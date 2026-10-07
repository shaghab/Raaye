import { ConfigError, loadConfig } from '../env';

const base = { APP_ENV: 'local', DATABASE_URL: 'postgresql://x', FIREBASE_AUTH_EMULATOR_HOST: 'auth:9099', INTERNAL_TASK_TOKEN: 'local-internal-task-token-change-me', ENABLE_SIMULATOR: 'true', ALLOW_DEMO_BOOTSTRAP: 'true' };

describe('configuration validation (R57)', () => {
  it('accepts the documented local defaults', () => {
    const config = loadConfig(base);
    expect(config.MESSAGING_MODE).toBe('mock');
    expect(config.simulatorEnabled).toBe(true);
  });

  it('rejects live messaging with emulator, demo bootstrap, simulator or missing secrets', () => {
    expect(() => loadConfig({ ...base, MESSAGING_MODE: 'live' })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, MESSAGING_MODE: 'live' });
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('ENABLE_SIMULATOR must be false');
      expect(problems).toContain('ALLOW_DEMO_BOOTSTRAP must be false');
      expect(problems).toContain('MESSAGING_MODE=live requires AUTH_MODE=live');
      expect(problems).toContain('META_ACCESS_TOKEN is required');
      expect(problems).toContain('META_APP_SECRET is required');
    }
  });

  it('fails closed in production and never falls back to mock', () => {
    const production = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://x',
      AUTH_MODE: 'live',
      FIREBASE_PROJECT_ID: 'raaye-prod',
      MESSAGING_MODE: 'live',
      ENABLE_SIMULATOR: 'false',
      ALLOW_DEMO_BOOTSTRAP: 'false',
      JOB_DRIVER: 'cloud_tasks',
      GCP_PROJECT_ID: 'p',
      CLOUD_TASKS_LOCATION: 'l',
      CLOUD_TASKS_QUEUE: 'q',
      WORKER_BASE_URL: 'https://worker.example.com',
      TASK_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
      META_GRAPH_VERSION: 'v24.0',
      META_APP_ID: '1',
      META_APP_SECRET: 's',
      META_ACCESS_TOKEN: 't',
      META_WEBHOOK_VERIFY_TOKEN: 'v',
      META_WABA_ID: 'w',
      META_PHONE_NUMBER_ID: 'p',
      META_WEBHOOK_APP_KEY: 'k',
    };
    expect(loadConfig(production).isLiveMessaging).toBe(true);
    expect(() => loadConfig({ ...production, ENABLE_SIMULATOR: 'true' })).toThrow(/ENABLE_SIMULATOR must be false/);
    expect(() => loadConfig({ ...production, AUTH_MODE: 'emulator', FIREBASE_AUTH_EMULATOR_HOST: 'x' })).toThrow(/AUTH_MODE=live/);
    expect(() => loadConfig({ ...production, FIREBASE_PROJECT_ID: 'demo-raaye' })).toThrow(/demo project/);
    expect(() => loadConfig({ ...production, JOB_DRIVER: 'postgres', INTERNAL_TASK_TOKEN: 'local-internal-task-token-change-me' })).toThrow(/strong secret/);
    expect(() => loadConfig({ ...production, META_ACCESS_TOKEN: '' })).toThrow(/META_ACCESS_TOKEN is required/);
    expect(() => loadConfig({ ...base, AUTH_MODE: 'test' })).toThrow(/APP_ENV=test/);
  });
});
