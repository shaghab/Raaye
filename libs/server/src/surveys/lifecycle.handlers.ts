import { Injectable } from '@nestjs/common';
import type { SystemContext } from '../common/context';
import type { JobHandler } from '../jobs/job-handler';
import type { ClaimedJob } from '../jobs/jobs.service';
import { LaunchService } from './launch.service';

@Injectable()
export class ActivateSurveyHandler implements JobHandler {
  readonly kind = 'ACTIVATE_SURVEY' as const;
  constructor(private readonly launch: LaunchService) {}
  async handle(job: ClaimedJob, ctx: SystemContext): Promise<void> {
    if (job.entityId) await this.launch.activateRun(ctx, job.entityId);
  }
}

@Injectable()
export class CloseSurveyHandler implements JobHandler {
  readonly kind = 'CLOSE_SURVEY' as const;
  constructor(private readonly launch: LaunchService) {}
  async handle(job: ClaimedJob, ctx: SystemContext): Promise<void> {
    if (job.entityId) await this.launch.closeRun(ctx, job.entityId, 'SCHEDULED_CLOSE');
  }
}
