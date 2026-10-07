import type { INestApplicationContext } from '@nestjs/common';
import { JobRunner } from './jobs/job-runner';
import { SweepService } from './jobs/sweep.service';
import { getLogger } from './observability/logger';
import { RetentionService } from './retention/retention.service';
import { SeedService } from './seed/seed.service';
import { APP_CONFIG, type AppConfig } from './config/env';

export const CLI_COMMANDS = ['sweep', 'run-once', 'retention', 'seed', 'seed:scale'] as const;

/** One-shot operational commands shared by the worker image and `pnpm` scripts. */
export async function runCli(app: INestApplicationContext, command: string, args: string[] = []): Promise<number> {
  const logger = getLogger('cli');
  const config = app.get<AppConfig>(APP_CONFIG);
  switch (command) {
    case 'sweep': {
      logger.info(await app.get(SweepService).run(), 'Sweep finished');
      return 0;
    }
    case 'run-once': {
      await app.get(SweepService).run();
      const processed = await app.get(JobRunner).runOnce(config.WORKER_BATCH_SIZE, config.WORKER_CONCURRENCY);
      logger.info({ processed }, 'Processed due jobs once');
      return 0;
    }
    case 'retention': {
      logger.info(await app.get(RetentionService).run(), 'Retention cleanup finished');
      return 0;
    }
    case 'seed': {
      const report = await app.get(SeedService).seed();
      logger.info(report, 'Demo seed finished');
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    case 'seed:scale': {
      const count = Number(args[0] ?? '1000');
      const result = await app.get(SeedService).seedScale(Number.isFinite(count) && count > 0 ? count : 1000);
      logger.info(result, 'Scale seed finished');
      console.log(JSON.stringify(result));
      return 0;
    }
    default:
      logger.error({ command }, `Unknown command. Use: worker | ${CLI_COMMANDS.join(' | ')}`);
      return 2;
  }
}
