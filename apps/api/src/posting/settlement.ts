import type { DocumentType, PaymentMethod } from "@prisma/client";
import { expenseSchema, settlementSchema } from "@stockpilot/shared";
import type { z } from "zod";
import { audit } from "../audit.js";
import { badRequest, notFound } from "../errors.js";
import { Journal, METHOD_ACCOUNT, idempotencyKey, loadBranch, loadParty, nextNumber, resolveBusinessDate, type PostContext } from "./core.js";

type TenderIn = { method: PaymentMethod; amount: number; reference?: string | undefined; partyId?: string | undefined };

/** Stores money taken or paid on a document and allocates it to the document itself. */
export async function recordTenders(ctx: PostContext, documentId: string, tenders: TenderIn[]) {
  if (tenders.length === 0) return;
  const paid = tenders.reduce((a, t) => a + t.amount, 0);
  await ctx.tx.tender.createMany({
    data: tenders.map((t) => ({ businessId: ctx.businessId, documentId, method: t.method, amount: t.amount, reference: t.reference ?? null, partyId: t.partyId ?? null })),
  });
  await ctx.tx.paymentAllocation.create({ data: { businessId: ctx.businessId, fromDocumentId: documentId, toDocumentId: documentId, amount: paid } });
  await ctx.tx.document.update({ where: { id: documentId }, data: { paidAmount: paid } });
}

export async function postExpense(ctx: PostContext, input: z.output<typeof expenseSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const party = input.partyId ? await loadParty(ctx, input.partyId, "SUPPLIER") : null;
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  const { number, fiscalYear } = await nextNumber(ctx, branch.id, "EXPENSE", iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type: "EXPENSE",
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: party?.id ?? null,
      expenseCategory: input.category,
      taxableTotal: input.amount,
      total: input.amount,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });
  const journal = new Journal();
  journal.post({ account: "EXPENSE", amount: input.amount, branchId: branch.id, expenseCategory: input.category });
  if (input.method) {
    journal.post({ account: METHOD_ACCOUNT[input.method], amount: -input.amount, branchId: branch.id });
  } else {
    journal.post({ account: "PAYABLE", amount: -input.amount, branchId: branch.id, partyId: party!.id });
  }
  await journal.write(ctx, doc.id, date);
  if (input.method) await recordTenders(ctx, doc.id, [{ method: input.method, amount: input.amount }]);
  await audit(ctx.tx, ctx.req, { action: "expense.posted", entityType: "Document", entityId: doc.id, metadata: { number, amount: input.amount } });
  return doc.id;
}

/**
 * A customer receipt (RECEIPT) or a supplier payment (PAYMENT). Money is
 * allocated to the invoices or bills chosen, or oldest first. Anything left
 * over stays on the party's account as an advance. A receipt can also come
 * from a financier paying out EMI sales, less the fees they keep back.
 */
export async function postSettlement(ctx: PostContext, type: "RECEIPT" | "PAYMENT", input: z.output<typeof settlementSchema>): Promise<string> {
  const branch = await loadBranch(ctx, input.branchId);
  const party = type === "RECEIPT" ? await loadParty(ctx, input.partyId, "CUSTOMER", "FINANCIER") : await loadParty(ctx, input.partyId, "SUPPLIER");
  if (input.deduction > 0 && party.kind !== "FINANCIER") throw badRequest("Only a finance company's payout can have fees kept back");
  const { date, iso } = await resolveBusinessDate(ctx, branch.id, input.businessDate);
  const received = input.tenders.reduce((a, t) => a + t.amount, 0);
  // What this settles on the party's account: the money, plus any fees the financier kept.
  const total = received + input.deduction;
  const targetTypes: DocumentType[] = type === "RECEIPT" ? ["SALE"] : ["PURCHASE", "EXPENSE"];

  // Lock the party's open documents so two receipts can't over-settle one invoice.
  const open = await ctx.tx.$queryRaw<{ id: string; total: number; paidAmount: number }[]>`
    SELECT "id", "total", "paidAmount" FROM "Document"
    WHERE "businessId" = ${ctx.businessId} AND "partyId" = ${party.id} AND "status" = 'POSTED'
      AND "type"::text = ANY(${targetTypes}::text[]) AND "paidAmount" < "total"
    ORDER BY "businessDate", "postedAt", "id" FOR UPDATE`;

  const plan: { documentId: string; amount: number }[] = [];
  if (input.allocations) {
    const allocated = input.allocations.reduce((a, x) => a + x.amount, 0);
    if (allocated > total) throw badRequest("Allocations add up to more than the amount received");
    for (const a of input.allocations) {
      const d = open.find((o) => o.id === a.documentId);
      if (!d) throw notFound("Open invoice or bill");
      if (a.amount > d.total - d.paidAmount) throw badRequest("Allocation is more than what is due on that document");
      plan.push(a);
    }
  } else {
    let left = total;
    for (const d of open) {
      if (left === 0) break;
      const amount = Math.min(left, d.total - d.paidAmount);
      plan.push({ documentId: d.id, amount });
      left -= amount;
    }
  }

  const { number, fiscalYear } = await nextNumber(ctx, branch.id, type, iso);
  const doc = await ctx.tx.document.create({
    data: {
      businessId: ctx.businessId,
      branchId: branch.id,
      type,
      status: "POSTED",
      number,
      fiscalYear,
      businessDate: date,
      partyId: party.id,
      total,
      /** On a receipt: fees or subvention the financier kept back. */
      otherCharges: input.deduction,
      notes: input.notes ?? null,
      idempotencyKey: idempotencyKey(ctx),
      createdById: ctx.userId,
    },
  });
  await ctx.tx.tender.createMany({
    data: input.tenders.map((t) => ({ businessId: ctx.businessId, documentId: doc.id, method: t.method, amount: t.amount, reference: t.reference ?? null })),
  });
  for (const p of plan) {
    await ctx.tx.paymentAllocation.create({ data: { businessId: ctx.businessId, fromDocumentId: doc.id, toDocumentId: p.documentId, amount: p.amount } });
    await ctx.tx.document.update({ where: { id: p.documentId }, data: { paidAmount: { increment: p.amount } } });
  }

  const journal = new Journal();
  const sign = type === "RECEIPT" ? 1 : -1;
  for (const t of input.tenders) journal.post({ account: METHOD_ACCOUNT[t.method], amount: sign * t.amount, branchId: branch.id });
  journal.post({ account: "EXPENSE", amount: input.deduction, branchId: branch.id, expenseCategory: "FINANCE_CHARGES" });
  journal.post({ account: type === "RECEIPT" ? "RECEIVABLE" : "PAYABLE", amount: -sign * total, branchId: branch.id, partyId: party.id });
  await journal.write(ctx, doc.id, date);
  await audit(ctx.tx, ctx.req, {
    action: type === "RECEIPT" ? "receipt.posted" : "payment.posted",
    entityType: "Document",
    entityId: doc.id,
    metadata: { number, total },
  });
  return doc.id;
}
