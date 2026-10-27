import { expect, type Page } from "@playwright/test";

let counter = 0;

/** A valid 15-digit IMEI (Luhn check digit) built from a number. */
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

/** Signs up through the real form and returns the new business's id. */
export async function signUp(page: Page, shop = "Sharma Mobiles") {
  counter += 1;
  await page.goto("/register");
  await page.getByLabel("Shop name").fill(shop);
  await page.getByLabel("Your name").fill("Ramesh Sharma");
  await page.getByLabel("Email").fill(`owner-${Date.now()}-${counter}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  return page.url().split("/b/")[1]!;
}

/** Calls the API as the signed-in user (shares the page's cookies), for setting up data quickly. */
export async function call<T = Record<string, unknown>>(page: Page, method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    data,
    headers: { "X-StockPilot-Client": "web", "Idempotency-Key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A phone, an accessory, a supplier and a customer, with stock bought in. */
export async function stockedShop(page: Page) {
  const businessId = await signUp(page);
  const base = `/businesses/${businessId}`;
  const { branches } = await call<{ branches: { id: string }[] }>(page, "GET", `${base}/branches`);
  const branchId = branches[0]!.id;
  const phone = await call<{ product: { variants: { id: string }[] } }>(page, "POST", `${base}/catalog/products`, {
    name: "Redmi 13C",
    isSerialized: true,
    hsnCode: "8517",
    gstRateBps: 1800,
    variants: [{ name: "4/128 Black", salePrice: 999_900 }],
  });
  const cover = await call<{ product: { variants: { id: string }[] } }>(page, "POST", `${base}/catalog/products`, {
    name: "Back cover",
    gstRateBps: 1800,
    variants: [{ name: "13C clear", salePrice: 19_900 }],
  });
  const supplier = await call<{ party: { id: string } }>(page, "POST", `${base}/parties`, { kind: "SUPPLIER", name: "Metro Distributors" });
  const customer = await call<{ party: { id: string } }>(page, "POST", `${base}/parties`, { kind: "CUSTOMER", name: "Ravi Kumar", phone: "9876543210" });
  const phoneId = phone.product.variants[0]!.id;
  const coverId = cover.product.variants[0]!.id;
  await call(page, "POST", `${base}/purchases`, {
    branchId,
    partyId: supplier.party.id,
    lines: [
      { variantId: phoneId, quantity: 3, unitPrice: 800_000, gstRateBps: 0, serials: [{ imei: imei(1) }, { imei: imei(2) }, { imei: imei(3) }] },
      { variantId: coverId, quantity: 10, unitPrice: 5_000, gstRateBps: 0 },
    ],
  });
  return { businessId, base, branchId, phoneId, coverId, supplierId: supplier.party.id, customerId: customer.party.id };
}
