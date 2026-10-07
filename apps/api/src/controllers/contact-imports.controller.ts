import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { LIMITS, importMappingSchema, type ImportBatchDto, type ImportMapping, type ImportPreviewDto } from '@raaye/contracts';
import { IdempotencyKeyHeader, ImportService, Roles, Tenant, importTemplate, invalid, type TenantContext } from '@raaye/server';
import type { Response } from 'express';
import { z } from 'zod';
import { sendDownload } from '../common/download';
import { zodBody } from '../common/zod';

interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('contact-imports')
@ApiBearerAuth()
@Roles('ADMIN', 'SURVEY_MANAGER')
@Controller('contact-imports')
export class ContactImportsController {
  constructor(private readonly imports: ImportService) {}

  @Get()
  list(@Tenant() ctx: TenantContext): Promise<ImportBatchDto[]> {
    return this.imports.list(ctx);
  }

  @Get('template')
  template(@Query(zodBody(z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }))) query: { format: 'csv' | 'xlsx' }, @Res() res: Response): void {
    sendDownload(res, importTemplate(query.format));
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LIMITS.importFile.maxBytes, files: 1 } }))
  upload(@Tenant() ctx: TenantContext, @UploadedFile() file: UploadedFileLike | undefined): Promise<ImportBatchDto> {
    if (!file) throw invalid('Attach a .csv or .xlsx file in the "file" field');
    return this.imports.upload(ctx, { originalName: file.originalname, size: file.size, buffer: file.buffer });
  }

  @Get(':id')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ImportBatchDto> {
    return this.imports.get(ctx, id);
  }

  @Get(':id/rows')
  rows(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<ImportPreviewDto> {
    return this.imports.previewRows(ctx, id);
  }

  @Post(':id/preview')
  @HttpCode(200)
  preview(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zodBody(importMappingSchema)) body: ImportMapping): Promise<ImportPreviewDto> {
    return this.imports.preview(ctx, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @IdempotencyKeyHeader() key: string | null): Promise<ImportBatchDto> {
    return this.imports.confirm(ctx, id, key);
  }

  @Get(':id/errors')
  async errors(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.imports.errorReport(ctx, id);
    sendDownload(res, { ...file, contentType: 'text/csv; charset=utf-8' });
  }
}
