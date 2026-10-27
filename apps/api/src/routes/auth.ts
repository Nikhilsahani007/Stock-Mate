import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { computeAccess, loginSchema, registerSchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { clearSessionCookie, createSession } from "../auth/sessions.js";
import { prisma } from "../db.js";
import { param } from "../params.js";
import { env } from "../env.js";
import { HttpError, conflict, notFound } from "../errors.js";
import { requireUser } from "../middleware/auth.js";

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === "test" ? 1000 : 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in a few minutes." } },
});

authRouter.post("/register", authLimiter, async (req, res) => {
  const input = registerSchema.parse(req.body);
  const passwordHash = await hashPassword(input.password);

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict("An account with this email already exists. Sign in instead.");

  const { user, business } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash } });
    const business = await tx.business.create({
      data: {
        name: input.businessName,
        subscription: { create: {} },
        branches: { create: { name: input.branchName } },
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    await audit(tx, req, {
      businessId: business.id,
      actorUserId: user.id,
      action: "business.created",
      entityType: "Business",
      entityId: business.id,
    });
    return { user, business };
  });

  const { token } = await createSession(req, res, user.id);
  res.status(201).json({ user: publicUser(user), businessId: business.id, token });
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = await verifyPassword(user?.passwordHash, input.password);
  if (!user || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  const { token } = await createSession(req, res, user.id);
  res.json({ user: publicUser(user), token });
});

authRouter.post("/logout", async (req, res) => {
  if (req.session) {
    await prisma.session.update({ where: { id: req.session.id }, data: { revokedAt: new Date() } });
  }
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get("/me", requireUser, async (req, res) => {
  const user = req.user!;
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    include: { business: { include: { subscription: true } } },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();
  res.json({
    user: publicUser(user),
    businesses: memberships.map((m) => ({
      id: m.businessId,
      name: m.business.name,
      role: m.role,
      access: computeAccess(m.business.subscription?.trialStartedAt ?? m.business.createdAt, now, m.business.subscription?.paidThrough ?? null),
    })),
  });
});

authRouter.get("/sessions", requireUser, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
  });
  res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === req.session!.id })) });
});

authRouter.delete("/sessions/:sessionId", requireUser, async (req, res) => {
  const { count } = await prisma.session.updateMany({
    where: { id: param(req, "sessionId"), userId: req.user!.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw notFound("Session");
  res.status(204).end();
});

/** Signs out every other device. */
authRouter.post("/sessions/revoke-others", requireUser, async (req, res) => {
  const { count } = await prisma.session.updateMany({
    where: { userId: req.user!.id, revokedAt: null, id: { not: req.session!.id } },
    data: { revokedAt: new Date() },
  });
  res.json({ revoked: count });
});

export function publicUser(user: { id: string; email: string; name: string }) {
  return { id: user.id, email: user.email, name: user.name };
}
