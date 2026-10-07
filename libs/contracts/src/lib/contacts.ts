import { z } from 'zod';
import {
  AGE_BANDS,
  CONSENT_SCOPES,
  CONSENT_STATUSES,
  DUPLICATE_MODES,
  GENDERS,
  MEMBERSHIP_KINDS,
  type AgeBand,
  type ConsentEventType,
  type ConsentScope,
  type ConsentSource,
  type ConsentStatus,
  type DuplicateMode,
  type Gender,
  type ImportFileType,
  type ImportRowStatus,
  type ImportState,
  type MembershipKind,
  type ValueSource,
} from './enums';
import { LIMITS } from './limits';
import { paginationQuerySchema, uuidSchema } from './common';

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

const csvList = <T extends string>(values: readonly T[]) =>
  z
    .union([z.enum(values as unknown as [T, ...T[]]), z.array(z.enum(values as unknown as [T, ...T[]]))])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional();

const stringList = z
  .union([z.string().trim().min(1).max(100), z.array(z.string().trim().min(1).max(100))])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

const uuidList = z
  .union([uuidSchema, z.array(uuidSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

export const contactProfileSchema = z.object({
  city: optionalTrimmed(100),
  district: optionalTrimmed(100),
  gender: z.enum(GENDERS).nullable().optional(),
  ageBand: z.enum(AGE_BANDS).nullable().optional(),
  occupation: optionalTrimmed(LIMITS.occupation.max),
  membership: z.enum(MEMBERSHIP_KINDS).optional(),
  preferredLocale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
});

export const contactCreateSchema = contactProfileSchema.extend({
  name: z.string().trim().min(1).max(LIMITS.contactName.max),
  phone: z.string().trim().min(3).max(32),
  /** ISO 3166-1 alpha-2 used when the number is in national format. */
  defaultCountry: z.string().length(2).toUpperCase().default('PK'),
  groupIds: z.array(uuidSchema).max(50).optional(),
  tagIds: z.array(uuidSchema).max(50).optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

export const contactUpdateSchema = contactProfileSchema
  .extend({
    name: z.string().trim().min(1).max(LIMITS.contactName.max),
    phone: z.string().trim().min(3).max(32),
    defaultCountry: z.string().length(2).toUpperCase(),
    /** Required when the phone number changes. */
    confirmPhoneChange: z.boolean(),
    groupIds: z.array(uuidSchema).max(50),
    tagIds: z.array(uuidSchema).max(50),
  })
  .partial();
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;

export const contactListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  city: stringList,
  district: stringList,
  gender: csvList(GENDERS),
  ageBand: csvList(AGE_BANDS),
  occupation: stringList,
  membership: csvList(MEMBERSHIP_KINDS),
  consentStatus: csvList(CONSENT_STATUSES),
  groupId: uuidList,
  tagId: uuidList,
  archived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((value) => value === true || value === 'true')
    .default(false),
  synthetic: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export interface ConsentSummaryDto {
  invitations: ConsentStatus;
  results: ConsentStatus;
  invitationsEvidenceAt: string | null;
  resultsEvidenceAt: string | null;
}

export interface ContactSummaryDto {
  id: string;
  name: string;
  phoneE164: string;
  city: string | null;
  district: string | null;
  gender: Gender | null;
  ageBand: AgeBand | null;
  occupation: string | null;
  membership: MembershipKind;
  membershipSource: ValueSource | null;
  selfReportedMembership: MembershipKind | null;
  preferredLocale: string;
  isSynthetic: boolean;
  archivedAt: string | null;
  consent: ConsentSummaryDto;
  groups: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactParticipationDto {
  surveyId: string;
  surveyTitle: string;
  runKind: 'LIVE' | 'TEST';
  state: 'INVITED' | 'STARTED' | 'COMPLETED';
  invitationState: string | null;
  startedAt: string | null;
  completedAt: string | null;
  answeredCount: number;
  questionCount: number;
}

export interface ContactDetailDto extends ContactSummaryDto {
  ageYears: number | null;
  ageAsOf: string | null;
  profileProvenance: Record<string, { source: ValueSource; at: string }> | null;
  participations: ContactParticipationDto[];
}

export interface ConsentEventDto {
  id: string;
  scope: ConsentScope;
  type: ConsentEventType;
  source: ConsentSource;
  evidenceAt: string;
  recordedAt: string;
  wordingVersion: string | null;
  evidenceReference: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  note: string | null;
}

export const consentEventCreateSchema = z.object({
  scopes: z.array(z.enum(CONSENT_SCOPES)).min(1),
  type: z.enum(['GRANTED', 'WITHDRAWN']),
  evidenceAt: z.iso.datetime({ offset: true }),
  wordingVersion: z.string().trim().max(50).optional(),
  evidenceReference: z.string().trim().min(1).max(300),
  note: z.string().trim().max(500).optional(),
  /** Required when re-granting after a withdrawal: staff attest they reviewed new evidence. */
  reviewedNewEvidence: z.boolean().optional(),
});
export type ConsentEventCreate = z.infer<typeof consentEventCreateSchema>;

export const groupUpsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
});
export type GroupUpsert = z.infer<typeof groupUpsertSchema>;

export const tagUpsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type TagUpsert = z.infer<typeof tagUpsertSchema>;

export interface GroupDto {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  createdAt: string;
}

export interface TagDto {
  id: string;
  name: string;
  contactCount: number;
  createdAt: string;
}

// ---- Imports ---------------------------------------------------------------

export const IMPORT_FIELDS = [
  'name',
  'phone',
  'city',
  'district',
  'gender',
  'ageBand',
  'age',
  'ageAsOf',
  'occupation',
  'membership',
  'preferredLocale',
  'groups',
  'tags',
  'consentEvidenceAt',
  'consentReference',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const importMappingSchema = z.object({
  sheetName: z.string().trim().max(100).optional(),
  /** Spreadsheet header -> Raaye field. Headers not listed are ignored. */
  columns: z.record(z.string(), z.enum(IMPORT_FIELDS)),
  defaultCountry: z.string().length(2).toUpperCase().default('PK'),
  duplicateMode: z.enum(DUPLICATE_MODES).default('SKIP_EXISTING'),
  consentAttestation: z
    .object({
      scopes: z.array(z.enum(CONSENT_SCOPES)).min(1),
      source: z.string().trim().min(1).max(200),
      collectedAt: z.iso.datetime({ offset: true }),
      wordingVersion: z.string().trim().min(1).max(50),
      statement: z.literal(true),
    })
    .optional(),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export interface ImportRowErrorDto {
  rowNumber: number;
  field: string | null;
  message: string;
}

export interface ImportPreviewRowDto {
  rowNumber: number;
  status: ImportRowStatus;
  name: string | null;
  phoneE164: string | null;
  consentEligible: boolean;
  errors: ImportRowErrorDto[];
}

export interface ImportSummaryDto {
  totalRows: number;
  create: number;
  update: number;
  skip: number;
  error: number;
  consentGrantedRows: number;
  withdrawnProtected: number;
}

export interface ImportBatchDto {
  id: string;
  fileName: string;
  fileType: ImportFileType;
  fileSize: number;
  sheetNames: string[] | null;
  sheetName: string | null;
  headers: string[] | null;
  columnMapping: Record<string, ImportField> | null;
  defaultCountry: string;
  duplicateMode: DuplicateMode;
  state: ImportState;
  summary: ImportSummaryDto | null;
  hasConsentAttestation: boolean;
  rawExpiresAt: string;
  previewedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ImportPreviewDto {
  batch: ImportBatchDto;
  rows: ImportPreviewRowDto[];
  rowsShown: number;
}
