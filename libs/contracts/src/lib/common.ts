import { z } from 'zod';
import { LIMITS } from './limits';

export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export const localizedText = (max: number) =>
  z
    .record(z.string().regex(LOCALE_PATTERN, 'Invalid locale key'), z.string().trim().min(1).max(max))
    .refine((map) => typeof map['en'] === 'string' && map['en'].length > 0, {
      message: 'English text is required',
    });

export type LocalizedText = Record<string, string>;

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pagination.max).default(LIMITS.pagination.default),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const idempotencyKeySchema = z.string().trim().min(8).max(128);

export function pickLocale(text: LocalizedText | null | undefined, locale = 'en'): string {
  if (!text) return '';
  return text[locale] ?? text['en'] ?? Object.values(text)[0] ?? '';
}
