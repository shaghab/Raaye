import request from 'supertest';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

/** Authenticated task handlers used by Cloud Tasks / Cloud Scheduler (R55) and the local sweep. */
describe('internal task endpoints', () => {
  let t: TestApp;
  let orgId: string;
  let manager: SeededUser;

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
  });

  afterAll(async () => {
    await t.close();
  });

  it('rejects missing, malformed and wrong service tokens and ignores staff identities', async () => {
    await request(t.server).post('/api/v1/internal/sweep').expect(401);
    await request(t.server).post('/api/v1/internal/sweep').set('Authorization', 'Bearer wrong-token').expect(401);
    await request(t.server).post('/api/v1/internal/sweep').set('Authorization', 'Basic abc').expect(401);
    await request(t.server).post('/api/v1/internal/sweep').set('Authorization', manager.authorization).expect(401);
    await request(t.server).post('/api/v1/internal/jobs/not-a-uuid/execute').set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(400);
  });

  it('executes a specific due job idempotently and sweeps due work', async () => {
    const contact = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Recipient', phone: '+923009000001' }).expect(201)).body;
    await request(t.server).post(`/api/v1/contacts/${contact.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    const survey = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({ internalTitle: 'Internal', title: { en: 'Internal' }, introduction: { en: 'Intro' }, questions: [{ authoringType: 'YES_NO', prompt: { en: 'Q?' } }], audience: { mode: 'EVERYONE' } }).expect(201)).body;
    await request(t.server).post(`/api/v1/surveys/${survey.id}/launch`).set('Authorization', manager.authorization).send({ mode: 'SCHEDULED', opensAt: '2026-10-10T10:00:00.000Z' }).expect(200);
    const activate = await t.prisma.job.findFirstOrThrow({ where: { kind: 'ACTIVATE_SURVEY', organizationId: orgId } });
    // Not due yet: the handler refuses to claim it.
    const early = (await request(t.server).post(`/api/v1/internal/jobs/${activate.id}/execute`).set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200)).body;
    expect(early.result).toBe('NOT_CLAIMABLE');
    t.clock.set(new Date('2026-10-10T10:00:01.000Z'));
    const done = (await request(t.server).post(`/api/v1/internal/jobs/${activate.id}/execute`).set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200)).body;
    expect(done.result).toBe('DONE');
    const again = (await request(t.server).post(`/api/v1/internal/jobs/${activate.id}/execute`).set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200)).body;
    expect(again.result).toBe('NOT_CLAIMABLE');
    expect(await t.prisma.surveyRun.count({ where: { surveyId: survey.id, state: 'ACTIVE' } })).toBe(1);
    const unknown = (await request(t.server).post('/api/v1/internal/jobs/00000000-0000-4000-8000-000000000000/execute').set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200)).body;
    expect(unknown.result).toBe('NOT_CLAIMABLE');
    t.clock.set(new Date('2026-10-12T10:00:01.000Z'));
    const sweep = (await request(t.server).post('/api/v1/internal/sweep').set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200)).body;
    expect(sweep.closings).toBe(1);
    expect(await t.prisma.surveyRun.count({ where: { surveyId: survey.id, state: 'CLOSED' } })).toBe(1);
  });
});
