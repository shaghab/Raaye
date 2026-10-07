import { deriveConsent, grantRestoresPermission, outreachEligibility } from '../consent';

const at = (iso: string) => new Date(iso);

describe('consent derivation (R13, R14)', () => {
  it('is unknown without events', () => {
    expect(deriveConsent([], 'SURVEY_INVITATIONS').status).toBe('UNKNOWN');
  });

  it('uses the latest evidence per scope', () => {
    const events = [
      { scope: 'SURVEY_INVITATIONS' as const, type: 'GRANTED' as const, evidenceAt: at('2026-01-01T00:00:00Z'), recordedAt: at('2026-01-02T00:00:00Z') },
      { scope: 'SURVEY_INVITATIONS' as const, type: 'WITHDRAWN' as const, evidenceAt: at('2026-02-01T00:00:00Z'), recordedAt: at('2026-02-01T00:00:00Z') },
      { scope: 'SURVEY_RESULTS' as const, type: 'GRANTED' as const, evidenceAt: at('2026-01-01T00:00:00Z'), recordedAt: at('2026-01-02T00:00:00Z') },
    ];
    expect(deriveConsent(events, 'SURVEY_INVITATIONS').status).toBe('WITHDRAWN');
    expect(deriveConsent(events, 'SURVEY_RESULTS').status).toBe('GRANTED');
  });

  it('does not let older re-imported evidence override a withdrawal', () => {
    const events = [
      { scope: 'SURVEY_INVITATIONS' as const, type: 'WITHDRAWN' as const, evidenceAt: at('2026-02-01T00:00:00Z'), recordedAt: at('2026-02-01T00:00:00Z') },
      { scope: 'SURVEY_INVITATIONS' as const, type: 'GRANTED' as const, evidenceAt: at('2026-01-01T00:00:00Z'), recordedAt: at('2026-03-01T00:00:00Z') },
    ];
    const current = deriveConsent(events, 'SURVEY_INVITATIONS');
    expect(current.status).toBe('WITHDRAWN');
    expect(grantRestoresPermission(current, at('2026-01-15T00:00:00Z'))).toBe(false);
    expect(grantRestoresPermission(current, at('2026-02-02T00:00:00Z'))).toBe(true);
  });

  it('blocks outreach for unknown, withdrawn and archived contacts', () => {
    expect(outreachEligibility({ archived: false, invitationConsent: 'UNKNOWN' })).toEqual({ eligible: false, reason: 'CONTACT_CONSENT_MISSING' });
    expect(outreachEligibility({ archived: false, invitationConsent: 'WITHDRAWN' })).toEqual({ eligible: false, reason: 'CONTACT_WITHDRAWN' });
    expect(outreachEligibility({ archived: true, invitationConsent: 'GRANTED' })).toEqual({ eligible: false, reason: 'CONTACT_ARCHIVED' });
    expect(outreachEligibility({ archived: false, invitationConsent: 'GRANTED' })).toEqual({ eligible: true });
  });
});
