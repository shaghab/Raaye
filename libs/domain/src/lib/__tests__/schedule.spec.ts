import { computeClosesAt, validateTiming } from '../schedule';

describe('schedule (R26)', () => {
  it('closes exactly 48 hours after the intended opening by default', () => {
    const opensAt = new Date('2026-11-01T09:00:00+05:00');
    expect(computeClosesAt({ opensAt, durationSeconds: 48 * 3600, explicitClosesAt: null }).toISOString()).toBe(
      '2026-11-03T04:00:00.000Z',
    );
  });

  it('respects an explicit closing instant', () => {
    const opensAt = new Date('2026-11-01T04:00:00.000Z');
    const explicit = new Date('2026-11-02T04:00:00.000Z');
    expect(computeClosesAt({ opensAt, durationSeconds: 48 * 3600, explicitClosesAt: explicit })).toEqual(explicit);
  });

  it('validates guardrails', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const opensAt = new Date('2026-10-11T00:00:00Z');
    expect(
      validateTiming({ now, opensAt, durationSeconds: 48 * 3600, editWindowSeconds: 120, explicitClosesAt: null, scheduled: true }),
    ).toEqual([]);
    const errors = validateTiming({
      now,
      opensAt: new Date('2026-10-09T00:00:00Z'),
      durationSeconds: 60,
      editWindowSeconds: 5000,
      explicitClosesAt: new Date('2026-10-09T00:30:00Z'),
      scheduled: true,
    }).map((error) => error.code);
    expect(errors).toEqual(['DURATION_OUT_OF_RANGE', 'EDIT_WINDOW_OUT_OF_RANGE', 'EXPLICIT_CLOSE_OUT_OF_RANGE', 'OPENS_IN_PAST']);
  });
});
