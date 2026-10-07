import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../persistence/prisma.service';
import { ActionBindingService } from './action-bindings';
import { DeliveryService } from './delivery.service';
import { MetaManagementClient } from './meta-management';
import { MetaMessagingProvider } from './meta.provider';
import { MockMessagingProvider } from './mock.provider';
import { MessagePlanner } from './planner';
import { MESSAGING_PROVIDER } from './provider';
import { MessagingReadinessService } from './readiness.service';

@Global()
@Module({
  providers: [
    ActionBindingService,
    MessagePlanner,
    MetaManagementClient,
    MessagingReadinessService,
    {
      provide: MESSAGING_PROVIDER,
      inject: [APP_CONFIG, PrismaService],
      useFactory: (config: AppConfig, prisma: PrismaService) => (config.isLiveMessaging ? new MetaMessagingProvider(config) : new MockMessagingProvider(prisma)),
    },
    DeliveryService,
  ],
  exports: [ActionBindingService, MessagePlanner, MetaManagementClient, MessagingReadinessService, MESSAGING_PROVIDER, DeliveryService],
})
export class MessagingModule {}
