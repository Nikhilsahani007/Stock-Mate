import type { Request, RequestHandler } from "express";
import { ALL_BRANCH_ROLES, computeAccess, roleHas, type Permission } from "@stockpilot/shared";
import { prisma } from "../db.js";
import { HttpError, forbidden, notFound, unauthorized } from "../errors.js";
import type { TenantContext } from "../types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolves :businessId against the signed-in user's own memberships. The
 * business ID from the URL is only a selector; access comes from the
 * membership row. Non-members get 404 so IDs of other tenants leak nothing.
 */
export const loadTenant: RequestHandler = async (req, _res, next) => {
  if (!req.user) throw unauthorized();
  const businessId = req.params.businessId;
  if (typeof businessId !== "string") throw notFound("Business");

  const membership = await prisma.membership.findUnique({
    where: { businessId_userId: { businessId, userId: req.user.id } },
    include: { branches: true, business: { include: { subscription: true } } },
  });
  if (!membership || membership.status !== "ACTIVE") throw notFound("Business");

  const sub = membership.business.subscription;
  const access = computeAccess(sub?.trialStartedAt ?? membership.business.createdAt, new Date(), sub?.paidThrough ?? null);
  if (access.access === "NONE") {
    throw new HttpError(403, "ACCOUNT_ARCHIVED", "This business account has been archived");
  }
  if (access.access === "READ_ONLY" && !SAFE_METHODS.has(req.method) && !isAllowedWhenReadOnly(req)) {
    throw new HttpError(402, "TRIAL_EXPIRED", "Your trial has ended. Data is read-only until you subscribe.");
  }

  req.tenant = {
    businessId,
    membershipId: membership.id,
    role: membership.role,
    branchIds: ALL_BRANCH_ROLES.includes(membership.role) ? null : membership.branches.map((b) => b.branchId),
    access,
  } satisfies TenantContext;
  next();
};

// Exports will live here once data export exists; nothing writes while read-only yet.
function isAllowedWhenReadOnly(_req: Request) {
  return false;
}

export function tenantOf(req: Request): TenantContext {
  if (!req.tenant) throw new Error("tenant middleware not applied");
  return req.tenant;
}

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!roleHas(tenantOf(req).role, permission)) throw forbidden();
    next();
  };

export function canAccessBranch(req: Request, branchId: string) {
  const { branchIds } = tenantOf(req);
  return branchIds === null || branchIds.includes(branchId);
}

/** Prisma where-fragment limiting branch queries to what the member may see. */
export function branchScope(req: Request) {
  const { businessId, branchIds } = tenantOf(req);
  return branchIds === null ? { businessId } : { businessId, id: { in: branchIds } };
}
