import { evaluateSendPolicy, type PolicyInput } from '../policy';

const base: PolicyInput = {
  now: new Date('2026-10-10T09:00:00Z'),
  providerMode: 'live',
  kind: 'INVITATION',
  isFreeForm: false,
  isTest: false,
  connectionEnabled: true,
  contact: { archivedAt: null, consentInvitations: 'GRANTED', consentResults: 'GRANTED', isSynthetic: false },
  lastInboundAt: null,
  run: { state: 'ACTIVE', closesAt: new Date('2026-10-12T09:00:00Z') },
  templateReady: true,
  flowReady: true,
  needsFlow: false,
  priorUnknownAttempts: 0,
  priorAcceptedAttempts: 0,
};

describe('sending policy gate (R15, R22, R45, R57)', () => {
  it('blocks synthetic contacts in live mode but not in mock mode', () => {
    expect(evaluateSendPolicy({ ...base, contact: { ...base.contact, isSynthetic: true } })).toEqual({ allowed: false, reason: 'SYNTHETIC_CONTACT' });
    expect(evaluateSendPolicy({ ...base, providerMode: 'mock', contact: { ...base.contact, isSynthetic: true } })).toEqual({ allowed: true });
  });

  it('never uses a sender the operator disabled, whatever the message kind', () => {
    expect(evaluateSendPolicy({ ...base, connectionEnabled: false })).toEqual({ allowed: false, reason: 'CONNECTION_DISABLED' });
    expect(evaluateSendPolicy({ ...base, connectionEnabled: false, kind: 'OPT_OUT_ACK', isFreeForm: true, lastInboundAt: base.now, run: null })).toEqual({ allowed: false, reason: 'CONNECTION_DISABLED' });
    expect(evaluateSendPolicy({ ...base, connectionEnabled: false, providerMode: 'mock', isTest: true })).toEqual({ allowed: false, reason: 'CONNECTION_DISABLED' });
  });

  it('rechecks permission for the purpose at send time', () => {
    expect(evaluateSendPolicy({ ...base, contact: { ...base.contact, consentInvitations: 'WITHDRAWN' } })).toEqual({ allowed: false, reason: 'CONTACT_WITHDRAWN' });
    expect(evaluateSendPolicy({ ...base, contact: { ...base.contact, consentInvitations: 'UNKNOWN' } })).toEqual({ allowed: false, reason: 'CONTACT_CONSENT_MISSING' });
    expect(evaluateSendPolicy({ ...base, kind: 'RESULTS_INVITATION', run: null, contact: { ...base.contact, consentResults: 'UNKNOWN' } })).toEqual({ allowed: false, reason: 'CONTACT_CONSENT_MISSING' });
    expect(evaluateSendPolicy({ ...base, kind: 'OPT_OUT_ACK', isFreeForm: true, lastInboundAt: base.now, run: null, contact: { ...base.contact, consentInvitations: 'WITHDRAWN' } })).toEqual({ allowed: true });
    expect(evaluateSendPolicy({ ...base, isTest: true, providerMode: 'mock', contact: { ...base.contact, consentInvitations: 'UNKNOWN' } })).toEqual({ allowed: true });
    expect(evaluateSendPolicy({ ...base, isTest: true, providerMode: 'live', contact: { ...base.contact, consentInvitations: 'UNKNOWN' } })).toEqual({ allowed: false, reason: 'CONTACT_CONSENT_MISSING' });
  });

  it('requires templates outside the service window and approved bindings', () => {
    expect(evaluateSendPolicy({ ...base, kind: 'QUESTION', isFreeForm: true, lastInboundAt: null })).toEqual({ allowed: false, reason: 'SERVICE_WINDOW_CLOSED' });
    expect(evaluateSendPolicy({ ...base, kind: 'QUESTION', isFreeForm: true, lastInboundAt: new Date('2026-10-09T09:00:01Z') })).toEqual({ allowed: true });
    expect(evaluateSendPolicy({ ...base, kind: 'QUESTION', isFreeForm: true, lastInboundAt: new Date('2026-10-09T09:00:00Z') })).toEqual({ allowed: false, reason: 'SERVICE_WINDOW_CLOSED' });
    expect(evaluateSendPolicy({ ...base, templateReady: false })).toEqual({ allowed: false, reason: 'TEMPLATE_NOT_READY' });
    expect(evaluateSendPolicy({ ...base, kind: 'QUESTION', isFreeForm: true, lastInboundAt: base.now, needsFlow: true, flowReady: false })).toEqual({ allowed: false, reason: 'FLOW_NOT_READY' });
  });

  it('respects survey deadlines and never resends ambiguous or accepted messages', () => {
    expect(evaluateSendPolicy({ ...base, run: { state: 'ACTIVE', closesAt: base.now } })).toEqual({ allowed: false, reason: 'SURVEY_CLOSED' });
    expect(evaluateSendPolicy({ ...base, run: { state: 'SCHEDULED', closesAt: new Date('2026-10-12T09:00:00Z') } })).toEqual({ allowed: false, reason: 'SURVEY_NOT_OPEN' });
    expect(evaluateSendPolicy({ ...base, priorUnknownAttempts: 1 })).toEqual({ allowed: false, reason: 'SEND_OUTCOME_UNKNOWN' });
    expect(evaluateSendPolicy({ ...base, priorAcceptedAttempts: 1 })).toEqual({ allowed: false, reason: 'ALREADY_ACCEPTED' });
    expect(evaluateSendPolicy({ ...base, contact: { ...base.contact, archivedAt: base.now } })).toEqual({ allowed: false, reason: 'CONTACT_ARCHIVED' });
  });
});
