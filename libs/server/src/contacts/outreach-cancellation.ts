import type { TenantTx } from '../persistence/tenant-db';

export interface CancellationResult {
  messages: number;
  jobs: number;
  invitations: number;
}

/**
 * Cancel every pending proactive message, its job and open invitations for a contact.
 * Messages already handed to the provider cannot be unsent; only PENDING work is touched
 * and the send-time policy gate blocks anything that slips through.
 */
export async function cancelPendingOutreach(tx: TenantTx, contactId: string, reason: string, now: Date): Promise<CancellationResult> {
  const pending = await tx.message.findMany({
    where: { contactId, state: 'PENDING', kind: { not: 'OPT_OUT_ACK' } },
    select: { id: true },
  });
  const messageIds = pending.map((message) => message.id);
  let jobs = 0;
  if (messageIds.length > 0) {
    await tx.message.updateMany({
      where: { id: { in: messageIds } },
      data: { state: 'CANCELED', deliveryState: 'CANCELED', suppressionReason: reason },
    });
    const result = await tx.job.updateMany({
      where: { entityId: { in: messageIds }, status: 'PENDING' },
      data: { status: 'CANCELED', finishedAt: now, lastErrorCode: reason },
    });
    jobs = result.count;
  }
  const invitations = await tx.invitation.updateMany({
    where: { contactId, state: { in: ['PENDING', 'QUEUED'] } },
    data: { state: 'CANCELED', stateReason: reason },
  });
  await tx.actionBinding.updateMany({ where: { contactId, expiresAt: { gt: now } }, data: { expiresAt: now } });
  return { messages: messageIds.length, jobs, invitations: invitations.count };
}
