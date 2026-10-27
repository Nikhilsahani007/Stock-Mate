export const ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
  "INVENTORY_STAFF",
  "ACCOUNTANT",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "business.read",
  "business.update",
  "branch.read",
  "branch.create",
  "branch.update",
  "member.read",
  "member.invite",
  "member.manage",
  "audit.read",
  "sale.create",
  "purchase.create",
  "stock.adjust",
  "stock.transfer",
  "payment.record",
  "expense.record",
  "report.view",
  "catalog.manage",
  "party.manage",
  "stock.view",
  /** See purchase costs, stock value and margins. */
  "cost.view",
  /** Cancel a posted document (writes a reversal). Also reopens a closed day. */
  "document.cancel",
  /** Count the cash drawer and close a branch's business day. */
  "day.close",
  /** Take goods back from a customer and issue a credit note. */
  "sale.return",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = PERMISSIONS;

/**
 * The single source of truth for what each role may do. The API enforces this;
 * the web client only uses it to decide which controls to show.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== "business.update"),
  BRANCH_MANAGER: [
    "business.read",
    "branch.read",
    "member.read",
    "sale.create",
    "purchase.create",
    "stock.adjust",
    "stock.transfer",
    "payment.record",
    "expense.record",
    "report.view",
    "catalog.manage",
    "party.manage",
    "stock.view",
    "cost.view",
    "document.cancel",
    "day.close",
    "sale.return",
  ],
  CASHIER: ["business.read", "branch.read", "sale.create", "payment.record", "party.manage", "stock.view", "day.close"],
  INVENTORY_STAFF: [
    "business.read",
    "branch.read",
    "purchase.create",
    "stock.adjust",
    "stock.transfer",
    "catalog.manage",
    "party.manage",
    "stock.view",
    "cost.view",
  ],
  ACCOUNTANT: [
    "business.read",
    "branch.read",
    "payment.record",
    "expense.record",
    "report.view",
    "audit.read",
    "party.manage",
    "stock.view",
    "cost.view",
  ],
};

/** Roles that always see every branch of the business. */
export const ALL_BRANCH_ROLES: readonly Role[] = ["OWNER", "ADMIN"];

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether `actor` may grant `target` to someone. Nobody can create another owner via invites. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (target === "OWNER") return false;
  if (actor === "OWNER") return true;
  if (actor === "ADMIN") return target !== "ADMIN";
  return false;
}
