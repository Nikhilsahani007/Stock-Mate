import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb, signUp } from "./helpers.js";

beforeEach(resetDb);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function shopStartedDaysAgo(days: number, paidThrough: Date | null = null) {
  const shop = await signUp();
  await prisma.subscription.update({
    where: { businessId: shop.businessId },
    data: { trialStartedAt: daysAgo(days), paidThrough },
  });
  return { ...shop, base: `/api/businesses/${shop.businessId}` };
}

describe("14-day trial", () => {
  it("allows writes during the trial and the 3-day grace period", async () => {
    const shop = await shopStartedDaysAgo(15);
    const res = await shop.c.get(shop.base).expect(200);
    expect(res.body.access).toMatchObject({ phase: "GRACE", access: "FULL" });
    await shop.c.post(`${shop.base}/branches`).send({ name: "Second" }).expect(201);
  });

  it("goes read-only after grace, enforced by the server", async () => {
    const shop = await shopStartedDaysAgo(18);
    const res = await shop.c.get(shop.base).expect(200);
    expect(res.body.access).toMatchObject({ phase: "EXPIRED", access: "READ_ONLY" });
    await shop.c.get(`${shop.base}/branches`).expect(200);
    const write = await shop.c.post(`${shop.base}/branches`).send({ name: "Second" }).expect(402);
    expect(write.body.error.code).toBe("TRIAL_EXPIRED");
    await shop.c.patch(shop.base).send({ name: "Renamed" }).expect(402);
  });

  it("archives accounts 90 days after the trial lapses", async () => {
    const shop = await shopStartedDaysAgo(120);
    const res = await shop.c.get(shop.base).expect(403);
    expect(res.body.error.code).toBe("ACCOUNT_ARCHIVED");
  });

  it("gives full access to paid businesses", async () => {
    const shop = await shopStartedDaysAgo(60, new Date(Date.now() + 10 * 86_400_000));
    await shop.c.post(`${shop.base}/branches`).send({ name: "Second" }).expect(201);
  });
});
