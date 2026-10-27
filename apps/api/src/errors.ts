import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = () => new HttpError(401, "UNAUTHENTICATED", "Please sign in");
export const forbidden = (message = "You don't have permission to do that") =>
  new HttpError(403, "FORBIDDEN", message);
/** Used for anything the caller can't see, so we never confirm another tenant's IDs exist. */
export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "VALIDATION", message: "Invalid input", details: err.issues } });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (typeof err === "object" && err && "type" in err && err.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body" } });
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
};
