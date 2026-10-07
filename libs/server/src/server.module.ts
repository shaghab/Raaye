import { Module, type DynamicModule, type OnModuleInit, type Provider } from '@nestjs/common';
import { ContactsModule } from './contacts/contacts.module';
import { ConversationModule } from './conversation/conversation.module';
import { ConversationService } from './conversation/conversation.service';
import { CoreModule, type CoreModuleOptions } from './core.module';
import { JobRunner } from './jobs/job-runner';
import { JobsModule } from './jobs/jobs.module';
import { DeliveryService } from './messaging/delivery.service';
import { MessagingModule } from './messaging/messaging.module';
import { ActivateSurveyHandler, CloseSurveyHandler } from './surveys/lifecycle.handlers';
import { SurveysModule } from './surveys/surveys.module';
import { SimulatorModule } from './simulator/simulator.module';
import { ReportingModule } from './reporting/reporting.module';
import { SeedModule } from './seed/seed.module';

/** Registers every job handler with the runner; shared by the API and the worker. */
@Module({})
export class JobHandlersModule implements OnModuleInit {
  constructor(
    private readonly runner: JobRunner,
    private readonly delivery: DeliveryService,
    private readonly activate: ActivateSurveyHandler,
    private readonly close: CloseSurveyHandler,
    private readonly conversation: ConversationService,
  ) {}

  onModuleInit(): void {
    for (const handler of [this.delivery, this.activate, this.close, this.conversation]) this.runner.register(handler);
  }
}

/** All domain modules without HTTP controllers. */
@Module({})
export class ServerModule {
  static forRoot(options: CoreModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [];
    return {
      module: ServerModule,
      imports: [CoreModule.forRoot(options), JobsModule, MessagingModule, ContactsModule, SurveysModule, ConversationModule, SimulatorModule, ReportingModule, SeedModule, { module: JobHandlersModule, imports: [SurveysModule, ConversationModule] }],
      providers,
      exports: [JobsModule, MessagingModule, ContactsModule, SurveysModule, ConversationModule, SimulatorModule, ReportingModule, SeedModule],
    };
  }
}
