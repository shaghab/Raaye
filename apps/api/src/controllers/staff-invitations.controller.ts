import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  staffInvitationAcceptSchema,
  staffInvitationCreateSchema,
  staffInvitationInspectSchema,
  type StaffInvitationAccept,
  type StaffInvitationCreate,
  type StaffInvitationDto,
  type StaffInvitationInspectDto,
} from '@raaye/contracts';
import {
  OrganizationService,
  Public,
  Roles,
  TOKEN_VERIFIER,
  Tenant,
  type TenantContext,
  type TokenVerifier,
  type VerifiedIdentity,
} from '@raaye/server';
import type { Request } from 'express';
import { zodBody } from '../common/zod';

@ApiTags('staff')
@Controller('staff-invitations')
export class StaffInvitationsController {
  constructor(
    private readonly organizations: OrganizationService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Post()
  create(@Tenant() ctx: TenantContext, @Body(zodBody(staffInvitationCreateSchema)) body: StaffInvitationCreate): Promise<StaffInvitationDto> {
    return this.organizations.createInvitation(ctx, body);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Get()
  list(@Tenant() ctx: TenantContext): Promise<StaffInvitationDto[]> {
    return this.organizations.listInvitations(ctx);
  }

  @ApiBearerAuth()
  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.organizations.revokeInvitation(ctx, id);
  }

  /** Public: reveals only the invited email, role and organization name for a valid token. */
  @Public()
  @Post('inspect')
  @HttpCode(200)
  inspect(@Body(zodBody(staffInvitationInspectSchema)) body: { token: string }): Promise<StaffInvitationInspectDto> {
    return this.organizations.inspectInvitation(body.token);
  }

  /**
   * Public route authorized by the invitation token. An existing user supplies their
   * Firebase token so the email binding can be verified; a new user supplies a password.
   */
  @Public()
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Body(zodBody(staffInvitationAcceptSchema)) body: StaffInvitationAccept,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request & { correlationId?: string },
  ): Promise<{ email: string }> {
    let identity: VerifiedIdentity | null = null;
    if (authorization?.startsWith('Bearer ')) {
      identity = await this.verifier.verify(authorization.slice('Bearer '.length).trim());
    }
    return this.organizations.acceptInvitation(body, identity, request.correlationId ?? 'none');
  }
}
