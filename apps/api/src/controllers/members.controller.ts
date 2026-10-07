import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memberUpdateSchema, type MemberDto, type MemberUpdate } from '@raaye/contracts';
import { OrganizationService, Roles, Tenant, type TenantContext } from '@raaye/server';
import { zodBody } from '../common/zod';

@ApiTags('staff')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(private readonly organizations: OrganizationService) {}

  @Roles('ADMIN')
  @Get()
  list(@Tenant() ctx: TenantContext): Promise<MemberDto[]> {
    return this.organizations.listMembers(ctx);
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(memberUpdateSchema)) body: MemberUpdate,
  ): Promise<MemberDto> {
    return this.organizations.updateMember(ctx, id, body);
  }

  /** Revokes the membership. Research data is never deleted by this route. */
  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.organizations.revokeMember(ctx, id);
  }
}
