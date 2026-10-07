import type { ErrorCode, FieldError } from '@raaye/contracts';

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  MEMBERSHIP_REQUIRED: 403,
  ROLE_FORBIDDEN: 403,
  TENANT_RESOURCE_NOT_FOUND: 404,
  CONTACT_DUPLICATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SURVEY_STATE_INVALID: 409,
  RESULTS_ALREADY_SHARED: 409,
  IMPORT_STATE_INVALID: 409,
  LAST_ADMIN_PROTECTED: 409,
  SIMULATOR_DISABLED: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  CONFIGURATION_INVALID: 500,
};

/** Typed domain error carrying a safe code, a staff-facing message and optional details. */
export class DomainError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly fieldErrors?: FieldError[],
    status?: number,
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = status ?? STATUS_BY_CODE[code] ?? 422;
  }
}

export function notFound(resource: string): DomainError {
  return new DomainError('TENANT_RESOURCE_NOT_FOUND', `${resource} was not found`);
}

export function forbidden(message = 'This action is not permitted for your role'): DomainError {
  return new DomainError('ROLE_FORBIDDEN', message);
}

export function invalid(message: string, fieldErrors?: FieldError[], details?: Record<string, unknown>): DomainError {
  return new DomainError('VALIDATION_FAILED', message, details, fieldErrors);
}
