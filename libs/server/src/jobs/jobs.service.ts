import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getLogger } from '../observability/logger';
import { asJson } from '../persistence/json';
import { Prisma, PrismaService, type JobKind } from '../persistence/prisma.service';
import { CloudTasksAdapter, type TaskPusher } from './cloud-tasks';

/** Minimal structural client so both the base client and tenant transactions can enqueue. */
export interface JobWriter {
  job: {
    createMany(args: { data: Prisma.JobCreateManyInput[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
    findUnique(args: { where: { dedupeKey: string }; select: { id: true } }): Promise<{ id: string } | null>;
    updateMany(args: { where: { dedupeKey: string; status: 'PENDING' }; data: { status: 'CANCELED'; finishedAt: Date } }): Promise<{ count: number }>;
  };
}

export interface EnqueueInput {
  organizationId: string;
  kind: JobKind;
  dedupeKey: string;
  dueAt: Date;
  entityId?: string | null;
  priority?: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: JobKind;
  entityId: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  /** The lease this claim holds. Completion and failure only apply while the row still carries it. */
  leaseOwner: string;
  leaseExpiresAt: Date;
}

interface ClaimedRow {
  id: string;
  organization_id: string;
  kind: JobKind;
  entity_id: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  lease_owner: string;
  lease_expires_at: Date;
}

function toClaimedJob(row: ClaimedRow): ClaimedJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    entityId: row.entity_id,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: new Date(row.lease_expires_at),
  };
}

/** Job priorities: lower runs first. Replies beat bulk invitations. */
export const JOB_PRIORITY = {
  optOut: 1,
  inbound: 5,
  reply: 10,
  lifecycle: 20,
  invitation: 50,
  results: 60,
  maintenance: 90,
} as const;

/**
 * Durable PostgreSQL job queue. Jobs are inserted in the same transaction as the domain
 * change that needs them, claimed with FOR UPDATE SKIP LOCKED under an expiring lease,
 * and retried with bounded exponential backoff. Payloads carry ids only.
 */
@Injectable()
export class JobsService {
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly logger = getLogger('jobs');
  private pushScheduled = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cloudTasks: CloudTasksAdapter,
  ) {}

  /** Idempotent enqueue: an existing job with the same dedupe key is left untouched. */
  async enqueue(client: JobWriter, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const result = await client.job.createMany({
      data: [
        {
          id,
          organizationId: input.organizationId,
          kind: input.kind,
          entityId: input.entityId ?? null,
          dedupeKey: input.dedupeKey,
          dueAt: input.dueAt,
          priority: input.priority ?? JOB_PRIORITY.invitation,
          payload: input.payload ? asJson(input.payload) : undefined,
          maxAttempts: input.maxAttempts ?? 8,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count === 1) {
      this.schedulePush();
      return { id, created: true };
    }
    const existing = await client.job.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    return { id: existing?.id ?? id, created: false };
  }

  /**
   * Under JOB_DRIVER=cloud_tasks the row alone does nothing: hand every pending, not yet
   * pushed job to the queue as an HTTP task aimed at /internal/jobs/:id/execute. Rows are
   * only visible once their transaction committed, so a push scheduled from inside a
   * transaction simply picks the job up on the next call; the periodic sweep calls this too.
   */
  async pushDue(options: { pusher?: TaskPusher; limit?: number; now?: Date } = {}): Promise<number> {
    const pusher = options.pusher ?? (this.cloudTasks.enabled ? this.cloudTasks : null);
    if (!pusher) return 0;
    const now = options.now ?? this.clock.now();
    const pending = await this.prisma.job.findMany({
      where: { status: 'PENDING', pushedAt: null },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: options.limit ?? 500,
      select: { id: true, dueAt: true, attempts: true },
    });
    let pushed = 0;
    for (const job of pending) {
      const outcome = await pusher.push({
        name: pusher.taskName(job.id, job.attempts),
        url: pusher.jobUrl(job.id),
        body: { jobId: job.id },
        scheduleTime: job.dueAt.getTime() > now.getTime() ? job.dueAt : undefined,
      });
      if (outcome === 'FAILED') {
        this.logger.warn({ jobId: job.id }, 'Task push failed; the sweep will retry');
        continue;
      }
      const marked = await this.prisma.job.updateMany({ where: { id: job.id, status: 'PENDING', pushedAt: null }, data: { pushedAt: now } });
      pushed += marked.count;
    }
    return pushed;
  }

  /** Coalesced, post-commit push attempt (no-op under the postgres driver). */
  private schedulePush(): void {
    if (!this.cloudTasks.enabled || this.pushScheduled) return;
    this.pushScheduled = true;
    setImmediate(() => {
      this.pushScheduled = false;
      void this.pushDue().catch((error: unknown) => this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Task push failed'));
    });
  }

  /** Narrow control-plane claim: returns due pending jobs under a lease, across tenants. */
  async claimDue(limit: number, now = this.clock.now()): Promise<ClaimedJob[]> {
    const leaseUntil = new Date(now.getTime() + this.config.JOB_LEASE_SECONDS * 1000);
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE jobs SET status = 'RUNNING', lease_owner = ${this.workerId}, lease_expires_at = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'PENDING' AND due_at <= ${now}
        ORDER BY priority ASC, due_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id, kind, entity_id, payload, attempts, max_attempts, lease_owner, lease_expires_at
    `);
    return rows.map(toClaimedJob);
  }

  /** Claim one specific job (Cloud Tasks delivery). Returns null when it is not claimable. */
  async claimOne(jobId: string, now = this.clock.now()): Promise<ClaimedJob | null> {
    const leaseUntil = new Date(now.getTime() + this.config.JOB_LEASE_SECONDS * 1000);
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE jobs SET status = 'RUNNING', lease_owner = ${this.workerId}, lease_expires_at = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = ${jobId}::uuid AND due_at <= ${now}
        AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at < ${now}))
      RETURNING id, organization_id, kind, entity_id, payload, attempts, max_attempts, lease_owner, lease_expires_at
    `);
    const row = rows[0];
    return row ? toClaimedJob(row) : null;
  }

  /** Only the holder of the row's current lease may settle it: an expired lease may have been reclaimed. */
  private owned(job: ClaimedJob): Prisma.JobWhereInput {
    return { id: job.id, status: 'RUNNING', leaseOwner: job.leaseOwner, leaseExpiresAt: job.leaseExpiresAt };
  }

  private lost(job: ClaimedJob, outcome: string): 'LOST' {
    this.logger.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, outcome }, 'Job lease lost before the outcome was recorded; outcome ignored');
    return 'LOST';
  }

  /** Mark the job succeeded while the caller still holds its lease. */
  async complete(job: ClaimedJob): Promise<'DONE' | 'LOST'> {
    const result = await this.prisma.job.updateMany({
      where: this.owned(job),
      data: { status: 'SUCCEEDED', finishedAt: this.clock.now(), leaseOwner: null, leaseExpiresAt: null },
    });
    return result.count === 1 ? 'DONE' : this.lost(job, 'SUCCEEDED');
  }

  /** Retry with exponential backoff and jitter, or fail permanently, while the caller still holds the lease. */
  async fail(job: ClaimedJob, errorCode: string, retryable: boolean): Promise<'RETRY' | 'FAILED' | 'LOST'> {
    const now = this.clock.now();
    if (!retryable || job.attempts >= job.maxAttempts) {
      const result = await this.prisma.job.updateMany({
        where: this.owned(job),
        data: { status: 'FAILED', finishedAt: now, lastErrorCode: errorCode, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null },
      });
      return result.count === 1 ? 'FAILED' : this.lost(job, 'FAILED');
    }
    const base = Math.min(300, 5 * 2 ** (job.attempts - 1));
    const jitter = Math.random() * base * 0.25;
    const dueAt = new Date(now.getTime() + (base + jitter) * 1000);
    const result = await this.prisma.job.updateMany({
      where: this.owned(job),
      data: { status: 'PENDING', dueAt, lastErrorCode: errorCode, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null, pushedAt: null },
    });
    if (result.count !== 1) return this.lost(job, 'RETRY');
    this.schedulePush();
    return 'RETRY';
  }

  /**
   * Jobs whose worker died keep their attempt count and become claimable again (or fail once the
   * attempts are exhausted). One conditional statement: a lease renewed between the sweep's read and
   * its write no longer satisfies `lease_expires_at < now`, so a job that was reclaimed meanwhile is
   * never reset underneath its new holder. Returns the number of jobs re-queued.
   */
  async recoverExpiredLeases(now = this.clock.now()): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ status: string }[]>(Prisma.sql`
      UPDATE jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
          finished_at = CASE WHEN attempts >= max_attempts THEN ${now} ELSE finished_at END,
          last_error_code = 'LEASE_EXPIRED', last_error_at = ${now},
          lease_owner = NULL, lease_expires_at = NULL, pushed_at = NULL, updated_at = ${now}
      WHERE status = 'RUNNING' AND lease_expires_at < ${now}
      RETURNING status
    `);
    return rows.filter((row) => row.status === 'PENDING').length;
  }

  async cancel(client: JobWriter, dedupeKey: string): Promise<boolean> {
    const result = await client.job.updateMany({ where: { dedupeKey, status: 'PENDING' }, data: { status: 'CANCELED', finishedAt: this.clock.now() } });
    return result.count > 0;
  }

  async pendingCount(): Promise<{ pending: number; running: number; failed: number; oldestDueAgeSeconds: number | null }> {
    const now = this.clock.now();
    const [pending, running, failed, oldest] = await Promise.all([
      this.prisma.job.count({ where: { status: 'PENDING', dueAt: { lte: now } } }),
      this.prisma.job.count({ where: { status: 'RUNNING' } }),
      this.prisma.job.count({ where: { status: 'FAILED' } }),
      this.prisma.job.findFirst({ where: { status: 'PENDING', dueAt: { lte: now } }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } }),
    ]);
    return { pending, running, failed, oldestDueAgeSeconds: oldest ? Math.round((now.getTime() - oldest.dueAt.getTime()) / 1000) : null };
  }
}
