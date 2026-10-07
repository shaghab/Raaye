import { bootstrapInputSchema, defaultParticipantNotice, parseBootstrapArgs } from '../bootstrap.service';

describe('bootstrap:org argument parsing and validation', () => {
  it('parses --key value and --key=value options into the schema shape', () => {
    const parsed = parseBootstrapArgs(['--name', 'Civic Trust', '--slug=civic-trust', '--admin-email', 'Lead@Civic.org', '--timezone', 'Asia/Karachi']);
    expect(parsed).toEqual({ name: 'Civic Trust', slug: 'civic-trust', adminEmail: 'Lead@Civic.org', supportContact: undefined, timezone: 'Asia/Karachi' });
    const input = bootstrapInputSchema.parse(parsed);
    expect(input.adminEmail).toBe('lead@civic.org');
    expect(input.timezone).toBe('Asia/Karachi');
  });

  it('rejects unknown options and positional arguments', () => {
    expect(() => parseBootstrapArgs(['--name', 'X', '--password', 'secret'])).toThrow(/Unknown option/);
    expect(() => parseBootstrapArgs(['civic'])).toThrow(/positional/i);
  });

  it('validates the slug, email and time zone', () => {
    const base = { name: 'Civic Trust', slug: 'civic-trust', adminEmail: 'lead@civic.org' };
    expect(bootstrapInputSchema.safeParse({ ...base, slug: 'Civic Trust' }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ ...base, slug: '-civic' }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ ...base, slug: 'a'.repeat(65) }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ ...base, adminEmail: 'not-an-email' }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ ...base, name: 'C' }).success).toBe(false);
    expect(bootstrapInputSchema.safeParse({ name: 'Civic Trust', slug: 'CIVIC-TRUST', adminEmail: 'lead@civic.org' }).data?.slug).toBe('civic-trust');
    const missing = bootstrapInputSchema.safeParse({ name: 'Civic Trust' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path.join('.'))).toEqual(expect.arrayContaining(['slug', 'adminEmail']));
  });

  it('derives a reviewable default participant notice from the organization name', () => {
    const notice = defaultParticipantNotice('Civic Trust');
    expect(notice).toContain('Civic Trust');
    expect(notice).toContain('STOP');
  });
});
