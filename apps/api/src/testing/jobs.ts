import { JobRunner, SweepService } from '@raaye/server';
import type { TestApp } from './harness';

/** Run the sweep and process every due job until the queue is empty. */
export async function drainJobs(t: TestApp, maxRounds = 30): Promise<number> {
  const runner = t.app.get(JobRunner);
  const sweep = t.app.get(SweepService);
  await sweep.run();
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const processed = await runner.runOnce(50, 4);
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

export async function sweepOnly(t: TestApp): Promise<void> {
  await t.app.get(SweepService).run();
}
