import supertest from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

export const app = createApp();

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AuditLog", "Invitation", "MembershipBranch", "Membership", "Branch", "Subscription", "Business", "Session", "User" CASCADE`,
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
