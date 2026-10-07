import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  launchRequestSchema,
  surveyCreateSchema,
  surveyListQuerySchema,
  surveyUpdateSchema,
  testRunRequestSchema,
  type AudiencePreviewDto,
  type LaunchRequest,
  type Page,
  type PreviewMessageDto,
  type SurveyCreate,
  type SurveyDetailDto,
  type SurveyListItemDto,
  type SurveyListQuery,
  type SurveyUpdate,
  type TestRunRequest,
} from '@raaye/contracts';
import { IdempotencyKeyHeader, LaunchService, Roles, SurveysService, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

@ApiTags('surveys')
@ApiBearerAuth()
@Controller('surveys')
export class SurveysController {
  constructor(
    private readonly surveys: SurveysService,
    private readonly launch: LaunchService,
  ) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Query(zodBody(surveyListQuerySchema)) query: SurveyListQuery): Promise<Page<SurveyListItemDto>> {
    return this.surveys.list(ctx, query);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post()
  create(@Tenant() ctx: TenantContext, @Body(zodBody(surveyCreateSchema)) body: SurveyCreate): Promise<SurveyDetailDto> {
    return this.surveys.create(ctx, body);
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.surveys.get(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Patch(':id')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(surveyUpdateSchema)) body: SurveyUpdate): Promise<SurveyDetailDto> {
    return this.surveys.update(ctx, id, body);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/clone')
  clone(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.surveys.clone(ctx, id);
  }

  @Post(':id/preview')
  @HttpCode(200)
  preview(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<PreviewMessageDto[]> {
    return this.surveys.preview(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/audience-preview')
  @HttpCode(200)
  audiencePreview(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<AudiencePreviewDto> {
    return this.launch.audiencePreview(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/test-runs')
  testRun(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(testRunRequestSchema)) body: TestRunRequest): Promise<SurveyDetailDto> {
    return this.launch.createTestRun(ctx, id, body);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/launch')
  @HttpCode(200)
  launchSurvey(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(launchRequestSchema)) body: LaunchRequest, @IdempotencyKeyHeader() key: string | null): Promise<SurveyDetailDto> {
    return this.launch.launch(ctx, id, body, key);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/unschedule')
  @HttpCode(200)
  unschedule(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.launch.unschedule(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/close')
  @HttpCode(200)
  close(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.launch.close(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.launch.archive(ctx, id);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Post(':id/unarchive')
  @HttpCode(200)
  unarchive(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<SurveyDetailDto> {
    return this.surveys.unarchive(ctx, id);
  }
}
