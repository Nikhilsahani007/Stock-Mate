import { Router } from "express";
import { ALL_BRANCH_ROLES, acceptInviteSchema, canAssignRole, inviteSchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { hashPassword } from "../auth/password.js";
import { createSession } from "../auth/sessions.js";
import { hashToken, newToken } from "../auth/tokens.js";
import { prisma } from "../db.js";
import { param } from "../params.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";
import { publicUser } from "./auth.js";
import { assertBranchesInBusiness } from "./members.js";

const INVITE_DAYS = 7;

/** Mounted under /businesses/:businessId/invitations. */
export const invitationsRouter = Router({ mergeParams: true });

invitationsRouter.get("/", requirePermission("member.invite"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const invitations = await prisma.invitation.findMany({
    where: { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, branchIds: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ invitations });
});

invitationsRouter.post("/", requirePermission("member.invite"), async (req, res) => {
  const { businessId, role: actorRole } = tenantOf(req);
  const input = inviteSchema.parse(req.body);
  if (!canAssignRole(actorRole, input.role)) throw forbidden("You can't invite someone with that role");

  const branchIds = ALL_BRANCH_ROLES.includes(input.role) ? [] : [...new Set(input.branchIds)];
  if (!ALL_BRANCH_ROLES.includes(input.role) && branchIds.length === 0) {
    throw badRequest("Choose at least one branch for this role");
  }
  await assertBranchesInBusiness(businessId, branchIds);

  const alreadyMember = await prisma.membership.findFirst({
    where: { businessId, status: "ACTIVE", user: { email: input.email } },
  });
  if (alreadyMember) throw conflict("This person is already a member");

  const token = newToken();
  const invitation = await prisma.$transaction(async (tx) => {
    const created = await tx.invitation.create({
      data: {
        businessId,
        email: input.email,
        role: input.role,
        branchIds,
        tokenHash: hashToken(token),
        invitedById: req.user!.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      },
    });
    await audit(tx, req, { action: "member.invited", entityType: "Invitation", entityId: created.id, metadata: { email: input.email, role: input.role } });
    return created;
  });
  // No email provider yet: the owner shares this link themselves (e.g. on WhatsApp).
  res.status(201).json({
    invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    token,
  });
});

invitationsRouter.delete("/:invitationId", requirePermission("member.invite"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const { count } = await prisma.invitation.updateMany({
    where: { id: param(req, "invitationId"), businessId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw notFound("Invitation");
  await audit(prisma, req, { action: "member.invite_revoked", entityType: "Invitation", entityId: param(req, "invitationId") });
  res.status(204).end();
});

/** Mounted at /invitations. Accepting doesn't need a business context. */
export const acceptInvitationRouter = Router();

acceptInvitationRouter.post("/accept", async (req, res) => {
  const input = acceptInviteSchema.parse(req.body);
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    throw notFound("Invitation");
  }

  if (req.user) {
    if (req.user.email !== invitation.email) throw forbidden("This invitation was sent to a different email address");
  } else {
    if (await prisma.user.findUnique({ where: { email: invitation.email } })) {
      throw conflict("You already have an account. Sign in, then open the invitation link again.");
    }
    if (!input.name || !input.password) throw badRequest("Name and password are required to create your account");
  }
  const passwordHash = req.user ? null : await hashPassword(input.password!);

  const user = await prisma.$transaction(async (tx) => {
    // Claim the invitation atomically so it can only be used once.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw notFound("Invitation");

    const user =
      req.user ?? (await tx.user.create({ data: { email: invitation.email, name: input.name!, passwordHash: passwordHash! } }));
    const userId = user.id;

    const branchIds = ALL_BRANCH_ROLES.includes(invitation.role)
      ? []
      : (await tx.branch.findMany({
          where: { businessId: invitation.businessId, id: { in: invitation.branchIds }, archivedAt: null },
          select: { id: true },
        })).map((b) => b.id);

    const membership = await tx.membership.upsert({
      where: { businessId_userId: { businessId: invitation.businessId, userId } },
      create: { businessId: invitation.businessId, userId, role: invitation.role },
      update: { role: invitation.role, status: "ACTIVE" },
    });
    await tx.membershipBranch.deleteMany({ where: { membershipId: membership.id } });
    await tx.membershipBranch.createMany({
      data: branchIds.map((branchId) => ({ membershipId: membership.id, branchId, businessId: invitation.businessId })),
    });
    await audit(tx, req, {
      businessId: invitation.businessId,
      actorUserId: userId,
      action: "member.joined",
      entityType: "Membership",
      entityId: membership.id,
      metadata: { role: invitation.role },
    });
    return user;
  });

  const token = req.user ? undefined : (await createSession(req, res, user.id)).token;
  res.status(201).json({ user: publicUser(user), businessId: invitation.businessId, token });
});
