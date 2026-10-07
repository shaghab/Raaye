import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getLogger } from '../observability/logger';

export interface TaskRequest {
  name: string;
  url: string;
  body: Record<string, unknown>;
  scheduleTime?: Date;
}

/**
 * Cloud Tasks delivery adapter (REST, small typed client). Task names are deterministic so
 * duplicate pushes are rejected by the queue; handlers are idempotent regardless.
 * Not used in local mode (JOB_DRIVER=postgres).
 */
@Injectable()
export class CloudTasksAdapter {
  private readonly logger = getLogger('cloud-tasks');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.JOB_DRIVER === 'cloud_tasks';
  }

  describe(request: TaskRequest): Record<string, unknown> {
    const parent = `projects/${this.config.GCP_PROJECT_ID}/locations/${this.config.CLOUD_TASKS_LOCATION}/queues/${this.config.CLOUD_TASKS_QUEUE}`;
    return {
      name: `${parent}/tasks/${request.name}`,
      scheduleTime: request.scheduleTime?.toISOString(),
      httpRequest: {
        httpMethod: 'POST',
        url: request.url,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(request.body)).toString('base64'),
        oidcToken: { serviceAccountEmail: this.config.TASK_SERVICE_ACCOUNT_EMAIL, audience: this.config.WORKER_BASE_URL },
      },
    };
  }

  /** Create the task; ALREADY_EXISTS is treated as success. */
  async push(request: TaskRequest): Promise<'CREATED' | 'EXISTS' | 'FAILED'> {
    if (!this.enabled) return 'FAILED';
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const parent = `projects/${this.config.GCP_PROJECT_ID}/locations/${this.config.CLOUD_TASKS_LOCATION}/queues/${this.config.CLOUD_TASKS_QUEUE}`;
    const response = await fetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: this.describe(request) }),
    });
    if (response.ok) return 'CREATED';
    if (response.status === 409) return 'EXISTS';
    this.logger.warn({ status: response.status, task: request.name }, 'Cloud Tasks push failed');
    return 'FAILED';
  }

  jobUrl(jobId: string): string {
    return `${this.config.WORKER_BASE_URL ?? ''}/api/v1/internal/jobs/${jobId}/execute`;
  }

  /** Deterministic per attempt: a retry after backoff gets a fresh task; a double push is rejected as ALREADY_EXISTS. */
  taskName(jobId: string, attempts: number): string {
    return `job-${jobId}-${attempts}`;
  }
}

/** The subset of the adapter the job queue needs; tests supply an in-memory pusher. */
export interface TaskPusher {
  push(request: TaskRequest): Promise<'CREATED' | 'EXISTS' | 'FAILED'>;
  jobUrl(jobId: string): string;
  taskName(jobId: string, attempts: number): string;
}
