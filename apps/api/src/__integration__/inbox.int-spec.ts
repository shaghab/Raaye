import request from 'supertest';
import { JobsService } from '@raaye/server';
import { drainJobs } from '../testing/jobs';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

/** R41/R42: an inbound delivery is persisted together with its processing job, or not at all. */
describe('inbox durability', () => {
  let t: TestApp;
  let orgId: string;
  let admin: SeededUser;
  let contactId: string;

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    const manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    contactId = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Inbox Person', phone: '+923001000050' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('does not keep an inbox row when its job cannot be enqueued, so the provider retry succeeds (R41)', async () => {
    const jobs = t.app.get(JobsService);
    const spy = jest.spyOn(jobs, 'enqueue').mockRejectedValueOnce(new Error('simulated queue outage'));
    await request(t.server).post('/api/v1/dev/simulator/text').set('Authorization', admin.authorization).send({ contactId, text: 'HELP', providerMessageId: 'wamid.outage.1' }).expect(500);
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.outage.1' } })).toBe(0);
    spy.mockRestore();
    const retry = await request(t.server).post('/api/v1/dev/simulator/text').set('Authorization', admin.authorization).send({ contactId, text: 'HELP', providerMessageId: 'wamid.outage.1' }).expect(200);
    expect(retry.body.duplicate).toBe(false);
    expect(await t.prisma.job.count({ where: { kind: 'PROCESS_INBOUND', entityId: retry.body.eventId } })).toBe(1);
    await drainJobs(t);
    expect((await t.prisma.inboundEvent.findUniqueOrThrow({ where: { id: retry.body.eventId } })).processingState).toBe('PROCESSED');
  });

  it('re-enqueues processing for a duplicate delivery whose row was left pending without a job (R42)', async () => {
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    const orphan = await t.prisma.inboundEvent.create({
      data: { organizationId: orgId, connectionId: connection.id, providerMessageId: 'wamid.orphan.1', senderIdentity: '923001000050', kind: 'TEXT', normalized: { kind: 'TEXT', text: 'HELP', actionId: null, flowResponse: null }, providerAt: t.clock.now(), receivedAt: t.clock.now(), isSimulated: true },
    });
    expect(await t.prisma.job.count({ where: { entityId: orphan.id } })).toBe(0);
    const redelivery = await request(t.server).post('/api/v1/dev/simulator/text').set('Authorization', admin.authorization).send({ contactId, text: 'HELP', providerMessageId: 'wamid.orphan.1' }).expect(200);
    expect(redelivery.body.duplicate).toBe(true);
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.orphan.1' } })).toBe(1);
    expect(await t.prisma.job.count({ where: { entityId: orphan.id, kind: 'PROCESS_INBOUND' } })).toBe(1);
    await drainJobs(t);
    expect((await t.prisma.inboundEvent.findUniqueOrThrow({ where: { id: orphan.id } })).processingState).toBe('PROCESSED');
    expect(await t.prisma.message.count({ where: { contactId, kind: 'COMMAND_REPLY' } })).toBeGreaterThanOrEqual(1);
    // A later duplicate of an already processed event creates nothing new.
    const again = await request(t.server).post('/api/v1/dev/simulator/text').set('Authorization', admin.authorization).send({ contactId, text: 'HELP', providerMessageId: 'wamid.orphan.1' }).expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(await t.prisma.job.count({ where: { entityId: orphan.id } })).toBe(1);
  });
});
