import { Inject, Injectable } from '@nestjs/common';
import type { ConsentEventCreate, ConsentEventDto, ConsentScope } from '@raaye/contracts';
import { deriveConsent, grantRestoresPermission, type Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { OrgContext, TenantContext } from '../common/context';
import { isStaff } from '../common/context';
import { DomainError, notFound } from '../common/errors';
import { PrismaService } from '../persistence/prisma.service';
import type { ConsentSource } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';
import { cancelPendingOutreach } from './outreach-cancellation';

export interface ConsentEventInput {
  scope: ConsentScope;
  type: 'GRANTED' | 'WITHDRAWN' | 'RESET';
  source: ConsentSource;
  evidenceAt: Date;
  wordingVersion?: string | null;
  evidenceReference?: string | null;
  actorUserId?: string | null;
  importBatchId?: string | null;
  note?: string | null;
}

/**
 * Append-only consent history with an effective-status cache on the contact row.
 * Every decision runs under a row lock on the contact, so validation, event insertion and
 * the recomputation of the cache from the full history serialize with concurrent decisions.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async listEvents(ctx: TenantContext, contactId: string): Promise<ConsentEventDto[]> {
    const db = this.dbFactory.for(ctx);
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true } });
    if (!contact) throw notFound('Contact');
    const events = await db.consentEvent.findMany({
      where: { contactId },
      orderBy: [{ evidenceAt: 'desc' }, { recordedAt: 'desc' }],
    });
    const actorIds = Array.from(new Set(events.map((event) => event.actorUserId).filter((id): id is string => Boolean(id))));
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
    const emails = new Map(users.map((user) => [user.id, user.email]));
    return events.map((event) => ({
      id: event.id,
      scope: event.scope,
      type: event.type,
      source: event.source,
      evidenceAt: event.evidenceAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
      wordingVersion: event.wordingVersion,
      evidenceReference: event.evidenceReference,
      actorUserId: event.actorUserId,
      actorEmail: event.actorUserId ? (emails.get(event.actorUserId) ?? null) : null,
      note: event.note,
    }));
  }

  /** Staff-recorded grant or withdrawal with explicit evidence. */
  async recordStaffEvent(ctx: TenantContext, contactId: string, input: ConsentEventCreate): Promise<ConsentEventDto[]> {
    const db = this.dbFactory.for(ctx);
    const now = this.clock.now();
    const evidenceAt = new Date(input.evidenceAt);
    if (evidenceAt.getTime() > now.getTime() + 60_000) {
      throw new DomainError('VALIDATION_FAILED', 'Evidence time cannot be in the future', undefined, [{ path: 'evidenceAt', message: 'In the future' }]);
    }
    await db.$transaction(async (tx) => {
      await this.lockContact(tx, contactId);
      if (input.type === 'GRANTED') {
        for (const scope of input.scopes) {
          const current = deriveConsent(await this.loadEvents(tx, contactId), scope);
          if (current.status === 'WITHDRAWN') {
            if (!input.reviewedNewEvidence) {
              throw new DomainError(
                'VALIDATION_FAILED',
                'This contact withdrew permission. Re-granting requires explicitly reviewed new evidence dated after the withdrawal.',
                { scope },
                [{ path: 'reviewedNewEvidence', message: 'Confirm that you reviewed new opt-in evidence' }],
              );
            }
            if (!grantRestoresPermission(current, evidenceAt)) {
              throw new DomainError('VALIDATION_FAILED', 'The new evidence must be dated after the withdrawal', { scope }, [
                { path: 'evidenceAt', message: 'Must be after the withdrawal' },
              ]);
            }
          }
        }
      }
      await this.applyEvents(
        tx,
        contactId,
        input.scopes.map((scope) => ({
          scope,
          type: input.type,
          source: input.type === 'WITHDRAWN' ? 'STAFF_OPT_OUT' : 'STAFF_RECORDED',
          evidenceAt,
          wordingVersion: input.wordingVersion ?? null,
          evidenceReference: input.evidenceReference,
          actorUserId: ctx.userId,
          note: input.note ?? null,
        })),
      );
      // Only the withdrawn scopes lose their queued outreach: results permission alone keeps result notices.
      if (input.type === 'WITHDRAWN') await cancelPendingOutreach(tx, contactId, 'CONTACT_WITHDRAWN', now, input.scopes);
      await this.audit.record(
        ctx,
        {
          action: input.type === 'GRANTED' ? 'consent.granted' : 'consent.withdrawn',
          resourceType: 'contact',
          resourceId: contactId,
          metadata: { scopes: input.scopes, source: 'staff', reviewedNewEvidence: Boolean(input.reviewedNewEvidence) },
        },
        tx,
      );
    });
    return this.listEvents(ctx, contactId);
  }

  /** Participant STOP / staff opt-out: withdraw both scopes and stop queued outreach. */
  async withdrawAll(ctx: OrgContext, contactId: string, source: ConsentSource, evidenceAt: Date, reference: string | null, tx?: TenantTx): Promise<void> {
    const run = async (client: TenantTx) => {
      await this.applyEvents(
        client,
        contactId,
        (['SURVEY_INVITATIONS', 'SURVEY_RESULTS'] as const).map((scope) => ({
          scope,
          type: 'WITHDRAWN' as const,
          source,
          evidenceAt,
          evidenceReference: reference,
          actorUserId: isStaff(ctx) ? ctx.userId : null,
        })),
      );
      await cancelPendingOutreach(client, contactId, 'CONTACT_WITHDRAWN', this.clock.now());
      await this.audit.record(ctx, { action: 'consent.withdrawn', resourceType: 'contact', resourceId: contactId, metadata: { source } }, client);
    };
    if (tx) await run(tx);
    else await this.dbFactory.for(ctx).$transaction(run);
  }

  /** Participant affirmative reply to the current notice grants both scopes. */
  async grantFromParticipant(tx: TenantTx, contactId: string, evidenceAt: Date, wordingVersion: string, reference: string): Promise<void> {
    await this.applyEvents(
      tx,
      contactId,
      (['SURVEY_INVITATIONS', 'SURVEY_RESULTS'] as const).map((scope) => ({
        scope,
        type: 'GRANTED' as const,
        source: 'PARTICIPANT_REPLY' as const,
        evidenceAt,
        wordingVersion,
        evidenceReference: reference,
      })),
    );
  }

  /** Insert events and recompute the effective status cache for the contact. */
  async applyEvents(tx: TenantTx, contactId: string, events: ConsentEventInput[]): Promise<void> {
    if (events.length === 0) return;
    const organizationId = await this.lockContact(tx, contactId);
    await tx.consentEvent.createMany({
      data: events.map((event) => ({
        organizationId,
        contactId,
        scope: event.scope,
        type: event.type,
        source: event.source,
        evidenceAt: event.evidenceAt,
        recordedAt: this.clock.now(),
        wordingVersion: event.wordingVersion ?? null,
        evidenceReference: event.evidenceReference ?? null,
        actorUserId: event.actorUserId ?? null,
        importBatchId: event.importBatchId ?? null,
        note: event.note ?? null,
      })),
    });
    await this.recompute(tx, contactId);
  }

  async recompute(tx: TenantTx, contactId: string): Promise<void> {
    const events = await this.loadEvents(tx, contactId);
    const invitations = deriveConsent(events, 'SURVEY_INVITATIONS');
    const results = deriveConsent(events, 'SURVEY_RESULTS');
    await tx.contact.update({
      where: { id: contactId },
      data: {
        consentInvitations: invitations.status,
        consentInvitationsAt: invitations.evidenceAt,
        consentResults: results.status,
        consentResultsAt: results.evidenceAt,
      },
    });
  }

  private async loadEvents(tx: TenantTx, contactId: string) {
    return tx.consentEvent.findMany({ where: { contactId }, select: { scope: true, type: true, evidenceAt: true, recordedAt: true }, orderBy: [{ evidenceAt: 'asc' }, { recordedAt: 'asc' }] });
  }

  /**
   * Row lock on the contact so concurrent consent decisions serialize (a STOP racing a staff
   * grant or an import attestation). The tenant-scoped read proves the contact belongs to the
   * organization before the raw lock statement runs; the lock is held until the transaction ends.
   */
  private async lockContact(tx: TenantTx, contactId: string): Promise<string> {
    const contact = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, organizationId: true } });
    if (!contact) throw notFound('Contact');
    await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${contact.id}::uuid AND organization_id = ${contact.organizationId}::uuid FOR UPDATE`;
    return contact.organizationId;
  }
}
