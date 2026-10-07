import { Global, Module } from '@nestjs/common';
import { RetentionService } from '../retention/retention.service';
import { CloudTasksAdapter } from './cloud-tasks';
import { JobRunner } from './job-runner';
import { JobsService } from './jobs.service';
import { SweepService } from './sweep.service';

@Global()
@Module({
  providers: [JobsService, JobRunner, RetentionService, SweepService, CloudTasksAdapter],
  exports: [JobsService, JobRunner, RetentionService, SweepService, CloudTasksAdapter],
})
export class JobsModule {}
