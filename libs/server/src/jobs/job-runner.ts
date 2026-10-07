import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '../common/errors';
import { getLogger, runWithContext } from '../observability/logger';
import type { JobKind } from '../persistence/prisma.service';
import { JOB_HANDLERS, PermanentJobError, type JobHandler } from './job-handler';
import { JobsService, type ClaimedJob } from './jobs.service';

const NON_RETRYABLE_DOMAIN_CODES = new Set([
  'CONTACT_CONSENT_MISSING',
  'CONTACT_WITHDRAWN',
  'CONTACT_ARCHIVED',
  'SURVEY_CLOSED',
  'SURVEY_NOT_OPEN',
  'TENANT_RESOURCE_NOT_FOUND',
  'TEMPLATE_NOT_READY',
  'FLOW_NOT_READY',
  'SERVICE_WINDOW_CLOSED',
  'SYNTHETIC_CONTACT',
  'ACTION_INVALID',
]);

@Injectable()
export class JobRunner {
  private readonly logger = getLogger('jobs');
  private readonly handlers = new Map<JobKind, JobHandler>();
  private inFlight = 0;

  constructor(
    private readonly jobs: JobsService,
    @Optional() @Inject(JOB_HANDLERS) handlers: JobHandler[] = [],
  ) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler: JobHandler): void {
    this.handlers.set(handler.kind, handler);
  }

  get activeCount(): number {
    return this.inFlight;
  }

  /** Claim and execute up to `limit` due jobs with bounded concurrency. Returns the number processed. */
  async runOnce(limit: number, concurrency = 4): Promise<number> {
    const claimed = await this.jobs.claimDue(limit);
    if (claimed.length === 0) return 0;
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
      while (index < claimed.length) {
        const job = claimed[index];
        index += 1;
        await this.execute(job);
      }
    });
    await Promise.all(workers);
    return claimed.length;
  }

  /** Execute a specific job id (Cloud Tasks delivery or tests). */
  async runJob(jobId: string): Promise<'DONE' | 'RETRY' | 'FAILED' | 'NOT_CLAIMABLE'> {
    const job = await this.jobs.claimOne(jobId);
    if (!job) return 'NOT_CLAIMABLE';
    return this.execute(job);
  }

  async execute(job: ClaimedJob): Promise<'DONE' | 'RETRY' | 'FAILED'> {
    const handler = this.handlers.get(job.kind);
    this.inFlight += 1;
    try {
      return await runWithContext({ correlationId: randomUUID(), jobId: job.id, organizationId: job.organizationId }, async () => {
        if (!handler) {
          this.logger.error({ kind: job.kind }, 'No handler registered for job kind');
          await this.jobs.fail(job, 'NO_HANDLER', false);
          return 'FAILED';
        }
        const started = Date.now();
        try {
          await handler.handle(job, { organizationId: job.organizationId, correlationId: job.id, actor: 'SYSTEM' });
          await this.jobs.complete(job.id);
          this.logger.debug({ kind: job.kind, ms: Date.now() - started, attempt: job.attempts }, 'Job succeeded');
          return 'DONE';
        } catch (error) {
          const { code, retryable } = classify(error);
          const outcome = await this.jobs.fail(job, code, retryable);
          this.logger.warn({ kind: job.kind, code, retryable, attempt: job.attempts, outcome, err: error instanceof Error ? error.message : String(error) }, 'Job failed');
          return outcome;
        }
      });
    } finally {
      this.inFlight -= 1;
    }
  }
}

export function classify(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof PermanentJobError) return { code: error.code, retryable: false };
  if (error instanceof DomainError) return { code: error.code, retryable: !NON_RETRYABLE_DOMAIN_CODES.has(error.code) && error.status >= 500 };
  const message = error instanceof Error ? error.message : String(error);
  return { code: message.slice(0, 60).replace(/[^\w ]/g, '_') || 'UNKNOWN_ERROR', retryable: true };
}
