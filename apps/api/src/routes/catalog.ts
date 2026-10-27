import { Prisma } from "@prisma/client";
import { Router } from "express";
import { nameOnlySchema, productSchema, updateProductSchema, updateVariantSchema, variantSchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";
import { param } from "../params.js";

export const catalogRouter = Router({ mergeParams: true });

function rethrowDuplicate(what: string) {
  return (err: unknown): never => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
      if (target.includes("sku")) throw conflict("Another product already uses this SKU");
      if (target.includes("barcode")) throw conflict("Another product already uses this barcode");
      throw conflict(`${what} with this name already exists`);
    }
    throw err;
  };
}

for (const kind of ["brands", "categories"] as const) {
  const model = kind === "brands" ? prisma.brand : prisma.category;
  const label = kind === "brands" ? "A brand" : "A category";

  catalogRouter.get(`/${kind}`, requirePermission("stock.view"), async (req, res) => {
    const items = await (model as typeof prisma.brand).findMany({ where: { businessId: tenantOf(req).businessId }, orderBy: { name: "asc" } });
    res.json({ items });
  });

  catalogRouter.post(`/${kind}`, requirePermission("catalog.manage"), async (req, res) => {
    const { name } = nameOnlySchema.parse(req.body);
    const item = await (model as typeof prisma.brand)
      .create({ data: { businessId: tenantOf(req).businessId, name } })
      .catch(rethrowDuplicate(label));
    res.status(201).json({ item });
  });
}

const productInclude = {
  brand: true,
  category: true,
  variants: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ProductInclude;

catalogRouter.get("/products", requirePermission("stock.view"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const includeArchived = req.query.includeArchived === "true";
  const products = await prisma.product.findMany({
    where: {
      businessId,
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { brand: { name: { contains: q, mode: "insensitive" } } },
              { variants: { some: { OR: [{ sku: q }, { barcode: q }, { name: { contains: q, mode: "insensitive" } }] } } },
            ],
          }
        : {}),
    },
    include: productInclude,
    orderBy: { name: "asc" },
    take: 200,
  });
  res.json({ products });
});

catalogRouter.post("/products", requirePermission("catalog.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const { variants, ...input } = productSchema.parse(req.body);
  await checkRefs(businessId, input.brandId, input.categoryId);
  const product = await prisma
    .$transaction(async (tx) => {
      const { id } = await tx.product.create({ data: { ...input, businessId } });
      await tx.variant.createMany({ data: variants.map((v) => ({ ...v, businessId, productId: id })) });
      const created = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
      await audit(tx, req, { action: "product.created", entityType: "Product", entityId: created.id, metadata: { name: created.name } });
      return created;
    })
    .catch(rethrowDuplicate("A product"));
  res.status(201).json({ product });
});

catalogRouter.get("/products/:productId", requirePermission("stock.view"), async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: param(req, "productId"), businessId: tenantOf(req).businessId },
    include: productInclude,
  });
  if (!product) throw notFound("Product");
  res.json({ product });
});

catalogRouter.patch("/products/:productId", requirePermission("catalog.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const existing = await prisma.product.findFirst({ where: { id: param(req, "productId"), businessId } });
  if (!existing) throw notFound("Product");
  const { archived, ...input } = updateProductSchema.parse(req.body);
  await checkRefs(businessId, input.brandId, input.categoryId);
  const product = await prisma
    .$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: { ...input, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) },
        include: productInclude,
      });
      await audit(tx, req, { action: "product.updated", entityType: "Product", entityId: existing.id, metadata: { ...input, archived } });
      return updated;
    })
    .catch(rethrowDuplicate("A product"));
  res.json({ product });
});

catalogRouter.post("/products/:productId/variants", requirePermission("catalog.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const product = await prisma.product.findFirst({ where: { id: param(req, "productId"), businessId } });
  if (!product) throw notFound("Product");
  const input = variantSchema.parse(req.body);
  const variant = await prisma.variant
    .create({ data: { ...input, businessId, productId: product.id } })
    .catch(rethrowDuplicate("A variant"));
  res.status(201).json({ variant });
});

catalogRouter.patch("/variants/:variantId", requirePermission("catalog.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const existing = await prisma.variant.findFirst({ where: { id: param(req, "variantId"), businessId } });
  if (!existing) throw notFound("Variant");
  const { archived, ...input } = updateVariantSchema.parse(req.body);
  const variant = await prisma.variant
    .update({
      where: { id: existing.id },
      data: { ...input, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) },
    })
    .catch(rethrowDuplicate("A variant"));
  res.json({ variant });
});

async function checkRefs(businessId: string, brandId?: string | null, categoryId?: string | null) {
  if (brandId && !(await prisma.brand.findFirst({ where: { id: brandId, businessId } }))) throw badRequest("Unknown brand");
  if (categoryId && !(await prisma.category.findFirst({ where: { id: categoryId, businessId } }))) throw badRequest("Unknown category");
}
