import type { ContactFilter } from '@raaye/contracts';
import { normalizeText } from '@raaye/domain';
import type { Prisma } from '../persistence/prisma.service';

/** Translate a demographic filter into a Prisma where clause (OR within a field, AND across). */
export function contactFilterWhere(filter: ContactFilter | undefined): Prisma.ContactWhereInput {
  if (!filter) return {};
  const where: Prisma.ContactWhereInput = {};
  const cities = (filter.city ?? []).map(normalizeText).filter((value): value is string => Boolean(value));
  if (cities.length) where.cityNormalized = { in: cities };
  const districts = (filter.district ?? []).map(normalizeText).filter((value): value is string => Boolean(value));
  if (districts.length) where.districtNormalized = { in: districts };
  if (filter.gender?.length) where.gender = { in: filter.gender };
  if (filter.ageBand?.length) where.ageBand = { in: filter.ageBand };
  if (filter.membership?.length) where.membership = { in: filter.membership };
  if (filter.occupation?.length) {
    where.OR = filter.occupation.map((occupation) => ({ occupation: { equals: occupation.trim(), mode: 'insensitive' } }));
  }
  return where;
}

export function searchWhere(search: string | undefined): Prisma.ContactWhereInput {
  const term = (search ?? '').trim();
  if (!term) return {};
  const digits = term.replace(/[^\d]/g, '');
  const clauses: Prisma.ContactWhereInput[] = [{ name: { contains: term, mode: 'insensitive' } }];
  if (digits.length >= 3) clauses.push({ phoneE164: { contains: digits } });
  return { OR: clauses };
}
