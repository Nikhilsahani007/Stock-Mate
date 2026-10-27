import { beforeEach, describe, expect, it } from "vitest";
import { addMember, client, prisma, resetDb, signUp } from "./helpers.js";

beforeEach(resetDb);

describe("roles and branch access", () => {
  it("enforces role permissions on the server", async () => {
    const owner = await signUp();
    const base = `/api/businesses/${owner.businessId}`;
    const cashier = await addMember(owner.c, owner.businessId, "CASHIER", [owner.branchId]);

    await cashier.c.get(base).expect(200);
    await cashier.c.post(`${base}/branches`).send({ name: "Second" }).expect(403);
    await cashier.c.patch(base).send({ name: "Renamed" }).expect(403);
    await cashier.c.get(`${base}/audit-logs`).expect(403);
    await cashier.c.get(`${base}/members`).expect(403);
    await cashier.c.post(`${base}/invitations`).send({ email: "z@example.com", role: "CASHIER", branchIds: [owner.branchId] }).expect(403);

    const accountant = await addMember(owner.c, owner.businessId, "ACCOUNTANT", [owner.branchId]);
    await accountant.c.get(`${base}/audit-logs`).expect(200);
  });

  it("limits branch-scoped roles to their branches", async () => {
    const owner = await signUp();
    const base = `/api/businesses/${owner.businessId}`;
    const second = await owner.c.post(`${base}/branches`).send({ name: "Station Road" }).expect(201);
    const manager = await addMember(owner.c, owner.businessId, "BRANCH_MANAGER", [second.body.branch.id]);

    const list = await manager.c.get(`${base}/branches`).expect(200);
    expect(list.body.branches.map((b: { id: string }) => b.id)).toEqual([second.body.branch.id]);
    await manager.c.get(`${base}/branches/${owner.branchId}`).expect(404);
    await manager.c.get(`${base}/branches/${second.body.branch.id}`).expect(200);

    const ownerList = await owner.c.get(`${base}/branches`).expect(200);
    expect(ownerList.body.branches).toHaveLength(2);
  });

  it("requires a branch for branch-scoped invites", async () => {
    const owner = await signUp();
    await owner.c.post(`/api/businesses/${owner.businessId}/invitations`).send({ email: "c@example.com", role: "CASHIER" }).expect(400);
  });

  it("stops admins from creating admins and anyone from touching the owner", async () => {
    const owner = await signUp();
    const base = `/api/businesses/${owner.businessId}`;
    const admin = await addMember(owner.c, owner.businessId, "ADMIN");

    await admin.c.post(`${base}/invitations`).send({ email: "a2@example.com", role: "ADMIN" }).expect(403);
    await admin.c.post(`${base}/invitations`).send({ email: "o2@example.com", role: "OWNER" }).expect(403);
    await owner.c.post(`${base}/invitations`).send({ email: "o3@example.com", role: "OWNER" }).expect(403);

    const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { businessId: owner.businessId, role: "OWNER" } });
    await admin.c.delete(`${base}/members/${ownerMembership.id}`).expect(403);
    await admin.c.patch(`${base}/members/${ownerMembership.id}`).send({ role: "CASHIER", branchIds: [owner.branchId] }).expect(403);
    await owner.c.delete(`${base}/members/${ownerMembership.id}`).expect(403);

    const cashier = await addMember(owner.c, owner.businessId, "CASHIER", [owner.branchId]);
    await admin.c.patch(`${base}/members/${cashier.membershipId}`).send({ role: "INVENTORY_STAFF" }).expect(204);
    await admin.c.delete(`${base}/members/${cashier.membershipId}`).expect(204);
    await cashier.c.get(base).expect(404);
  });

  it("accepts an invitation once, for the invited email only", async () => {
    const owner = await signUp();
    const inv = await owner.c
      .post(`/api/businesses/${owner.businessId}/invitations`)
      .send({ email: "staff@example.com", role: "CASHIER", branchIds: [owner.branchId] })
      .expect(201);

    const stranger = await signUp("stranger");
    await stranger.c.post("/api/invitations/accept").send({ token: inv.body.token }).expect(403);

    await client()
      .post("/api/invitations/accept")
      .send({ token: inv.body.token, name: "Staff", password: "correct-horse-battery" })
      .expect(201);
    await client()
      .post("/api/invitations/accept")
      .send({ token: inv.body.token, name: "Staff", password: "correct-horse-battery" })
      .expect(404);
  });

  it("refuses revoked invitations", async () => {
    const owner = await signUp();
    const base = `/api/businesses/${owner.businessId}`;
    const inv = await owner.c.post(`${base}/invitations`).send({ email: "r@example.com", role: "ADMIN" }).expect(201);
    await owner.c.delete(`${base}/invitations/${inv.body.invitation.id}`).expect(204);
    await client()
      .post("/api/invitations/accept")
      .send({ token: inv.body.token, name: "R", password: "correct-horse-battery" })
      .expect(404);
  });

  it("records GST settings per branch", async () => {
    const owner = await signUp();
    const base = `/api/businesses/${owner.businessId}`;
    await owner.c.patch(`${base}/branches/${owner.branchId}`).send({ gstEnabled: true }).expect(400);
    const res = await owner.c
      .patch(`${base}/branches/${owner.branchId}`)
      .send({ gstEnabled: true, gstin: "27aapfu0939f1zv" })
      .expect(200);
    expect(res.body.branch).toMatchObject({ gstEnabled: true, gstin: "27AAPFU0939F1ZV" });
    await owner.c.post(`${base}/branches`).send({ name: "Non GST shop" }).expect(201);
    await owner.c.post(`${base}/branches`).send({ name: "Non GST shop" }).expect(409);
  });
});
