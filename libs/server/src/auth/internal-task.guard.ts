import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { safeEqual } from '@raaye/domain';
import { DomainError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import type { AuthenticatedRequest } from './decorators';

/**
 * Verified service identity for /internal routes: a shared secret locally, a Google OIDC
 * token from the configured task service account under Cloud Tasks / Cloud Scheduler.
 */
@Injectable()
export class InternalTaskGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const token = value?.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Service identity required');
    if (this.config.JOB_DRIVER === 'cloud_tasks') {
      const { OAuth2Client } = await import('google-auth-library');
      const client = new OAuth2Client();
      try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: this.config.WORKER_BASE_URL });
        const payload = ticket.getPayload();
        if (!payload?.email_verified || payload.email !== this.config.TASK_SERVICE_ACCOUNT_EMAIL) throw new Error('wrong identity');
        return true;
      } catch {
        throw new DomainError('UNAUTHENTICATED', 'Invalid service identity token');
      }
    }
    const expected = this.config.INTERNAL_TASK_TOKEN ?? '';
    if (!expected || !safeEqual(token, expected)) throw new DomainError('UNAUTHENTICATED', 'Invalid service identity token');
    return true;
  }
}
