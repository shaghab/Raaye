import { Prisma } from './generated/client';

interface AdapterMeta {
  target?: string | string[];
  driverAdapterError?: { cause?: { constraint?: { index?: string; fields?: string[] }; originalMessage?: string } };
}

function constraintText(error: Prisma.PrismaClientKnownRequestError): string {
  const meta = (error.meta ?? {}) as AdapterMeta;
  const parts: string[] = [];
  if (meta.target) parts.push(Array.isArray(meta.target) ? meta.target.join(',') : meta.target);
  const constraint = meta.driverAdapterError?.cause?.constraint;
  if (constraint?.index) parts.push(constraint.index);
  if (constraint?.fields) parts.push(constraint.fields.join(','));
  if (meta.driverAdapterError?.cause?.originalMessage) parts.push(meta.driverAdapterError.cause.originalMessage);
  return parts.join(' ').toLowerCase();
}

/** P2002 unique violation, optionally narrowed to a constraint/column fragment such as "phone". */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  if (!target) return true;
  return constraintText(error).includes(target.toLowerCase());
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === 'P2034';
  const message = error instanceof Error ? error.message : String(error);
  return /could not serialize|deadlock detected/i.test(message);
}
