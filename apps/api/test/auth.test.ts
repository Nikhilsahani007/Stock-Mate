import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, client, prisma, resetDb, signUp } from "./helpers.js";

beforeEach(resetDb);

describe("auth", () => {
  it("registers a business with a trial, main branch, owner membership and audit trail", async () => {
    const { c, businessId } = await signUp();
    const me = await c.get("/api/auth/me").expect(200);
    expect(me.body.businesses).toHaveLength(1);
    expect(me.body.businesses[0]).toMatchObject({ id: businessId, role: "OWNER", access: { phase: "TRIAL", daysLeft: 14 } });

    const branches = await c.get(`/api/businesses/${businessId}/branches`).expect(200);
    expect(branches.body.branches.map((b: { name: string }) => b.name)).toEqual(["Main branch"]);

    const logs = await prisma.auditLog.findMany({ where: { businessId } });
    expect(logs.map((l) => l.action)).toContain("business.created");
  });

  it("stores only a hash of the password and session token", async () => {
    const { email, token } = await signUp();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.every((s) => s.tokenHash !== token)).toBe(true);
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const { email } = await signUp();
    await client()
      .post("/api/auth/register")
      .send({ name: "X", email: email.toUpperCase(), password: "correct-horse-battery", businessName: "Y" })
      .expect(409);
    const weak = await client()
      .post("/api/auth/register")
      .send({ name: "X", email: "new@example.com", password: "short", businessName: "Y" })
      .expect(400);
    expect(weak.body.error.code).toBe("VALIDATION");
  });

  it("logs in with the right password only", async () => {
    const { email } = await signUp();
    await client().post("/api/auth/login").send({ email, password: "wrong-password" }).expect(401);
    await client().post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever" }).expect(401);
    const c = client();
    await c.post("/api/auth/login").send({ email, password: "correct-horse-battery" }).expect(200);
    await c.get("/api/auth/me").expect(200);
  });

  it("revokes the session on logout", async () => {
    const { c } = await signUp();
    await c.post("/api/auth/logout").expect(204);
    await c.get("/api/auth/me").expect(401);
  });

  it("supports bearer tokens and revoking other devices", async () => {
    const { c, token } = await signUp();
    const desktop = supertest(app);
    await desktop.get("/api/auth/me").set("Authorization", `Bearer ${token}`).expect(200);

    const other = client();
    const login = await other
      .post("/api/auth/login")
      .send({ email: (await c.get("/api/auth/me")).body.user.email, password: "correct-horse-battery" })
      .expect(200);
    const res = await other.post("/api/auth/sessions/revoke-others").expect(200);
    expect(res.body.revoked).toBe(1);
    await desktop.get("/api/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
    await desktop.get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`).expect(200);
  });

  it("refuses cookie-authenticated writes without the client header (CSRF)", async () => {
    const { businessId } = await signUp();
    const raw = supertest.agent(app);
    const email = (await prisma.user.findFirstOrThrow()).email;
    await raw.post("/api/auth/login").send({ email, password: "correct-horse-battery" }).expect(200);
    await raw.post(`/api/businesses/${businessId}/branches`).send({ name: "Sneaky" }).expect(403);
    await raw.get(`/api/businesses/${businessId}/branches`).expect(200);
  });

  it("requires sign-in for business routes", async () => {
    const { businessId } = await signUp();
    await supertest(app).get(`/api/businesses/${businessId}`).expect(401);
  });
});
