import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { DomainError } from '@raaye/server';
import type { ZodType, z } from 'zod';

/** Validate a request part against a zod schema and return the parsed value. */
@Injectable()
export class ZodPipe<T extends ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'The request is invalid',
        undefined,
        result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      );
    }
    return result.data;
  }
}

export function zodBody<T extends ZodType>(schema: T): ZodPipe<T> {
  return new ZodPipe(schema);
}
