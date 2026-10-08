import { computeEditExpiry, evaluateEdit, evaluateFirstAnswer, isStaleReply } from '../edit-window';

const T = new Date('2026-10-10T09:00:00.000Z');
const plus = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const closesAt = plus(48 * 3600);

describe('edit window (R34, R35)', () => {
  it('fixes the expiry at first acceptance plus the window', () => {
    expect(computeEditExpiry(T, 120, closesAt)).toEqual(plus(120));
  });

  it('never extends past survey closing', () => {
    expect(computeEditExpiry(T, 120, plus(60))).toEqual(plus(60));
  });

  it('zero seconds disables editing', () => {
    const expiry = computeEditExpiry(T, 0, closesAt);
    expect(expiry).toEqual(T);
    expect(evaluateEdit({ now: T, runState: 'ACTIVE', closesAt, editExpiresAt: expiry })).toEqual({
      allowed: false,
      reason: 'ANSWER_EDIT_EXPIRED',
    });
  });

  it('allows an edit at 119 seconds and rejects at exactly 120 seconds', () => {
    const editExpiresAt = computeEditExpiry(T, 120, closesAt);
    expect(evaluateEdit({ now: plus(119), runState: 'ACTIVE', closesAt, editExpiresAt })).toEqual({ allowed: true });
    expect(evaluateEdit({ now: plus(119.999), runState: 'ACTIVE', closesAt, editExpiresAt })).toEqual({ allowed: true });
    expect(evaluateEdit({ now: plus(120), runState: 'ACTIVE', closesAt, editExpiresAt })).toEqual({
      allowed: false,
      reason: 'ANSWER_EDIT_EXPIRED',
    });
  });

  it('rejects edits once the survey is closed or the deadline is reached', () => {
    const editExpiresAt = computeEditExpiry(T, 3600, closesAt);
    expect(evaluateEdit({ now: plus(10), runState: 'CLOSED', closesAt, editExpiresAt })).toEqual({
      allowed: false,
      reason: 'SURVEY_CLOSED',
    });
    expect(evaluateEdit({ now: closesAt, runState: 'ACTIVE', closesAt, editExpiresAt: plus(2 * 48 * 3600) })).toEqual({
      allowed: false,
      reason: 'SURVEY_CLOSED',
    });
    expect(evaluateFirstAnswer({ now: closesAt, runState: 'ACTIVE', closesAt })).toEqual({ allowed: false, reason: 'SURVEY_CLOSED' });
    expect(evaluateFirstAnswer({ now: T, runState: 'SCHEDULED', closesAt })).toEqual({ allowed: false, reason: 'SURVEY_NOT_OPEN' });
  });

  it('treats clearly older replies as stale and uses ingress order on ties (R39)', () => {
    expect(
      isStaleReply({ incomingProviderAt: plus(5), incomingReceivedAt: plus(9), currentProviderAt: plus(6), currentReceivedAt: plus(7) }),
    ).toBe(true);
    expect(
      isStaleReply({ incomingProviderAt: plus(7), incomingReceivedAt: plus(1), currentProviderAt: plus(6), currentReceivedAt: plus(7) }),
    ).toBe(false);
    expect(
      isStaleReply({ incomingProviderAt: plus(6), incomingReceivedAt: plus(6), currentProviderAt: plus(6), currentReceivedAt: plus(7) }),
    ).toBe(true);
    expect(
      isStaleReply({ incomingProviderAt: plus(6), incomingReceivedAt: plus(8), currentProviderAt: plus(6), currentReceivedAt: plus(7) }),
    ).toBe(false);
  });

  it('breaks equal provider timestamps by the order of arrival before the receipt time (R39)', () => {
    // One webhook batch: the same provider second and one receipt time for every message; the later arrival wins.
    const batch = { incomingProviderAt: plus(6), incomingReceivedAt: plus(7), currentProviderAt: plus(6), currentReceivedAt: plus(7) };
    expect(isStaleReply({ ...batch, incomingSequence: 10n, currentSequence: 11n })).toBe(true);
    expect(isStaleReply({ ...batch, incomingSequence: 12, currentSequence: 11n })).toBe(false);
    // The order of arrival outranks the receipt time, which concurrent deliveries can stamp out of order.
    expect(isStaleReply({ ...batch, incomingReceivedAt: plus(9), incomingSequence: 10n, currentSequence: 11n })).toBe(true);
    // A clearly newer provider timestamp still wins whatever the order of arrival.
    expect(isStaleReply({ ...batch, incomingProviderAt: plus(8), incomingSequence: 10n, currentSequence: 11n })).toBe(false);
    // Without a position on one side (an answer recorded before positions were kept) the receipt time decides, and a tie stands.
    expect(isStaleReply({ ...batch, incomingSequence: 10n, currentSequence: null })).toBe(false);
    expect(isStaleReply({ ...batch, incomingReceivedAt: plus(6), incomingSequence: 10n })).toBe(true);
  });
});
