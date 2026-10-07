import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { NestPinoLogger, createRootLogger, getLogger, loadConfig } from '@raaye/server';
import { AppModule } from './app/app.module';
import { buildOpenApiDocument, configureApp } from './app/setup';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  createRootLogger(config.LOG_LEVEL);
  const logger = getLogger('api');
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ config }), {
    rawBody: true,
    bodyParser: false,
    logger: new NestPinoLogger(),
  });
  configureApp(app, config);
  if (!config.isProduction) {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app), { jsonDocumentUrl: 'api/docs-json' });
  }
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
  logger.info(
    { port: config.API_PORT, env: config.APP_ENV, messagingMode: config.MESSAGING_MODE, simulator: config.simulatorEnabled },
    'Raaye API listening',
  );
}

bootstrap().catch((error: unknown) => {
  // Configuration errors must stop the process with a readable reason.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
