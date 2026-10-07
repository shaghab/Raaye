import request from 'supertest';
import { signWebhookBody } from '@raaye/server';
import { bootTestApp, resetDatabase, seedOrganization, type TestApp } from '../testing/harness';

/**
 * The app key selects configuration; the HMAC over the raw body is the control. A connection whose
 * bound secret reference does not resolve must be refused, never authenticated with the
 * process-wide default (issue #10, R40).
 */
describe('webhook secret resolution fails closed (R40)', () => {
  let t: TestApp;
  let appKey: string;
  let connectionId: string;
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '555000111' }, contacts: [{ profile: { name: 'Sender' }, wa_id: '923009990002' }], messages: [{ from: '923009990002', id: 'wamid.secret.1', timestamp: '1760000000', type: 'text', text: { body: 'hi' } }] } }] }],
  });
  const raw = Buffer.from(payload, 'utf8');

  beforeAll(async () => {
    t = await bootTestApp({ env: { META_APP_SECRET: 'global-secret', META_WEBHOOK_VERIFY_TOKEN: 'global-verify' } });
    await resetDatabase(t.prisma);
    const org = await seedOrganization(t.prisma, 'Webhook Org');
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: org.id } });
    appKey = connection.appKey;
    connectionId = connection.id;
    process.env['TEST_BOUND_APP_SECRET'] = 'bound-secret';
    process.env['TEST_BOUND_VERIFY_TOKEN'] = 'bound-verify';
    delete process.env['TEST_MISSING_APP_SECRET'];
    delete process.env['TEST_MISSING_VERIFY_TOKEN'];
  });

  afterAll(async () => {
    delete process.env['TEST_BOUND_APP_SECRET'];
    delete process.env['TEST_BOUND_VERIFY_TOKEN'];
    await t.close();
  });

  const post = (secret: string) => request(t.server).post(`/api/v1/webhooks/whatsapp/${appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(raw, secret)).send(payload);
  const verify = (token: string) => request(t.server).get(`/api/v1/webhooks/whatsapp/${appKey}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=777`);
  const bind = (appSecretRef: string | null, verifyTokenRef: string | null) => t.prisma.messagingConnection.update({ where: { id: connectionId }, data: { appSecretRef, verifyTokenRef } });

  it('uses the process-wide secrets only when the connection binds no reference', async () => {
    await bind(null, null);
    expect((await verify('global-verify').expect(200)).text).toBe('777');
    await verify('bound-verify').expect(403);
    await post('bound-secret').expect(401);
    await post('global-secret').expect(200);
  });

  it('uses the bound secrets when the references resolve, never the process-wide ones', async () => {
    await bind('TEST_BOUND_APP_SECRET', 'TEST_BOUND_VERIFY_TOKEN');
    expect((await verify('bound-verify').expect(200)).text).toBe('777');
    await verify('global-verify').expect(403);
    await post('global-secret').expect(401);
    await post('bound-secret').expect(200);
  });

  it('refuses the connection when a bound reference does not resolve instead of falling back', async () => {
    await bind('TEST_MISSING_APP_SECRET', 'TEST_MISSING_VERIFY_TOKEN');
    await verify('global-verify').expect(403);
    await verify('bound-verify').expect(403);
    const inboundBefore = await t.prisma.inboundEvent.count();
    const rejected = await post('global-secret').expect(401);
    expect(rejected.body.code).toBe('UNAUTHENTICATED');
    await post('bound-secret').expect(401);
    expect(await t.prisma.inboundEvent.count()).toBe(inboundBefore);
    // Fixing the reference restores the connection without touching the process-wide secret.
    process.env['TEST_MISSING_APP_SECRET'] = 'repaired-secret';
    process.env['TEST_MISSING_VERIFY_TOKEN'] = 'repaired-verify';
    try {
      expect((await verify('repaired-verify').expect(200)).text).toBe('777');
      await post('global-secret').expect(401);
      await post('repaired-secret').expect(200);
    } finally {
      delete process.env['TEST_MISSING_APP_SECRET'];
      delete process.env['TEST_MISSING_VERIFY_TOKEN'];
    }
  });
});
