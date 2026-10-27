import type { CostConfidence } from "@prisma/client";
import { allocate, computeLine, openingStockSchema, purchaseSchema, roundInvoice, stateCodeOf } from "@stockpilot/shared";
import type { z } from "zod";
import { audit } from "../audit.js";
import { badRequest, conflict } from "../errors.js";
import {
  Journal,
  METHOD_ACCOUNT,
  StockBook,
  assertDistinct,
  idempotencyKey,
  loadBranch,
  loadParty,
  loadVariants,
  lockSerials,
  nextNumber,
  resolveBusinessDate,
  type LoadedVariant,
  type PostContext,
} from "./core.js";
import { recordTenders } from "./settlement.js";

type NewSerial = { imei: string; imei2?: string | undefined };

/** Statuses a device can be bought back from. Anything else means it is already with us. */
const REOPENABLE = new Set(["SOLD", "RETURNED_TO_SUPPLIER", "WRITTEN_OFF", "VOIDED"]);

function checkSerialLine(v: LoadedVariant, quantity: number, serials: NewSerial[], position: number) {
  const label = `Line ${position + 1} (${v.product.name} ${v.name})`;
  if (v.product.isSerialized) {
    if (serials.length !== quantity) throw badRequest(`${label}: enter ${quantity} IMEI or serial number${quantity === 1 ? "" : "s"}, one per unit`);
  } else if (serials.length > 0) {
    throw badRequest(`${label}: this product isn't tracked by IMEI`);
  }
}

/**
 * Brings devices into stock. A device seen before (sold, returned to the
 * supplier, written off) is reopened with a new cost instead of duplicated.
 */
async function receiveSerials(
  ctx: PostContext,
  branchId: string,
  variantId: string,
  serials: NewSerial[],
  unitCosts: number[],
  confidence: CostConfidence,
) {
  const all = serials.flatMap((s) => (s.imei2 ? [s.imei, s.imei2] : [s.imei]));
  const existing = await lockSerials(ctx, all);
  const units = [];
  for (const [i, s] of serials.entries()) {
    const ids = s.imei2 ? [s.imei, s.imei2] : [s.imei];
    const matches = existing.filter((u) => ids.includes(u.imei) || (u.imei2 !== null && ids.includes(u.imei2)));
    const data = { branchId, status: "IN_STOCK" as const, unitCost: unitCosts[i]!, costConfidence: confidence };
    if (matches.length === 0) {
      units.push(await ctx.tx.serialUnit.create({ data: { ...data, businessId: ctx.businessId, variantId, imei: s.imei, imei2: s.imei2 ?? null } }));
      continue;
    }
    const unit = matches[0]!;
    if (matches.length > 1 || unit.imei !== s.imei) throw conflict(`${s.imei} clashes with a device already recorded`);
    if (!REOPENABLE.has(unit.status)) throw conflict(`${s.imei} is already in stock or in transit`);
    if (unit.variantId !== variantId) throw conflict(`${s.imei} was recorded as a different product before`);
    units.push(await ctx.tx.serialUnit.update({ where: { id: unit.id }, data: { ...data, imei2: s.imei2 ?? unit.imei2 } }));
  }
  return units;
}

export async function postPurchase(ctx: PostContext, input: z.output<typeof purchaseSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const party = await loadParty(ctx, input.partyId, "SUPPLIER");
  const { date, iso } = resolveBusinessDate(ctx, input.businessDate);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  assertDistinct(input.lines.flatMap((l) => l.serials.flatMap((s) => (s.imei2 ? [s.imei, s.imei2] : [s.imei]))));

  // GST on a supplier bill is input credit only when this branch is GST registered;
  // otherwise it is part of what the stock cost.
  const branchState = stateCodeOf(branch.gstin);
  const partyState = party.stateCode ?? stateCodeOf(party.gstin);
  const interState = !!branchState && !!partyState && branchState !== partyState;
  const claimable = branch.gstEnabled;
  const mode = { gstApplied: true, pricesIncludeTax: input.pricesIncludeTax, interState };

  const lines = input.lines.map((l, i) => {
    const v = variants.get(l.variantId)!;
    checkSerialLine(v, l.quantity, l.serials, i);
    const gstRateBps = l.gstRateBps ?? v.product.gstRateBps;
    const amounts = computeLine({ ...l, gstRateBps }, mode);
    return { input: l, v, gstRateBps, amounts };
  });
  const charges = allocate(input.otherCharges, lines.map((l) => l.amounts.taxableValue));
  const costs = lines.map((l, i) => {
    const tax = l.amounts.cgst + l.amounts.sgst + l.amounts.igst;
    return l.amounts.taxableValue + (claimable ? 0 : tax) + charges[i]!;
  });
  const taxableTotal = lines.reduce((a, l) => a + l.amounts.taxableValue, 0);
  const taxTotal = lines.reduce((a, l) => a + l.amounts.cgst + l.amounts.sgst + l.amounts.igst, 0);
  const { total, roundOff } = roundInvoice(taxableTotal + taxTotal + input.otherCharges);
  const paid = input.tenders.reduce((a, t) => a + t.amount, 0);
  if (paid > total) throw badRequest("Payment is more than the bill total");

  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "PURCHASE", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "PURCHASE",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: party.id,
      gstApplied: claimable,
      pricesIncludeTax: input.pricesIncludeTax,
      interState,
      taxableTotal,
      taxTotal,
      otherCharges: input.otherCharges,
      roundOff,
      total,
      reason: input.supplierRef ?? null,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

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
        costTotal: costs[i]!,
        costConfidence: "VERIFIED",
      },
    });
    await moveIn(ctx, book, doc.id, line.id, date, l.v, l.input.quantity, costs[i]!, l.input.serials, "VERIFIED");
  }

  const journal = new Journal();
  journal.post({ account: "INVENTORY", amount: costs.reduce((a, b) => a + b, 0), branchId: branch.id });
  if (claimable) journal.post({ account: "GST_INPUT", amount: taxTotal, branchId: branch.id });
  journal.post({ account: "ROUND_OFF", amount: roundOff, branchId: branch.id });
  journal.post({ account: "PAYABLE", amount: -total, branchId: branch.id, partyId: party.id });
  for (const t of input.tenders) {
    journal.post({ account: "PAYABLE", amount: t.amount, branchId: branch.id, partyId: party.id });
    journal.post({ account: METHOD_ACCOUNT[t.method], amount: -t.amount, branchId: branch.id });
  }
  await journal.write(ctx, doc.id, date);
  await recordTenders(ctx, doc.id, input.tenders);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "purchase.posted", entityType: "Document", entityId: doc.id, metadata: { number, total } });
  return doc.id;
}

export async function postOpeningStock(ctx: PostContext, input: z.output<typeof openingStockSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const { date, iso } = resolveBusinessDate(ctx, input.businessDate);
  const variants = await loadVariants(ctx, input.lines.map((l) => l.variantId));
  assertDistinct(input.lines.flatMap((l) => l.serials.flatMap((s) => (s.imei2 ? [s.imei, s.imei2] : [s.imei]))));
  input.lines.forEach((l, i) => checkSerialLine(variants.get(l.variantId)!, l.quantity, l.serials, i));

  const book = await StockBook.lock(ctx, branch.id, [...variants.keys()]);
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "OPENING_STOCK", iso);
  const values = input.lines.map((l) => l.quantity * (l.unitCost ?? 0));
  const total = values.reduce((a, b) => a + b, 0);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "OPENING_STOCK",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      taxableTotal: total,
      total,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  for (const [i, l] of input.lines.entries()) {
    // Typed-in costs are the owner's estimate; a missing cost stays unknown until fixed.
    const confidence: CostConfidence = l.unitCost === undefined ? "UNKNOWN" : "ESTIMATED";
    const line = await ctx.tx.documentLine.create({
      data: {
        businessId: ctx.businessId,
        documentId: doc.id,
        position: i,
        variantId: l.variantId,
        quantity: l.quantity,
        unitPrice: l.unitCost ?? 0,
        taxableValue: values[i]!,
        lineTotal: values[i]!,
        costTotal: values[i]!,
        costConfidence: confidence,
      },
    });
    await moveIn(ctx, book, doc.id, line.id, date, variants.get(l.variantId)!, l.quantity, values[i]!, l.serials, confidence);
  }

  const journal = new Journal();
  journal.post({ account: "INVENTORY", amount: total, branchId: branch.id });
  journal.post({ account: "OPENING_EQUITY", amount: -total, branchId: branch.id });
  await journal.write(ctx, doc.id, date);
  await book.save();
  await audit(ctx.tx, ctx.req, { action: "opening_stock.posted", entityType: "Document", entityId: doc.id, metadata: { number, total } });
  return doc.id;
}

/** Writes stock-in for one line: one movement per device, or one for the whole accessory line. */
async function moveIn(
  ctx: PostContext,
  book: StockBook,
  documentId: string,
  lineId: string,
  businessDate: Date,
  v: LoadedVariant,
  quantity: number,
  cost: number,
  serials: NewSerial[],
  confidence: CostConfidence,
) {
  const base = { businessId: ctx.businessId, branchId: book.branchId, variantId: v.id, documentId, lineId, businessDate, costConfidence: confidence };
  if (!v.product.isSerialized) {
    await ctx.tx.stockMovement.create({ data: { ...base, quantity, value: cost } });
    book.receive(v.id, quantity, cost, confidence);
    return;
  }
  const unitCosts = allocate(cost, serials.map(() => 1));
  const units = await receiveSerials(ctx, book.branchId, v.id, serials, unitCosts, confidence);
  await ctx.tx.lineSerial.createMany({
    data: units.map((u, i) => ({ businessId: ctx.businessId, lineId, serialUnitId: u.id, unitCost: unitCosts[i]! })),
  });
  await ctx.tx.stockMovement.createMany({
    data: units.map((u, i) => ({ ...base, serialUnitId: u.id, quantity: 1, value: unitCosts[i]! })),
  });
  book.receive(v.id, quantity, cost, confidence);
}
