import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { FirebaseAdminService, FirebaseTokenVerifier, TOKEN_VERIFIER, TestTokenVerifier } from './auth/token-verifier';
import { AppClock, CLOCK } from './clock/clock.service';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, type AppConfig } from './config/env';
import { HealthService } from './health/health.service';
import { OrganizationService } from './organizations/organization.service';
import { PrismaService } from './persistence/prisma.service';
import { TenantDbFactory } from './persistence/tenant-db.factory';

export interface CoreModuleOptions {
  config?: AppConfig;
  /** Override the clock (tests inject a fixed clock). */
  clock?: Provider;
}

/** Shared infrastructure used by the API, the worker and the ops CLI. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(options: CoreModuleOptions = {}): DynamicModule {
    const clockProvider: Provider = options.clock ?? { provide: CLOCK, useExisting: AppClock };
    return {
      module: CoreModule,
      imports: [ConfigModule.forRoot(options.config)],
      providers: [
        PrismaService,
        TenantDbFactory,
        AppClock,
        clockProvider,
        AuditService,
        FirebaseAdminService,
        {
          provide: TOKEN_VERIFIER,
          inject: [APP_CONFIG, FirebaseAdminService],
          useFactory: (config: AppConfig, firebase: FirebaseAdminService) =>
            config.AUTH_MODE === 'test' ? new TestTokenVerifier() : new FirebaseTokenVerifier(firebase),
        },
        AuthService,
        OrganizationService,
        HealthService,
      ],
      exports: [
        PrismaService,
        TenantDbFactory,
        AppClock,
        CLOCK,
        AuditService,
        FirebaseAdminService,
        TOKEN_VERIFIER,
        AuthService,
        OrganizationService,
        HealthService,
      ],
    };
  }
}
