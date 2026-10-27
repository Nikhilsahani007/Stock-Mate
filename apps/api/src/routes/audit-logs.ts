import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";

export const auditLogsRouter = Router({ mergeParams: true });

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

auditLogsRouter.get("/", requirePermission("audit.read"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const { cursor, limit } = querySchema.parse(req.query);
  const rows = await prisma.auditLog.findMany({
    where: { businessId },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map(({ actorUserId: _a, ip: _ip, ...row }) => row);
  res.json({ entries, nextCursor: hasMore ? entries.at(-1)?.id : null });
});
