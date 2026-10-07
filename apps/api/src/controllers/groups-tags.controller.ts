import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { groupUpsertSchema, tagUpsertSchema, type GroupDto, type GroupUpsert, type TagDto, type TagUpsert } from '@raaye/contracts';
import { GroupsTagsService, Roles, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

@ApiTags('groups')
@ApiBearerAuth()
@Roles('ADMIN', 'SURVEY_MANAGER')
@Controller('groups')
export class GroupsController {
  constructor(private readonly service: GroupsTagsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext): Promise<GroupDto[]> {
    return this.service.listGroups(ctx);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body(zodBody(groupUpsertSchema)) body: GroupUpsert): Promise<GroupDto> {
    return this.service.createGroup(ctx, body);
  }

  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(groupUpsertSchema)) body: GroupUpsert): Promise<GroupDto> {
    return this.service.updateGroup(ctx, id, body);
  }

  @Post(':id/contacts/:contactId')
  @HttpCode(204)
  async add(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string): Promise<void> {
    await this.service.setGroupMembership(ctx, id, contactId, true);
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string): Promise<void> {
    await this.service.setGroupMembership(ctx, id, contactId, false);
  }
}

@ApiTags('tags')
@ApiBearerAuth()
@Roles('ADMIN', 'SURVEY_MANAGER')
@Controller('tags')
export class TagsController {
  constructor(private readonly service: GroupsTagsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext): Promise<TagDto[]> {
    return this.service.listTags(ctx);
  }

  @Post()
  create(@Tenant() ctx: TenantContext, @Body(zodBody(tagUpsertSchema)) body: TagUpsert): Promise<TagDto> {
    return this.service.createTag(ctx, body);
  }

  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(tagUpsertSchema)) body: TagUpsert): Promise<TagDto> {
    return this.service.updateTag(ctx, id, body);
  }

  @Post(':id/contacts/:contactId')
  @HttpCode(204)
  async add(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string): Promise<void> {
    await this.service.setTagMembership(ctx, id, contactId, true);
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string): Promise<void> {
    await this.service.setTagMembership(ctx, id, contactId, false);
  }
}
