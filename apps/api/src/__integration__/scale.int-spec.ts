import request from 'supertest';
import { JobRunner, SweepService } from '@raaye/server';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

/**
 * R59: 1,000-contact launch. Measures launch request time, dispatch throughput, a restart
 * during dispatch (expired leases) and the integrity of logical invitations.
 */
describe('1,000-contact launch (R59)', () => {
  let t: TestApp;
  let orgId: string;
  let manager: SeededUser;

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Scale Org')).id;
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
  });

  afterAll(async () => {
    await t.close();
  });

  it(
    'launches, dispatches once per recipient, survives a restart and answers results queries quickly',
    async () => {
      const contacts = Array.from({ length: 1000 }, (_, index) => ({
        organizationId: orgId,
        name: `Contact ${index + 1}`,
        phoneE164: `+92300${String(2000000 + index).padStart(7, '0')}`,
        city: index % 3 === 0 ? 'Lahore' : index % 3 === 1 ? 'Karachi' : null,
        consentInvitations: 'GRANTED' as const,
        consentResults: 'GRANTED' as const,
        consentInvitationsAt: new Date('2026-09-01T00:00:00Z'),
        isSynthetic: true,
      }));
      for (let i = 0; i < contacts.length; i += 250) await t.prisma.contact.createMany({ data: contacts.slice(i, i + 250) });
      const ids = await t.prisma.contact.findMany({ where: { organizationId: orgId }, select: { id: true } });
      await t.prisma.consentEvent.createMany({ data: ids.map((contact) => ({ organizationId: orgId, contactId: contact.id, scope: 'SURVEY_INVITATIONS' as const, type: 'GRANTED' as const, source: 'IMPORT_ATTESTATION' as const, evidenceAt: new Date('2026-09-01T00:00:00Z') })) });
      const survey = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({
        internalTitle: 'Scale survey',
        title: { en: 'Scale survey' },
        introduction: { en: 'Intro' },
        questions: [
          { authoringType: 'YES_NO', prompt: { en: 'Q1?' } },
          { authoringType: 'YES_NO_INDIFFERENT', prompt: { en: 'Q2?' } },
          { authoringType: 'SINGLE_CHOICE', prompt: { en: 'Q3?' }, options: [{ label: { en: 'A' } }, { label: { en: 'B' } }, { label: { en: 'C' } }, { label: { en: 'D' } }] },
          { authoringType: 'MULTI_CHOICE', prompt: { en: 'Q4?' }, options: [{ label: { en: 'X' } }, { label: { en: 'Y' } }, { label: { en: 'Z' } }] },
          { authoringType: 'RATING', prompt: { en: 'Q5?' } },
        ],
        audience: { mode: 'EVERYONE' },
      }).expect(201)).body;
      const launchStart = Date.now();
      const launched = (await request(t.server).post(`/api/v1/surveys/${survey.id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
      const launchMs = Date.now() - launchStart;
      expect(launched.liveRun.audienceSummary).toMatchObject({ selected: 1000, eligible: 1000 });
      const runner = t.app.get(JobRunner);
      const sweep = t.app.get(SweepService);
      const dispatchStart = Date.now();
      // Activation queues invitation messages in bounded batches.
      await runner.runOnce(5, 1);
      expect(await t.prisma.message.count({ where: { runId: launched.liveRun.id } })).toBe(1000);
      // Process some sends, then simulate a worker crash by expiring leases of running jobs.
      await runner.runOnce(100, 4);
      const crashed = await t.prisma.job.updateMany({ where: { status: 'PENDING', kind: 'SEND_MESSAGE' }, data: { status: 'RUNNING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(t.clock.now().getTime() - 1000) } });
      expect(crashed.count).toBeGreaterThan(0);
      await sweep.run();
      let processed = 0;
      for (let round = 0; round < 60; round += 1) {
        const count = await runner.runOnce(100, 4);
        processed += count;
        if (count === 0) break;
      }
      const dispatchMs = Date.now() - dispatchStart;
      const accepted = await t.prisma.message.count({ where: { runId: launched.liveRun.id, state: 'ACCEPTED' } });
      const attempts = await t.prisma.messageAttempt.count({ where: { message: { runId: launched.liveRun.id } } });
      const invitations = await t.prisma.invitation.groupBy({ by: ['state'], where: { runId: launched.liveRun.id }, _count: { _all: true } });
      expect(accepted).toBe(1000);
      expect(attempts).toBe(1000);
      expect(invitations).toEqual([{ state: 'ACCEPTED', _count: { _all: 1000 } }]);
      expect(await t.prisma.job.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, kind: 'SEND_MESSAGE' } })).toBe(0);
      const resultsStart = Date.now();
      const results = (await request(t.server).get(`/api/v1/surveys/${survey.id}/results`).set('Authorization', manager.authorization).expect(200)).body;
      const resultsMs = Date.now() - resultsStart;
      expect(results.started).toBe(0);
      const dispatch = (await request(t.server).get(`/api/v1/surveys/${survey.id}/dispatch?limit=25`).set('Authorization', manager.authorization).expect(200)).body;
      expect(dispatch.metrics).toMatchObject({ selected: 1000, providerAccepted: 1000, delivered: 1000 });
      expect(dispatch.recipients.total).toBe(1000);
      console.log(`[scale] launch=${launchMs}ms dispatch=${dispatchMs}ms processedJobs=${processed} results=${resultsMs}ms`);
      expect(launchMs).toBeLessThan(10_000);
      expect(resultsMs).toBeLessThan(2_000);
    },
    600_000,
  );
});
