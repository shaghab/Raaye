import request from 'supertest';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

describe('messaging connection provisioning (R22, R57)', () => {
  let t: TestApp;
  let orgId: string;
  let otherOrgId: string;
  let admin: SeededUser;
  let manager: SeededUser;
  let otherAdmin: SeededUser;

  beforeAll(async () => {
    t = await bootTestApp();
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    otherOrgId = (await seedOrganization(t.prisma, 'Org B')).id;
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    otherAdmin = await seedUser(t.prisma, otherOrgId, 'ADMIN');
    // A deployment that only ran `migrate deploy` has no sender row for the organization.
    await t.prisma.messagingConnection.deleteMany({ where: { organizationId: orgId } });
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports the missing sender, creates it on the first Settings save and never duplicates it', async () => {
    const missing = (await request(t.server).get('/api/v1/messaging/readiness').set('Authorization', admin.authorization).expect(200)).body;
    expect(missing).toMatchObject({ ok: false, connection: null, webhookPath: null });
    expect(missing.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['CONNECTION_MISSING']);
    await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', manager.authorization).send({ displayPhoneNumber: '+92 300 0000000' }).expect(403);
    const created = (await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ displayPhoneNumber: '+92 300 0000000', graphVersion: 'v24.0', enabled: true }).expect(200)).body;
    expect(created.ok).toBe(true);
    expect(created.connection).toMatchObject({ displayPhoneNumber: '+92 300 0000000', graphVersion: 'v24.0', enabled: true });
    expect(created.connection.appKey).toMatch(/^mock-/);
    expect(created.webhookPath).toBe(`/api/v1/webhooks/whatsapp/${created.connection.appKey}`);
    const again = (await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ wabaId: 'WABA-1' }).expect(200)).body;
    expect(again.connection.id).toBe(created.connection.id);
    expect(again.connection).toMatchObject({ wabaId: 'WABA-1', displayPhoneNumber: '+92 300 0000000' });
    const rows = await t.prisma.messagingConnection.findMany({ where: { organizationId: orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'MOCK', mode: 'MOCK', enabled: true });
    expect(await t.prisma.auditEvent.count({ where: { organizationId: orgId, action: 'messaging.connection_created' } })).toBe(1);
    // The other organization keeps its own sender untouched.
    const other = (await request(t.server).get('/api/v1/messaging/readiness').set('Authorization', otherAdmin.authorization).expect(200)).body;
    expect(other.connection.id).not.toBe(created.connection.id);
    expect(await t.prisma.messagingConnection.count({ where: { organizationId: otherOrgId } })).toBe(1);
  });

  it('concurrent first saves create exactly one sender', async () => {
    await t.prisma.messagingConnection.deleteMany({ where: { organizationId: orgId } });
    const responses = await Promise.all([1, 2, 3].map((n) => request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ appId: `app-${n}` })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await t.prisma.messagingConnection.count({ where: { organizationId: orgId } })).toBe(1);
  });
});
