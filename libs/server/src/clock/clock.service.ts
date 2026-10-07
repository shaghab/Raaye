import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@raaye/domain';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../persistence/prisma.service';

export const CLOCK = Symbol('CLOCK');

/**
 * Authoritative server clock. In simulator-enabled local/test configuration the clock
 * can be offset through the persisted simulator state so edit windows, schedules and
 * closings can be exercised without waiting. Live configuration never reads the offset.
 */
@Injectable()
export class AppClock implements Clock {
  private offsetSeconds = 0;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  now(): Date {
    if (this.config.simulatorEnabled) {
      void this.maybeRefresh();
      return new Date(Date.now() + this.offsetSeconds * 1000);
    }
    return new Date();
  }

  /** Reload the persisted offset immediately (used after simulator clock changes). */
  async refresh(): Promise<void> {
    if (!this.config.simulatorEnabled) return;
    const state = await this.prisma.simulatorState.findUnique({ where: { id: 1 } });
    this.offsetSeconds = state?.clockOffsetSeconds ?? 0;
    this.lastRefresh = Date.now();
  }

  getOffsetSeconds(): number {
    return this.offsetSeconds;
  }

  private async maybeRefresh(): Promise<void> {
    if (Date.now() - this.lastRefresh < 500 || this.refreshing) return;
    this.refreshing = this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = null;
      });
    await this.refreshing;
  }
}
