import { isServiceWindowOpen } from '@raaye/domain';

export interface PolicyInput {
  now: Date;
  providerMode: 'mock' | 'live';
  kind: string;
  isFreeForm: boolean;
  isTest: boolean;
  /** The organization-owned sender connection is enabled; a disabled sender blocks every kind. */
  connectionEnabled: boolean;
  contact: { archivedAt: Date | null; consentInvitations: string; consentResults: string; isSynthetic: boolean };
  lastInboundAt: Date | null;
  run: { state: string; closesAt: Date } | null;
  templateReady: boolean;
  flowReady: boolean;
  needsFlow: boolean;
  priorUnknownAttempts: number;
  priorAcceptedAttempts: number;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const PROACTIVE_KINDS = new Set(['INVITATION', 'RESULTS_INVITATION']);
const RESULTS_KINDS = new Set(['RESULTS_INVITATION', 'RESULTS_CONTENT']);
const TRANSACTIONAL_KINDS = new Set(['OPT_OUT_ACK', 'COMMAND_REPLY', 'ENROLLMENT']);

/**
 * Sending policy gate evaluated immediately before every provider call. It rechecks
 * tenant/contact state, the sender connection, permission for the purpose, run deadlines, service-window versus
 * template eligibility, required bindings and prior ambiguous attempts.
 */
export function evaluateSendPolicy(input: PolicyInput): PolicyDecision {
  if (input.priorAcceptedAttempts > 0) return { allowed: false, reason: 'ALREADY_ACCEPTED' };
  if (input.priorUnknownAttempts > 0) return { allowed: false, reason: 'SEND_OUTCOME_UNKNOWN' };
  if (!input.connectionEnabled) return { allowed: false, reason: 'CONNECTION_DISABLED' };
  if (input.providerMode === 'live' && input.contact.isSynthetic) return { allowed: false, reason: 'SYNTHETIC_CONTACT' };
  if (input.contact.archivedAt && !TRANSACTIONAL_KINDS.has(input.kind)) return { allowed: false, reason: 'CONTACT_ARCHIVED' };
  const proactive = PROACTIVE_KINDS.has(input.kind);
  if (proactive && (!input.isTest || input.providerMode === 'live')) {
    if (input.contact.consentInvitations === 'WITHDRAWN') return { allowed: false, reason: 'CONTACT_WITHDRAWN' };
    if (input.contact.consentInvitations !== 'GRANTED') return { allowed: false, reason: 'CONTACT_CONSENT_MISSING' };
  }
  if (RESULTS_KINDS.has(input.kind)) {
    if (input.contact.consentResults !== 'GRANTED') return { allowed: false, reason: 'CONTACT_CONSENT_MISSING' };
  }
  if (!TRANSACTIONAL_KINDS.has(input.kind) && !RESULTS_KINDS.has(input.kind) && input.contact.consentInvitations === 'WITHDRAWN') {
    return { allowed: false, reason: 'CONTACT_WITHDRAWN' };
  }
  if (input.run) {
    if (input.run.state === 'CANCELED' || input.run.state === 'CLOSED') return { allowed: false, reason: 'SURVEY_CLOSED' };
    if (input.run.state === 'SCHEDULED') return { allowed: false, reason: 'SURVEY_NOT_OPEN' };
    if (input.now.getTime() >= input.run.closesAt.getTime()) return { allowed: false, reason: 'SURVEY_CLOSED' };
  }
  if (input.isFreeForm) {
    if (!isServiceWindowOpen(input.lastInboundAt, input.now)) return { allowed: false, reason: 'SERVICE_WINDOW_CLOSED' };
  } else if (!input.templateReady) {
    return { allowed: false, reason: 'TEMPLATE_NOT_READY' };
  }
  if (input.needsFlow && !input.flowReady) return { allowed: false, reason: 'FLOW_NOT_READY' };
  return { allowed: true };
}
