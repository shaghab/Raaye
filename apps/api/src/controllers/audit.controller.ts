import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { auditQuerySchema, paginationQuerySchema, type AuditEventDto, type Page } from '@raaye/contracts';
import { AuditService, Roles, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

const querySchema = paginationQuerySchema.extend(auditQuerySchema.shape);

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles('ADMIN')
  @Get()
  list(@Tenant() ctx: TenantContext, @Query(zodBody(querySchema)) query: ReturnType<typeof querySchema.parse>): Promise<Page<AuditEventDto>> {
    return this.audit.list(ctx, query);
  }
}
