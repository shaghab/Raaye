import { z } from 'zod';
import { AGE_BANDS, GENDERS, MEMBERSHIP_KINDS } from './enums';
import { uuidSchema } from './common';

/** Development-only simulator contracts. Never available in live configuration. */

export const simulatorTextSchema = z.object({
  contactId: uuidSchema.optional(),
  /** Unknown sender simulation for enrollment flows. */
  phone: z.string().trim().min(5).max(32).optional(),
  profileName: z.string().trim().max(80).optional(),
  text: z.string().min(1).max(4096),
  providerMessageId: z.string().trim().min(1).max(120).optional(),
  providerAtOffsetSeconds: z.number().int().min(-86400).max(86400).optional(),
});

export const simulatorTapSchema = z.object({
  contactId: uuidSchema,
  messageId: uuidSchema,
  /** The control id rendered in the outbound message (bound action token). */
  controlId: z.string().trim().min(1).max(256),
  providerMessageId: z.string().trim().min(1).max(120).optional(),
  providerAtOffsetSeconds: z.number().int().min(-86400).max(86400).optional(),
});

export const simulatorFlowSubmitSchema = z.object({
  contactId: uuidSchema,
  messageId: uuidSchema,
  flowToken: z.string().trim().min(1).max(256),
  /** Selected option ids for question flows. */
  selectedOptionIds: z.array(uuidSchema).max(20).optional(),
  profile: z
    .object({
      city: z.string().trim().max(100).optional(),
      district: z.string().trim().max(100).optional(),
      gender: z.enum(GENDERS).optional(),
      ageBand: z.enum(AGE_BANDS).optional(),
      occupation: z.string().trim().max(120).optional(),
      membership: z.enum(MEMBERSHIP_KINDS).optional(),
    })
    .optional(),
  /** Simulate a tampered submission that references another participant's token. */
  overrideSenderContactId: uuidSchema.optional(),
  providerMessageId: z.string().trim().min(1).max(120).optional(),
  providerAtOffsetSeconds: z.number().int().min(-86400).max(86400).optional(),
});

export const simulatorStatusSchema = z.object({
  messageId: uuidSchema,
  status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
  providerAtOffsetSeconds: z.number().int().min(-86400).max(86400).optional(),
  errorCode: z.string().trim().max(32).optional(),
  /** Send the same callback twice to exercise deduplication. */
  duplicate: z.boolean().optional(),
});

export const simulatorClockSchema = z.object({
  advanceSeconds: z.number().int().min(-31_536_000).max(31_536_000).optional(),
  reset: z.boolean().optional(),
});

export const simulatorFaultsSchema = z.object({
  nextSendOutcome: z.enum(['ACCEPTED', 'FAILED_TEMPORARY', 'FAILED_PERMANENT', 'TIMEOUT']).optional(),
  failForContactId: uuidSchema.nullable().optional(),
  timeoutForContactId: uuidSchema.nullable().optional(),
  expireServiceWindowForContactId: uuidSchema.nullable().optional(),
});

export interface SimulatorConversationMessageDto {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  kind: string;
  state: string;
  deliveryState: string | null;
  isTest: boolean;
  createdAt: string;
  text: string;
  controls: { id: string; label: string; description?: string; type: 'BUTTON' | 'LIST_ROW' | 'FLOW_CTA' }[];
  flow: {
    token: string;
    purpose: 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE';
    questionId: string | null;
    options: { id: string; label: string; exclusive: boolean }[];
    initialSelectedOptionIds: string[];
    minSelections: number | null;
    maxSelections: number | null;
    profile: Record<string, string | null> | null;
  } | null;
  providerMessageId: string | null;
  templateName: string | null;
  suppressionReason: string | null;
  errorCode: string | null;
}

export interface SimulatorStateDto {
  enabled: boolean;
  now: string;
  clockOffsetSeconds: number;
  faults: Record<string, unknown>;
  connectionAppKey: string;
}
