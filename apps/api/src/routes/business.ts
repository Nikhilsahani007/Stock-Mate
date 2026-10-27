import { Router } from "express";
import { updateBusinessSchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { badRequest } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";

export const businessRouter = Router({ mergeParams: true });

businessRouter.get("/", requirePermission("business.read"), async (req, res) => {
  const { businessId, role, access, branchIds } = tenantOf(req);
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { subscription: true },
  });
  res.json({
    business: {
      id: business.id,
      name: business.name,
      timezone: business.timezone,
      currency: business.currency,
      plan: business.subscription?.plan ?? "STARTER",
      createdAt: business.createdAt,
    },
    membership: { role, branchIds },
    access,
  });
});

businessRouter.patch("/", requirePermission("business.update"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const input = updateBusinessSchema.parse(req.body);
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw badRequest("Unknown timezone");
  }
  const business = await prisma.$transaction(async (tx) => {
    const updated = await tx.business.update({ where: { id: businessId }, data: input });
    await audit(tx, req, { action: "business.updated", entityType: "Business", entityId: businessId, metadata: input });
    return updated;
  });
  res.json({ business: { id: business.id, name: business.name, timezone: business.timezone } });
});

function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
