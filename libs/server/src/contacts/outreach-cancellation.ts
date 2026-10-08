import type { Prisma } from '../persistence/prisma.service';
import type { TenantTx } from '../persistence/tenant-db';

export interface CancellationResult {
  messages: number;
  jobs: number;
  invitations: number;
}

/**
 * Cancel the pending messages matching `where` together with their send jobs. Messages already
 * handed to the provider cannot be unsent; only PENDING work is touched and the send-time
 * policy gate blocks anything that slips through.
 */
export async function cancelPendingMessages(tx: TenantTx, where: Prisma.MessageWhereInput, reason: string, now: Date): Promise<{ messageIds: string[]; jobs: number }> {
  const pending = await tx.message.findMany({ where: { ...where, state: 'PENDING' }, select: { id: true } });
  const messageIds = pending.map((message) => message.id);
  if (messageIds.length === 0) return { messageIds, jobs: 0 };
  await tx.message.updateMany({
    where: { id: { in: messageIds }, state: 'PENDING' },
    data: { state: 'CANCELED', deliveryState: 'CANCELED', suppressionReason: reason },
  });
  const jobs = await tx.job.updateMany({
    where: { entityId: { in: messageIds }, status: 'PENDING' },
    data: { status: 'CANCELED', finishedAt: now, lastErrorCode: reason },
  });
  return { messageIds, jobs: jobs.count };
}

/** Cancel every pending proactive message, its job and open invitations for a contact. */
export async function cancelPendingOutreach(tx: TenantTx, contactId: string, reason: string, now: Date): Promise<CancellationResult> {
  const { messageIds, jobs } = await cancelPendingMessages(tx, { contactId, kind: { not: 'OPT_OUT_ACK' } }, reason, now);
  if (messageIds.length > 0) {
    await tx.resultRecipient.updateMany({ where: { invitationMessageId: { in: messageIds }, accessState: { in: ['PENDING', 'INVITED'] } }, data: { accessState: 'SUPPRESSED', suppressionReason: reason } });
  }
  const invitations = await tx.invitation.updateMany({
    where: { contactId, state: { in: ['PENDING', 'QUEUED'] } },
    data: { state: 'CANCELED', stateReason: reason },
  });
  await tx.actionBinding.updateMany({ where: { contactId, expiresAt: { gt: now } }, data: { expiresAt: now } });
  return { messages: messageIds.length, jobs, invitations: invitations.count };
}
