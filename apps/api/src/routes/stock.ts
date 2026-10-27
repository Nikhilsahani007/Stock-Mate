import type { Prisma, SerialStatus } from "@prisma/client";
import { roleHas } from "@stockpilot/shared";
import { Router, type Request } from "express";
import { prisma } from "../db.js";
import { notFound } from "../errors.js";
import { canAccessBranch, requirePermission, tenantOf } from "../middleware/tenant.js";
import { param } from "../params.js";

export const stockRouter = Router({ mergeParams: true });

export function canSeeCost(req: Request) {
  return roleHas(tenantOf(req).role, "cost.view");
}

/** Branch filter from ?branchId=, limited to this business's branches the member may see. */
async function branchFilter(req: Request): Promise<{ in: string[] } | string | undefined> {
  const { businessId, branchIds } = tenantOf(req);
  const requested = typeof req.query.branchId === "string" ? req.query.branchId : null;
  if (requested) {
    if (!canAccessBranch(req, requested) || !(await prisma.branch.findFirst({ where: { id: requested, businessId } }))) {
      throw notFound("Branch");
    }
    return requested;
  }
  return branchIds === null ? undefined : { in: branchIds };
}

const SERIAL_STATUSES = ["IN_STOCK", "SOLD", "IN_TRANSIT", "RETURNED_DAMAGED", "RETURNED_TO_SUPPLIER", "WRITTEN_OFF", "VOIDED"];

/** Quantity on hand per variant and branch. Value and average cost only for roles that may see costs. */
stockRouter.get("/", requirePermission("stock.view"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const showCost = canSeeCost(req);
  const balances = await prisma.stockBalance.findMany({
    where: {
      businessId,
      branchId: await branchFilter(req),
      ...(req.query.inStock === "true" ? { quantity: { gt: 0 } } : {}),
      ...(q
        ? {
            variant: {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { product: { name: { contains: q, mode: "insensitive" } } },
                { sku: q },
                { barcode: q },
              ],
            },
          }
        : {}),
    },
    include: { variant: { include: { product: { include: { brand: true } } } } },
    orderBy: [{ variant: { product: { name: "asc" } } }, { variant: { name: "asc" } }],
    take: 500,
  });
  res.json({
    rows: balances.map((b) => ({
      branchId: b.branchId,
      variantId: b.variantId,
      productId: b.variant.productId,
      productName: b.variant.product.name,
      brand: b.variant.product.brand?.name ?? null,
      variantName: b.variant.name,
      isSerialized: b.variant.product.isSerialized,
      quantity: b.quantity,
      reorderLevel: b.variant.reorderLevel,
      salePrice: b.variant.salePrice,
      mrp: b.variant.mrp,
      ...(showCost
        ? { value: b.value, averageCost: b.quantity > 0 ? Math.round(b.value / b.quantity) : null, costConfidence: b.costConfidence }
        : {}),
    })),
  });
});

/** Devices, for picking at the counter or finding where an IMEI is. */
stockRouter.get("/serials", requirePermission("stock.view"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const q = typeof req.query.q === "string" ? req.query.q.replace(/\s+/g, "").toUpperCase().slice(0, 24) : "";
  const status = typeof req.query.status === "string" && SERIAL_STATUSES.includes(req.query.status) ? (req.query.status as SerialStatus) : undefined;
  const variantId = typeof req.query.variantId === "string" ? req.query.variantId : undefined;
  const where: Prisma.SerialUnitWhereInput = {
    businessId,
    branchId: await branchFilter(req),
    ...(status ? { status } : {}),
    ...(variantId ? { variantId } : {}),
    ...(q ? { OR: [{ imei: { contains: q } }, { imei2: { contains: q } }] } : {}),
  };
  const units = await prisma.serialUnit.findMany({
    where,
    include: { variant: { include: { product: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const showCost = canSeeCost(req);
  res.json({ units: units.map((u) => serialView(u, showCost)) });
});

/** One device and its full history. */
stockRouter.get("/serials/:imei", requirePermission("stock.view"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const id = param(req, "imei").replace(/\s+/g, "").toUpperCase();
  const unit = await prisma.serialUnit.findFirst({
    where: { businessId, OR: [{ imei: id }, { imei2: id }] },
    include: {
      variant: { include: { product: true } },
      movements: {
        include: { document: { select: { id: true, type: true, number: true, status: true } }, branch: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!unit || !canAccessBranch(req, unit.branchId)) throw notFound("Device");
  const showCost = canSeeCost(req);
  res.json({
    unit: serialView(unit, showCost),
    history: unit.movements.map((m) => ({
      businessDate: m.businessDate,
      branch: m.branch.name,
      quantity: m.quantity,
      isReversal: m.isReversal,
      document: m.document,
      ...(showCost ? { value: m.value } : {}),
    })),
  });
});

function serialView(
  u: Prisma.SerialUnitGetPayload<{ include: { variant: { include: { product: true } } } }>,
  showCost: boolean,
) {
  return {
    id: u.id,
    imei: u.imei,
    imei2: u.imei2,
    status: u.status,
    branchId: u.branchId,
    variantId: u.variantId,
    productName: u.variant.product.name,
    variantName: u.variant.name,
    ...(showCost ? { unitCost: u.unitCost, costConfidence: u.costConfidence } : {}),
  };
}
