import type { INestApplicationContext } from '@nestjs/common';
import { JobRunner } from './jobs/job-runner';
import { SweepService } from './jobs/sweep.service';
import { DomainError } from './common/errors';
import { getLogger } from './observability/logger';
import { BOOTSTRAP_USAGE, OrganizationBootstrapService, parseBootstrapArgs } from './organizations/bootstrap.service';
import { RetentionService } from './retention/retention.service';
import { SeedService } from './seed/seed.service';
import { APP_CONFIG, type AppConfig } from './config/env';

export const CLI_COMMANDS = ['sweep', 'run-once', 'retention', 'seed', 'seed:scale', 'bootstrap:org'] as const;

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
    case 'bootstrap:org': {
      let input: Record<string, string | undefined>;
      try {
        input = parseBootstrapArgs(args);
      } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n${BOOTSTRAP_USAGE}`);
        return 2;
      }
      try {
        const result = await app.get(OrganizationBootstrapService).bootstrap(input);
        // The acceptance link is a secret: it goes to stdout once and never into the structured log.
        logger.info(
          { organizationId: result.organizationId, slug: result.slug, organizationCreated: result.organizationCreated, invitationId: result.invitationId, expiresAt: result.expiresAt, revokedInvitations: result.revokedInvitations },
          'Organization bootstrapped; send the printed acceptance link to the Admin',
        );
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        if (error instanceof DomainError) {
          const fields = error.fieldErrors?.map((field) => `${field.path}: ${field.message}`).join('; ');
          console.error(`${error.code}: ${error.message}${fields ? ` (${fields})` : ''}\n${BOOTSTRAP_USAGE}`);
          return 1;
        }
        throw error;
      }
    }
    default:
      logger.error({ command }, `Unknown command. Use: worker | ${CLI_COMMANDS.join(' | ')}`);
      return 2;
  }
}
