import type { CostConfidence } from "@prisma/client";
import { adjustmentSchema, computeLine, roundInvoice, saleSchema, stateCodeOf, todayIn, transferSchema } from "@stockpilot/shared";
import type { z } from "zod";
import { audit } from "../audit.js";
import { HttpError, badRequest, notFound } from "../errors.js";
import { canAccessBranch } from "../middleware/tenant.js";
import {
  Journal,
  METHOD_ACCOUNT,
  StockBook,
  assertDayOpen,
  assertDistinct,
  idempotencyKey,
  loadBranch,
  loadParty,
  loadVariants,
  lockSerials,
  nextNumber,
  resolveBusinessDate,
  weakest,
  type LoadedVariant,
  type LockedSerial,
  type PostContext,
} from "./core.js";
import { recordTenders } from "./settlement.js";

/**
 * Picks the devices for one line from the already-locked units. Staff must
 * pick or scan an IMEI that is in stock here; unknown IMEIs are refused.
 */
function pickSerials(units: LockedSerial[], branchId: string, v: LoadedVariant, ids: string[], quantity: number, position: number) {
  const label = `Line ${position + 1} (${v.product.name} ${v.name})`;
  if (!v.product.isSerialized) {
    if (ids.length > 0) throw badRequest(`${label}: this product isn't tracked by IMEI`);
    return [];
  }
  if (ids.length !== quantity) throw badRequest(`${label}: pick ${quantity} IMEI or serial number${quantity === 1 ? "" : "s"}, one per unit`);
  return ids.map((id) => {
    const unit = units.find((u) => u.imei === id || u.imei2 === id);
    if (!unit || unit.branchId !== branchId || unit.status !== "IN_STOCK") {
      throw new HttpError(409, "SERIAL_NOT_IN_STOCK", `${id} is not in stock at this branch`, { serial: id });
    }
    if (unit.variantId !== v.id) throw badRequest(`${label}: ${id} is a different product`);
    return unit;
  });
}

/** Removes devices or accessories from a branch's stock and returns the cost taken out. */
export async function moveOut(
  ctx: PostContext,
  book: StockBook,
  ref: { documentId: string; lineId: string; businessDate: Date },
  v: LoadedVariant,
  quantity: number,
  units: LockedSerial[],
  serialStatus: "SOLD" | "WRITTEN_OFF" | "IN_TRANSIT" | "RETURNED_TO_SUPPLIER",
): Promise<{ value: number; confidence: CostConfidence }> {
  const base = { businessId: ctx.businessId, branchId: book.branchId, variantId: v.id, ...ref };
  if (!v.product.isSerialized) {
    const out = book.issueAtAverage(v.id, quantity);
    await ctx.tx.stockMovement.create({ data: { ...base, quantity: -quantity, value: -out.value, costConfidence: out.confidence } });
    return out;
  }
  const value = units.reduce((a, u) => a + u.unitCost, 0);
  const confidence = units.reduce<CostConfidence>((c, u) => weakest(c, u.costConfidence), "VERIFIED");
  book.issueExact(v.id, quantity, value);
  await ctx.tx.serialUnit.updateMany({ where: { id: { in: units.map((u) => u.id) } }, data: { status: serialStatus } });
  await ctx.tx.lineSerial.createMany({
    data: units.map((u) => ({ businessId: ctx.businessId, lineId: ref.lineId, serialUnitId: u.id, unitCost: u.unitCost })),
  });
  await ctx.tx.stockMovement.createMany({
    data: units.map((u) => ({ ...base, serialUnitId: u.id, quantity: -1, value: -u.unitCost, costConfidence: u.costConfidence })),
  });
  return { value, confidence };
}

export async function postSale(ctx: PostContext, input: z.output<typeof saleSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const party = input.partyId ? await loadParty(ctx, input.partyId, "CUSTOMER") : null;
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  const allSerials = input.lines.flatMap((l) => l.serials);
  assertDistinct(allSerials);

  const branchState = stateCodeOf(branch.gstin);
  const partyState = party ? (party.stateCode ?? stateCodeOf(party.gstin)) : null;
  const interState = branch.gstEnabled && !!branchState && !!partyState && branchState !== partyState;
  const mode = { gstApplied: branch.gstEnabled, pricesIncludeTax: input.pricesIncludeTax, interState };
  const lines = input.lines.map((l) => {
    const v = variants.get(l.variantId)!;
    const gstRateBps = branch.gstEnabled ? v.product.gstRateBps : 0;
    return { input: l, v, gstRateBps, amounts: computeLine({ ...l, gstRateBps }, mode) };
  });
  const taxableTotal = lines.reduce((a, l) => a + l.amounts.taxableValue, 0);
  const taxTotal = lines.reduce((a, l) => a + l.amounts.cgst + l.amounts.sgst + l.amounts.igst, 0);
  const { total, roundOff } = roundInvoice(taxableTotal + taxTotal);
  const paid = input.tenders.reduce((a, t) => a + t.amount, 0);
  if (paid > total) throw badRequest("Payment is more than the invoice total");
  if (!party && paid !== total) throw badRequest("Choose a customer to leave part of the bill on credit");
  const financed = input.tenders.filter((t) => t.method === "FINANCE");
  if (financed.length > 0 && !party) throw badRequest("Choose the customer for an EMI sale");
  for (const partyId of new Set(financed.map((t) => t.partyId!))) await loadParty(ctx, partyId, "FINANCIER");

  // Lock order everywhere: stock balances, then devices, then the number series.
  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const locked = await lockSerials(ctx, allSerials);
  const picked = lines.map((l, i) => pickSerials(locked, branch.id, l.v, l.input.serials, l.input.quantity, i));
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "SALE", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "SALE",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: party?.id ?? null,
      gstApplied: branch.gstEnabled,
      pricesIncludeTax: input.pricesIncludeTax,
      interState,
      taxableTotal,
      taxTotal,
      roundOff,
      total,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  let cogs = 0;
  for (const [i, l] of lines.entries()) {
    const line = await ctx.tx.documentLine.create({
      data: {
        businessId: ctx.businessId,
        documentId: doc.id,
        position: i,
        variantId: l.v.id,
        quantity: l.input.quantity,
        unitPrice: l.input.unitPrice,
        discount: l.input.discount,
        gstRateBps: l.gstRateBps,
        ...l.amounts,
        costTotal: 0,
      },
    });
    const out = await moveOut(ctx, book, { documentId: doc.id, lineId: line.id, businessDate: date }, l.v, l.input.quantity, picked[i]!, "SOLD");
    // A missing cost stays visibly unknown rather than counting as zero-cost profit.
    const confidence: CostConfidence = out.value === 0 && out.confidence !== "VERIFIED" ? "UNKNOWN" : out.confidence;
    await ctx.tx.documentLine.update({ where: { id: line.id }, data: { costTotal: out.value, costConfidence: confidence } });
    cogs += out.value;
  }

  const journal = new Journal();
  const partyId = party?.id ?? null;
  journal.post({ account: "RECEIVABLE", amount: total, branchId: branch.id, partyId });
  journal.post({ account: "SALES", amount: -taxableTotal, branchId: branch.id });
  journal.post({ account: "GST_OUTPUT", amount: -taxTotal, branchId: branch.id });
  journal.post({ account: "ROUND_OFF", amount: -roundOff, branchId: branch.id });
  journal.post({ account: "COGS", amount: cogs, branchId: branch.id });
  journal.post({ account: "INVENTORY", amount: -cogs, branchId: branch.id });
  for (const t of input.tenders) {
    // An EMI moves what is owed from the customer to the financier.
    journal.post({ account: METHOD_ACCOUNT[t.method], amount: t.amount, branchId: branch.id, partyId: t.method === "FINANCE" ? t.partyId : null });
    journal.post({ account: "RECEIVABLE", amount: -t.amount, branchId: branch.id, partyId });
  }
  await journal.write(ctx, doc.id, date);
  await recordTenders(ctx, doc.id, input.tenders);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "sale.posted", entityType: "Document", entityId: doc.id, metadata: { number, total } });
  return doc.id;
}

export async function postAdjustment(ctx: PostContext, input: z.output<typeof adjustmentSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  const allSerials = input.lines.flatMap((l) => l.serials);
  assertDistinct(allSerials);
  for (const [i, l] of input.lines.entries()) {
    const v = variants.get(l.variantId)!;
    if (l.quantity > 0 && v.product.isSerialized) {
      throw badRequest(`Line ${i + 1}: record a found phone as opening stock or a purchase, so its IMEI and cost are captured`);
    }
  }

  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const locked = await lockSerials(ctx, allSerials);
  const picked = input.lines.map((l, i) =>
    l.quantity < 0 ? pickSerials(locked, branch.id, variants.get(l.variantId)!, l.serials, -l.quantity, i) : [],
  );
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "ADJUSTMENT", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "ADJUSTMENT",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      reason: input.reason,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  const journal = new Journal();
  for (const [i, l] of input.lines.entries()) {
    const v = variants.get(l.variantId)!;
    const line = await ctx.tx.documentLine.create({
      data: { businessId: ctx.businessId, documentId: doc.id, position: i, variantId: v.id, quantity: l.quantity, unitPrice: 0, taxableValue: 0, lineTotal: 0, costTotal: 0 },
    });
    let value: number;
    let confidence: CostConfidence;
    if (l.quantity < 0) {
      const out = await moveOut(ctx, book, { documentId: doc.id, lineId: line.id, businessDate: date }, v, -l.quantity, picked[i]!, "WRITTEN_OFF");
      value = -out.value;
      confidence = out.confidence;
    } else {
      // Found stock comes in at the given cost, else the current average.
      const avg = book.averageCost(v.id);
      const unitCost = l.unitCost ?? avg?.unitCost ?? 0;
      confidence = l.unitCost !== undefined ? "ESTIMATED" : (avg?.confidence ?? "UNKNOWN");
      value = unitCost * l.quantity;
      book.receive(v.id, l.quantity, value, confidence);
      await ctx.tx.stockMovement.create({
        data: { businessId: ctx.businessId, branchId: branch.id, variantId: v.id, documentId: doc.id, lineId: line.id, businessDate: date, quantity: l.quantity, value, costConfidence: confidence },
      });
    }
    await ctx.tx.documentLine.update({ where: { id: line.id }, data: { costTotal: value, costConfidence: confidence } });
    journal.post({ account: "INVENTORY", amount: value, branchId: branch.id });
    journal.post({ account: "STOCK_LOSS", amount: -value, branchId: branch.id });
  }
  await journal.write(ctx, doc.id, date);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "adjustment.posted", entityType: "Document", entityId: doc.id, metadata: { number, reason: input.reason } });
  return doc.id;
}

/** Dispatches stock to another branch. It sits in transit, at cost, until received. */
export async function postTransfer(ctx: PostContext, input: z.output<typeof transferSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  if (input.toBranchId === branch.id) throw badRequest("Choose a different branch to send to");
  const toBranch = await ctx.tx.branch.findFirst({ where: { id: input.toBranchId, businessId: ctx.businessId, archivedAt: null } });
  if (!toBranch) throw notFound("Branch");
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  const allSerials = input.lines.flatMap((l) => l.serials);
  assertDistinct(allSerials);

  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const locked = await lockSerials(ctx, allSerials);
  const picked = input.lines.map((l, i) => pickSerials(locked, branch.id, variants.get(l.variantId)!, l.serials, l.quantity, i));
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "TRANSFER", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      toBranchId: toBranch.id,
      type: "TRANSFER",
      status: "IN_TRANSIT",
      number,
      fiscalYear,
      businessDate: date,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });
  let value = 0;
  for (const [i, l] of input.lines.entries()) {
    const v = variants.get(l.variantId)!;
    const line = await ctx.tx.documentLine.create({
      data: { businessId: ctx.businessId, documentId: doc.id, position: i, variantId: v.id, quantity: l.quantity, unitPrice: 0, taxableValue: 0, lineTotal: 0, costTotal: 0 },
    });
    const out = await moveOut(ctx, book, { documentId: doc.id, lineId: line.id, businessDate: date }, v, l.quantity, picked[i]!, "IN_TRANSIT");
    await ctx.tx.documentLine.update({ where: { id: line.id }, data: { costTotal: out.value, costConfidence: out.confidence } });
    value += out.value;
  }
  const journal = new Journal();
  journal.post({ account: "STOCK_IN_TRANSIT", amount: value, branchId: branch.id });
  journal.post({ account: "INVENTORY", amount: -value, branchId: branch.id });
  await journal.write(ctx, doc.id, date);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "transfer.dispatched", entityType: "Document", entityId: doc.id, metadata: { number, to: toBranch.name } });
  return doc.id;
}

/** Receives a transfer at its destination; the receiving branch blends the cost into its own average. */
export async function receiveTransfer(ctx: PostContext, documentId: string): Promise<string> {
  // The receiving branch's day lock comes before the document lock, as in every other posting.
  const target = await ctx.tx.document.findFirst({ where: { id: documentId, businessId: ctx.businessId, type: "TRANSFER" }, select: { toBranchId: true } });
  if (!target?.toBranchId) throw notFound("Transfer");
  const today = todayIn(ctx.timezone);
  const date = new Date(`${today}T00:00:00Z`);
  await assertDayOpen(ctx, target.toBranchId, date);
  const rows = await ctx.tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Document" WHERE "id" = ${documentId} AND "businessId" = ${ctx.businessId} AND "type" = 'TRANSFER' FOR UPDATE`;
  if (rows.length === 0) throw notFound("Transfer");
  const doc = await ctx.tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { lines: { include: { serials: true } } } });
  if (!canAccessBranch(ctx.req, doc.toBranchId!) && !canAccessBranch(ctx.req, doc.branchId)) throw notFound("Transfer");
  if (!canAccessBranch(ctx.req, doc.toBranchId!)) throw new HttpError(403, "FORBIDDEN", "Only the receiving branch can receive this transfer");
  if (doc.status !== "IN_TRANSIT") throw new HttpError(409, "CONFLICT", "This transfer is not in transit");
  const toBranchId = doc.toBranchId!;

  const book = await StockBook.lock(ctx, toBranchId, doc.lines.map((l) => l.variantId));
  const serialIds = doc.lines.flatMap((l) => l.serials.map((s) => s.serialUnitId)).sort();
  if (serialIds.length) {
    await ctx.tx.$queryRaw`SELECT "id" FROM "SerialUnit" WHERE "id" = ANY(${serialIds}::text[]) ORDER BY "id" FOR UPDATE`;
  }
  const base = { businessId: ctx.businessId, branchId: toBranchId, documentId: doc.id, businessDate: date };
  let value = 0;
  for (const line of doc.lines) {
    const confidence = line.costConfidence ?? "UNKNOWN";
    if (line.serials.length > 0) {
      await ctx.tx.serialUnit.updateMany({
        where: { id: { in: line.serials.map((s) => s.serialUnitId) }, status: "IN_TRANSIT" },
        data: { status: "IN_STOCK", branchId: toBranchId },
      });
      const units = await ctx.tx.serialUnit.findMany({ where: { id: { in: line.serials.map((s) => s.serialUnitId) } } });
      await ctx.tx.stockMovement.createMany({
        data: units.map((u) => ({ ...base, variantId: line.variantId, lineId: line.id, serialUnitId: u.id, quantity: 1, value: u.unitCost, costConfidence: u.costConfidence })),
      });
    } else {
      await ctx.tx.stockMovement.create({ data: { ...base, variantId: line.variantId, lineId: line.id, quantity: line.quantity, value: line.costTotal, costConfidence: confidence } });
    }
    book.receive(line.variantId, line.quantity, line.costTotal, confidence);
    value += line.costTotal;
  }
  const journal = new Journal();
  journal.post({ account: "INVENTORY", amount: value, branchId: toBranchId });
  journal.post({ account: "STOCK_IN_TRANSIT", amount: -value, branchId: doc.branchId });
  await journal.write(ctx, doc.id, date);
  await book.save();
  await ctx.tx.document.update({ where: { id: doc.id }, data: { status: "POSTED", receivedAt: new Date() } });
  await audit(ctx.tx, ctx.req, { action: "transfer.received", entityType: "Document", entityId: doc.id, metadata: { number: doc.number } });
  return doc.id;
}
