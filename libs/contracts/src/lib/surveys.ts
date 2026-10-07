import { z } from 'zod';
import {
  AGE_BANDS,
  AUDIENCE_MODES,
  AUTHORING_TYPES,
  GENDERS,
  MEMBERSHIP_KINDS,
  type AudienceMode,
  type AuthoringType,
  type DeliveryState,
  type InvitationState,
  type QuestionPreset,
  type QuestionType,
  type Renderer,
  type RunKind,
  type RunState,
  type SurveyState,
} from './enums';
import { isoDateTimeSchema, localizedText, uuidSchema, type LocalizedText } from './common';
import { LIMITS } from './limits';

export const optionInputSchema = z.object({
  id: uuidSchema.optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{1,24}$/)
    .optional(),
  label: localizedText(LIMITS.optionLabel.max),
  shortLabel: localizedText(24).optional(),
  exclusive: z.boolean().optional(),
});
export type OptionInput = z.infer<typeof optionInputSchema>;

export const questionInputSchema = z
  .object({
    id: uuidSchema.optional(),
    authoringType: z.enum(AUTHORING_TYPES),
    prompt: localizedText(LIMITS.questionPrompt.max),
    options: z.array(optionInputSchema).max(LIMITS.optionsPerQuestion.max).optional(),
    minSelections: z.number().int().min(0).max(LIMITS.optionsPerQuestion.max).optional(),
    maxSelections: z.number().int().min(1).max(LIMITS.optionsPerQuestion.max).optional(),
    ratingMinLabel: localizedText(24).optional(),
    ratingMaxLabel: localizedText(24).optional(),
  })
  .superRefine((question, ctx) => {
    const needsOptions = question.authoringType === 'SINGLE_CHOICE' || question.authoringType === 'MULTI_CHOICE';
    if (needsOptions) {
      const count = question.options?.length ?? 0;
      if (count < LIMITS.optionsPerQuestion.min || count > LIMITS.optionsPerQuestion.max) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: `Provide between ${LIMITS.optionsPerQuestion.min} and ${LIMITS.optionsPerQuestion.max} options`,
        });
      }
    } else if (question.options && question.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'This question type has fixed options' });
    }
    if (question.authoringType === 'MULTI_CHOICE') {
      const count = question.options?.length ?? 0;
      const min = question.minSelections ?? 1;
      const max = question.maxSelections ?? count;
      if (min > max) {
        ctx.addIssue({ code: 'custom', path: ['minSelections'], message: 'Minimum cannot exceed maximum' });
      }
      if (max > count && count > 0) {
        ctx.addIssue({ code: 'custom', path: ['maxSelections'], message: 'Maximum cannot exceed option count' });
      }
      if (min < 1) {
        ctx.addIssue({ code: 'custom', path: ['minSelections'], message: 'At least one selection is required' });
      }
    } else if (question.minSelections !== undefined || question.maxSelections !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['minSelections'], message: 'Selection limits apply to multiple selection only' });
    }
    if (question.authoringType !== 'RATING' && (question.ratingMinLabel || question.ratingMaxLabel)) {
      ctx.addIssue({ code: 'custom', path: ['ratingMinLabel'], message: 'Endpoint labels apply to ratings only' });
    }
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const contactFilterSchema = z.object({
  city: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  district: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  gender: z.array(z.enum(GENDERS)).optional(),
  ageBand: z.array(z.enum(AGE_BANDS)).optional(),
  occupation: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  membership: z.array(z.enum(MEMBERSHIP_KINDS)).optional(),
});
export type ContactFilter = z.infer<typeof contactFilterSchema>;

export const audienceDefinitionSchema = z
  .object({
    mode: z.enum(AUDIENCE_MODES),
    contactIds: z.array(uuidSchema).max(10_000).optional(),
    groupIds: z.array(uuidSchema).max(100).optional(),
    tagIds: z.array(uuidSchema).max(100).optional(),
    groupTagMatch: z.enum(['ANY', 'ALL']).default('ANY'),
    filters: contactFilterSchema.optional(),
    exclude: z
      .object({
        contactIds: z.array(uuidSchema).max(10_000).optional(),
        groupIds: z.array(uuidSchema).max(100).optional(),
        tagIds: z.array(uuidSchema).max(100).optional(),
      })
      .optional(),
  })
  .superRefine((audience, ctx) => {
    if (audience.mode === 'SELECTED' && (audience.contactIds?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['contactIds'], message: 'Select at least one contact' });
    }
    if (
      audience.mode === 'GROUPS_TAGS' &&
      (audience.groupIds?.length ?? 0) + (audience.tagIds?.length ?? 0) === 0
    ) {
      ctx.addIssue({ code: 'custom', path: ['groupIds'], message: 'Select at least one group or tag' });
    }
  });
export type AudienceDefinition = z.infer<typeof audienceDefinitionSchema>;

export const surveyDraftSchema = z.object({
  internalTitle: z.string().trim().min(1).max(LIMITS.internalTitle.max),
  title: localizedText(LIMITS.surveyTitle.max),
  introduction: localizedText(LIMITS.introduction.max),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default('en'),
  questions: z.array(questionInputSchema).min(LIMITS.questionsPerSurvey.min).max(LIMITS.questionsPerSurvey.max),
  audience: audienceDefinitionSchema,
  /** Admin-only timing settings. Managers must omit or echo the current values. */
  editWindowSeconds: z
    .number()
    .int()
    .min(LIMITS.editWindowSeconds.min)
    .max(LIMITS.editWindowSeconds.max)
    .optional(),
  durationSeconds: z
    .number()
    .int()
    .min(LIMITS.durationSeconds.min)
    .max(LIMITS.durationSeconds.max)
    .optional(),
  explicitClosesAt: isoDateTimeSchema.nullable().optional(),
  scheduledOpensAt: isoDateTimeSchema.nullable().optional(),
});
export type SurveyDraft = z.infer<typeof surveyDraftSchema>;

export const surveyCreateSchema = surveyDraftSchema.partial({
  questions: true,
  audience: true,
  title: true,
  introduction: true,
});
export type SurveyCreate = z.infer<typeof surveyCreateSchema>;

export const surveyUpdateSchema = surveyDraftSchema.partial();
export type SurveyUpdate = z.infer<typeof surveyUpdateSchema>;

export const surveyListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pagination.max).default(LIMITS.pagination.default),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(100).optional(),
  state: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED']).optional(),
  archived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((value) => value === true || value === 'true')
    .default(false),
});
export type SurveyListQuery = z.infer<typeof surveyListQuerySchema>;

export const launchRequestSchema = z.object({
  mode: z.enum(['NOW', 'SCHEDULED']),
  opensAt: isoDateTimeSchema.optional(),
  /** Staff confirm the live-send charge notice; required in live mode. */
  acknowledgeCharges: z.boolean().optional(),
});
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export const testRunRequestSchema = z.object({
  contactIds: z.array(uuidSchema).min(1).max(20),
  /** Independent test clock: duration for the test run; defaults to the draft duration. */
  durationSeconds: z
    .number()
    .int()
    .min(60)
    .max(LIMITS.durationSeconds.max)
    .optional(),
});
export type TestRunRequest = z.infer<typeof testRunRequestSchema>;

export interface OptionDto {
  id: string;
  code: string;
  position: number;
  label: LocalizedText;
  shortLabel: LocalizedText | null;
  ratingValue: number | null;
  exclusive: boolean;
}

export interface QuestionDto {
  id: string;
  position: number;
  type: QuestionType;
  preset: QuestionPreset;
  authoringType: AuthoringType;
  prompt: LocalizedText;
  minSelections: number | null;
  maxSelections: number | null;
  ratingMinLabel: LocalizedText | null;
  ratingMaxLabel: LocalizedText | null;
  renderer: Renderer | null;
  options: OptionDto[];
}

export interface RevisionDto {
  id: string;
  revisionNumber: number;
  frozenAt: string | null;
  locale: string;
  title: LocalizedText;
  introduction: LocalizedText;
  editWindowSeconds: number;
  durationSeconds: number;
  explicitClosesAt: string | null;
  scheduledOpensAt: string | null;
  audience: AudienceDefinition;
  questions: QuestionDto[];
}

export interface RunSummaryDto {
  id: string;
  kind: RunKind;
  state: RunState;
  opensAt: string;
  closesAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  dispatchBlockReason: string | null;
  audienceSummary: AudienceSummaryDto;
  revisionNumber: number;
  createdAt: string;
}

export interface AudienceSummaryDto {
  selected: number;
  eligible: number;
  exclusions: Record<string, number>;
}

export interface SurveyListItemDto {
  id: string;
  internalTitle: string;
  title: LocalizedText;
  state: SurveyState;
  archivedAt: string | null;
  questionCount: number;
  opensAt: string | null;
  closesAt: string | null;
  respondedCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface SurveyDetailDto {
  id: string;
  internalTitle: string;
  state: SurveyState;
  archivedAt: string | null;
  authorUserId: string | null;
  clonedFromSurveyId: string | null;
  revision: RevisionDto;
  liveRun: RunSummaryDto | null;
  testRuns: RunSummaryDto[];
  readiness: ReadinessDto;
  contentErrors: ContentErrorDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ContentErrorDto {
  questionIndex: number | null;
  optionIndex: number | null;
  code: string;
  message: string;
}

export interface ReadinessDto {
  ok: boolean;
  messagingMode: 'mock' | 'live';
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

export interface PreviewMessageDto {
  questionId: string | null;
  kind: 'INVITATION' | 'INTRODUCTION' | 'QUESTION' | 'PROFILE_OFFER' | 'COMPLETION';
  renderer: Renderer | 'TEXT' | 'TEMPLATE';
  text: string;
  controls: { id: string; label: string; description?: string }[];
  flow?: { purpose: 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE'; fields: unknown };
}

export interface AudiencePreviewDto {
  mode: AudienceMode;
  selected: number;
  eligible: number;
  exclusions: Record<string, number>;
  sample: { contactId: string; name: string; eligible: boolean; reason: string | null }[];
}

export interface DispatchMetricsDto {
  selected: number;
  eligibleAtLaunch: number;
  queued: number;
  providerAccepted: number;
  delivered: number;
  started: number;
  responded: number;
  completed: number;
  failed: number;
  suppressed: number;
  unknown: number;
  responseRate: number | null;
  completionRate: number | null;
  deliveredRespondents: number;
  refreshedAt: string;
}

export interface DispatchRecipientDto {
  recipientId: string;
  contactId: string;
  contactName: string;
  phoneE164: string;
  eligibleAtFreeze: boolean;
  exclusionReason: string | null;
  invitationState: InvitationState | null;
  deliveryState: DeliveryState | null;
  lastErrorCode: string | null;
  messageId: string | null;
  attempts: number;
  participationState: 'NOT_STARTED' | 'STARTED' | 'COMPLETED';
  answeredCount: number;
}

export interface DispatchDto {
  run: RunSummaryDto | null;
  metrics: DispatchMetricsDto | null;
  recipients: { items: DispatchRecipientDto[]; total: number; limit: number; offset: number };
}

export const dispatchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pagination.max).default(LIMITS.pagination.default),
  offset: z.coerce.number().int().min(0).default(0),
  state: z.string().trim().max(30).optional(),
  search: z.string().trim().max(100).optional(),
  runId: uuidSchema.optional(),
});
