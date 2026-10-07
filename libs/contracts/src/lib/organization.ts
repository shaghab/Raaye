import { z } from 'zod';
import { LIMITS } from './limits';

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  defaultLocale: string;
  privacyUrl: string | null;
  supportContact: string | null;
  participantNotice: string;
  participantNoticeVersion: number;
  profileOnboardingEnabled: boolean;
  defaultDurationSeconds: number;
  defaultEditWindowSeconds: number;
  livePolicyReviewedAt: string | null;
  isDemo: boolean;
}

export const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    timezone: z.string().trim().min(1).max(64),
    privacyUrl: z.url().max(500).nullable(),
    supportContact: z.string().trim().min(1).max(200).nullable(),
    participantNotice: z.string().trim().min(20).max(1500),
    profileOnboardingEnabled: z.boolean(),
    defaultDurationSeconds: z
      .number()
      .int()
      .min(LIMITS.durationSeconds.min)
      .max(LIMITS.durationSeconds.max),
    defaultEditWindowSeconds: z
      .number()
      .int()
      .min(LIMITS.editWindowSeconds.min)
      .max(LIMITS.editWindowSeconds.max),
    livePolicyReviewed: z.boolean(),
  })
  .partial();
export type OrganizationUpdate = z.infer<typeof organizationUpdateSchema>;

export interface AuditEventDto {
  id: string;
  actorType: 'USER' | 'SYSTEM' | 'PARTICIPANT';
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  correlationId: string | null;
  createdAt: string;
}

export const auditQuerySchema = z.object({
  action: z.string().trim().max(100).optional(),
  resourceType: z.string().trim().max(100).optional(),
  resourceId: z.string().trim().max(100).optional(),
});
