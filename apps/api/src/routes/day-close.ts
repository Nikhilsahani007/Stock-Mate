import { cancelSchema, dayCloseSchema, roleHas, todayIn } from "@stockpilot/shared";
import { Router, type Request } from "express";
import { prisma } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { canAccessBranch, requirePermission, tenantOf } from "../middleware/tenant.js";
import { param } from "../params.js";
import { cancelDocument } from "../posting/cancel.js";
import { lastClosedDay, runPosting } from "../posting/core.js";
import { computeDay, hasActiveClose, postDayClose } from "../posting/day-close.js";

export const dayCloseRouter = Router({ mergeParams: true });

/** Counting the drawer needs day.close; reviewing closes needs either that or report access. */
function requireDayAccess(req: Request) {
  const { role } = tenantOf(req);
  if (!roleHas(role, "day.close") && !roleHas(role, "report.view")) throw forbidden();
}

async function accessibleBranch(req: Request, branchId: unknown) {
  const { businessId } = tenantOf(req);
  if (typeof branchId !== "string" || !canAccessBranch(req, branchId)) throw notFound("Branch");
  const branch = await prisma.branch.findFirst({ where: { id: branchId, businessId } });
  if (!branch) throw notFound("Branch");
  return branch;
}

/**
 * The day's figures before counting. People without report access (cashiers)
 * count blind: they don't see the expected cash until the day is closed.
 */
dayCloseRouter.get("/preview", async (req, res) => {
  requireDayAccess(req);
  const { businessId, role } = tenantOf(req);
  const branch = await accessibleBranch(req, req.query.branchId);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });
  const today = todayIn(business.timezone);
  const date = typeof req.query.date === "string" && req.query.date ? req.query.date : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw badRequest("Choose today or an earlier date");

  const last = await lastClosedDay(prisma, branch.id);
  const lastIso = last?.toISOString().slice(0, 10) ?? null;
  const day = await computeDay(prisma, businessId, branch.id, date);
  const seesExpected = roleHas(role, "report.view");
  res.json({
    branchId: branch.id,
    date,
    lastClosedDate: lastIso,
    /** False when this date is on or before the last closed day. */
    canClose: lastIso === null || date > lastIso,
    /** An opening float can be entered only on a branch's first close. */
    firstClose: !(await hasActiveClose(prisma, branch.id)),
    summary: day.summary,
    ...(seesExpected ? { openingCash: day.openingCash, cashIn: day.cashIn, cashOut: day.cashOut, expectedCash: day.openingCash + day.cashIn - day.cashOut } : {}),
  });
});

dayCloseRouter.post("/", requirePermission("day.close"), async (req, res) => {
  const input = dayCloseSchema.parse(req.body);
  const { documentId, replayed } = await runPosting(req, (ctx) => postDayClose(ctx, input));
  res.status(replayed ? 200 : 201).json({ dayClose: await loadClose(req, { documentId }), replayed });
});

dayCloseRouter.get("/", async (req, res) => {
  requireDayAccess(req);
  const { businessId, branchIds } = tenantOf(req);
  const branchId = typeof req.query.branchId === "string" && req.query.branchId ? (await accessibleBranch(req, req.query.branchId)).id : null;
  const closes = await prisma.dayClose.findMany({
    where: {
      businessId,
      ...(branchId ? { branchId } : branchIds === null ? {} : { branchId: { in: branchIds } }),
    },
    include: { branch: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } }, document: { select: { number: true } } },
    orderBy: [{ businessDate: "desc" }, { closedAt: "desc" }],
    take: Math.min(Number(req.query.limit) || 60, 200),
  });
  res.json({ dayCloses: closes });
});

dayCloseRouter.get("/:dayCloseId", async (req, res) => {
  requireDayAccess(req);
  res.json({ dayClose: await loadClose(req, { id: param(req, "dayCloseId") }) });
});

/** Reopens the latest closed day of a branch by cancelling its close. */
dayCloseRouter.post("/:dayCloseId/reopen", requirePermission("document.cancel"), async (req, res) => {
  const close = await loadClose(req, { id: param(req, "dayCloseId") });
  const { reason } = cancelSchema.parse(req.body);
  await runPosting(req, (ctx) => cancelDocument(ctx, close.documentId, reason));
  res.json({ dayClose: await loadClose(req, { id: close.id }) });
});

async function loadClose(req: Request, where: { id: string } | { documentId: string }) {
  const { businessId } = tenantOf(req);
  const close = await prisma.dayClose.findFirst({
    where: { businessId, ...where },
    include: { branch: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } }, document: { select: { number: true } } },
  });
  if (!close || !canAccessBranch(req, close.branchId)) throw notFound("Day close");
  return close;
}
