import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneResult =
  | { ok: true; e164: string; waId: string; country: string | undefined }
  | { ok: false; reason: 'EMPTY' | 'INVALID' | 'AMBIGUOUS' | 'SCIENTIFIC_NOTATION' };

const SCIENTIFIC = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

/**
 * Normalize a phone number to E.164 using libphonenumber. National-format numbers
 * require a default country. Values that look like floating-point/scientific
 * notation are rejected instead of being coerced.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry = 'PK'): PhoneResult {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'EMPTY' };
  if (SCIENTIFIC.test(raw)) return { ok: false, reason: 'SCIENTIFIC_NOTATION' };
  // Accept common separators but reject letters and other noise.
  if (!/^[+(\d][\d\s().-]*$/.test(raw)) return { ok: false, reason: 'INVALID' };
  // A leading "00" international prefix is converted to "+".
  const candidate = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  const parsed = parsePhoneNumberFromString(candidate, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isValid()) return { ok: false, reason: 'INVALID' };
  if (!parsed.isPossible()) return { ok: false, reason: 'AMBIGUOUS' };
  const e164 = parsed.number;
  return { ok: true, e164, waId: e164.replace(/^\+/, ''), country: parsed.country };
}

/** WhatsApp sender identities (wa_id) are digit-only E.164 numbers. */
export function waIdToE164(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

export function e164ToWaId(e164: string): string {
  return e164.replace(/^\+/, '');
}
