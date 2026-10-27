import "./types.js";
import cookieParser from "cookie-parser";
import express, { Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./env.js";
import { errorHandler, notFound } from "./errors.js";
import { authenticate, requireUser } from "./middleware/auth.js";
import { loadTenant } from "./middleware/tenant.js";
import { auditLogsRouter } from "./routes/audit-logs.js";
import { authRouter } from "./routes/auth.js";
import { branchesRouter } from "./routes/branches.js";
import { businessRouter } from "./routes/business.js";
import { catalogRouter } from "./routes/catalog.js";
import { documentsRouter } from "./routes/documents.js";
import { acceptInvitationRouter, invitationsRouter } from "./routes/invitations.js";
import { membersRouter } from "./routes/members.js";
import { partiesRouter } from "./routes/parties.js";
import { stockRouter } from "./routes/stock.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  if (env.NODE_ENV !== "test") app.use(pinoHttp({ redact: ["req.headers.authorization", "req.headers.cookie"] }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  const api = Router();
  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.use(authenticate);
  api.use("/auth", authRouter);
  api.use("/invitations", acceptInvitationRouter);

  const tenant = Router({ mergeParams: true });
  tenant.use(requireUser, loadTenant);
  tenant.use("/", businessRouter);
  tenant.use("/branches", branchesRouter);
  tenant.use("/members", membersRouter);
  tenant.use("/invitations", invitationsRouter);
  tenant.use("/audit-logs", auditLogsRouter);
  tenant.use("/catalog", catalogRouter);
  tenant.use("/parties", partiesRouter);
  tenant.use("/stock", stockRouter);
  tenant.use("/", documentsRouter);
  api.use("/businesses/:businessId", tenant);

  api.use(() => {
    throw notFound("Route");
  });

  app.use("/api", api);
  app.use(errorHandler);
  return app;
}
