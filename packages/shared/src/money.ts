/**
 * Money is stored as integer paise (1 rupee = 100 paise). Never use floats for
 * amounts. Rounding rule: half away from zero, applied once at the line level.
 */
export type Paise = number;

export function rupeesToPaise(rupees: string): Paise {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(rupees.trim());
  if (!m) throw new Error(`Invalid rupee amount: ${rupees}`);
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  const value = whole * 100 + frac;
  if (!Number.isSafeInteger(value)) throw new Error(`Amount too large: ${rupees}`);
  return sign * value;
}

export function formatPaise(paise: Paise): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}₹${rupees.toLocaleString("en-IN")}.${frac}`;
}

/** Multiply paise by a rate given in basis points (e.g. 18% GST = 1800), rounding half away from zero. */
export function applyBasisPoints(paise: Paise, bps: number): Paise {
  const raw = (paise * bps) / 10_000;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/** Whole rupees in words with Indian grouping: 1,25,000 -> "One Lakh Twenty Five Thousand". */
function rupeeWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore) parts.push(`${rupeeWords(crore)} Crore`);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor((n % 100_000) / 1000);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  const rest = n % 1000;
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/** An amount in words for invoices: 1_59_990_50 paise -> "Rupees One Lakh Fifty Nine Thousand Nine Hundred Ninety and Fifty Paise Only". */
export function amountInWords(paise: Paise): string {
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const words = `Rupees ${rupeeWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ""} Only`;
  return paise < 0 ? `Minus ${words}` : words;
}
