import { Router } from "express";
import { partySchema, stateCodeOf, updatePartySchema } from "@stockpilot/shared";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { notFound } from "../errors.js";
import { requirePermission, tenantOf } from "../middleware/tenant.js";
import { param } from "../params.js";

export const partiesRouter = Router({ mergeParams: true });

partiesRouter.get("/", requirePermission("party.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const kind = req.query.kind === "CUSTOMER" || req.query.kind === "SUPPLIER" ? req.query.kind : null;
  const parties = await prisma.party.findMany({
    where: {
      businessId,
      ...(kind ? { kind: { in: [kind, "BOTH"] } } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { startsWith: q } }] } : {}),
    },
    orderBy: { name: "asc" },
    take: 200,
  });
  res.json({ parties });
});

partiesRouter.post("/", requirePermission("party.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const input = partySchema.parse(req.body);
  const party = await prisma.$transaction(async (tx) => {
    const created = await tx.party.create({
      data: { ...input, businessId, stateCode: input.stateCode ?? stateCodeOf(input.gstin) },
    });
    await audit(tx, req, { action: "party.created", entityType: "Party", entityId: created.id, metadata: { name: created.name, kind: created.kind } });
    return created;
  });
  res.status(201).json({ party });
});

/**
 * A party with what they owe us (receivable) and what we owe them (payable),
 * both straight from the ledger, plus their unsettled invoices and bills.
 */
partiesRouter.get("/:partyId", requirePermission("party.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const party = await prisma.party.findFirst({ where: { id: param(req, "partyId"), businessId } });
  if (!party) throw notFound("Party");
  const sums = await prisma.ledgerEntry.groupBy({
    by: ["account"],
    where: { businessId, partyId: party.id, account: { in: ["RECEIVABLE", "PAYABLE"] } },
    _sum: { debit: true, credit: true },
  });
  const net = (account: "RECEIVABLE" | "PAYABLE") => {
    const s = sums.find((x) => x.account === account)?._sum;
    return (s?.debit ?? 0) - (s?.credit ?? 0);
  };
  const openDocuments = await prisma.document.findMany({
    where: { businessId, partyId: party.id, status: "POSTED", type: { in: ["SALE", "PURCHASE", "EXPENSE"] } },
    select: { id: true, type: true, number: true, businessDate: true, total: true, paidAmount: true, branchId: true },
    orderBy: [{ businessDate: "asc" }, { postedAt: "asc" }],
  });
  res.json({
    party,
    receivable: net("RECEIVABLE"),
    payable: -net("PAYABLE"),
    openDocuments: openDocuments.filter((d) => d.paidAmount < d.total),
  });
});

partiesRouter.patch("/:partyId", requirePermission("party.manage"), async (req, res) => {
  const { businessId } = tenantOf(req);
  const existing = await prisma.party.findFirst({ where: { id: param(req, "partyId"), businessId } });
  if (!existing) throw notFound("Party");
  const input = updatePartySchema.parse(req.body);
  const stateCode = input.stateCode !== undefined ? input.stateCode : input.gstin ? stateCodeOf(input.gstin) : undefined;
  const party = await prisma.$transaction(async (tx) => {
    const updated = await tx.party.update({ where: { id: existing.id }, data: { ...input, ...(stateCode === undefined ? {} : { stateCode }) } });
    await audit(tx, req, { action: "party.updated", entityType: "Party", entityId: existing.id, metadata: input });
    return updated;
  });
  res.json({ party });
});
