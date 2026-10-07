import { z } from 'zod';
import type { DeliveryState, FlowPurpose, MessageKind, TemplatePurpose } from './enums';

export interface TemplateBindingDto {
  purpose: TemplatePurpose;
  providerName: string;
  locale: string;
  category: string | null;
  status: string;
  buttonPosition: number;
  lastCheckedAt: string | null;
}

export interface FlowBindingDto {
  purpose: FlowPurpose;
  locale: string;
  assetVersion: string;
  providerFlowId: string | null;
  status: string;
  lastCheckedAt: string | null;
}

export interface MessagingReadinessDto {
  mode: 'mock' | 'live';
  provider: 'MOCK' | 'META';
  ok: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  connection: {
    id: string;
    appKey: string;
    phoneNumberId: string | null;
    wabaId: string | null;
    appId: string | null;
    displayPhoneNumber: string | null;
    graphVersion: string | null;
    appSecretRef: string | null;
    accessTokenRef: string | null;
    verifyTokenRef: string | null;
    enabled: boolean;
  } | null;
  templates: TemplateBindingDto[];
  flows: FlowBindingDto[];
  webhookPath: string | null;
  checkedAt: string;
}

export const messagingConfigurationSchema = z
  .object({
    phoneNumberId: z.string().trim().min(1).max(64).nullable(),
    wabaId: z.string().trim().min(1).max(64).nullable(),
    appId: z.string().trim().min(1).max(64).nullable(),
    displayPhoneNumber: z.string().trim().min(3).max(32).nullable(),
    graphVersion: z.string().trim().regex(/^v\d{1,3}\.\d{1,2}$/).nullable(),
    appSecretRef: z.string().trim().min(1).max(200).nullable(),
    accessTokenRef: z.string().trim().min(1).max(200).nullable(),
    verifyTokenRef: z.string().trim().min(1).max(200).nullable(),
    enabled: z.boolean(),
    templates: z
      .array(
        z.object({
          purpose: z.enum(['SURVEY_INVITATION', 'RESULTS_AVAILABLE']),
          providerName: z.string().trim().min(1).max(512),
          locale: z.string().trim().min(2).max(10),
          category: z.string().trim().max(32).nullable().optional(),
          buttonPosition: z.number().int().min(0).max(9).default(0),
        }),
      )
      .max(10),
    flows: z
      .array(
        z.object({
          purpose: z.enum(['SINGLE_CHOICE', 'MULTI_CHOICE', 'PROFILE']),
          locale: z.string().trim().min(2).max(10),
          providerFlowId: z.string().trim().min(1).max(64).nullable(),
        }),
      )
      .max(10),
  })
  .partial();
export type MessagingConfiguration = z.infer<typeof messagingConfigurationSchema>;

export interface MessageAttemptDto {
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'IN_FLIGHT' | 'ACCEPTED' | 'FAILED' | 'UNKNOWN';
  providerMessageId: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  authorizedByUserId: string | null;
}

export interface MessageDto {
  id: string;
  kind: MessageKind;
  state: string;
  deliveryState: DeliveryState;
  contactId: string;
  contactName: string | null;
  runId: string | null;
  isTest: boolean;
  isFreeForm: boolean;
  providerMessageId: string | null;
  suppressionReason: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  attempts: MessageAttemptDto[];
  statusEvents: { status: string; providerAt: string; receivedAt: string; errorCode: string | null }[];
  renderedSummary: string;
}

export const messageRetrySchema = z.object({
  /** Required when the previous attempt had an unknown outcome. */
  acknowledgeDuplicateRisk: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
});
export type MessageRetry = z.infer<typeof messageRetrySchema>;

export interface OverviewDto {
  contacts: { total: number; eligibleForInvitations: number; withdrawn: number; unknown: number };
  surveys: { draft: number; scheduled: number; active: number; closed: number; archived: number };
  recent: {
    id: string;
    internalTitle: string;
    state: string;
    opensAt: string | null;
    closesAt: string | null;
    responded: number;
    completed: number;
  }[];
  attention: {
    failedMessages: number;
    unknownOutcomes: number;
    blockedRuns: { surveyId: string; internalTitle: string; reason: string }[];
    deadJobs: number;
  };
  messagingMode: 'mock' | 'live';
  refreshedAt: string;
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  checks?: Record<string, 'ok' | 'fail'>;
}
