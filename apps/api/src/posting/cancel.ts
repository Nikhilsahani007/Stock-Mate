import type { SerialStatus } from "@prisma/client";
import { roleHas } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { HttpError, badRequest, forbidden, notFound } from "../errors.js";
import { canAccessBranch, tenantOf } from "../middleware/tenant.js";
import { CREATE_PERMISSION, Journal, StockBook, assertDayOpen, lastClosedDay, lockDays, type PostContext } from "./core.js";

/** For each type, the status a device must be in to be reversed, and the status it returns to. */
const SERIAL_REVERSAL: Partial<Record<string, { from: SerialStatus; to: SerialStatus }>> = {
  SALE: { from: "SOLD", to: "IN_STOCK" },
  PURCHASE: { from: "IN_STOCK", to: "VOIDED" },
  OPENING_STOCK: { from: "IN_STOCK", to: "VOIDED" },
  ADJUSTMENT: { from: "WRITTEN_OFF", to: "IN_STOCK" },
  TRANSFER: { from: "IN_TRANSIT", to: "IN_STOCK" },
};

/**
 * Cancels a posted document by appending an exact reversal on its original
 * business date. Nothing already written is changed. Stock that came in is
 * taken back out at today's average cost, with any difference booked as price
 * variance, so balances stay consistent and can never go negative.
 */
export async function cancelDocument(ctx: PostContext, documentId: string, reason: string): Promise<string> {
  // Day locks come before document locks, as in every posting.
  const target = await ctx.tx.document.findFirst({ where: { id: documentId, businessId: ctx.businessId }, select: { type: true, branchId: true, businessDate: true } });
  if (!target || !canAccessBranch(ctx.req, target.branchId)) throw notFound("Document");
  if (target.type === "DAY_CLOSE") {
    // Reopening a day: only the branch's latest close, so later closes never rest on changed cash.
    await lockDays(ctx, target.branchId);
    const last = await lastClosedDay(ctx.tx, target.branchId);
    if (!last || last.getTime() !== target.businessDate.getTime()) {
      throw new HttpError(409, "CONFLICT", "Only the latest closed day of a branch can be reopened. Reopen the later days first.");
    }
  } else {
    await assertDayOpen(ctx, target.branchId, target.businessDate);
  }
  const rows = await ctx.tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Document" WHERE "id" = ${documentId} AND "businessId" = ${ctx.businessId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Document");
  const doc = await ctx.tx.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { movements: { where: { isReversal: false } }, ledgerEntries: { where: { isReversal: false } } },
  });
  if (!canAccessBranch(ctx.req, doc.branchId)) throw notFound("Document");
  const role = tenantOf(ctx.req).role;
  if (!roleHas(role, "document.cancel") || !roleHas(role, CREATE_PERMISSION[doc.type])) throw forbidden();
  if (doc.status === "CANCELLED") throw new HttpError(409, "CONFLICT", "This document is already cancelled");
  if (doc.type === "TRANSFER" && doc.status !== "IN_TRANSIT") {
    throw badRequest("A received transfer can't be cancelled; send the stock back with a new transfer");
  }

  // Money: unlink payments. Receipts that paid a cancelled invoice stay with the party as an advance.
  if (doc.type === "RECEIPT" || doc.type === "PAYMENT") {
    const allocations = await ctx.tx.paymentAllocation.findMany({ where: { fromDocumentId: doc.id }, orderBy: { toDocumentId: "asc" } });
    for (const a of allocations) {
      await ctx.tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${a.toDocumentId} FOR UPDATE`;
      await ctx.tx.document.update({ where: { id: a.toDocumentId }, data: { paidAmount: { decrement: a.amount } } });
    }
    await ctx.tx.paymentAllocation.deleteMany({ where: { fromDocumentId: doc.id } });
  } else {
    await ctx.tx.paymentAllocation.deleteMany({ where: { toDocumentId: doc.id } });
  }

  const journal = new Journal();
  for (const e of doc.ledgerEntries) {
    journal.post({ account: e.account, amount: e.credit - e.debit, branchId: e.branchId, partyId: e.partyId, expenseCategory: e.expenseCategory });
  }

  if (doc.movements.length > 0) {
    const book = await StockBook.lock(ctx, doc.branchId, doc.movements.map((m) => m.variantId));
    const serialIds = doc.movements.flatMap((m) => (m.serialUnitId ? [m.serialUnitId] : [])).sort();
    const units = serialIds.length
      ? (await ctx.tx.$queryRaw`SELECT "id" FROM "SerialUnit" WHERE "id" = ANY(${serialIds}::text[]) ORDER BY "id" FOR UPDATE`,
        await ctx.tx.serialUnit.findMany({ where: { id: { in: serialIds } } }))
      : [];
    const rule = SERIAL_REVERSAL[doc.type];

    for (const m of doc.movements) {
      const reversal = { businessId: ctx.businessId, branchId: m.branchId, variantId: m.variantId, serialUnitId: m.serialUnitId, documentId: doc.id, lineId: m.lineId, businessDate: doc.businessDate, isReversal: true };
      if (m.serialUnitId) {
        const unit = units.find((u) => u.id === m.serialUnitId)!;
        const last = await ctx.tx.stockMovement.findFirst({ where: { serialUnitId: unit.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (!rule || unit.status !== rule.from || unit.branchId !== doc.branchId || last?.documentId !== doc.id) {
          throw new HttpError(409, "SERIAL_MOVED_ON", `${unit.imei} has moved on since this document, so it can't be cancelled`, { serial: unit.imei });
        }
        await ctx.tx.serialUnit.update({ where: { id: unit.id }, data: { status: rule.to } });
        if (m.quantity > 0) book.issueExact(m.variantId, 1, m.value);
        else book.receive(m.variantId, 1, -m.value, m.costConfidence);
        await ctx.tx.stockMovement.create({ data: { ...reversal, quantity: -m.quantity, value: -m.value, costConfidence: m.costConfidence } });
      } else if (m.quantity < 0) {
        book.receive(m.variantId, -m.quantity, -m.value, m.costConfidence);
        await ctx.tx.stockMovement.create({ data: { ...reversal, quantity: -m.quantity, value: -m.value, costConfidence: m.costConfidence } });
      } else {
        const out = book.issueAtAverage(m.variantId, m.quantity);
        const variance = m.value - out.value;
        journal.post({ account: "INVENTORY", amount: variance, branchId: m.branchId });
        journal.post({ account: "PRICE_VARIANCE", amount: -variance, branchId: m.branchId });
        await ctx.tx.stockMovement.create({ data: { ...reversal, quantity: -m.quantity, value: -out.value, costConfidence: out.confidence } });
      }
    }
    await book.save();
  }

  await journal.write(ctx, doc.id, doc.businessDate, true);
  await ctx.tx.document.update({
    where: { id: doc.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason, paidAmount: 0 },
  });
  if (doc.type === "DAY_CLOSE") {
    await ctx.tx.dayClose.updateMany({ where: { documentId: doc.id }, data: { reopenedAt: new Date(), reopenReason: reason } });
  }
  await audit(ctx.tx, ctx.req, { action: "document.cancelled", entityType: "Document", entityId: doc.id, metadata: { number: doc.number, type: doc.type, reason } });
  return doc.id;
}
