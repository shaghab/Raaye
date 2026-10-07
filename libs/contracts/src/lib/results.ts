import { z } from 'zod';
import { DEMOGRAPHIC_DIMENSIONS, type DemographicDimension, type QuestionType } from './enums';
import { type LocalizedText, uuidSchema } from './common';
import { LIMITS } from './limits';

export interface OptionResultDto {
  optionId: string;
  code: string;
  label: LocalizedText;
  ratingValue: number | null;
  count: number;
  /** Percentage of valid respondents; null when the denominator is zero. */
  percentage: number | null;
}

export interface QuestionResultDto {
  questionId: string;
  position: number;
  type: QuestionType;
  prompt: LocalizedText;
  validAnswers: number;
  unansweredAmongStarted: number;
  options: OptionResultDto[];
  ratingMean: number | null;
  percentagesMaySumOver100: boolean;
}

export interface ResultsDto {
  surveyId: string;
  runId: string | null;
  revisionNumber: number;
  started: number;
  responded: number;
  completed: number;
  questions: QuestionResultDto[];
  refreshedAt: string;
  isSnapshot: boolean;
}

export interface CohortBreakdownDto {
  cohort: string;
  label: string;
  /** Null when the cohort is suppressed by the disclosure threshold. */
  respondents: number | null;
  suppressed: boolean;
  options: { optionId: string; count: number; percentage: number | null }[];
}

export interface QuestionBreakdownDto {
  questionId: string;
  position: number;
  prompt: LocalizedText;
  type: QuestionType;
  options: { optionId: string; label: LocalizedText }[];
  cohorts: CohortBreakdownDto[];
}

export interface BreakdownDto {
  dimension: DemographicDimension;
  threshold: number;
  thresholdApplied: boolean;
  questions: QuestionBreakdownDto[];
  refreshedAt: string;
}

export const breakdownQuerySchema = z.object({
  dimension: z.enum(DEMOGRAPHIC_DIMENSIONS),
  questionId: uuidSchema.optional(),
});

export interface ResponseAnswerDto {
  questionId: string;
  position: number;
  selections: { optionId: string; code: string; label: LocalizedText; ratingValue: number | null }[];
  firstAcceptedAt: string;
  editExpiresAt: string;
  currentRevisionNumber: number;
  lastAcceptedAt: string;
  revisions: {
    revisionNumber: number;
    acceptedAt: string;
    source: string;
    selections: { optionId: string; code: string; label: LocalizedText; ratingValue: number | null }[];
  }[];
}

export interface IndividualResponseDto {
  participationId: string;
  contactId: string;
  contactName: string;
  phoneE164: string;
  state: 'STARTED' | 'COMPLETED';
  startedAt: string;
  completedAt: string | null;
  analysisProfile: Record<string, string | null> | null;
  answers: ResponseAnswerDto[];
}

export const responsesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pagination.max).default(LIMITS.pagination.default),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(100).optional(),
  state: z.enum(['STARTED', 'COMPLETED']).optional(),
});

export const EXPORT_TYPES = ['aggregates', 'breakdowns', 'responses', 'revisions'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  dimension: z.enum(DEMOGRAPHIC_DIMENSIONS).optional(),
});

export interface ResultSharePreviewDto {
  surveyId: string;
  eligibleRecipients: number;
  excluded: Record<string, number>;
  questions: {
    questionId: string;
    position: number;
    prompt: LocalizedText;
    validAnswers: number;
    shareable: boolean;
    reason: string | null;
  }[];
  canShare: boolean;
  reason: string | null;
  minimumRespondents: number;
  messagePreview: string;
  summaryPreview: string[];
  alreadyShared: boolean;
}

export const shareResultsSchema = z.object({
  confirm: z.literal(true),
});

export interface ResultSharingDto {
  snapshot: {
    id: string;
    generatedAt: string;
    createdByUserId: string;
    createdByEmail: string | null;
    formatVersion: number;
    eligibleCount: number;
    suppressedCount: number;
    questionsShared: number;
    questionsSuppressed: number;
    broadcastState: string;
    revokedAt: string | null;
  } | null;
  recipients: {
    total: number;
    byState: Record<string, number>;
    byDelivery: Record<string, number>;
  } | null;
}
