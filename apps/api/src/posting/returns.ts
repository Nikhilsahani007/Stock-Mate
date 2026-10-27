import type { CostConfidence, DocumentType } from "@prisma/client";
import { computeLine, formatPaise, proRata, purchaseReturnSchema, roundInvoice, saleReturnSchema, stateCodeOf } from "@stockpilot/shared";
import type { z } from "zod";
import { audit } from "../audit.js";
import { HttpError, badRequest, notFound } from "../errors.js";
import { canAccessBranch } from "../middleware/tenant.js";
import {
  Journal,
  METHOD_ACCOUNT,
  StockBook,
  assertDistinct,
  idempotencyKey,
  lastMovement,
  loadBranch,
  loadParty,
  loadVariants,
  lockSerials,
  nextNumber,
  resolveBusinessDate,
  type PostContext,
} from "./core.js";
import { moveOut } from "./outbound.js";

type Refund = { method: "CASH" | "UPI" | "CARD" | "BANK" | "FINANCE"; amount: number; reference?: string | undefined; partyId?: string | undefined };

type OpenDoc = { id: string; total: number; paidAmount: number };

/**
 * Locks the document a return is made against together with the party's other
 * open invoices or bills, in the order receipts and payments lock them, so the
 * credit can be spread over them without deadlocking against a settlement.
 */
async function lockOpen(ctx: PostContext, sourceId: string | null, partyId: string | null, types: DocumentType[]): Promise<OpenDoc[]> {
  return ctx.tx.$queryRaw<OpenDoc[]>`
    SELECT "id", "total", "paidAmount" FROM "Document"
    WHERE "businessId" = ${ctx.businessId}
      AND ("id" = ${sourceId ?? ""} OR ("partyId" = ${partyId ?? ""} AND "status" = 'POSTED' AND "type"::text = ANY(${types}::text[]) AND "paidAmount" < "total"))
    ORDER BY "businessDate", "postedAt", "id" FOR UPDATE`;
}

/**
 * Applies the credit a return gives (what wasn't refunded in money) to the open
 * balance of the invoice or bill it was made against, then to the party's other
 * open ones, oldest first. Anything beyond that stays on the party's account as
 * an advance.
 */
async function applyCredit(ctx: PostContext, returnId: string, sourceId: string | null, open: OpenDoc[], credit: number, refunded: number) {
  let left = credit;
  const ordered = [...open.filter((d) => d.id === sourceId), ...open.filter((d) => d.id !== sourceId)];
  for (const d of ordered) {
    const amount = Math.min(left, Math.max(0, d.total - d.paidAmount));
    if (amount <= 0) continue;
    await ctx.tx.paymentAllocation.create({ data: { businessId: ctx.businessId, fromDocumentId: returnId, toDocumentId: d.id, amount } });
    await ctx.tx.document.update({ where: { id: d.id }, data: { paidAmount: { increment: amount } } });
    left -= amount;
  }
  await ctx.tx.document.update({ where: { id: returnId }, data: { paidAmount: refunded + credit - left } });
}

async function recordRefunds(ctx: PostContext, documentId: string, refunds: Refund[]) {
  if (refunds.length === 0) return;
  await ctx.tx.tender.createMany({
    data: refunds.map((t) => ({ businessId: ctx.businessId, documentId, method: t.method, amount: t.amount, reference: t.reference ?? null, partyId: t.partyId ?? null })),
  });
}

/**
 * A returned EMI phone usually means the loan is cancelled and the finance
 * company won't pay. A FINANCE refund records that, up to what each finance
 * company financed on the invoice less what earlier returns already cancelled.
 */
async function checkLoanCancellations(ctx: PostContext, saleId: string, refunds: Refund[]) {
  const finance = refunds.filter((t) => t.method === "FINANCE");
  if (finance.length === 0) return;
  const rows = await ctx.tx.tender.findMany({
    where: {
      method: "FINANCE",
      OR: [{ documentId: saleId }, { document: { type: "SALE_RETURN", sourceDocumentId: saleId, status: "POSTED" } }],
    },
    select: { partyId: true, amount: true, documentId: true },
  });
  for (const t of finance) {
    const financed = rows.filter((r) => r.partyId === t.partyId && r.documentId === saleId).reduce((a, r) => a + r.amount, 0);
    if (financed === 0) throw badRequest("That finance company didn't finance this invoice");
    const cancelled = rows.filter((r) => r.partyId === t.partyId && r.documentId !== saleId).reduce((a, r) => a + r.amount, 0);
    const asked = finance.filter((x) => x.partyId === t.partyId).reduce((a, x) => a + x.amount, 0);
    if (asked > financed - cancelled) throw badRequest(`Only ${formatPaise(financed - cancelled)} of the EMI on this invoice is left to cancel`);
  }
}

/**
 * Credit note: a customer brings goods back. Everything reverses the original
 * invoice line, at its price, tax and cost; nothing is taken from the client but
 * which units came back and whether they are damaged. Good goods go back on the
 * shelf at the cost they left at; damaged goods are written off as a stock loss.
 */
export async function postSaleReturn(ctx: PostContext, input: z.output<typeof saleReturnSchema>): Promise<string> {
  const found = await ctx.tx.document.findFirst({ where: { id: input.saleId, businessId: ctx.businessId, type: "SALE" }, select: { branchId: true, partyId: true } });
  if (!found || !canAccessBranch(ctx.req, found.branchId)) throw notFound("Invoice");
  const branch = await loadBranch(ctx, found.branchId);
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);

  // Locking the invoice serializes returns against it, so two can't return the same units.
  const open = await lockOpen(ctx, input.saleId, found.partyId, ["SALE"]);
  const sale = await ctx.tx.document.findUniqueOrThrow({
    where: { id: input.saleId },
    include: {
      lines: {
        include: {
          variant: { include: { product: true } },
          serials: { include: { serialUnit: true } },
          returnedBy: { where: { document: { status: { not: "CANCELLED" } } }, select: { quantity: true } },
        },
      },
    },
  });
  if (sale.status !== "POSTED") throw new HttpError(409, "CONFLICT", "This invoice is cancelled");
  if (iso < sale.businessDate.toISOString().slice(0, 10)) throw badRequest("A return can't be dated before its invoice");
  assertDistinct(input.lines.map((l) => l.lineId));
  assertDistinct(input.lines.flatMap((l) => l.serials));

  const lines = input.lines.map((l) => {
    const src = sale.lines.find((x) => x.id === l.lineId);
    if (!src) throw notFound("Invoice line");
    const label = `${src.variant.product.name} ${src.variant.name}`;
    const done = src.returnedBy.reduce((a, r) => a + r.quantity, 0);
    if (l.quantity > src.quantity - done) {
      throw badRequest(`${label}: only ${src.quantity - done} of ${src.quantity} can still be returned`);
    }
    const share = (amount: number) => proRata(amount, src.quantity, done, l.quantity);
    let units: (typeof src.serials)[number]["serialUnit"][] = [];
    let cost: number;
    if (src.variant.product.isSerialized) {
      if (l.serials.length !== l.quantity) throw badRequest(`${label}: choose the ${l.quantity} IMEI${l.quantity === 1 ? "" : "s"} that came back`);
      units = l.serials.map((id) => {
        const s = src.serials.find((x) => x.serialUnit.imei === id || x.serialUnit.imei2 === id);
        if (!s) throw badRequest(`${id} was not sold on this invoice line`);
        return s.serialUnit;
      });
      cost = src.serials.filter((s) => units.includes(s.serialUnit)).reduce((a, s) => a + s.unitCost, 0);
    } else {
      if (l.serials.length > 0) throw badRequest(`${label}: this product isn't tracked by IMEI`);
      cost = share(src.costTotal);
    }
    const amounts = { taxableValue: share(src.taxableValue), cgst: share(src.cgst), sgst: share(src.sgst), igst: share(src.igst), discount: share(src.discount) };
    return { input: l, src, units, cost, amounts, lineTotal: amounts.taxableValue + amounts.cgst + amounts.sgst + amounts.igst };
  });

  const taxableTotal = lines.reduce((a, l) => a + l.amounts.taxableValue, 0);
  const taxTotal = lines.reduce((a, l) => a + l.amounts.cgst + l.amounts.sgst + l.amounts.igst, 0);
  const { total, roundOff } = roundInvoice(taxableTotal + taxTotal);
  const refunded = input.refunds.reduce((a, t) => a + t.amount, 0);
  if (refunded > total) throw badRequest("Refund is more than the credit note total");
  if (!sale.partyId && refunded !== total) throw badRequest("A walk-in customer's return must be refunded in full");
  await checkLoanCancellations(ctx, sale.id, input.refunds);

  const variants = await loadVariants(ctx, lines.map((l) => l.src.variantId));
  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const locked = await lockSerials(ctx, lines.flatMap((l) => l.units.map((u) => u.imei)));
  for (const l of lines) {
    for (const u of l.units) {
      const unit = locked.find((x) => x.id === u.id)!;
      const last = await lastMovement(ctx, unit.id);
      if (unit.status !== "SOLD" || last?.documentId !== sale.id) {
        throw new HttpError(409, "SERIAL_MOVED_ON", `${unit.imei} has already come back or moved on since this sale`, { serial: unit.imei });
      }
    }
  }

  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "SALE_RETURN", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "SALE_RETURN",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: sale.partyId,
      sourceDocumentId: sale.id,
      gstApplied: sale.gstApplied,
      pricesIncludeTax: sale.pricesIncludeTax,
      interState: sale.interState,
      taxableTotal,
      taxTotal,
      roundOff,
      total,
      reason: input.reason,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  let restocked = 0;
  let writtenOff = 0;
  for (const [i, l] of lines.entries()) {
    const confidence: CostConfidence = l.src.costConfidence ?? "UNKNOWN";
    const line = await ctx.tx.documentLine.create({
      data: {
        businessId: ctx.businessId,
        documentId: doc.id,
        position: i,
        variantId: l.src.variantId,
        quantity: l.input.quantity,
        unitPrice: l.src.unitPrice,
        discount: l.amounts.discount,
        gstRateBps: l.src.gstRateBps,
        taxableValue: l.amounts.taxableValue,
        cgst: l.amounts.cgst,
        sgst: l.amounts.sgst,
        igst: l.amounts.igst,
        lineTotal: l.lineTotal,
        costTotal: l.cost,
        costConfidence: confidence,
        sourceLineId: l.src.id,
        damaged: l.input.damaged,
      },
    });
    const base = { businessId: ctx.businessId, branchId: branch.id, variantId: l.src.variantId, documentId: doc.id, lineId: line.id, businessDate: date };
    if (l.units.length > 0) {
      const costOf = (unitId: string) => l.src.serials.find((s) => s.serialUnitId === unitId)!.unitCost;
      await ctx.tx.lineSerial.createMany({ data: l.units.map((u) => ({ businessId: ctx.businessId, lineId: line.id, serialUnitId: u.id, unitCost: costOf(u.id) })) });
      await ctx.tx.serialUnit.updateMany({
        where: { id: { in: l.units.map((u) => u.id) } },
        data: { status: l.input.damaged ? "RETURNED_DAMAGED" : "IN_STOCK", branchId: branch.id },
      });
      if (!l.input.damaged) {
        await ctx.tx.stockMovement.createMany({
          data: l.units.map((u) => ({ ...base, serialUnitId: u.id, quantity: 1, value: costOf(u.id), costConfidence: u.costConfidence })),
        });
      }
    } else if (!l.input.damaged) {
      await ctx.tx.stockMovement.create({ data: { ...base, quantity: l.input.quantity, value: l.cost, costConfidence: confidence } });
    }
    if (l.input.damaged) {
      writtenOff += l.cost;
    } else {
      book.receive(l.src.variantId, l.input.quantity, l.cost, confidence);
      restocked += l.cost;
    }
  }

  const journal = new Journal();
  const partyId = sale.partyId;
  journal.post({ account: "SALES_RETURNS", amount: taxableTotal, branchId: branch.id });
  journal.post({ account: "GST_OUTPUT", amount: taxTotal, branchId: branch.id });
  journal.post({ account: "ROUND_OFF", amount: roundOff, branchId: branch.id });
  journal.post({ account: "RECEIVABLE", amount: -total, branchId: branch.id, partyId });
  journal.post({ account: "INVENTORY", amount: restocked, branchId: branch.id });
  journal.post({ account: "STOCK_LOSS", amount: writtenOff, branchId: branch.id });
  journal.post({ account: "COGS", amount: -(restocked + writtenOff), branchId: branch.id });
  for (const t of input.refunds) {
    journal.post({ account: "RECEIVABLE", amount: t.amount, branchId: branch.id, partyId });
    // Cancelling EMI comes off what the finance company owes instead of out of the till.
    journal.post({ account: METHOD_ACCOUNT[t.method], amount: -t.amount, branchId: branch.id, ...(t.partyId ? { partyId: t.partyId } : {}) });
  }
  await journal.write(ctx, doc.id, date);
  await recordRefunds(ctx, doc.id, input.refunds);
  await applyCredit(ctx, doc.id, sale.id, open, total - refunded, refunded);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "sale_return.posted", entityType: "Document", entityId: doc.id, metadata: { number, total, invoice: sale.number } });
  return doc.id;
}

/**
 * Debit note: goods go back to a supplier at the price they credit. In-stock
 * goods leave at their cost; devices a customer returned damaged (already
 * written off) recover that loss. Any difference between the credit and the
 * cost is price variance. GST input claimed on the goods is reversed.
 */
export async function postPurchaseReturn(ctx: PostContext, input: z.output<typeof purchaseReturnSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const party = await loadParty(ctx, input.partyId, "SUPPLIER");
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  let purchase: { id: string; number: string } | null = null;
  if (input.purchaseId) {
    const p = await ctx.tx.document.findFirst({
      where: { id: input.purchaseId, businessId: ctx.businessId, type: "PURCHASE", branchId: branch.id, partyId: party.id },
      select: { id: true, number: true, status: true },
    });
    if (!p) throw notFound("Purchase from this supplier at this branch");
    if (p.status !== "POSTED") throw new HttpError(409, "CONFLICT", "That purchase is cancelled");
    purchase = p;
  }
  const open = await lockOpen(ctx, purchase?.id ?? null, party.id, ["PURCHASE", "EXPENSE"]);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  assertDistinct(input.lines.flatMap((l) => l.serials));

  const branchState = stateCodeOf(branch.gstin);
  const partyState = party.stateCode ?? stateCodeOf(party.gstin);
  const interState = !!branchState && !!partyState && branchState !== partyState;
  const claimable = branch.gstEnabled;
  const mode = { gstApplied: true, pricesIncludeTax: false, interState };
  const lines = input.lines.map((l, i) => {
    const v = variants.get(l.variantId)!;
    const label = `Line ${i + 1} (${v.product.name} ${v.name})`;
    if (v.product.isSerialized && l.serials.length !== l.quantity) throw badRequest(`${label}: choose ${l.quantity} IMEI${l.quantity === 1 ? "" : "s"}, one per unit`);
    if (!v.product.isSerialized && l.serials.length > 0) throw badRequest(`${label}: this product isn't tracked by IMEI`);
    const gstRateBps = l.gstRateBps ?? v.product.gstRateBps;
    return { input: l, v, label, gstRateBps, amounts: computeLine({ ...l, discount: 0, gstRateBps }, mode) };
  });
  const taxableTotal = lines.reduce((a, l) => a + l.amounts.taxableValue, 0);
  const taxTotal = lines.reduce((a, l) => a + l.amounts.cgst + l.amounts.sgst + l.amounts.igst, 0);
  const { total, roundOff } = roundInvoice(taxableTotal + taxTotal);
  const refunded = input.refunds.reduce((a, t) => a + t.amount, 0);
  if (refunded > total) throw badRequest("Refund is more than the debit note total");

  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const locked = await lockSerials(ctx, input.lines.flatMap((l) => l.serials));
  const picked = lines.map((l) =>
    l.input.serials.map((id) => {
      const unit = locked.find((u) => u.imei === id || u.imei2 === id);
      if (!unit || unit.branchId !== branch.id || (unit.status !== "IN_STOCK" && unit.status !== "RETURNED_DAMAGED")) {
        throw new HttpError(409, "SERIAL_NOT_IN_STOCK", `${id} is not in stock or returned damaged at this branch`, { serial: id });
      }
      if (unit.variantId !== l.v.id) throw badRequest(`${l.label}: ${id} is a different product`);
      return unit;
    }),
  );

  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "PURCHASE_RETURN", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "PURCHASE_RETURN",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: party.id,
      sourceDocumentId: purchase?.id ?? null,
      gstApplied: claimable,
      interState,
      taxableTotal,
      taxTotal,
      roundOff,
      total,
      reason: input.reason,
      notes: [input.supplierRef ? `Supplier credit note ${input.supplierRef}` : null, input.notes].filter(Boolean).join(". ") || null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  let stockOut = 0;
  let recovered = 0;
  for (const [i, l] of lines.entries()) {
    const line = await ctx.tx.documentLine.create({
      data: {
        businessId: ctx.businessId,
        documentId: doc.id,
        position: i,
        variantId: l.v.id,
        quantity: l.input.quantity,
        unitPrice: l.input.unitPrice,
        gstRateBps: l.gstRateBps,
        ...l.amounts,
        costTotal: 0,
      },
    });
    const ref = { documentId: doc.id, lineId: line.id, businessDate: date };
    const damaged = picked[i]!.filter((u) => u.status === "RETURNED_DAMAGED");
    const inStock = picked[i]!.filter((u) => u.status === "IN_STOCK");
    let value = 0;
    let confidence: CostConfidence = "VERIFIED";
    if (!l.v.product.isSerialized || inStock.length > 0) {
      const out = await moveOut(ctx, book, ref, l.v, l.v.product.isSerialized ? inStock.length : l.input.quantity, inStock, "RETURNED_TO_SUPPLIER");
      value += out.value;
      confidence = out.confidence;
      stockOut += out.value;
    }
    if (damaged.length > 0) {
      // Already written off when the customer returned them; sending them back recovers that loss.
      const loss = damaged.reduce((a, u) => a + u.unitCost, 0);
      await ctx.tx.serialUnit.updateMany({ where: { id: { in: damaged.map((u) => u.id) } }, data: { status: "RETURNED_TO_SUPPLIER" } });
      await ctx.tx.lineSerial.createMany({ data: damaged.map((u) => ({ businessId: ctx.businessId, lineId: line.id, serialUnitId: u.id, unitCost: u.unitCost })) });
      value += loss;
      recovered += loss;
    }
    await ctx.tx.documentLine.update({ where: { id: line.id }, data: { costTotal: value, costConfidence: confidence } });
  }

  const journal = new Journal();
  const claimedTax = claimable ? taxTotal : 0;
  journal.post({ account: "PAYABLE", amount: total, branchId: branch.id, partyId: party.id });
  journal.post({ account: "GST_INPUT", amount: -claimedTax, branchId: branch.id });
  journal.post({ account: "ROUND_OFF", amount: -roundOff, branchId: branch.id });
  journal.post({ account: "INVENTORY", amount: -stockOut, branchId: branch.id });
  journal.post({ account: "STOCK_LOSS", amount: -recovered, branchId: branch.id });
  // Credit above cost is a gain (credit); below cost a loss (debit).
  journal.post({ account: "PRICE_VARIANCE", amount: -(total - claimedTax - roundOff - stockOut - recovered), branchId: branch.id });
  for (const t of input.refunds) {
    journal.post({ account: METHOD_ACCOUNT[t.method], amount: t.amount, branchId: branch.id });
    journal.post({ account: "PAYABLE", amount: -t.amount, branchId: branch.id, partyId: party.id });
  }
  await journal.write(ctx, doc.id, date);
  await recordRefunds(ctx, doc.id, input.refunds);
  await applyCredit(ctx, doc.id, purchase?.id ?? null, open, total - refunded, refunded);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "purchase_return.posted", entityType: "Document", entityId: doc.id, metadata: { number, total, purchase: purchase?.number ?? null } });
  return doc.id;
}
