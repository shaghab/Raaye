import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CLI_COMMANDS, JobRunner, NestPinoLogger, ServerModule, SweepService, createRootLogger, getLogger, loadConfig, runCli } from '@raaye/server';

const SWEEP_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  createRootLogger(config.LOG_LEVEL);
  const logger = getLogger('worker');
  const command = process.argv[2] ?? 'worker';
  const app = await NestFactory.createApplicationContext(ServerModule.forRoot({ config }), { logger: new NestPinoLogger() });
  app.enableShutdownHooks();
  const runner = app.get(JobRunner);
  const sweep = app.get(SweepService);

  if ((CLI_COMMANDS as readonly string[]).includes(command)) {
    const code = await runCli(app, command, process.argv.slice(3));
    await app.close();
    process.exit(code);
  }
  if (command !== 'worker') {
    logger.error({ command }, `Unknown command. Use: worker | ${CLI_COMMANDS.join(' | ')}`);
    await app.close();
    process.exit(2);
  }

  let stopping = false;
  let lastSweep = 0;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, inFlight: runner.activeCount }, 'Worker stopping; waiting for in-flight jobs');
    const deadline = Date.now() + 30_000;
    while (runner.activeCount > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  logger.info({ pollMs: config.WORKER_POLL_INTERVAL_MS, batch: config.WORKER_BATCH_SIZE, concurrency: config.WORKER_CONCURRENCY, driver: config.JOB_DRIVER }, 'Worker started');
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
        await sweep.run();
        lastSweep = Date.now();
      }
      const processed = await runner.runOnce(config.WORKER_BATCH_SIZE, config.WORKER_CONCURRENCY);
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Worker loop error');
      await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
