import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { messageRetrySchema, messagingConfigurationSchema, type MessageRetry, type MessagingConfiguration, type MessagingReadinessDto } from '@raaye/contracts';
import { DeliveryService, MessagingReadinessService, Roles, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

@ApiTags('messaging')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('messaging')
export class MessagingController {
  constructor(private readonly readiness: MessagingReadinessService) {}

  @Get('readiness')
  getReadiness(@Tenant() ctx: TenantContext): Promise<MessagingReadinessDto> {
    return this.readiness.readiness(ctx);
  }

  @Patch('configuration')
  update(@Tenant() ctx: TenantContext, @Body(zodBody(messagingConfigurationSchema)) body: MessagingConfiguration): Promise<MessagingReadinessDto> {
    return this.readiness.updateConfiguration(ctx, body);
  }

  @Post('refresh-status')
  @HttpCode(200)
  refresh(@Tenant() ctx: TenantContext): Promise<MessagingReadinessDto> {
    return this.readiness.refreshStatus(ctx);
  }
}

@ApiTags('messaging')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('messages')
export class MessagesController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(messageRetrySchema)) body: MessageRetry): Promise<{ queued: true }> {
    await this.delivery.retry(ctx, id, body);
    return { queued: true };
  }
}
