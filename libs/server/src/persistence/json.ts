import { Prisma } from './generated/client';

/** Mark an already JSON-serializable value as Prisma JSON input. */
export function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Nullable JSON columns need Prisma.JsonNull rather than a bare null. */
export function asJsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
