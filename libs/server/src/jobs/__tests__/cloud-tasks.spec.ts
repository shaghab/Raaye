import { loadConfig } from '../../config/env';
import { CloudTasksAdapter } from '../cloud-tasks';

describe('Cloud Tasks adapter (R55 deployment path)', () => {
  const config = loadConfig({
    APP_ENV: 'production',
    MESSAGING_MODE: 'live',
    AUTH_MODE: 'live',
    FIREBASE_PROJECT_ID: 'raaye-prod',
    DATABASE_URL: 'postgresql://user:pass@10.0.0.1:5432/raaye',
    JOB_DRIVER: 'cloud_tasks',
    INTERNAL_TASK_TOKEN: 'a-very-long-random-production-token-value',
    META_GRAPH_VERSION: 'v24.0',
    META_APP_ID: '1',
    META_APP_SECRET: 'secret',
    META_ACCESS_TOKEN: 'token',
    META_WEBHOOK_VERIFY_TOKEN: 'verify',
    META_WABA_ID: '2',
    META_PHONE_NUMBER_ID: '3',
    META_WEBHOOK_APP_KEY: 'live-key',
    GCP_PROJECT_ID: 'raaye-prod',
    CLOUD_TASKS_LOCATION: 'asia-south1',
    CLOUD_TASKS_QUEUE: 'raaye-jobs',
    WORKER_BASE_URL: 'https://worker.example.run.app',
    TASK_SERVICE_ACCOUNT_EMAIL: 'tasks@raaye-prod.iam.gserviceaccount.com',
    ENABLE_SIMULATOR: 'false',
    ALLOW_DEMO_BOOTSTRAP: 'false',
  });

  it('describes deterministic, OIDC-authenticated HTTP tasks pointed at the internal job handler', () => {
    const adapter = new CloudTasksAdapter(config);
    expect(adapter.enabled).toBe(true);
    const described = adapter.describe({ name: 'job-abc', url: adapter.jobUrl('abc'), body: { jobId: 'abc' }, scheduleTime: new Date('2026-10-10T09:00:00Z') });
    expect(described['name']).toBe('projects/raaye-prod/locations/asia-south1/queues/raaye-jobs/tasks/job-abc');
    expect(described['scheduleTime']).toBe('2026-10-10T09:00:00.000Z');
    const http = described['httpRequest'] as Record<string, unknown>;
    expect(http['url']).toBe('https://worker.example.run.app/api/v1/internal/jobs/abc/execute');
    expect(http['httpMethod']).toBe('POST');
    expect(Buffer.from(String(http['body']), 'base64').toString('utf8')).toBe('{"jobId":"abc"}');
    expect(http['oidcToken']).toEqual({ serviceAccountEmail: 'tasks@raaye-prod.iam.gserviceaccount.com', audience: 'https://worker.example.run.app' });
  });

  it('is disabled under the local postgres driver and never calls the network', async () => {
    const local = new CloudTasksAdapter(loadConfig({ APP_ENV: 'local', DATABASE_URL: 'postgresql://raaye:raaye@127.0.0.1:5432/raaye', JOB_DRIVER: 'postgres', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', INTERNAL_TASK_TOKEN: 'local-internal-task-token-change-me' }));
    expect(local.enabled).toBe(false);
    await expect(local.push({ name: 'x', url: 'https://example.invalid', body: {} })).resolves.toBe('FAILED');
  });
});
