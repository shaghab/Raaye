import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { pickLocale, type AudiencePreviewDto, type LaunchRequest, type LocalizedText, type SurveyDetailDto, type TestRunRequest } from '@raaye/contracts';
import { validateTiming, type Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { OrgContext, SystemContext, TenantContext } from '../common/context';
import { DomainError, forbidden, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { JOB_PRIORITY, JobsService } from '../jobs/jobs.service';
import { DeliveryService } from '../messaging/delivery.service';
import { MessagePlanner } from '../messaging/planner';
import { MessagingReadinessService } from '../messaging/readiness.service';
import { getLogger } from '../observability/logger';
import { isUniqueViolation } from '../persistence/db-errors';
import { asJson } from '../persistence/json';
import type { SurveyRun } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantDb, TenantTx } from '../persistence/tenant-db';
import { AudienceService } from './audience.service';
import { revisionInclude, type RevisionWithQuestions } from './survey-mapper';
import { SurveysService, flowsNeeded } from './surveys.service';

const DISPATCH_BATCH = 100;

/** Launch, schedule, activate, close and cancel survey runs. All handlers are idempotent. */
@Injectable()
export class LaunchService {
  private readonly logger = getLogger('launch');

  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly surveys: SurveysService,
    private readonly audience: AudienceService,
    private readonly readiness: MessagingReadinessService,
    private readonly planner: MessagePlanner,
    private readonly delivery: DeliveryService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async audiencePreview(ctx: TenantContext, surveyId: string): Promise<AudiencePreviewDto> {
    const db = this.dbFactory.for(ctx);
    const survey = await this.surveys.load(db, surveyId);
    return this.audience.preview(ctx, survey.revisions[0].audienceDefinition as Parameters<AudienceService['preview']>[1]);
  }

  /** Send now or schedule. Freezes the revision and audience, creates the LIVE run and its jobs. */
  async launch(ctx: TenantContext, surveyId: string, input: LaunchRequest, idempotencyKey: string | null): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const requestHash = createHash('sha256').update(JSON.stringify({ surveyId, ...input })).digest('hex');
    const committedLaunch = async () => (idempotencyKey ? db.idempotencyKey.findUnique({ where: { organizationId_scope_key: { organizationId: ctx.organizationId, scope: `launch:${surveyId}`, key: idempotencyKey } } }) : null);
    const replay = (stored: { requestHash: string }) => {
      if (stored.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request');
      return this.surveys.get(ctx, surveyId);
    };
    const existing = await committedLaunch();
    if (existing) return replay(existing);
    try {
      return await this.launchDraft(ctx, db, surveyId, input, idempotencyKey, requestHash);
    } catch (error) {
      // A retry of a launch that committed meanwhile (a double click racing a slow network): the
      // state guards or the unique constraints refused it only because its twin had already
      // succeeded, so it receives the answer the twin received instead of an error.
      const twin = await committedLaunch();
      if (twin) return replay(twin);
      if (isUniqueViolation(error, 'live_slot') || isUniqueViolation(error, 'idempotency')) return this.surveys.get(ctx, surveyId);
      throw error;
    }
  }

  private async launchDraft(ctx: TenantContext, db: TenantDb, surveyId: string, input: LaunchRequest, idempotencyKey: string | null, requestHash: string): Promise<SurveyDetailDto> {
    const survey = await this.surveys.load(db, surveyId);
    if (survey.archivedAt) throw new DomainError('SURVEY_STATE_INVALID', 'Archived surveys cannot be launched');
    if (survey.state !== 'DRAFT') throw new DomainError('SURVEY_STATE_INVALID', `Only a draft can be launched (current state: ${survey.state})`);
    const revision = survey.revisions[0];
    this.surveys.assertNoContentErrors(revision);
    const now = this.clock.now();
    const opensAt = input.mode === 'NOW' ? now : input.opensAt ? new Date(input.opensAt) : null;
    if (!opensAt) throw new DomainError('SURVEY_TIMING_INVALID', 'A scheduled launch needs an opening time', undefined, [{ path: 'opensAt', message: 'Required' }]);
    const timingErrors = validateTiming({ now, opensAt, durationSeconds: revision.durationSeconds, editWindowSeconds: revision.editWindowSeconds, explicitClosesAt: revision.explicitClosesAt, scheduled: input.mode === 'SCHEDULED' });
    if (timingErrors.length) throw new DomainError('SURVEY_TIMING_INVALID', timingErrors.map((error) => error.message).join('; '), { errors: timingErrors });
    const closesAt = this.surveys.effectiveCloses(revision, opensAt);
    if (closesAt.getTime() <= now.getTime()) throw new DomainError('SURVEY_TIMING_INVALID', 'The closing time is already in the past');
    const readiness = await this.readiness.check(ctx, { needFlows: flowsNeeded(revision) });
    if (!readiness.ok || !readiness.connection) throw new DomainError('TEMPLATE_NOT_READY', 'Messaging is not ready for this survey', { blockers: readiness.blockers });
    if (this.config.isLiveMessaging && !input.acknowledgeCharges) {
      throw new DomainError('VALIDATION_FAILED', 'Confirm that live sends may incur WhatsApp messaging charges', undefined, [{ path: 'acknowledgeCharges', message: 'Required for live sends' }]);
    }
    const resolved = await this.audience.resolve(ctx, revision.audienceDefinition as Parameters<AudienceService['resolve']>[1]);
    if (resolved.summary.eligible === 0) throw new DomainError('AUDIENCE_EMPTY', 'No currently eligible recipients; review consent and audience selection', { summary: resolved.summary });
    const connectionId = readiness.connection.id;
    await db.$transaction(async (tx) => {
      // Serialized with archive on the survey row: an archive that commits first fails this guard.
      await tx.$queryRaw`SELECT id FROM surveys WHERE id = ${survey.id}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
      // Everything validated above was read before the lock: refuse to freeze a revision that an
      // edit changed in between (edits bump the revision's updatedAt or install a new revision).
      const fresh = await tx.survey.findUnique({ where: { id: survey.id }, select: { currentRevisionNumber: true, revisions: { where: { id: revision.id }, select: { updatedAt: true } } } });
      if (!fresh || fresh.currentRevisionNumber !== survey.currentRevisionNumber || fresh.revisions[0]?.updatedAt.getTime() !== revision.updatedAt.getTime()) {
        throw new DomainError('SURVEY_STATE_INVALID', 'The survey was edited while it was being launched; review it and launch again');
      }
      const guard = await tx.survey.updateMany({ where: { id: survey.id, state: 'DRAFT', archivedAt: null }, data: { state: input.mode === 'NOW' ? 'ACTIVE' : 'SCHEDULED' } });
      if (guard.count !== 1) throw new DomainError('SURVEY_STATE_INVALID', 'The survey was launched or archived concurrently');
      await tx.surveyRevision.update({ where: { id: revision.id }, data: { frozenAt: now, scheduledOpensAt: opensAt, rendererPlan: asJson(revision.questions.map((question) => ({ questionId: question.id, renderer: question.renderer }))) } });
      const run = await tx.surveyRun.create({
        data: {
          organizationId: ctx.organizationId,
          surveyId: survey.id,
          revisionId: revision.id,
          kind: 'LIVE',
          liveSlot: 1,
          state: input.mode === 'NOW' ? 'ACTIVE' : 'SCHEDULED',
          opensAt,
          closesAt,
          activatedAt: input.mode === 'NOW' ? now : null,
          audienceDefinition: asJson(revision.audienceDefinition),
          audienceSummary: asJson(resolved.summary),
          launchIdempotencyKey: idempotencyKey,
          launchedByUserId: ctx.userId,
        },
      });
      await this.createRecipients(tx, ctx.organizationId, run.id, resolved.recipients);
      await this.jobs.enqueue(tx, { organizationId: ctx.organizationId, kind: 'ACTIVATE_SURVEY', entityId: run.id, dedupeKey: `activate:${run.id}`, dueAt: opensAt, priority: JOB_PRIORITY.lifecycle, maxAttempts: 20 });
      await this.jobs.enqueue(tx, { organizationId: ctx.organizationId, kind: 'CLOSE_SURVEY', entityId: run.id, dedupeKey: `close:${run.id}`, dueAt: closesAt, priority: JOB_PRIORITY.lifecycle, maxAttempts: 20 });
      if (idempotencyKey) {
        await tx.idempotencyKey.create({ data: { organizationId: ctx.organizationId, scope: `launch:${surveyId}`, key: idempotencyKey, requestHash, responseStatus: 200 } });
      }
      await this.audit.record(ctx, { action: input.mode === 'NOW' ? 'survey.launched' : 'survey.scheduled', resourceType: 'survey', resourceId: survey.id, metadata: { runId: run.id, opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(), selected: resolved.summary.selected, eligible: resolved.summary.eligible, connectionId } }, tx);
    });
    return this.surveys.get(ctx, surveyId);
  }

  /** Return a scheduled survey to draft before any outreach begins. */
  async unschedule(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const survey = await this.surveys.load(db, surveyId);
    const run = survey.runs.find((candidate) => candidate.kind === 'LIVE' && candidate.state === 'SCHEDULED');
    if (survey.state !== 'SCHEDULED' || !run) throw new DomainError('SURVEY_STATE_INVALID', 'Only a scheduled survey can be unscheduled');
    const sent = await db.message.count({ where: { runId: run.id, state: { notIn: ['PENDING', 'CANCELED'] } } });
    if (sent > 0) throw new DomainError('SURVEY_STATE_INVALID', 'Outreach already began; close the survey instead');
    await db.$transaction(async (tx) => {
      await this.cancelRun(tx, run.id, 'UNSCHEDULED');
      await tx.survey.update({ where: { id: survey.id }, data: { state: 'DRAFT' } });
      await this.audit.record(ctx, { action: 'survey.unscheduled', resourceType: 'survey', resourceId: survey.id, metadata: { runId: run.id } }, tx);
    });
    return this.surveys.get(ctx, surveyId);
  }

  async close(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const survey = await this.surveys.load(db, surveyId);
    const run = survey.runs.find((candidate) => candidate.kind === 'LIVE' && (candidate.state === 'ACTIVE' || candidate.state === 'SCHEDULED'));
    if (!run) throw new DomainError('SURVEY_STATE_INVALID', 'Only an active or scheduled survey can be closed');
    await this.closeRun(ctx, run.id, 'MANUAL');
    return this.surveys.get(ctx, surveyId);
  }

  async archive(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    return this.surveys.archive(ctx, surveyId, (tx, runId) => this.cancelRun(tx, runId, 'ARCHIVED'));
  }

  /** Test runs have their own recipients, timing, sessions and answers and never enter live reporting. */
  async createTestRun(ctx: TenantContext, surveyId: string, input: TestRunRequest): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const survey = await this.surveys.load(db, surveyId);
    if (survey.archivedAt) throw new DomainError('SURVEY_STATE_INVALID', 'Archived surveys cannot be tested');
    const revision = survey.revisions[0];
    this.surveys.assertNoContentErrors(revision);
    const readiness = await this.readiness.check(ctx, { needFlows: flowsNeeded(revision) });
    if (!readiness.ok || !readiness.connection) throw new DomainError('TEMPLATE_NOT_READY', 'Messaging is not ready for a test send', { blockers: readiness.blockers });
    const contacts = await db.contact.findMany({ where: { id: { in: input.contactIds } }, select: { id: true, name: true, archivedAt: true, isSynthetic: true, consentInvitations: true } });
    if (contacts.length !== new Set(input.contactIds).size) throw notFound('Contact');
    if (this.config.isLiveMessaging) {
      for (const contact of contacts) {
        if (contact.isSynthetic) throw new DomainError('SYNTHETIC_CONTACT', `${contact.name} is a synthetic contact and cannot receive live messages`);
        if (contact.consentInvitations !== 'GRANTED') throw new DomainError('CONTACT_CONSENT_MISSING', `${contact.name} has not granted permission for test invitations`);
      }
    }
    const now = this.clock.now();
    const closesAt = new Date(now.getTime() + (input.durationSeconds ?? revision.durationSeconds) * 1000);
    await db.$transaction(async (tx) => {
      // Serialized with archive and draft edits on the survey row; the checks above were made before the lock.
      await tx.$queryRaw`SELECT id FROM surveys WHERE id = ${survey.id}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
      const fresh = await tx.survey.findUnique({ where: { id: survey.id }, select: { archivedAt: true, currentRevisionNumber: true, revisions: { where: { id: revision.id }, select: { updatedAt: true } } } });
      if (!fresh || fresh.archivedAt) throw new DomainError('SURVEY_STATE_INVALID', 'Archived surveys cannot be tested');
      if (fresh.currentRevisionNumber !== survey.currentRevisionNumber || fresh.revisions[0]?.updatedAt.getTime() !== revision.updatedAt.getTime()) {
        throw new DomainError('SURVEY_STATE_INVALID', 'The survey was edited while the test run was being created; review it and send the test again');
      }
      const run = await tx.surveyRun.create({
        data: {
          organizationId: ctx.organizationId,
          surveyId: survey.id,
          revisionId: revision.id,
          kind: 'TEST',
          state: 'ACTIVE',
          opensAt: now,
          closesAt,
          activatedAt: now,
          audienceDefinition: asJson({ mode: 'SELECTED', contactIds: input.contactIds }),
          audienceSummary: asJson({ selected: contacts.length, eligible: contacts.filter((contact) => !contact.archivedAt).length, exclusions: {} }),
          launchedByUserId: ctx.userId,
        },
      });
      await this.createRecipients(
        tx,
        ctx.organizationId,
        run.id,
        contacts.map((contact) => ({ contactId: contact.id, name: contact.name, eligible: !contact.archivedAt, reason: contact.archivedAt ? 'CONTACT_ARCHIVED' : null, snapshot: {} })),
      );
      await this.jobs.enqueue(tx, { organizationId: ctx.organizationId, kind: 'ACTIVATE_SURVEY', entityId: run.id, dedupeKey: `activate:${run.id}`, dueAt: now, priority: JOB_PRIORITY.lifecycle, maxAttempts: 20 });
      await this.jobs.enqueue(tx, { organizationId: ctx.organizationId, kind: 'CLOSE_SURVEY', entityId: run.id, dedupeKey: `close:${run.id}`, dueAt: closesAt, priority: JOB_PRIORITY.lifecycle, maxAttempts: 20 });
      await this.audit.record(ctx, { action: 'survey.test_run_created', resourceType: 'survey', resourceId: survey.id, metadata: { runId: run.id, recipients: contacts.length } }, tx);
    });
    return this.surveys.get(ctx, surveyId);
  }

  private async createRecipients(tx: TenantTx, organizationId: string, runId: string, recipients: { contactId: string; eligible: boolean; reason: string | null; snapshot: Record<string, unknown> }[]): Promise<void> {
    for (let i = 0; i < recipients.length; i += 500) {
      await tx.surveyRecipient.createMany({
        data: recipients.slice(i, i + 500).map((recipient) => ({ organizationId, runId, contactId: recipient.contactId, eligibleAtFreeze: recipient.eligible, exclusionReason: recipient.reason, audienceSnapshot: asJson(recipient.snapshot) })),
      });
    }
    const created = await tx.surveyRecipient.findMany({ where: { runId, eligibleAtFreeze: true }, select: { id: true, contactId: true } });
    for (let i = 0; i < created.length; i += 500) {
      await tx.invitation.createMany({ data: created.slice(i, i + 500).map((recipient) => ({ organizationId, runId, recipientId: recipient.id, contactId: recipient.contactId, state: 'PENDING' })) });
    }
  }

  /**
   * ACTIVATE_SURVEY handler: activate when due, then queue remaining invitations in bounded batches.
   * Readiness is verified before the run is committed as active. A blocked run keeps its state and
   * records the blocker; the sweep re-enqueues it every minute until messaging is repaired or the
   * run reaches its closing time, when it closes without sending.
   */
  async activateRun(ctx: SystemContext, runId: string): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const now = this.clock.now();
    const run = await db.surveyRun.findUnique({ where: { id: runId }, include: { revision: { include: revisionInclude }, survey: true } });
    if (!run || run.state === 'CANCELED' || run.state === 'CLOSED') return;
    if (now.getTime() >= run.closesAt.getTime()) {
      // Workers resumed after the deadline: close without sending stale invitations.
      await this.closeRun(ctx, runId, 'EXPIRED_BEFORE_ACTIVATION');
      return;
    }
    if (now.getTime() < run.opensAt.getTime() - 60_000) return;
    const readiness = await this.readiness.check(ctx, { needFlows: flowsNeeded(run.revision) });
    if (!readiness.ok || !readiness.connection) {
      const reason = readiness.blockers.map((blocker) => blocker.code).join(',') || 'NOT_READY';
      await db.$transaction(async (tx) => {
        // Conditional update so concurrent activation attempts record one audit entry per reason change.
        const changed = await tx.surveyRun.updateMany({ where: { id: runId, OR: [{ dispatchBlockReason: null }, { dispatchBlockReason: { not: reason } }] }, data: { dispatchBlockReason: reason } });
        if (changed.count === 1) await this.audit.record(ctx, { action: 'survey.activation_blocked', resourceType: 'survey', resourceId: run.surveyId, metadata: { runId, state: run.state, reason } }, tx);
      });
      this.logger.warn({ runId, state: run.state, reason }, 'Activation blocked: messaging is not ready; the sweep retries until the closing time');
      return;
    }
    if (run.state === 'SCHEDULED') {
      await db.$transaction(async (tx) => {
        await tx.surveyRun.updateMany({ where: { id: runId, state: 'SCHEDULED' }, data: { state: 'ACTIVE', activatedAt: now } });
        if (run.kind === 'LIVE') await tx.survey.updateMany({ where: { id: run.surveyId, state: 'SCHEDULED' }, data: { state: 'ACTIVE' } });
        await this.audit.record(ctx, { action: 'survey.activated', resourceType: 'survey', resourceId: run.surveyId, metadata: { runId, late: now.getTime() - run.opensAt.getTime() > 60_000 } }, tx);
      });
    }
    if (run.dispatchBlockReason) await db.surveyRun.update({ where: { id: runId }, data: { dispatchBlockReason: null } });
    const connection = readiness.connection;
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    const orgCopy = this.planner.org(org);
    const template = readiness.templates.find((binding) => binding.purpose === 'SURVEY_INVITATION') ?? null;
    const title = pickLocale(run.revision.title as LocalizedText, run.revision.locale);
    let queued = 0;
    for (;;) {
      const batch = await db.invitation.findMany({ where: { runId, state: 'PENDING' }, take: DISPATCH_BATCH, orderBy: { createdAt: 'asc' }, include: { recipient: { select: { suppressedAt: true, suppressedReason: true } } } });
      if (batch.length === 0) break;
      for (const invitation of batch) {
        await db.$transaction(async (tx) => {
          if (invitation.recipient.suppressedAt) {
            await tx.invitation.updateMany({ where: { id: invitation.id, state: 'PENDING' }, data: { state: 'SUPPRESSED', stateReason: invitation.recipient.suppressedReason ?? 'SUPPRESSED' } });
            return;
          }
          const { rendered, bindingId } = await this.planner.invitation(tx, {
            organizationId: ctx.organizationId,
            contact: { id: invitation.contactId, connectionId: connection.id },
            mode: run.kind === 'TEST' ? 'TEST' : 'LIVE',
            runId,
            org: orgCopy,
            surveyTitle: title,
            template,
            expiresAt: run.closesAt,
            isTest: run.kind === 'TEST',
          });
          const message = await this.delivery.createMessage(tx, {
            organizationId: ctx.organizationId,
            connectionId: connection.id,
            contactId: invitation.contactId,
            kind: 'INVITATION',
            rendered,
            dedupeKey: `invite:${invitation.id}`,
            runId,
            isTest: run.kind === 'TEST',
            priority: JOB_PRIORITY.invitation,
          });
          await tx.invitation.updateMany({ where: { id: invitation.id, state: 'PENDING' }, data: { state: 'QUEUED', messageId: message.id, actionBindingId: bindingId } });
          queued += 1;
        });
      }
    }
    this.logger.info({ runId, queued }, 'Invitations queued');
  }

  /** CLOSE_SURVEY handler and manual close: idempotent, cancels remaining outreach. */
  async closeRun(ctx: OrgContext, runId: string, reason: string): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const now = this.clock.now();
    const run = await db.surveyRun.findUnique({ where: { id: runId } });
    if (!run || run.state === 'CLOSED' || run.state === 'CANCELED') return;
    if (reason !== 'MANUAL' && now.getTime() < run.closesAt.getTime()) return;
    await db.$transaction(async (tx) => {
      const guard = await tx.surveyRun.updateMany({ where: { id: runId, state: { in: ['ACTIVE', 'SCHEDULED'] } }, data: { state: 'CLOSED', closedAt: now, closeReason: reason, closesAt: reason === 'MANUAL' ? now : run.closesAt } });
      if (guard.count !== 1) return;
      if (run.kind === 'LIVE') await tx.survey.updateMany({ where: { id: run.surveyId, state: { in: ['ACTIVE', 'SCHEDULED'] } }, data: { state: 'CLOSED' } });
      await this.cancelRunWork(tx, runId, `SURVEY_CLOSED:${reason}`, now);
      await this.audit.record(ctx, { action: 'survey.closed', resourceType: 'survey', resourceId: run.surveyId, metadata: { runId, reason, kind: run.kind } }, tx);
    });
  }

  async cancelRun(tx: TenantTx, runId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    // Releasing the live slot lets the survey be scheduled again after an unschedule.
    await tx.surveyRun.updateMany({ where: { id: runId, state: { in: ['SCHEDULED', 'ACTIVE'] } }, data: { state: 'CANCELED', closedAt: now, closeReason: reason, liveSlot: null } });
    await this.cancelRunWork(tx, runId, reason, now);
  }

  private async cancelRunWork(tx: TenantTx, runId: string, reason: string, now: Date): Promise<void> {
    await this.jobs.cancel(tx, `activate:${runId}`);
    await this.jobs.cancel(tx, `close:${runId}`);
    const pending = await tx.message.findMany({ where: { runId, state: 'PENDING' }, select: { id: true } });
    if (pending.length) {
      const ids = pending.map((message) => message.id);
      await tx.message.updateMany({ where: { id: { in: ids } }, data: { state: 'CANCELED', deliveryState: 'CANCELED', suppressionReason: reason } });
      await tx.job.updateMany({ where: { entityId: { in: ids }, status: 'PENDING' }, data: { status: 'CANCELED', finishedAt: now, lastErrorCode: reason } });
    }
    await tx.invitation.updateMany({ where: { runId, state: { in: ['PENDING', 'QUEUED'] } }, data: { state: 'CANCELED', stateReason: reason } });
    await tx.actionBinding.updateMany({ where: { runId, expiresAt: { gt: now }, purpose: { in: ['START_SURVEY', 'ANSWER_OPTION', 'QUESTION_FLOW', 'EDIT_QUESTION', 'CONTINUE_SURVEY', 'SWITCH_SURVEY'] } }, data: { expiresAt: now } });
  }

  async loadRun(ctx: OrgContext, runId: string): Promise<SurveyRun | null> {
    return this.dbFactory.for(ctx).surveyRun.findUnique({ where: { id: runId } });
  }

  revisionOf(run: { revision: RevisionWithQuestions }): RevisionWithQuestions {
    return run.revision;
  }
}
