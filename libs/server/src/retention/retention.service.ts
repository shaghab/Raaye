import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getLogger } from '../observability/logger';
import { PrismaService } from '../persistence/prisma.service';

export interface RetentionResult {
  importBatchesPurged: number;
  importRowsDeleted: number;
  rawWebhooksCleared: number;
  quarantineDeleted: number;
  enrollmentsExpired: number;
  bindingsDeleted: number;
}

/**
 * Scheduled cleanup of short-lived artifacts. Canonical answers, surveys, contacts and
 * audit records are never touched here.
 */
@Injectable()
export class RetentionService {
  private readonly logger = getLogger('retention');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(): Promise<RetentionResult> {
    const now = this.clock.now();
    const expiredBatches = await this.prisma.importBatch.findMany({ where: { rawExpiresAt: { lte: now }, stagingPurgedAt: null }, select: { id: true, state: true } });
    let importRowsDeleted = 0;
    for (const batch of expiredBatches) {
      const rows = await this.prisma.importRow.deleteMany({ where: { batchId: batch.id } });
      importRowsDeleted += rows.count;
      await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: { rawBytes: null, stagingPurgedAt: now, state: batch.state === 'COMPLETED' || batch.state === 'FAILED' ? batch.state : 'EXPIRED' },
      });
    }
    const rawWebhooks = await this.prisma.inboundEvent.updateMany({ where: { rawExpiresAt: { lte: now }, rawPayload: { not: { equals: null } } }, data: { rawPayload: undefined } });
    // Prisma cannot null a Json column via updateMany with `undefined`; use raw SQL for the actual clear.
    const cleared = await this.prisma.$executeRaw`UPDATE inbound_events SET raw_payload = NULL, raw_expires_at = NULL WHERE raw_expires_at <= ${now} AND raw_payload IS NOT NULL`;
    const quarantine = await this.prisma.webhookQuarantine.deleteMany({ where: { expiresAt: { lte: now } } });
    const enrollments = await this.prisma.enrollment.updateMany({ where: { expiresAt: { lte: now }, state: { in: ['AWAITING_NAME', 'AWAITING_CONSENT'] } }, data: { state: 'EXPIRED' } });
    const bindings = await this.prisma.actionBinding.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } } });
    const result = { importBatchesPurged: expiredBatches.length, importRowsDeleted, rawWebhooksCleared: Number(cleared) || rawWebhooks.count, quarantineDeleted: quarantine.count, enrollmentsExpired: enrollments.count, bindingsDeleted: bindings.count };
    if (Object.values(result).some((value) => value > 0)) this.logger.info(result, 'Retention cleanup completed');
    return result;
  }

  get retention(): { importHours: number; rawWebhookDays: number; quarantineDays: number } {
    return { importHours: this.config.IMPORT_STAGING_RETENTION_HOURS, rawWebhookDays: this.config.RAW_WEBHOOK_RETENTION_DAYS, quarantineDays: this.config.QUARANTINE_RETENTION_DAYS };
  }
}
