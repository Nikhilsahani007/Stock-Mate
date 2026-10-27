import { Prisma, type CostConfidence, type DocumentType, type LedgerAccount, type PaymentMethod } from "@prisma/client";
import { fiscalYearOf, roleHas, todayIn, type Permission } from "@stockpilot/shared";
import type { Request } from "express";
import { prisma } from "../db.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { canAccessBranch, tenantOf } from "../middleware/tenant.js";

export type Tx = Prisma.TransactionClient;

/** Everything a poster needs: the transaction, who is posting, and where. */
export interface PostContext {
  tx: Tx;
  req: Request;
  businessId: string;
  userId: string;
  timezone: string;
}

export const insufficientStock = (details: unknown) =>
  new HttpError(409, "INSUFFICIENT_STOCK", "Not enough stock. Stock can't go negative; enter the purchase or opening stock first.", details);

/** Permission needed to create (and see) each document type. */
export const CREATE_PERMISSION: Record<DocumentType, Permission> = {
  PURCHASE: "purchase.create",
  SALE: "sale.create",
  OPENING_STOCK: "stock.adjust",
  ADJUSTMENT: "stock.adjust",
  TRANSFER: "stock.transfer",
  EXPENSE: "expense.record",
  RECEIPT: "payment.record",
  PAYMENT: "payment.record",
  DAY_CLOSE: "day.close",
};

const NUMBER_PREFIX: Record<DocumentType, string> = {
  PURCHASE: "PUR",
  SALE: "INV",
  OPENING_STOCK: "OPN",
  ADJUSTMENT: "ADJ",
  TRANSFER: "TRF",
  EXPENSE: "EXP",
  RECEIPT: "RCT",
  PAYMENT: "PAY",
  DAY_CLOSE: "CLS",
};

export const METHOD_ACCOUNT: Record<PaymentMethod, LedgerAccount> = {
  CASH: "CASH",
  UPI: "UPI_CARD_CLEARING",
  CARD: "UPI_CARD_CLEARING",
  BANK: "BANK",
};

const CONFIDENCE_RANK: Record<CostConfidence, number> = { VERIFIED: 0, ESTIMATED: 1, UNKNOWN: 2 };
export function weakest(a: CostConfidence, b: CostConfidence): CostConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Runs one posting in a single database transaction. A retried request with
 * the same Idempotency-Key returns the document the first attempt created
 * instead of posting twice.
 */
export async function runPosting(
  req: Request,
  fn: (ctx: PostContext) => Promise<string>,
): Promise<{ documentId: string; replayed: boolean }> {
  const { businessId } = tenantOf(req);
  const key = idempotencyKeyOf(req);
  if (key) {
    const existing = await prisma.document.findUnique({ where: { businessId_idempotencyKey: { businessId, idempotencyKey: key } } });
    if (existing) return { documentId: existing.id, replayed: true };
  }
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  try {
    const documentId = await prisma.$transaction(
      (tx) => fn({ tx, req, businessId, userId: req.user!.id, timezone: business.timezone }),
      { timeout: 20_000, maxWait: 10_000 },
    );
    return { documentId, replayed: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
      if (key && target.includes("idempotencyKey")) {
        const existing = await prisma.document.findUnique({ where: { businessId_idempotencyKey: { businessId, idempotencyKey: key } } });
        if (existing) return { documentId: existing.id, replayed: true };
      }
      if (target.includes("imei")) throw conflict("That IMEI or serial number is already recorded in this business");
    }
    throw err;
  }
}

/** The validated Idempotency-Key header of the request being posted. */
export function idempotencyKey(ctx: PostContext) {
  return idempotencyKeyOf(ctx.req);
}

export function idempotencyKeyOf(req: Request): string | null {
  const key = req.get("Idempotency-Key");
  if (!key) return null;
  if (!/^[\w.:-]{8,100}$/.test(key)) throw badRequest("Idempotency-Key must be 8 to 100 letters, digits or -_.:");
  return key;
}

/**
 * Resolves the business date for a posting at a branch: today by default, never
 * in the future, and never on or before the branch's last closed day. Returns a
 * Date at UTC midnight.
 */
export async function resolveBusinessDate(ctx: PostContext, branchId: string, date: string | undefined): Promise<{ date: Date; iso: string }> {
  const today = todayIn(ctx.timezone);
  const iso = date ?? today;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw badRequest("Invalid date");
  if (iso > today) throw badRequest("Date can't be in the future");
  await assertDayOpen(ctx, branchId, parsed);
  return { date: parsed, iso };
}

export const dayClosed = (iso: string) =>
  new HttpError(409, "DAY_CLOSED", `The day ${iso} is closed at this branch. Post it on a later date, or reopen the day first.`);

/**
 * Refuses postings dated on or before the branch's latest closed day. Takes the
 * branch's day lock in shared mode, so postings run side by side while a day
 * close (which takes it exclusively) waits for them and they wait for it.
 */
export async function assertDayOpen(ctx: PostContext, branchId: string, date: Date) {
  await ctx.tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`day-close:${branchId}`}, 0))`;
  const last = await lastClosedDay(ctx.tx, branchId);
  if (last && date.getTime() <= last.getTime()) throw dayClosed(date.toISOString().slice(0, 10));
}

/** Takes the branch's day lock exclusively, for closing or reopening a day. */
export async function lockDays(ctx: PostContext, branchId: string) {
  await ctx.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`day-close:${branchId}`}, 0))`;
}

export async function lastClosedDay(tx: Tx, branchId: string): Promise<Date | null> {
  const close = await tx.dayClose.findFirst({
    where: { branchId, reopenedAt: null },
    orderBy: { businessDate: "desc" },
    select: { businessDate: true },
  });
  return close?.businessDate ?? null;
}

export function requireRole(req: Request, permission: Permission) {
  if (!roleHas(tenantOf(req).role, permission)) throw forbidden();
}

/** A branch of this business that the member may use for posting. */
export async function loadBranch(ctx: PostContext, branchId: string) {
  if (!canAccessBranch(ctx.req, branchId)) throw notFound("Branch");
  const branch = await ctx.tx.branch.findFirst({ where: { id: branchId, businessId: ctx.businessId } });
  if (!branch) throw notFound("Branch");
  if (branch.archivedAt) throw badRequest("This branch is archived");
  return branch;
}

export async function loadParty(ctx: PostContext, partyId: string, role: "CUSTOMER" | "SUPPLIER") {
  const party = await ctx.tx.party.findFirst({ where: { id: partyId, businessId: ctx.businessId } });
  if (!party) throw notFound("Party");
  if (party.kind !== role && party.kind !== "BOTH") {
    throw badRequest(role === "SUPPLIER" ? "That party is not a supplier" : "That party is not a customer");
  }
  return party;
}

/** Loads the variants used on a document, with their product, and checks they belong to this business. */
export async function loadVariants(ctx: PostContext, variantIds: string[]) {
  const unique = [...new Set(variantIds)];
  const variants = await ctx.tx.variant.findMany({
    where: { businessId: ctx.businessId, id: { in: unique } },
    include: { product: true },
  });
  if (variants.length !== unique.length) throw notFound("Product");
  return new Map(variants.map((v) => [v.id, v]));
}
export type LoadedVariant = Awaited<ReturnType<typeof loadVariants>> extends Map<string, infer V> ? V : never;

/** Gap-free number from the branch series. The counter row stays locked until the posting commits. */
export async function nextNumber(ctx: PostContext, branchId: string, type: DocumentType, isoDate: string) {
  const fiscalYear = fiscalYearOf(isoDate);
  const rows = await ctx.tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "DocumentCounter" ("businessId", "branchId", "type", "fiscalYear", "last")
    VALUES (${ctx.businessId}, ${branchId}, ${type}::"DocumentType", ${fiscalYear}, 1)
    ON CONFLICT ("branchId", "type", "fiscalYear") DO UPDATE SET "last" = "DocumentCounter"."last" + 1
    RETURNING "last"`;
  const n = rows[0]!.last;
  return { fiscalYear, number: `${NUMBER_PREFIX[type]}/${fiscalYear}/${String(n).padStart(4, "0")}` };
}

// ---------------------------------------------------------------------------
// Stock balances
// ---------------------------------------------------------------------------

interface Balance {
  quantity: number;
  value: number;
  costConfidence: CostConfidence;
  dirty: boolean;
}

/**
 * Locked view of one branch's stock balances for the duration of a posting.
 * Rows are locked in sorted variant order so concurrent postings never deadlock.
 */
export class StockBook {
  private readonly balances = new Map<string, Balance>();

  private constructor(
    private readonly ctx: PostContext,
    readonly branchId: string,
  ) {}

  static async lock(ctx: PostContext, branchId: string, variantIds: string[]) {
    const book = new StockBook(ctx, branchId);
    const ids = [...new Set(variantIds)].sort();
    if (ids.length === 0) return book;
    await ctx.tx.$executeRaw`
      INSERT INTO "StockBalance" ("businessId", "branchId", "variantId", "updatedAt")
      SELECT ${ctx.businessId}, ${branchId}, v, now() FROM unnest(${ids}::text[]) AS v
      ON CONFLICT DO NOTHING`;
    const rows = await ctx.tx.$queryRaw<{ variantId: string; quantity: number; value: number; costConfidence: CostConfidence }[]>`
      SELECT "variantId", "quantity", "value", "costConfidence" FROM "StockBalance"
      WHERE "branchId" = ${branchId} AND "variantId" = ANY(${ids}::text[])
      ORDER BY "variantId" FOR UPDATE`;
    for (const r of rows) book.balances.set(r.variantId, { ...r, dirty: false });
    return book;
  }

  private get(variantId: string): Balance {
    const b = this.balances.get(variantId);
    if (!b) throw new Error(`balance for ${variantId} not locked`);
    return b;
  }

  quantity(variantId: string) {
    return this.get(variantId).quantity;
  }

  /** Current average unit cost, or null when there is no stock to average. */
  averageCost(variantId: string): { unitCost: number; confidence: CostConfidence } | null {
    const b = this.get(variantId);
    return b.quantity > 0 ? { unitCost: Math.round(b.value / b.quantity), confidence: b.costConfidence } : null;
  }

  receive(variantId: string, quantity: number, value: number, confidence: CostConfidence) {
    const b = this.get(variantId);
    b.costConfidence = b.quantity === 0 ? confidence : weakest(b.costConfidence, confidence);
    b.quantity += quantity;
    b.value += value;
    b.dirty = true;
  }

  /** Takes stock out at moving average cost. Refuses to go below zero. */
  issueAtAverage(variantId: string, quantity: number): { value: number; confidence: CostConfidence } {
    const b = this.get(variantId);
    if (b.quantity < quantity) throw insufficientStock({ variantId, available: b.quantity, requested: quantity });
    const value = quantity === b.quantity ? b.value : Math.round((b.value * quantity) / b.quantity);
    const confidence = b.costConfidence;
    b.quantity -= quantity;
    b.value -= value;
    b.dirty = true;
    return { value, confidence };
  }

  /** Takes out specific units (IMEIs) whose cost is known exactly. */
  issueExact(variantId: string, quantity: number, value: number) {
    const b = this.get(variantId);
    if (b.quantity < quantity) throw insufficientStock({ variantId, available: b.quantity, requested: quantity });
    b.quantity -= quantity;
    b.value = Math.max(0, b.value - value);
    b.dirty = true;
  }

  async save() {
    for (const [variantId, b] of this.balances) {
      if (!b.dirty) continue;
      if (b.quantity === 0) b.value = 0;
      await this.ctx.tx.stockBalance.update({
        where: { branchId_variantId: { branchId: this.branchId, variantId } },
        data: { quantity: b.quantity, value: b.value, costConfidence: b.costConfidence },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Serial units
// ---------------------------------------------------------------------------

/** Locks every serial unit matching any of these IMEIs (as first or second IMEI). */
export async function lockSerials(ctx: PostContext, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await ctx.tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "SerialUnit"
    WHERE "businessId" = ${ctx.businessId} AND ("imei" = ANY(${ids}::text[]) OR "imei2" = ANY(${ids}::text[]))
    ORDER BY "id" FOR UPDATE`;
  return ctx.tx.serialUnit.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
}
export type LockedSerial = Awaited<ReturnType<typeof lockSerials>>[number];

export function assertDistinct(ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw badRequest(`${id} is entered twice`);
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerLine {
  account: LedgerAccount;
  /** Positive is a debit, negative a credit. */
  amount: number;
  branchId: string;
  partyId?: string | null;
  expenseCategory?: Prisma.LedgerEntryCreateManyInput["expenseCategory"];
}

/** Collects one document's double entries and refuses to write them unless they balance. */
export class Journal {
  readonly lines: LedgerLine[] = [];

  post(line: LedgerLine) {
    if (line.amount !== 0) this.lines.push(line);
  }

  async write(ctx: PostContext, documentId: string, businessDate: Date, isReversal = false) {
    const sum = this.lines.reduce((a, l) => a + l.amount, 0);
    if (sum !== 0) throw new Error(`Unbalanced journal for ${documentId}: off by ${sum}`);
    if (this.lines.length === 0) return;
    await ctx.tx.ledgerEntry.createMany({
      data: this.lines.map((l) => ({
        businessId: ctx.businessId,
        branchId: l.branchId,
        documentId,
        account: l.account,
        partyId: l.partyId ?? null,
        expenseCategory: l.expenseCategory ?? null,
        debit: l.amount > 0 ? l.amount : 0,
        credit: l.amount < 0 ? -l.amount : 0,
        businessDate,
        isReversal,
      })),
    });
  }
}
