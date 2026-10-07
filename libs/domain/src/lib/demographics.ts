import {
  AGE_BAND_LABELS,
  GENDER_LABELS,
  MEMBERSHIP_LABELS,
  UNKNOWN_LABEL,
  type AgeBand,
  type DemographicDimension,
  type Gender,
  type MembershipKind,
} from '@raaye/contracts';

/** Immutable per-participation demographic snapshot used for analysis. */
export interface AnalysisProfile {
  city: string | null;
  district: string | null;
  gender: Gender | null;
  ageBand: AgeBand | null;
  occupation: string | null;
  membership: MembershipKind;
  membershipSource: string | null;
  selfReportedMembership: MembershipKind | null;
}

export interface ContactProfileLike {
  city: string | null;
  district: string | null;
  gender: Gender | null;
  ageBand: AgeBand | null;
  occupation: string | null;
  membership: MembershipKind;
  membershipSource: string | null;
  selfReportedMembership: MembershipKind | null;
}

export function buildAnalysisProfile(contact: ContactProfileLike): AnalysisProfile {
  return {
    city: contact.city,
    district: contact.district,
    gender: contact.gender,
    ageBand: contact.ageBand,
    occupation: contact.occupation,
    membership: contact.membership,
    membershipSource: contact.membershipSource,
    selfReportedMembership: contact.selfReportedMembership,
  };
}

export const UNKNOWN_COHORT = '__unknown__';

export function cohortKey(profile: AnalysisProfile | null, dimension: DemographicDimension): string {
  if (!profile) return UNKNOWN_COHORT;
  const value = profile[dimension];
  if (value === null || value === undefined || value === '' || value === 'UNKNOWN') return UNKNOWN_COHORT;
  return String(value);
}

export function cohortLabel(dimension: DemographicDimension, key: string): string {
  if (key === UNKNOWN_COHORT) return UNKNOWN_LABEL;
  switch (dimension) {
    case 'gender':
      return GENDER_LABELS[key as Gender] ?? key;
    case 'ageBand':
      return AGE_BAND_LABELS[key as AgeBand] ?? key;
    case 'membership':
      return MEMBERSHIP_LABELS[key as MembershipKind] ?? key;
    default:
      return key;
  }
}

export function normalizeText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.toLowerCase() : null;
}
