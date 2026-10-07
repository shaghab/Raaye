import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@raaye/contracts';
import { DomainError, currentCorrelationId, getLogger } from '@raaye/server';
import type { Request, Response } from 'express';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'ROLE_FORBIDDEN',
  404: 'TENANT_RESOURCE_NOT_FOUND',
  409: 'IDEMPOTENCY_CONFLICT',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

/** Maps domain and framework errors to the typed API error body. Never leaks internals. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = getLogger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { correlationId?: string }>();
    const correlationId = request.correlationId ?? currentCorrelationId();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody;
    if (exception instanceof DomainError) {
      status = exception.status;
      body = {
        code: exception.code,
        message: exception.message,
        correlationId,
        fieldErrors: exception.fieldErrors,
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      const message = typeof payload === 'string' ? payload : ((payload as { message?: string | string[] }).message ?? exception.message);
      body = {
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED'),
        message: Array.isArray(message) ? message.join('; ') : String(message),
        correlationId,
      };
    } else {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      if (/payload too large|request entity too large/i.test(error.message)) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        body = { code: 'VALIDATION_FAILED', message: 'The request body is too large', correlationId };
      } else {
        this.logger.error({ err: error, path: request.path, method: request.method }, 'Unhandled error');
        if (process.env['RAAYE_DEBUG_ERRORS'] === '1') console.error('[unhandled]', request.method, request.path, error);
        body = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', correlationId };
      }
    }
    if (status >= 500 && exception instanceof DomainError) {
      this.logger.error({ code: exception.code, path: request.path }, exception.message);
    } else if (status >= 400) {
      this.logger.debug({ code: body.code, status, path: request.path }, 'Request rejected');
    }
    response.status(status).json(body);
  }
}
