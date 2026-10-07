import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { DeliveryService } from '../messaging/delivery.service';
import { getLogger } from '../observability/logger';
import { PrismaService } from '../persistence/prisma.service';
import { JOB_PRIORITY, JobsService } from './jobs.service';
import { RetentionService } from '../retention/retention.service';

export interface SweepResult {
  recoveredLeases: number;
  activations: number;
  closings: number;
  reconciledStatuses: number;
}

/**
 * Periodic due-work sweep (Cloud Scheduler in production, the worker loop locally).
 * Narrow control-plane queries find due runs by id; all processing stays tenant-scoped
 * inside the handlers.
 */
@Injectable()
export class SweepService {
  private readonly logger = getLogger('sweep');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly delivery: DeliveryService,
    private readonly retention: RetentionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private lastRetentionAt = 0;

  async run(): Promise<SweepResult> {
    const now = this.clock.now();
    const bucket = Math.floor(now.getTime() / 60_000);
    const recoveredLeases = await this.jobs.recoverExpiredLeases(now);
    const dueOpen = await this.prisma.surveyRun.findMany({ where: { state: 'SCHEDULED', opensAt: { lte: now } }, select: { id: true, organizationId: true } });
    let activations = 0;
    for (const run of dueOpen) {
      const result = await this.jobs.enqueue(this.prisma, { organizationId: run.organizationId, kind: 'ACTIVATE_SURVEY', entityId: run.id, dedupeKey: `activate:${run.id}:sweep:${bucket}`, dueAt: now, priority: JOB_PRIORITY.lifecycle, maxAttempts: 5 });
      if (result.created) activations += 1;
    }
    const dueClose = await this.prisma.surveyRun.findMany({ where: { state: 'ACTIVE', closesAt: { lte: now } }, select: { id: true, organizationId: true } });
    let closings = 0;
    for (const run of dueClose) {
      const result = await this.jobs.enqueue(this.prisma, { organizationId: run.organizationId, kind: 'CLOSE_SURVEY', entityId: run.id, dedupeKey: `close:${run.id}:sweep:${bucket}`, dueAt: now, priority: JOB_PRIORITY.lifecycle, maxAttempts: 5 });
      if (result.created) closings += 1;
    }
    const unmatched = await this.prisma.messageStatusEvent.groupBy({ by: ['organizationId'], where: { messageId: null, reconciledAt: null }, _count: { _all: true } });
    let reconciledStatuses = 0;
    for (const group of unmatched) reconciledStatuses += await this.delivery.reconcileUnmatched(group.organizationId);
    if (Date.now() - this.lastRetentionAt > 3_600_000) {
      this.lastRetentionAt = Date.now();
      await this.retention.run();
    }
    const result = { recoveredLeases, activations, closings, reconciledStatuses };
    if (recoveredLeases || activations || closings || reconciledStatuses) this.logger.info(result, 'Sweep completed');
    return result;
  }
}
