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

// ---------------------------------------------------------------------------
// Phase 2: catalog, parties and documents. Money is integer paise.
// ---------------------------------------------------------------------------

const paise = z.number().int().min(0).max(1_000_000_000);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const id = z.string().min(1).max(64);

export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** An IMEI or serial number, normalised to upper case without spaces. */
export const deviceIdSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9-]{6,24}$/, "IMEI or serial must be 6 to 24 letters or digits"));

/** GST rate in basis points: 0%, 0.25%, 3%, 5%, 12%, 18%, 28% or 40%. */
export const gstRateSchema = z.union([0, 25, 300, 500, 1200, 1800, 2800, 4000].map((r) => z.literal(r)) as [
  z.ZodLiteral<number>,
  z.ZodLiteral<number>,
  ...z.ZodLiteral<number>[],
]);

export const nameOnlySchema = z.object({ name: z.string().trim().min(1).max(80) });

export const variantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(1).max(64).optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  mrp: paise.optional(),
  salePrice: paise.optional(),
  reorderLevel: z.number().int().min(0).max(100_000).default(0),
});
export type VariantInput = z.input<typeof variantSchema>;

export const updateVariantSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  mrp: paise.nullable().optional(),
  salePrice: paise.nullable().optional(),
  reorderLevel: z.number().int().min(0).max(100_000).optional(),
  archived: z.boolean().optional(),
});

export const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brandId: id.optional(),
  categoryId: id.optional(),
  isSerialized: z.boolean().default(false),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "HSN is 4 to 8 digits").optional(),
  gstRateBps: gstRateSchema.default(1800),
  variants: z.array(variantSchema).min(1).max(50),
});
export type ProductInput = z.input<typeof productSchema>;

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  brandId: id.nullable().optional(),
  categoryId: id.nullable().optional(),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/).nullable().optional(),
  gstRateBps: gstRateSchema.optional(),
  archived: z.boolean().optional(),
});

export const PARTY_KINDS = ["CUSTOMER", "SUPPLIER", "BOTH"] as const;
export const partySchema = z.object({
  kind: z.enum(PARTY_KINDS),
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema.optional(),
  gstin: gstinSchema.optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  address: optionalText(300),
});
export type PartyInput = z.input<typeof partySchema>;

export const updatePartySchema = z.object({
  kind: z.enum(PARTY_KINDS).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: phoneSchema.nullable().optional(),
  gstin: gstinSchema.nullable().optional(),
  stateCode: z.string().regex(/^\d{2}$/).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});

export const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "BANK"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const tenderSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: paise.min(1),
  reference: optionalText(80),
});

export const EXPENSE_CATEGORIES = ["RENT", "SALARY", "ELECTRICITY", "TRANSPORT", "OTHER"] as const;

const qty = z.number().int().min(1).max(100_000);
const docBase = {
  branchId: id,
  businessDate: businessDateSchema.optional(),
  notes: optionalText(500),
};

export const newSerialSchema = z.object({ imei: deviceIdSchema, imei2: deviceIdSchema.optional() });

export const purchaseSchema = z.object({
  ...docBase,
  partyId: id,
  /** The supplier's own bill number, for matching. */
  supplierRef: optionalText(60),
  pricesIncludeTax: z.boolean().default(false),
  otherCharges: paise.default(0),
  lines: z
    .array(
      z.object({
        variantId: id,
        quantity: qty,
        unitPrice: paise,
        discount: paise.default(0),
        gstRateBps: gstRateSchema.optional(),
        serials: z.array(newSerialSchema).max(1000).default([]),
      }),
    )
    .min(1)
    .max(200),
  tenders: z.array(tenderSchema).max(5).default([]),
});
export type PurchaseInput = z.input<typeof purchaseSchema>;

export const saleSchema = z.object({
  ...docBase,
  /** Optional for a fully paid counter sale; required when anything is left on credit. */
  partyId: id.optional(),
  pricesIncludeTax: z.boolean().default(true),
  lines: z
    .array(
      z.object({
        variantId: id,
        quantity: qty,
        unitPrice: paise,
        discount: paise.default(0),
        serials: z.array(deviceIdSchema).max(1000).default([]),
      }),
    )
    .min(1)
    .max(200),
  tenders: z.array(tenderSchema).max(5).default([]),
});
export type SaleInput = z.input<typeof saleSchema>;

export const openingStockSchema = z.object({
  ...docBase,
  lines: z
    .array(
      z.object({
        variantId: id,
        quantity: qty,
        /** What the owner believes each unit cost. Leave out if unknown. */
        unitCost: paise.optional(),
        serials: z.array(newSerialSchema).max(1000).default([]),
      }),
    )
    .min(1)
    .max(500),
});
export type OpeningStockInput = z.input<typeof openingStockSchema>;

export const adjustmentSchema = z.object({
  ...docBase,
  reason: z.string().trim().min(3).max(300),
  lines: z
    .array(
      z.object({
        variantId: id,
        /** Negative for loss or damage, positive for stock found. */
        quantity: z.number().int().min(-100_000).max(100_000).refine((q) => q !== 0, "Quantity cannot be zero"),
        /** Cost of found stock. Defaults to the current average. */
        unitCost: paise.optional(),
        serials: z.array(deviceIdSchema).max(1000).default([]),
      }),
    )
    .min(1)
    .max(200),
});
export type AdjustmentInput = z.input<typeof adjustmentSchema>;

export const transferSchema = z.object({
  ...docBase,
  toBranchId: id,
  lines: z
    .array(z.object({ variantId: id, quantity: qty, serials: z.array(deviceIdSchema).max(1000).default([]) }))
    .min(1)
    .max(200),
});
export type TransferInput = z.input<typeof transferSchema>;

export const expenseSchema = z
  .object({
    ...docBase,
    category: z.enum(EXPENSE_CATEGORIES),
    amount: paise.min(1),
    /** How it was paid. Leave out for an unpaid bill, which then needs a supplier. */
    method: z.enum(PAYMENT_METHODS).optional(),
    partyId: id.optional(),
  })
  .refine((e) => e.method || e.partyId, { message: "An unpaid expense needs a supplier", path: ["partyId"] });
export type ExpenseInput = z.input<typeof expenseSchema>;

/** A customer receipt or a supplier payment. */
export const settlementSchema = z.object({
  ...docBase,
  partyId: id,
  tenders: z.array(tenderSchema).min(1).max(5),
  /** Which invoices or bills to settle. Left out: oldest first. */
  allocations: z.array(z.object({ documentId: id, amount: paise.min(1) })).max(100).optional(),
});
export type SettlementInput = z.input<typeof settlementSchema>;

export const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });
