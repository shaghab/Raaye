import { describeSeconds, formatDateTime, isoToLocal, label, localToIso, percent } from './format';

describe('dashboard formatting helpers', () => {
  it('maps enum codes to readable labels with a safe fallback', () => {
    expect(label('SURVEY_MANAGER')).toBe('Survey Manager');
    expect(label('WITHDRAWN')).toBe('Withdrawn');
    expect(label('SOME_NEW_CODE')).toBe('Some new code');
    expect(label(null)).toBe('—');
  });

  it('formats instants in the organization timezone and round-trips local inputs', () => {
    expect(formatDateTime('2026-10-11T04:00:00Z', 'Asia/Karachi')).toBe('11 Oct 2026, 09:00');
    expect(localToIso('2026-10-11T09:00', 'Asia/Karachi')).toBe('2026-10-11T04:00:00.000Z');
    expect(isoToLocal('2026-10-11T04:00:00Z', 'Asia/Karachi')).toBe('2026-10-11T09:00');
    expect(localToIso('', 'Asia/Karachi')).toBeNull();
    expect(formatDateTime(null, 'Asia/Karachi')).toBe('—');
  });

  it('prints percentages and durations the way the reports do', () => {
    expect(percent(62.5)).toBe('62.5%');
    expect(percent(null)).toBe('N/A');
    expect(describeSeconds(172800)).toBe('2 days');
    expect(describeSeconds(3600)).toBe('1 hour');
    expect(describeSeconds(120)).toBe('2 minutes');
    expect(describeSeconds(45)).toBe('45 seconds');
  });
});
