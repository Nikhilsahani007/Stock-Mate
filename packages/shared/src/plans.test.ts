import { describe, expect, it } from "vitest";
import { computeAccess } from "./plans.js";
import { applyBasisPoints, formatPaise, rupeesToPaise } from "./money.js";
import { canAssignRole, roleHas } from "./roles.js";

const start = new Date("2026-01-01T00:00:00Z");
const at = (days: number) => new Date(start.getTime() + days * 86_400_000);

describe("computeAccess", () => {
  it("walks through trial, grace, expired and archived", () => {
    expect(computeAccess(start, at(0)).phase).toBe("TRIAL");
    expect(computeAccess(start, at(0)).daysLeft).toBe(14);
    expect(computeAccess(start, at(13.9)).phase).toBe("TRIAL");
    expect(computeAccess(start, at(14)).phase).toBe("GRACE");
    expect(computeAccess(start, at(14)).access).toBe("FULL");
    expect(computeAccess(start, at(17)).access).toBe("READ_ONLY");
    expect(computeAccess(start, at(17 + 90)).access).toBe("NONE");
  });

  it("gives full access while paid", () => {
    expect(computeAccess(start, at(40), at(60))).toMatchObject({ access: "FULL", phase: "ACTIVE", daysLeft: 20 });
  });
});

describe("money", () => {
  it("parses and formats paise without floats", () => {
    expect(rupeesToPaise("199")).toBe(19900);
    expect(rupeesToPaise("0.1")).toBe(10);
    expect(rupeesToPaise("-12.05")).toBe(-1205);
    expect(() => rupeesToPaise("1.234")).toThrow();
    expect(formatPaise(12345678)).toBe("₹1,23,456.78");
  });

  it("rounds half away from zero", () => {
    expect(applyBasisPoints(25, 1800)).toBe(5); // 4.5 -> 5
    expect(applyBasisPoints(-25, 1800)).toBe(-5);
  });
});

describe("roles", () => {
  it("keeps cashiers out of reports and nobody can mint owners", () => {
    expect(roleHas("CASHIER", "report.view")).toBe(false);
    expect(roleHas("ACCOUNTANT", "report.view")).toBe(true);
    expect(canAssignRole("OWNER", "OWNER")).toBe(false);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("ADMIN", "CASHIER")).toBe(true);
    expect(canAssignRole("BRANCH_MANAGER", "CASHIER")).toBe(false);
  });
});
