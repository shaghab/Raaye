import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

export interface RequestContext {
  correlationId: string;
  organizationId?: string;
  userId?: string;
  jobId?: string;
}

/** Correlation context propagated across request handling, transactions and jobs. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'none';
}

export function runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  const parent = requestContext.getStore();
  return requestContext.run({ correlationId: context.correlationId ?? parent?.correlationId ?? randomUUID(), ...parent, ...context }, fn);
}

const SENSITIVE_KEYS = new Set([
  'phone',
  'phoneE164',
  'phone_e164',
  'token',
  'accessToken',
  'authorization',
  'password',
  'rawPayload',
  'body',
  'selections',
  'answer',
  'answers',
  'email',
  'name',
  'text',
]);

let rootLogger: Logger | null = null;

export function createRootLogger(level: string): Logger {
  rootLogger = pino({
    level,
    base: { service: 'raaye' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: Array.from(SENSITIVE_KEYS).flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
      censor: '[redacted]',
    },
    mixin() {
      const store = requestContext.getStore();
      return store ? { correlationId: store.correlationId, organizationId: store.organizationId, jobId: store.jobId } : {};
    },
  });
  return rootLogger;
}

export function getLogger(name: string): Logger {
  if (!rootLogger) rootLogger = createRootLogger(process.env['LOG_LEVEL'] ?? 'info');
  return rootLogger.child({ module: name });
}

/** Adapter so Nest's internal logging uses the same structured logger. */
@Injectable()
export class NestPinoLogger implements LoggerService {
  private readonly logger = getLogger('nest');
  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}
