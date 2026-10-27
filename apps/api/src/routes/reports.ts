import { Prisma, type CostConfidence, type ExpenseCategory, type PaymentMethod } from "@prisma/client";
import { reportRangeSchema, todayIn } from "@stockpilot/shared";
import { Router, type Request } from "express";
import { prisma } from "../db.js";
import { notFound } from "../errors.js";
import { canAccessBranch, requirePermission, tenantOf } from "../middleware/tenant.js";
import { canSeeCost } from "./stock.js";

/**
 * Reports read only from posted documents and the two ledgers, never from
 * anything a client sends but the filters. Cancelled documents are left out:
 * their reversal sits on the original date, so they net to nothing anyway.
 * Amounts are paise; sums are computed as bigint and returned as numbers.
 */
export const reportsRouter = Router({ mergeParams: true });

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

interface Scope {
  businessId: string;
  /** null means every branch of the business. */
  branchIds: string[] | null;
  from: string;
  to: string;
  today: string;
}

/** Reads ?from=&to=&branchId= (dates default to today) and limits branches to what the member may see. */
async function scopeOf(req: Request): Promise<Scope> {
  const { businessId, branchIds } = tenantOf(req);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const today = todayIn(business.timezone);
  const q = (k: string) => (typeof req.query[k] === "string" && req.query[k] !== "" ? (req.query[k] as string) : undefined);
  const range = reportRangeSchema.parse({ from: q("from") ?? today, to: q("to") ?? today, branchId: q("branchId") });
  if (range.branchId) {
    if (!canAccessBranch(req, range.branchId) || !(await prisma.branch.findFirst({ where: { id: range.branchId, businessId } }))) {
      throw notFound("Branch");
    }
    return { businessId, branchIds: [range.branchId], from: range.from, to: range.to, today };
  }
  return { businessId, branchIds, from: range.from, to: range.to, today };
}

/** `AND <column> = ANY(branches)` when the scope is limited, nothing otherwise. */
function inBranches(column: string, s: Scope) {
  return s.branchIds === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(column)} = ANY(${s.branchIds}::text[])`;
}

/** Posted documents of the given types in the scope's branches and dates. */
function docsWhere(alias: string, types: string[], s: Scope) {
  return Prisma.sql`${Prisma.raw(alias)}."businessId" = ${s.businessId}
    AND ${Prisma.raw(alias)}."type"::text = ANY(${types}::text[])
    AND ${Prisma.raw(alias)}."status" = 'POSTED'
    AND ${Prisma.raw(alias)}."businessDate" BETWEEN ${s.from}::date AND ${s.to}::date
    ${inBranches(`${alias}."branchId"`, s)}`;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

reportsRouter.get("/sales", requirePermission("report.view"), async (req, res) => {
  const s = await scopeOf(req);
  const where = docsWhere("d", ["SALE"], s);
  const [totals] = await prisma.$queryRaw<{ invoices: bigint; total: bigint; taxable: bigint; tax: bigint; tendered: bigint }[]>`
    SELECT COUNT(*)::bigint AS invoices, COALESCE(SUM(d."total"), 0)::bigint AS total,
      COALESCE(SUM(d."taxableTotal"), 0)::bigint AS taxable, COALESCE(SUM(d."taxTotal"), 0)::bigint AS tax,
      COALESCE((SELECT SUM(t."amount") FROM "Tender" t JOIN "Document" d ON d."id" = t."documentId" WHERE ${where}), 0)::bigint AS tendered
    FROM "Document" d WHERE ${where}`;
  const [units] = await prisma.$queryRaw<{ units: bigint }[]>`
    SELECT COALESCE(SUM(l."quantity"), 0)::bigint AS units FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId" WHERE ${where}`;
  const [cancelled] = await prisma.$queryRaw<{ count: bigint; total: bigint }[]>`
    SELECT COUNT(*)::bigint AS count, COALESCE(SUM(d."total"), 0)::bigint AS total FROM "Document" d
    WHERE d."businessId" = ${s.businessId} AND d."type" = 'SALE' AND d."status" = 'CANCELLED'
      AND d."businessDate" BETWEEN ${s.from}::date AND ${s.to}::date ${inBranches(`d."branchId"`, s)}`;
  const byDay = await prisma.$queryRaw<{ date: string; invoices: bigint; total: bigint; taxable: bigint }[]>`
    SELECT d."businessDate"::text AS date, COUNT(*)::bigint AS invoices, SUM(d."total")::bigint AS total, SUM(d."taxableTotal")::bigint AS taxable
    FROM "Document" d WHERE ${where} GROUP BY 1 ORDER BY 1`;
  const byBranch = await prisma.$queryRaw<{ branchId: string; name: string; invoices: bigint; total: bigint; taxable: bigint }[]>`
    SELECT d."branchId", b."name", COUNT(*)::bigint AS invoices, SUM(d."total")::bigint AS total, SUM(d."taxableTotal")::bigint AS taxable
    FROM "Document" d JOIN "Branch" b ON b."id" = d."branchId" WHERE ${where} GROUP BY 1, 2 ORDER BY 4 DESC`;
  const lineGroup = (key: Prisma.Sql) => prisma.$queryRaw<{ name: string; units: bigint; taxable: bigint }[]>`
    SELECT ${key} AS name, SUM(l."quantity")::bigint AS units, SUM(l."taxableValue")::bigint AS taxable
    FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId"
      JOIN "Variant" v ON v."id" = l."variantId" JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "Brand" br ON br."id" = p."brandId" LEFT JOIN "Category" c ON c."id" = p."categoryId"
    WHERE ${where} GROUP BY 1 ORDER BY 3 DESC LIMIT 50`;
  const [byBrand, byCategory, topProducts] = await Promise.all([
    lineGroup(Prisma.sql`COALESCE(br."name", 'No brand')`),
    lineGroup(Prisma.sql`COALESCE(c."name", 'No category')`),
    lineGroup(Prisma.sql`p."name" || ' · ' || v."name"`),
  ]);
  const group = (rows: { name: string; units: bigint; taxable: bigint }[]) => rows.map((r) => ({ name: r.name, units: num(r.units), netSales: num(r.taxable) }));

  res.json({
    range: { from: s.from, to: s.to },
    totals: {
      invoices: num(totals?.invoices),
      units: num(units?.units),
      /** Sales after discount, before GST. */
      netSales: num(totals?.taxable),
      tax: num(totals?.tax),
      /** What customers were billed, GST and round-off included. */
      billed: num(totals?.total),
      paidAtCounter: num(totals?.tendered),
      onCredit: num(totals?.total) - num(totals?.tendered),
    },
    cancelled: { count: num(cancelled?.count), total: num(cancelled?.total) },
    byDay: byDay.map((r) => ({ date: r.date, invoices: num(r.invoices), billed: num(r.total), netSales: num(r.taxable) })),
    byBranch: byBranch.map((r) => ({ branchId: r.branchId, name: r.name, invoices: num(r.invoices), billed: num(r.total), netSales: num(r.taxable) })),
    byBrand: group(byBrand),
    byCategory: group(byCategory),
    topProducts: group(topProducts).slice(0, 20),
  });
});

// ---------------------------------------------------------------------------
// Collections: money in and out by payment method
// ---------------------------------------------------------------------------

async function tenderFlows(s: Scope) {
  return prisma.$queryRaw<{ date: string; branchId: string; type: string; method: PaymentMethod; amount: bigint }[]>`
    SELECT d."businessDate"::text AS date, d."branchId", d."type"::text AS type, t."method", SUM(t."amount")::bigint AS amount
    FROM "Tender" t JOIN "Document" d ON d."id" = t."documentId"
    WHERE ${docsWhere("d", ["SALE", "RECEIPT", "PURCHASE", "EXPENSE", "PAYMENT"], s)}
    GROUP BY 1, 2, 3, 4 ORDER BY 1`;
}

const MONEY_IN = new Set(["SALE", "RECEIPT"]);

reportsRouter.get("/collections", requirePermission("report.view"), async (req, res) => {
  const s = await scopeOf(req);
  const rows = await tenderFlows(s);
  const methods = new Map<PaymentMethod, { method: PaymentMethod; atCounter: number; receipts: number; paidOut: number }>();
  const days = new Map<string, { date: string; in: number; out: number }>();
  for (const r of rows) {
    const amount = num(r.amount);
    const m = methods.get(r.method) ?? { method: r.method, atCounter: 0, receipts: 0, paidOut: 0 };
    const d = days.get(r.date) ?? { date: r.date, in: 0, out: 0 };
    if (r.type === "SALE") m.atCounter += amount;
    else if (r.type === "RECEIPT") m.receipts += amount;
    else m.paidOut += amount;
    if (MONEY_IN.has(r.type)) d.in += amount;
    else d.out += amount;
    methods.set(r.method, m);
    days.set(r.date, d);
  }
  const byMethod = [...methods.values()].map((m) => ({ ...m, collected: m.atCounter + m.receipts, net: m.atCounter + m.receipts - m.paidOut }));
  res.json({
    range: { from: s.from, to: s.to },
    totals: {
      atCounter: byMethod.reduce((a, m) => a + m.atCounter, 0),
      receipts: byMethod.reduce((a, m) => a + m.receipts, 0),
      collected: byMethod.reduce((a, m) => a + m.collected, 0),
      paidOut: byMethod.reduce((a, m) => a + m.paidOut, 0),
    },
    byMethod,
    byDay: [...days.values()],
  });
});

// ---------------------------------------------------------------------------
// Profit: verified, estimated and unknown-cost sales are never added together
// ---------------------------------------------------------------------------

type Bucket = { lines: number; units: number; revenue: number; cost: number; profit: number };
const emptyBucket = (): Bucket => ({ lines: 0, units: 0, revenue: 0, cost: 0, profit: 0 });

interface ConfidenceRow {
  key: string;
  confidence: CostConfidence;
  lines: bigint;
  units: bigint;
  revenue: bigint;
  cost: bigint;
}

/** Splits rows by confidence. Unknown-cost sales carry revenue only: their profit is not known. */
function splitByConfidence(rows: ConfidenceRow[]) {
  const out = new Map<string, { verified: Bucket; estimated: Bucket; unknown: { lines: number; units: number; revenue: number } }>();
  for (const r of rows) {
    const g = out.get(r.key) ?? { verified: emptyBucket(), estimated: emptyBucket(), unknown: { lines: 0, units: 0, revenue: 0 } };
    const base = { lines: num(r.lines), units: num(r.units), revenue: num(r.revenue) };
    if (r.confidence === "UNKNOWN") {
      g.unknown = { lines: g.unknown.lines + base.lines, units: g.unknown.units + base.units, revenue: g.unknown.revenue + base.revenue };
    } else {
      const b = r.confidence === "VERIFIED" ? g.verified : g.estimated;
      b.lines += base.lines;
      b.units += base.units;
      b.revenue += base.revenue;
      b.cost += num(r.cost);
      b.profit = b.revenue - b.cost;
    }
    out.set(r.key, g);
  }
  return out;
}

/**
 * Profit per sale line by cost confidence, grouped by `key`. Revenue is the
 * line's value after discount and before GST (for a non-GST branch, the full price).
 */
function profitRows(s: Scope, key: Prisma.Sql, label: Prisma.Sql = key) {
  return prisma.$queryRaw<(ConfidenceRow & { label: string })[]>`
    SELECT ${key} AS key, ${label} AS label, COALESCE(l."costConfidence", 'UNKNOWN') AS confidence,
      COUNT(*)::bigint AS lines, SUM(l."quantity")::bigint AS units,
      SUM(l."taxableValue")::bigint AS revenue, SUM(l."costTotal")::bigint AS cost
    FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId"
      JOIN "Variant" v ON v."id" = l."variantId" JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "Brand" br ON br."id" = p."brandId"
      JOIN "Branch" b ON b."id" = d."branchId"
    WHERE ${docsWhere("d", ["SALE"], s)}
    GROUP BY 1, 2, 3`;
}

function groupedProfit(rows: (ConfidenceRow & { label: string })[], limit: number) {
  const labels = new Map(rows.map((r) => [r.key, r.label]));
  return [...splitByConfidence(rows).entries()]
    .map(([key, g]) => ({ key, name: labels.get(key) ?? key, ...g }))
    .sort((a, b) => b.verified.revenue + b.estimated.revenue + b.unknown.revenue - (a.verified.revenue + a.estimated.revenue + a.unknown.revenue))
    .slice(0, limit);
}

async function expensesOf(s: Scope) {
  const rows = await prisma.$queryRaw<{ branchId: string; category: ExpenseCategory; total: bigint }[]>`
    SELECT d."branchId", d."expenseCategory" AS category, SUM(d."total")::bigint AS total
    FROM "Document" d WHERE ${docsWhere("d", ["EXPENSE"], s)} GROUP BY 1, 2`;
  return rows.map((r) => ({ branchId: r.branchId, category: r.category, total: num(r.total) }));
}

/** Net debit of loss-type ledger accounts in the range: positive is a cost to the shop. */
async function otherCostsOf(s: Scope) {
  const rows = await prisma.$queryRaw<{ branchId: string; account: string; net: bigint }[]>`
    SELECT e."branchId", e."account"::text AS account, SUM(e."debit" - e."credit")::bigint AS net
    FROM "LedgerEntry" e
    WHERE e."businessId" = ${s.businessId} AND e."account" IN ('STOCK_LOSS', 'PRICE_VARIANCE', 'CASH_OVER_SHORT')
      AND e."businessDate" BETWEEN ${s.from}::date AND ${s.to}::date ${inBranches(`e."branchId"`, s)}
    GROUP BY 1, 2`;
  return rows.map((r) => ({ branchId: r.branchId, account: r.account, net: num(r.net) }));
}

reportsRouter.get("/profit", requirePermission("report.view"), requirePermission("cost.view"), async (req, res) => {
  const s = await scopeOf(req);
  const [all, brands, products, expenses, other] = await Promise.all([
    profitRows(s, Prisma.sql`'all'`),
    profitRows(s, Prisma.sql`COALESCE(br."id", '')`, Prisma.sql`COALESCE(br."name", 'No brand')`),
    profitRows(s, Prisma.sql`v."id"`, Prisma.sql`p."name" || ' · ' || v."name"`),
    expensesOf(s),
    otherCostsOf(s),
  ]);
  const missing = await prisma.$queryRaw<{ documentId: string; number: string; date: string; product: string; quantity: number; revenue: number; serials: string | null }[]>`
    SELECT d."id" AS "documentId", d."number", d."businessDate"::text AS date, p."name" || ' · ' || v."name" AS product,
      l."quantity", l."taxableValue" AS revenue,
      (SELECT string_agg(su."imei", ', ') FROM "LineSerial" ls JOIN "SerialUnit" su ON su."id" = ls."serialUnitId" WHERE ls."lineId" = l."id") AS serials
    FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId"
      JOIN "Variant" v ON v."id" = l."variantId" JOIN "Product" p ON p."id" = v."productId"
    WHERE ${docsWhere("d", ["SALE"], s)} AND COALESCE(l."costConfidence", 'UNKNOWN') = 'UNKNOWN'
    ORDER BY d."businessDate" DESC, d."number" DESC LIMIT 100`;

  const totals = splitByConfidence(all).get("all") ?? { verified: emptyBucket(), estimated: emptyBucket(), unknown: { lines: 0, units: 0, revenue: 0 } };
  const byCategory = new Map<string, number>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.total);
  const expenseTotal = expenses.reduce((a, e) => a + e.total, 0);
  const sumOf = (account: string) => other.filter((o) => o.account === account).reduce((a, o) => a + o.net, 0);
  const otherCosts = { stockLoss: sumOf("STOCK_LOSS"), priceVariance: sumOf("PRICE_VARIANCE"), cashShortage: sumOf("CASH_OVER_SHORT") };
  const otherTotal = otherCosts.stockLoss + otherCosts.priceVariance + otherCosts.cashShortage;

  res.json({
    range: { from: s.from, to: s.to },
    ...totals,
    expenses: { total: expenseTotal, byCategory: [...byCategory.entries()].map(([category, total]) => ({ category, total })) },
    otherCosts,
    /** The conservative bottom line: verified profit less all expenses and losses. Estimated profit is never added in. */
    verifiedAfterExpenses: totals.verified.profit - expenseTotal - otherTotal,
    byBrand: groupedProfit(brands, 50),
    byProduct: groupedProfit(products, 50),
    missingCosts: missing.map((m) => ({ ...m, quantity: num(m.quantity), revenue: num(m.revenue) })),
  });
});

// ---------------------------------------------------------------------------
// Stock: what is on hand now, its value and age
// ---------------------------------------------------------------------------

const AGE_BUCKETS = [
  { label: "0–30 days", max: 30 },
  { label: "31–60 days", max: 60 },
  { label: "61–90 days", max: 90 },
  { label: "Over 90 days", max: Infinity },
];

reportsRouter.get("/stock", requirePermission("stock.view"), async (req, res) => {
  const s = await scopeOf(req);
  const showCost = canSeeCost(req);
  // Phones carry their own cost and confidence, so they are valued device by device;
  // accessories by their branch balance, whose confidence is the weakest cost layer in it.
  const byBranch = await prisma.$queryRaw<
    { branchId: string; name: string; units: bigint; items: bigint; value: bigint; verified: bigint; estimated: bigint; unknownUnits: bigint; retail: bigint }[]
  >`
    WITH layers AS (
      SELECT sb."branchId", sb."variantId", sb."quantity" AS qty, sb."value" AS value, sb."costConfidence" AS confidence
      FROM "StockBalance" sb JOIN "Variant" v ON v."id" = sb."variantId" JOIN "Product" p ON p."id" = v."productId"
      WHERE sb."businessId" = ${s.businessId} AND sb."quantity" > 0 AND p."isSerialized" = false ${inBranches(`sb."branchId"`, s)}
      UNION ALL
      SELECT su."branchId", su."variantId", 1, su."unitCost", su."costConfidence"
      FROM "SerialUnit" su
      WHERE su."businessId" = ${s.businessId} AND su."status" = 'IN_STOCK' ${inBranches(`su."branchId"`, s)}
    )
    SELECT l."branchId", b."name", SUM(l.qty)::bigint AS units, COUNT(DISTINCT l."variantId")::bigint AS items,
      SUM(l.value)::bigint AS value,
      COALESCE(SUM(l.value) FILTER (WHERE l.confidence = 'VERIFIED'), 0)::bigint AS verified,
      COALESCE(SUM(l.value) FILTER (WHERE l.confidence = 'ESTIMATED'), 0)::bigint AS estimated,
      COALESCE(SUM(l.qty) FILTER (WHERE l.confidence = 'UNKNOWN'), 0)::bigint AS "unknownUnits",
      SUM(l.qty::bigint * COALESCE(v."salePrice", 0))::bigint AS retail
    FROM layers l JOIN "Branch" b ON b."id" = l."branchId" JOIN "Variant" v ON v."id" = l."variantId"
    GROUP BY 1, 2 ORDER BY 2`;
  const byCategory = await prisma.$queryRaw<{ name: string; units: bigint; value: bigint; retail: bigint }[]>`
    SELECT COALESCE(c."name", 'No category') AS name, SUM(sb."quantity")::bigint AS units, SUM(sb."value")::bigint AS value,
      SUM(sb."quantity"::bigint * COALESCE(v."salePrice", 0))::bigint AS retail
    FROM "StockBalance" sb JOIN "Variant" v ON v."id" = sb."variantId" JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "Category" c ON c."id" = p."categoryId"
    WHERE sb."businessId" = ${s.businessId} AND sb."quantity" > 0 ${inBranches(`sb."branchId"`, s)}
    GROUP BY 1 ORDER BY 3 DESC`;
  const lowStock = await prisma.$queryRaw<{ branch: string; product: string; quantity: number; reorderLevel: number }[]>`
    SELECT b."name" AS branch, p."name" || ' · ' || v."name" AS product, COALESCE(sb."quantity", 0) AS quantity, v."reorderLevel"
    FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
      JOIN "Branch" b ON b."businessId" = v."businessId" AND b."archivedAt" IS NULL
      LEFT JOIN "StockBalance" sb ON sb."variantId" = v."id" AND sb."branchId" = b."id"
    WHERE v."businessId" = ${s.businessId} AND v."archivedAt" IS NULL AND p."archivedAt" IS NULL
      AND v."reorderLevel" > 0 AND COALESCE(sb."quantity", 0) <= v."reorderLevel" ${inBranches(`b."id"`, s)}
    ORDER BY 3, 2 LIMIT 200`;
  const scopeOrTarget =
    s.branchIds === null ? Prisma.empty : Prisma.sql`AND (d."branchId" = ANY(${s.branchIds}::text[]) OR d."toBranchId" = ANY(${s.branchIds}::text[]))`;
  const [transit] = await prisma.$queryRaw<{ transfers: bigint; units: bigint; value: bigint }[]>`
    SELECT COUNT(DISTINCT d."id")::bigint AS transfers, COALESCE(SUM(l."quantity"), 0)::bigint AS units, COALESCE(SUM(l."costTotal"), 0)::bigint AS value
    FROM "Document" d JOIN "DocumentLine" l ON l."documentId" = d."id"
    WHERE d."businessId" = ${s.businessId} AND d."type" = 'TRANSFER' AND d."status" = 'IN_TRANSIT' ${scopeOrTarget}`;
  // A device's age is counted from the last day it came into the branch it is at now.
  const devices = await prisma.$queryRaw<{ imei: string; product: string; branch: string; unitCost: number; costConfidence: CostConfidence; days: number }[]>`
    SELECT su."imei", p."name" || ' · ' || v."name" AS product, b."name" AS branch, su."unitCost", su."costConfidence",
      (${s.today}::date - COALESCE((
        SELECT MAX(m."businessDate") FROM "StockMovement" m
        WHERE m."serialUnitId" = su."id" AND m."branchId" = su."branchId" AND m."quantity" > 0 AND m."isReversal" = false
      ), su."createdAt"::date))::int AS days
    FROM "SerialUnit" su JOIN "Variant" v ON v."id" = su."variantId" JOIN "Product" p ON p."id" = v."productId"
      JOIN "Branch" b ON b."id" = su."branchId"
    WHERE su."businessId" = ${s.businessId} AND su."status" = 'IN_STOCK' ${inBranches(`su."branchId"`, s)}
    ORDER BY days DESC`;

  const aging = AGE_BUCKETS.map((b) => ({ label: b.label, devices: 0, value: 0 }));
  for (const d of devices) {
    const i = AGE_BUCKETS.findIndex((b) => d.days <= b.max);
    aging[i]!.devices += 1;
    aging[i]!.value += d.unitCost;
  }
  const cost = <T extends object>(withCost: T, without: Partial<T>) => (showCost ? withCost : without);

  res.json({
    asOf: s.today,
    byBranch: byBranch.map((r) => ({
      branchId: r.branchId,
      name: r.name,
      units: num(r.units),
      items: num(r.items),
      retailValue: num(r.retail),
      ...cost(
        { value: num(r.value), verifiedValue: num(r.verified), estimatedValue: num(r.estimated), unknownCostUnits: num(r.unknownUnits) },
        {},
      ),
    })),
    byCategory: byCategory.map((r) => ({ name: r.name, units: num(r.units), retailValue: num(r.retail), ...cost({ value: num(r.value) }, {}) })),
    lowStock: lowStock.map((r) => ({ ...r, quantity: num(r.quantity), reorderLevel: num(r.reorderLevel) })),
    inTransit: { transfers: num(transit?.transfers), units: num(transit?.units), ...cost({ value: num(transit?.value) }, {}) },
    deviceAging: aging.map((a) => ({ label: a.label, devices: a.devices, ...cost({ value: a.value }, {}) })),
    oldestDevices: devices.slice(0, 20).map((d) => ({
      imei: d.imei,
      product: d.product,
      branch: d.branch,
      days: d.days,
      ...cost({ unitCost: d.unitCost, costConfidence: d.costConfidence }, {}),
    })),
  });
});

// ---------------------------------------------------------------------------
// Dues: what customers owe and what is owed to suppliers, right now
// ---------------------------------------------------------------------------

async function partyBalances(s: Scope, account: "RECEIVABLE" | "PAYABLE", openTypes: string[]) {
  const sign = account === "RECEIVABLE" ? Prisma.sql`e."debit" - e."credit"` : Prisma.sql`e."credit" - e."debit"`;
  const rows = await prisma.$queryRaw<{ partyId: string; name: string; phone: string | null; balance: bigint; oldest: string | null }[]>`
    SELECT p."id" AS "partyId", p."name", p."phone", SUM(${sign})::bigint AS balance,
      (SELECT MIN(d."businessDate")::text FROM "Document" d
        WHERE d."businessId" = ${s.businessId} AND d."partyId" = p."id" AND d."status" = 'POSTED'
          AND d."type"::text = ANY(${openTypes}::text[]) AND d."paidAmount" < d."total" ${inBranches(`d."branchId"`, s)}) AS oldest
    FROM "LedgerEntry" e JOIN "Party" p ON p."id" = e."partyId"
    WHERE e."businessId" = ${s.businessId} AND e."account" = ${account}::"LedgerAccount" ${inBranches(`e."branchId"`, s)}
    GROUP BY 1, 2, 3 HAVING SUM(${sign}) <> 0
    ORDER BY 4 DESC`;
  return rows.map((r) => ({ partyId: r.partyId, name: r.name, phone: r.phone, balance: num(r.balance), oldestOpen: r.oldest }));
}

/** Unpaid amounts of open invoices or bills, by how long ago they were dated. */
async function agingOf(s: Scope, types: string[]) {
  const rows = await prisma.$queryRaw<{ days: number; due: bigint }[]>`
    SELECT (${s.today}::date - d."businessDate")::int AS days, SUM(d."total" - d."paidAmount")::bigint AS due
    FROM "Document" d
    WHERE d."businessId" = ${s.businessId} AND d."status" = 'POSTED' AND d."type"::text = ANY(${types}::text[])
      AND d."paidAmount" < d."total" AND d."partyId" IS NOT NULL ${inBranches(`d."branchId"`, s)}
    GROUP BY 1`;
  const buckets = AGE_BUCKETS.map((b) => ({ label: b.label, amount: 0 }));
  for (const r of rows) buckets[AGE_BUCKETS.findIndex((b) => r.days <= b.max)]!.amount += num(r.due);
  return buckets;
}

reportsRouter.get("/dues", requirePermission("report.view"), async (req, res) => {
  const s = await scopeOf(req);
  const [customers, suppliers, customerAging, supplierAging] = await Promise.all([
    partyBalances(s, "RECEIVABLE", ["SALE"]),
    partyBalances(s, "PAYABLE", ["PURCHASE", "EXPENSE"]),
    agingOf(s, ["SALE"]),
    agingOf(s, ["PURCHASE", "EXPENSE"]),
  ]);
  const owed = (rows: { balance: number }[]) => rows.filter((r) => r.balance > 0).reduce((a, r) => a + r.balance, 0);
  const advances = (rows: { balance: number }[]) => rows.filter((r) => r.balance < 0).reduce((a, r) => a - r.balance, 0);
  res.json({
    asOf: s.today,
    /** Positive balance: the customer owes the shop. Negative: an advance the shop holds. */
    customers: { totalDue: owed(customers), advances: advances(customers), aging: customerAging, parties: customers },
    /** Positive balance: the shop owes the supplier. Negative: paid in advance. */
    suppliers: { totalDue: owed(suppliers), advances: advances(suppliers), aging: supplierAging, parties: suppliers },
  });
});

// ---------------------------------------------------------------------------
// GST summary, per GST-registered branch (each branch has its own GSTIN)
// ---------------------------------------------------------------------------

interface TaxRow {
  branchId: string;
  rate: number;
  taxable: bigint;
  cgst: bigint;
  sgst: bigint;
  igst: bigint;
}

function taxByRate(type: "SALE" | "PURCHASE", s: Scope) {
  return prisma.$queryRaw<TaxRow[]>`
    SELECT d."branchId", l."gstRateBps" AS rate, SUM(l."taxableValue")::bigint AS taxable,
      SUM(l."cgst")::bigint AS cgst, SUM(l."sgst")::bigint AS sgst, SUM(l."igst")::bigint AS igst
    FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId"
    WHERE ${docsWhere("d", [type], s)} AND d."gstApplied" = true
    GROUP BY 1, 2 ORDER BY 2`;
}

const taxView = (r: { taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint }) => {
  const t = { taxable: num(r.taxable), cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst) };
  return { ...t, tax: t.cgst + t.sgst + t.igst };
};

reportsRouter.get("/gst", requirePermission("report.view"), async (req, res) => {
  const s = await scopeOf(req);
  const branches = await prisma.branch.findMany({
    where: { businessId: s.businessId, ...(s.branchIds === null ? {} : { id: { in: s.branchIds } }) },
    select: { id: true, name: true, gstin: true, gstEnabled: true },
    orderBy: { createdAt: "asc" },
  });
  const sales = Prisma.sql`${docsWhere("d", ["SALE"], s)} AND d."gstApplied" = true`;
  const [outward, inward, hsn, split, b2b, docs] = await Promise.all([
    taxByRate("SALE", s),
    taxByRate("PURCHASE", s),
    prisma.$queryRaw<(TaxRow & { hsn: string; units: bigint })[]>`
      SELECT d."branchId", COALESCE(p."hsnCode", '') AS hsn, l."gstRateBps" AS rate, SUM(l."quantity")::bigint AS units,
        SUM(l."taxableValue")::bigint AS taxable, SUM(l."cgst")::bigint AS cgst, SUM(l."sgst")::bigint AS sgst, SUM(l."igst")::bigint AS igst
      FROM "DocumentLine" l JOIN "Document" d ON d."id" = l."documentId"
        JOIN "Variant" v ON v."id" = l."variantId" JOIN "Product" p ON p."id" = v."productId"
      WHERE ${sales} GROUP BY 1, 2, 3 ORDER BY 2, 3`,
    prisma.$queryRaw<{ branchId: string; b2b: boolean; invoices: bigint; taxable: bigint; tax: bigint }[]>`
      SELECT d."branchId", (pa."gstin" IS NOT NULL) AS b2b, COUNT(*)::bigint AS invoices,
        SUM(d."taxableTotal")::bigint AS taxable, SUM(d."taxTotal")::bigint AS tax
      FROM "Document" d LEFT JOIN "Party" pa ON pa."id" = d."partyId"
      WHERE ${sales} GROUP BY 1, 2`,
    prisma.$queryRaw<{ branchId: string; documentId: string; number: string; date: string; party: string; gstin: string; interState: boolean; taxable: number; tax: number; total: number }[]>`
      SELECT d."branchId", d."id" AS "documentId", d."number", d."businessDate"::text AS date, pa."name" AS party, pa."gstin",
        d."interState", d."taxableTotal" AS taxable, d."taxTotal" AS tax, d."total"
      FROM "Document" d JOIN "Party" pa ON pa."id" = d."partyId"
      WHERE ${sales} AND pa."gstin" IS NOT NULL ORDER BY d."businessDate", d."number" LIMIT 1000`,
    prisma.$queryRaw<{ branchId: string; first: string; last: string; issued: bigint; cancelled: bigint }[]>`
      SELECT d."branchId", MIN(d."number") AS first, MAX(d."number") AS last, COUNT(*)::bigint AS issued,
        COUNT(*) FILTER (WHERE d."status" = 'CANCELLED')::bigint AS cancelled
      FROM "Document" d
      WHERE d."businessId" = ${s.businessId} AND d."type" = 'SALE' AND d."gstApplied" = true
        AND d."businessDate" BETWEEN ${s.from}::date AND ${s.to}::date ${inBranches(`d."branchId"`, s)}
      GROUP BY 1`,
  ]);

  const result = branches
    .filter((b) => b.gstEnabled || outward.some((o) => o.branchId === b.id) || inward.some((i) => i.branchId === b.id))
    .map((b) => {
      const out = outward.filter((r) => r.branchId === b.id).map((r) => ({ rate: r.rate, ...taxView(r) }));
      const inn = inward.filter((r) => r.branchId === b.id).map((r) => ({ rate: r.rate, ...taxView(r) }));
      const outputTax = out.reduce((a, r) => a + r.tax, 0);
      const inputTax = inn.reduce((a, r) => a + r.tax, 0);
      const d = docs.find((x) => x.branchId === b.id);
      const sp = (isB2b: boolean) => {
        const r = split.find((x) => x.branchId === b.id && x.b2b === isB2b);
        return { invoices: num(r?.invoices), taxable: num(r?.taxable), tax: num(r?.tax) };
      };
      return {
        branchId: b.id,
        name: b.name,
        gstin: b.gstin,
        gstEnabled: b.gstEnabled,
        outward: out,
        inward: inn,
        outputTax,
        inputTax,
        /** Output tax less input credit, before any carried-forward credit. Negative means credit to carry forward. */
        netTax: outputTax - inputTax,
        b2b: sp(true),
        b2c: sp(false),
        hsn: hsn.filter((r) => r.branchId === b.id).map((r) => ({ hsn: r.hsn, rate: r.rate, units: num(r.units), ...taxView(r) })),
        b2bInvoices: b2b.filter((r) => r.branchId === b.id).map(({ branchId: _b, ...r }) => r),
        documents: d ? { first: d.first, last: d.last, issued: num(d.issued), cancelled: num(d.cancelled) } : null,
      };
    });
  res.json({ range: { from: s.from, to: s.to }, branches: result });
});

// ---------------------------------------------------------------------------
// Branch comparison
// ---------------------------------------------------------------------------

reportsRouter.get("/branches", requirePermission("report.view"), async (req, res) => {
  const s = await scopeOf(req);
  const showCost = canSeeCost(req);
  const branches = await prisma.branch.findMany({
    where: { businessId: s.businessId, archivedAt: null, ...(s.branchIds === null ? {} : { id: { in: s.branchIds } }) },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const [sales, flows, expenses, other, profit, stock] = await Promise.all([
    prisma.$queryRaw<{ branchId: string; invoices: bigint; total: bigint; taxable: bigint }[]>`
      SELECT d."branchId", COUNT(*)::bigint AS invoices, SUM(d."total")::bigint AS total, SUM(d."taxableTotal")::bigint AS taxable
      FROM "Document" d WHERE ${docsWhere("d", ["SALE"], s)} GROUP BY 1`,
    tenderFlows(s),
    expensesOf(s),
    otherCostsOf(s),
    showCost ? profitRows(s, Prisma.sql`d."branchId"`) : Promise.resolve([]),
    prisma.$queryRaw<{ branchId: string; units: bigint; value: bigint }[]>`
      SELECT sb."branchId", SUM(sb."quantity")::bigint AS units, SUM(sb."value")::bigint AS value
      FROM "StockBalance" sb WHERE sb."businessId" = ${s.businessId} ${inBranches(`sb."branchId"`, s)} GROUP BY 1`,
  ]);
  const profits = splitByConfidence(profit);
  res.json({
    range: { from: s.from, to: s.to },
    branches: branches.map((b) => {
      const sale = sales.find((x) => x.branchId === b.id);
      const p = profits.get(b.id);
      const st = stock.find((x) => x.branchId === b.id);
      const expenseTotal = expenses.filter((e) => e.branchId === b.id).reduce((a, e) => a + e.total, 0);
      const otherTotal = other.filter((o) => o.branchId === b.id).reduce((a, o) => a + o.net, 0);
      return {
        branchId: b.id,
        name: b.name,
        invoices: num(sale?.invoices),
        billed: num(sale?.total),
        netSales: num(sale?.taxable),
        collected: flows.filter((f) => f.branchId === b.id && MONEY_IN.has(f.type)).reduce((a, f) => a + num(f.amount), 0),
        expenses: expenseTotal,
        stockUnits: num(st?.units),
        ...(showCost
          ? {
              verifiedProfit: p?.verified.profit ?? 0,
              estimatedProfit: p?.estimated.profit ?? 0,
              unknownCostRevenue: p?.unknown.revenue ?? 0,
              verifiedAfterExpenses: (p?.verified.profit ?? 0) - expenseTotal - otherTotal,
              stockValue: num(st?.value),
            }
          : {}),
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// A cashier's own sales today
// ---------------------------------------------------------------------------

reportsRouter.get("/my-day", requirePermission("sale.create"), async (req, res) => {
  const { businessId, branchIds } = tenantOf(req);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const today = todayIn(business.timezone);
  const docs = await prisma.document.findMany({
    where: {
      businessId,
      type: "SALE",
      createdById: req.user!.id,
      businessDate: new Date(`${today}T00:00:00Z`),
      ...(branchIds === null ? {} : { branchId: { in: branchIds } }),
    },
    select: { id: true, number: true, status: true, total: true, paidAmount: true, postedAt: true, party: { select: { name: true } }, tenders: { select: { method: true, amount: true } } },
    orderBy: { postedAt: "desc" },
  });
  const posted = docs.filter((d) => d.status === "POSTED");
  const byMethod = new Map<string, number>();
  for (const t of posted.flatMap((d) => d.tenders)) byMethod.set(t.method, (byMethod.get(t.method) ?? 0) + t.amount);
  res.json({
    date: today,
    invoices: posted.length,
    billed: posted.reduce((a, d) => a + d.total, 0),
    byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, amount })),
    onCredit: posted.reduce((a, d) => a + d.total - d.tenders.reduce((x, t) => x + t.amount, 0), 0),
    sales: docs.map(({ tenders: _t, ...d }) => d),
  });
});
