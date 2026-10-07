import type { ConsentScope, ConsentStatus } from '@raaye/contracts';

export interface ConsentEventLike {
  scope: ConsentScope;
  type: 'GRANTED' | 'WITHDRAWN' | 'RESET';
  evidenceAt: Date;
  recordedAt: Date;
}

export interface EffectiveConsent {
  status: ConsentStatus;
  evidenceAt: Date | null;
  lastWithdrawalAt: Date | null;
}

/**
 * Effective status is derived from the latest event for the scope, ordered by
 * evidence time and then record time. No event means unknown. A RESET event (for
 * example after a phone-number change) returns the status to unknown so that new
 * evidence is required for the new number.
 */
export function deriveConsent(events: readonly ConsentEventLike[], scope: ConsentScope): EffectiveConsent {
  let latest: ConsentEventLike | null = null;
  let lastWithdrawalAt: Date | null = null;
  for (const event of events) {
    if (event.scope !== scope) continue;
    if (event.type === 'WITHDRAWN' && (!lastWithdrawalAt || event.evidenceAt > lastWithdrawalAt)) {
      lastWithdrawalAt = event.evidenceAt;
    }
    // Ties (same evidence and record time) resolve to the later event in input order.
    if (!latest || compareEvents(event, latest) >= 0) latest = event;
  }
  if (!latest || latest.type === 'RESET') return { status: 'UNKNOWN', evidenceAt: null, lastWithdrawalAt };
  return {
    status: latest.type === 'GRANTED' ? 'GRANTED' : 'WITHDRAWN',
    evidenceAt: latest.evidenceAt,
    lastWithdrawalAt,
  };
}

function compareEvents(a: ConsentEventLike, b: ConsentEventLike): number {
  const byEvidence = a.evidenceAt.getTime() - b.evidenceAt.getTime();
  if (byEvidence !== 0) return byEvidence;
  return a.recordedAt.getTime() - b.recordedAt.getTime();
}

/**
 * A grant may restore permission after a withdrawal only when its evidence is dated
 * after that withdrawal. Older evidence (for example a re-imported spreadsheet) is
 * rejected.
 */
export function grantRestoresPermission(current: EffectiveConsent, grantEvidenceAt: Date): boolean {
  if (current.status !== 'WITHDRAWN') return true;
  if (!current.lastWithdrawalAt) return true;
  return grantEvidenceAt.getTime() > current.lastWithdrawalAt.getTime();
}

export type OutreachBlockReason = 'CONTACT_ARCHIVED' | 'CONTACT_WITHDRAWN' | 'CONTACT_CONSENT_MISSING';

export function outreachEligibility(params: {
  archived: boolean;
  invitationConsent: ConsentStatus;
}): { eligible: true } | { eligible: false; reason: OutreachBlockReason } {
  if (params.archived) return { eligible: false, reason: 'CONTACT_ARCHIVED' };
  if (params.invitationConsent === 'WITHDRAWN') return { eligible: false, reason: 'CONTACT_WITHDRAWN' };
  if (params.invitationConsent !== 'GRANTED') return { eligible: false, reason: 'CONTACT_CONSENT_MISSING' };
  return { eligible: true };
}
