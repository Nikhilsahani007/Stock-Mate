import type { Paise } from "./money.js";

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 3;
export const ARCHIVE_AFTER_DAYS = 90;

export const PLAN_CODES = ["STARTER", "GROWTH", "PRO"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  monthlyPricePaise: Paise;
  yearlyPricePaise: Paise;
  maxBranches: number | null;
}

/** Launch prices. Yearly: Starter ₹149/mo billed yearly; Growth and Pro get two months free. */
export const PLANS: Record<PlanCode, PlanDefinition> = {
  STARTER: { code: "STARTER", name: "Starter", monthlyPricePaise: 199_00, yearlyPricePaise: 1_788_00, maxBranches: 1 },
  GROWTH: { code: "GROWTH", name: "Growth", monthlyPricePaise: 999_00, yearlyPricePaise: 9_990_00, maxBranches: 3 },
  PRO: { code: "PRO", name: "Pro", monthlyPricePaise: 1_999_00, yearlyPricePaise: 19_990_00, maxBranches: 5 },
};

export const SUBSCRIPTION_ACCESS = ["FULL", "READ_ONLY", "NONE"] as const;
export type SubscriptionAccess = (typeof SUBSCRIPTION_ACCESS)[number];

export interface AccessState {
  access: SubscriptionAccess;
  phase: "TRIAL" | "GRACE" | "ACTIVE" | "EXPIRED" | "ARCHIVED";
  trialEndsAt: Date;
  graceEndsAt: Date;
  daysLeft: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trial lifecycle: 14 days full access -> 3 days grace (full access, with
 * warnings) -> read-only with export -> archived after 90 days.
 */
export function computeAccess(
  trialStartedAt: Date,
  now: Date,
  paidThrough: Date | null = null,
): AccessState {
  const trialEndsAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * DAY_MS);
  const graceEndsAt = new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY_MS);
  const archiveAt = new Date(graceEndsAt.getTime() + ARCHIVE_AFTER_DAYS * DAY_MS);
  const daysUntil = (d: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY_MS));

  if (paidThrough && now < paidThrough) {
    return { access: "FULL", phase: "ACTIVE", trialEndsAt, graceEndsAt, daysLeft: daysUntil(paidThrough) };
  }
  if (now < trialEndsAt) {
    return { access: "FULL", phase: "TRIAL", trialEndsAt, graceEndsAt, daysLeft: daysUntil(trialEndsAt) };
  }
  if (now < graceEndsAt) {
    return { access: "FULL", phase: "GRACE", trialEndsAt, graceEndsAt, daysLeft: daysUntil(graceEndsAt) };
  }
  if (now < archiveAt) {
    return { access: "READ_ONLY", phase: "EXPIRED", trialEndsAt, graceEndsAt, daysLeft: 0 };
  }
  return { access: "NONE", phase: "ARCHIVED", trialEndsAt, graceEndsAt, daysLeft: 0 };
}
