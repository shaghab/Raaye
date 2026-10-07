import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@raaye/contracts';
import type { TenantContext } from '../common/context';
import type { VerifiedIdentity } from './token-verifier';

export const PUBLIC_KEY = 'raaye:public';
export const ROLES_KEY = 'raaye:roles';
export const IDENTITY_ONLY_KEY = 'raaye:identity-only';

/** Route needs no authentication (health, webhooks, invitation inspection). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Route needs a verified Firebase identity but not an organization membership. */
export const IdentityOnly = () => SetMetadata(IDENTITY_ONLY_KEY, true);

/** Restrict a route to the listed roles. Without it any active member may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedRequest {
  tenant?: TenantContext;
  identity?: VerifiedIdentity;
  correlationId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  ip?: string;
}

export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.tenant) throw new Error('Tenant context missing: route must be authenticated');
  return request.tenant;
});

export const Identity = createParamDecorator((_data: unknown, context: ExecutionContext): VerifiedIdentity => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.identity) throw new Error('Identity missing: route must be authenticated');
  return request.identity;
});

export const IdempotencyKeyHeader = createParamDecorator((_data: unknown, context: ExecutionContext): string | null => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim().length > 0 ? value.trim() : null;
});
