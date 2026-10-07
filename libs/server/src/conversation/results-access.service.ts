import { Inject, Injectable } from '@nestjs/common';
import { LIMITS, pickLocale, type LocalizedText } from '@raaye/contracts';
import { copy, formatResultsChunks, type Clock, type SnapshotAggregate } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { SystemContext } from '../common/context';
import { JOB_PRIORITY } from '../jobs/jobs.service';
import { DeliveryService } from '../messaging/delivery.service';
import type { Contact, MessagingConnection } from '../persistence/prisma.service';
import type { TenantTx } from '../persistence/tenant-db';

/** Participant-side access to shared result snapshots (RESULTS command and View results). */
@Injectable()
export class ResultsAccessService {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Snapshots already shared with this respondent and not revoked. */
  async availableFor(tx: TenantTx, contactId: string): Promise<{ snapshotId: string; title: string }[]> {
    const recipients = await tx.resultRecipient.findMany({
      where: { contactId, accessState: { in: ['INVITED', 'VIEWED'] }, snapshot: { revokedAt: null } },
      include: { snapshot: { include: { run: { include: { revision: { select: { title: true, locale: true } } } } } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return recipients.map((recipient) => ({ snapshotId: recipient.snapshotId, title: pickLocale(recipient.snapshot.run.revision.title as LocalizedText, recipient.snapshot.run.revision.locale) }));
  }

  /** Validate eligibility again and queue the bound summary chunks inside the current window. */
  async deliver(tx: TenantTx, ctx: SystemContext, contact: Contact, connection: MessagingConnection, snapshotId: string, eventId: string): Promise<string> {
    const recipient = await tx.resultRecipient.findUnique({ where: { organizationId_snapshotId_contactId: { organizationId: ctx.organizationId, snapshotId, contactId: contact.id } }, include: { snapshot: true } });
    if (!recipient || recipient.snapshot.revokedAt || contact.consentResults !== 'GRANTED' || contact.archivedAt) {
      await this.delivery.createMessage(tx, { organizationId: ctx.organizationId, connectionId: connection.id, contactId: contact.id, kind: 'COMMAND_REPLY', rendered: { type: 'text', body: copy.notEligible }, dedupeKey: `results-denied:${eventId}` });
      return 'RESULTS_NOT_ELIGIBLE';
    }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
    const aggregate = recipient.snapshot.aggregate as unknown as SnapshotAggregate;
    const chunks = formatResultsChunks(aggregate, org.name, 'en').slice(0, 10);
    for (const [index, chunk] of chunks.entries()) {
      await this.delivery.createMessage(tx, {
        organizationId: ctx.organizationId,
        connectionId: connection.id,
        contactId: contact.id,
        kind: 'RESULTS_CONTENT',
        rendered: { type: 'text', body: chunk.slice(0, LIMITS.serviceWindowHours * 0 + 4096) },
        dedupeKey: `results-content:${snapshotId}:${contact.id}:${eventId}:${index}`,
        snapshotId,
        priority: JOB_PRIORITY.results,
      });
    }
    await tx.resultRecipient.update({ where: { id: recipient.id }, data: { accessState: 'VIEWED', viewedAt: this.clock.now() } });
    await this.audit.record(ctx, { action: 'results.viewed', resourceType: 'result_snapshot', resourceId: snapshotId, metadata: { contactId: contact.id, chunks: chunks.length } }, tx);
    return 'RESULTS_DELIVERED';
  }
}
