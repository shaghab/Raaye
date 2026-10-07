import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  consentEventCreateSchema,
  contactCreateSchema,
  contactListQuerySchema,
  contactUpdateSchema,
  type ConsentEventCreate,
  type ConsentEventDto,
  type ContactCreate,
  type ContactDetailDto,
  type ContactListQuery,
  type ContactSummaryDto,
  type ContactUpdate,
  type Page,
} from '@raaye/contracts';
import { ConsentService, ContactsService, Roles, Tenant, type TenantContext } from '@raaye/server';
import type { Response } from 'express';
import { z } from 'zod';
import { zodBody } from '../common/zod';
import { sendDownload } from '../common/download';

const exportQuerySchema = contactListQuerySchema.extend({ format: z.enum(['csv', 'xlsx']).default('csv') });

@ApiTags('contacts')
@ApiBearerAuth()
@Roles('ADMIN', 'SURVEY_MANAGER')
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
  ) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Query(zodBody(contactListQuerySchema)) query: ContactListQuery): Promise<Page<ContactSummaryDto>> {
    return this.contacts.list(ctx, query);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body(zodBody(contactCreateSchema)) body: ContactCreate): Promise<ContactDetailDto> {
    return this.contacts.create(ctx, body);
  }

  @Get('export')
  async exportContacts(@Tenant() ctx: TenantContext, @Query(zodBody(exportQuerySchema)) query: ContactListQuery & { format: 'csv' | 'xlsx' }, @Res() res: Response): Promise<void> {
    const { format, ...rest } = query;
    const file = await this.contacts.exportContacts(ctx, { ...rest, limit: 100, offset: 0 }, format);
    sendDownload(res, file);
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ContactDetailDto> {
    return this.contacts.get(ctx, id);
  }

  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(contactUpdateSchema)) body: ContactUpdate): Promise<ContactDetailDto> {
    return this.contacts.update(ctx, id, body);
  }

  @Post(':id/archive')
  archive(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ContactDetailDto> {
    return this.contacts.archive(ctx, id);
  }

  @Post(':id/unarchive')
  unarchive(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ContactDetailDto> {
    return this.contacts.unarchive(ctx, id);
  }

  @Get(':id/consent-events')
  consentEvents(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ConsentEventDto[]> {
    return this.consent.listEvents(ctx, id);
  }

  @Post(':id/consent-events')
  recordConsent(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(consentEventCreateSchema)) body: ConsentEventCreate): Promise<ConsentEventDto[]> {
    return this.consent.recordStaffEvent(ctx, id, body);
  }
}
