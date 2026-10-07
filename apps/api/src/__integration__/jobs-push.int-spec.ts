import { JobsService, type ClaimedJob, type TaskRequest } from '@raaye/server';
import { bootTestApp, resetDatabase, seedOrganization, type TestApp } from '../testing/harness';

/** R55: under the Cloud Tasks driver every pending job must be handed to the queue, including retries. */
describe('job push to Cloud Tasks', () => {
  let t: TestApp;
  let orgId: string;
  const pushed: TaskRequest[] = [];
  const pusher = {
    push: async (request: TaskRequest) => {
      pushed.push(request);
      return request.name.endsWith('-fail') ? ('FAILED' as const) : ('CREATED' as const);
    },
    jobUrl: (jobId: string) => `https://worker.example.test/api/v1/internal/jobs/${jobId}/execute`,
    taskName: (jobId: string, attempts: number) => `job-${jobId}-${attempts}`,
  };

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('pushes every unpushed pending job once, schedules future jobs, and re-pushes retries (R55)', async () => {
    const jobs = t.app.get(JobsService);
    const now = t.clock.now();
    const later = new Date(now.getTime() + 3600_000);
    const immediate = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'push:immediate', dueAt: now });
    const scheduled = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'CLOSE_SURVEY', dedupeKey: 'push:scheduled', dueAt: later });
    expect(await jobs.pushDue({ pusher, now })).toBe(2);
    expect(pushed.map((task) => task.name).sort()).toEqual([`job-${immediate.id}-0`, `job-${scheduled.id}-0`].sort());
    expect(pushed.find((task) => task.name === `job-${scheduled.id}-0`)?.scheduleTime).toEqual(later);
    expect(pushed.find((task) => task.name === `job-${immediate.id}-0`)?.scheduleTime).toBeUndefined();
    expect(pushed[0].url).toBe(`https://worker.example.test/api/v1/internal/jobs/${pushed[0].body['jobId']}/execute`);
    // Nothing is pushed twice.
    expect(await jobs.pushDue({ pusher, now })).toBe(0);
    expect(await t.prisma.job.count({ where: { pushedAt: null, status: 'PENDING' } })).toBe(0);
    // A failed attempt that is rescheduled must be pushed again under a new task name.
    const claimed = (await jobs.claimDue(1, now)).find((job) => job.id === immediate.id) as ClaimedJob;
    expect(claimed).toBeDefined();
    expect(await jobs.fail(claimed, 'MOCK_RATE_LIMIT', true)).toBe('RETRY');
    const retried = await t.prisma.job.findUniqueOrThrow({ where: { id: immediate.id } });
    expect(retried.pushedAt).toBeNull();
    expect(retried.status).toBe('PENDING');
    expect(await jobs.pushDue({ pusher, now })).toBe(1);
    expect(pushed.map((task) => task.name)).toContain(`job-${immediate.id}-1`);
    expect(pushed.find((task) => task.name === `job-${immediate.id}-1`)?.scheduleTime).toEqual(retried.dueAt);
    // A push the queue rejects stays unpushed for the next sweep.
    const rejected = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'push:rejected', dueAt: now });
    await t.prisma.job.update({ where: { id: rejected.id }, data: { attempts: 0 } });
    const failingPusher = { ...pusher, taskName: (jobId: string) => `job-${jobId}-fail` };
    expect(await jobs.pushDue({ pusher: failingPusher, now })).toBe(0);
    expect((await t.prisma.job.findUniqueOrThrow({ where: { id: rejected.id } })).pushedAt).toBeNull();
    expect(await jobs.pushDue({ pusher, now })).toBe(1);
  });

  it('is inert under the postgres driver', async () => {
    const jobs = t.app.get(JobsService);
    await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'push:local', dueAt: t.clock.now() });
    expect(await jobs.pushDue()).toBe(0);
    expect((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: 'push:local' } })).pushedAt).toBeNull();
  });
});
