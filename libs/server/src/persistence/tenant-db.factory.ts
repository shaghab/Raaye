import { Injectable } from '@nestjs/common';
import type { OrgContext } from '../common/context';
import { PrismaService } from './prisma.service';
import { createTenantDb, type TenantDb } from './tenant-db';

/** Produces tenant-scoped clients for a verified context. */
@Injectable()
export class TenantDbFactory {
  constructor(private readonly prisma: PrismaService) {}

  for(ctx: OrgContext): TenantDb {
    return createTenantDb(this.prisma, ctx.organizationId);
  }

  forOrganization(organizationId: string): TenantDb {
    return createTenantDb(this.prisma, organizationId);
  }
}
