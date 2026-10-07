import request from 'supertest';
import { OrganizationBootstrapService, SeedService, parseBootstrapArgs, type PrismaService } from '@raaye/server';
import { bootTestApp, resetDatabase, seedUser, type TestApp } from '../testing/harness';

type TransactionFn = Parameters<PrismaService['$transaction']>[0];
type Tx = Parameters<TransactionFn>[0];

describe('first-organization bootstrap for live deployments (issue #13)', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Live and production configurations reject ALLOW_DEMO_BOOTSTRAP; the bootstrap must not need it.
    t = await bootTestApp({ env: { ALLOW_DEMO_BOOTSTRAP: 'false' } });
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates the organization and an Admin invitation that is accepted through the API, then refuses once an Admin exists', async () => {
    await expect(t.app.get(SeedService).seed()).rejects.toThrow(/Demo seeding is disabled/);
    const service = t.app.get(OrganizationBootstrapService);

    const first = await service.bootstrap(parseBootstrapArgs(['--name', 'Civic Trust', '--slug', 'civic-trust', '--admin-email', 'Lead@Civic.org', '--support-contact', 'help@civic.org']));
    expect(first).toMatchObject({ slug: 'civic-trust', organizationCreated: true, adminEmail: 'lead@civic.org', revokedInvitations: 0 });
    const organization = await t.prisma.organization.findUniqueOrThrow({ where: { slug: 'civic-trust' } });
    expect(organization).toMatchObject({ name: 'Civic Trust', isDemo: false, timezone: t.config.DEFAULT_TIMEZONE, supportContact: 'help@civic.org', participantNoticeVersion: 1 });
    expect(organization.participantNotice).toContain('Civic Trust');
    const firstToken = new URL(first.acceptUrl).searchParams.get('token') ?? '';
    expect(firstToken.length).toBeGreaterThan(30);
    const invitation = await t.prisma.staffInvitation.findUniqueOrThrow({ where: { id: first.invitationId } });
    expect(invitation).toMatchObject({ organizationId: organization.id, email: 'lead@civic.org', role: 'ADMIN', invitedByUserId: null, acceptedAt: null, revokedAt: null });
    expect(invitation.tokenHash).not.toContain(firstToken);
    expect(invitation.expiresAt.getTime() - t.clock.now().getTime()).toBe(72 * 3600 * 1000);

    const audits = await t.prisma.auditEvent.findMany({ where: { organizationId: organization.id, action: 'organization.bootstrapped' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, resourceType: 'organization', resourceId: organization.id });
    expect(audits[0]?.metadata).toMatchObject({ organizationCreated: true, invitationId: first.invitationId, role: 'ADMIN' });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('civic.org');

    // A re-run before acceptance reuses the organization and replaces the pending link, including a link
    // issued to a different address when the operator corrects the email.
    const corrected = await service.bootstrap({ name: 'Civic Trust', slug: 'civic-trust', adminEmail: 'typo@civic.org' });
    expect(corrected).toMatchObject({ organizationId: organization.id, organizationCreated: false, revokedInvitations: 1 });
    const typoToken = new URL(corrected.acceptUrl).searchParams.get('token') ?? '';
    await request(t.server).post('/api/v1/staff-invitations/inspect').send({ token: firstToken }).expect(422);
    const second = await service.bootstrap({ name: 'Civic Trust (renamed later)', slug: 'civic-trust', adminEmail: 'lead@civic.org' });
    expect(second).toMatchObject({ organizationId: organization.id, organizationCreated: false, revokedInvitations: 1 });
    expect((await t.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).name).toBe('Civic Trust');
    await request(t.server).post('/api/v1/staff-invitations/inspect').send({ token: typoToken }).expect(422);
    expect(await t.prisma.staffInvitation.count({ where: { organizationId: organization.id, revokedAt: null } })).toBe(1);
    const token = new URL(second.acceptUrl).searchParams.get('token') ?? '';
    const inspect = await request(t.server).post('/api/v1/staff-invitations/inspect').send({ token }).expect(200);
    expect(inspect.body).toMatchObject({ email: 'lead@civic.org', role: 'ADMIN', organizationName: 'Civic Trust', existingAccount: false });

    // Acceptance goes through the normal flow: the invited email on a verified identity becomes the first Admin.
    const identity = 'Bearer test:uid-civic-lead:lead@civic.org';
    await request(t.server).get('/api/v1/me').set('Authorization', identity).expect(403);
    await request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', 'Bearer test:uid-other:someone@else.org').send({ token }).expect(422);
    await request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', identity).send({ token }).expect(200);
    const me = await request(t.server).get('/api/v1/me').set('Authorization', identity).expect(200);
    expect(me.body).toMatchObject({ role: 'ADMIN', organization: { slug: 'civic-trust' } });
    const members = await request(t.server).get('/api/v1/members').set('Authorization', identity).expect(200);
    expect(members.body).toHaveLength(1);
    expect(members.body[0]).toMatchObject({ email: 'lead@civic.org', role: 'ADMIN', status: 'ACTIVE' });

    // With an active Admin the command refuses, even for another email, and changes nothing.
    await expect(service.bootstrap({ name: 'Civic Trust', slug: 'civic-trust', adminEmail: 'other@civic.org' })).rejects.toMatchObject({ code: 'BOOTSTRAP_REFUSED' });
    expect(await t.prisma.staffInvitation.count({ where: { organizationId: organization.id } })).toBe(3);
    expect(await t.prisma.auditEvent.count({ where: { organizationId: organization.id, action: 'organization.bootstrapped' } })).toBe(3);

    // Admin-issued invitations are not touched by a later bootstrap of an organization without an Admin.
    const other = await t.prisma.organization.create({ data: { name: 'Other', slug: 'other', participantNotice: 'n' } });
    const admin = await seedUser(t.prisma, other.id, 'ADMIN');
    const adminInvite = await request(t.server).post('/api/v1/staff-invitations').set('Authorization', admin.authorization).send({ email: 'lead@civic.org', role: 'VIEWER' }).expect(201);
    await t.prisma.organizationMembership.update({ where: { id: admin.membershipId }, data: { status: 'REVOKED' } });
    const third = await service.bootstrap({ name: 'Other', slug: 'other', adminEmail: 'lead@civic.org' });
    expect(third.revokedInvitations).toBe(0);
    expect((await t.prisma.staffInvitation.findUniqueOrThrow({ where: { id: adminInvite.body.id } })).revokedAt).toBeNull();
  });

  it('a re-run and an acceptance of the pending link serialize on the organization row', async () => {
    const service = t.app.get(OrganizationBootstrapService);
    const first = await service.bootstrap({ name: 'Race Org', slug: 'race-org', adminEmail: 'lead@race.org' });
    const firstToken = new URL(first.acceptUrl).searchParams.get('token') ?? '';
    const authorization = 'Bearer test:uid-race-lead:lead@race.org';

    // A bootstrap re-run that pauses inside its transaction right after counting active Admins under the lock.
    let reachedCount = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateTransaction = (tx: Tx): Tx =>
      new Proxy(tx, {
        get(txTarget, txProperty) {
          const delegate = Reflect.get(txTarget, txProperty);
          if (txProperty !== 'organizationMembership') return delegate;
          return new Proxy(delegate as object, {
            get(model, method) {
              const value = Reflect.get(model, method);
              if (method !== 'count') return typeof value === 'function' ? value.bind(model) : value;
              return async (...args: unknown[]) => {
                const count = await (value as (...inner: unknown[]) => Promise<number>).apply(model, args);
                reachedCount = true;
                await gate;
                return count;
              };
            },
          });
        },
      });
    const gatedPrisma = new Proxy(t.prisma, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== '$transaction') return typeof value === 'function' ? value.bind(target) : value;
        return (fn: TransactionFn) => target.$transaction((tx) => fn(gateTransaction(tx)));
      },
    });
    const gated = new OrganizationBootstrapService(gatedPrisma, t.clock, t.config);
    const rerun = gated.bootstrap({ name: 'Race Org', slug: 'race-org', adminEmail: 'lead@race.org' });
    for (let i = 0; i < 300 && !reachedCount; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reachedCount).toBe(true);

    // The acceptance of the first link arrives while the re-run holds the organization lock...
    const acceptance = request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', authorization).send({ token: firstToken }).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const second = await rerun;
    expect(second).toMatchObject({ organizationCreated: false, revokedInvitations: 1 });
    // ...and finds the link revoked once it gets the lock: no Admin exists and only the new link is pending.
    const response = await acceptance;
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVITATION_INVALID');
    expect(await t.prisma.organizationMembership.count({ where: { organizationId: first.organizationId, role: 'ADMIN', status: 'ACTIVE' } })).toBe(0);
    expect(await t.prisma.staffInvitation.count({ where: { organizationId: first.organizationId, acceptedAt: null, revokedAt: null } })).toBe(1);
    const secondToken = new URL(second.acceptUrl).searchParams.get('token') ?? '';
    await request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', authorization).send({ token: secondToken }).expect(200);
    await expect(service.bootstrap({ name: 'Race Org', slug: 'race-org', adminEmail: 'other@race.org' })).rejects.toMatchObject({ code: 'BOOTSTRAP_REFUSED' });
  });

  it('rejects invalid input with field errors and creates nothing', async () => {
    const service = t.app.get(OrganizationBootstrapService);
    await expect(service.bootstrap({ name: 'X', slug: 'Bad Slug', adminEmail: 'nope' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: expect.arrayContaining([expect.objectContaining({ path: 'slug' }), expect.objectContaining({ path: 'adminEmail' }), expect.objectContaining({ path: 'name' })]),
    });
    expect(await t.prisma.organization.count({ where: { slug: 'bad slug' } })).toBe(0);
  });
});
