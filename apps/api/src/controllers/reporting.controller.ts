import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  breakdownQuerySchema,
  dispatchQuerySchema,
  EXPORT_TYPES,
  exportQuerySchema,
  responsesQuerySchema,
  shareResultsSchema,
  type BreakdownDto,
  type DemographicDimension,
  type DispatchDto,
  type ExportType,
  type IndividualResponseDto,
  type MessageDto,
  type OverviewDto,
  type Page,
  type ResultSharePreviewDto,
  type ResultSharingDto,
  type ResultsDto,
} from '@raaye/contracts';
import { DomainError, ExportService, IdempotencyKeyHeader, ReportingService, Roles, SharingService, Tenant, type TenantContext } from '@raaye/server';
import type { Response } from 'express';
import { z } from 'zod';
import { sendDownload } from '../common/download';
import { zodBody } from '../common/zod';

@ApiTags('reporting')
@ApiBearerAuth()
@Controller('surveys')
export class ReportingController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly exports: ExportService,
    private readonly sharing: SharingService,
  ) {}

  @Get(':id/results')
  results(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ResultsDto> {
    return this.reporting.results(ctx, id);
  }

  @Get(':id/breakdowns')
  breakdowns(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zodBody(breakdownQuerySchema)) query: { dimension: DemographicDimension; questionId?: string }): Promise<BreakdownDto> {
    return this.reporting.breakdown(ctx, id, query.dimension, query.questionId);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Get(':id/dispatch')
  dispatch(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zodBody(dispatchQuerySchema)) query: z.infer<typeof dispatchQuerySchema>): Promise<DispatchDto> {
    return this.reporting.dispatch(ctx, id, query);
  }

  @Roles('ADMIN')
  @Get(':id/responses')
  responses(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zodBody(responsesQuerySchema)) query: z.infer<typeof responsesQuerySchema>): Promise<Page<IndividualResponseDto>> {
    return this.reporting.responses(ctx, id, query);
  }

  @Get(':id/exports/:type')
  async exportSurvey(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('type') type: string, @Query(zodBody(exportQuerySchema)) query: z.infer<typeof exportQuerySchema>, @Res() res: Response): Promise<void> {
    if (!(EXPORT_TYPES as readonly string[]).includes(type)) throw new DomainError('VALIDATION_FAILED', `Unknown export type; use one of ${EXPORT_TYPES.join(', ')}`);
    const file = await this.exports.exportSurvey(ctx, id, type as ExportType, query.format, query.dimension);
    sendDownload(res, file);
  }

  @Roles('ADMIN')
  @Post(':id/results-preview')
  @HttpCode(200)
  resultsPreview(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ResultSharePreviewDto> {
    return this.sharing.preview(ctx, id);
  }

  @Roles('ADMIN')
  @Post(':id/share-results')
  @HttpCode(200)
  shareResults(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(shareResultsSchema)) _body: { confirm: true }, @IdempotencyKeyHeader() key: string | null): Promise<ResultSharingDto> {
    return this.sharing.share(ctx, id, key);
  }

  @Roles('ADMIN', 'SURVEY_MANAGER')
  @Get(':id/result-sharing')
  resultSharing(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ResultSharingDto> {
    return this.sharing.status(ctx, id);
  }

  @Roles('ADMIN')
  @Post(':id/result-sharing/revoke')
  @HttpCode(200)
  revoke(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ResultSharingDto> {
    return this.sharing.revoke(ctx, id);
  }
}

@ApiTags('overview')
@ApiBearerAuth()
@Controller('overview')
export class OverviewController {
  constructor(private readonly reporting: ReportingService) {}

  @Get()
  overview(@Tenant() ctx: TenantContext): Promise<OverviewDto> {
    return this.reporting.overview(ctx);
  }
}

@ApiTags('messaging')
@ApiBearerAuth()
@Roles('ADMIN', 'SURVEY_MANAGER')
@Controller('messages')
export class MessageDetailController {
  constructor(private readonly reporting: ReportingService) {}

  @Get(':id')
  detail(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<MessageDto> {
    return this.reporting.messageDetail(ctx, id);
  }
}
