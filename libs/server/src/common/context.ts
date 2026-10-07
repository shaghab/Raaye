import type { Role } from '@raaye/contracts';

/** Verified staff identity plus active membership. Never derived from client-supplied ids. */
export interface TenantContext {
  organizationId: string;
  userId: string;
  membershipId: string;
  role: Role;
  email: string;
  correlationId: string;
}

/** Context for worker handlers and system processes acting inside one organization. */
export interface SystemContext {
  organizationId: string;
  correlationId: string;
  actor: 'SYSTEM' | 'PARTICIPANT';
}

export type OrgContext = TenantContext | SystemContext;

export function isStaff(ctx: OrgContext): ctx is TenantContext {
  return 'userId' in ctx;
}

export function requireRole(ctx: OrgContext, ...roles: Role[]): asserts ctx is TenantContext {
  if (!isStaff(ctx) || !roles.includes(ctx.role)) {
    throw Object.assign(new Error('ROLE_FORBIDDEN'), { code: 'ROLE_FORBIDDEN' });
  }
}
