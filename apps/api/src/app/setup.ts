import type { IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { AppConfig } from '@raaye/server';
import helmet from 'helmet';
import { correlationMiddleware } from '../common/correlation.middleware';
import { ApiExceptionFilter } from '../common/exception.filter';

export const API_PREFIX = 'api/v1';

/** Shared HTTP configuration for the real server and integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(correlationMiddleware);
  // Keep the exact raw bytes for webhook signature verification.
  app.useBodyParser('json', {
    limit: '1mb',
    verify: (req: IncomingMessage & { rawBody?: Buffer }, _res: unknown, buffer: Buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  });
  app.useBodyParser('urlencoded', { limit: '256kb', extended: false });
  app.enableCors({
    origin: Array.from(new Set([config.WEB_ORIGIN, 'http://localhost:4200', 'http://127.0.0.1:4200'])),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id', 'Content-Disposition'],
    maxAge: 600,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('Raaye API')
    .setDescription('Permission-based WhatsApp surveys. All admin routes require a Firebase ID token and an active organization membership.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, builder);
}
