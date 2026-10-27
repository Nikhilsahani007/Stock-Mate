import type { Request } from "express";
import { notFound } from "./errors.js";

/** Reads a single route parameter, treating anything malformed as not found. */
export function param(req: Request, name: string): string {
  const value: unknown = req.params[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 64) throw notFound();
  return value;
}
