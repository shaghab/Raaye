import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => value === true || value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  APP_ENV: z.enum(['local', 'test', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_ORIGIN: z.url().default('http://localhost:8080'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Karachi'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  AUTH_MODE: z.enum(['emulator', 'live', 'test']).default('emulator'),
  FIREBASE_PROJECT_ID: z.string().min(1).default('demo-raaye'),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  PUBLIC_AUTH_EMULATOR_URL: z.string().optional(),
  PUBLIC_FIREBASE_API_KEY: z.string().optional(),
  MESSAGING_MODE: z.enum(['mock', 'live']).default('mock'),
  ENABLE_SIMULATOR: boolish.default(false),
  ALLOW_DEMO_BOOTSTRAP: boolish.default(false),
  JOB_DRIVER: z.enum(['postgres', 'cloud_tasks']).default('postgres'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  INTERNAL_TASK_TOKEN: z.string().optional(),
  IMPORT_STAGING_RETENTION_HOURS: z.coerce.number().int().min(1).max(24).default(24),
  RAW_WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  QUARANTINE_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  META_GRAPH_VERSION: z.string().regex(/^v\d{1,3}\.\d{1,2}$/).optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_WABA_ID: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WEBHOOK_APP_KEY: z.string().optional(),
  GCP_PROJECT_ID: z.string().optional(),
  CLOUD_TASKS_LOCATION: z.string().optional(),
  CLOUD_TASKS_QUEUE: z.string().optional(),
  WORKER_BASE_URL: z.url().optional(),
  TASK_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isLiveMessaging: boolean;
  simulatorEnabled: boolean;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const DEMO_TOKEN_MARKERS = ['change-me', 'local-internal-task-token'];

/**
 * Validate configuration once at startup. Live configuration fails closed: it rejects
 * emulator flags, demo bootstrap, simulator routes and missing secrets instead of
 * silently falling back to mock behavior.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Empty strings (e.g. unset Compose interpolations such as `META_APP_ID: ${META_APP_ID:-}`)
  // mean "not provided", never a value.
  const normalized = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const config = parsed.data;
  const problems: string[] = [];
  const isProduction = config.APP_ENV === 'production';
  const isLiveMessaging = config.MESSAGING_MODE === 'live';

  if (config.AUTH_MODE === 'test' && config.APP_ENV !== 'test') {
    problems.push('AUTH_MODE=test is only allowed when APP_ENV=test');
  }
  if (config.AUTH_MODE === 'live' && config.FIREBASE_AUTH_EMULATOR_HOST) {
    problems.push('FIREBASE_AUTH_EMULATOR_HOST must not be set when AUTH_MODE=live');
  }
  if (config.AUTH_MODE === 'emulator' && !config.FIREBASE_AUTH_EMULATOR_HOST) {
    problems.push('FIREBASE_AUTH_EMULATOR_HOST is required when AUTH_MODE=emulator');
  }
  if (isProduction) {
    if (config.AUTH_MODE !== 'live') problems.push('APP_ENV=production requires AUTH_MODE=live');
    if (config.ENABLE_SIMULATOR) problems.push('ENABLE_SIMULATOR must be false in production');
    if (config.ALLOW_DEMO_BOOTSTRAP) problems.push('ALLOW_DEMO_BOOTSTRAP must be false in production');
    if (config.FIREBASE_PROJECT_ID.startsWith('demo-')) problems.push('FIREBASE_PROJECT_ID must not be a demo project in production');
  }
  if (isLiveMessaging) {
    if (config.ENABLE_SIMULATOR) problems.push('ENABLE_SIMULATOR must be false when MESSAGING_MODE=live');
    if (config.ALLOW_DEMO_BOOTSTRAP) problems.push('ALLOW_DEMO_BOOTSTRAP must be false when MESSAGING_MODE=live');
    if (config.AUTH_MODE !== 'live') problems.push('MESSAGING_MODE=live requires AUTH_MODE=live');
    for (const key of [
      'META_GRAPH_VERSION',
      'META_APP_ID',
      'META_APP_SECRET',
      'META_ACCESS_TOKEN',
      'META_WEBHOOK_VERIFY_TOKEN',
      'META_WABA_ID',
      'META_PHONE_NUMBER_ID',
      'META_WEBHOOK_APP_KEY',
    ] as const) {
      if (!config[key]) problems.push(`${key} is required when MESSAGING_MODE=live`);
    }
  }
  if (config.JOB_DRIVER === 'cloud_tasks') {
    for (const key of ['GCP_PROJECT_ID', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_QUEUE', 'WORKER_BASE_URL', 'TASK_SERVICE_ACCOUNT_EMAIL'] as const) {
      if (!config[key]) problems.push(`${key} is required when JOB_DRIVER=cloud_tasks`);
    }
  } else if (!config.INTERNAL_TASK_TOKEN) {
    problems.push('INTERNAL_TASK_TOKEN is required when JOB_DRIVER=postgres');
  }
  if (isProduction && config.INTERNAL_TASK_TOKEN) {
    if (config.INTERNAL_TASK_TOKEN.length < 32 || DEMO_TOKEN_MARKERS.some((marker) => config.INTERNAL_TASK_TOKEN?.includes(marker))) {
      problems.push('INTERNAL_TASK_TOKEN must be a strong secret in production');
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { ...config, isProduction, isLiveMessaging, simulatorEnabled: config.ENABLE_SIMULATOR && !isLiveMessaging && !isProduction };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
