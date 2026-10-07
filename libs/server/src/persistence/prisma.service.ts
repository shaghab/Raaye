import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaClient } from './generated/client';

/**
 * Unrestricted Prisma client. Only documented control-plane helpers may use it directly
 * (membership resolution, sender-connection routing, job claims, retention sweeps).
 * Tenant-owned business access goes through {@link createTenantDb}.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: 10 }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export { PrismaClient };
export * from './generated/client';
