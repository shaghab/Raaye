import { Inject, Injectable } from '@nestjs/common';
import type { MessageRetry } from '@raaye/contracts';
import type { Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { SystemContext, TenantContext } from '../common/context';
import { DomainError, notFound } from '../common/errors';
import { JOB_PRIORITY, JobsService, type ClaimedJob } from '../jobs/jobs.service';
import { PermanentJobError, type JobHandler } from '../jobs/job-handler';
import { getLogger } from '../observability/logger';
import { isUniqueViolation } from '../persistence/db-errors';
import { asJson } from '../persistence/json';
import type { DeliveryState, MessageKind, TemplatePurpose } from '../persistence/prisma.service';
import { PrismaService } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';
import { MESSAGING_PROVIDER, type ProviderAdapter } from './provider';
import { isFreeForm, type RenderedMessage } from './rendered';
import { evaluateSendPolicy, type PolicyDecision } from './policy';
import type { NormalizedStatus } from './webhook-parser';

export interface CreateMessageInput {
  organizationId: string;
  connectionId: string;
  contactId: string;
  kind: MessageKind;
  rendered: RenderedMessage;
  dedupeKey: string;
  runId?: string | null;
  participationId?: string | null;
  snapshotId?: string | null;
  isTest?: boolean;
  priority?: number;
  dueAt?: Date;
}

/**
 * A failure report outranks the states that precede delivery (a message can be sent and then fail
 * to reach the recipient) and is itself outranked by delivery evidence, so callbacks that arrive
 * in any order settle on the same state.
 */
const DELIVERY_RANK: Record<string, number> = { QUEUED: 0, ACCEPTED: 1, SENT: 2, FAILED: 2.5, DELIVERED: 3, READ: 4 };

/** Delivery states that a callback of the given rank must never overwrite (unranked states such as UNKNOWN stay promotable). */
function statesRankedAtLeast(rank: number): DeliveryState[] {
  return Object.entries(DELIVERY_RANK)
    .filter(([, value]) => value >= rank)
    .map(([state]) => state as DeliveryState);
}
const MAX_SEND_ATTEMPTS = 5;
/** The hand-off transaction spans one provider call (15 s timeout in the Meta adapter) plus the outcome writes. */
const HANDOFF_TIMEOUT_MS = 60_000;

/**
 * One logical message per intended action with separate attempts and delivery evidence.
 * Sending runs through the policy gate; ambiguous outcomes stop automatic resends.
 */
@Injectable()
export class DeliveryService implements JobHandler {
  readonly kind = 'SEND_MESSAGE' as const;
  private readonly logger = getLogger('delivery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MESSAGING_PROVIDER) private readonly provider: ProviderAdapter,
  ) {}

  /** Persist the outgoing intent and its job in the caller's transaction. Idempotent on dedupe key. */
  async createMessage(tx: TenantTx, input: CreateMessageInput): Promise<{ id: string; created: boolean }> {
    const existing = await tx.message.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    if (existing) return { id: existing.id, created: false };
    try {
      const message = await tx.message.create({
        data: {
          organizationId: input.organizationId,
          connectionId: input.connectionId,
          contactId: input.contactId,
          runId: input.runId ?? null,
          participationId: input.participationId ?? null,
          snapshotId: input.snapshotId ?? null,
          dedupeKey: input.dedupeKey,
          kind: input.kind,
          rendered: asJson(input.rendered),
          isFreeForm: isFreeForm(input.rendered),
          isTest: input.isTest ?? false,
        },
      });
      await this.jobs.enqueue(tx, {
        organizationId: input.organizationId,
        kind: 'SEND_MESSAGE',
        entityId: message.id,
        dedupeKey: `send:${message.id}`,
        dueAt: input.dueAt ?? this.clock.now(),
        priority: input.priority ?? JOB_PRIORITY.reply,
        maxAttempts: MAX_SEND_ATTEMPTS,
      });
      return { id: message.id, created: true };
    } catch (error) {
      if (isUniqueViolation(error, 'dedupe')) {
        const again = await tx.message.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
        if (again) return { id: again.id, created: false };
      }
      throw error;
    }
  }

  async handle(job: ClaimedJob, ctx: SystemContext): Promise<void> {
    if (!job.entityId) return;
    const payload = (job.payload ?? {}) as { overrideUnknown?: boolean; authorizedByUserId?: string };
    await this.send(ctx.organizationId, job.entityId, { overrideUnknown: Boolean(payload.overrideUnknown), authorizedByUserId: payload.authorizedByUserId ?? null });
  }

  async send(organizationId: string, messageId: string, options: { overrideUnknown?: boolean; authorizedByUserId?: string | null } = {}): Promise<'ACCEPTED' | 'SUPPRESSED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED'> {
    const db = this.dbFactory.forOrganization(organizationId);
    const now = this.clock.now();
    const initial = await db.message.findUnique({ where: { id: messageId }, include: { attempts: true } });
    if (!initial) return 'SKIPPED';
    const inFlight = initial.attempts.find((attempt) => attempt.outcome === 'IN_FLIGHT');
    if (inFlight) {
      // A previous worker died while a send was in progress: the outcome is ambiguous.
      await db.$transaction(async (tx) => {
        await tx.messageAttempt.update({ where: { id: inFlight.id }, data: { outcome: 'UNKNOWN', finishedAt: now, errorCode: 'LEASE_LOST' } });
        await tx.message.update({ where: { id: initial.id }, data: { state: 'UNKNOWN', deliveryState: 'UNKNOWN', lastErrorCode: 'LEASE_LOST' } });
        await this.markOutcome(tx, initial.id, 'UNKNOWN', 'LEASE_LOST');
      });
      return 'UNKNOWN';
    }
    if (initial.state !== 'PENDING') return 'SKIPPED';
    const mode = this.provider.mode;
    const ctx: SystemContext = { organizationId, correlationId: messageId, actor: 'SYSTEM' };
    // Claim the message under the contact row lock. Consent decisions (STOP, staff withdrawal,
    // import attestation), archive, phone changes and the processing of an inbound message take the
    // same lock, so the policy is evaluated on state that no decision can invalidate before the
    // hand-off, and a message canceled meanwhile is never revived.
    const claim = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${initial.contactId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
      const message = await tx.message.findUnique({ where: { id: messageId }, include: { contact: true, connection: true, run: true, attempts: true, snapshot: { select: { revokedAt: true } } } });
      if (!message || message.state !== 'PENDING') return { outcome: 'SKIPPED' as const };
      const conversation = await tx.conversation.findUnique({ where: { organizationId_contactId: { organizationId, contactId: message.contactId } } });
      const rendered = message.rendered as RenderedMessage;
      const templatePurpose = this.templatePurposeFor(message.kind);
      const template = templatePurpose
        ? await tx.templateBinding.findFirst({ where: { connectionId: message.connectionId, purpose: templatePurpose, locale: rendered.type === 'template' ? rendered.language : 'en' } })
        : null;
      const flow = rendered.type === 'flow' ? await tx.flowBinding.findFirst({ where: { connectionId: message.connectionId, purpose: rendered.purpose } }) : null;
      const templateReady = mode === 'mock' ? true : template?.status === 'APPROVED';
      const flowReady = mode === 'mock' ? true : flow?.status === 'PUBLISHED' && Boolean(flow.providerFlowId);
      const decision = evaluateSendPolicy({
        now,
        providerMode: mode,
        kind: message.kind,
        isFreeForm: message.isFreeForm,
        isTest: message.isTest,
        connectionEnabled: message.connection.enabled,
        contact: message.contact,
        lastInboundAt: conversation?.lastInboundAt ?? null,
        run: message.run && message.kind !== 'OPT_OUT_ACK' ? { state: message.run.state, closesAt: message.run.closesAt } : null,
        templateReady,
        flowReady,
        needsFlow: rendered.type === 'flow',
        priorUnknownAttempts: options.overrideUnknown ? 0 : message.attempts.filter((attempt) => attempt.outcome === 'UNKNOWN').length,
        priorAcceptedAttempts: message.attempts.filter((attempt) => attempt.outcome === 'ACCEPTED').length,
        snapshotRevoked: Boolean(message.snapshot?.revokedAt),
      });
      if (!decision.allowed) {
        await tx.message.update({ where: { id: message.id }, data: { state: 'SUPPRESSED', deliveryState: 'SUPPRESSED', suppressionReason: decision.reason } });
        await this.markOutcome(tx, message.id, 'SUPPRESSED', decision.reason);
        await this.audit.record(ctx, { action: 'message.suppressed', resourceType: 'message', resourceId: message.id, metadata: { reason: decision.reason, kind: message.kind } }, tx);
        return { outcome: 'SUPPRESSED' as const, reason: decision.reason, kind: message.kind };
      }
      const claimed = await tx.message.updateMany({ where: { id: message.id, state: 'PENDING' }, data: { state: 'SENDING' } });
      if (claimed.count !== 1) return { outcome: 'SKIPPED' as const };
      const attemptNumber = message.attempts.length + 1;
      const attempt = await tx.messageAttempt.create({
        data: { organizationId, messageId: message.id, attemptNumber, startedAt: now, outcome: 'IN_FLIGHT', leaseOwner: this.jobs.workerId, authorizedByUserId: options.authorizedByUserId ?? null },
      });
      return { outcome: 'CLAIMED' as const, message, rendered, flow, attempt, attemptNumber, templateReady, flowReady };
    });
    if (claim.outcome === 'SKIPPED') return 'SKIPPED';
    if (claim.outcome === 'SUPPRESSED') {
      this.logger.info({ messageId, reason: claim.reason, kind: claim.kind }, 'Message suppressed by policy');
      return 'SUPPRESSED';
    }
    const { message, rendered, flow, attempt, attemptNumber, templateReady, flowReady } = claim;
    // Phase 2: hand the message to the provider while holding the contact row lock. A consent
    // decision waiting on that lock either committed before this transaction (the re-check below
    // suppresses the message) or runs after the provider has answered, when the message is already
    // out of our hands. The attempt committed in phase 1 keeps a crash during the call ambiguous.
    const handoff = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${message.contactId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
        // The lock may have been waited for: deadlines are judged on the clock as of this moment.
        const handoffAt = this.clock.now();
        const fresh = await tx.message.findUnique({ where: { id: message.id }, include: { contact: true, connection: true, run: true } });
        const conversation = await tx.conversation.findUnique({ where: { organizationId_contactId: { organizationId, contactId: message.contactId } } });
        // A results message leaves under a share lock on its snapshot: a revocation takes the
        // exclusive lock, so it either committed before this read (the message is refused here)
        // or waits until this hand-off has committed, when the notice is already out of our hands.
        const snapshotRevoked = message.snapshotId ? await this.snapshotRevokedUnderLock(tx, message.snapshotId) : false;
        const decision: PolicyDecision =
          !fresh || fresh.state !== 'SENDING'
            ? { allowed: false, reason: 'CANCELED_BEFORE_SEND' }
            : evaluateSendPolicy({
                now: handoffAt,
                providerMode: mode,
                kind: fresh.kind,
                isFreeForm: fresh.isFreeForm,
                isTest: fresh.isTest,
                connectionEnabled: fresh.connection.enabled,
                contact: fresh.contact,
                lastInboundAt: conversation?.lastInboundAt ?? null,
                run: fresh.run && fresh.kind !== 'OPT_OUT_ACK' ? { state: fresh.run.state, closesAt: fresh.run.closesAt } : null,
                templateReady,
                flowReady,
                needsFlow: rendered.type === 'flow',
                priorUnknownAttempts: 0,
                priorAcceptedAttempts: 0,
                snapshotRevoked,
              });
        if (!decision.allowed) {
          await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'FAILED', finishedAt: this.clock.now(), errorCode: decision.reason, retryable: false } });
          await tx.message.update({ where: { id: message.id }, data: { state: 'SUPPRESSED', deliveryState: 'SUPPRESSED', suppressionReason: decision.reason } });
          await this.markOutcome(tx, message.id, 'SUPPRESSED', decision.reason);
          await this.audit.record(ctx, { action: 'message.suppressed', resourceType: 'message', resourceId: message.id, metadata: { reason: decision.reason, kind: message.kind, attempt: attemptNumber } }, tx);
          return { outcome: 'SUPPRESSED' as const, reason: decision.reason };
        }
        const result = await this.provider.send({
          connection: { id: message.connection.id, phoneNumberId: message.connection.phoneNumberId, graphVersion: message.connection.graphVersion, appKey: message.connection.appKey, accessTokenRef: message.connection.accessTokenRef },
          to: message.contact.phoneE164.replace(/^\+/, ''),
          message: rendered,
          messageId: message.id,
          contactId: message.contactId,
          attemptNumber,
          isTest: message.isTest,
          flowId: flow?.providerFlowId ?? null,
        });
        const finishedAt = this.clock.now();
        if (result.outcome === 'ACCEPTED') {
          await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'ACCEPTED', finishedAt, providerMessageId: result.providerMessageId } });
          await tx.message.update({ where: { id: message.id }, data: { state: 'ACCEPTED', deliveryState: 'ACCEPTED', providerMessageId: result.providerMessageId, lastStatusAt: finishedAt } });
          await this.markOutcome(tx, message.id, 'ACCEPTED', null);
          await tx.conversation.upsert({
            where: { organizationId_contactId: { organizationId, contactId: message.contactId } },
            create: { organizationId, contactId: message.contactId, connectionId: message.connectionId },
            update: {},
          });
          await this.audit.record(ctx, { action: 'message.accepted', resourceType: 'message', resourceId: message.id, metadata: { kind: message.kind, attempt: attemptNumber } }, tx);
          return { outcome: 'ACCEPTED' as const, providerMessageId: result.providerMessageId, finishedAt };
        }
        if (result.outcome === 'UNKNOWN') {
          await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'UNKNOWN', finishedAt, errorCode: result.errorCode, errorDetail: result.detail ?? null } });
          await tx.message.update({ where: { id: message.id }, data: { state: 'UNKNOWN', deliveryState: 'UNKNOWN', lastErrorCode: result.errorCode } });
          await this.markOutcome(tx, message.id, 'UNKNOWN', result.errorCode);
          await this.audit.record(ctx, { action: 'message.outcome_unknown', resourceType: 'message', resourceId: message.id, metadata: { errorCode: result.errorCode, attempt: attemptNumber } }, tx);
          return { outcome: 'UNKNOWN' as const };
        }
        const finalFailure = !result.retryable || attemptNumber >= MAX_SEND_ATTEMPTS;
        await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'FAILED', finishedAt, errorCode: result.errorCode, errorDetail: result.detail ?? null, retryable: result.retryable } });
        await tx.message.update({
          where: { id: message.id },
          data: finalFailure ? { state: 'FAILED', deliveryState: 'FAILED', lastErrorCode: result.errorCode } : { state: 'PENDING', lastErrorCode: result.errorCode },
        });
        if (finalFailure) await this.markOutcome(tx, message.id, 'FAILED', result.errorCode);
        return { outcome: 'FAILED' as const, finalFailure, errorCode: result.errorCode, detail: result.detail ?? null };
      },
      { timeout: HANDOFF_TIMEOUT_MS, maxWait: 15_000 },
    );
    if (handoff.outcome === 'SUPPRESSED') {
      this.logger.info({ messageId, reason: handoff.reason, kind: message.kind }, 'Message suppressed by policy before hand-off');
      return 'SUPPRESSED';
    }
    if (handoff.outcome === 'ACCEPTED') {
      if (mode === 'mock') await this.mockAutoStatuses(organizationId, message.connectionId, handoff.providerMessageId, handoff.finishedAt);
      return 'ACCEPTED';
    }
    if (handoff.outcome === 'UNKNOWN') return 'UNKNOWN';
    if (handoff.finalFailure) throw new PermanentJobError(handoff.errorCode, handoff.detail ?? undefined);
    throw new DomainError('SEND_FAILED', handoff.detail ?? handoff.errorCode, { errorCode: handoff.errorCode }, undefined, 503);
  }

  /** Mock mode mirrors a realistic provider: accepted messages get sent/delivered callbacks. */
  private async mockAutoStatuses(organizationId: string, connectionId: string, providerMessageId: string, at: Date): Promise<void> {
    const state = await this.prisma.simulatorState.findUnique({ where: { id: 1 } });
    const faults = (state?.faults as { suppressAutoStatus?: boolean } | null) ?? {};
    if (faults.suppressAutoStatus) return;
    await this.recordStatus(organizationId, connectionId, { phoneNumberId: '', providerMessageId, recipientIdentity: null, status: 'SENT', providerAt: at, errorCode: null, errorTitle: null });
    await this.recordStatus(organizationId, connectionId, { phoneNumberId: '', providerMessageId, recipientIdentity: null, status: 'DELIVERED', providerAt: new Date(at.getTime() + 1000), errorCode: null, errorTitle: null });
  }

  /**
   * Append a provider status event and derive the display state without regression. The event
   * row and its projection (message delivery state, invitation state) commit together: a failed
   * projection rolls the event back, so the provider's retry of the same status is applied instead
   * of being dismissed as a duplicate.
   */
  async recordStatus(organizationId: string, connectionId: string, status: NormalizedStatus): Promise<'RECORDED' | 'DUPLICATE' | 'UNMATCHED'> {
    const db = this.dbFactory.forOrganization(organizationId);
    const message = await this.findByProviderMessageId(organizationId, connectionId, status.providerMessageId);
    try {
      await db.$transaction(async (tx) => {
        const now = this.clock.now();
        await tx.messageStatusEvent.create({
          data: {
            organizationId,
            connectionId,
            providerMessageId: status.providerMessageId,
            messageId: message?.id ?? null,
            status: status.status,
            providerAt: status.providerAt,
            receivedAt: now,
            errorCode: status.errorCode,
            errorTitle: status.errorTitle,
            reconciledAt: message ? now : null,
          },
        });
        if (message) await this.applyStatus(tx, message.id, status);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'DUPLICATE';
      throw error;
    }
    return message ? 'RECORDED' : 'UNMATCHED';
  }

  /**
   * Promote the display state without regression, inside the caller's transaction. The rank
   * comparison is part of the UPDATE's WHERE clause, so concurrent callbacks (a READ racing a
   * SENT) cannot overwrite a higher state.
   */
  async applyStatus(tx: TenantTx, messageId: string, status: NormalizedStatus): Promise<void> {
    const newRank = DELIVERY_RANK[status.status] ?? 0;
    if (status.status === 'FAILED') {
      const changed = await tx.message.updateMany({
        where: { id: messageId, deliveryState: { notIn: statesRankedAtLeast(newRank) } },
        data: { deliveryState: 'FAILED', lastErrorCode: status.errorCode ?? 'PROVIDER_FAILED', lastStatusAt: status.providerAt },
      });
      if (changed.count === 1) await this.markInvitation(tx, messageId, 'FAILED', status.errorCode ?? 'PROVIDER_FAILED');
      return;
    }
    // Delivery evidence that outranks an earlier failure report supersedes it, error code included:
    // the message and its invitation settle on the same state in one transaction, so a recipient is
    // never shown as delivered next to a provider error or counted as both delivered and failed,
    // whichever order the two callbacks were applied in. The status events keep the failure's history.
    const supersedesFailure = newRank > DELIVERY_RANK['FAILED'];
    const promoted = await tx.message.updateMany({
      where: { id: messageId, deliveryState: { notIn: statesRankedAtLeast(newRank) } },
      data: supersedesFailure
        ? { deliveryState: status.status as DeliveryState, lastStatusAt: status.providerAt, lastErrorCode: null }
        : { deliveryState: status.status as DeliveryState, lastStatusAt: status.providerAt },
    });
    if (promoted.count === 1 && supersedesFailure) {
      await tx.invitation.updateMany({ where: { messageId, state: 'FAILED' }, data: { state: 'ACCEPTED', stateReason: null } });
    }
  }

  /**
   * Match status events that arrived before their message row could be resolved. Linking the
   * event and applying it commit together, so an event is only marked reconciled once applied.
   */
  async reconcileUnmatched(organizationId: string, limit = 200): Promise<number> {
    const db = this.dbFactory.forOrganization(organizationId);
    const pending = await db.messageStatusEvent.findMany({ where: { messageId: null, reconciledAt: null }, orderBy: { receivedAt: 'asc' }, take: limit });
    let reconciled = 0;
    for (const event of pending) {
      const message = await this.findByProviderMessageId(organizationId, event.connectionId, event.providerMessageId);
      if (!message) continue;
      await db.$transaction(async (tx) => {
        const linked = await tx.messageStatusEvent.updateMany({ where: { id: event.id, reconciledAt: null }, data: { messageId: message.id, reconciledAt: this.clock.now() } });
        if (linked.count !== 1) return;
        await this.applyStatus(tx, message.id, { phoneNumberId: '', providerMessageId: event.providerMessageId, recipientIdentity: null, status: event.status, providerAt: event.providerAt, errorCode: event.errorCode, errorTitle: event.errorTitle });
        reconciled += 1;
      });
    }
    return reconciled;
  }

  private async findByProviderMessageId(organizationId: string, connectionId: string, providerMessageId: string): Promise<{ id: string } | null> {
    const db = this.dbFactory.forOrganization(organizationId);
    const direct = await db.message.findFirst({ where: { connectionId, providerMessageId }, select: { id: true } });
    if (direct) return direct;
    const attempt = await db.messageAttempt.findFirst({ where: { providerMessageId, message: { connectionId } }, select: { messageId: true } });
    return attempt ? { id: attempt.messageId } : null;
  }

  /** Admin-authorized retry after a known failure or an acknowledged ambiguous outcome. */
  async retry(ctx: TenantContext, messageId: string, input: MessageRetry): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const message = await db.message.findUnique({ where: { id: messageId }, include: { attempts: true } });
    if (!message) throw notFound('Message');
    if (message.state !== 'FAILED' && message.state !== 'UNKNOWN' && message.state !== 'SUPPRESSED') {
      throw new DomainError('SURVEY_STATE_INVALID', `Only failed, suppressed or unknown-outcome messages can be retried (current: ${message.state})`);
    }
    const hasUnknown = message.attempts.some((attempt) => attempt.outcome === 'UNKNOWN');
    if (hasUnknown && !input.acknowledgeDuplicateRisk) {
      throw new DomainError('SEND_OUTCOME_UNKNOWN', 'A previous attempt had an unknown outcome; acknowledge the duplicate-send risk to retry');
    }
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id: messageId }, data: { state: 'PENDING', deliveryState: 'QUEUED', suppressionReason: null } });
      await tx.invitation.updateMany({ where: { messageId }, data: { state: 'QUEUED', stateReason: 'RETRY_AUTHORIZED' } });
      await this.jobs.enqueue(tx, {
        organizationId: ctx.organizationId,
        kind: 'SEND_MESSAGE',
        entityId: messageId,
        dedupeKey: `send:${messageId}:retry:${message.attempts.length + 1}`,
        dueAt: this.clock.now(),
        priority: JOB_PRIORITY.reply,
        payload: { overrideUnknown: hasUnknown, authorizedByUserId: ctx.userId },
        maxAttempts: MAX_SEND_ATTEMPTS,
      });
      await this.audit.record(ctx, { action: 'message.retry_authorized', resourceType: 'message', resourceId: messageId, metadata: { acknowledgedDuplicateRisk: Boolean(input.acknowledgeDuplicateRisk), reason: input.reason ?? null, priorUnknown: hasUnknown } }, tx);
    });
  }

  private templatePurposeFor(kind: MessageKind): TemplatePurpose | null {
    if (kind === 'INVITATION') return 'SURVEY_INVITATION';
    if (kind === 'RESULTS_INVITATION') return 'RESULTS_AVAILABLE';
    return null;
  }

  private async snapshotRevokedUnderLock(tx: TenantTx, snapshotId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM result_snapshots WHERE id = ${snapshotId}::uuid FOR SHARE`;
    return Boolean(rows[0]?.revoked_at);
  }

  /** Reflect a send-time outcome on the invitation the message carries and on the result recipient reporting reads. */
  private async markOutcome(tx: TenantTx, messageId: string, state: 'ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED', reason: string | null): Promise<void> {
    await this.markInvitation(tx, messageId, state, reason);
    await this.markResultRecipient(tx, messageId, state, reason);
  }

  private async markInvitation(tx: TenantTx, messageId: string, state: 'ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED', reason: string | null): Promise<void> {
    await tx.invitation.updateMany({ where: { messageId }, data: { state, stateReason: reason } });
  }

  /**
   * Send-time outcomes only. An accepted send (a retry included) makes the recipient invited
   * again and a recipient who already viewed the results is never moved back. A delivery failure
   * the provider reports after acceptance is delivery evidence on the message; it does not take
   * the respondent's access to the shared results away, since the notice cannot be resent.
   */
  private async markResultRecipient(tx: TenantTx, messageId: string, state: 'ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED', reason: string | null): Promise<void> {
    if (state === 'ACCEPTED') {
      await tx.resultRecipient.updateMany({ where: { invitationMessageId: messageId, accessState: { in: ['PENDING', 'SUPPRESSED', 'FAILED', 'UNKNOWN'] } }, data: { accessState: 'INVITED', suppressionReason: null } });
    } else {
      await tx.resultRecipient.updateMany({ where: { invitationMessageId: messageId, accessState: { in: ['PENDING', 'INVITED'] } }, data: { accessState: state, suppressionReason: reason } });
    }
  }
}
