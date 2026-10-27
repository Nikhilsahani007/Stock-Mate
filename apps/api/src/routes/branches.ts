import { Prisma } from "@prisma/client";
import { Router } from "express";
import { branchSchema, updateBranchSchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { param } from "../params.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { branchScope, canAccessBranch, requirePermission, tenantOf } from "../middleware/tenant.js";

export const branchesRouter = Router({ mergeParams: true });

branchesRouter.get("/", requirePermission("branch.read"), async (req, res) => {
  const includeArchived = req.query.includeArchived === "true";
  const branches = await prisma.branch.findMany({
    where: { ...branchScope(req), ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: "asc" },
  });
  res.json({ branches });
});

branchesRouter.post("/", requirePermission("branch.create"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const input = branchSchema.parse(req.body);
  const branch = await prisma
    .$transaction(async (tx) => {
      const created = await tx.branch.create({ data: { ...input, businessId } });
      await audit(tx, req, { action: "branch.created", entityType: "Branch", entityId: created.id, metadata: { name: created.name } });
      return created;
    })
    .catch(rethrowDuplicateName);
  res.status(201).json({ branch });
});

branchesRouter.get("/:branchId", requirePermission("branch.read"), async (req, res) => {
  res.json({ branch: await findAccessibleBranch(req, param(req, "branchId")) });
});

branchesRouter.patch("/:branchId", requirePermission("branch.update"), async (req, res) => {
  const existing = await findAccessibleBranch(req, param(req, "branchId"));
  const input = updateBranchSchema.parse(req.body);
  const gstEnabled = input.gstEnabled ?? existing.gstEnabled;
  const gstin = input.gstin === undefined ? existing.gstin : input.gstin;
  if (gstEnabled && !gstin) throw badRequest("GSTIN is required when GST invoicing is enabled");

  const branch = await prisma
    .$transaction(async (tx) => {
      const updated = await tx.branch.update({ where: { id: existing.id }, data: input });
      await audit(tx, req, { action: "branch.updated", entityType: "Branch", entityId: existing.id, metadata: input });
      return updated;
    })
    .catch(rethrowDuplicateName);
  res.json({ branch });
});

async function findAccessibleBranch(req: Parameters<typeof tenantOf>[0], branchId: string) {
  const { businessId } = tenantOf(req);
  if (!canAccessBranch(req, branchId)) throw notFound("Branch");
  const branch = await prisma.branch.findFirst({ where: { id: branchId, businessId } });
  if (!branch) throw notFound("Branch");
  return branch;
}

function rethrowDuplicateName(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw conflict("A branch with this name already exists");
  }
  throw err;
}
