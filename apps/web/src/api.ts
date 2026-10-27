export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-StockPilot-Client": "web",
      ...options.headers,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    const detail = Array.isArray(err.details) && err.details[0]?.message ? `: ${err.details[0].message}` : "";
    throw new ApiError(res.status, err.code ?? "UNKNOWN", `${err.message ?? "Request failed"}${detail}`);
  }
  return data as T;
}

export interface AccessState {
  access: "FULL" | "READ_ONLY" | "NONE";
  phase: "TRIAL" | "GRACE" | "ACTIVE" | "EXPIRED" | "ARCHIVED";
  trialEndsAt: string;
  daysLeft: number;
}

export interface Me {
  user: { id: string; name: string; email: string };
  businesses: { id: string; name: string; role: string; access: AccessState }[];
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  gstEnabled: boolean;
  gstin: string | null;
}

/** Posts a document. The key makes a double-tap or a retry after a dropped connection safe. */
export function postDocument<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  return api<T>(path, { method: "POST", body, headers: { "Idempotency-Key": idempotencyKey } });
}

export function newKey() {
  return `web-${crypto.randomUUID()}`;
}

export interface Variant {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  mrp: number | null;
  salePrice: number | null;
  reorderLevel: number;
  archivedAt: string | null;
}

export interface Product {
  id: string;
  name: string;
  isSerialized: boolean;
  hsnCode: string | null;
  gstRateBps: number;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  variants: Variant[];
}

export interface Party {
  id: string;
  kind: "CUSTOMER" | "SUPPLIER" | "BOTH";
  name: string;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
}

export interface StockRow {
  branchId: string;
  variantId: string;
  productId: string;
  productName: string;
  brand: string | null;
  variantName: string;
  isSerialized: boolean;
  quantity: number;
  reorderLevel: number;
  salePrice: number | null;
  mrp: number | null;
  value?: number;
  averageCost?: number | null;
  costConfidence?: Confidence;
}

export type Confidence = "VERIFIED" | "ESTIMATED" | "UNKNOWN";

export interface SerialUnit {
  id: string;
  imei: string;
  imei2: string | null;
  status: string;
  branchId: string;
  variantId: string;
  productName: string;
  variantName: string;
  unitCost?: number;
  costConfidence?: Confidence;
}

export type DocumentType = "PURCHASE" | "SALE" | "OPENING_STOCK" | "ADJUSTMENT" | "TRANSFER" | "EXPENSE" | "RECEIPT" | "PAYMENT";

export interface DocumentSummary {
  id: string;
  type: DocumentType;
  status: "POSTED" | "IN_TRANSIT" | "CANCELLED";
  number: string;
  businessDate: string;
  branchId: string;
  toBranchId: string | null;
  total: number;
  paidAmount: number;
  expenseCategory: string | null;
  party: { id: string; name: string } | null;
}

export interface DocumentLine {
  id: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  gstRateBps: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
  costTotal?: number;
  costConfidence?: Confidence | null;
  variant: Variant & { product: { id: string; name: string; hsnCode: string | null; isSerialized: boolean } };
  serials: { serialUnit: { id: string; imei: string; imei2: string | null } }[];
}

export interface DocumentDetail extends Omit<DocumentSummary, "party"> {
  gstApplied: boolean;
  pricesIncludeTax: boolean;
  interState: boolean;
  taxableTotal: number;
  taxTotal: number;
  otherCharges: number;
  roundOff: number;
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  branch: { id: string; name: string; address: string | null; phone: string | null; gstin: string | null; gstEnabled: boolean };
  toBranch: { id: string; name: string } | null;
  party: Party | null;
  createdBy: { id: string; name: string };
  lines: DocumentLine[];
  tenders: { id: string; method: string; amount: number; reference: string | null }[];
  allocationsFrom: { id: string; amount: number; to: { id: string; number: string; type: DocumentType } }[];
  allocationsTo: { id: string; amount: number; from: { id: string; number: string; type: DocumentType } }[];
}

export interface PostResult {
  document: DocumentDetail;
  warnings: string[];
}
