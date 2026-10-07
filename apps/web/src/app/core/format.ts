import { AGE_BAND_LABELS, GENDER_LABELS, MEMBERSHIP_LABELS, UNKNOWN_LABEL, pickLocale, type LocalizedText } from '@raaye/contracts';
import { DateTime } from 'luxon';

const LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  SURVEY_MANAGER: 'Survey Manager',
  VIEWER: 'Viewer',
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  CANCELED: 'Canceled',
  GRANTED: 'Granted',
  WITHDRAWN: 'Withdrawn',
  UNKNOWN: 'Unknown',
  PENDING: 'Pending',
  QUEUED: 'Queued',
  ACCEPTED: 'Accepted by provider',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  SUPPRESSED: 'Suppressed',
  NOT_STARTED: 'Not started',
  STARTED: 'Started',
  COMPLETED: 'Completed',
  INVITED: 'Invited',
  VIEWED: 'Viewed',
  EVERYONE: 'Everyone',
  SELECTED: 'Selected contacts',
  GROUPS_TAGS: 'Groups and tags',
  FILTERED: 'Demographic filter',
  YES_NO: 'Yes / No',
  YES_NO_INDIFFERENT: 'Yes / No / Indifferent',
  SINGLE_CHOICE: 'Single choice',
  MULTI_CHOICE: 'Multiple selection',
  RATING: 'Rating 1-5',
  BUTTONS: 'Reply buttons',
  LIST: 'List message',
  FLOW_SINGLE: 'Flow (single choice)',
  FLOW_MULTI: 'Flow (multiple selection)',
  TEXT: 'Text',
  TEMPLATE: 'Template',
  city: 'City',
  district: 'District',
  gender: 'Gender',
  ageBand: 'Age band',
  occupation: 'Occupation',
  membership: 'Membership',
  SURVEY_INVITATIONS: 'Survey invitations',
  SURVEY_RESULTS: 'Result sharing',
  MOCK: 'Mock provider',
  META: 'WhatsApp Cloud API',
  LIVE: 'Live',
  TEST: 'Test',
  EXPIRED: 'Expired',
  PREVIEWED: 'Previewed',
  CONFIRMED: 'Confirmed',
  UPLOADED: 'Uploaded',
  ...GENDER_LABELS,
  ...AGE_BAND_LABELS,
  MEMBER: MEMBERSHIP_LABELS.MEMBER,
  NON_MEMBER: MEMBERSHIP_LABELS.NON_MEMBER,
};

/** Human label for enum codes shown in the dashboard. */
export function label(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '—';
  return LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (first) => first.toUpperCase());
}

export function text(value: LocalizedText | null | undefined, locale = 'en'): string {
  return pickLocale(value, locale);
}

export function formatDateTime(iso: string | null | undefined, zone: string): string {
  if (!iso) return '—';
  const value = DateTime.fromISO(iso, { zone });
  return value.isValid ? value.toFormat('d MMM yyyy, HH:mm') : '—';
}

export function formatDate(iso: string | null | undefined, zone: string): string {
  if (!iso) return '—';
  const value = DateTime.fromISO(iso, { zone });
  return value.isValid ? value.toFormat('d MMM yyyy') : '—';
}

/** Converts a <input type="datetime-local"> value interpreted in the organization zone into ISO. */
export function localToIso(value: string, zone: string): string | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone });
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

export function isoToLocal(iso: string | null | undefined, zone: string): string {
  if (!iso) return '';
  const parsed = DateTime.fromISO(iso, { zone });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm") : '';
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${value.toFixed(digits)}%`;
}

export function describeSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

export const UNKNOWN = UNKNOWN_LABEL;
