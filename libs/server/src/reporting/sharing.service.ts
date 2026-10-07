import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LIMITS, pickLocale, type LocalizedText, type ResultSharePreviewDto, type ResultSharingDto } from '@raaye/contracts';
import { copy, formatResultsChunks, isServiceWindowOpen, type Clock, type SnapshotAggregate } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, forbidden, notFound } from '../common/errors';
import { JOB_PRIORITY } from '../jobs/jobs.service';
import { DeliveryService } from '../messaging/delivery.service';
import { MessagePlanner } from '../messaging/planner';
import { MessagingReadinessService } from '../messaging/readiness.service';
import { isUniqueViolation } from '../persistence/db-errors';
import { asJson } from '../persistence/json';
import { PrismaService } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import { ReportingService } from './reporting.service';

const FORMAT_VERSION = 1;

/**
 * Admin-initiated sharing of a frozen aggregate snapshot with eligible respondents after
 * closure: one broadcast per survey, re-checked permission, minimum-sample rule, no
 * identities or demographic slices. Delivery goes through the normal sending gate.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly reporting: ReportingService,
    private readonly readiness: MessagingReadinessService,
    private readonly planner: MessagePlanner,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async eligibility(ctx: TenantContext, runId: string) {
    const db = this.dbFactory.for(ctx);
    const respondents = await db.participation.findMany({ where: { runId, answers: { some: {} } }, include: { contact: { select: { id: true, archivedAt: true, consentResults: true, consentInvitations: true, isSynthetic: true } } } });
    const excluded: Record<string, number> = {};
    const eligible: { contactId: string; participationId: string }[] = [];
    for (const participation of respondents) {
      const contact = participation.contact;
      const reason = contact.archivedAt ? 'CONTACT_ARCHIVED' : contact.consentResults === 'WITHDRAWN' ? 'CONTACT_WITHDRAWN' : contact.consentResults !== 'GRANTED' ? 'RESULTS_CONSENT_MISSING' : null;
      if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
      else eligible.push({ contactId: contact.id, participationId: participation.id });
    }
    return { eligible, excluded, respondents: respondents.length };
  }

  private async buildAggregate(ctx: TenantContext, surveyId: string): Promise<{ aggregate: SnapshotAggregate; shareable: number; suppressed: number }> {
    const { run } = await this.reporting.liveRun(ctx, surveyId);
    if (!run) throw notFound('Survey run');
    const results = await this.reporting.results(ctx, surveyId);
    let shareable = 0;
    let suppressed = 0;
    const aggregate: SnapshotAggregate = {
      formatVersion: FORMAT_VERSION,
      surveyTitle: run.revision.title as LocalizedText,
      generatedAt: this.clock.now().toISOString(),
      respondents: results.responded,
      minimumRespondents: LIMITS.shareMinRespondents,
      questions: results.questions.map((question) => {
        const ok = question.validAnswers >= LIMITS.shareMinRespondents;
        if (ok) shareable += 1;
        else suppressed += 1;
        return {
          questionId: question.questionId,
          position: question.position,
          prompt: question.prompt,
          type: question.type,
          validAnswers: ok ? question.validAnswers : 0,
          shareable: ok,
          options: ok ? question.options.map((option) => ({ optionId: option.optionId, code: option.code, label: option.label, count: option.count, percentage: option.percentage })) : [],
          ratingMean: ok ? question.ratingMean : null,
        };
      }),
    };
    return { aggregate, shareable, suppressed };
  }

  async preview(ctx: TenantContext, surveyId: string): Promise<ResultSharePreviewDto> {
    if (ctx.role !== 'ADMIN') throw forbidden('Only Admins can share results');
    const { run } = await this.reporting.liveRun(ctx, surveyId);
    if (!run) throw new DomainError('SURVEY_STATE_INVALID', 'The survey has not been launched');
    const closed = run.state === 'CLOSED';
    const existing = await this.dbFactory.for(ctx).resultSnapshot.findUnique({ where: { organizationId_runId: { organizationId: ctx.organizationId, runId: run.id } } });
    const { aggregate, shareable } = await this.buildAggregate(ctx, surveyId);
    const { eligible, excluded } = await this.eligibility(ctx, run.id);
    const org = await this.dbFactory.for(ctx).organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    const reason = existing ? 'Results were already shared for this survey' : !closed ? 'The survey must be closed before results can be shared' : shareable === 0 ? 'Every question is below the minimum of five respondents' : eligible.length === 0 ? 'No respondent has permission to receive results' : null;
    return {
      surveyId,
      eligibleRecipients: eligible.length,
      excluded,
      questions: aggregate.questions.map((question) => ({ questionId: question.questionId, position: question.position, prompt: question.prompt, validAnswers: question.validAnswers, shareable: question.shareable, reason: question.shareable ? null : `Fewer than ${LIMITS.shareMinRespondents} valid responses` })),
      canShare: reason === null,
      reason,
      minimumRespondents: LIMITS.shareMinRespondents,
      messagePreview: copy.resultsAvailable(this.planner.org(org), pickLocale(aggregate.surveyTitle)),
      summaryPreview: formatResultsChunks(aggregate, org.name),
      alreadyShared: Boolean(existing),
    };
  }

  async share(ctx: TenantContext, surveyId: string, idempotencyKey: string | null): Promise<ResultSharingDto> {
    if (ctx.role !== 'ADMIN') throw forbidden('Only Admins can share results');
    const db = this.dbFactory.for(ctx);
    const { run } = await this.reporting.liveRun(ctx, surveyId);
    if (!run) throw new DomainError('SURVEY_STATE_INVALID', 'The survey has not been launched');
    const existing = await db.resultSnapshot.findUnique({ where: { organizationId_runId: { organizationId: ctx.organizationId, runId: run.id } } });
    if (existing) return this.status(ctx, surveyId);
    this.reporting.assertRunClosed(run);
    const readiness = await this.readiness.check(ctx, { needResultsTemplate: true });
    if (!readiness.ok || !readiness.connection) throw new DomainError('TEMPLATE_NOT_READY', 'Messaging is not ready to broadcast results', { blockers: readiness.blockers });
    const { aggregate, shareable, suppressed } = await this.buildAggregate(ctx, surveyId);
    if (shareable === 0) throw new DomainError('RESULTS_INSUFFICIENT_SAMPLE', 'Every question is below the minimum of five respondents; nothing can be shared');
    const { eligible, excluded } = await this.eligibility(ctx, run.id);
    if (eligible.length === 0) throw new DomainError('RESULTS_INSUFFICIENT_SAMPLE', 'No respondent has current permission to receive results');
    const connection = readiness.connection;
    const template = readiness.templates.find((binding) => binding.purpose === 'RESULTS_AVAILABLE') ?? null;
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    const orgCopy = this.planner.org(org);
    const title = pickLocale(aggregate.surveyTitle);
    const now = this.clock.now();
    const requestHash = createHash('sha256').update(`${surveyId}:${idempotencyKey ?? ''}`).digest('hex').slice(0, 32);
    try {
      await db.$transaction(async (tx) => {
        const snapshot = await tx.resultSnapshot.create({
          data: { organizationId: ctx.organizationId, surveyId, runId: run.id, formatVersion: FORMAT_VERSION, aggregate: asJson(aggregate), generatedAt: now, createdByUserId: ctx.userId, eligibleCount: eligible.length, suppressedCount: Object.values(excluded).reduce((sum, value) => sum + value, 0), questionsShared: shareable, questionsSuppressed: suppressed, broadcastState: 'QUEUED', idempotencyKey: requestHash },
        });
        const conversations = await tx.conversation.findMany({ where: { contactId: { in: eligible.map((item) => item.contactId) } }, select: { contactId: true, lastInboundAt: true } });
        const windows = new Map(conversations.map((conversation) => [conversation.contactId, conversation.lastInboundAt]));
        for (const recipient of eligible) {
          const useTemplate = !isServiceWindowOpen(windows.get(recipient.contactId) ?? null, now);
          const rendered = await this.planner.resultsInvitation(tx, { organizationId: ctx.organizationId, contact: { id: recipient.contactId, connectionId: connection.id }, snapshotId: snapshot.id, org: orgCopy, surveyTitle: title, template, useTemplate, expiresAt: new Date(now.getTime() + LIMITS.actionBindingDays * 86_400_000) });
          const message = await this.delivery.createMessage(tx, { organizationId: ctx.organizationId, connectionId: connection.id, contactId: recipient.contactId, kind: 'RESULTS_INVITATION', rendered, dedupeKey: `results-invite:${snapshot.id}:${recipient.contactId}`, snapshotId: snapshot.id, priority: JOB_PRIORITY.results });
          await tx.resultRecipient.create({ data: { organizationId: ctx.organizationId, snapshotId: snapshot.id, contactId: recipient.contactId, invitationMessageId: message.id, accessState: 'INVITED' } });
        }
        await tx.resultSnapshot.update({ where: { id: snapshot.id }, data: { broadcastState: 'COMPLETED' } });
        await this.audit.record(ctx, { action: 'results.shared', resourceType: 'survey', resourceId: surveyId, metadata: { snapshotId: snapshot.id, eligible: eligible.length, excluded, questionsShared: shareable, questionsSuppressed: suppressed } }, tx);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.status(ctx, surveyId);
  }

  async status(ctx: TenantContext, surveyId: string): Promise<ResultSharingDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const { run } = await this.reporting.liveRun(ctx, surveyId);
    if (!run) return { snapshot: null, recipients: null };
    const snapshot = await db.resultSnapshot.findUnique({ where: { organizationId_runId: { organizationId: ctx.organizationId, runId: run.id } } });
    if (!snapshot) return { snapshot: null, recipients: null };
    const [recipients, creator] = await Promise.all([
      db.resultRecipient.findMany({ where: { snapshotId: snapshot.id }, include: { invitationMessage: { select: { deliveryState: true, state: true } } } }),
      this.prisma.user.findUnique({ where: { id: snapshot.createdByUserId }, select: { email: true } }),
    ]);
    const byState: Record<string, number> = {};
    const byDelivery: Record<string, number> = {};
    for (const recipient of recipients) {
      byState[recipient.accessState] = (byState[recipient.accessState] ?? 0) + 1;
      const delivery = recipient.invitationMessage?.deliveryState ?? 'NONE';
      byDelivery[delivery] = (byDelivery[delivery] ?? 0) + 1;
    }
    return {
      snapshot: {
        id: snapshot.id,
        generatedAt: snapshot.generatedAt.toISOString(),
        createdByUserId: snapshot.createdByUserId,
        createdByEmail: creator?.email ?? null,
        formatVersion: snapshot.formatVersion,
        eligibleCount: snapshot.eligibleCount,
        suppressedCount: snapshot.suppressedCount,
        questionsShared: snapshot.questionsShared,
        questionsSuppressed: snapshot.questionsSuppressed,
        broadcastState: snapshot.broadcastState,
        revokedAt: snapshot.revokedAt?.toISOString() ?? null,
      },
      recipients: { total: recipients.length, byState, byDelivery },
    };
  }

  /** Revoke in-app access; WhatsApp text already delivered cannot be retracted by Raaye. */
  async revoke(ctx: TenantContext, surveyId: string): Promise<ResultSharingDto> {
    if (ctx.role !== 'ADMIN') throw forbidden('Only Admins can revoke shared results');
    const db = this.dbFactory.for(ctx);
    const { run } = await this.reporting.liveRun(ctx, surveyId);
    if (!run) throw notFound('Survey run');
    const snapshot = await db.resultSnapshot.findUnique({ where: { organizationId_runId: { organizationId: ctx.organizationId, runId: run.id } } });
    if (!snapshot) throw notFound('Result snapshot');
    await db.$transaction(async (tx) => {
      await tx.resultSnapshot.update({ where: { id: snapshot.id }, data: { revokedAt: this.clock.now(), revokedByUserId: ctx.userId, broadcastState: 'REVOKED' } });
      await tx.actionBinding.updateMany({ where: { snapshotId: snapshot.id, expiresAt: { gt: this.clock.now() } }, data: { expiresAt: this.clock.now() } });
      await this.audit.record(ctx, { action: 'results.revoked', resourceType: 'survey', resourceId: surveyId, metadata: { snapshotId: snapshot.id } }, tx);
    });
    return this.status(ctx, surveyId);
  }
}
