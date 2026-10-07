import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@raaye/contracts';
import { DomainError } from '../common/errors';
import { AuthService } from './auth.service';
import { IDENTITY_ONLY_KEY, PUBLIC_KEY, ROLES_KEY, type AuthenticatedRequest } from './decorators';

/**
 * Global guard: verifies the bearer token, resolves the active membership and enforces
 * the role matrix. Membership revocation takes effect on the next request because the
 * membership row is read on every call.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue');
    const token = value.slice('Bearer '.length).trim();
    const { identity, tenant } = await this.auth.authenticate(token, request.correlationId);
    request.identity = identity;
    if (this.reflector.getAllAndOverride<boolean>(IDENTITY_ONLY_KEY, targets)) return true;
    if (!tenant) throw new DomainError('MEMBERSHIP_REQUIRED', 'Your account is not a member of an organization');
    request.tenant = tenant;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && roles.length > 0 && !roles.includes(tenant.role)) {
      throw new DomainError('ROLE_FORBIDDEN', 'This action is not permitted for your role');
    }
    return true;
  }
}
