import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { env, isProd } from "../env.js";
import { hashToken, newToken } from "./tokens.js";

export const SESSION_COOKIE = "sp_session";
const DAY_MS = 86_400_000;
/** Refresh lastUsedAt / slide expiry at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function createSession(req: Request, res: Response, userId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + env.SESSION_DAYS * DAY_MS);
  const session = await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
      ip: req.ip ?? null,
    },
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
  // Returned so non-browser clients (the desktop app) can use a bearer token.
  return { session, token };
}

export function readToken(req: Request): { token: string; viaCookie: boolean } | null {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return { token: header.slice(7).trim(), viaCookie: false };
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return cookie ? { token: cookie, viaCookie: true } : null;
}

export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  const now = Date.now();
  if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return null;
  if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(now), expiresAt: new Date(now + env.SESSION_DAYS * DAY_MS) },
    });
  }
  return session;
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
