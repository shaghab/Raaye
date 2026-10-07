import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { asJson } from '../persistence/json';
import { Prisma, PrismaService, type JobKind } from '../persistence/prisma.service';

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

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
    if (result.count === 1) return { id, created: true };
    const existing = await client.job.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    return { id: existing?.id ?? id, created: false };
  }

  /** Narrow control-plane claim: returns due pending jobs under a lease, across tenants. */
  async claimDue(limit: number, now = this.clock.now()): Promise<ClaimedJob[]> {
    const leaseUntil = new Date(now.getTime() + this.config.JOB_LEASE_SECONDS * 1000);
    const rows = await this.prisma.$queryRaw<
      { id: string; organization_id: string; kind: JobKind; entity_id: string | null; payload: unknown; attempts: number; max_attempts: number }[]
    >(Prisma.sql`
      UPDATE jobs SET status = 'RUNNING', lease_owner = ${this.workerId}, lease_expires_at = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'PENDING' AND due_at <= ${now}
        ORDER BY priority ASC, due_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id, kind, entity_id, payload, attempts, max_attempts
    `);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      entityId: row.entity_id,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  /** Claim one specific job (Cloud Tasks delivery). Returns null when it is not claimable. */
  async claimOne(jobId: string, now = this.clock.now()): Promise<ClaimedJob | null> {
    const leaseUntil = new Date(now.getTime() + this.config.JOB_LEASE_SECONDS * 1000);
    const rows = await this.prisma.$queryRaw<
      { id: string; organization_id: string; kind: JobKind; entity_id: string | null; payload: unknown; attempts: number; max_attempts: number }[]
    >(Prisma.sql`
      UPDATE jobs SET status = 'RUNNING', lease_owner = ${this.workerId}, lease_expires_at = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = ${jobId}::uuid AND due_at <= ${now}
        AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at < ${now}))
      RETURNING id, organization_id, kind, entity_id, payload, attempts, max_attempts
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      entityId: row.entity_id,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  async complete(jobId: string): Promise<void> {
    await this.prisma.job.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'SUCCEEDED', finishedAt: this.clock.now(), leaseOwner: null, leaseExpiresAt: null },
    });
  }

  /** Retry with exponential backoff and jitter, or fail permanently. */
  async fail(job: ClaimedJob, errorCode: string, retryable: boolean): Promise<'RETRY' | 'FAILED'> {
    const now = this.clock.now();
    if (!retryable || job.attempts >= job.maxAttempts) {
      await this.prisma.job.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: { status: 'FAILED', finishedAt: now, lastErrorCode: errorCode, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null },
      });
      return 'FAILED';
    }
    const base = Math.min(300, 5 * 2 ** (job.attempts - 1));
    const jitter = Math.random() * base * 0.25;
    const dueAt = new Date(now.getTime() + (base + jitter) * 1000);
    await this.prisma.job.updateMany({
      where: { id: job.id, status: 'RUNNING' },
      data: { status: 'PENDING', dueAt, lastErrorCode: errorCode, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null },
    });
    return 'RETRY';
  }

  /** Jobs whose worker died keep their attempt count and become claimable again. */
  async recoverExpiredLeases(now = this.clock.now()): Promise<number> {
    const expired = await this.prisma.job.findMany({ where: { status: 'RUNNING', leaseExpiresAt: { lt: now } }, select: { id: true, attempts: true, maxAttempts: true } });
    let recovered = 0;
    for (const job of expired) {
      if (job.attempts >= job.maxAttempts) {
        await this.prisma.job.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FAILED', lastErrorCode: 'LEASE_EXPIRED', lastErrorAt: now, finishedAt: now, leaseOwner: null, leaseExpiresAt: null } });
      } else {
        const result = await this.prisma.job.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'PENDING', lastErrorCode: 'LEASE_EXPIRED', lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null } });
        recovered += result.count;
      }
    }
    return recovered;
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
