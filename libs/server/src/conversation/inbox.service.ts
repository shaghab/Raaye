import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { JOB_PRIORITY, JobsService, type EnqueueInput } from '../jobs/jobs.service';
import { DeliveryService } from '../messaging/delivery.service';
import type { NormalizedInbound, NormalizedStatus } from '../messaging/webhook-parser';
import { getLogger } from '../observability/logger';
import { isUniqueViolation } from '../persistence/db-errors';
import { asJson } from '../persistence/json';
import { PrismaService, type MessagingConnection } from '../persistence/prisma.service';
import { parseCommand } from '@raaye/domain';

export interface IngestResult {
  accepted: number;
  duplicates: number;
  statuses: number;
  quarantined: number;
}

/**
 * Durable ingress. Every verified event is persisted (and its job enqueued) before the
 * webhook responds. Unknown sender connections are quarantined without touching any
 * organization. Opt-out commands are prioritized ahead of bulk work.
 */
@Injectable()
export class InboxService {
  private readonly logger = getLogger('inbox');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly delivery: DeliveryService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Narrow control-plane lookup: a live phone_number_id maps to exactly one organization. */
  async connectionForPhoneNumberId(phoneNumberId: string): Promise<MessagingConnection | null> {
    return this.prisma.messagingConnection.findFirst({ where: { phoneNumberId, enabled: true } });
  }

  async connectionForAppKey(appKey: string): Promise<MessagingConnection | null> {
    return this.prisma.messagingConnection.findUnique({ where: { appKey } });
  }

  async ingest(inbound: NormalizedInbound[], statuses: NormalizedStatus[], options: { appKey: string; rawPayload?: unknown; simulated?: boolean; connectionOverride?: MessagingConnection }): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicates: 0, statuses: 0, quarantined: 0 };
    const now = this.clock.now();
    const rawExpiresAt = new Date(now.getTime() + this.config.RAW_WEBHOOK_RETENTION_DAYS * 86_400_000);
    for (const event of inbound) {
      const connection = await this.resolveConnection(event.phoneNumberId, options.connectionOverride);
      if (!connection) {
        await this.quarantine(options.appKey, 'UNKNOWN_SENDER_CONNECTION', event.phoneNumberId, { kind: event.kind, providerMessageId: event.providerMessageId }, now);
        result.quarantined += 1;
        continue;
      }
      const isOptOut = event.kind === 'TEXT' && parseCommand(event.text)?.kind === 'STOP';
      const jobFor = (eventId: string): EnqueueInput => ({
        organizationId: connection.organizationId,
        kind: 'PROCESS_INBOUND',
        entityId: eventId,
        dedupeKey: `inbound:${eventId}`,
        dueAt: now,
        priority: isOptOut ? JOB_PRIORITY.optOut : JOB_PRIORITY.inbound,
        maxAttempts: 5,
      });
      try {
        // The inbox row and its processing job commit together: a delivery is either fully
        // accepted (row + job) or not persisted at all, so the provider's retry can succeed.
        await this.prisma.$transaction(async (tx) => {
          const record = await tx.inboundEvent.create({
            data: {
              organizationId: connection.organizationId,
              connectionId: connection.id,
              providerMessageId: event.providerMessageId,
              senderIdentity: event.senderIdentity,
              senderProfileName: event.senderProfileName,
              kind: event.kind,
              normalized: asJson({ kind: event.kind, text: event.text, actionId: event.actionId, flowResponse: event.flowResponse, contextMessageId: event.contextMessageId, rawType: event.rawType }),
              providerAt: event.providerAt,
              receivedAt: now,
              rawPayload: options.rawPayload !== undefined && !options.simulated ? asJson(options.rawPayload) : undefined,
              rawExpiresAt: options.rawPayload !== undefined && !options.simulated ? rawExpiresAt : null,
              isSimulated: Boolean(options.simulated),
            },
          });
          await this.jobs.enqueue(tx, jobFor(record.id));
        });
        result.accepted += 1;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Already delivered. If the earlier delivery left the row without a job (for
          // example a crash between commit and acknowledgement), make sure it gets processed.
          const existing = await this.prisma.inboundEvent.findUnique({
            where: { organizationId_connectionId_providerMessageId: { organizationId: connection.organizationId, connectionId: connection.id, providerMessageId: event.providerMessageId } },
            select: { id: true, processingState: true },
          });
          if (existing && existing.processingState === 'PENDING') await this.jobs.enqueue(this.prisma, jobFor(existing.id));
          result.duplicates += 1;
          continue;
        }
        throw error;
      }
    }
    for (const status of statuses) {
      const connection = await this.resolveConnection(status.phoneNumberId, options.connectionOverride);
      if (!connection) {
        await this.quarantine(options.appKey, 'UNKNOWN_SENDER_CONNECTION', status.phoneNumberId, { status: status.status, providerMessageId: status.providerMessageId }, now);
        result.quarantined += 1;
        continue;
      }
      await this.delivery.recordStatus(connection.organizationId, connection.id, status);
      result.statuses += 1;
    }
    return result;
  }

  /**
   * The URL app key selects a connection, but the payload still has to name that
   * connection's phone number id. A mismatch is quarantined instead of being attributed
   * to the organization behind the key.
   */
  private async resolveConnection(phoneNumberId: string, override: MessagingConnection | undefined): Promise<MessagingConnection | null> {
    if (!override) return this.connectionForPhoneNumberId(phoneNumberId);
    if (override.phoneNumberId && override.phoneNumberId !== phoneNumberId) return null;
    return override;
  }

  async quarantine(appKey: string, reason: string, phoneNumberId: string | null, payload: Record<string, unknown>, now: Date): Promise<void> {
    await this.prisma.webhookQuarantine.create({
      data: { appKey, reason, phoneNumberId, rawPayload: asJson(payload), receivedAt: now, expiresAt: new Date(now.getTime() + this.config.QUARANTINE_RETENTION_DAYS * 86_400_000) },
    });
    this.logger.warn({ appKey, reason }, 'Webhook payload quarantined');
  }
}
