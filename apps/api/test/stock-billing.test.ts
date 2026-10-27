import { fiscalYearOf, todayIn } from "@stockpilot/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { addMember, assertBooksBalance, imei, prisma, resetDb, stockedShop, type Shop } from "./helpers.js";

beforeEach(resetDb);

const FY = fiscalYearOf(todayIn("Asia/Kolkata"));

function buy(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/purchases`).send({ branchId: shop.branchId, partyId: shop.supplierId, lines, ...extra });
}

function sell(shop: Shop, lines: unknown[], extra: Record<string, unknown> = {}) {
  return shop.c.post(`${shop.base}/sales`).send({ branchId: shop.branchId, lines, ...extra });
}

async function balance(shop: Shop, variantId: string, branchId = shop.branchId) {
  return prisma.stockBalance.findUnique({ where: { branchId_variantId: { branchId, variantId } } });
}

async function enableGst(shop: Shop) {
  await shop.c.patch(`${shop.base}/branches/${shop.branchId}`).send({ gstEnabled: true, gstin: "27AAPFU0939F1ZV" }).expect(200);
}

describe("purchases", () => {
  it("brings phones in by IMEI at their own cost, with GST in the cost for a non-GST shop", async () => {
    const shop = await stockedShop();
    const res = await buy(shop, [
      { variantId: shop.phoneId, quantity: 2, unitPrice: 1_200_000, serials: [{ imei: imei(1) }, { imei: imei(2), imei2: imei(3) }] },
      { variantId: shop.coverId, quantity: 10, unitPrice: 5_000 },
    ]).expect(201);

    const doc = res.body.document;
    expect(doc.number).toBe(`PUR/${FY}/0001`);
    // 24,000 + 500 taxable, 18% GST = 4,410; total 28,910
    expect(doc).toMatchObject({ taxableTotal: 2_450_000, taxTotal: 441_000, total: 2_891_000, gstApplied: false });
    expect(doc.lines[0].costTotal).toBe(2_832_000);

    const units = await prisma.serialUnit.findMany({ where: { businessId: shop.businessId }, orderBy: { imei: "asc" } });
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.status === "IN_STOCK" && u.unitCost === 1_416_000 && u.costConfidence === "VERIFIED")).toBe(true);
    expect(units[1]!.imei2).toBe(imei(3));
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 10, value: 59_000 });

    const books = await assertBooksBalance(shop.businessId);
    expect(books.debits).toBe(books.credits);
    expect(books.inventoryLedger).toBe(books.stockValue);
  });

  it("claims GST input and keeps it out of cost for a GST branch, and spreads freight by value", async () => {
    const shop = await stockedShop();
    await enableGst(shop);
    const res = await buy(
      shop,
      [
        { variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] },
        { variantId: shop.coverId, quantity: 10, unitPrice: 10_000 },
      ],
      { otherCharges: 22_000 },
    ).expect(201);
    expect(res.body.document.gstApplied).toBe(true);
    // Freight 220 split 10,000 : 1,000
    expect(res.body.document.lines.map((l: { costTotal: number }) => l.costTotal)).toEqual([1_020_000, 102_000]);
    const gstInput = await prisma.ledgerEntry.aggregate({ where: { businessId: shop.businessId, account: "GST_INPUT" }, _sum: { debit: true } });
    expect(gstInput._sum.debit).toBe(198_000);
  });

  it("refuses bad or duplicate IMEIs and wrong serial counts", async () => {
    const shop = await stockedShop();
    const bad = imei(1).slice(0, 14) + String((Number(imei(1)[14]) + 1) % 10);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [{ imei: bad }] }]).expect(400);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 2, unitPrice: 100, serials: [{ imei: imei(1) }] }]).expect(400);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 2, unitPrice: 100, serials: [{ imei: imei(1) }, { imei: imei(1) }] }]).expect(400);
    await buy(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 100, serials: [{ imei: imei(1) }] }]).expect(400);

    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [{ imei: imei(1) }] }]).expect(201);
    const again = await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [{ imei: imei(1) }] }]).expect(409);
    expect(again.body.error.message).toMatch(/already in stock/);
    // Its second IMEI clashing with an existing first IMEI is refused too
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [{ imei: imei(2), imei2: imei(1) }] }]).expect(409);
  });

  it("accepts a non-IMEI serial number with a warning", async () => {
    const shop = await stockedShop();
    const res = await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [{ imei: "r58n12abcde" }] }]).expect(201);
    expect(res.body.warnings).toEqual(["R58N12ABCDE is not a 15-digit IMEI; saved as a serial number"]);
  });
});

describe("sales and costing", () => {
  it("books the exact cost of the IMEI sold (specific identification)", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 2, unitPrice: 1_200_000, serials: [{ imei: imei(1) }, { imei: imei(2) }] }]).expect(201);
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_100_000, serials: [{ imei: imei(3) }] }]).expect(201);

    const res = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_599_900, serials: [imei(3)] }], {
      tenders: [{ method: "UPI", amount: 1_599_900 }],
    }).expect(201);
    const doc = res.body.document;
    expect(doc.number).toBe(`INV/${FY}/0001`);
    expect(doc.lines[0]).toMatchObject({ costTotal: 1_298_000, costConfidence: "VERIFIED", taxableValue: 1_599_900 });
    expect(doc.paidAmount).toBe(1_599_900);
    expect((await prisma.serialUnit.findFirst({ where: { imei: imei(3) } }))!.status).toBe("SOLD");
    expect(await balance(shop, shop.phoneId)).toMatchObject({ quantity: 2, value: 2_832_000 });

    // The same IMEI can't be sold twice, and unknown IMEIs can't be typed in
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [imei(3)] }], { partyId: shop.customerId }).expect(409);
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 100, serials: [imei(99)] }], { partyId: shop.customerId }).expect(409);
  });

  it("uses a moving weighted average for accessories", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 13_000, gstRateBps: 0 }]).expect(201);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 20, value: 230_000 });

    const res = await sell(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 99_500 }] }).expect(201);
    expect(res.body.document.lines[0].costTotal).toBe(57_500);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 15, value: 172_500 });

    // Selling the rest takes exactly what is left, so no rounding dust remains
    await sell(shop, [{ variantId: shop.coverId, quantity: 15, unitPrice: 0 }], { partyId: shop.customerId }).expect(201);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 0, value: 0 });
  });

  it("never lets stock go negative, and a refused sale leaves no trace", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 3, unitPrice: 5_000 }]).expect(201);
    const res = await sell(shop, [{ variantId: shop.coverId, quantity: 4, unitPrice: 19_900 }], { partyId: shop.customerId }).expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.details).toMatchObject({ available: 3, requested: 4 });
    expect(await prisma.document.count({ where: { type: "SALE" } })).toBe(0);
    // The number series did not advance
    const ok = await sell(shop, [{ variantId: shop.coverId, quantity: 3, unitPrice: 19_900 }], { partyId: shop.customerId }).expect(201);
    expect(ok.body.document.number).toBe(`INV/${FY}/0001`);
  });

  it("splits CGST and SGST within the state, IGST across states, and rounds the invoice", async () => {
    const shop = await stockedShop();
    await enableGst(shop);
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000 }]).expect(201);

    const local = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_949 }], { partyId: shop.customerId }).expect(201);
    expect(local.body.document).toMatchObject({ gstApplied: true, interState: false, taxableTotal: 16_906, taxTotal: 3_043, total: 19_900, roundOff: -49 });
    expect(local.body.document.lines[0]).toMatchObject({ cgst: 1_522, sgst: 1_521, igst: 0 });

    const outsider = await shop.c.post(`${shop.base}/parties`).send({ kind: "CUSTOMER", name: "Bengaluru dealer", gstin: "29AAPFU0939F1ZV" }).expect(201);
    expect(outsider.body.party.stateCode).toBe("29");
    const inter = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 11_800 }], { partyId: outsider.body.party.id }).expect(201);
    expect(inter.body.document.lines[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 1_800, taxableValue: 10_000 });

    const books = await assertBooksBalance(shop.businessId);
    expect(books.debits).toBe(books.credits);
  });

  it("needs a customer for anything left on credit", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 5_000 }]).expect(201);
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 10_000 }] }).expect(400);
    await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], { tenders: [{ method: "CASH", amount: 30_000 }] }).expect(400);
    const credit = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 19_900 }], {
      partyId: shop.customerId,
      tenders: [{ method: "CASH", amount: 10_000 }],
    }).expect(201);
    expect(credit.body.document).toMatchObject({ total: 19_900, paidAmount: 10_000 });
  });

  it("labels profit from opening stock as estimated, or unknown when no cost was given", async () => {
    const shop = await stockedShop();
    await shop.c
      .post(`${shop.base}/opening-stock`)
      .send({
        branchId: shop.branchId,
        lines: [
          { variantId: shop.phoneId, quantity: 1, unitCost: 1_000_000, serials: [{ imei: imei(1) }] },
          { variantId: shop.phoneId, quantity: 1, serials: [{ imei: imei(2) }] },
        ],
      })
      .expect(201);
    const a = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], { partyId: shop.customerId }).expect(201);
    expect(a.body.document.lines[0]).toMatchObject({ costTotal: 1_000_000, costConfidence: "ESTIMATED" });
    const b = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(2)] }], { partyId: shop.customerId }).expect(201);
    expect(b.body.document.lines[0]).toMatchObject({ costTotal: 0, costConfidence: "UNKNOWN" });
  });

  it("returns the original document when a request is retried with the same key", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 5_000 }]).expect(201);
    const send = () =>
      shop.c
        .post(`${shop.base}/sales`)
        .set("Idempotency-Key", "counter-1-sale-0001")
        .send({ branchId: shop.branchId, partyId: shop.customerId, lines: [{ variantId: shop.coverId, quantity: 2, unitPrice: 19_900 }] });
    const first = await send().expect(201);
    const second = await send().expect(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.document.id).toBe(first.body.document.id);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 3 });
  });
});

describe("concurrency", () => {
  it("sells one phone only once when two counters try at the same moment", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] }]).expect(201);
    const attempt = () => sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], { partyId: shop.customerId });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.document.count({ where: { type: "SALE" } })).toBe(1);
  });

  it("never oversells accessories under parallel sales", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 5, unitPrice: 5_000 }]).expect(201);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sell(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 19_900 }], { partyId: shop.customerId })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 1 });
    const numbers = (await prisma.document.findMany({ where: { type: "SALE" }, orderBy: { number: "asc" } })).map((d) => d.number);
    expect(numbers).toEqual([`INV/${FY}/0001`, `INV/${FY}/0002`]);
  });
});

describe("payments and expenses", () => {
  it("allocates a receipt to the oldest unpaid invoices and keeps the rest as an advance", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 5_000 }]).expect(201);
    const inv1 = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 20_000 }], { partyId: shop.customerId }).expect(201);
    const inv2 = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 30_000 }], { partyId: shop.customerId }).expect(201);

    await shop.c
      .post(`${shop.base}/receipts`)
      .send({ branchId: shop.branchId, partyId: shop.customerId, tenders: [{ method: "CASH", amount: 25_000 }] })
      .expect(201);
    const party = await shop.c.get(`${shop.base}/parties/${shop.customerId}`).expect(200);
    expect(party.body.receivable).toBe(25_000);
    expect(party.body.openDocuments).toEqual([expect.objectContaining({ id: inv2.body.document.id, paidAmount: 5_000 })]);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: inv1.body.document.id } })).paidAmount).toBe(20_000);

    await shop.c
      .post(`${shop.base}/receipts`)
      .send({ branchId: shop.branchId, partyId: shop.customerId, tenders: [{ method: "UPI", amount: 30_000 }] })
      .expect(201);
    const after = await shop.c.get(`${shop.base}/parties/${shop.customerId}`).expect(200);
    expect(after.body.receivable).toBe(-5_000);
    expect(after.body.openDocuments).toEqual([]);
  });

  it("records paid and unpaid expenses and settles bills with a supplier payment", async () => {
    const shop = await stockedShop();
    await shop.c.post(`${shop.base}/expenses`).send({ branchId: shop.branchId, category: "RENT", amount: 2_500_000, method: "BANK" }).expect(201);
    await shop.c.post(`${shop.base}/expenses`).send({ branchId: shop.branchId, category: "ELECTRICITY", amount: 300_000 }).expect(400);
    const bill = await shop.c
      .post(`${shop.base}/expenses`)
      .send({ branchId: shop.branchId, category: "TRANSPORT", amount: 300_000, partyId: shop.supplierId })
      .expect(201);
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);

    let party = await shop.c.get(`${shop.base}/parties/${shop.supplierId}`).expect(200);
    expect(party.body.payable).toBe(400_000);

    await shop.c
      .post(`${shop.base}/supplier-payments`)
      .send({ branchId: shop.branchId, partyId: shop.supplierId, tenders: [{ method: "BANK", amount: 300_000 }], allocations: [{ documentId: bill.body.document.id, amount: 300_000 }] })
      .expect(201);
    party = await shop.c.get(`${shop.base}/parties/${shop.supplierId}`).expect(200);
    expect(party.body.payable).toBe(100_000);
    expect(party.body.openDocuments).toHaveLength(1);
    expect(party.body.openDocuments[0].type).toBe("PURCHASE");
  });
});

describe("transfers and adjustments", () => {
  it("moves stock at cost through transit, and the receiving branch blends it into its average", async () => {
    const shop = await stockedShop();
    const b2 = await shop.c.post(`${shop.base}/branches`).send({ name: "Station Road" }).expect(201);
    const b2Id: string = b2.body.branch.id;
    await buy(shop, [
      { variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] },
      { variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 },
    ]).expect(201);
    await shop.c
      .post(`${shop.base}/purchases`)
      .send({ branchId: b2Id, partyId: shop.supplierId, lines: [{ variantId: shop.coverId, quantity: 2, unitPrice: 16_000, gstRateBps: 0 }] })
      .expect(201);

    const trf = await shop.c
      .post(`${shop.base}/transfers`)
      .send({
        branchId: shop.branchId,
        toBranchId: b2Id,
        lines: [
          { variantId: shop.phoneId, quantity: 1, serials: [imei(1)] },
          { variantId: shop.coverId, quantity: 4 },
        ],
      })
      .expect(201);
    expect(trf.body.document.status).toBe("IN_TRANSIT");
    expect((await prisma.serialUnit.findFirst({ where: { imei: imei(1) } }))!.status).toBe("IN_TRANSIT");
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 6, value: 60_000 });
    let books = await assertBooksBalance(shop.businessId);
    expect(books.transitLedger).toBe(1_040_000);
    expect(books.inventoryLedger).toBe(books.stockValue);

    // Can't sell it while in transit
    await shop.c
      .post(`${shop.base}/sales`)
      .send({ branchId: b2Id, partyId: shop.customerId, lines: [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1, serials: [imei(1)] }] })
      .expect(409);

    await shop.c.post(`${shop.base}/transfers/${trf.body.document.id}/receive`).expect(200);
    await shop.c.post(`${shop.base}/transfers/${trf.body.document.id}/receive`).expect(409);
    const unit = await prisma.serialUnit.findFirstOrThrow({ where: { imei: imei(1) } });
    expect(unit).toMatchObject({ status: "IN_STOCK", branchId: b2Id, unitCost: 1_000_000 });
    // 2 at 160 + 4 at 100 = 720 for 6
    expect(await balance(shop, shop.coverId, b2Id)).toMatchObject({ quantity: 6, value: 72_000 });
    books = await assertBooksBalance(shop.businessId);
    expect(books.transitLedger).toBe(0);
    expect(books.inventoryLedger).toBe(books.stockValue);
    expect(books.debits).toBe(books.credits);
  });

  it("only lets the receiving branch receive", async () => {
    const shop = await stockedShop();
    const b2 = await shop.c.post(`${shop.base}/branches`).send({ name: "Station Road" }).expect(201);
    await buy(shop, [{ variantId: shop.coverId, quantity: 2, unitPrice: 100 }]).expect(201);
    const trf = await shop.c
      .post(`${shop.base}/transfers`)
      .send({ branchId: shop.branchId, toBranchId: b2.body.branch.id, lines: [{ variantId: shop.coverId, quantity: 1 }] })
      .expect(201);
    const sender = await addMember(shop.c, shop.businessId, "INVENTORY_STAFF", [shop.branchId]);
    await sender.c.post(`${shop.base}/transfers/${trf.body.document.id}/receive`).expect(403);
  });

  it("writes off damaged stock with a reason and adds found stock at average cost", async () => {
    const shop = await stockedShop();
    await buy(shop, [
      { variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, gstRateBps: 0, serials: [{ imei: imei(1) }] },
      { variantId: shop.coverId, quantity: 4, unitPrice: 10_000, gstRateBps: 0 },
    ]).expect(201);
    const adj = (body: Record<string, unknown>) => shop.c.post(`${shop.base}/adjustments`).send({ branchId: shop.branchId, ...body });
    await adj({ lines: [{ variantId: shop.coverId, quantity: -1 }] }).expect(400);
    await adj({ reason: "Screen cracked in display", lines: [{ variantId: shop.phoneId, quantity: -1, serials: [imei(1)] }] }).expect(201);
    expect((await prisma.serialUnit.findFirstOrThrow({ where: { imei: imei(1) } })).status).toBe("WRITTEN_OFF");
    await adj({ reason: "Found in back room", lines: [{ variantId: shop.coverId, quantity: 2 }] }).expect(201);
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 6, value: 60_000 });
    await adj({ reason: "Found a phone", lines: [{ variantId: shop.phoneId, quantity: 1 }] }).expect(400);
    await adj({ reason: "Lost", lines: [{ variantId: shop.coverId, quantity: -7 }] }).expect(409);
    const loss = await prisma.ledgerEntry.aggregate({ where: { businessId: shop.businessId, account: "STOCK_LOSS" }, _sum: { debit: true, credit: true } });
    expect((loss._sum.debit ?? 0) - (loss._sum.credit ?? 0)).toBe(1_000_000 - 20_000);
  });
});

describe("cancelling", () => {
  it("reverses a sale exactly: the phone is back in stock and the books net to zero", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] }]).expect(201);
    const before = await assertBooksBalance(shop.businessId);
    const sale = await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], {
      tenders: [{ method: "CASH", amount: 1_500_000 }],
    }).expect(201);
    const id = sale.body.document.id;
    await shop.c.post(`${shop.base}/documents/${id}/cancel`).send({ reason: "Customer changed mind" }).expect(200);
    await shop.c.post(`${shop.base}/documents/${id}/cancel`).send({ reason: "Again" }).expect(409);

    expect((await prisma.serialUnit.findFirstOrThrow({ where: { imei: imei(1) } })).status).toBe("IN_STOCK");
    expect(await balance(shop, shop.phoneId)).toMatchObject({ quantity: 1, value: 1_180_000 });
    const net = await prisma.ledgerEntry.groupBy({ by: ["account"], where: { documentId: id }, _sum: { debit: true, credit: true } });
    for (const n of net) expect(n._sum.debit).toBe(n._sum.credit);
    const after = await assertBooksBalance(shop.businessId);
    expect(after.inventoryLedger).toBe(before.inventoryLedger);
    // The phone can be sold again
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], { partyId: shop.customerId }).expect(201);
  });

  it("refuses to cancel a purchase whose phone was already sold", async () => {
    const shop = await stockedShop();
    const p = await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] }]).expect(201);
    await sell(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }], { partyId: shop.customerId }).expect(201);
    const res = await shop.c.post(`${shop.base}/documents/${p.body.document.id}/cancel`).send({ reason: "Wrong bill" }).expect(409);
    expect(res.body.error.code).toBe("SERIAL_MOVED_ON");
  });

  it("takes cancelled accessory purchases out at average cost and books the difference as price variance", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 10_000, gstRateBps: 0 }]).expect(201);
    const second = await buy(shop, [{ variantId: shop.coverId, quantity: 10, unitPrice: 20_000, gstRateBps: 0 }]).expect(201);
    await shop.c.post(`${shop.base}/documents/${second.body.document.id}/cancel`).send({ reason: "Entered twice" }).expect(200);
    // Average was 150; removing 10 at 150 leaves 10 at 150, and 500 goes to price variance
    expect(await balance(shop, shop.coverId)).toMatchObject({ quantity: 10, value: 150_000 });
    const variance = await prisma.ledgerEntry.aggregate({ where: { businessId: shop.businessId, account: "PRICE_VARIANCE" }, _sum: { credit: true } });
    expect(variance._sum.credit).toBe(50_000);
    const books = await assertBooksBalance(shop.businessId);
    expect(books.inventoryLedger).toBe(books.stockValue);
    expect(books.debits).toBe(books.credits);
  });

  it("frees a cancelled receipt's money from the invoices it paid", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 100 }]).expect(201);
    const inv = await sell(shop, [{ variantId: shop.coverId, quantity: 1, unitPrice: 20_000 }], { partyId: shop.customerId }).expect(201);
    const rct = await shop.c
      .post(`${shop.base}/receipts`)
      .send({ branchId: shop.branchId, partyId: shop.customerId, tenders: [{ method: "CASH", amount: 20_000 }] })
      .expect(201);
    await shop.c.post(`${shop.base}/documents/${rct.body.document.id}/cancel`).send({ reason: "Cheque bounced" }).expect(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: inv.body.document.id } })).paidAmount).toBe(0);
    const party = await shop.c.get(`${shop.base}/parties/${shop.customerId}`).expect(200);
    expect(party.body.receivable).toBe(20_000);
  });
});

describe("roles", () => {
  it("lets a cashier sell without ever seeing costs, but not buy or cancel", async () => {
    const shop = await stockedShop();
    await buy(shop, [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_000_000, serials: [{ imei: imei(1) }] }]).expect(201);
    const cashier = await addMember(shop.c, shop.businessId, "CASHIER", [shop.branchId]);

    const stock = await cashier.c.get(`${shop.base}/stock?branchId=${shop.branchId}`).expect(200);
    expect(stock.body.rows[0].quantity).toBe(1);
    expect(stock.body.rows[0]).not.toHaveProperty("value");
    const serials = await cashier.c.get(`${shop.base}/stock/serials?status=IN_STOCK`).expect(200);
    expect(serials.body.units[0]).not.toHaveProperty("unitCost");

    const sale = await cashier.c
      .post(`${shop.base}/sales`)
      .send({ branchId: shop.branchId, partyId: shop.customerId, lines: [{ variantId: shop.phoneId, quantity: 1, unitPrice: 1_500_000, serials: [imei(1)] }] })
      .expect(201);
    expect(sale.body.document.lines[0]).not.toHaveProperty("costTotal");
    expect(sale.body.document.lines[0].serials[0]).not.toHaveProperty("unitCost");
    expect(sale.body.document.ledgerEntries).toBeUndefined();

    await cashier.c
      .post(`${shop.base}/purchases`)
      .send({ branchId: shop.branchId, partyId: shop.supplierId, lines: [{ variantId: shop.coverId, quantity: 1, unitPrice: 1 }] })
      .expect(403);
    await cashier.c.post(`${shop.base}/documents/${sale.body.document.id}/cancel`).send({ reason: "Oops" }).expect(403);
    const docs = await cashier.c.get(`${shop.base}/documents`).expect(200);
    expect(docs.body.documents.map((d: { type: string }) => d.type)).toEqual(["SALE"]);
  });

  it("keeps a branch-scoped member out of other branches' stock and documents", async () => {
    const shop = await stockedShop();
    const b2 = await shop.c.post(`${shop.base}/branches`).send({ name: "Station Road" }).expect(201);
    const b2Id: string = b2.body.branch.id;
    const p = await shop.c
      .post(`${shop.base}/purchases`)
      .send({ branchId: b2Id, partyId: shop.supplierId, lines: [{ variantId: shop.coverId, quantity: 1, unitPrice: 100 }] })
      .expect(201);
    const manager = await addMember(shop.c, shop.businessId, "BRANCH_MANAGER", [shop.branchId]);
    await manager.c.get(`${shop.base}/stock?branchId=${b2Id}`).expect(404);
    const all = await manager.c.get(`${shop.base}/stock`).expect(200);
    expect(all.body.rows).toEqual([]);
    await manager.c.get(`${shop.base}/documents/${p.body.document.id}`).expect(404);
    await manager.c
      .post(`${shop.base}/sales`)
      .send({ branchId: b2Id, partyId: shop.customerId, lines: [{ variantId: shop.coverId, quantity: 1, unitPrice: 100 }] })
      .expect(404);
  });
});

describe("tenant isolation for stock and billing", () => {
  it("refuses another business's products, parties, branches and documents", async () => {
    const a = await stockedShop("alpha");
    const b = await stockedShop("beta");
    await buy(b, [{ variantId: b.coverId, quantity: 5, unitPrice: 100 }]).expect(201);
    const bSale = await sell(b, [{ variantId: b.coverId, quantity: 1, unitPrice: 200 }], { partyId: b.customerId }).expect(201);

    // B's IDs under A's business URL
    await a.c.post(`${a.base}/purchases`).send({ branchId: a.branchId, partyId: a.supplierId, lines: [{ variantId: b.coverId, quantity: 1, unitPrice: 1 }] }).expect(404);
    await a.c.post(`${a.base}/purchases`).send({ branchId: a.branchId, partyId: b.supplierId, lines: [{ variantId: a.coverId, quantity: 1, unitPrice: 1 }] }).expect(404);
    await a.c.post(`${a.base}/purchases`).send({ branchId: b.branchId, partyId: a.supplierId, lines: [{ variantId: a.coverId, quantity: 1, unitPrice: 1 }] }).expect(404);
    await a.c.get(`${a.base}/documents/${bSale.body.document.id}`).expect(404);
    await a.c.post(`${a.base}/documents/${bSale.body.document.id}/cancel`).send({ reason: "Nope" }).expect(404);
    await a.c.get(`${a.base}/parties/${b.customerId}`).expect(404);
    await a.c.get(`${a.base}/catalog/products/${b.coverId}`).expect(404);
    await a.c.patch(`${a.base}/catalog/variants/${b.coverId}`).send({ name: "Mine" }).expect(404);
    await a.c.get(`${a.base}/stock?branchId=${b.branchId}`).expect(404);

    // B's business URL entirely
    for (const path of ["/stock", "/stock/serials", "/documents", "/parties", "/catalog/products"]) {
      expect((await a.c.get(`${b.base}${path}`)).status, path).toBe(404);
    }

    // A's lists contain only A's rows
    expect((await a.c.get(`${a.base}/documents`).expect(200)).body.documents).toEqual([]);
    const products = (await a.c.get(`${a.base}/catalog/products`).expect(200)).body.products;
    expect(products.every((p: { businessId: string }) => p.businessId === a.businessId)).toBe(true);
    expect(await prisma.stockBalance.findUnique({ where: { branchId_variantId: { branchId: b.branchId, variantId: b.coverId } } })).toMatchObject({ quantity: 4 });
  });

  it("enforces cross-tenant links in the database itself", async () => {
    const a = await stockedShop("alpha");
    const b = await stockedShop("beta");
    await expect(
      prisma.serialUnit.create({
        data: { businessId: a.businessId, branchId: a.branchId, variantId: b.phoneId, imei: imei(1), status: "IN_STOCK", unitCost: 0, costConfidence: "UNKNOWN" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.stockBalance.create({ data: { businessId: a.businessId, branchId: a.branchId, variantId: a.coverId, quantity: -1 } }),
    ).rejects.toThrow();
  });
});
