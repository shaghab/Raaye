import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { MeDto } from '@raaye/contracts';
import { AuthService, Tenant, type TenantContext } from '@raaye/server';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@Tenant() ctx: TenantContext): Promise<MeDto> {
    return this.auth.me(ctx);
  }
}
