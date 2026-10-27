import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "./db.js";

type Db = Prisma.TransactionClient | typeof prisma;

export interface AuditEntry {
  businessId?: string | null;
  /** Defaults to the signed-in user. */
  actorUserId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Writes an audit row. Pass the transaction client so the log commits with the change. */
export function audit(db: Db, req: Request, entry: AuditEntry) {
  return db.auditLog.create({
    data: {
      businessId: entry.businessId ?? req.tenant?.businessId ?? null,
      actorUserId: entry.actorUserId ?? req.user?.id ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata,
      ip: req.ip ?? null,
    },
  });
}
