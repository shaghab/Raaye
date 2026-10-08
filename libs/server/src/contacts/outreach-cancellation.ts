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

export type WithdrawnScope = 'SURVEY_INVITATIONS' | 'SURVEY_RESULTS';
const RESULTS_KINDS = ['RESULTS_INVITATION', 'RESULTS_CONTENT'] as const;
/** Messages that drive survey participation; replies to what the participant just sent (command replies, results menus) are not among them. */
const SURVEY_KINDS = ['INVITATION', 'QUESTION', 'ACKNOWLEDGEMENT', 'PROFILE_OFFER', 'PROFILE_FLOW', 'ENROLLMENT'] as const;

/**
 * Cancel every pending proactive message, its job and open invitations for a contact, for the
 * permission scopes that were withdrawn (both by default: archive, phone change, STOP, which
 * cancel everything but the opt-out acknowledgement). The two scopes are independent:
 * withdrawing survey invitations alone cancels the survey participation messages and controls
 * and leaves result notices, result content, the results menu and View results controls
 * untouched; withdrawing results alone touches only the result messages and controls.
 */
export async function cancelPendingOutreach(tx: TenantTx, contactId: string, reason: string, now: Date, scopes: readonly WithdrawnScope[] = ['SURVEY_INVITATIONS', 'SURVEY_RESULTS']): Promise<CancellationResult> {
  const invitations = scopes.includes('SURVEY_INVITATIONS');
  const results = scopes.includes('SURVEY_RESULTS');
  if (!invitations && !results) return { messages: 0, jobs: 0, invitations: 0 };
  const kind: Prisma.MessageWhereInput['kind'] = invitations && results ? { not: 'OPT_OUT_ACK' } : invitations ? { in: [...SURVEY_KINDS] } : { in: [...RESULTS_KINDS] };
  const { messageIds, jobs } = await cancelPendingMessages(tx, { contactId, kind }, reason, now);
  if (results && messageIds.length > 0) {
    await tx.resultRecipient.updateMany({ where: { invitationMessageId: { in: messageIds }, accessState: { in: ['PENDING', 'INVITED'] } }, data: { accessState: 'SUPPRESSED', suppressionReason: reason } });
  }
  const canceledInvitations = invitations
    ? await tx.invitation.updateMany({ where: { contactId, state: { in: ['PENDING', 'QUEUED'] } }, data: { state: 'CANCELED', stateReason: reason } })
    : { count: 0 };
  const purpose: Prisma.ActionBindingWhereInput['purpose'] = invitations && results ? undefined : invitations ? { not: 'VIEW_RESULTS' } : 'VIEW_RESULTS';
  await tx.actionBinding.updateMany({ where: { contactId, expiresAt: { gt: now }, purpose }, data: { expiresAt: now } });
  return { messages: messageIds.length, jobs, invitations: canceledInvitations.count };
}
