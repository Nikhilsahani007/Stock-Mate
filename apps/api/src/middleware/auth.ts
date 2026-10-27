import type { RequestHandler } from "express";
import { readToken, resolveSession } from "../auth/sessions.js";
import { forbidden, unauthorized } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const CLIENT_HEADER = "x-stockpilot-client";

/** Attaches req.user and req.session when a valid session token is present. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const found = readToken(req);
  if (!found) return next();
  const session = await resolveSession(found.token);
  if (!session) return next();

  // CSRF defence for cookie sessions: browsers cannot add a custom header to a
  // cross-site request without a CORS preflight, which we don't allow.
  if (found.viaCookie && !SAFE_METHODS.has(req.method) && !req.get(CLIENT_HEADER)) {
    throw forbidden("Missing client header");
  }
  const { user, ...rest } = session;
  req.user = user;
  req.session = rest;
  next();
};

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) throw unauthorized();
  next();
};
