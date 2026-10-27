import { z } from "zod";
import { ROLES } from "./roles.js";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
export const passwordSchema = z.string().min(10, "Use at least 10 characters").max(200);
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number");

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN");

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
  businessName: z.string().trim().min(1).max(120),
  branchName: z.string().trim().min(1).max(80).default("Main branch"),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const branchSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(300).optional(),
  phone: phoneSchema.optional(),
  gstEnabled: z.boolean().default(false),
  gstin: gstinSchema.optional(),
}).refine((b) => !b.gstEnabled || !!b.gstin, {
  message: "GSTIN is required when GST invoicing is enabled",
  path: ["gstin"],
});
export type BranchInput = z.input<typeof branchSchema>;

export const updateBranchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  gstEnabled: z.boolean().optional(),
  gstin: gstinSchema.nullable().optional(),
});

export const roleSchema = z.enum(ROLES);

export const inviteSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  /** Branches the member may access. Ignored for roles that see all branches. */
  branchIds: z.array(z.string().min(1)).default([]),
});
export type InviteInput = z.input<typeof inviteSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(100).optional(),
  password: passwordSchema.optional(),
});

export const updateMembershipSchema = z.object({
  role: roleSchema.optional(),
  branchIds: z.array(z.string().min(1)).optional(),
});
