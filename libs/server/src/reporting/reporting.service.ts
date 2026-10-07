import { Inject, Injectable } from '@nestjs/common';
import {
  LIMITS,
  pickLocale,
  type BreakdownDto,
  type DemographicDimension,
  type DispatchDto,
  type DispatchMetricsDto,
  type IndividualResponseDto,
  type LocalizedText,
  type OverviewDto,
  type Page,
  type ResultsDto,
} from '@raaye/contracts';
import { cohortKey, computeBreakdown, computeQuestionResults, rate, type AnalysisProfile, type Clock, type CurrentSelectionRow, type QuestionShape } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { OrgContext, TenantContext } from '../common/context';
import { DomainError, forbidden, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { Prisma } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantDb } from '../persistence/tenant-db';
import { revisionInclude, toRunSummary, type RevisionWithQuestions } from '../surveys/survey-mapper';
import { assertSurveyVisible } from '../surveys/visibility';

export interface LiveRunContext {
  survey: { id: string; internalTitle: string; state: string };
  run: Prisma.SurveyRunGetPayload<{ include: { revision: { include: typeof revisionInclude } } }> | null;
}

/**
 * Aggregates computed from canonical current answers of the LIVE run only. Test runs,
 * revisions and unstarted recipients never enter counts. Viewers only see aggregates.
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async liveRun(ctx: OrgContext, surveyId: string): Promise<LiveRunContext> {
    const db = this.dbFactory.for(ctx);
    const survey = await db.survey.findUnique({ where: { id: surveyId }, select: { id: true, internalTitle: true, state: true } });
    if (!survey) throw notFound('Survey');
    assertSurveyVisible(ctx, survey);
    const run = await db.surveyRun.findFirst({ where: { surveyId, kind: 'LIVE', state: { not: 'CANCELED' } }, include: { revision: { include: revisionInclude } }, orderBy: { createdAt: 'desc' } });
    return { survey, run };
  }

  /** Current selections of every respondent of the run (one row per selected option). */
  async currentSelections(db: TenantDb, runId: string): Promise<CurrentSelectionRow[]> {
    const rows = await db.$queryRaw<{ participation_id: string; question_id: string; option_id: string; rating_value: number | null }[]>(Prisma.sql`
      SELECT a.participation_id, a.question_id, s.option_id, r.rating_value
      FROM answers a
      JOIN participations p ON p.id = a.participation_id AND p.organization_id = a.organization_id
      JOIN answer_revisions r ON r.answer_id = a.id AND r.organization_id = a.organization_id AND r.is_current = true
      JOIN answer_selections s ON s.answer_revision_id = r.id AND s.organization_id = r.organization_id
      WHERE p.run_id = ${runId}::uuid
    `);
    return rows.map((row) => ({ participationId: row.participation_id, questionId: row.question_id, optionId: row.option_id, ratingValue: row.rating_value }));
  }

  questionShapes(revision: RevisionWithQuestions): QuestionShape[] {
    return revision.questions.map((question) => ({
      id: question.id,
      position: question.position,
      type: question.type,
      prompt: question.prompt as LocalizedText,
      options: question.options.map((option) => ({ id: option.id, code: option.code, label: option.label as LocalizedText, ratingValue: option.ratingValue })),
    }));
  }

  async results(ctx: OrgContext, surveyId: string): Promise<ResultsDto> {
    const db = this.dbFactory.for(ctx);
    const { run } = await this.liveRun(ctx, surveyId);
    const now = this.clock.now();
    if (!run) {
      const survey = await db.survey.findUniqueOrThrow({ where: { id: surveyId }, select: { currentRevisionNumber: true } });
      return { surveyId, runId: null, revisionNumber: survey.currentRevisionNumber, started: 0, responded: 0, completed: 0, questions: [], refreshedAt: now.toISOString(), isSnapshot: false };
    }
    const [rows, started, responded, completed] = await Promise.all([
      this.currentSelections(db, run.id),
      db.participation.count({ where: { runId: run.id } }),
      db.participation.count({ where: { runId: run.id, answers: { some: {} } } }),
      db.participation.count({ where: { runId: run.id, state: 'COMPLETED' } }),
    ]);
    return {
      surveyId,
      runId: run.id,
      revisionNumber: run.revision.revisionNumber,
      started,
      responded,
      completed,
      questions: computeQuestionResults(this.questionShapes(run.revision), rows, started),
      refreshedAt: now.toISOString(),
      isSnapshot: false,
    };
  }

  async breakdown(ctx: TenantContext, surveyId: string, dimension: DemographicDimension, questionId?: string): Promise<BreakdownDto> {
    const db = this.dbFactory.for(ctx);
    const { run } = await this.liveRun(ctx, surveyId);
    const applyThreshold = ctx.role !== 'ADMIN';
    if (!run) return { dimension, threshold: LIMITS.cohortThreshold, thresholdApplied: applyThreshold, questions: [], refreshedAt: this.clock.now().toISOString() };
    const [rows, participations] = await Promise.all([
      this.currentSelections(db, run.id),
      db.participation.findMany({ where: { runId: run.id }, select: { id: true, analysisProfile: true } }),
    ]);
    const cohortOf = new Map(participations.map((participation) => [participation.id, cohortKey((participation.analysisProfile as AnalysisProfile | null) ?? null, dimension)]));
    const shapes = this.questionShapes(run.revision).filter((question) => !questionId || question.id === questionId);
    return {
      dimension,
      threshold: LIMITS.cohortThreshold,
      thresholdApplied: applyThreshold,
      questions: computeBreakdown({ questions: shapes, rows, cohortOf, dimension, threshold: LIMITS.cohortThreshold, applyThreshold }),
      refreshedAt: this.clock.now().toISOString(),
    };
  }

  async dispatch(ctx: TenantContext, surveyId: string, query: { limit: number; offset: number; state?: string; search?: string; runId?: string }): Promise<DispatchDto> {
    const db = this.dbFactory.for(ctx);
    const { run: liveRun } = await this.liveRun(ctx, surveyId);
    const run = query.runId ? await db.surveyRun.findFirst({ where: { id: query.runId, surveyId }, include: { revision: { include: revisionInclude } } }) : liveRun;
    if (!run) return { run: null, metrics: null, recipients: { items: [], total: 0, limit: query.limit, offset: query.offset } };
    const metrics = await this.metrics(db, run.id);
    const where: Prisma.SurveyRecipientWhereInput = {
      runId: run.id,
      contact: query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { phoneE164: { contains: query.search.replace(/[^\d]/g, '') || query.search } }] } : undefined,
      invitation: query.state && query.state !== 'NOT_ELIGIBLE' ? { state: query.state as never } : undefined,
      eligibleAtFreeze: query.state === 'NOT_ELIGIBLE' ? false : undefined,
    };
    const [recipients, total] = await Promise.all([
      db.surveyRecipient.findMany({ where, include: { contact: { select: { id: true, name: true, phoneE164: true } }, invitation: { include: { message: { include: { _count: { select: { attempts: true } } } } } } }, orderBy: { createdAt: 'asc' }, take: query.limit, skip: query.offset }),
      db.surveyRecipient.count({ where }),
    ]);
    const participations = await db.participation.findMany({ where: { runId: run.id, contactId: { in: recipients.map((recipient) => recipient.contactId) } }, include: { _count: { select: { answers: true } } } });
    const byContact = new Map(participations.map((participation) => [participation.contactId, participation]));
    // Survey Managers see identities and delivery state for operations, never answer content.
    return {
      run: toRunSummary(run, run.revision.revisionNumber),
      metrics,
      recipients: {
        items: recipients.map((recipient) => {
          const participation = byContact.get(recipient.contactId);
          return {
            recipientId: recipient.id,
            contactId: recipient.contactId,
            contactName: recipient.contact.name,
            phoneE164: recipient.contact.phoneE164,
            eligibleAtFreeze: recipient.eligibleAtFreeze,
            exclusionReason: recipient.exclusionReason ?? recipient.suppressedReason,
            invitationState: recipient.invitation?.state ?? null,
            deliveryState: recipient.invitation?.message?.deliveryState ?? null,
            lastErrorCode: recipient.invitation?.message?.lastErrorCode ?? null,
            messageId: recipient.invitation?.messageId ?? null,
            attempts: recipient.invitation?.message?._count.attempts ?? 0,
            participationState: participation ? (participation.state === 'COMPLETED' ? 'COMPLETED' : 'STARTED') : 'NOT_STARTED',
            answeredCount: participation?._count.answers ?? 0,
          };
        }),
        total,
        limit: query.limit,
        offset: query.offset,
      },
    };
  }

  async metrics(db: TenantDb, runId: string): Promise<DispatchMetricsDto> {
    const [selected, eligible, queued, accepted, delivered, started, responded, completed, failed, suppressed, unknown, deliveredRespondents] = await Promise.all([
      db.surveyRecipient.count({ where: { runId } }),
      db.surveyRecipient.count({ where: { runId, eligibleAtFreeze: true } }),
      db.invitation.count({ where: { runId, state: { in: ['PENDING', 'QUEUED'] } } }),
      db.invitation.count({ where: { runId, message: { attempts: { some: { outcome: 'ACCEPTED' } } } } }),
      db.invitation.count({ where: { runId, message: { deliveryState: { in: ['DELIVERED', 'READ'] } } } }),
      db.participation.count({ where: { runId } }),
      db.participation.count({ where: { runId, answers: { some: {} } } }),
      db.participation.count({ where: { runId, state: 'COMPLETED' } }),
      db.invitation.count({ where: { runId, state: 'FAILED' } }),
      db.invitation.count({ where: { runId, state: { in: ['SUPPRESSED', 'CANCELED'] } } }),
      db.invitation.count({ where: { runId, state: 'UNKNOWN' } }),
      db.participation.count({ where: { runId, answers: { some: {} }, contact: { invitations: { some: { runId, message: { deliveryState: { in: ['DELIVERED', 'READ'] } } } } } } }),
    ]);
    return {
      selected,
      eligibleAtLaunch: eligible,
      queued,
      providerAccepted: accepted,
      delivered,
      started,
      responded,
      completed,
      failed,
      suppressed,
      unknown,
      responseRate: rate(deliveredRespondents, delivered),
      completionRate: rate(completed, started),
      deliveredRespondents,
      refreshedAt: this.clock.now().toISOString(),
    };
  }

  /** Admin only: identifiable current answers with revision history. Access is audited. */
  async responses(ctx: TenantContext, surveyId: string, query: { limit: number; offset: number; search?: string; state?: 'STARTED' | 'COMPLETED' }): Promise<Page<IndividualResponseDto>> {
    if (ctx.role !== 'ADMIN') throw forbidden('Only Admins can view identifiable individual answers');
    const db = this.dbFactory.for(ctx);
    const { run } = await this.liveRun(ctx, surveyId);
    if (!run) return { items: [], total: 0, limit: query.limit, offset: query.offset };
    const where: Prisma.ParticipationWhereInput = {
      runId: run.id,
      state: query.state,
      contact: query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { phoneE164: { contains: query.search.replace(/[^\d]/g, '') || query.search } }] } : undefined,
    };
    const [participations, total] = await Promise.all([
      db.participation.findMany({
        where,
        include: { contact: { select: { id: true, name: true, phoneE164: true } }, answers: { include: { question: { select: { position: true } }, revisions: { include: { selections: { include: { option: true } } }, orderBy: { revisionNumber: 'asc' } } } } },
        orderBy: { startedAt: 'asc' },
        take: query.limit,
        skip: query.offset,
      }),
      db.participation.count({ where }),
    ]);
    await this.audit.record(ctx, { action: 'responses.viewed', resourceType: 'survey', resourceId: surveyId, metadata: { runId: run.id, count: participations.length, offset: query.offset, search: Boolean(query.search) } });
    return {
      items: participations.map((participation) => ({
        participationId: participation.id,
        contactId: participation.contact.id,
        contactName: participation.contact.name,
        phoneE164: participation.contact.phoneE164,
        state: participation.state,
        startedAt: participation.startedAt.toISOString(),
        completedAt: participation.completedAt?.toISOString() ?? null,
        analysisProfile: (participation.analysisProfile as Record<string, string | null> | null) ?? null,
        answers: participation.answers
          .sort((a, b) => a.question.position - b.question.position)
          .map((answer) => {
            const current = answer.revisions.find((revision) => revision.isCurrent) ?? answer.revisions[answer.revisions.length - 1];
            const toSelections = (revision: (typeof answer.revisions)[number]) => revision.selections.map((selection) => ({ optionId: selection.optionId, code: selection.option.code, label: selection.option.label as LocalizedText, ratingValue: selection.option.ratingValue }));
            return {
              questionId: answer.questionId,
              position: answer.question.position,
              selections: current ? toSelections(current) : [],
              firstAcceptedAt: answer.firstAcceptedAt.toISOString(),
              editExpiresAt: answer.editExpiresAt.toISOString(),
              currentRevisionNumber: answer.currentRevisionNumber,
              lastAcceptedAt: current?.acceptedAt.toISOString() ?? answer.firstAcceptedAt.toISOString(),
              revisions: answer.revisions.map((revision) => ({ revisionNumber: revision.revisionNumber, acceptedAt: revision.acceptedAt.toISOString(), source: revision.source, selections: toSelections(revision) })),
            };
          }),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async overview(ctx: TenantContext): Promise<OverviewDto> {
    const db = this.dbFactory.for(ctx);
    const now = this.clock.now();
    // Viewers see published surveys only (R06): drafts are absent from their counts and recent list.
    const published: Prisma.SurveyWhereInput = ctx.role === 'VIEWER' ? { state: { not: 'DRAFT' } } : {};
    const [total, eligible, withdrawn, unknown, draft, scheduled, active, closed, archived, recentSurveys, failedMessages, unknownOutcomes, blocked, deadJobs] = await Promise.all([
      db.contact.count({ where: { archivedAt: null } }),
      db.contact.count({ where: { archivedAt: null, consentInvitations: 'GRANTED' } }),
      db.contact.count({ where: { archivedAt: null, consentInvitations: 'WITHDRAWN' } }),
      db.contact.count({ where: { archivedAt: null, consentInvitations: 'UNKNOWN' } }),
      ctx.role === 'VIEWER' ? Promise.resolve(0) : db.survey.count({ where: { archivedAt: null, state: 'DRAFT' } }),
      db.survey.count({ where: { archivedAt: null, state: 'SCHEDULED' } }),
      db.survey.count({ where: { archivedAt: null, state: 'ACTIVE' } }),
      db.survey.count({ where: { archivedAt: null, state: 'CLOSED' } }),
      db.survey.count({ where: { archivedAt: { not: null }, ...published } }),
      db.survey.findMany({ where: { archivedAt: null, ...published }, orderBy: { updatedAt: 'desc' }, take: 6, include: { runs: { where: { kind: 'LIVE', state: { not: 'CANCELED' } }, take: 1 } } }),
      db.message.count({ where: { state: 'FAILED', isTest: false } }),
      db.message.count({ where: { state: 'UNKNOWN', isTest: false } }),
      db.surveyRun.findMany({ where: { dispatchBlockReason: { not: null }, state: { in: ['SCHEDULED', 'ACTIVE'] } }, include: { survey: { select: { id: true, internalTitle: true } } } }),
      db.job.count({ where: { status: 'FAILED' } }),
    ]);
    const recent = [] as OverviewDto['recent'];
    for (const survey of recentSurveys) {
      const run = survey.runs[0];
      const [responded, completed] = run ? await Promise.all([db.participation.count({ where: { runId: run.id, answers: { some: {} } } }), db.participation.count({ where: { runId: run.id, state: 'COMPLETED' } })]) : [0, 0];
      recent.push({ id: survey.id, internalTitle: survey.internalTitle, state: survey.state, opensAt: run?.opensAt.toISOString() ?? null, closesAt: run?.closesAt.toISOString() ?? null, responded, completed });
    }
    return {
      contacts: { total, eligibleForInvitations: eligible, withdrawn, unknown },
      surveys: { draft, scheduled, active, closed, archived },
      recent,
      attention: { failedMessages, unknownOutcomes, blockedRuns: blocked.map((run) => ({ surveyId: run.survey.id, internalTitle: run.survey.internalTitle, reason: run.dispatchBlockReason ?? '' })), deadJobs },
      messagingMode: this.config.MESSAGING_MODE,
      refreshedAt: now.toISOString(),
    };
  }

  async messageDetail(ctx: TenantContext, messageId: string) {
    const db = this.dbFactory.for(ctx);
    const message = await db.message.findUnique({ where: { id: messageId }, include: { contact: { select: { name: true } }, attempts: { orderBy: { attemptNumber: 'asc' } }, statusEvents: { orderBy: { providerAt: 'asc' } } } });
    if (!message) throw notFound('Message');
    if (ctx.role === 'VIEWER') throw forbidden();
    const rendered = message.rendered as { type: string; body?: string; previewText?: string };
    return {
      id: message.id,
      kind: message.kind,
      state: message.state,
      deliveryState: message.deliveryState,
      contactId: message.contactId,
      contactName: message.contact.name,
      runId: message.runId,
      isTest: message.isTest,
      isFreeForm: message.isFreeForm,
      providerMessageId: message.providerMessageId,
      suppressionReason: message.suppressionReason,
      lastErrorCode: message.lastErrorCode,
      createdAt: message.createdAt.toISOString(),
      attempts: message.attempts.map((attempt) => ({ attemptNumber: attempt.attemptNumber, startedAt: attempt.startedAt.toISOString(), finishedAt: attempt.finishedAt?.toISOString() ?? null, outcome: attempt.outcome, providerMessageId: attempt.providerMessageId, errorCode: attempt.errorCode, errorDetail: attempt.errorDetail, authorizedByUserId: attempt.authorizedByUserId })),
      statusEvents: message.statusEvents.map((event) => ({ status: event.status, providerAt: event.providerAt.toISOString(), receivedAt: event.receivedAt.toISOString(), errorCode: event.errorCode })),
      // Question text may be shown to operators; selected answers never appear here.
      renderedSummary: message.kind === 'QUESTION' || message.kind === 'INVITATION' ? ((rendered.body ?? rendered.previewText ?? '').slice(0, 200)) : `[${message.kind}]`,
    };
  }

  assertRunClosed(run: { state: string } | null): void {
    if (!run || run.state !== 'CLOSED') throw new DomainError('SURVEY_STATE_INVALID', 'The survey must be closed first');
  }

  titleOf(revision: RevisionWithQuestions): string {
    return pickLocale(revision.title as LocalizedText, revision.locale);
  }
}
