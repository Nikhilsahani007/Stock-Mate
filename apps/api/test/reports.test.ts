import { todayIn } from "@stockpilot/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { addMember, assertBooksBalance, imei, prisma, resetDb, stockedShop, type Shop } from "./helpers.js";

beforeEach(resetDb);

const TODAY = todayIn("Asia/Kolkata");
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function buy(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/purchases`).send({ branchId: shop.branchId, partyId: shop.supplierId, lines, ...extra });
}

function sell(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/sales`).send({ branchId: shop.branchId, lines, ...extra });
}

/** Cash balance of a branch's drawer in the ledger, through a date. */
async function cashThrough(shop: Shop, date: string) {
  const r = await prisma.ledgerEntry.aggregate({
    where: { businessId: shop.businessId, branchId: shop.branchId, account: "CASH", businessDate: { lte: new Date(`${date}T00:00:00Z`) } },
    _sum: { debit: true, credit: true },
  });
  return (r._sum.debit ?? 0) - (r._sum.credit ?? 0);
}

/** One phone bought (verified cost), one with a typed-in cost (estimated), one with no cost (unknown), all sold. */
async function threePhoneShop() {
  const shop = await stockedShop();
  await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
  await shop.c
    .post(`${shop.base}/opening-stock`)
    .send({
      branchId: shop.branchId,
      lines: [
        { variantId: shop.phoneId, quantity: 1, unitCost: 900_000, serials: [{ imei: imei(2) }] },
        { variantId: shop.phoneId, quantity: 1, serials: [{ imei: imei(3) }] },
      ],
    })
    .expect(201);
  for (const n of [1, 2, 3]) {
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(n)] }], { tenders: [{ method: "CASH", amount: 1_200_000 }] }).expect(201);
  }
  await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
  const cover = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "UPI", amount: 19_900 }] }).expect(201);
  await shop.c.post(`${shop.base}/documents/${cover.body.document.id}/cancel`).send({ reason: "Wrong item" }).expect(200);
  await shop.c.post(`${shop.base}/expenses`).send({ branchId: shop.branchId, category: "RENT", amount: 50_000, method: "CASH" }).expect(201);
  return shop;
}

describe("profit report", () => {
  it("keeps verified, estimated and unknown-cost profit apart", async () => {
    const shop = await threePhoneShop();
    const res = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(res.body.verified).toMatchObject({ lines: 1, revenue: 1_200_000, cost: 1_000_000, profit: 200_000 });
    expect(res.body.estimated).toMatchObject({ lines: 1, revenue: 1_200_000, cost: 900_000, profit: 300_000 });
    // Unknown cost: revenue only, never a profit figure
    expect(res.body.unknown).toEqual({ lines: 1, units: 1, revenue: 1_200_000 });
    expect(res.body.missingCosts).toHaveLength(1);
    expect(res.body.missingCosts[0].serials).toBe(imei(3));
    expect(res.body.expenses.total).toBe(50_000);
    expect(res.body.verifiedAfterExpenses).toBe(150_000);
    expect(res.body.byProduct[0]).toMatchObject({ name: "Galaxy A15 · 6/128 Black", unknown: { revenue: 1_200_000 } });
  });

  it("is only for roles that may see costs", async () => {
    const shop = await stockedShop();
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    await cashier.c.get(`${shop.base}/reports/profit`).expect(403);
    await cashier.c.get(`${shop.base}/reports/sales`).expect(403);
    const inventory = await addMember(shop.c, shop.businessId, "INVENTORY_STAFF", [shop.branchId]);
    await inventory.c.get(`${shop.base}/reports/profit`).expect(403);
    await inventory.c.get(`${shop.base}/reports/stock`).expect(200);
  });
});

describe("sales, collections and dues", () => {
  it("counts posted sales, lists cancellations apart, and splits collections by method", async () => {
    const shop = await threePhoneShop();
    const sales = await shop.c.get(`${shop.base}/reports/sales?from=${TODAY}&to=${TODAY}`).expect(200);
    expect(sales.body.totals).toMatchObject({ invoices: 3, units: 3, netSales: 3_600_000, billed: 3_600_000, paidAtCounter: 3_600_000, onCredit: 0 });
    expect(sales.body.cancelled).toEqual({ count: 1, total: 19_900 });
    expect(sales.body.byDay).toEqual([{ date: TODAY, invoices: 3, billed: 3_600_000, netSales: 3_600_000 }]);

    const col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.byMethod).toEqual([
      { method: "CASH", atCounter: 3_600_000, receipts: 0, supplierRefunds: 0, paidOut: 50_000, refunded: 0, collected: 3_600_000, net: 3_550_000 },
    ]);

    // Nothing yesterday
    const empty = await shop.c.get(`${shop.base}/reports/sales?from=${YESTERDAY}&to=${YESTERDAY}`).expect(200);
    expect(empty.body.totals.invoices).toBe(0);
    await shop.c.get(`${shop.base}/reports/sales?from=${TODAY}&to=${YESTERDAY}`).expect(400);
  });

  it("shows customer and supplier dues from the ledger", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    await sell(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 20_000 }], { partyId: shop.customerId, tenders: [{ method: "CASH", amount: 5_000 }] }).expect(201);
    await shop.c.post(`${shop.base}/receipts`).send({ branchId: shop.branchId, partyId: shop.customerId, tenders: [{ method: "UPI", amount: 10_000 }] }).expect(201);

    const res = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    expect(res.body.customers.totalDue).toBe(25_000);
    expect(res.body.customers.parties).toEqual([expect.objectContaining({ name: "Ravi Kumar", balance: 25_000, oldestOpen: TODAY })]);
    expect(res.body.customers.aging[0]).toEqual({ label: "0–30 days", amount: 25_000 });
    expect(res.body.suppliers.totalDue).toBe(100_000);
  });
});

describe("stock report", () => {
  it("values stock by cost confidence and hides costs from cashiers", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    await shop.c
      .post(`${shop.base}/opening-stock`)
      .send({ branchId: shop.branchId, businessDate: YESTERDAY, lines: [{ variantId: shop.coverId, quantity: 4, unitCost: 5_000 }] })
      .expect(201);
    await shop.c.patch(`${shop.base}/catalog/variants/${shop.coverId}`).send({ reorderLevel: 5 }).expect(200);
    // A phone with no cost that is then sold leaves only the verified phone behind
    await shop.c
      .post(`${shop.base}/opening-stock`)
      .send({ branchId: shop.branchId, lines: [{ variantId: shop.phoneId, quantity: 1, serials: [{ imei: imei(2) }] }] })
      .expect(201);
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(2)] }], { tenders: [{ method: "CASH", amount: 1_200_000 }] }).expect(201);

    const res = await shop.c.get(`${shop.base}/reports/stock`).expect(200);
    expect(res.body.byBranch[0]).toMatchObject({ units: 5, items: 2, value: 1_020_000, verifiedValue: 1_000_000, estimatedValue: 20_000, unknownCostUnits: 0, retailValue: 1_599_900 + 4 * 19_900 });
    expect(res.body.lowStock).toEqual([expect.objectContaining({ quantity: 4, reorderLevel: 5 })]);
    expect(res.body.deviceAging[0]).toEqual({ label: "0–30 days", devices: 1, value: 1_000_000 });

    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    const blind = await cashier.c.get(`${shop.base}/reports/stock`).expect(200);
    expect(blind.body.byBranch[0].value).toBeUndefined();
    expect(blind.body.byBranch[0].units).toBe(5);
    expect(blind.body.oldestDevices[0].unitCost).toBeUndefined();
    expect(JSON.stringify(blind.body)).not.toMatch(/"value"/);
  });
});

describe("GST summary", () => {
  it("summarises output tax, input credit, B2B and B2C, and HSN for a GST branch", async () => {
    const shop = await stockedShop();
    await shop.c.patch(`${shop.base}/branches/${shop.branchId}`).send({ gstEnabled: true, gstin: "27AAPFU0939F1ZV" }).expect(200);
    const b2b = await shop.c.post(`${shop.base}/parties`).send({ kind: "CUSTOMER", name: "Sharma Traders", gstin: "27AAACS1234A1Z1" });
    expect(b2b.status).toBe(201);
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000 }]).expect(201);
    await sell(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 11_800 }], { partyId: b2b.body.party.id }).expect(201);
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 11_800 }], { tenders: [{ method: "CASH", amount: 11_800 }] }).expect(201);

    const res = await shop.c.get(`${shop.base}/reports/gst`).expect(200);
    const branch = res.body.branches[0];
    expect(branch.gstin).toBe("27AAPFU0939F1ZV");
    expect(branch.outward).toEqual([{ rate: 1800, taxable: 30_000, cgst: 2_700, sgst: 2_700, igst: 0, tax: 5_400 }]);
    expect(branch.inward).toEqual([{ rate: 1800, taxable: 100_000, cgst: 9_000, sgst: 9_000, igst: 0, tax: 18_000 }]);
    expect(branch.netTax).toBe(5_400 - 18_000);
    expect(branch.b2b).toEqual({ invoices: 1, taxable: 20_000, tax: 3_600 });
    expect(branch.b2c).toEqual({ invoices: 1, taxable: 10_000, tax: 1_800 });
    expect(branch.b2bInvoices).toEqual([expect.objectContaining({ party: "Sharma Traders", gstin: "27AAACS1234A1Z1", total: 23_600 })]);
    expect(branch.documents).toMatchObject({ issued: 2, cancelled: 0 });
  });
});

describe("branch scope", () => {
  it("limits branch-scoped roles to their own branches", async () => {
    const shop = await stockedShop();
    const other = await shop.c.post(`${shop.base}/branches`).send({ name: "Second shop" }).expect(201);
    const manager = await addMember(shop.c, shop.businessId, "BRANCH_MANAGER", [other.body.branch.id]);
    await manager.c.get(`${shop.base}/reports/sales?branchId=${shop.branchId}`).expect(404);
    const res = await manager.c.get(`${shop.base}/reports/branches`).expect(200);
    expect(res.body.branches.map((b: { name: string }) => b.name)).toEqual(["Second shop"]);
    const owner = await shop.c.get(`${shop.base}/reports/branches`).expect(200);
    expect(owner.body.branches).toHaveLength(2);
    expect(owner.body.branches[0]).toHaveProperty("verifiedProfit");
  });
});

describe("day close", () => {
  async function dayOne() {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }], { businessDate: YESTERDAY }).expect(201);
    await sell(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 19_900 }], { businessDate: YESTERDAY, tenders: [{ method: "CASH", amount: 39_800 }] }).expect(201);
    await shop.c.post(`${shop.base}/expenses`).send({ branchId: shop.branchId, businessDate: YESTERDAY, category: "OTHER", amount: 5_000, method: "CASH" }).expect(201);
    return shop;
  }

  it("compares counted cash with the books, posts the shortage and hand-over, and locks the day", async () => {
    const shop = await dayOne();
    const preview = await shop.c.get(`${shop.base}/day-closes/preview?branchId=${shop.branchId}&date=${YESTERDAY}`).expect(200);
    expect(preview.body).toMatchObject({ openingCash: 0, cashIn: 39_800, cashOut: 5_000, expectedCash: 34_800, firstClose: true, canClose: true });
    expect(preview.body.summary.sales).toMatchObject({ count: 1, total: 39_800 });

    // ₹10,000 float already in the drawer; ₹8 short; ₹300 deposited in the bank.
    const close = await shop.c
      .post(`${shop.base}/day-closes`)
      .send({ branchId: shop.branchId, businessDate: YESTERDAY, countedCash: 1_034_000, openingFloat: 1_000_000, handedOver: 30_000, handedOverTo: "BANK" })
      .expect(201);
    expect(close.body.dayClose).toMatchObject({ expectedCash: 1_034_800, countedCash: 1_034_000, difference: -800 });
    expect(await cashThrough(shop, YESTERDAY)).toBe(1_004_000);
    const books = await assertBooksBalance(shop.businessId);
    expect(books.debits).toBe(books.credits);

    // The closed day takes no more postings, including cancellations
    const late = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { businessDate: YESTERDAY, tenders: [{ method: "CASH", amount: 19_900 }] }).expect(409);
    expect(late.body.error.code).toBe("DAY_CLOSED");
    const sale = await prisma.document.findFirstOrThrow({ where: { businessId: shop.businessId, type: "SALE" } });
    await shop.c.post(`${shop.base}/documents/${sale.id}/cancel`).send({ reason: "Mistake" }).expect(409);
    await shop.c
      .post(`${shop.base}/day-closes`)
      .send({ branchId: shop.branchId, businessDate: YESTERDAY, countedCash: 0 })
      .expect(409);

    // Today starts from what was left in the drawer
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 19_900 }] }).expect(201);
    const today = await shop.c.get(`${shop.base}/day-closes/preview?branchId=${shop.branchId}`).expect(200);
    expect(today.body).toMatchObject({ openingCash: 1_004_000, cashIn: 19_900, expectedCash: 1_023_900, firstClose: false, lastClosedDate: YESTERDAY });
    await shop.c
      .post(`${shop.base}/day-closes`)
      .send({ branchId: shop.branchId, countedCash: 1_023_900, openingFloat: 100 })
      .expect(400);
    const second = await shop.c.post(`${shop.base}/day-closes`).send({ branchId: shop.branchId, countedCash: 1_023_900 }).expect(201);
    expect(second.body.dayClose.difference).toBe(0);

    // The shortage shows in the profit report as a cost
    const profit = await shop.c.get(`${shop.base}/reports/profit?from=${YESTERDAY}&to=${TODAY}`).expect(200);
    expect(profit.body.otherCosts.cashShortage).toBe(800);

    // Reopen latest first, then the day before; then yesterday takes postings again
    await shop.c.post(`${shop.base}/day-closes/${close.body.dayClose.id}/reopen`).send({ reason: "Missed a bill" }).expect(409);
    await shop.c.post(`${shop.base}/day-closes/${second.body.dayClose.id}/reopen`).send({ reason: "Recount" }).expect(200);
    const reopened = await shop.c.post(`${shop.base}/day-closes/${close.body.dayClose.id}/reopen`).send({ reason: "Missed a bill" }).expect(200);
    expect(reopened.body.dayClose.reopenedAt).not.toBeNull();
    expect(await cashThrough(shop, YESTERDAY)).toBe(34_800);
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { businessDate: YESTERDAY, tenders: [{ method: "CASH", amount: 19_900 }] }).expect(201);
    const after = await assertBooksBalance(shop.businessId);
    expect(after.debits).toBe(after.credits);
    expect(after.inventoryLedger).toBe(after.stockValue);
  });

  it("never misses a sale posted while the day is being closed", async () => {
    const shop = await dayOne();
    for (let round = 0; round < 3; round++) {
      const [sale, close] = await Promise.all([
        sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 19_900 }] }),
        shop.c.post(`${shop.base}/day-closes`).send({ branchId: shop.branchId, countedCash: 0 }),
      ]);
      expect(close.status).toBe(201);
      const counted = close.body.dayClose.summary.sales.count;
      if (sale.status === 201) expect(counted).toBeGreaterThan(0);
      else expect(sale.body.error.code).toBe("DAY_CLOSED");
      // The drawer balance through today always equals the close's view of it
      expect(await cashThrough(shop, TODAY)).toBe(0);
      await shop.c.post(`${shop.base}/day-closes/${close.body.dayClose.id}/reopen`).send({ reason: "Again" }).expect(200);
    }
  });

  it("lets cashiers count blind and close, but not reopen", async () => {
    const shop = await dayOne();
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    const preview = await cashier.c.get(`${shop.base}/day-closes/preview?branchId=${shop.branchId}&date=${YESTERDAY}`).expect(200);
    expect(preview.body.expectedCash).toBeUndefined();
    expect(preview.body.summary.sales.total).toBe(39_800);
    const close = await cashier.c.post(`${shop.base}/day-closes`).send({ branchId: shop.branchId, businessDate: YESTERDAY, countedCash: 35_000 }).expect(201);
    expect(close.body.dayClose.difference).toBe(200);
    await cashier.c.post(`${shop.base}/day-closes/${close.body.dayClose.id}/reopen`).send({ reason: "Oops" }).expect(403);

    const outsider = await shop.c.post(`${shop.base}/branches`).send({ name: "Other" }).expect(201);
    const manager = await addMember(shop.c, shop.businessId, "BRANCH_MANAGER", [outsider.body.branch.id]);
    await manager.c.get(`${shop.base}/day-closes/preview?branchId=${shop.branchId}`).expect(404);
    await manager.c.get(`${shop.base}/day-closes/${close.body.dayClose.id}`).expect(404);
  });
});

describe("cashier's own day", () => {
  it("shows only the cashier's own sales today, without costs", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 19_900 }] }).expect(201);
    await cashier.c
      .post(`${shop.base}/sales`)
      .send({ branchId: shop.branchId, lines: [{ variantId: shop.coverId, quantity: 2, unitPrice: 19_900 }], tenders: [{ method: "UPI", amount: 39_800 }] })
      .expect(201);
    const res = await cashier.c.get(`${shop.base}/reports/my-day`).expect(200);
    expect(res.body).toMatchObject({ invoices: 1, billed: 39_800, byMethod: [{ method: "UPI", amount: 39_800 }], onCredit: 0 });
  });
});
