import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { HealthDto } from '@raaye/contracts';
import { HealthService, Public } from '@raaye/server';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('live')
  live(): HealthDto {
    return this.health.live();
  }

  @Public()
  @Get('ready')
  async ready(): Promise<HealthDto> {
    const result = await this.health.ready();
    if (result.status !== 'ok') {
      // Readiness failures are reported with 503 so orchestrators stop routing traffic.
      throw Object.assign(new Error('not ready'), { status: 503, response: result });
    }
    return result;
  }
}
