import type { Session, User } from "@prisma/client";
import type { AccessState, Role } from "@stockpilot/shared";

export interface TenantContext {
  businessId: string;
  membershipId: string;
  role: Role;
  /** null means every branch in the business. */
  branchIds: string[] | null;
  access: AccessState;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
      tenant?: TenantContext;
    }
  }
}
