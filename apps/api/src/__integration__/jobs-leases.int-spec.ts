import { JobRunner, JobsService } from '@raaye/server';
import { bootTestApp, resetDatabase, seedOrganization, type TestApp } from '../testing/harness';

/** R43/R55: a job lease belongs to one claim; recovery, completion and failure respect the current holder. */
describe('job leases', () => {
  let t: TestApp;
  let orgId: string;

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('a reclaimed lease is not reset by recovery and the previous holder can neither complete nor fail the job', async () => {
    const jobs = t.app.get(JobsService);
    const now = t.clock.now();
    const { id } = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'lease:reclaim', dueAt: now });
    const first = (await jobs.claimDue(10, now)).find((job) => job.id === id);
    if (!first) throw new Error('job was not claimed');
    expect(first.leaseOwner).toBe(jobs.workerId);
    expect(first.leaseExpiresAt.getTime()).toBeGreaterThan(now.getTime());
    // A live lease is never touched by recovery.
    expect(await jobs.recoverExpiredLeases(now)).toBe(0);
    // The lease expires and a Cloud Tasks redelivery reclaims the job before the sweep gets to it.
    const later = new Date(first.leaseExpiresAt.getTime() + 1000);
    const second = await jobs.claimOne(id, later);
    if (!second) throw new Error('expired job was not reclaimable');
    expect(second.attempts).toBe(2);
    expect(second.leaseExpiresAt.getTime()).toBeGreaterThan(later.getTime());
    // The sweep at the same instant sees the renewed lease and leaves it with its new holder.
    expect(await jobs.recoverExpiredLeases(later)).toBe(0);
    const renewed = await t.prisma.job.findUniqueOrThrow({ where: { id } });
    expect(renewed).toMatchObject({ status: 'RUNNING', attempts: 2, leaseOwner: second.leaseOwner });
    expect(renewed.leaseExpiresAt?.toISOString()).toBe(second.leaseExpiresAt.toISOString());
    // The first holder lost its lease: its outcome is ignored, whichever way its handler ended.
    expect(await jobs.complete(first)).toBe('LOST');
    expect(await jobs.fail(first, 'HANDLER_CRASHED', true)).toBe('LOST');
    expect(await jobs.fail(first, 'HANDLER_CRASHED', false)).toBe('LOST');
    const untouched = await t.prisma.job.findUniqueOrThrow({ where: { id } });
    expect(untouched).toMatchObject({ status: 'RUNNING', attempts: 2, leaseOwner: second.leaseOwner, lastErrorCode: null });
    expect(untouched.leaseExpiresAt?.toISOString()).toBe(second.leaseExpiresAt.toISOString());
    // The current holder settles the job normally.
    expect(await jobs.complete(second)).toBe('DONE');
    expect(await t.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUCCEEDED', leaseOwner: null, leaseExpiresAt: null });
    // Settling twice changes nothing.
    expect(await jobs.complete(second)).toBe('LOST');
  });

  it('recovery re-queues expired leases of a dead worker, fails exhausted ones and keeps attempt counts', async () => {
    const jobs = t.app.get(JobsService);
    const now = t.clock.now();
    const retryable = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'lease:dead:retryable', dueAt: now });
    const exhausted = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'lease:dead:exhausted', dueAt: now, maxAttempts: 1 });
    const claimed = await jobs.claimDue(10, now);
    const claimedRetryable = claimed.find((job) => job.id === retryable.id);
    const claimedExhausted = claimed.find((job) => job.id === exhausted.id);
    if (!claimedRetryable || !claimedExhausted) throw new Error('jobs were not claimed');
    // The worker that held both leases died; its leases expire.
    await t.prisma.job.updateMany({ where: { id: { in: [retryable.id, exhausted.id] } }, data: { leaseOwner: 'dead-worker', leaseExpiresAt: new Date(now.getTime() - 1000) } });
    expect(await jobs.recoverExpiredLeases(now)).toBe(1);
    const requeued = await t.prisma.job.findUniqueOrThrow({ where: { id: retryable.id } });
    expect(requeued).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorCode: 'LEASE_EXPIRED', leaseOwner: null, leaseExpiresAt: null, pushedAt: null, finishedAt: null });
    const failed = await t.prisma.job.findUniqueOrThrow({ where: { id: exhausted.id } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, lastErrorCode: 'LEASE_EXPIRED', leaseOwner: null, leaseExpiresAt: null });
    expect(failed.finishedAt?.toISOString()).toBe(now.toISOString());
    // Recovery is idempotent and the original claims can no longer settle anything.
    expect(await jobs.recoverExpiredLeases(now)).toBe(0);
    expect(await jobs.complete(claimedRetryable)).toBe('LOST');
    expect(await jobs.fail(claimedExhausted, 'LATE_FAILURE', false)).toBe('LOST');
    expect((await t.prisma.job.findUniqueOrThrow({ where: { id: retryable.id } })).status).toBe('PENDING');
    expect((await t.prisma.job.findUniqueOrThrow({ where: { id: exhausted.id } })).status).toBe('FAILED');
    // The re-queued job is claimable again and keeps counting attempts.
    const again = (await jobs.claimDue(10, now)).find((job) => job.id === retryable.id);
    expect(again?.attempts).toBe(2);
    expect(await jobs.complete(again ?? claimedRetryable)).toBe('DONE');
  });

  it('the runner reports a lost lease instead of recording an outcome for a job another claim owns', async () => {
    const jobs = t.app.get(JobsService);
    const runner = t.app.get(JobRunner);
    const now = t.clock.now();
    runner.register({
      kind: 'CLEANUP_RETENTION',
      handle: async (job) => {
        // While the handler runs, the lease expires and another worker reclaims the job.
        await t.prisma.job.update({ where: { id: job.id }, data: { leaseOwner: 'other-worker', leaseExpiresAt: new Date(now.getTime() + 120_000), attempts: { increment: 1 } } });
        if (job.payload?.['crash']) throw new Error('handler crashed after the takeover');
      },
    });
    const completed = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'CLEANUP_RETENTION', dedupeKey: 'lease:runner:completed', dueAt: now });
    expect(await runner.runJob(completed.id)).toBe('LOST');
    expect(await t.prisma.job.findUniqueOrThrow({ where: { id: completed.id } })).toMatchObject({ status: 'RUNNING', leaseOwner: 'other-worker', attempts: 2 });
    const crashed = await jobs.enqueue(t.prisma, { organizationId: orgId, kind: 'CLEANUP_RETENTION', dedupeKey: 'lease:runner:crashed', dueAt: now, payload: { crash: true } });
    expect(await runner.runJob(crashed.id)).toBe('LOST');
    expect(await t.prisma.job.findUniqueOrThrow({ where: { id: crashed.id } })).toMatchObject({ status: 'RUNNING', leaseOwner: 'other-worker', attempts: 2, lastErrorCode: null });
  });
});
