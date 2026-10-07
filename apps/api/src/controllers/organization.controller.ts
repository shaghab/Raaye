import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { organizationUpdateSchema, type OrganizationDto, type OrganizationUpdate } from '@raaye/contracts';
import { OrganizationService, Roles, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

@ApiTags('organization')
@ApiBearerAuth()
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  get(@Tenant() ctx: TenantContext): Promise<OrganizationDto> {
    return this.organizations.get(ctx);
  }

  @Roles('ADMIN')
  @Patch()
  update(@Tenant() ctx: TenantContext, @Body(zodBody(organizationUpdateSchema)) body: OrganizationUpdate): Promise<OrganizationDto> {
    return this.organizations.update(ctx, body);
  }
}
