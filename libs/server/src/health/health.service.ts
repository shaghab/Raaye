import { Inject, Injectable } from '@nestjs/common';
import type { HealthDto } from '@raaye/contracts';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../persistence/prisma.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  live(): HealthDto {
    return { status: 'ok' };
  }

  /** Readiness checks local dependencies only; it never calls a paid provider. */
  async ready(): Promise<HealthDto> {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'fail';
    }
    checks['configuration'] = this.config.isLiveMessaging && !this.config.META_ACCESS_TOKEN ? 'fail' : 'ok';
    const status = Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'degraded';
    return { status, checks };
  }
}
