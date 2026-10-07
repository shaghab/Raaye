import type { AudienceDefinition, LocalizedText, QuestionDto, Renderer, RevisionDto, RunSummaryDto, AudienceSummaryDto } from '@raaye/contracts';
import { authoringTypeOf } from '@raaye/domain';
import type { Prisma, Question, QuestionOption, SurveyRevision, SurveyRun } from '../persistence/prisma.service';

export const revisionInclude = {
  questions: { include: { options: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
} satisfies Prisma.SurveyRevisionInclude;

export type RevisionWithQuestions = Prisma.SurveyRevisionGetPayload<{ include: typeof revisionInclude }>;

export function toQuestionDto(question: Question & { options: QuestionOption[] }): QuestionDto {
  return {
    id: question.id,
    position: question.position,
    type: question.type,
    preset: question.preset,
    authoringType: authoringTypeOf(question.type, question.preset),
    prompt: question.prompt as LocalizedText,
    minSelections: question.minSelections,
    maxSelections: question.maxSelections,
    ratingMinLabel: (question.ratingMinLabel as LocalizedText | null) ?? null,
    ratingMaxLabel: (question.ratingMaxLabel as LocalizedText | null) ?? null,
    renderer: (question.renderer as Renderer | null) ?? null,
    options: question.options.map((option) => ({
      id: option.id,
      code: option.code,
      position: option.position,
      label: option.label as LocalizedText,
      shortLabel: (option.shortLabel as LocalizedText | null) ?? null,
      ratingValue: option.ratingValue,
      exclusive: option.exclusive,
    })),
  };
}

export function toRevisionDto(revision: RevisionWithQuestions): RevisionDto {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    frozenAt: revision.frozenAt?.toISOString() ?? null,
    locale: revision.locale,
    title: revision.title as LocalizedText,
    introduction: revision.introduction as LocalizedText,
    editWindowSeconds: revision.editWindowSeconds,
    durationSeconds: revision.durationSeconds,
    explicitClosesAt: revision.explicitClosesAt?.toISOString() ?? null,
    scheduledOpensAt: revision.scheduledOpensAt?.toISOString() ?? null,
    audience: revision.audienceDefinition as AudienceDefinition,
    questions: revision.questions.map(toQuestionDto),
  };
}

export function toRunSummary(run: SurveyRun & { revision?: Pick<SurveyRevision, 'revisionNumber'> }, revisionNumber?: number): RunSummaryDto {
  return {
    id: run.id,
    kind: run.kind,
    state: run.state,
    opensAt: run.opensAt.toISOString(),
    closesAt: run.closesAt.toISOString(),
    activatedAt: run.activatedAt?.toISOString() ?? null,
    closedAt: run.closedAt?.toISOString() ?? null,
    closeReason: run.closeReason,
    dispatchBlockReason: run.dispatchBlockReason,
    audienceSummary: run.audienceSummary as unknown as AudienceSummaryDto,
    revisionNumber: revisionNumber ?? run.revision?.revisionNumber ?? 0,
    createdAt: run.createdAt.toISOString(),
  };
}
