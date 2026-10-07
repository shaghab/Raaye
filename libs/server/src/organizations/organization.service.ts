import { Inject, Injectable } from '@nestjs/common';
import {
  LIMITS,
  type MemberDto,
  type MemberUpdate,
  type OrganizationDto,
  type OrganizationUpdate,
  type StaffInvitationAccept,
  type StaffInvitationCreate,
  type StaffInvitationDto,
  type StaffInvitationInspectDto,
} from '@raaye/contracts';
import { generateToken, hashToken, type Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { FirebaseAdminService, type VerifiedIdentity } from '../auth/token-verifier';
import { CLOCK } from '../clock/clock.service';
import { DomainError, notFound } from '../common/errors';
import { getLogger } from '../observability/logger';
import type { TenantContext } from '../common/context';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService, type Organization } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';

export function toOrganizationDto(org: Organization): OrganizationDto {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    defaultLocale: org.defaultLocale,
    privacyUrl: org.privacyUrl,
    supportContact: org.supportContact,
    participantNotice: org.participantNotice,
    participantNoticeVersion: org.participantNoticeVersion,
    profileOnboardingEnabled: org.profileOnboardingEnabled,
    defaultDurationSeconds: org.defaultDurationSeconds,
    defaultEditWindowSeconds: org.defaultEditWindowSeconds,
    livePolicyReviewedAt: org.livePolicyReviewedAt?.toISOString() ?? null,
    isDemo: org.isDemo,
  };
}

/** Advisory lock key that serializes every acceptance and reconciliation concerning one Firebase identity. */
function identityLockKey(firebaseUid: string): string {
  return `identity:${firebaseUid}`;
}

@Injectable()
export class OrganizationService {
  private readonly logger = getLogger('organizations');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    private readonly firebase: FirebaseAdminService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async get(ctx: TenantContext): Promise<OrganizationDto> {
    const org = await this.dbFactory.for(ctx).organization.findUnique({ where: { id: ctx.organizationId } });
    if (!org) throw notFound('Organization');
    return toOrganizationDto(org);
  }

  async update(ctx: TenantContext, input: OrganizationUpdate): Promise<OrganizationDto> {
    const db = this.dbFactory.for(ctx);
    const { livePolicyReviewed, ...fields } = input;
    const updated = await db.$transaction(async (tx) => {
      // The organization row lock serializes concurrent settings saves, so every notice text change
      // receives its own version and a version always identifies exactly one wording.
      await this.lockOrganization(tx, ctx.organizationId);
      const current = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      if (!current) throw notFound('Organization');
      const noticeChanged = input.participantNotice !== undefined && input.participantNotice !== current.participantNotice;
      const row = await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          ...fields,
          participantNoticeVersion: noticeChanged ? { increment: 1 } : undefined,
          livePolicyReviewedAt: livePolicyReviewed === undefined ? undefined : livePolicyReviewed ? this.clock.now() : null,
          livePolicyReviewedById: livePolicyReviewed === undefined ? undefined : livePolicyReviewed ? ctx.userId : null,
        },
      });
      await this.audit.record(ctx, { action: 'organization.updated', resourceType: 'organization', resourceId: ctx.organizationId, metadata: { fields: Object.keys(input), noticeVersion: row.participantNoticeVersion } }, tx);
      return row;
    });
    return toOrganizationDto(updated);
  }

  async listMembers(ctx: TenantContext): Promise<MemberDto[]> {
    const memberships = await this.dbFactory.for(ctx).organizationMembership.findMany({
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      displayName: membership.user.displayName,
      role: membership.role,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
    }));
  }

  async updateMember(ctx: TenantContext, membershipId: string, input: MemberUpdate): Promise<MemberDto> {
    const db = this.dbFactory.for(ctx);
    const { updated, previousRole } = await db.$transaction(async (tx) => {
      await this.lockOrganization(tx, ctx.organizationId);
      const membership = await tx.organizationMembership.findUnique({ where: { id: membershipId } });
      if (!membership || membership.status !== 'ACTIVE') throw notFound('Member');
      if (membership.role === 'ADMIN' && input.role !== 'ADMIN') await this.assertNotLastAdmin(tx, membershipId);
      const row = await tx.organizationMembership.update({ where: { id: membershipId }, data: { role: input.role }, include: { user: true } });
      return { updated: row, previousRole: membership.role };
    });
    await this.audit.record(ctx, {
      action: 'member.role_changed',
      resourceType: 'membership',
      resourceId: membershipId,
      metadata: { from: previousRole, to: input.role },
    });
    return {
      id: updated.id,
      userId: updated.userId,
      email: updated.user.email,
      displayName: updated.user.displayName,
      role: updated.role,
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async revokeMember(ctx: TenantContext, membershipId: string): Promise<void> {
    const db = this.dbFactory.for(ctx);
    await db.$transaction(async (tx) => {
      await this.lockOrganization(tx, ctx.organizationId);
      const membership = await tx.organizationMembership.findUnique({ where: { id: membershipId } });
      if (!membership || membership.status !== 'ACTIVE') throw notFound('Member');
      if (membership.role === 'ADMIN') await this.assertNotLastAdmin(tx, membershipId);
      await tx.organizationMembership.update({
        where: { id: membershipId },
        data: { status: 'REVOKED', revokedAt: this.clock.now() },
      });
    });
    await this.audit.record(ctx, { action: 'member.revoked', resourceType: 'membership', resourceId: membershipId });
  }

  /**
   * Row lock on the organization so concurrent Admin downgrades/revocations serialize: the
   * last-Admin check and the mutation run under the same lock and cannot interleave.
   */
  private async lockOrganization(tx: TenantTx, organizationId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
  }

  private async assertNotLastAdmin(tx: TenantTx, membershipId: string): Promise<void> {
    const otherAdmins = await tx.organizationMembership.count({
      where: { role: 'ADMIN', status: 'ACTIVE', id: { not: membershipId } },
    });
    if (otherAdmins === 0) {
      throw new DomainError('LAST_ADMIN_PROTECTED', 'The last active Admin cannot be removed or downgraded');
    }
  }

  async createInvitation(ctx: TenantContext, input: StaffInvitationCreate): Promise<StaffInvitationDto> {
    const db = this.dbFactory.for(ctx);
    const existingMember = await db.organizationMembership.findFirst({
      where: { status: 'ACTIVE', user: { email: input.email } },
    });
    if (existingMember) throw new DomainError('VALIDATION_FAILED', 'This email already belongs to an active member');
    const token = generateToken(32);
    const now = this.clock.now();
    const invitation = await db.staffInvitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + LIMITS.staffInvitationHours * 3600 * 1000),
        invitedByUserId: ctx.userId,
      },
    });
    await this.audit.record(ctx, {
      action: 'staff_invitation.created',
      resourceType: 'staff_invitation',
      resourceId: invitation.id,
      metadata: { role: input.role },
    });
    const acceptUrl = `${this.config.WEB_ORIGIN}/accept-invitation?token=${encodeURIComponent(token)}`;
    return { ...this.toInvitationDto(invitation), acceptUrl };
  }

  async listInvitations(ctx: TenantContext): Promise<StaffInvitationDto[]> {
    const invitations = await this.dbFactory.for(ctx).staffInvitation.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return invitations.map((invitation) => this.toInvitationDto(invitation));
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const invitation = await db.staffInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw notFound('Invitation');
    if (invitation.acceptedAt) throw new DomainError('INVITATION_INVALID', 'This invitation was already accepted');
    await db.staffInvitation.update({ where: { id: invitationId }, data: { revokedAt: this.clock.now() } });
    await this.audit.record(ctx, { action: 'staff_invitation.revoked', resourceType: 'staff_invitation', resourceId: invitationId });
  }

  /** Public inspection by token: reveals only what the invitee needs to proceed. */
  async inspectInvitation(token: string): Promise<StaffInvitationInspectDto> {
    const invitation = await this.loadValidInvitation(token);
    const organization = await this.prisma.organization.findUnique({ where: { id: invitation.organizationId } });
    const existing = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    return {
      email: invitation.email,
      role: invitation.role,
      organizationName: organization?.name ?? '',
      expiresAt: invitation.expiresAt.toISOString(),
      existingAccount: Boolean(existing) || Boolean(await this.firebase.findUidByEmail(invitation.email)),
    };
  }

  /**
   * Accept an invitation. For a new account the API creates the Firebase user with the
   * password the invitee chose (never visible to Admin). For an existing account the
   * verified Firebase identity must carry the invited email. Role and organization come
   * from the invitation record only; the token is consumed transactionally.
   */
  async acceptInvitation(input: StaffInvitationAccept, identity: VerifiedIdentity | null, correlationId: string): Promise<{ email: string }> {
    const invitation = await this.loadValidInvitation(input.token);
    const email = invitation.email;
    let firebaseUid: string;
    let createdUid: string | null = null;
    if (identity) {
      if (identity.email !== email) throw new DomainError('INVITATION_EMAIL_MISMATCH', 'Sign in with the invited email address');
      firebaseUid = identity.uid;
    } else {
      const existingUid = await this.firebase.findUidByEmail(email);
      if (existingUid) throw new DomainError('INVITATION_INVALID', 'An account already exists for this email; sign in first, then accept the invitation');
      if (!input.password) throw new DomainError('VALIDATION_FAILED', 'Choose a password to create your account', undefined, [{ path: 'password', message: 'Required' }]);
      firebaseUid = await this.firebase.createUser(email, input.password, input.displayName);
      createdUid = firebaseUid;
    }
    try {
      await this.consumeInvitation(invitation, firebaseUid, input.displayName, correlationId);
    } catch (error) {
      if (!createdUid) throw error;
      // The account was provisioned for this acceptance. It is removed again only when the acceptance
      // rolled back and nothing else references the identity, so that no orphan credentials remain. A
      // failure may hide a commit whose acknowledgement was lost, and the identity may already carry a
      // membership from another acceptance, so the database decides: a persisted acceptance is a success,
      // and an unconfirmed or referenced state keeps the account rather than stranding a membership.
      const outcome = await this.acceptanceOutcome(invitation.id, createdUid);
      if (outcome === 'persisted') {
        this.logger.warn({ invitationId: invitation.id }, 'Invitation acceptance was persisted although its transaction reported an error');
        return { email };
      }
      if (outcome === 'rolled-back') {
        await this.firebase.deleteUser(createdUid).catch((cleanupError: unknown) => {
          this.logger.warn({ invitationId: invitation.id, err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }, 'Could not remove the account created for a failed invitation acceptance');
        });
      } else {
        this.logger.warn({ invitationId: invitation.id }, 'The invitation acceptance could not be confirmed as rolled back, or its identity is referenced elsewhere; the created account is left in place');
      }
      throw error;
    }
    return { email };
  }

  /**
   * What became of the acceptance transaction, decided by the authoritative rows: 'persisted' when the
   * created identity is the invitation's accepter (a commit whose acknowledgement was lost), 'rolled-back'
   * only when nothing references the identity, and 'unknown' otherwise, including when another
   * acceptance of the same person (the identity is usable as soon as it exists) has stored a user row
   * for it, or when the database cannot be read. The rows are read only after the identity lock has
   * waited for any other acceptance of the same person and a lock on the invitation row has waited for
   * the failed transaction to finish resolving; a domain refusal raised inside the callback never
   * committed, but the identity is still checked for other references before deletion.
   */
  private async acceptanceOutcome(invitationId: string, firebaseUid: string): Promise<'rolled-back' | 'persisted' | 'unknown'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identityLockKey(firebaseUid)}))`;
        await tx.$queryRaw`SELECT id FROM staff_invitations WHERE id = ${invitationId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { firebaseUid }, select: { id: true } });
        if (!user) return 'rolled-back' as const;
        const invitation = await tx.staffInvitation.findUnique({ where: { id: invitationId }, select: { acceptedByUserId: true } });
        return invitation?.acceptedByUserId === user.id ? ('persisted' as const) : ('unknown' as const);
      });
    } catch {
      return 'unknown';
    }
  }

  private async consumeInvitation(invitation: { id: string; organizationId: string; email: string; role: 'ADMIN' | 'SURVEY_MANAGER' | 'VIEWER' }, firebaseUid: string, displayName: string | undefined, correlationId: string): Promise<void> {
    const email = invitation.email;
    await this.prisma.$transaction(async (tx) => {
      // Every acceptance and reconciliation that concerns one identity serializes on this lock, taken
      // first: an acceptance of another invitation by the same person, even while it still waits for its
      // organization lock, is therefore visible to a reconciliation before an identity can be deleted.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identityLockKey(firebaseUid)}))`;
      // The organization row lock serializes acceptance with bootstrap re-runs and member administration:
      // a re-run's active-Admin count and the membership created here cannot interleave, and both paths
      // take the organization lock before touching invitations, so they never deadlock on each other.
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${invitation.organizationId}::uuid FOR UPDATE`;
      // The deadline is judged on a clock reading taken after the lock wait, so an invitation that expired
      // while this request waited is refused and `acceptedAt` never predates the wait.
      const now = this.clock.now();
      const consumed = await tx.staffInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (consumed.count !== 1) throw new DomainError('INVITATION_INVALID', 'This invitation is no longer valid');
      const user = await tx.user.upsert({
        where: { firebaseUid },
        create: { firebaseUid, email, displayName: displayName ?? null },
        update: { email, displayName: displayName ?? undefined },
      });
      await tx.staffInvitation.update({ where: { id: invitation.id }, data: { acceptedByUserId: user.id } });
      await tx.organizationMembership.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } },
        create: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role, status: 'ACTIVE' },
        update: { role: invitation.role, status: 'ACTIVE', revokedAt: null },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: invitation.organizationId,
          actorType: 'USER',
          actorUserId: user.id,
          action: 'staff_invitation.accepted',
          resourceType: 'staff_invitation',
          resourceId: invitation.id,
          metadata: { role: invitation.role },
          correlationId,
        },
      });
    });
  }

  private async loadValidInvitation(token: string) {
    const invitation = await this.prisma.staffInvitation.findUnique({ where: { tokenHash: hashToken(token) } });
    const now = this.clock.now();
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
      throw new DomainError('INVITATION_INVALID', 'This invitation link is invalid, expired or already used');
    }
    return invitation;
  }

  private toInvitationDto(invitation: {
    id: string;
    email: string;
    role: 'ADMIN' | 'SURVEY_MANAGER' | 'VIEWER';
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }): StaffInvitationDto {
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      revokedAt: invitation.revokedAt?.toISOString() ?? null,
      createdAt: invitation.createdAt.toISOString(),
    };
  }
}
