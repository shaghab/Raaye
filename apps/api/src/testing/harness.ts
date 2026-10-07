import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Role } from '@raaye/contracts';
import { FixedClock } from '@raaye/domain';
import { CLOCK, PrismaService, createRootLogger, loadConfig, type AppConfig } from '@raaye/server';
import { AppModule } from '../app/app.module';
import { configureApp } from '../app/setup';

export interface TestApp {
  app: INestApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  prisma: PrismaService;
  clock: FixedClock;
  config: AppConfig;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  const databaseUrl = process.env['TEST_DATABASE_URL'] ?? 'postgresql://raaye:raaye@127.0.0.1:5432/raaye_test';
  return loadConfig({
    APP_ENV: 'test',
    AUTH_MODE: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    MESSAGING_MODE: 'mock',
    ENABLE_SIMULATOR: 'true',
    ALLOW_DEMO_BOOTSTRAP: 'true',
    JOB_DRIVER: 'postgres',
    INTERNAL_TASK_TOKEN: 'test-internal-task-token-0123456789',
    WEB_ORIGIN: 'http://localhost:8080',
    FIREBASE_PROJECT_ID: 'demo-raaye',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    ...overrides,
  });
}

/** Boot the real HTTP application against the test database with a fixed clock. */
export async function bootTestApp(options: { now?: Date; env?: Partial<NodeJS.ProcessEnv> } = {}): Promise<TestApp> {
  createRootLogger('silent');
  const config = testConfig(options.env);
  const clock = new FixedClock(options.now ?? new Date('2026-10-10T09:00:00.000Z'));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, clock: { provide: CLOCK, useValue: clock } })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, bodyParser: false, logger: false });
  configureApp(app, config);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    server: app.getHttpServer(),
    prisma,
    clock,
    config,
    close: () => app.close(),
  };
}

/** Remove all rows from every application table (keeps migrations history). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export interface SeededOrg {
  id: string;
  slug: string;
  name: string;
}

export async function seedOrganization(prisma: PrismaService, name: string): Promise<SeededOrg> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
  const org = await prisma.organization.create({
    data: {
      name,
      slug,
      participantNotice: `This is Raaye, a survey bot from ${name}. Reply STOP at any time.`,
      privacyUrl: 'https://example.org/privacy',
      supportContact: 'support@example.org',
    },
  });
  await prisma.messagingConnection.create({
    data: { organizationId: org.id, provider: 'MOCK', mode: 'MOCK', appKey: `mock-${slug}`, enabled: true, readinessState: 'READY' },
  });
  return { id: org.id, slug, name };
}

export interface SeededUser {
  userId: string;
  membershipId: string;
  email: string;
  token: string;
  authorization: string;
}

export async function seedUser(prisma: PrismaService, organizationId: string, role: Role, email?: string): Promise<SeededUser> {
  const uid = `uid-${randomUUID()}`;
  const address = (email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.org`).toLowerCase();
  const user = await prisma.user.create({ data: { firebaseUid: uid, email: address } });
  const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id, role } });
  const token = `test:${uid}:${address}`;
  return { userId: user.id, membershipId: membership.id, email: address, token, authorization: `Bearer ${token}` };
}

/** A verified identity that has no membership anywhere. */
export function strayToken(): string {
  return `Bearer test:uid-stray-${randomUUID()}:stray-${randomUUID().slice(0, 6)}@example.org`;
}
