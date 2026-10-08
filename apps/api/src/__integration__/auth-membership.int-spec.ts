import request from 'supertest';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, strayToken, type TestApp } from '../testing/harness';

describe('authentication and membership (R04, R05)', () => {
  let t: TestApp;
  let orgId: string;

  beforeAll(async () => {
    t = await bootTestApp();
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('rejects anonymous and malformed tokens', async () => {
    await request(t.server).get('/api/v1/me').expect(401);
    const bad = await request(t.server).get('/api/v1/me').set('Authorization', 'Bearer nonsense').expect(401);
    expect(bad.body.code).toBe('UNAUTHENTICATED');
    expect(bad.body.correlationId).toBeTruthy();
  });

  it('a valid identity without membership cannot read organization data (R04)', async () => {
    const response = await request(t.server).get('/api/v1/me').set('Authorization', strayToken()).expect(403);
    expect(response.body.code).toBe('MEMBERSHIP_REQUIRED');
    await request(t.server).get('/api/v1/organization').set('Authorization', strayToken()).expect(403);
  });

  it('returns the active membership and enforces the role matrix', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const viewer = await seedUser(t.prisma, orgId, 'VIEWER');
    const me = await request(t.server).get('/api/v1/me').set('Authorization', admin.authorization).expect(200);
    expect(me.body.role).toBe('ADMIN');
    expect(me.body.organization.id).toBe(orgId);
    expect(me.body.features.messagingMode).toBe('mock');
    const forbidden = await request(t.server).get('/api/v1/members').set('Authorization', viewer.authorization).expect(403);
    expect(forbidden.body.code).toBe('ROLE_FORBIDDEN');
    await request(t.server).get('/api/v1/members').set('Authorization', admin.authorization).expect(200);
  });

  it('revoking a membership blocks the next request and the last Admin is protected (R05)', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    await request(t.server).get('/api/v1/organization').set('Authorization', manager.authorization).expect(200);
    await request(t.server).delete(`/api/v1/members/${manager.membershipId}`).set('Authorization', admin.authorization).expect(204);
    const blocked = await request(t.server).get('/api/v1/organization').set('Authorization', manager.authorization).expect(403);
    expect(blocked.body.code).toBe('MEMBERSHIP_REQUIRED');

    // Remove every other admin, then try to remove / downgrade the last one.
    const admins = await t.prisma.organizationMembership.findMany({ where: { organizationId: orgId, role: 'ADMIN', status: 'ACTIVE' } });
    for (const membership of admins) {
      if (membership.id !== admin.membershipId) {
        await request(t.server).delete(`/api/v1/members/${membership.id}`).set('Authorization', admin.authorization).expect(204);
      }
    }
    const last = await request(t.server).delete(`/api/v1/members/${admin.membershipId}`).set('Authorization', admin.authorization).expect(409);
    expect(last.body.code).toBe('LAST_ADMIN_PROTECTED');
    const downgrade = await request(t.server)
      .patch(`/api/v1/members/${admin.membershipId}`)
      .set('Authorization', admin.authorization)
      .send({ role: 'VIEWER' })
      .expect(409);
    expect(downgrade.body.code).toBe('LAST_ADMIN_PROTECTED');
  });

  it('concurrent Admin downgrades cannot remove the last Admin (R05)', async () => {
    const org = await seedOrganization(t.prisma, 'Org Race');
    const first = await seedUser(t.prisma, org.id, 'ADMIN');
    const second = await seedUser(t.prisma, org.id, 'ADMIN');
    for (let round = 0; round < 3; round += 1) {
      await t.prisma.organizationMembership.updateMany({ where: { organizationId: org.id }, data: { role: 'ADMIN', status: 'ACTIVE', revokedAt: null } });
      const [a, b] = await Promise.all([
        request(t.server).patch(`/api/v1/members/${second.membershipId}`).set('Authorization', first.authorization).send({ role: 'VIEWER' }),
        request(t.server).delete(`/api/v1/members/${first.membershipId}`).set('Authorization', second.authorization),
      ]);
      const successes = [a.status, b.status].filter((status) => status < 300).length;
      expect(successes).toBe(1);
      const failed = a.status < 300 ? b : a;
      expect(['LAST_ADMIN_PROTECTED', 'ROLE_FORBIDDEN']).toContain(failed.body.code);
      expect(await t.prisma.organizationMembership.count({ where: { organizationId: org.id, role: 'ADMIN', status: 'ACTIVE' } })).toBe(1);
    }
  });

  it('staff invitations are single-use, expiring and bound to the invited email', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const created = await request(t.server)
      .post('/api/v1/staff-invitations')
      .set('Authorization', admin.authorization)
      .send({ email: 'New.Person@Example.org', role: 'VIEWER' })
      .expect(201);
    expect(created.body.email).toBe('new.person@example.org');
    const token = new URL(created.body.acceptUrl).searchParams.get('token') ?? '';
    expect(token.length).toBeGreaterThan(30);
    const stored = await t.prisma.staffInvitation.findUnique({ where: { id: created.body.id } });
    expect(stored?.tokenHash).not.toContain(token);

    const inspect = await request(t.server).post('/api/v1/staff-invitations/inspect').send({ token }).expect(200);
    expect(inspect.body).toMatchObject({ email: 'new.person@example.org', role: 'VIEWER', organizationName: 'Org A' });

    // Wrong email on an existing identity is rejected.
    const mismatch = await request(t.server)
      .post('/api/v1/staff-invitations/accept')
      .set('Authorization', 'Bearer test:uid-other:someone.else@example.org')
      .send({ token })
      .expect(422);
    expect(mismatch.body.code).toBe('INVITATION_EMAIL_MISMATCH');

    // Existing identity with the right email creates the membership from the invitation record.
    await request(t.server)
      .post('/api/v1/staff-invitations/accept')
      .set('Authorization', 'Bearer test:uid-newperson:new.person@example.org')
      .send({ token })
      .expect(200);
    const me = await request(t.server).get('/api/v1/me').set('Authorization', 'Bearer test:uid-newperson:new.person@example.org').expect(200);
    expect(me.body.role).toBe('VIEWER');

    // Single use.
    const reuse = await request(t.server)
      .post('/api/v1/staff-invitations/accept')
      .set('Authorization', 'Bearer test:uid-newperson:new.person@example.org')
      .send({ token })
      .expect(422);
    expect(reuse.body.code).toBe('INVITATION_INVALID');

    // Expiry is enforced against the server clock.
    const second = await request(t.server)
      .post('/api/v1/staff-invitations')
      .set('Authorization', admin.authorization)
      .send({ email: 'late@example.org', role: 'VIEWER' })
      .expect(201);
    const secondToken = new URL(second.body.acceptUrl).searchParams.get('token') ?? '';
    t.clock.advance(73 * 3600 * 1000);
    await request(t.server).post('/api/v1/staff-invitations/inspect').send({ token: secondToken }).expect(422);
    t.clock.advance(-73 * 3600 * 1000);
  });

  it('an invitation that expires while its acceptance waits for the organization lock is refused', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const created = await request(t.server)
      .post('/api/v1/staff-invitations')
      .set('Authorization', admin.authorization)
      .send({ email: 'late.joiner@example.org', role: 'VIEWER' })
      .expect(201);
    const token = new URL(created.body.acceptUrl).searchParams.get('token') ?? '';
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Another transaction holds the organization row, as a bootstrap re-run or a member change would.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
        await released;
      },
      { timeout: 20_000 },
    );
    for (let i = 0; i < 300; i += 1) {
      const free = await t.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE SKIP LOCKED`;
      if (free.length === 0) break;
      await sleep(10);
    }
    // The acceptance passes its pre-checks while the invitation is still valid, then waits for the lock...
    const acceptance = request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', 'Bearer test:uid-late:late.joiner@example.org').send({ token }).then((response) => response);
    for (let i = 0; i < 300; i += 1) {
      const [row] = await t.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) > 0) break;
      await sleep(10);
    }
    // ...and the invitation expires during that wait.
    t.clock.advance(73 * 3600 * 1000);
    release();
    await holder;
    const response = await acceptance;
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVITATION_INVALID');
    expect((await t.prisma.staffInvitation.findUniqueOrThrow({ where: { id: created.body.id } })).acceptedAt).toBeNull();
    expect(await t.prisma.organizationMembership.count({ where: { organizationId: orgId, user: { email: 'late.joiner@example.org' } } })).toBe(0);
    t.clock.advance(-73 * 3600 * 1000);
  });

  it('an invitation that expires while its acceptance waits for the invitee\'s user row is refused', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    // The invitee already has an account (an identity that joined another organization before).
    const busy = await t.prisma.user.create({ data: { firebaseUid: 'uid-busy', email: 'busy.joiner@example.org', displayName: 'Busy Joiner' } });
    const created = await request(t.server)
      .post('/api/v1/staff-invitations')
      .set('Authorization', admin.authorization)
      .send({ email: 'busy.joiner@example.org', role: 'VIEWER' })
      .expect(201);
    const token = new URL(created.body.acceptUrl).searchParams.get('token') ?? '';
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Another transaction holds the user row, as the same identity's acceptance for another organization would.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${busy.id}::uuid FOR UPDATE`;
        await released;
      },
      { timeout: 20_000 },
    );
    for (let i = 0; i < 300; i += 1) {
      const free = await t.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${busy.id}::uuid FOR UPDATE SKIP LOCKED`;
      if (free.length === 0) break;
      await sleep(10);
    }
    // The acceptance takes the organization lock, then waits for the user row...
    const acceptance = request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', 'Bearer test:uid-busy:busy.joiner@example.org').send({ token }).then((response) => response);
    for (let i = 0; i < 300; i += 1) {
      const [row] = await t.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) > 0) break;
      await sleep(10);
    }
    // ...and the invitation expires during that wait.
    t.clock.advance(73 * 3600 * 1000);
    release();
    await holder;
    const response = await acceptance;
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVITATION_INVALID');
    expect(await t.prisma.staffInvitation.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ acceptedAt: null, acceptedByUserId: null });
    expect(await t.prisma.organizationMembership.count({ where: { organizationId: orgId, userId: busy.id } })).toBe(0);
    t.clock.advance(-73 * 3600 * 1000);
    // With time to spare, the same acceptance waits for the row and then joins.
    const fresh = await request(t.server).post('/api/v1/staff-invitations').set('Authorization', admin.authorization).send({ email: 'busy.joiner@example.org', role: 'VIEWER' }).expect(201);
    await request(t.server).post('/api/v1/staff-invitations/accept').set('Authorization', 'Bearer test:uid-busy:busy.joiner@example.org').send({ token: new URL(fresh.body.acceptUrl).searchParams.get('token') ?? '' }).expect(200);
    expect(await t.prisma.organizationMembership.count({ where: { organizationId: orgId, userId: busy.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('concurrent participant-notice changes receive distinct, increasing versions (R14)', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const before = (await request(t.server).get('/api/v1/organization').set('Authorization', admin.authorization).expect(200)).body;
    const texts = [1, 2, 3].map((n) => `Notice variant ${n}: this consultation is voluntary and your answers stay with authorized administrators only.`);
    const responses = await Promise.all(texts.map((text) => request(t.server).patch('/api/v1/organization').set('Authorization', admin.authorization).send({ participantNotice: text })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const versions = responses.map((response) => response.body.participantNoticeVersion as number).sort((a, b) => a - b);
    expect(versions).toEqual([before.participantNoticeVersion + 1, before.participantNoticeVersion + 2, before.participantNoticeVersion + 3]);
    const after = (await request(t.server).get('/api/v1/organization').set('Authorization', admin.authorization).expect(200)).body;
    expect(after.participantNoticeVersion).toBe(before.participantNoticeVersion + 3);
    const winner = responses.find((response) => response.body.participantNoticeVersion === after.participantNoticeVersion);
    expect(after.participantNotice).toBe(winner?.body.participantNotice);
    // Saving the same wording again does not mint a new version.
    const same = (await request(t.server).patch('/api/v1/organization').set('Authorization', admin.authorization).send({ participantNotice: after.participantNotice }).expect(200)).body;
    expect(same.participantNoticeVersion).toBe(after.participantNoticeVersion);
  });

  it('writes audit events that Admin can read and others cannot', async () => {
    const admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    await request(t.server).patch('/api/v1/organization').set('Authorization', admin.authorization).send({ timezone: 'Asia/Karachi' }).expect(200);
    await request(t.server).patch('/api/v1/organization').set('Authorization', manager.authorization).send({ timezone: 'UTC' }).expect(403);
    const audit = await request(t.server).get('/api/v1/audit?action=organization.updated').set('Authorization', admin.authorization).expect(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    expect(audit.body.items[0].actorEmail).toBe(admin.email);
    await request(t.server).get('/api/v1/audit').set('Authorization', manager.authorization).expect(403);
  });
});
