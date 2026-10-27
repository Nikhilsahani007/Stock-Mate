import type { Paise } from "./money.js";

/**
 * Billing math shared by the API (which is authoritative) and the web app
 * (which previews totals). All amounts are integer paise; every rounding is
 * half away from zero and happens once per line.
 */

function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export interface LineInput {
  quantity: number;
  unitPrice: Paise;
  discount?: Paise;
  /** GST rate in basis points. Ignored when GST does not apply. */
  gstRateBps: number;
}

export interface LineAmounts {
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  lineTotal: Paise;
}

export interface TaxMode {
  /** The branch issues GST invoices (or claims GST input) on this document. */
  gstApplied: boolean;
  /** Prices already include GST, as with MRP pricing at the counter. */
  pricesIncludeTax: boolean;
  /** Supplier or customer is in another state, so IGST instead of CGST + SGST. */
  interState: boolean;
}

export function computeLine(line: LineInput, mode: TaxMode): LineAmounts {
  const gross = line.quantity * line.unitPrice - (line.discount ?? 0);
  if (gross < 0) throw new Error("Discount is larger than the line amount");
  if (!mode.gstApplied || line.gstRateBps === 0) {
    return { taxableValue: gross, cgst: 0, sgst: 0, igst: 0, lineTotal: gross };
  }
  const rate = line.gstRateBps;
  let taxable: number;
  let tax: number;
  if (mode.pricesIncludeTax) {
    taxable = roundHalfAway((gross * 10_000) / (10_000 + rate));
    tax = gross - taxable;
  } else {
    taxable = gross;
    tax = roundHalfAway((gross * rate) / 10_000);
  }
  if (mode.interState) return { taxableValue: taxable, cgst: 0, sgst: 0, igst: tax, lineTotal: taxable + tax };
  const cgst = roundHalfAway(tax / 2);
  return { taxableValue: taxable, cgst, sgst: tax - cgst, igst: 0, lineTotal: taxable + tax };
}

/** Rounds an invoice to the nearest rupee and returns the separate round-off amount. */
export function roundInvoice(exact: Paise): { total: Paise; roundOff: Paise } {
  const total = roundHalfAway(exact / 100) * 100;
  return { total, roundOff: total - exact };
}

/**
 * Splits `amount` across `weights` in proportion, so the parts always add up
 * to exactly `amount` (largest remainder method). Used to spread freight over
 * purchase lines and a line's cost over its units.
 */
export function allocate(amount: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    // Nothing to weight by: split evenly.
    return allocate(amount, weights.map(() => 1));
  }
  const raw = weights.map((w) => (amount * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let left = amount - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k]!.i]! += 1;
  return parts;
}

/** Indian fiscal year label for a YYYY-MM-DD date: 2026-10-27 -> "2026-27". */
export function fiscalYearOf(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Today's calendar date in a timezone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** GST state code is the first two digits of a GSTIN. */
export function stateCodeOf(gstin: string | null | undefined): string | null {
  return gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null;
}

/** True for a 15-digit number whose last digit is a valid Luhn check digit. */
export function isValidImei(value: string): boolean {
  if (!/^\d{15}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(value[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Classifies a device identifier. A 15-digit value must pass the IMEI check
 * digit; anything else is accepted as a plain serial number with a warning.
 */
export function checkDeviceId(value: string): { ok: true; isImei: boolean } | { ok: false; reason: string } {
  if (/^\d{15}$/.test(value)) {
    return isValidImei(value) ? { ok: true, isImei: true } : { ok: false, reason: `${value} is not a valid IMEI (check digit)` };
  }
  return { ok: true, isImei: false };
}
