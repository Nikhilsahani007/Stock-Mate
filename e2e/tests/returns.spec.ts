import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { call, imei, stockedShop } from "./helpers.js";

const shots = process.env.E2E_SCREENSHOTS;

test("EMI sale, receipt, PDF, customer return and return to supplier", async ({ page }) => {
  const shop = await stockedShop(page);
  await call(page, "POST", `${shop.base}/parties`, { kind: "FINANCIER", name: "Bajaj Finserv" });

  // Sell a phone: ₹2,000 down in cash, the rest on EMI
  await page.goto(`/b/${shop.businessId}/sell`);
  await page.getByLabel("Scan IMEI").fill(imei(1));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(imei(1))).toBeVisible();
  await page.locator(".field", { hasText: "Customer" }).locator("select").selectOption({ label: "Ravi Kumar · 9876543210" });
  await page.getByLabel("Cash").fill("2000");
  await page.getByLabel("Paid partly or fully on EMI").check();
  await page.locator(".field", { hasText: "Finance company" }).locator("select").selectOption({ label: "Bajaj Finserv" });
  await page.getByLabel("Financed amount").fill("7999");
  await page.getByLabel("Loan number").fill("LAN-55");
  if (shots) await page.screenshot({ path: `${shots}/sale-emi.png`, fullPage: true });
  await page.getByRole("button", { name: "Save and print" }).click();

  await expect(page.getByRole("heading", { name: "Bill" })).toBeVisible();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("Paid by EMI / finance (Bajaj Finserv) · LAN-55")).toBeVisible();
  const invoiceUrl = page.url().split("?")[0]!;

  // The PDF opens from the same session
  const pdfHref = await page.getByRole("link", { name: "PDF", exact: true }).getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  if (shots) writeFileSync(`${shots}/invoice.pdf`, await pdf.body());

  // Till receipt
  await page.getByRole("link", { name: "Receipt (80 mm)" }).click();
  await expect(page.locator(".receipt")).toContainText(`IMEI ${imei(1)}`);
  await expect(page.locator(".receipt")).toContainText("Rupees Nine Thousand Nine Hundred Ninety Nine Only");
  if (shots) await page.screenshot({ path: `${shots}/receipt.png`, fullPage: true });

  // The customer brings it back
  await page.goto(invoiceUrl);
  await page.getByRole("link", { name: "Return items" }).click();
  await page.getByLabel(imei(1)).check();
  await page.getByLabel("Reason").fill("Screen flickers");
  // Bajaj cancels the loan; the customer gets their down payment back
  await page.getByLabel(/Bajaj Finserv \(up to/).fill("7999");
  await page.getByRole("button", { name: "Refund the rest in cash" }).click();
  await expect(page.getByLabel("Cash")).toHaveValue("2000");
  if (shots) await page.screenshot({ path: `${shots}/sale-return.png`, fullPage: true });
  await page.getByRole("button", { name: "Save credit note" }).click();
  await expect(page.getByRole("heading", { name: "Return receipt" })).toBeVisible();
  await expect(page.getByText("Refunded by Cash")).toBeVisible();
  await expect(page.getByText(/^Against INV\//)).toBeVisible();

  // Back on the shelf: 3 bought, 1 sold, 1 returned
  await page.goto(`/b/${shop.businessId}/stock`);
  await expect(page.locator("tr", { hasText: "Redmi 13C" }).locator("td").nth(1)).toHaveText("3");

  // Send another one back to the supplier
  await page.goto(`/b/${shop.businessId}/purchases/return`);
  await page.locator(".field", { hasText: "Supplier" }).first().locator("select").selectOption({ label: "Metro Distributors" });
  await page.getByLabel("Reason").fill("Dead on arrival");
  await page.getByLabel("Product").fill("Redmi 13C · 4/128 Black");
  await page.getByLabel("Unit price").fill("8000");
  await page.getByLabel(imei(2)).check();
  if (shots) await page.screenshot({ path: `${shots}/purchase-return.png`, fullPage: true });
  await page.getByRole("button", { name: "Save debit note" }).click();
  await expect(page.getByRole("heading", { name: "Debit note" })).toBeVisible();

  // Dues: the cancelled loan is no longer owed, and the debit note settled the supplier's bill
  await page.goto(`/b/${shop.businessId}/reports?tab=dues`);
  await expect(page.locator(".stat", { hasText: "You owe suppliers" })).toBeVisible();
  await expect(page.locator(".stat", { hasText: "EMI payouts due" })).toHaveCount(0);
  await expect(page.locator(".stat", { hasText: "Customers owe you" })).not.toContainText("advances");
  await expect(page.locator(".stat", { hasText: "You owe suppliers" })).toContainText("₹15,060.00");
  await expect(page.locator("tr", { hasText: "0–30 days" }).nth(1)).toContainText("₹15,060.00");
  if (shots) await page.screenshot({ path: `${shots}/dues.png`, fullPage: true });
});
