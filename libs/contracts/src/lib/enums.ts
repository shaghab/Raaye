// String-literal enums shared by the dashboard and the API. They mirror the
// database enums but keep the client independent of Prisma.

export const ROLES = ['ADMIN', 'SURVEY_MANAGER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const GENDERS = ['WOMAN', 'MAN', 'ANOTHER_IDENTITY', 'PREFER_NOT_TO_SAY'] as const;
export type Gender = (typeof GENDERS)[number];

export const AGE_BANDS = [
  'UNDER_18',
  'AGE_18_24',
  'AGE_25_34',
  'AGE_35_44',
  'AGE_45_54',
  'AGE_55_64',
  'AGE_65_PLUS',
  'PREFER_NOT_TO_SAY',
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const MEMBERSHIP_KINDS = ['MEMBER', 'NON_MEMBER', 'UNKNOWN'] as const;
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

export const VALUE_SOURCES = ['ADMIN', 'IMPORT', 'SELF_REPORTED'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

export const CONSENT_SCOPES = ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const CONSENT_STATUSES = ['UNKNOWN', 'GRANTED', 'WITHDRAWN'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const CONSENT_EVENT_TYPES = ['GRANTED', 'WITHDRAWN', 'RESET'] as const;
export type ConsentEventType = (typeof CONSENT_EVENT_TYPES)[number];

export const CONSENT_SOURCES = [
  'STAFF_RECORDED',
  'IMPORT_ATTESTATION',
  'PARTICIPANT_REPLY',
  'PARTICIPANT_STOP',
  'STAFF_OPT_OUT',
  'PHONE_CHANGED',
  'SEED',
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SURVEY_STATES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED'] as const;
export type SurveyState = (typeof SURVEY_STATES)[number];

/** The five authoring choices exposed to staff. */
export const AUTHORING_TYPES = [
  'YES_NO',
  'YES_NO_INDIFFERENT',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'RATING',
] as const;
export type AuthoringType = (typeof AUTHORING_TYPES)[number];

/** Normalized storage types. */
export const QUESTION_TYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'RATING'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_PRESETS = ['YES_NO', 'YES_NO_INDIFFERENT', 'CUSTOM'] as const;
export type QuestionPreset = (typeof QUESTION_PRESETS)[number];

export const RENDERERS = ['BUTTONS', 'LIST', 'FLOW_SINGLE', 'FLOW_MULTI'] as const;
export type Renderer = (typeof RENDERERS)[number];

export const RUN_KINDS = ['LIVE', 'TEST'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATES = ['SCHEDULED', 'ACTIVE', 'CLOSED', 'CANCELED'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const AUDIENCE_MODES = ['EVERYONE', 'SELECTED', 'GROUPS_TAGS', 'FILTERED'] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

export const INVITATION_STATES = [
  'PENDING',
  'QUEUED',
  'ACCEPTED',
  'FAILED',
  'UNKNOWN',
  'SUPPRESSED',
  'CANCELED',
] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const DELIVERY_STATES = [
  'QUEUED',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'UNKNOWN',
  'SUPPRESSED',
  'CANCELED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const MESSAGE_KINDS = [
  'INVITATION',
  'QUESTION',
  'ACKNOWLEDGEMENT',
  'COMMAND_REPLY',
  'OPT_OUT_ACK',
  'PROFILE_OFFER',
  'PROFILE_FLOW',
  'RESULTS_INVITATION',
  'RESULTS_CONTENT',
  'ENROLLMENT',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const PARTICIPATION_STATES = ['STARTED', 'COMPLETED'] as const;
export type ParticipationState = (typeof PARTICIPATION_STATES)[number];

export const PROFILE_OFFER_STATES = [
  'NOT_OFFERED',
  'OFFERED',
  'COMPLETED',
  'SKIPPED',
  'ABANDONED',
] as const;
export type ProfileOfferState = (typeof PROFILE_OFFER_STATES)[number];

export const MESSAGING_MODES = ['mock', 'live'] as const;
export type MessagingMode = (typeof MESSAGING_MODES)[number];

export const TEMPLATE_PURPOSES = ['SURVEY_INVITATION', 'RESULTS_AVAILABLE'] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];

export const FLOW_PURPOSES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'PROFILE'] as const;
export type FlowPurpose = (typeof FLOW_PURPOSES)[number];

export const IMPORT_FILE_TYPES = ['CSV', 'XLSX'] as const;
export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

export const DUPLICATE_MODES = ['SKIP_EXISTING', 'UPDATE_NON_EMPTY_FIELDS'] as const;
export type DuplicateMode = (typeof DUPLICATE_MODES)[number];

export const IMPORT_STATES = [
  'UPLOADED',
  'PREVIEWED',
  'CONFIRMED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

export const IMPORT_ROW_STATUSES = ['CREATE', 'UPDATE', 'SKIP', 'ERROR'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const DEMOGRAPHIC_DIMENSIONS = [
  'city',
  'district',
  'gender',
  'ageBand',
  'occupation',
  'membership',
] as const;
export type DemographicDimension = (typeof DEMOGRAPHIC_DIMENSIONS)[number];

export const SNAPSHOT_BROADCAST_STATES = ['PENDING', 'QUEUED', 'COMPLETED', 'REVOKED'] as const;
export type SnapshotBroadcastState = (typeof SNAPSHOT_BROADCAST_STATES)[number];

export const RESULT_ACCESS_STATES = [
  'PENDING',
  'INVITED',
  'VIEWED',
  'SUPPRESSED',
  'FAILED',
  'UNKNOWN',
] as const;
export type ResultAccessState = (typeof RESULT_ACCESS_STATES)[number];

/** Human labels for locale-ready display. Only English is implemented. */
export const GENDER_LABELS: Record<Gender, string> = {
  WOMAN: 'Woman',
  MAN: 'Man',
  ANOTHER_IDENTITY: 'Another identity',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  UNDER_18: 'Under 18',
  AGE_18_24: '18-24',
  AGE_25_34: '25-34',
  AGE_35_44: '35-44',
  AGE_45_54: '45-54',
  AGE_55_64: '55-64',
  AGE_65_PLUS: '65+',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

export const MEMBERSHIP_LABELS: Record<MembershipKind, string> = {
  MEMBER: 'Member',
  NON_MEMBER: 'Non-member',
  UNKNOWN: 'Unknown',
};

export const AUTHORING_TYPE_LABELS: Record<AuthoringType, string> = {
  YES_NO: 'Yes / No',
  YES_NO_INDIFFERENT: 'Yes / No / Indifferent',
  SINGLE_CHOICE: 'Single choice',
  MULTI_CHOICE: 'Multiple selection',
  RATING: 'Rating 1-5',
};

export const UNKNOWN_LABEL = 'Unknown / not provided';
