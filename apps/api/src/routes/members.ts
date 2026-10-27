import type { Request } from "express";
import { Router } from "express";
import { ALL_BRANCH_ROLES, canAssignRole, updateMembershipSchema, type Role } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { param } from "../params.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";

export const membersRouter = Router({ mergeParams: true });

membersRouter.get("/", requirePermission("member.read"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const members = await prisma.membership.findMany({
    where: { businessId },
    include: { user: { select: { id: true, name: true, email: true } }, branches: { select: { branchId: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    members: members.map((m) => ({
      id: m.id,
      user: m.user,
      role: m.role,
      status: m.status,
      branchIds: ALL_BRANCH_ROLES.includes(m.role) ? null : m.branches.map((b) => b.branchId),
      createdAt: m.createdAt,
    })),
  });
});

membersRouter.patch("/:membershipId", requirePermission("member.manage"), async (req, res) => {
  const target = await findManageableMember(req);
  const input = updateMembershipSchema.parse(req.body);
  const role = input.role ?? target.role;
  if (input.role && !canAssignRole(tenantOf(req).role, input.role)) throw forbidden("You can't assign that role");

  const branchIds = ALL_BRANCH_ROLES.includes(role)
    ? []
    : [...new Set(input.branchIds ?? target.branches.map((b) => b.branchId))];
  await assertBranchesInBusiness(tenantOf(req).businessId, branchIds);
  if (!ALL_BRANCH_ROLES.includes(role) && branchIds.length === 0) {
    throw badRequest("Choose at least one branch for this role");
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: target.id }, data: { role } });
    await tx.membershipBranch.deleteMany({ where: { membershipId: target.id } });
    await tx.membershipBranch.createMany({
      data: branchIds.map((branchId) => ({ membershipId: target.id, branchId, businessId: target.businessId })),
    });
    await audit(tx, req, {
      action: "member.updated",
      entityType: "Membership",
      entityId: target.id,
      metadata: { from: { role: target.role }, to: { role, branchIds } },
    });
  });
  res.status(204).end();
});

/** Removes a member's access. Their user account and history stay intact. */
membersRouter.delete("/:membershipId", requirePermission("member.manage"), async (req, res) => {
  const target = await findManageableMember(req);
  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: target.id }, data: { status: "DISABLED" } });
    await audit(tx, req, { action: "member.removed", entityType: "Membership", entityId: target.id });
  });
  res.status(204).end();
});

async function findManageableMember(req: Request) {
  const { businessId, membershipId, role } = tenantOf(req);
  const target = await prisma.membership.findFirst({
    where: { id: param(req, "membershipId"), businessId },
    include: { branches: true },
  });
  if (!target) throw notFound("Member");
  if (target.id === membershipId) throw forbidden("You can't change your own access");
  if (!outranks(role, target.role)) throw forbidden("You can't change this member's access");
  return target;
}

function outranks(actor: Role, target: Role) {
  if (target === "OWNER") return false;
  if (actor === "OWNER") return true;
  return actor === "ADMIN" && target !== "ADMIN";
}

export async function assertBranchesInBusiness(businessId: string, branchIds: string[]) {
  if (branchIds.length === 0) return;
  const unique = [...new Set(branchIds)];
  const count = await prisma.branch.count({ where: { businessId, id: { in: unique }, archivedAt: null } });
  if (count !== unique.length) throw badRequest("One or more branches don't exist");
}
