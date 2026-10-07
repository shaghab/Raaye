import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '@raaye/server';

const HEADER = 'x-correlation-id';

export function correlationMiddleware(request: Request & { correlationId?: string }, response: Response, next: NextFunction): void {
  const incoming = request.header(HEADER);
  const correlationId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  request.correlationId = correlationId;
  response.setHeader(HEADER, correlationId);
  requestContext.run({ correlationId }, () => next());
}
