import type { DocumentStatus, DocumentType, Prisma } from "@prisma/client";
import {
  adjustmentSchema,
  cancelSchema,
  checkDeviceId,
  expenseSchema,
  openingStockSchema,
  purchaseReturnSchema,
  purchaseSchema,
  roleHas,
  saleReturnSchema,
  saleSchema,
  settlementSchema,
  transferSchema,
  type Permission,
} from "@stockpilot/shared";
import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import { prisma } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";
import { param } from "../params.js";
import { cancelDocument } from "../posting/cancel.js";
import { CREATE_PERMISSION, runPosting, type PostContext } from "../posting/core.js";
import { postOpeningStock, postPurchase } from "../posting/inbound.js";
import { postAdjustment, postSale, postTransfer, receiveTransfer } from "../posting/outbound.js";
import { postPurchaseReturn, postSaleReturn } from "../posting/returns.js";
import { postExpense, postSettlement } from "../posting/settlement.js";
import { renderDocumentPdf } from "../pdf/document-pdf.js";
import { canSeeCost } from "./stock.js";

export const documentsRouter = Router({ mergeParams: true });

const DOCUMENT_TYPES = Object.keys(CREATE_PERMISSION) as DocumentType[];

/** Types the member may read: the ones they can create, or all of them with report access. */
function visibleTypes(req: Request): DocumentType[] {
  const { role } = tenantOf(req);
  return DOCUMENT_TYPES.filter((t) => roleHas(role, CREATE_PERMISSION[t]) || roleHas(role, "report.view"));
}

function branchVisibility(req: Request): Prisma.DocumentWhereInput {
  const { branchIds } = tenantOf(req);
  return branchIds === null ? {} : { OR: [{ branchId: { in: branchIds } }, { toBranchId: { in: branchIds } }] };
}

/** Posts a document and answers with it. Retries with the same Idempotency-Key get the original back. */
function poster<S extends z.ZodType>(
  permission: Permission,
  schema: S,
  post: (ctx: PostContext, input: z.output<S>) => Promise<string>,
  warn?: (input: z.output<S>) => string[],
) {
  return [
    requirePermission(permission),
    async (req: Request, res: Response) => {
      const input = schema.parse(req.body);
      const warnings = warn?.(input) ?? [];
      const { documentId, replayed } = await runPosting(req, (ctx) => post(ctx, input));
      res.status(replayed ? 200 : 201).json({ document: await loadDocument(req, documentId), replayed, warnings });
    },
  ];
}

/** IMEIs that aren't 15-digit IMEIs are accepted as plain serial numbers, with a heads-up. Bad check digits are refused. */
function serialWarnings(lines: { serials: { imei: string; imei2?: string | undefined }[] }[]) {
  const warnings: string[] = [];
  for (const s of lines.flatMap((l) => l.serials)) {
    for (const id of s.imei2 ? [s.imei, s.imei2] : [s.imei]) {
      const check = checkDeviceId(id);
      if (!check.ok) throw badRequest(check.reason);
      if (!check.isImei) warnings.push(`${id} is not a 15-digit IMEI; saved as a serial number`);
    }
  }
  return warnings;
}

documentsRouter.post("/purchases", ...poster("purchase.create", purchaseSchema, postPurchase, (i) => serialWarnings(i.lines)));
documentsRouter.post("/opening-stock", ...poster("stock.adjust", openingStockSchema, postOpeningStock, (i) => serialWarnings(i.lines)));
documentsRouter.post("/sales", ...poster("sale.create", saleSchema, postSale));
documentsRouter.post("/adjustments", ...poster("stock.adjust", adjustmentSchema, postAdjustment));
documentsRouter.post("/transfers", ...poster("stock.transfer", transferSchema, postTransfer));
documentsRouter.post("/expenses", ...poster("expense.record", expenseSchema, postExpense));
documentsRouter.post("/receipts", ...poster("payment.record", settlementSchema, (ctx, i) => postSettlement(ctx, "RECEIPT", i)));
documentsRouter.post("/supplier-payments", ...poster("payment.record", settlementSchema, (ctx, i) => postSettlement(ctx, "PAYMENT", i)));
documentsRouter.post("/sale-returns", ...poster("sale.return", saleReturnSchema, postSaleReturn));
documentsRouter.post("/purchase-returns", ...poster("purchase.create", purchaseReturnSchema, postPurchaseReturn));

documentsRouter.post("/transfers/:documentId/receive", requirePermission("stock.transfer"), async (req, res) => {
  const id = param(req, "documentId");
  const { documentId } = await runPosting(req, (ctx) => receiveTransfer(ctx, id));
  res.json({ document: await loadDocument(req, documentId) });
});

documentsRouter.post("/documents/:documentId/cancel", requirePermission("document.cancel"), async (req, res) => {
  const id = param(req, "documentId");
  const { reason } = cancelSchema.parse(req.body);
  const { documentId } = await runPosting(req, (ctx) => cancelDocument(ctx, id, reason));
  res.json({ document: await loadDocument(req, documentId) });
});

documentsRouter.get("/documents", async (req, res) => {
  const { businessId } = tenantOf(req);
  const types = visibleTypes(req);
  const type = typeof req.query.type === "string" ? (req.query.type as DocumentType) : null;
  if (type && !types.includes(type)) throw notFound("Document type");
  const status = typeof req.query.status === "string" ? (req.query.status as DocumentStatus) : null;
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;
  const where: Prisma.DocumentWhereInput = {
    businessId,
    type: type ?? { in: types },
    ...branchVisibility(req),
    ...(typeof req.query.branchId === "string" ? { branchId: req.query.branchId } : {}),
    ...(typeof req.query.partyId === "string" ? { partyId: req.query.partyId } : {}),
    ...(status && ["POSTED", "IN_TRANSIT", "CANCELLED"].includes(status) ? { status } : {}),
    ...(from || to
      ? { businessDate: { ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}) } }
      : {}),
    ...(typeof req.query.q === "string" && req.query.q ? { number: { contains: req.query.q.slice(0, 40), mode: "insensitive" as const } } : {}),
  };
  const documents = await prisma.document.findMany({
    where,
    select: {
      id: true,
      type: true,
      status: true,
      number: true,
      businessDate: true,
      branchId: true,
      toBranchId: true,
      total: true,
      paidAmount: true,
      expenseCategory: true,
      party: { select: { id: true, name: true } },
    },
    orderBy: [{ businessDate: "desc" }, { postedAt: "desc" }],
    take: Math.min(Number(req.query.limit) || 50, 200),
  });
  res.json({ documents });
});

documentsRouter.get("/documents/:documentId", async (req, res) => {
  res.json({ document: await loadDocument(req, param(req, "documentId")) });
});

/** The document as a printable A4 PDF. Prints no costs, whoever asks. */
documentsRouter.get("/documents/:documentId/pdf", async (req, res) => {
  const doc = await loadDocument(req, param(req, "documentId"));
  const business = await prisma.business.findUniqueOrThrow({ where: { id: tenantOf(req).businessId }, select: { name: true } });
  const pdf = await renderDocumentPdf(doc, business.name);
  res
    .type("application/pdf")
    .set("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${doc.number.replaceAll("/", "-")}.pdf"`)
    .set("Cache-Control", "private, no-store")
    .send(pdf);
});

/** A document as the member may see it: costs and ledger only with the matching permissions. */
async function loadDocument(req: Request, id: string) {
  const { businessId, role } = tenantOf(req);
  const doc = await prisma.document.findFirst({
    where: { id, businessId, type: { in: visibleTypes(req) }, ...branchVisibility(req) },
    include: {
      branch: { select: { id: true, name: true, address: true, phone: true, gstin: true, gstEnabled: true } },
      toBranch: { select: { id: true, name: true } },
      party: true,
      createdBy: { select: { id: true, name: true } },
      sourceDocument: { select: { id: true, number: true, type: true, businessDate: true } },
      returns: { select: { id: true, number: true, type: true, status: true, total: true, businessDate: true, tenders: { where: { method: "FINANCE" }, select: { method: true, amount: true, party: { select: { id: true, name: true } } } } }, orderBy: { postedAt: "asc" } },
      lines: {
        orderBy: { position: "asc" },
        include: {
          variant: { include: { product: { select: { id: true, name: true, hsnCode: true, isSerialized: true } } } },
          serials: { include: { serialUnit: { select: { id: true, imei: true, imei2: true, status: true } } } },
          // What has come back against this line so far, for return screens.
          returnedBy: {
            where: { document: { status: { not: "CANCELLED" } } },
            select: { quantity: true, serials: { select: { serialUnit: { select: { imei: true } } } } },
          },
        },
      },
      tenders: { include: { party: { select: { id: true, name: true } } } },
      allocationsFrom: { include: { to: { select: { id: true, number: true, type: true } } } },
      allocationsTo: { include: { from: { select: { id: true, number: true, type: true } } } },
      ledgerEntries: roleHas(role, "report.view") ? { orderBy: { id: "asc" } } : false,
    },
  });
  if (!doc) throw notFound("Document");
  if (canSeeCost(req)) return doc;
  return {
    ...doc,
    lines: doc.lines.map(({ costTotal: _c, costConfidence: _cc, serials, ...line }) => ({
      ...line,
      serials: serials.map(({ unitCost: _u, ...s }) => s),
    })),
  };
}
