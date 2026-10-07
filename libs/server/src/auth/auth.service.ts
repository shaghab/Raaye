import { Inject, Injectable } from '@nestjs/common';
import type { MeDto } from '@raaye/contracts';
import { DomainError } from '../common/errors';
import type { TenantContext } from '../common/context';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../persistence/prisma.service';
import { TOKEN_VERIFIER, type TokenVerifier, type VerifiedIdentity } from './token-verifier';

/**
 * Control-plane helper: maps a verified identity to its single active membership.
 * This is one of the few documented places that query without a tenant scope.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(idToken: string, correlationId: string): Promise<{ identity: VerifiedIdentity; tenant: TenantContext | null }> {
    const identity = await this.verifier.verify(idToken);
    const tenant = await this.resolveTenant(identity, correlationId);
    return { identity, tenant };
  }

  async resolveTenant(identity: VerifiedIdentity, correlationId: string): Promise<TenantContext | null> {
    const user = await this.prisma.user.findUnique({ where: { firebaseUid: identity.uid } });
    if (!user || user.state !== 'ACTIVE') return null;
    const membership = await this.prisma.organizationMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) return null;
    return {
      organizationId: membership.organizationId,
      userId: user.id,
      membershipId: membership.id,
      role: membership.role,
      email: user.email,
      correlationId,
    };
  }

  async me(ctx: TenantContext): Promise<MeDto> {
    const [user, organization] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ctx.userId } }),
      this.prisma.organization.findUnique({ where: { id: ctx.organizationId } }),
    ]);
    if (!user || !organization) throw new DomainError('MEMBERSHIP_REQUIRED', 'No active membership');
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      organization: { id: organization.id, name: organization.name, slug: organization.slug, timezone: organization.timezone },
      role: ctx.role,
      membershipId: ctx.membershipId,
      features: {
        messagingMode: this.config.MESSAGING_MODE,
        simulatorEnabled: this.config.simulatorEnabled,
        appEnv: this.config.APP_ENV,
      },
    };
  }
}
