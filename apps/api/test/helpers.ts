import supertest from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "LedgerEntry", "StockMovement", "PaymentAllocation", "Tender", "LineSerial", "DocumentLine", "Document", "DocumentCounter", "StockBalance", "SerialUnit", "Party", "Variant", "Product", "Brand", "Category", "AuditLog", "Invitation", "MembershipBranch", "Membership", "Branch", "Subscription", "Business", "Session", "User" CASCADE`,
  );
}

/** A cookie-keeping client that behaves like the web app. */
export function client() {
  const agent = supertest.agent(app);
  agent.set("X-StockPilot-Client", "web");
  return agent;
}

export type Client = ReturnType<typeof client>;

let counter = 0;

export async function signUp(label = "shop") {
  counter += 1;
  const c = client();
  const email = `${label}-${counter}@example.com`;
  const res = await c
    .post("/api/auth/register")
    .send({ name: `${label} owner`, email, password: "correct-horse-battery", businessName: `${label} mobiles` })
    .expect(201);
  const businessId: string = res.body.businessId;
  const branches = await c.get(`/api/businesses/${businessId}/branches`).expect(200);
  return { c, email, businessId, branchId: branches.body.branches[0].id as string, token: res.body.token as string };
}

/** Invites a new person with `role` and returns a signed-in client for them. */
export async function addMember(
  owner: Client,
  businessId: string,
  role: string,
  branchIds: string[] = [],
) {
  counter += 1;
  const email = `${role.toLowerCase()}-${counter}@example.com`;
  const inv = await owner
    .post(`/api/businesses/${businessId}/invitations`)
    .send({ email, role, branchIds })
    .expect(201);
  const c = client();
  const res = await c
    .post("/api/invitations/accept")
    .send({ token: inv.body.token, name: `${role} person`, password: "correct-horse-battery" })
    .expect(201);
  const me = await c.get("/api/auth/me").expect(200);
  const members = await owner.get(`/api/businesses/${businessId}/members`).expect(200);
  const membershipId: string = members.body.members.find((m: { user: { email: string } }) => m.user.email === email).id;
  return { c, email, userId: res.body.user.id as string, membershipId, me: me.body };
}

export { prisma };

/** A valid 15-digit IMEI (correct Luhn check digit) built from a 14-digit body. */
export function imei(n: number): string {
  const body = String(35_000_000_000_000 + n).padStart(14, "0");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

/** A shop with a phone (IMEI tracked), an accessory, a supplier and a customer. */
export async function stockedShop(label = "shop") {
  const shop = await signUp(label);
  const base = `/api/businesses/${shop.businessId}`;
  const phone = await shop.c
    .post(`${base}/catalog/products`)
    .send({ name: "Galaxy A15", isSerialized: true, hsnCode: "8517", gstRateBps: 1800, variants: [{ name: "6/128 Black", salePrice: 1_599_900 }] })
    .expect(201);
  const cover = await shop.c
    .post(`${base}/catalog/products`)
    .send({ name: "Back cover", gstRateBps: 1800, variants: [{ name: "A15 clear", salePrice: 19_900 }] })
    .expect(201);
  const supplier = await shop.c.post(`${base}/parties`).send({ kind: "SUPPLIER", name: "Metro Distributors" }).expect(201);
  const customer = await shop.c.post(`${base}/parties`).send({ kind: "CUSTOMER", name: "Ravi Kumar", phone: "9876543210" }).expect(201);
  return {
    ...shop,
    base,
    phoneId: phone.body.product.variants[0].id as string,
    coverId: cover.body.product.variants[0].id as string,
    supplierId: supplier.body.party.id as string,
    customerId: customer.body.party.id as string,
  };
}

export type Shop = Awaited<ReturnType<typeof stockedShop>>;

/** Sum of every ledger entry must be zero, and the inventory account must equal the stock balances. */
export async function assertBooksBalance(businessId: string) {
  const all = await prisma.ledgerEntry.aggregate({ where: { businessId }, _sum: { debit: true, credit: true } });
  const inventory = await prisma.ledgerEntry.aggregate({ where: { businessId, account: "INVENTORY" }, _sum: { debit: true, credit: true } });
  const stock = await prisma.stockBalance.aggregate({ where: { businessId }, _sum: { value: true } });
  const transit = await prisma.ledgerEntry.aggregate({ where: { businessId, account: "STOCK_IN_TRANSIT" }, _sum: { debit: true, credit: true } });
  const inTransitValue = await prisma.documentLine.aggregate({
    where: { businessId, document: { type: "TRANSFER", status: "IN_TRANSIT" } },
    _sum: { costTotal: true },
  });
  return {
    debits: all._sum.debit ?? 0,
    credits: all._sum.credit ?? 0,
    inventoryLedger: (inventory._sum.debit ?? 0) - (inventory._sum.credit ?? 0),
    stockValue: stock._sum.value ?? 0,
    transitLedger: (transit._sum.debit ?? 0) - (transit._sum.credit ?? 0),
    inTransitValue: inTransitValue._sum.costTotal ?? 0,
  };
}
