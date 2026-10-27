import { describe, expect, it } from "vitest";
import { proRata } from "./billing.js";
import { amountInWords } from "./money.js";

describe("amountInWords", () => {
  it("uses Indian grouping and names paise", () => {
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(1_00)).toBe("Rupees One Only");
    expect(amountInWords(15_999_00)).toBe("Rupees Fifteen Thousand Nine Hundred Ninety Nine Only");
    expect(amountInWords(1_25_000_00)).toBe("Rupees One Lakh Twenty Five Thousand Only");
    expect(amountInWords(2_03_45_678_50)).toBe("Rupees Two Crore Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only");
    expect(amountInWords(-500_00)).toBe("Minus Rupees Five Hundred Only");
  });
});

describe("proRata", () => {
  it("adds up to the total however the units are taken", () => {
    // 3 units sharing 100 paise: 33 + 33 + 34, or 67 + 33
    expect([proRata(100, 3, 0, 1), proRata(100, 3, 1, 1), proRata(100, 3, 2, 1)]).toEqual([33, 34, 33]);
    expect(proRata(100, 3, 0, 2) + proRata(100, 3, 2, 1)).toBe(100);
    expect(proRata(100, 3, 0, 3)).toBe(100);
    expect(proRata(-100, 3, 0, 1)).toBe(-33);
  });

  it("refuses to take more units than the line has", () => {
    expect(() => proRata(100, 2, 1, 2)).toThrow();
  });
});
