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
