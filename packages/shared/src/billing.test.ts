import { describe, expect, it } from "vitest";
import { allocate, checkDeviceId, computeLine, fiscalYearOf, isValidImei, roundInvoice, stateCodeOf, todayIn } from "./billing.js";
import { deviceIdSchema, gstRateSchema } from "./schemas.js";

const intra = { gstApplied: true, pricesIncludeTax: false, interState: false };

describe("computeLine", () => {
  it("adds GST on top of an exclusive price and splits CGST and SGST", () => {
    // 2 × ₹1,000 at 18%
    expect(computeLine({ quantity: 2, unitPrice: 100_000, gstRateBps: 1800 }, intra)).toEqual({
      taxableValue: 200_000,
      cgst: 18_000,
      sgst: 18_000,
      igst: 0,
      lineTotal: 236_000,
    });
  });

  it("backs GST out of an inclusive price", () => {
    // ₹15,999 MRP at 18%: taxable 13,558.47, tax 2,440.53
    const line = computeLine({ quantity: 1, unitPrice: 1_599_900, gstRateBps: 1800 }, { ...intra, pricesIncludeTax: true });
    expect(line.taxableValue).toBe(1_355_847);
    expect(line.cgst + line.sgst).toBe(244_053);
    expect(line.cgst).toBe(122_027);
    expect(line.lineTotal).toBe(1_599_900);
  });

  it("uses IGST between states", () => {
    const line = computeLine({ quantity: 1, unitPrice: 10_000, gstRateBps: 1800 }, { ...intra, interState: true });
    expect(line).toMatchObject({ cgst: 0, sgst: 0, igst: 1_800, lineTotal: 11_800 });
  });

  it("charges no tax when the branch does not issue GST invoices", () => {
    const line = computeLine({ quantity: 3, unitPrice: 5_000, discount: 1_000, gstRateBps: 1800 }, { ...intra, gstApplied: false });
    expect(line).toEqual({ taxableValue: 14_000, cgst: 0, sgst: 0, igst: 0, lineTotal: 14_000 });
  });

  it("refuses a discount bigger than the line", () => {
    expect(() => computeLine({ quantity: 1, unitPrice: 100, discount: 101, gstRateBps: 0 }, intra)).toThrow();
  });
});

describe("roundInvoice", () => {
  it("rounds to the nearest rupee with a separate round-off", () => {
    expect(roundInvoice(1_599_949)).toEqual({ total: 1_599_900, roundOff: -49 });
    expect(roundInvoice(1_599_950)).toEqual({ total: 1_600_000, roundOff: 50 });
    expect(roundInvoice(500)).toEqual({ total: 500, roundOff: 0 });
  });
});

describe("allocate", () => {
  it("always adds up exactly", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1_000, [300, 700])).toEqual([300, 700]);
    expect(allocate(7, [0, 0])).toEqual([4, 3]);
    const parts = allocate(99_999, [13, 7, 19, 61]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99_999);
  });
});

describe("dates and codes", () => {
  it("labels the Indian fiscal year", () => {
    expect(fiscalYearOf("2026-10-27")).toBe("2026-27");
    expect(fiscalYearOf("2027-03-31")).toBe("2026-27");
    expect(fiscalYearOf("2027-04-01")).toBe("2027-28");
    expect(fiscalYearOf("2099-12-01")).toBe("2099-00");
  });

  it("gives today's date in India even when UTC is still yesterday", () => {
    expect(todayIn("Asia/Kolkata", new Date("2026-10-27T20:00:00Z"))).toBe("2026-10-28");
  });

  it("reads the state code from a GSTIN", () => {
    expect(stateCodeOf("27AAPFU0939F1ZV")).toBe("27");
    expect(stateCodeOf(null)).toBeNull();
  });

  it("accepts the GST 2.0 rates only", () => {
    expect(gstRateSchema.safeParse(1800).success).toBe(true);
    expect(gstRateSchema.safeParse(4000).success).toBe(true);
    expect(gstRateSchema.safeParse(1700).success).toBe(false);
  });
});

describe("device IDs", () => {
  it("checks the IMEI Luhn digit", () => {
    expect(isValidImei("490154203237518")).toBe(true);
    expect(isValidImei("490154203237519")).toBe(false);
    expect(checkDeviceId("490154203237519")).toMatchObject({ ok: false });
  });

  it("accepts non-IMEI serial numbers", () => {
    expect(checkDeviceId("R58N12ABCDE")).toEqual({ ok: true, isImei: false });
  });

  it("normalises spacing and case", () => {
    expect(deviceIdSchema.parse(" 4901 5420 3237 518 ")).toBe("490154203237518");
    expect(deviceIdSchema.parse("r58n12abcde")).toBe("R58N12ABCDE");
  });
});
