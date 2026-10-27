import { beforeEach, describe, expect, it } from "vitest";
import { addMember, prisma, resetDb, signUp } from "./helpers.js";

beforeEach(resetDb);

/**
 * Two unrelated shops. Everything shop A's owner tries against shop B must
 * fail without revealing whether B's records exist.
 */
async function twoShops() {
  const a = await signUp("alpha");
  const b = await signUp("beta");
  const bCashier = await addMember(b.c, b.businessId, "CASHIER", [b.branchId]);
  return { a, b, bCashier };
}

describe("tenant isolation", () => {
  it("hides another business entirely", async () => {
    const { a, b } = await twoShops();
    for (const path of ["", "/branches", `/branches/${b.branchId}`, "/members", "/invitations", "/audit-logs"]) {
      const res = await a.c.get(`/api/businesses/${b.businessId}${path}`);
      expect(res.status, path).toBe(404);
    }
    await a.c.patch(`/api/businesses/${b.businessId}`).send({ name: "Hijacked" }).expect(404);
    await a.c.post(`/api/businesses/${b.businessId}/branches`).send({ name: "Mine now" }).expect(404);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.businessId } })).name).toBe("beta mobiles");
  });

  it("does not trust IDs from another business under your own business URL", async () => {
    const { a, b, bCashier } = await twoShops();
    const base = `/api/businesses/${a.businessId}`;

    await a.c.get(`${base}/branches/${b.branchId}`).expect(404);
    await a.c.patch(`${base}/branches/${b.branchId}`).send({ name: "Stolen" }).expect(404);
    await a.c.patch(`${base}/members/${bCashier.membershipId}`).send({ role: "ACCOUNTANT" }).expect(404);
    await a.c.delete(`${base}/members/${bCashier.membershipId}`).expect(404);

    const bInvite = await b.c.post(`/api/businesses/${b.businessId}/invitations`).send({ email: "x@example.com", role: "ADMIN" }).expect(201);
    await a.c.delete(`${base}/invitations/${bInvite.body.invitation.id}`).expect(404);

    // Granting a member of A access to B's branch
    await a.c.post(`${base}/invitations`).send({ email: "y@example.com", role: "CASHIER", branchIds: [b.branchId] }).expect(400);

    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: b.branchId } });
    expect(branch.name).toBe("Main branch");
    const membership = await prisma.membership.findUniqueOrThrow({ where: { id: bCashier.membershipId } });
    expect(membership).toMatchObject({ role: "CASHIER", status: "ACTIVE" });
  });

  it("only lists the caller's own business data", async () => {
    const { a, b } = await twoShops();
    const members = await a.c.get(`/api/businesses/${a.businessId}/members`).expect(200);
    expect(members.body.members).toHaveLength(1);

    const logs = await a.c.get(`/api/businesses/${a.businessId}/audit-logs`).expect(200);
    expect(logs.body.entries.length).toBeGreaterThan(0);
    expect(logs.body.entries.every((e: { businessId: string }) => e.businessId === a.businessId)).toBe(true);

    const me = await a.c.get("/api/auth/me").expect(200);
    expect(me.body.businesses.map((x: { id: string }) => x.id)).toEqual([a.businessId]);
    expect(me.body.businesses).not.toContainEqual(expect.objectContaining({ id: b.businessId }));
  });

  it("lets a person belong to two businesses with separate roles", async () => {
    const { a, b } = await twoShops();
    const inv = await b.c.post(`/api/businesses/${b.businessId}/invitations`).send({ email: a.email, role: "ACCOUNTANT", branchIds: [b.branchId] }).expect(201);
    await a.c.post("/api/invitations/accept").send({ token: inv.body.token }).expect(201);

    const me = await a.c.get("/api/auth/me").expect(200);
    expect(me.body.businesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.businessId, role: "OWNER" }),
        expect.objectContaining({ id: b.businessId, role: "ACCOUNTANT" }),
      ]),
    );
    // Owner in A, but only an accountant in B
    await a.c.post(`/api/businesses/${b.businessId}/branches`).send({ name: "New" }).expect(403);
    await a.c.post(`/api/businesses/${a.businessId}/branches`).send({ name: "New" }).expect(201);
  });

  it("is enforced by the database for branch access links", async () => {
    const { a, b } = await twoShops();
    const aOwner = await prisma.membership.findFirstOrThrow({ where: { businessId: a.businessId } });
    await expect(
      prisma.membershipBranch.create({
        data: { membershipId: aOwner.id, branchId: b.branchId, businessId: a.businessId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.membershipBranch.create({
        data: { membershipId: aOwner.id, branchId: b.branchId, businessId: b.businessId },
      }),
    ).rejects.toThrow();
  });
});
