import type { DocumentType, PaymentMethod } from "@prisma/client";
import { dayCloseSchema } from "@stockpilot/shared";
import type { z } from "zod";
import { audit } from "../audit.js";
import { badRequest } from "../errors.js";
import { Journal, idempotencyKey, loadBranch, lockDays, nextNumber, resolveBusinessDate, type PostContext, type Tx } from "./core.js";

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

export interface DaySummary {
  sales: { count: number; total: number; taxable: number; tax: number };
  /** What was left on credit: sales total minus what was paid at the counter. */
  creditGiven: number;
  cancelledSales: { count: number; total: number };
  /** Money taken (in) and paid (out) by method, from posted documents of the day. */
  tenders: { method: PaymentMethod; in: number; out: number }[];
  /** Cash in and out of the drawer by kind of document, including cancellations. */
  cash: { type: DocumentType; in: number; out: number }[];
}

export interface DayFigures {
  openingCash: number;
  cashIn: number;
  cashOut: number;
  summary: DaySummary;
}

/**
 * The day's figures for a branch, straight from the ledgers. The cash account
 * of a branch is its drawer: every cash sale, receipt, expense, payment, count
 * difference and hand-over goes through it, so its balance is what should be there.
 */
export async function computeDay(tx: Tx, businessId: string, branchId: string, iso: string): Promise<DayFigures> {
  const [opening] = await tx.$queryRaw<{ balance: bigint | null }[]>`
    SELECT SUM("debit" - "credit")::bigint AS balance FROM "LedgerEntry"
    WHERE "businessId" = ${businessId} AND "branchId" = ${branchId} AND "account" = 'CASH' AND "businessDate" < ${iso}::date`;
  const cash = await tx.$queryRaw<{ type: DocumentType; in: bigint; out: bigint }[]>`
    SELECT d."type", SUM(e."debit")::bigint AS in, SUM(e."credit")::bigint AS out
    FROM "LedgerEntry" e JOIN "Document" d ON d."id" = e."documentId"
    WHERE e."businessId" = ${businessId} AND e."branchId" = ${branchId} AND e."account" = 'CASH' AND e."businessDate" = ${iso}::date
    GROUP BY d."type" ORDER BY d."type"`;
  const [sales] = await tx.$queryRaw<{ count: bigint; total: bigint | null; taxable: bigint | null; tax: bigint | null; tendered: bigint | null }[]>`
    SELECT COUNT(*)::bigint AS count, SUM("total")::bigint AS total, SUM("taxableTotal")::bigint AS taxable, SUM("taxTotal")::bigint AS tax,
      (SELECT SUM(t."amount") FROM "Tender" t JOIN "Document" d2 ON d2."id" = t."documentId"
        WHERE d2."businessId" = ${businessId} AND d2."branchId" = ${branchId} AND d2."type" = 'SALE' AND d2."status" = 'POSTED' AND d2."businessDate" = ${iso}::date)::bigint AS tendered
    FROM "Document"
    WHERE "businessId" = ${businessId} AND "branchId" = ${branchId} AND "type" = 'SALE' AND "status" = 'POSTED' AND "businessDate" = ${iso}::date`;
  const [cancelled] = await tx.$queryRaw<{ count: bigint; total: bigint | null }[]>`
    SELECT COUNT(*)::bigint AS count, SUM("total")::bigint AS total FROM "Document"
    WHERE "businessId" = ${businessId} AND "branchId" = ${branchId} AND "type" = 'SALE' AND "status" = 'CANCELLED' AND "businessDate" = ${iso}::date`;
  const tenders = await tx.$queryRaw<{ method: PaymentMethod; in: bigint; out: bigint }[]>`
    SELECT t."method",
      SUM(CASE WHEN d."type" IN ('SALE', 'RECEIPT') THEN t."amount" ELSE 0 END)::bigint AS in,
      SUM(CASE WHEN d."type" IN ('PURCHASE', 'EXPENSE', 'PAYMENT') THEN t."amount" ELSE 0 END)::bigint AS out
    FROM "Tender" t JOIN "Document" d ON d."id" = t."documentId"
    WHERE d."businessId" = ${businessId} AND d."branchId" = ${branchId} AND d."status" = 'POSTED' AND d."businessDate" = ${iso}::date
    GROUP BY t."method" ORDER BY t."method"`;

  const cashRows = cash.map((r) => ({ type: r.type, in: num(r.in), out: num(r.out) }));
  return {
    openingCash: num(opening?.balance),
    cashIn: cashRows.reduce((a, r) => a + r.in, 0),
    cashOut: cashRows.reduce((a, r) => a + r.out, 0),
    summary: {
      sales: { count: num(sales?.count), total: num(sales?.total), taxable: num(sales?.taxable), tax: num(sales?.tax) },
      creditGiven: num(sales?.total) - num(sales?.tendered),
      cancelledSales: { count: num(cancelled?.count), total: num(cancelled?.total) },
      tenders: tenders.map((t) => ({ method: t.method, in: num(t.in), out: num(t.out) })),
      cash: cashRows,
    },
  };
}

/** Whether a branch has ever been closed (and not reopened). The first close may record an opening float. */
export async function hasActiveClose(tx: Tx, branchId: string) {
  return (await tx.dayClose.count({ where: { branchId, reopenedAt: null } })) > 0;
}

/**
 * Closes a branch's business day: compares counted cash with what the books
 * expect, posts the difference as a shortage or excess, posts any cash taken
 * out, and locks the day against further postings.
 */
export async function postDayClose(ctx: PostContext, input: z.output<typeof dayCloseSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  await lockDays(ctx, branch.id);
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  if (input.openingFloat > 0 && (await hasActiveClose(ctx.tx, branch.id))) {
    throw badRequest("An opening float can only be entered on a branch's first day close. After that the drawer carries over from the last close.");
  }

  const day = await computeDay(ctx.tx, ctx.businessId, branch.id, iso);
  const expectedCash = day.openingCash + input.openingFloat + day.cashIn - day.cashOut;
  const difference = input.countedCash - expectedCash;

  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "DAY_CLOSE", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "DAY_CLOSE",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      total: input.countedCash,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });

  const journal = new Journal();
  journal.post({ account: "CASH", amount: input.openingFloat, branchId: branch.id });
  journal.post({ account: "OPENING_EQUITY", amount: -input.openingFloat, branchId: branch.id });
  journal.post({ account: "CASH", amount: difference, branchId: branch.id });
  journal.post({ account: "CASH_OVER_SHORT", amount: -difference, branchId: branch.id });
  if (input.handedOver > 0) {
    journal.post({ account: input.handedOverTo === "BANK" ? "BANK" : "OWNER_DRAWINGS", amount: input.handedOver, branchId: branch.id });
    journal.post({ account: "CASH", amount: -input.handedOver, branchId: branch.id });
  }
  await journal.write(ctx, doc.id, date);

  await ctx.tx.dayClose.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      businessDate: date,
      documentId: doc.id,
      openingCash: day.openingCash,
      openingFloat: input.openingFloat,
      cashIn: day.cashIn,
      cashOut: day.cashOut,
      expectedCash,
      countedCash: input.countedCash,
      difference,
      handedOver: input.handedOver,
      handedOverTo: input.handedOver > 0 ? (input.handedOverTo ?? null) : null,
      summary: day.summary as object,
      notes: input.notes ?? null,
      closedById: ctx.userId,
    },
  });
  await audit(ctx.tx, ctx.req, {
    action: "day.closed",
    entityType: "Document",
    entityId: doc.id,
    metadata: { number, date: iso, branch: branch.name, expectedCash, countedCash: input.countedCash, difference },
  });
  return doc.id;
}
