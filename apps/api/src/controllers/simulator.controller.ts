import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, type CanActivate } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  contactListQuerySchema,
  simulatorClockSchema,
  simulatorFaultsSchema,
  simulatorFlowSubmitSchema,
  simulatorStatusSchema,
  simulatorTapSchema,
  simulatorTextSchema,
  type ContactListQuery,
  type ContactSummaryDto,
  type Page,
  type SimulatorConversationMessageDto,
  type SimulatorStateDto,
} from '@raaye/contracts';
import { APP_CONFIG, ContactsService, DomainError, Roles, SimulatorService, Tenant, type AppConfig, type TenantContext } from '@raaye/server';
import { z } from 'zod';
import { zodBody } from '../common/zod';

/** Simulator routes vanish (404) unless the simulator is enabled in a non-live configuration. */
@Injectable()
export class SimulatorEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  canActivate(): boolean {
    if (!this.config.simulatorEnabled) throw new DomainError('SIMULATOR_DISABLED', 'Not found');
    return true;
  }
}

@ApiTags('simulator (development only)')
@ApiBearerAuth()
@Roles('ADMIN')
@UseGuards(SimulatorEnabledGuard)
@Controller('dev/simulator')
export class SimulatorController {
  constructor(
    private readonly simulator: SimulatorService,
    private readonly contacts: ContactsService,
  ) {}

  @Get('state')
  state(@Tenant() ctx: TenantContext): Promise<SimulatorStateDto> {
    return this.simulator.state(ctx);
  }

  @Post('clock')
  @HttpCode(200)
  clock(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorClockSchema)) body: z.infer<typeof simulatorClockSchema>): Promise<SimulatorStateDto> {
    return this.simulator.setClock(ctx, body);
  }

  @Post('faults')
  @HttpCode(200)
  faults(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorFaultsSchema)) body: z.infer<typeof simulatorFaultsSchema>): Promise<SimulatorStateDto> {
    return this.simulator.setFaults(ctx, body as Record<string, unknown>);
  }

  @Get('contacts')
  contactsList(@Tenant() ctx: TenantContext, @Query(zodBody(contactListQuerySchema)) query: ContactListQuery): Promise<Page<ContactSummaryDto>> {
    return this.contacts.list(ctx, query);
  }

  @Get('conversation/:contactId')
  conversation(@Tenant() ctx: TenantContext, @Param('contactId', ParseUUIDPipe) contactId: string): Promise<SimulatorConversationMessageDto[]> {
    return this.simulator.conversation(ctx, contactId);
  }

  @Post('text')
  @HttpCode(200)
  text(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorTextSchema)) body: z.infer<typeof simulatorTextSchema>): Promise<{ eventId: string | null; duplicate: boolean }> {
    return this.simulator.sendText(ctx, body);
  }

  @Post('tap')
  @HttpCode(200)
  tap(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorTapSchema)) body: z.infer<typeof simulatorTapSchema>): Promise<{ eventId: string | null; duplicate: boolean }> {
    return this.simulator.tap(ctx, body);
  }

  @Post('flow')
  @HttpCode(200)
  flow(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorFlowSubmitSchema)) body: z.infer<typeof simulatorFlowSubmitSchema>): Promise<{ eventId: string | null; duplicate: boolean }> {
    return this.simulator.submitFlow(ctx, body);
  }

  @Post('status')
  @HttpCode(200)
  status(@Tenant() ctx: TenantContext, @Body(zodBody(simulatorStatusSchema)) body: z.infer<typeof simulatorStatusSchema>): Promise<{ results: string[] }> {
    return this.simulator.status(ctx, body);
  }

  @Post('drain')
  @HttpCode(200)
  drain(@Tenant() ctx: TenantContext): Promise<{ processed: number }> {
    return this.simulator.drain(ctx);
  }

  @Get('outbox')
  outbox(): Promise<{ email: string; requestType: string; oobLink: string }[]> {
    return this.simulator.emulatorOutbox();
  }
}
