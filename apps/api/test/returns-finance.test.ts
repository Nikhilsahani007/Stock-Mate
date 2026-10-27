import { beforeEach, describe, expect, it } from "vitest";
import { addMember, assertBooksBalance, imei, prisma, resetDb, signUp, stockedShop, type Shop } from "./helpers.js";

beforeEach(resetDb);

function buy(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/purchases`).send({ branchId: shop.branchId, partyId: shop.supplierId, lines, ...extra });
}

function sell(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/sales`).send({ branchId: shop.branchId, lines, ...extra });
}

function giveBack(shop: Shop, saleId: string, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/sale-returns`).send({ saleId, reason: "Customer changed mind", lines, ...extra });
}

function sendBack(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/purchase-returns`).send({ branchId: shop.branchId, partyId: shop.supplierId, reason: "Faulty", lines, ...extra });
}

async function unit(n: number) {
  return prisma.serialUnit.findFirstOrThrow({ where: { imei: imei(n) } });
}

async function balance(shop: Shop, variantId: string) {
  return prisma.stockBalance.findUnique({ where: { branchId_variantId: { branchId: shop.branchId, variantId } } });
}

async function expectBalanced(shop: Shop) {
  const books = await assertBooksBalance(shop.businessId);
  expect(books.debits).toBe(books.credits);
  expect(books.inventoryLedger).toBe(books.stockValue);
}

describe("stock page cost tag", () => {
  it("follows the phones still in stock, not ones already sold", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    await shop.c.post(`${shop.base}/opening-stock`).send({ branchId: shop.branchId, lines: [{ variantId: shop.phoneId, quantity: 1, serials: [{ imei: imei(2) }] }] }).expect(201);
    const row = async () => (await shop.c.get(`${shop.base}/stock?branchId=${shop.branchId}`).expect(200)).body.rows.find((r: { variantId: string }) => r.variantId === shop.phoneId);
    expect((await row()).costConfidence).toBe("UNKNOWN");

    // Selling the phone with no cost leaves only the verified one on the shelf
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(2)] }], { tenders: [{ method: "CASH", amount: 1_200_000 }] }).expect(201);
    expect(await row()).toMatchObject({ quantity: 1, value: 1_000_000, costConfidence: "VERIFIED" });
  });
});

describe("sale returns (credit notes)", () => {
  it("puts a returned phone back on the shelf at its own cost and refunds the customer", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(1)] }], {
      partyId: shop.customerId,
      tenders: [{ method: "CASH", amount: 1_200_000 }],
    }).expect(201);
    const line = sale.body.document.lines[0];

    const res = await giveBack(shop, sale.body.document.id, [{ lineId: line.id, quantity: 1, serials: [imei(1)] }], {
      refunds: [{ method: "CASH", amount: 1_200_000 }],
    }).expect(201);
    const note = res.body.document;
    expect(note.number).toMatch(/^CRN\//);
    expect(note).toMatchObject({ type: "SALE_RETURN", total: 1_200_000, paidAmount: 1_200_000, sourceDocument: { id: sale.body.document.id } });
    expect(note.lines[0]).toMatchObject({ costTotal: 1_000_000, costConfidence: "VERIFIED", sourceLineId: line.id, damaged: false });
    expect(await unit(1)).toMatchObject({ status: "IN_STOCK", unitCost: 1_000_000 });
    expect(await balance(shop, shop.phoneId)).toMatchObject({ quantity: 1, value: 1_000_000 });
    await expectBalanced(shop);

    // Returned once; it can't come back again on the same invoice
    await giveBack(shop, sale.body.document.id, [{ lineId: line.id, quantity: 1, serials: [imei(1)] }]).expect(400);

    // Reports: the sale and the return net to nothing
    const profit = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(profit.body.verified).toMatchObject({ lines: 1, units: 0, revenue: 0, cost: 0, profit: 0 });
    const sales = await shop.c.get(`${shop.base}/reports/sales`).expect(200);
    expect(sales.body.returns).toMatchObject({ creditNotes: 1, units: 1, netSales: 1_200_000, refunded: 1_200_000 });
    expect(sales.body.netSalesAfterReturns).toBe(0);
    const col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.totals).toMatchObject({ atCounter: 1_200_000, refunded: 1_200_000 });

    // The phone is back in stock and can be sold again
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_150_000, serials: [imei(1)] }], { tenders: [{ method: "UPI", amount: 1_150_000 }] }).expect(201);
  });

  it("splits partial returns of a line so they add up exactly, and refuses to return more than was sold", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 3, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    // 3 covers for ₹500 less ₹1 discount: 49,900 over 3 units doesn't divide evenly
    const sale = await sell(shop, [{ variantId: shop.coverId, quantity: 3, unitPrice: 16_667, discount: 101 }], { partyId: shop.customerId }).expect(201);
    const line = sale.body.document.lines[0];
    expect(line.taxableValue).toBe(49_900);

    const first = await giveBack(shop, sale.body.document.id, [{ lineId: line.id, quantity: 1 }]).expect(201);
    const second = await giveBack(shop, sale.body.document.id, [{ lineId: line.id, quantity: 2 }]).expect(201);
    expect(first.body.document.lines[0].taxableValue + second.body.document.lines[0].taxableValue).toBe(49_900);
    expect(first.body.document.lines[0].costTotal + second.body.document.lines[0].costTotal).toBe(30_000);
    const over = await giveBack(shop, sale.body.document.id, [{ lineId: line.id, quantity: 1 }]).expect(400);
    expect(over.body.error.message).toMatch(/only 0 of 3/);

    // The credit went against the unpaid invoice, so nothing is due any more
    const invoice = await prisma.document.findUniqueOrThrow({ where: { id: sale.body.document.id } });
    expect(invoice.paidAmount).toBe(invoice.total);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 3, value: 30_000 });
    const party = await shop.c.get(`${shop.base}/parties/${shop.customerId}`).expect(200);
    expect(party.body.receivable).toBe(0);
    await expectBalanced(shop);
  });

  it("credits a paid invoice's return to the customer's account, and makes walk-ins be refunded in full", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    const paid = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 20_000 }], { partyId: shop.customerId, tenders: [{ method: "CASH", amount: 20_000 }] }).expect(201);
    await giveBack(shop, paid.body.document.id, [{ lineId: paid.body.document.lines[0].id, quantity: 1 }]).expect(201);
    const party = await shop.c.get(`${shop.base}/parties/${shop.customerId}`).expect(200);
    expect(party.body.receivable).toBe(-20_000); // held for them as an advance

    const walkIn = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 20_000 }], { tenders: [{ method: "CASH", amount: 20_000 }] }).expect(201);
    const lineId = walkIn.body.document.lines[0].id;
    const res = await giveBack(shop, walkIn.body.document.id, [{ lineId, quantity: 1 }]).expect(400);
    expect(res.body.error.message).toMatch(/refunded in full/);
    await giveBack(shop, walkIn.body.document.id, [{ lineId, quantity: 1 }], { refunds: [{ method: "CASH", amount: 30_000 }] }).expect(400);
    await giveBack(shop, walkIn.body.document.id, [{ lineId, quantity: 1 }], { refunds: [{ method: "CASH", amount: 20_000 }] }).expect(201);
    await expectBalanced(shop);
  });

  it("writes damaged returns off, and recovers the loss when the phone goes back to the supplier", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(1)] }], { tenders: [{ method: "CASH", amount: 1_200_000 }] }).expect(201);
    await giveBack(shop, sale.body.document.id, [{ lineId: sale.body.document.lines[0].id, quantity: 1, serials: [imei(1)], damaged: true }], {
      refunds: [{ method: "CASH", amount: 1_200_000 }],
    }).expect(201);
    expect((await unit(1)).status).toBe("RETURNED_DAMAGED");
    expect(await balance(shop, shop.phoneId)).toMatchObject({ quantity: 0, value: 0 });
    let profit = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(profit.body.otherCosts.stockLoss).toBe(1_000_000);
    await expectBalanced(shop);

    // It can't be sold while damaged
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [imei(1)] }], { tenders: [{ method: "CASH", amount: 100 }] }).expect(409);

    // The supplier takes it back for full credit: the loss is recovered
    const back = await sendBack(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [imei(1)] }]).expect(201);
    expect(back.body.document.number).toMatch(/^DBN\//);
    expect((await unit(1)).status).toBe("RETURNED_TO_SUPPLIER");
    profit = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(profit.body.otherCosts).toMatchObject({ stockLoss: 0, priceVariance: 0 });
    await expectBalanced(shop);

    // Cancelling the debit note puts the phone back to damaged; then the credit note can be cancelled too
    await shop.c.post(`${shop.base}/documents/${back.body.document.id}/cancel`).send({ reason: "Supplier refused" }).expect(200);
    expect((await unit(1)).status).toBe("RETURNED_DAMAGED");
    await expectBalanced(shop);
  });

  it("blocks cancelling an invoice with returns until the return is cancelled", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_200_000, serials: [imei(1)] }], { partyId: shop.customerId }).expect(201);
    const ret = await giveBack(shop, sale.body.document.id, [{ lineId: sale.body.document.lines[0].id, quantity: 1, serials: [imei(1)] }]).expect(201);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: sale.body.document.id } })).paidAmount).toBe(1_200_000);

    const blocked = await shop.c.post(`${shop.base}/documents/${sale.body.document.id}/cancel`).send({ reason: "Mistake" }).expect(409);
    expect(blocked.body.error.code).toBe("HAS_RETURNS");

    await shop.c.post(`${shop.base}/documents/${ret.body.document.id}/cancel`).send({ reason: "Entered by mistake" }).expect(200);
    expect((await unit(1)).status).toBe("SOLD");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: sale.body.document.id } })).paidAmount).toBe(0);
    await shop.c.post(`${shop.base}/documents/${sale.body.document.id}/cancel`).send({ reason: "Mistake" }).expect(200);
    expect((await unit(1)).status).toBe("IN_STOCK");
    await expectBalanced(shop);
  });

  it("reverses GST output on a GST branch's credit note and reports it", async () => {
    const shop = await stockedShop();
    await shop.c.patch(`${shop.base}/branches/${shop.branchId}`).send({ gstEnabled: true, gstin: "27AAPFU0939F1ZV" }).expect(200);
    await buy(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 10_000 }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 23_600 }], { tenders: [{ method: "CASH", amount: 47_200 }] }).expect(201);
    const note = await giveBack(shop, sale.body.document.id, [{ lineId: sale.body.document.lines[0].id, quantity: 1 }], { refunds: [{ method: "CASH", amount: 23_600 }] }).expect(201);
    expect(note.body.document).toMatchObject({ gstApplied: true, taxableTotal: 20_000, taxTotal: 3_600, total: 23_600 });
    const gst = await shop.c.get(`${shop.base}/reports/gst`).expect(200);
    const branch = gst.body.branches[0];
    expect(branch.outward).toEqual([{ rate: 1800, taxable: 20_000, cgst: 1_800, sgst: 1_800, igst: 0, tax: 3_600 }]);
    expect(branch.creditNotes).toEqual({ count: 1, taxable: 20_000, tax: 3_600 });
    await expectBalanced(shop);
  });

  it("is for owners, admins and branch managers only", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 10_000 }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 20_000 }], { tenders: [{ method: "CASH", amount: 20_000 }] }).expect(201);
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    await cashier.c
      .post(`${shop.base}/sale-returns`)
      .send({ saleId: sale.body.document.id, reason: "Changed mind", lines: [{ lineId: sale.body.document.lines[0].id, quantity: 1 }], refunds: [{ method: "CASH", amount: 20_000 }] })
      .expect(403);
    const manager = await addMember(shop.c, shop.businessId, "BRANCH_MANAGER", [shop.branchId]);
    await manager.c
      .post(`${shop.base}/sale-returns`)
      .send({ saleId: sale.body.document.id, reason: "Changed mind", lines: [{ lineId: sale.body.document.lines[0].id, quantity: 1 }], refunds: [{ method: "CASH", amount: 20_000 }] })
      .expect(201);

    // Another business can't return against this invoice
    const other = await stockedShop("other");
    await other.c
      .post(`${other.base}/sale-returns`)
      .send({ saleId: sale.body.document.id, reason: "Changed mind", lines: [{ lineId: sale.body.document.lines[0].id, quantity: 1 }] })
      .expect(404);
  });
});

describe("purchase returns (debit notes)", () => {
  it("reverses GST input, books the shortfall as price variance and reduces the bill's balance", async () => {
    const shop = await stockedShop();
    await shop.c.patch(`${shop.base}/branches/${shop.branchId}`).send({ gstEnabled: true, gstin: "27AAPFU0939F1ZV" }).expect(200);
    const bill = await buy(shop, [{ variantId: shop.phoneId, quantity: 2, unitPrice: 1_000_000, serials: [{ imei: imei(1) }, { imei: imei(2) }] }]).expect(201);
    expect(bill.body.document.total).toBe(2_360_000);

    // The supplier credits ₹9,500 + GST for a phone that cost ₹10,000
    const res = await sendBack(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 950_000, serials: [imei(2)] }], {
      purchaseId: bill.body.document.id,
      supplierRef: "CN-77",
    }).expect(201);
    const note = res.body.document;
    expect(note).toMatchObject({ taxableTotal: 950_000, taxTotal: 171_000, total: 1_121_000, paidAmount: 1_121_000, notes: "Supplier credit note CN-77" });
    expect(note.lines[0].costTotal).toBe(1_000_000);
    expect((await unit(2)).status).toBe("RETURNED_TO_SUPPLIER");
    expect(await balance(shop, shop.phoneId)).toMatchObject({ quantity: 1, value: 1_000_000 });

    const purchase = await prisma.document.findUniqueOrThrow({ where: { id: bill.body.document.id } });
    expect(purchase.paidAmount).toBe(1_121_000);
    const gstInput = await prisma.ledgerEntry.aggregate({ where: { businessId: shop.businessId, account: "GST_INPUT" }, _sum: { debit: true, credit: true } });
    expect((gstInput._sum.debit ?? 0) - (gstInput._sum.credit ?? 0)).toBe(360_000 - 171_000);
    const profit = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(profit.body.otherCosts.priceVariance).toBe(50_000);
    const gst = await shop.c.get(`${shop.base}/reports/gst`).expect(200);
    expect(gst.body.branches[0].inputTax).toBe(360_000 - 171_000);
    await expectBalanced(shop);

    // Cancel puts the phone back in stock
    await shop.c.post(`${shop.base}/documents/${note.id}/cancel`).send({ reason: "Supplier refused" }).expect(200);
    expect((await unit(2)).status).toBe("IN_STOCK");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: bill.body.document.id } })).paidAmount).toBe(0);
    await expectBalanced(shop);
  });

  it("settles the supplier's oldest bills with a debit note not linked to a bill, so ageing matches what is owed", async () => {
    const shop = await stockedShop();
    const first = await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    const second = await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    const note = await sendBack(shop, [{ variantId: shop.coverId, quantity: 15, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    expect(note.body.document.paidAmount).toBe(150_000);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: first.body.document.id } })).paidAmount).toBe(100_000);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: second.body.document.id } })).paidAmount).toBe(50_000);

    const dues = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    const aged = dues.body.suppliers.aging.reduce((a: number, b: { amount: number }) => a + b.amount, 0);
    expect(dues.body.suppliers.totalDue).toBe(50_000);
    expect(aged).toBe(50_000);

    await shop.c.post(`${shop.base}/documents/${note.body.document.id}/cancel`).send({ reason: "Supplier refused" }).expect(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: second.body.document.id } })).paidAmount).toBe(0);
    await expectBalanced(shop);
  });

  it("takes accessories out at average cost with a cash refund, and never below zero", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 4, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    await sendBack(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 10_000, gstRateBps: 0 }]).expect(409);
    await sendBack(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 10_000, gstRateBps: 0 }], { refunds: [{ method: "CASH", amount: 20_000 }] }).expect(201);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 2, value: 20_000 });
    const col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.totals.supplierRefunds).toBe(20_000);

    // Inventory staff may send goods back; cashiers may not
    const staff = await addMember(shop.c, shop.businessId, "INVENTORY_STAFF", [shop.branchId]);
    await staff.c
      .post(`${shop.base}/purchase-returns`)
      .send({ branchId: shop.branchId, partyId: shop.supplierId, reason: "Faulty", lines: [{ variantId: shop.coverId, quantity: 1, unitPrice: 10_000, gstRateBps: 0 }] })
      .expect(201);
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    await cashier.c
      .post(`${shop.base}/purchase-returns`)
      .send({ branchId: shop.branchId, partyId: shop.supplierId, reason: "Faulty", lines: [{ variantId: shop.coverId, quantity: 1, unitPrice: 10_000, gstRateBps: 0 }] })
      .expect(403);
    await expectBalanced(shop);
  });
});

describe("EMI and finance sales", () => {
  async function financier(shop: Shop) {
    const res = await shop.c.post(`${shop.base}/parties`).send({ kind: "FINANCIER", name: "Bajaj Finserv" }).expect(201);
    return res.body.party.id as string;
  }

  it("moves what is owed to the financier, and books fees kept back from the payout as an expense", async () => {
    const shop = await stockedShop();
    const bajaj = await financier(shop);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);

    // EMI needs a named customer and a finance company
    const lines = [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }];
    await sell(shop, lines, { tenders: [{ method: "CASH", amount: 300_000 }, { method: "FINANCE", amount: 1_200_000, partyId: bajaj }] }).expect(400);
    await sell(shop, lines, { partyId: shop.customerId, tenders: [{ method: "FINANCE", amount: 1_500_000 }] }).expect(400);
    await sell(shop, lines, { partyId: shop.customerId, tenders: [{ method: "FINANCE", amount: 1_500_000, partyId: shop.supplierId }] }).expect(400);
    const sale = await sell(shop, lines, {
      partyId: shop.customerId,
      tenders: [
        { method: "CASH", amount: 300_000 },
        { method: "FINANCE", amount: 1_200_000, partyId: bajaj, reference: "LAN-1234" },
      ],
    }).expect(201);
    expect(sale.body.document.paidAmount).toBe(1_500_000);
    expect(sale.body.document.tenders.find((t: { method: string }) => t.method === "FINANCE")).toMatchObject({ party: { id: bajaj, name: "Bajaj Finserv" }, reference: "LAN-1234" });

    let dues = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    expect(dues.body.customers.totalDue).toBe(0);
    expect(dues.body.financiers).toMatchObject({ totalDue: 1_200_000, parties: [{ partyId: bajaj, balance: 1_200_000 }] });
    let col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.totals).toMatchObject({ atCounter: 300_000, financed: 1_200_000 });

    // Fees can only be kept back by a financier
    await shop.c.post(`${shop.base}/receipts`).send({ branchId: shop.branchId, partyId: shop.customerId, deduction: 100, tenders: [{ method: "CASH", amount: 100 }] }).expect(400);
    // Bajaj pays ₹11,800 and keeps ₹200 as processing fee
    const payout = await shop.c
      .post(`${shop.base}/receipts`)
      .send({ branchId: shop.branchId, partyId: bajaj, deduction: 20_000, tenders: [{ method: "BANK", amount: 1_180_000, reference: "NEFT 998" }] })
      .expect(201);
    expect(payout.body.document).toMatchObject({ total: 1_200_000, otherCharges: 20_000 });

    dues = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    expect(dues.body.financiers.totalDue).toBe(0);
    col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.totals.receipts).toBe(1_180_000);
    const profit = await shop.c.get(`${shop.base}/reports/profit`).expect(200);
    expect(profit.body.expenses.byCategory).toEqual([{ category: "FINANCE_CHARGES", total: 20_000 }]);
    expect(profit.body.verifiedAfterExpenses).toBe(500_000 - 20_000);
    await expectBalanced(shop);
  });

  it("cancels the finance company's share when an EMI phone comes back", async () => {
    const shop = await stockedShop();
    const bajaj = await financier(shop);
    const other = await shop.c.post(`${shop.base}/parties`).send({ kind: "FINANCIER", name: "HDFC" }).expect(201);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] }]).expect(201);
    const sale = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], {
      partyId: shop.customerId,
      tenders: [{ method: "CASH", amount: 300_000 }, { method: "FINANCE", amount: 1_200_000, partyId: bajaj }],
    }).expect(201);
    const lineId = sale.body.document.lines[0].id;
    const back = [{ lineId, quantity: 1, serials: [imei(1)] }];

    // Only the finance company on the bill, and only up to what it financed
    await giveBack(shop, sale.body.document.id, back, { refunds: [{ method: "FINANCE", amount: 1_200_000, partyId: other.body.party.id }] }).expect(400);
    await giveBack(shop, sale.body.document.id, back, { refunds: [{ method: "FINANCE", amount: 1_300_000, partyId: bajaj }] }).expect(400);
    const ret = await giveBack(shop, sale.body.document.id, back, {
      refunds: [{ method: "CASH", amount: 300_000 }, { method: "FINANCE", amount: 1_200_000, partyId: bajaj, reference: "LAN cancelled" }],
    }).expect(201);
    expect(ret.body.document.paidAmount).toBe(1_500_000);

    const dues = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    expect(dues.body.financiers.totalDue).toBe(0);
    expect(dues.body.customers.advances).toBe(0);
    const col = await shop.c.get(`${shop.base}/reports/collections`).expect(200);
    expect(col.body.totals).toMatchObject({ financed: 0, refunded: 300_000 });
    await expectBalanced(shop);

    // Cancelling the return puts the loan back
    await shop.c.post(`${shop.base}/documents/${ret.body.document.id}/cancel`).send({ reason: "Entered by mistake" }).expect(200);
    const after = await shop.c.get(`${shop.base}/reports/dues`).expect(200);
    expect(after.body.financiers.totalDue).toBe(1_200_000);
    await expectBalanced(shop);
  });

  it("refuses EMI as a way to pay suppliers or expenses", async () => {
    const shop = await stockedShop();
    const bajaj = await financier(shop);
    await buy(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 10_000 }], { tenders: [{ method: "FINANCE", amount: 100, partyId: bajaj }] }).expect(400);
    await shop.c.post(`${shop.base}/expenses`).send({ branchId: shop.branchId, category: "RENT", amount: 100, method: "FINANCE" }).expect(400);
  });
});

describe("invoice PDF", () => {
  it("renders a PDF for those who may see the document, and nobody else", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] }]).expect(201);
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);
    const sale = await cashier.c
      .post(`${shop.base}/sales`)
      .send({ branchId: shop.branchId, partyId: shop.customerId, lines: [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_599_900, serials: [imei(1)] }], tenders: [{ method: "UPI", amount: 1_599_900 }] })
      .expect(201);
    const url = `${shop.base}/documents/${sale.body.document.id}/pdf`;

    const res = await cashier.c.get(url).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.headers["content-disposition"]).toMatch(/INV-/);

    const stranger = await signUp("stranger");
    await stranger.c.get(url).expect(404);
  });
});
