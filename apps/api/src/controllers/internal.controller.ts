import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InternalTaskGuard, JobRunner, Public, SweepService } from '@raaye/server';

/** Task delivery endpoints for Cloud Tasks / Cloud Scheduler. Service identity is verified by the guard. */
@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTaskGuard)
export class InternalController {
  constructor(
    private readonly runner: JobRunner,
    private readonly sweep: SweepService,
  ) {}

  @Public()
  @Post('jobs/:jobId/execute')
  @HttpCode(200)
  async execute(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<{ result: string }> {
    const result = await this.runner.runJob(jobId);
    return { result };
  }

  @Public()
  @Post('sweep')
  @HttpCode(200)
  async runSweep(): Promise<Record<string, number>> {
    const result = await this.sweep.run();
    const processed = await this.runner.runOnce(25, 4);
    return { ...result, processed };
  }
}
