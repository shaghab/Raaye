import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, ServerModule, type AppConfig } from '@raaye/server';
import type { DynamicModule, Provider } from '@nestjs/common';
import { AuditController } from '../controllers/audit.controller';
import { AuthConfigController } from '../controllers/auth-config.controller';
import { ContactImportsController } from '../controllers/contact-imports.controller';
import { ContactsController } from '../controllers/contacts.controller';
import { GroupsController, TagsController } from '../controllers/groups-tags.controller';
import { MessagesController, MessagingController } from '../controllers/messaging.controller';
import { SurveysController } from '../controllers/surveys.controller';
import { MessageDetailController, OverviewController, ReportingController } from '../controllers/reporting.controller';
import { WebhooksController } from '../controllers/webhooks.controller';
import { InternalController } from '../controllers/internal.controller';
import { SimulatorController, SimulatorEnabledGuard } from '../controllers/simulator.controller';
import { HealthController } from '../controllers/health.controller';
import { MeController } from '../controllers/me.controller';
import { MembersController } from '../controllers/members.controller';
import { OrganizationController } from '../controllers/organization.controller';
import { StaffInvitationsController } from '../controllers/staff-invitations.controller';

export interface AppModuleOptions {
  config?: AppConfig;
  clock?: Provider;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [ServerModule.forRoot({ config: options.config, clock: options.clock })],
      controllers: [
        HealthController,
        AuthConfigController,
        MeController,
        OrganizationController,
        MembersController,
        StaffInvitationsController,
        AuditController,
        ContactsController,
        GroupsController,
        TagsController,
        ContactImportsController,
        SurveysController,
        MessagingController,
        MessagesController,
        WebhooksController,
        InternalController,
        SimulatorController,
        ReportingController,
        OverviewController,
        MessageDetailController,
      ],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }, SimulatorEnabledGuard],
    };
  }
}
