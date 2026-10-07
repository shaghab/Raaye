import { Inject, Injectable } from '@nestjs/common';
import {
  pickLocale,
  type ContentErrorDto,
  type LocalizedText,
  type Page,
  type PreviewMessageDto,
  type QuestionInput,
  type SurveyCreate,
  type SurveyDetailDto,
  type SurveyListItemDto,
  type SurveyListQuery,
  type SurveyUpdate,
} from '@raaye/contracts';
import { authoringTypeOf, computeClosesAt, copy, validateQuestions, validateTiming, type Clock, type NormalizedQuestion } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, forbidden, invalid, notFound } from '../common/errors';
import { MessagePlanner } from '../messaging/planner';
import { MessagingReadinessService } from '../messaging/readiness.service';
import type { RenderedMessage } from '../messaging/rendered';
import { asJson, asJsonOrNull } from '../persistence/json';
import type { Prisma, Survey } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';
import { revisionInclude, toRevisionDto, toRunSummary, type RevisionWithQuestions } from './survey-mapper';

type SurveyWithRevisions = Survey & { revisions: RevisionWithQuestions[]; runs: Prisma.SurveyRunGetPayload<{ include: { revision: { select: { revisionNumber: true } } } }>[] };

const surveyInclude = (revisionNumber?: number) =>
  ({
    revisions: { where: revisionNumber ? { revisionNumber } : undefined, include: revisionInclude, orderBy: { revisionNumber: 'desc' as const }, take: 1 },
    runs: { include: { revision: { select: { revisionNumber: true } } }, orderBy: { createdAt: 'desc' as const } },
  }) satisfies Prisma.SurveyInclude;

@Injectable()
export class SurveysService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    private readonly planner: MessagePlanner,
    private readonly readiness: MessagingReadinessService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext, query: SurveyListQuery): Promise<Page<SurveyListItemDto>> {
    const db = this.dbFactory.for(ctx);
    const where: Prisma.SurveyWhereInput = {
      archivedAt: query.archived ? { not: null } : null,
      state: query.state,
      internalTitle: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };
    const [items, total] = await Promise.all([
      db.survey.findMany({ where, include: surveyInclude(), orderBy: { updatedAt: 'desc' }, take: query.limit, skip: query.offset }),
      db.survey.count({ where }),
    ]);
    const liveRunIds = items.map((survey) => survey.runs.find((run) => run.kind === 'LIVE' && run.state !== 'CANCELED')?.id).filter((id): id is string => Boolean(id));
    const responded = liveRunIds.length
      ? await db.participation.groupBy({ by: ['runId'], where: { runId: { in: liveRunIds }, answers: { some: {} } }, _count: { _all: true } })
      : [];
    const respondedByRun = new Map(responded.map((row) => [row.runId, row._count._all]));
    return {
      items: items.map((survey) => {
        const revision = survey.revisions[0];
        const liveRun = survey.runs.find((run) => run.kind === 'LIVE' && run.state !== 'CANCELED') ?? null;
        return {
          id: survey.id,
          internalTitle: survey.internalTitle,
          title: (revision?.title as LocalizedText) ?? { en: survey.internalTitle },
          state: survey.state,
          archivedAt: survey.archivedAt?.toISOString() ?? null,
          questionCount: revision?.questions.length ?? 0,
          opensAt: liveRun?.opensAt.toISOString() ?? revision?.scheduledOpensAt?.toISOString() ?? null,
          closesAt: liveRun?.closesAt.toISOString() ?? null,
          respondedCount: liveRun ? (respondedByRun.get(liveRun.id) ?? 0) : 0,
          updatedAt: survey.updatedAt.toISOString(),
          createdAt: survey.createdAt.toISOString(),
        };
      }),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async create(ctx: TenantContext, input: SurveyCreate): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    this.assertTimingPermission(ctx, input, { editWindowSeconds: org.defaultEditWindowSeconds, durationSeconds: org.defaultDurationSeconds, explicitClosesAt: null });
    const questions = input.questions ?? [];
    const { normalized } = validateQuestions(questions.length ? questions : [{ authoringType: 'YES_NO', prompt: { en: 'Do you support this proposal?' } }], input.locale ?? 'en');
    const surveyId = await db.$transaction(async (tx) => {
      const survey = await tx.survey.create({ data: { organizationId: ctx.organizationId, internalTitle: input.internalTitle, authorUserId: ctx.userId, state: 'DRAFT', currentRevisionNumber: 1 } });
      const revision = await tx.surveyRevision.create({
        data: {
          organizationId: ctx.organizationId,
          surveyId: survey.id,
          revisionNumber: 1,
          locale: input.locale ?? 'en',
          title: asJson(input.title ?? { en: input.internalTitle }),
          introduction: asJson(input.introduction ?? { en: `${org.name} would like to hear your views.` }),
          editWindowSeconds: input.editWindowSeconds ?? org.defaultEditWindowSeconds,
          durationSeconds: input.durationSeconds ?? org.defaultDurationSeconds,
          explicitClosesAt: input.explicitClosesAt ? new Date(input.explicitClosesAt) : null,
          scheduledOpensAt: input.scheduledOpensAt ? new Date(input.scheduledOpensAt) : null,
          audienceDefinition: asJson(input.audience ?? { mode: 'EVERYONE', groupTagMatch: 'ANY' }),
        },
      });
      await this.writeQuestions(tx, ctx.organizationId, revision.id, normalized, []);
      await this.audit.record(ctx, { action: 'survey.created', resourceType: 'survey', resourceId: survey.id }, tx);
      return survey.id;
    });
    return this.get(ctx, surveyId);
  }

  async update(ctx: TenantContext, surveyId: string, input: SurveyUpdate): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    await db.$transaction(async (tx) => {
      // Survey row lock shared with launch and archive: the state and the revision are read and
      // validated under it, so an edit can neither overwrite a revision a launch is freezing nor
      // install a new revision on a survey that just became active.
      await tx.$queryRaw`SELECT id FROM surveys WHERE id = ${surveyId}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
      const survey = await this.load(tx, surveyId);
      if (survey.archivedAt) throw new DomainError('SURVEY_STATE_INVALID', 'Archived surveys are read-only');
      if (survey.state !== 'DRAFT') throw new DomainError('SURVEY_STATE_INVALID', `A ${survey.state.toLowerCase()} survey cannot be edited; unschedule or clone it first`);
      const current = survey.revisions[0];
      this.assertTimingPermission(ctx, input, { editWindowSeconds: current.editWindowSeconds, durationSeconds: current.durationSeconds, explicitClosesAt: current.explicitClosesAt?.toISOString() ?? null });
      const locale = input.locale ?? current.locale;
      const questionInputs: QuestionInput[] | null = input.questions ?? null;
      const normalized = questionInputs ? validateQuestions(questionInputs, locale).normalized : null;
      let revision = current;
      const hasRuns = await tx.surveyRun.count({ where: { revisionId: current.id } });
      if (current.frozenAt || hasRuns > 0) {
        revision = await this.cloneRevision(tx, ctx.organizationId, survey, current);
        await tx.survey.update({ where: { id: survey.id }, data: { currentRevisionNumber: revision.revisionNumber } });
      }
      await tx.surveyRevision.update({
        where: { id: revision.id },
        data: {
          locale,
          title: input.title ? asJson(input.title) : undefined,
          introduction: input.introduction ? asJson(input.introduction) : undefined,
          editWindowSeconds: input.editWindowSeconds,
          durationSeconds: input.durationSeconds,
          explicitClosesAt: input.explicitClosesAt === undefined ? undefined : input.explicitClosesAt ? new Date(input.explicitClosesAt) : null,
          scheduledOpensAt: input.scheduledOpensAt === undefined ? undefined : input.scheduledOpensAt ? new Date(input.scheduledOpensAt) : null,
          audienceDefinition: input.audience ? asJson(input.audience) : undefined,
        },
      });
      if (input.internalTitle) await tx.survey.update({ where: { id: survey.id }, data: { internalTitle: input.internalTitle } });
      if (normalized) await this.writeQuestions(tx, ctx.organizationId, revision.id, normalized, revision.questions);
      await this.audit.record(ctx, { action: 'survey.updated', resourceType: 'survey', resourceId: survey.id, metadata: { fields: Object.keys(input), revision: revision.revisionNumber } }, tx);
    });
    return this.get(ctx, surveyId);
  }

  async get(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    const db = this.dbFactory.for(ctx);
    const survey = await this.load(db, surveyId);
    const revision = survey.revisions[0];
    const liveRun = survey.runs.find((run) => run.kind === 'LIVE' && run.state !== 'CANCELED') ?? null;
    const contentErrors = this.contentErrors(revision);
    const readiness = await this.readiness.check(ctx, { needFlows: flowsNeeded(revision) });
    return {
      id: survey.id,
      internalTitle: survey.internalTitle,
      state: survey.state,
      archivedAt: survey.archivedAt?.toISOString() ?? null,
      authorUserId: survey.authorUserId,
      clonedFromSurveyId: survey.clonedFromSurveyId,
      revision: toRevisionDto(revision),
      liveRun: liveRun ? toRunSummary(liveRun) : null,
      testRuns: survey.runs.filter((run) => run.kind === 'TEST').map((run) => toRunSummary(run)),
      readiness: { ok: readiness.ok, messagingMode: readiness.connection?.mode === 'LIVE' ? 'live' : 'mock', blockers: readiness.blockers, warnings: readiness.warnings },
      contentErrors,
      createdAt: survey.createdAt.toISOString(),
      updatedAt: survey.updatedAt.toISOString(),
    };
  }

  async clone(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const survey = await this.load(db, surveyId);
    const source = survey.revisions[0];
    const newId = await db.$transaction(async (tx) => {
      const created = await tx.survey.create({ data: { organizationId: ctx.organizationId, internalTitle: `${survey.internalTitle} (copy)`.slice(0, 150), authorUserId: ctx.userId, state: 'DRAFT', currentRevisionNumber: 1, clonedFromSurveyId: survey.id } });
      await this.cloneRevision(tx, ctx.organizationId, created, source, 1, true);
      await this.audit.record(ctx, { action: 'survey.cloned', resourceType: 'survey', resourceId: created.id, metadata: { from: survey.id } }, tx);
      return created.id;
    });
    return this.get(ctx, newId);
  }

  async archive(ctx: TenantContext, surveyId: string, cancelScheduled: (tx: TenantTx, runId: string) => Promise<void>): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    await db.$transaction(async (tx) => {
      // Survey row lock: a concurrent launch either commits first (the survey is then active and
      // archiving is refused) or waits for this archive and fails its draft guard.
      await tx.$queryRaw`SELECT id FROM surveys WHERE id = ${surveyId}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
      const survey = await this.load(tx, surveyId);
      if (survey.state === 'ACTIVE') throw new DomainError('SURVEY_STATE_INVALID', 'Close the survey before archiving it');
      const scheduled = survey.runs.find((run) => run.kind === 'LIVE' && run.state === 'SCHEDULED');
      if (scheduled) await cancelScheduled(tx, scheduled.id);
      const guard = await tx.survey.updateMany({ where: { id: survey.id, state: survey.state }, data: { archivedAt: survey.archivedAt ?? this.clock.now(), state: survey.state === 'SCHEDULED' ? 'DRAFT' : survey.state } });
      if (guard.count !== 1) throw new DomainError('SURVEY_STATE_INVALID', 'The survey changed concurrently; reload and try again');
      await this.audit.record(ctx, { action: 'survey.archived', resourceType: 'survey', resourceId: survey.id }, tx);
    });
    return this.get(ctx, surveyId);
  }

  async unarchive(ctx: TenantContext, surveyId: string): Promise<SurveyDetailDto> {
    if (ctx.role === 'VIEWER') throw forbidden();
    const db = this.dbFactory.for(ctx);
    const survey = await this.load(db, surveyId);
    await db.survey.update({ where: { id: survey.id }, data: { archivedAt: null } });
    await this.audit.record(ctx, { action: 'survey.unarchived', resourceType: 'survey', resourceId: survey.id });
    return this.get(ctx, surveyId);
  }

  /** Render every participant-facing message without sending anything or minting bindings. */
  async preview(ctx: TenantContext, surveyId: string): Promise<PreviewMessageDto[]> {
    const db = this.dbFactory.for(ctx);
    const survey = await this.load(db, surveyId);
    const revision = survey.revisions[0];
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    const orgCopy = this.planner.org(org);
    const title = pickLocale(revision.title as LocalizedText, revision.locale);
    const previews: PreviewMessageDto[] = [];
    previews.push({ questionId: null, kind: 'INVITATION', renderer: 'TEMPLATE', text: copy.invitation(orgCopy, title), controls: [{ id: 'start', label: copy.invitationButton }] });
    const intro = this.planner.introduction(orgCopy, revision.title as LocalizedText, revision.introduction as LocalizedText, revision.questions.length, revision.editWindowSeconds, revision.locale, '');
    previews.push({ questionId: null, kind: 'INTRODUCTION', renderer: 'TEXT', text: intro.type === 'text' ? intro.body : '', controls: [] });
    if (org.profileOnboardingEnabled) {
      previews.push({ questionId: null, kind: 'PROFILE_OFFER', renderer: 'BUTTONS', text: copy.profileOffer(orgCopy), controls: [{ id: 'accept', label: copy.profileOfferAccept }, { id: 'skip', label: copy.profileOfferSkip }] });
    }
    const contact = { id: '00000000-0000-4000-8000-000000000000', connectionId: '00000000-0000-4000-8000-000000000000' };
    for (const [index, question] of revision.questions.entries()) {
      const { rendered, renderer } = await this.planner.question(null, {
        organizationId: ctx.organizationId,
        contact,
        mode: 'TEST',
        runId: 'preview',
        participationId: 'preview',
        question,
        position: index + 1,
        total: revision.questions.length,
        locale: revision.locale,
        expiresAt: this.clock.now(),
        currentOptionIds: [],
        prefix: '',
        isEdit: false,
      });
      previews.push({ questionId: question.id, kind: 'QUESTION', renderer, ...describeRendered(rendered) });
    }
    const completion = this.planner.completion(revision.editWindowSeconds, '');
    previews.push({ questionId: null, kind: 'COMPLETION', renderer: 'TEXT', text: completion.type === 'text' ? completion.body : '', controls: [] });
    return previews;
  }

  contentErrors(revision: RevisionWithQuestions): ContentErrorDto[] {
    const inputs: QuestionInput[] = revision.questions.map((question) => ({
      id: question.id,
      authoringType: authoringTypeOf(question.type, question.preset),
      prompt: question.prompt as LocalizedText,
      options: question.type === 'RATING' || question.preset !== 'CUSTOM' ? undefined : question.options.map((option) => ({ id: option.id, code: option.code, label: option.label as LocalizedText, shortLabel: (option.shortLabel as LocalizedText | null) ?? undefined, exclusive: option.exclusive })),
      minSelections: question.minSelections ?? undefined,
      maxSelections: question.maxSelections ?? undefined,
      ratingMinLabel: (question.ratingMinLabel as LocalizedText | null) ?? undefined,
      ratingMaxLabel: (question.ratingMaxLabel as LocalizedText | null) ?? undefined,
    }));
    const errors = validateQuestions(inputs, revision.locale).errors;
    const timing = validateTiming({ now: this.clock.now(), opensAt: revision.scheduledOpensAt ?? this.clock.now(), durationSeconds: revision.durationSeconds, editWindowSeconds: revision.editWindowSeconds, explicitClosesAt: revision.explicitClosesAt, scheduled: false });
    return [...errors, ...timing.map((error) => ({ questionIndex: null, optionIndex: null, code: error.code, message: error.message }))];
  }

  async load(db: TenantTx, surveyId: string): Promise<SurveyWithRevisions> {
    const survey = await db.survey.findUnique({ where: { id: surveyId }, include: surveyInclude() });
    if (!survey || survey.revisions.length === 0) throw notFound('Survey');
    const current = await db.surveyRevision.findFirst({ where: { surveyId, revisionNumber: survey.currentRevisionNumber }, include: revisionInclude });
    return { ...survey, revisions: [current ?? survey.revisions[0]] };
  }

  async cloneRevision(tx: TenantTx, organizationId: string, target: Survey, source: RevisionWithQuestions, revisionNumber?: number, keepIds = false): Promise<RevisionWithQuestions> {
    const number = revisionNumber ?? (await tx.surveyRevision.count({ where: { surveyId: target.id } })) + 1;
    const revision = await tx.surveyRevision.create({
      data: {
        organizationId,
        surveyId: target.id,
        revisionNumber: number,
        locale: source.locale,
        title: asJson(source.title),
        introduction: asJson(source.introduction),
        editWindowSeconds: source.editWindowSeconds,
        durationSeconds: source.durationSeconds,
        explicitClosesAt: keepIds ? null : source.explicitClosesAt,
        scheduledOpensAt: keepIds ? null : source.scheduledOpensAt,
        audienceDefinition: asJson(source.audienceDefinition),
      },
    });
    for (const question of source.questions) {
      const created = await tx.question.create({
        data: { organizationId, revisionId: revision.id, position: question.position, type: question.type, preset: question.preset, prompt: asJson(question.prompt), minSelections: question.minSelections, maxSelections: question.maxSelections, ratingMinLabel: question.ratingMinLabel === null ? undefined : asJson(question.ratingMinLabel), ratingMaxLabel: question.ratingMaxLabel === null ? undefined : asJson(question.ratingMaxLabel), renderer: question.renderer },
      });
      await tx.questionOption.createMany({
        data: question.options.map((option) => ({ organizationId, questionId: created.id, code: option.code, position: option.position, label: asJson(option.label), shortLabel: option.shortLabel === null ? undefined : asJson(option.shortLabel), ratingValue: option.ratingValue, exclusive: option.exclusive })),
      });
    }
    const loaded = await tx.surveyRevision.findUniqueOrThrow({ where: { id: revision.id }, include: revisionInclude });
    return loaded;
  }

  /** Replace the question set of an unfrozen revision while preserving stable ids. */
  private async writeQuestions(tx: TenantTx, organizationId: string, revisionId: string, normalized: NormalizedQuestion[], existing: RevisionWithQuestions['questions']): Promise<void> {
    const existingById = new Map(existing.map((question) => [question.id, question]));
    const keepIds = new Set(normalized.map((question) => question.id).filter((id): id is string => Boolean(id)));
    for (const question of existing) {
      if (!keepIds.has(question.id)) {
        await tx.questionOption.deleteMany({ where: { questionId: question.id } });
        await tx.question.delete({ where: { id: question.id } });
      }
    }
    // Move surviving questions out of the way to avoid transient position collisions.
    for (const [index, question] of normalized.entries()) {
      if (question.id && existingById.has(question.id)) await tx.question.update({ where: { id: question.id }, data: { position: 1000 + index } });
    }
    for (const question of normalized) {
      const data = {
        position: question.position,
        type: question.type,
        preset: question.preset,
        prompt: asJson(question.prompt),
        minSelections: question.minSelections,
        maxSelections: question.maxSelections,
        ratingMinLabel: question.ratingMinLabel ? asJson(question.ratingMinLabel) : undefined,
        ratingMaxLabel: question.ratingMaxLabel ? asJson(question.ratingMaxLabel) : undefined,
        renderer: question.renderer,
      };
      let questionId: string;
      const previous = question.id ? existingById.get(question.id) : undefined;
      if (previous) {
        questionId = previous.id;
        await tx.question.update({ where: { id: questionId }, data: { ...data, ratingMinLabel: asJsonOrNull(question.ratingMinLabel), ratingMaxLabel: asJsonOrNull(question.ratingMaxLabel) } });
        const previousOptions = new Map(previous.options.map((option) => [option.id, option]));
        const keepOptionIds = new Set(question.options.map((option) => option.id).filter((id): id is string => Boolean(id)));
        for (const option of previous.options) if (!keepOptionIds.has(option.id)) await tx.questionOption.delete({ where: { id: option.id } });
        for (const [index, option] of question.options.entries()) {
          if (option.id && previousOptions.has(option.id)) await tx.questionOption.update({ where: { id: option.id }, data: { position: 1000 + index } });
        }
        for (const option of question.options) {
          const optionData = { code: option.code, position: option.position, label: asJson(option.label), shortLabel: asJsonOrNull(option.shortLabel), ratingValue: option.ratingValue, exclusive: option.exclusive };
          if (option.id && previousOptions.has(option.id)) await tx.questionOption.update({ where: { id: option.id }, data: optionData });
          else await tx.questionOption.create({ data: { organizationId, questionId, ...optionData, shortLabel: option.shortLabel ? asJson(option.shortLabel) : undefined } });
        }
      } else {
        const created = await tx.question.create({ data: { organizationId, revisionId, ...data } });
        questionId = created.id;
        await tx.questionOption.createMany({
          data: question.options.map((option) => ({ organizationId, questionId, code: option.code, position: option.position, label: asJson(option.label), shortLabel: option.shortLabel ? asJson(option.shortLabel) : undefined, ratingValue: option.ratingValue, exclusive: option.exclusive })),
        });
      }
    }
  }

  /** Only Admin changes timing; Survey Managers may echo unchanged values. */
  private assertTimingPermission(ctx: TenantContext, input: { editWindowSeconds?: number; durationSeconds?: number; explicitClosesAt?: string | null }, current: { editWindowSeconds: number; durationSeconds: number; explicitClosesAt: string | null }): void {
    if (ctx.role === 'ADMIN') return;
    const changed =
      (input.editWindowSeconds !== undefined && input.editWindowSeconds !== current.editWindowSeconds) ||
      (input.durationSeconds !== undefined && input.durationSeconds !== current.durationSeconds) ||
      (input.explicitClosesAt !== undefined && (input.explicitClosesAt ?? null) !== (current.explicitClosesAt ?? null));
    if (changed) throw new DomainError('ROLE_FORBIDDEN', 'Only an Admin can change the survey duration, closing time or answer edit window');
  }

  effectiveCloses(revision: { durationSeconds: number; explicitClosesAt: Date | null }, opensAt: Date): Date {
    return computeClosesAt({ opensAt, durationSeconds: revision.durationSeconds, explicitClosesAt: revision.explicitClosesAt });
  }

  assertNoContentErrors(revision: RevisionWithQuestions): void {
    const errors = this.contentErrors(revision);
    if (errors.length) throw new DomainError('SURVEY_CONTENT_INVALID', 'Fix the survey content before launching', { errors });
  }
}

export function flowsNeeded(revision: RevisionWithQuestions): ('SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE')[] {
  const needed = new Set<'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE'>();
  for (const question of revision.questions) {
    if (question.renderer === 'FLOW_MULTI') needed.add('MULTI_CHOICE');
    if (question.renderer === 'FLOW_SINGLE') needed.add('SINGLE_CHOICE');
  }
  return Array.from(needed);
}

function describeRendered(rendered: RenderedMessage): Pick<PreviewMessageDto, 'text' | 'controls' | 'flow'> {
  switch (rendered.type) {
    case 'buttons':
      return { text: rendered.body, controls: rendered.buttons.map((button) => ({ id: button.id, label: button.title })) };
    case 'list':
      return { text: rendered.body, controls: rendered.sections.flatMap((section) => section.rows.map((row) => ({ id: row.id, label: row.title, description: row.description }))) };
    case 'flow':
      return { text: rendered.body, controls: [{ id: 'open', label: rendered.cta }], flow: { purpose: rendered.purpose, fields: rendered.data } };
    case 'template':
      return { text: rendered.previewText, controls: rendered.previewButtons.map((button) => ({ id: button.id, label: button.title })) };
    case 'text':
      return { text: rendered.body, controls: [] };
  }
}

export function assertInvalidIfErrors(errors: ContentErrorDto[]): void {
  if (errors.length) throw invalid('Survey content is invalid', errors.map((error) => ({ path: error.questionIndex === null ? 'questions' : `questions.${error.questionIndex}`, message: error.message })));
}
