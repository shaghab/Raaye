import { addSeconds, minDate } from './clock';

/**
 * edit_expires_at = min(first_accepted_at + edit_window_seconds, effective_closes_at).
 * Zero seconds disables editing (the expiry equals the first acceptance instant).
 */
export function computeEditExpiry(firstAcceptedAt: Date, editWindowSeconds: number, closesAt: Date): Date {
  const windowEnd = addSeconds(firstAcceptedAt, Math.max(0, editWindowSeconds));
  return minDate(windowEnd, closesAt);
}

export type EditDecision =
  | { allowed: true }
  | { allowed: false; reason: 'SURVEY_NOT_OPEN' | 'SURVEY_CLOSED' | 'ANSWER_EDIT_EXPIRED' };

export interface EditContext {
  now: Date;
  runState: 'SCHEDULED' | 'ACTIVE' | 'CLOSED' | 'CANCELED';
  closesAt: Date;
  editExpiresAt: Date;
}

/** An edit is allowed only while the survey is active and strictly before both deadlines. */
export function evaluateEdit(ctx: EditContext): EditDecision {
  if (ctx.runState === 'SCHEDULED') return { allowed: false, reason: 'SURVEY_NOT_OPEN' };
  if (ctx.runState !== 'ACTIVE' || ctx.now.getTime() >= ctx.closesAt.getTime()) {
    return { allowed: false, reason: 'SURVEY_CLOSED' };
  }
  if (ctx.now.getTime() >= ctx.editExpiresAt.getTime()) {
    return { allowed: false, reason: 'ANSWER_EDIT_EXPIRED' };
  }
  return { allowed: true };
}

export type AnswerDecision =
  | { allowed: true }
  | { allowed: false; reason: 'SURVEY_NOT_OPEN' | 'SURVEY_CLOSED' };

/** A first answer is accepted only while the run is active and before closing. */
export function evaluateFirstAnswer(ctx: Omit<EditContext, 'editExpiresAt'>): AnswerDecision {
  if (ctx.runState === 'SCHEDULED') return { allowed: false, reason: 'SURVEY_NOT_OPEN' };
  if (ctx.runState !== 'ACTIVE' || ctx.now.getTime() >= ctx.closesAt.getTime()) {
    return { allowed: false, reason: 'SURVEY_CLOSED' };
  }
  return { allowed: true };
}

/**
 * Ordering rule for distinct replies: a reply whose provider timestamp is clearly older
 * than the currently accepted revision cannot overwrite it. With equal provider timestamps
 * (the provider stamps whole seconds) the order of arrival decides: the inbox position of
 * each message, which also orders the messages of one webhook batch, all stamped with the
 * same receipt time. Without a position on either side the receipt time decides, as before.
 */
export function isStaleReply(params: {
  incomingProviderAt: Date | null;
  incomingReceivedAt: Date;
  incomingSequence?: bigint | number | null;
  currentProviderAt: Date | null;
  currentReceivedAt: Date;
  currentSequence?: bigint | number | null;
}): boolean {
  const { incomingProviderAt, incomingReceivedAt, incomingSequence, currentProviderAt, currentReceivedAt, currentSequence } = params;
  if (incomingProviderAt && currentProviderAt) {
    if (incomingProviderAt.getTime() < currentProviderAt.getTime()) return true;
    if (incomingProviderAt.getTime() > currentProviderAt.getTime()) return false;
  }
  if (incomingSequence != null && currentSequence != null) return BigInt(incomingSequence) < BigInt(currentSequence);
  return incomingReceivedAt.getTime() < currentReceivedAt.getTime();
}
