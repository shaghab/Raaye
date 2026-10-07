import { suggestMapping, validateImportRow } from '../import-rules';
import { normalizePhone } from '../phone';

const cell = (text: string, extra: Partial<{ isFormula: boolean; isNumeric: boolean }> = {}) => ({
  text,
  isFormula: false,
  isNumeric: false,
  ...extra,
});

describe('import rules (R11, R12)', () => {
  it('normalizes a valid row including leading-zero national numbers', () => {
    const { normalized, errors } = validateImportRow(
      2,
      { name: cell('  Ayesha   Khan '), phone: cell('0300-1234567'), gender: cell('Female'), age: cell('30'), membership: cell('yes'), groups: cell('Members; Lahore'), tags: cell('vip,2026') },
      'PK',
      '2026-10-07',
    );
    expect(errors).toEqual([]);
    expect(normalized).toMatchObject({
      name: 'Ayesha Khan',
      phoneE164: '+923001234567',
      gender: 'WOMAN',
      ageYears: 30,
      ageBand: 'AGE_25_34',
      ageAsOf: '2026-10-07',
      membership: 'MEMBER',
      groups: ['Members', 'Lahore'],
      tags: ['vip', '2026'],
    });
  });

  it('rejects formula cells, scientific-notation phones, invalid ages and conflicting bands', () => {
    const { errors } = validateImportRow(
      3,
      { name: cell('=cmd()', { isFormula: true }), phone: cell('3.001234567E9', { isNumeric: true }), age: cell('150'), ageBand: cell('18-24') },
      'PK',
      '2026-10-07',
    );
    const messages = errors.map((error) => `${error.field}:${error.message}`);
    expect(messages.some((message) => message.startsWith('name:Formula'))).toBe(true);
    expect(messages.some((message) => message.startsWith('phone:Phone number was stored as a floating-point'))).toBe(true);
    expect(messages.some((message) => message.startsWith('age:Age must be between 0 and 120'))).toBe(true);
  });

  it('requires correction when exact age conflicts with an explicit age band', () => {
    const { errors } = validateImportRow(4, { name: cell('A'), phone: cell('+923001234567'), age: cell('40'), ageBand: cell('18-24') }, 'PK', '2026-10-07');
    expect(errors.map((error) => error.field)).toEqual(['age']);
  });

  it('accepts xlsx numeric phones that lost a leading zero', () => {
    const { normalized } = validateImportRow(5, { name: cell('B'), phone: cell('3001234567', { isNumeric: true }) }, 'PK', '2026-10-07');
    expect(normalized?.phoneE164).toBe('+923001234567');
  });

  it('suggests column mappings from headers', () => {
    expect(suggestMapping(['Full Name', 'WhatsApp Number', 'City', 'Age', 'Member?', 'Consent Date'])).toEqual({
      'Full Name': 'name',
      'WhatsApp Number': 'phone',
      City: 'city',
      Age: 'age',
      'Member?': 'membership',
      'Consent Date': 'consentEvidenceAt',
    });
  });
});

describe('phone normalization', () => {
  it('parses international and national formats', () => {
    expect(normalizePhone('+92 300 1234567')).toMatchObject({ ok: true, e164: '+923001234567', waId: '923001234567' });
    expect(normalizePhone('00923001234567')).toMatchObject({ ok: true, e164: '+923001234567' });
    expect(normalizePhone('03001234567', 'PK')).toMatchObject({ ok: true, e164: '+923001234567' });
    expect(normalizePhone('(202) 456-1111', 'US')).toMatchObject({ ok: true, e164: '+12024561111' });
  });

  it('rejects invalid, empty and float-coerced values', () => {
    expect(normalizePhone('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizePhone('12')).toEqual({ ok: false, reason: 'INVALID' });
    expect(normalizePhone('abc')).toEqual({ ok: false, reason: 'INVALID' });
    expect(normalizePhone('9.23001234567E11')).toEqual({ ok: false, reason: 'SCIENTIFIC_NOTATION' });
  });
});
