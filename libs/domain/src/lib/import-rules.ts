import type { AgeBand, Gender, ImportField, ImportRowErrorDto, MembershipKind } from '@raaye/contracts';
import { LIMITS } from '@raaye/contracts';
import { ageBandFromYears, parseAgeBand } from './age';
import { normalizePhone } from './phone';
import type { ParsedCell } from './spreadsheet';

export interface NormalizedImportRow {
  name: string;
  phoneE164: string;
  city: string | null;
  district: string | null;
  gender: Gender | null;
  ageBand: AgeBand | null;
  ageYears: number | null;
  ageAsOf: string | null;
  occupation: string | null;
  membership: MembershipKind | null;
  preferredLocale: string | null;
  groups: string[];
  tags: string[];
  consentEvidenceAt: string | null;
  consentReference: string | null;
}

export type ImportCells = Partial<Record<ImportField, ParsedCell>>;

const GENDER_SYNONYMS: Record<string, Gender> = {
  WOMAN: 'WOMAN',
  FEMALE: 'WOMAN',
  F: 'WOMAN',
  W: 'WOMAN',
  MAN: 'MAN',
  MALE: 'MAN',
  M: 'MAN',
  ANOTHER_IDENTITY: 'ANOTHER_IDENTITY',
  'ANOTHER IDENTITY': 'ANOTHER_IDENTITY',
  OTHER: 'ANOTHER_IDENTITY',
  'NON-BINARY': 'ANOTHER_IDENTITY',
  NONBINARY: 'ANOTHER_IDENTITY',
  PREFER_NOT_TO_SAY: 'PREFER_NOT_TO_SAY',
  'PREFER NOT TO SAY': 'PREFER_NOT_TO_SAY',
};

const MEMBERSHIP_SYNONYMS: Record<string, MembershipKind> = {
  MEMBER: 'MEMBER',
  YES: 'MEMBER',
  Y: 'MEMBER',
  TRUE: 'MEMBER',
  '1': 'MEMBER',
  NON_MEMBER: 'NON_MEMBER',
  'NON-MEMBER': 'NON_MEMBER',
  'NON MEMBER': 'NON_MEMBER',
  NONMEMBER: 'NON_MEMBER',
  NO: 'NON_MEMBER',
  N: 'NON_MEMBER',
  FALSE: 'NON_MEMBER',
  '0': 'NON_MEMBER',
  UNKNOWN: 'UNKNOWN',
};

function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 200_000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string, numeric: boolean): string | null {
  const text = value.trim();
  if (!text) return null;
  if (numeric && /^\d+(\.\d+)?$/.test(text)) return excelSerialToIsoDate(Number(text));
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function parseIsoDateTime(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  // Date-only values are treated as midnight UTC.
  return date.toISOString();
}

export function splitList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[;|,]/)
        .map((item) => cleanText(item))
        .filter((item) => item.length > 0),
    ),
  );
}

/**
 * Validate and normalize one import row. Every cell is untrusted: formulas are rejected,
 * numbers are never coerced via floating point, and conflicting age data must be fixed
 * by the operator rather than silently resolved.
 */
export function validateImportRow(
  rowNumber: number,
  cells: ImportCells,
  defaultCountry: string,
  importDateIso: string,
): { normalized: NormalizedImportRow | null; errors: ImportRowErrorDto[] } {
  const errors: ImportRowErrorDto[] = [];
  const fail = (field: string | null, message: string) => errors.push({ rowNumber, field, message });

  for (const [field, cell] of Object.entries(cells) as [ImportField, ParsedCell | undefined][]) {
    if (cell?.isFormula) fail(field, 'Formula cells are not accepted; enter a plain value');
  }

  const name = cleanText(cells.name?.text);
  if (!name) fail('name', 'Name is required');
  else if (name.length > LIMITS.contactName.max) fail('name', `Name must be at most ${LIMITS.contactName.max} characters`);

  const phoneCell = cells.phone;
  let phoneE164 = '';
  if (!phoneCell || !cleanText(phoneCell.text)) {
    fail('phone', 'Phone number is required');
  } else {
    const result = normalizePhone(phoneCell.text, defaultCountry);
    if (!result.ok) {
      const reason =
        result.reason === 'SCIENTIFIC_NOTATION'
          ? 'Phone number was stored as a floating-point number; format the column as text'
          : result.reason === 'AMBIGUOUS'
            ? 'Phone number is ambiguous; use international format'
            : 'Phone number is invalid';
      fail('phone', reason);
    } else {
      phoneE164 = result.e164;
    }
  }

  const city = cleanText(cells.city?.text) || null;
  const district = cleanText(cells.district?.text) || null;
  if (city && city.length > 100) fail('city', 'City must be at most 100 characters');
  if (district && district.length > 100) fail('district', 'District must be at most 100 characters');

  let gender: Gender | null = null;
  const genderText = cleanText(cells.gender?.text);
  if (genderText) {
    gender = GENDER_SYNONYMS[genderText.toUpperCase()] ?? null;
    if (!gender) fail('gender', `Unrecognized gender value "${genderText}"`);
  }

  let ageBand: AgeBand | null = null;
  const ageBandText = cleanText(cells.ageBand?.text);
  if (ageBandText) {
    ageBand = parseAgeBand(ageBandText);
    if (!ageBand) fail('ageBand', `Unrecognized age band "${ageBandText}"`);
  }

  let ageYears: number | null = null;
  let ageAsOf: string | null = null;
  const ageText = cleanText(cells.age?.text);
  if (ageText) {
    if (!/^\d{1,3}$/.test(ageText)) {
      fail('age', 'Age must be a whole number between 0 and 120');
    } else {
      const years = Number(ageText);
      if (years < 0 || years > 120) fail('age', 'Age must be between 0 and 120');
      else ageYears = years;
    }
    const asOfText = cleanText(cells.ageAsOf?.text);
    ageAsOf = asOfText ? parseIsoDate(asOfText, Boolean(cells.ageAsOf?.isNumeric)) : importDateIso;
    if (asOfText && !ageAsOf) fail('ageAsOf', 'Age reference date must be YYYY-MM-DD');
    if (ageYears !== null) {
      const derived = ageBandFromYears(ageYears);
      if (ageBand && derived && ageBand !== derived) {
        fail('age', `Age ${ageYears} conflicts with age band ${ageBand}; correct one of them`);
      } else if (!ageBand) {
        ageBand = derived;
      }
    }
  } else if (cleanText(cells.ageAsOf?.text)) {
    fail('ageAsOf', 'Age reference date requires an age value');
  }

  const occupation = cleanText(cells.occupation?.text) || null;
  if (occupation && occupation.length > LIMITS.occupation.max) fail('occupation', `Occupation must be at most ${LIMITS.occupation.max} characters`);

  let membership: MembershipKind | null = null;
  const membershipText = cleanText(cells.membership?.text);
  if (membershipText) {
    membership = MEMBERSHIP_SYNONYMS[membershipText.toUpperCase()] ?? null;
    if (!membership) fail('membership', `Unrecognized membership value "${membershipText}"`);
  }

  let preferredLocale: string | null = null;
  const localeText = cleanText(cells.preferredLocale?.text);
  if (localeText) {
    if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(localeText)) fail('preferredLocale', 'Locale must be a BCP-47 tag such as en or ur');
    else preferredLocale = localeText;
  }

  const groups = splitList(cells.groups?.text ?? '');
  const tags = splitList(cells.tags?.text ?? '');
  for (const value of [...groups, ...tags]) {
    if (value.length > 80) fail('groups', `Group or tag name "${value.slice(0, 20)}..." is too long`);
  }

  let consentEvidenceAt: string | null = null;
  const consentAtText = cleanText(cells.consentEvidenceAt?.text);
  if (consentAtText) {
    consentEvidenceAt = cells.consentEvidenceAt?.isNumeric
      ? (() => {
          const iso = parseIsoDate(consentAtText, true);
          return iso ? `${iso}T00:00:00.000Z` : null;
        })()
      : parseIsoDateTime(consentAtText);
    if (!consentEvidenceAt) fail('consentEvidenceAt', 'Consent evidence date must be an ISO date or date-time');
  }
  const consentReference = cleanText(cells.consentReference?.text) || null;

  if (errors.length > 0) return { normalized: null, errors };
  return {
    normalized: {
      name,
      phoneE164,
      city,
      district,
      gender,
      ageBand,
      ageYears,
      ageAsOf,
      occupation,
      membership,
      preferredLocale,
      groups,
      tags,
      consentEvidenceAt,
      consentReference,
    },
    errors,
  };
}

/** Suggest a column mapping from spreadsheet headers. */
export function suggestMapping(headers: readonly string[]): Record<string, ImportField> {
  const mapping: Record<string, ImportField> = {};
  const used = new Set<ImportField>();
  const candidates: [RegExp, ImportField][] = [
    [/^(full\s*)?name$|^contact(\s*name)?$|^participant$/i, 'name'],
    [/phone|mobile|whatsapp|number|msisdn|cell/i, 'phone'],
    [/^city$|^town$/i, 'city'],
    [/^district$|^tehsil$/i, 'district'],
    [/^gender$|^sex$/i, 'gender'],
    [/age.?band|age.?group|age.?range/i, 'ageBand'],
    [/^age$|age.?years/i, 'age'],
    [/age.?as.?of|age.?date/i, 'ageAsOf'],
    [/occupation|profession|job/i, 'occupation'],
    [/member/i, 'membership'],
    [/locale|language/i, 'preferredLocale'],
    [/^groups?$/i, 'groups'],
    [/^tags?$/i, 'tags'],
    [/consent.*(date|at|time)|opt.?in.*(date|at)/i, 'consentEvidenceAt'],
    [/consent.*(ref|evidence|source)|evidence/i, 'consentReference'],
  ];
  for (const header of headers) {
    const trimmed = header.trim();
    if (!trimmed) continue;
    for (const [pattern, field] of candidates) {
      if (!used.has(field) && pattern.test(trimmed)) {
        mapping[trimmed] = field;
        used.add(field);
        break;
      }
    }
  }
  return mapping;
}
