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
import { evaluateSendPolicy } from './policy';
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

const DELIVERY_RANK: Record<string, number> = { QUEUED: 0, ACCEPTED: 1, SENT: 2, DELIVERED: 3, READ: 4 };
const MAX_SEND_ATTEMPTS = 5;

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
    const message = await db.message.findUnique({ where: { id: messageId }, include: { contact: true, connection: true, run: true, attempts: true } });
    if (!message) return 'SKIPPED';
    const inFlight = message.attempts.find((attempt) => attempt.outcome === 'IN_FLIGHT');
    if (inFlight) {
      // A previous worker died while a send was in progress: the outcome is ambiguous.
      await db.$transaction(async (tx) => {
        await tx.messageAttempt.update({ where: { id: inFlight.id }, data: { outcome: 'UNKNOWN', finishedAt: now, errorCode: 'LEASE_LOST' } });
        await tx.message.update({ where: { id: message.id }, data: { state: 'UNKNOWN', deliveryState: 'UNKNOWN', lastErrorCode: 'LEASE_LOST' } });
        await this.markInvitation(tx, message.id, 'UNKNOWN', 'LEASE_LOST');
      });
      return 'UNKNOWN';
    }
    if (message.state !== 'PENDING') return 'SKIPPED';
    const conversation = await db.conversation.findUnique({ where: { organizationId_contactId: { organizationId, contactId: message.contactId } } });
    const rendered = message.rendered as RenderedMessage;
    const mode = this.provider.mode;
    const templatePurpose = this.templatePurposeFor(message.kind);
    const template = templatePurpose
      ? await db.templateBinding.findFirst({ where: { connectionId: message.connectionId, purpose: templatePurpose, locale: rendered.type === 'template' ? rendered.language : 'en' } })
      : null;
    const flow = rendered.type === 'flow' ? await db.flowBinding.findFirst({ where: { connectionId: message.connectionId, purpose: rendered.purpose } }) : null;
    const decision = evaluateSendPolicy({
      now,
      providerMode: mode,
      kind: message.kind,
      isFreeForm: message.isFreeForm,
      isTest: message.isTest,
      contact: message.contact,
      lastInboundAt: conversation?.lastInboundAt ?? null,
      run: message.run && message.kind !== 'OPT_OUT_ACK' ? { state: message.run.state, closesAt: message.run.closesAt } : null,
      templateReady: mode === 'mock' ? true : template?.status === 'APPROVED',
      flowReady: mode === 'mock' ? true : flow?.status === 'PUBLISHED' && Boolean(flow.providerFlowId),
      needsFlow: rendered.type === 'flow',
      priorUnknownAttempts: options.overrideUnknown ? 0 : message.attempts.filter((attempt) => attempt.outcome === 'UNKNOWN').length,
      priorAcceptedAttempts: message.attempts.filter((attempt) => attempt.outcome === 'ACCEPTED').length,
    });
    const ctx: SystemContext = { organizationId, correlationId: messageId, actor: 'SYSTEM' };
    if (!decision.allowed) {
      await db.$transaction(async (tx) => {
        await tx.message.update({ where: { id: message.id }, data: { state: 'SUPPRESSED', deliveryState: 'SUPPRESSED', suppressionReason: decision.reason } });
        await this.markInvitation(tx, message.id, 'SUPPRESSED', decision.reason);
        await this.audit.record(ctx, { action: 'message.suppressed', resourceType: 'message', resourceId: message.id, metadata: { reason: decision.reason, kind: message.kind } }, tx);
      });
      this.logger.info({ messageId: message.id, reason: decision.reason, kind: message.kind }, 'Message suppressed by policy');
      return 'SUPPRESSED';
    }
    const attemptNumber = message.attempts.length + 1;
    const attempt = await db.$transaction(async (tx) => {
      const created = await tx.messageAttempt.create({
        data: { organizationId, messageId: message.id, attemptNumber, startedAt: now, outcome: 'IN_FLIGHT', leaseOwner: this.jobs.workerId, authorizedByUserId: options.authorizedByUserId ?? null },
      });
      await tx.message.update({ where: { id: message.id }, data: { state: 'SENDING' } });
      return created;
    });
    const result = await this.provider.send({
      connection: { id: message.connection.id, phoneNumberId: message.connection.phoneNumberId, graphVersion: message.connection.graphVersion, appKey: message.connection.appKey },
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
      await db.$transaction(async (tx) => {
        await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'ACCEPTED', finishedAt, providerMessageId: result.providerMessageId } });
        await tx.message.update({ where: { id: message.id }, data: { state: 'ACCEPTED', deliveryState: 'ACCEPTED', providerMessageId: result.providerMessageId, lastStatusAt: finishedAt } });
        await this.markInvitation(tx, message.id, 'ACCEPTED', null);
        await tx.conversation.upsert({
          where: { organizationId_contactId: { organizationId, contactId: message.contactId } },
          create: { organizationId, contactId: message.contactId, connectionId: message.connectionId },
          update: {},
        });
        await this.audit.record(ctx, { action: 'message.accepted', resourceType: 'message', resourceId: message.id, metadata: { kind: message.kind, attempt: attemptNumber } }, tx);
      });
      if (mode === 'mock') await this.mockAutoStatuses(organizationId, message.connectionId, result.providerMessageId, finishedAt);
      return 'ACCEPTED';
    }
    if (result.outcome === 'UNKNOWN') {
      await db.$transaction(async (tx) => {
        await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'UNKNOWN', finishedAt, errorCode: result.errorCode, errorDetail: result.detail ?? null } });
        await tx.message.update({ where: { id: message.id }, data: { state: 'UNKNOWN', deliveryState: 'UNKNOWN', lastErrorCode: result.errorCode } });
        await this.markInvitation(tx, message.id, 'UNKNOWN', result.errorCode);
        await this.audit.record(ctx, { action: 'message.outcome_unknown', resourceType: 'message', resourceId: message.id, metadata: { errorCode: result.errorCode, attempt: attemptNumber } }, tx);
      });
      return 'UNKNOWN';
    }
    const exhausted = attemptNumber >= MAX_SEND_ATTEMPTS;
    const finalFailure = !result.retryable || exhausted;
    await db.$transaction(async (tx) => {
      await tx.messageAttempt.update({ where: { id: attempt.id }, data: { outcome: 'FAILED', finishedAt, errorCode: result.errorCode, errorDetail: result.detail ?? null, retryable: result.retryable } });
      await tx.message.update({
        where: { id: message.id },
        data: finalFailure ? { state: 'FAILED', deliveryState: 'FAILED', lastErrorCode: result.errorCode } : { state: 'PENDING', lastErrorCode: result.errorCode },
      });
      if (finalFailure) await this.markInvitation(tx, message.id, 'FAILED', result.errorCode);
    });
    if (finalFailure) throw new PermanentJobError(result.errorCode, result.detail);
    throw new DomainError('SEND_FAILED', result.detail ?? result.errorCode, { errorCode: result.errorCode }, undefined, 503);
  }

  /** Mock mode mirrors a realistic provider: accepted messages get sent/delivered callbacks. */
  private async mockAutoStatuses(organizationId: string, connectionId: string, providerMessageId: string, at: Date): Promise<void> {
    const state = await this.prisma.simulatorState.findUnique({ where: { id: 1 } });
    const faults = (state?.faults as { suppressAutoStatus?: boolean } | null) ?? {};
    if (faults.suppressAutoStatus) return;
    await this.recordStatus(organizationId, connectionId, { phoneNumberId: '', providerMessageId, recipientIdentity: null, status: 'SENT', providerAt: at, errorCode: null, errorTitle: null });
    await this.recordStatus(organizationId, connectionId, { phoneNumberId: '', providerMessageId, recipientIdentity: null, status: 'DELIVERED', providerAt: new Date(at.getTime() + 1000), errorCode: null, errorTitle: null });
  }

  /** Append a provider status event and derive the display state without regression. */
  async recordStatus(organizationId: string, connectionId: string, status: NormalizedStatus): Promise<'RECORDED' | 'DUPLICATE' | 'UNMATCHED'> {
    const db = this.dbFactory.forOrganization(organizationId);
    const message = await this.findByProviderMessageId(organizationId, connectionId, status.providerMessageId);
    try {
      await db.messageStatusEvent.create({
        data: {
          organizationId,
          connectionId,
          providerMessageId: status.providerMessageId,
          messageId: message?.id ?? null,
          status: status.status,
          providerAt: status.providerAt,
          receivedAt: this.clock.now(),
          errorCode: status.errorCode,
          errorTitle: status.errorTitle,
          reconciledAt: message ? this.clock.now() : null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'DUPLICATE';
      throw error;
    }
    if (!message) return 'UNMATCHED';
    await this.applyStatus(organizationId, message.id, status);
    return 'RECORDED';
  }

  private async applyStatus(organizationId: string, messageId: string, status: NormalizedStatus): Promise<void> {
    const db = this.dbFactory.forOrganization(organizationId);
    const message = await db.message.findUnique({ where: { id: messageId }, select: { deliveryState: true, lastStatusAt: true } });
    if (!message) return;
    const currentRank = DELIVERY_RANK[message.deliveryState] ?? -1;
    if (status.status === 'FAILED') {
      if (currentRank < DELIVERY_RANK['DELIVERED']) {
        await db.message.update({ where: { id: messageId }, data: { deliveryState: 'FAILED', lastErrorCode: status.errorCode ?? 'PROVIDER_FAILED', lastStatusAt: status.providerAt } });
        await db.$transaction(async (tx) => this.markInvitation(tx, messageId, 'FAILED', status.errorCode ?? 'PROVIDER_FAILED'));
      }
      return;
    }
    const newRank = DELIVERY_RANK[status.status] ?? 0;
    if (newRank > currentRank) {
      await db.message.update({ where: { id: messageId }, data: { deliveryState: status.status as DeliveryState, lastStatusAt: status.providerAt } });
    }
  }

  /** Match status events that arrived before their message row could be resolved. */
  async reconcileUnmatched(organizationId: string, limit = 200): Promise<number> {
    const db = this.dbFactory.forOrganization(organizationId);
    const pending = await db.messageStatusEvent.findMany({ where: { messageId: null, reconciledAt: null }, orderBy: { receivedAt: 'asc' }, take: limit });
    let reconciled = 0;
    for (const event of pending) {
      const message = await this.findByProviderMessageId(organizationId, event.connectionId, event.providerMessageId);
      if (!message) continue;
      await db.messageStatusEvent.update({ where: { id: event.id }, data: { messageId: message.id, reconciledAt: this.clock.now() } });
      await this.applyStatus(organizationId, message.id, { phoneNumberId: '', providerMessageId: event.providerMessageId, recipientIdentity: null, status: event.status, providerAt: event.providerAt, errorCode: event.errorCode, errorTitle: event.errorTitle });
      reconciled += 1;
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

  private async markInvitation(tx: TenantTx, messageId: string, state: 'ACCEPTED' | 'FAILED' | 'UNKNOWN' | 'SUPPRESSED', reason: string | null): Promise<void> {
    await tx.invitation.updateMany({ where: { messageId }, data: { state, stateReason: reason } });
  }
}
