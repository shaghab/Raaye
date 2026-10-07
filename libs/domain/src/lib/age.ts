import type { AgeBand } from '@raaye/contracts';

export function ageBandFromYears(years: number): AgeBand | null {
  if (!Number.isInteger(years) || years < 0 || years > 120) return null;
  if (years < 18) return 'UNDER_18';
  if (years <= 24) return 'AGE_18_24';
  if (years <= 34) return 'AGE_25_34';
  if (years <= 44) return 'AGE_35_44';
  if (years <= 54) return 'AGE_45_54';
  if (years <= 64) return 'AGE_55_64';
  return 'AGE_65_PLUS';
}

const AGE_BAND_SYNONYMS: Record<string, AgeBand> = {
  'UNDER 18': 'UNDER_18',
  'UNDER_18': 'UNDER_18',
  '<18': 'UNDER_18',
  '0-17': 'UNDER_18',
  '18-24': 'AGE_18_24',
  '18_24': 'AGE_18_24',
  'AGE_18_24': 'AGE_18_24',
  '25-34': 'AGE_25_34',
  '25_34': 'AGE_25_34',
  'AGE_25_34': 'AGE_25_34',
  '35-44': 'AGE_35_44',
  '35_44': 'AGE_35_44',
  'AGE_35_44': 'AGE_35_44',
  '45-54': 'AGE_45_54',
  '45_54': 'AGE_45_54',
  'AGE_45_54': 'AGE_45_54',
  '55-64': 'AGE_55_64',
  '55_64': 'AGE_55_64',
  'AGE_55_64': 'AGE_55_64',
  '65+': 'AGE_65_PLUS',
  '65 PLUS': 'AGE_65_PLUS',
  '65_PLUS': 'AGE_65_PLUS',
  'AGE_65_PLUS': 'AGE_65_PLUS',
  'PREFER NOT TO SAY': 'PREFER_NOT_TO_SAY',
  'PREFER_NOT_TO_SAY': 'PREFER_NOT_TO_SAY',
};

export function parseAgeBand(value: string): AgeBand | null {
  const key = value.trim().toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ');
  return AGE_BAND_SYNONYMS[key] ?? null;
}
