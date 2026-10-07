import type { SystemContext } from '../common/context';
import type { JobKind } from '../persistence/prisma.service';
import type { ClaimedJob } from './jobs.service';

/** A handler must be idempotent: a job can run twice or resume after a crash. */
export interface JobHandler {
  readonly kind: JobKind;
  handle(job: ClaimedJob, ctx: SystemContext): Promise<void>;
}

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

/** Thrown by handlers for failures that must not be retried automatically. */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PermanentJobError';
  }
}
