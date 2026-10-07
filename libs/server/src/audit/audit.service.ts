import { Injectable } from '@nestjs/common';
import type { AuditEventDto, Page, PaginationQuery } from '@raaye/contracts';
import type { OrgContext } from '../common/context';
import { isStaff } from '../common/context';
import { PrismaService } from '../persistence/prisma.service';
import { createTenantDb, type TenantTx } from '../persistence/tenant-db';
import { asJson } from '../persistence/json';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Metadata must be safe: identifiers, counts, reasons. Never
 * selected answers, phone numbers or token values.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: OrgContext, input: AuditInput, tx?: TenantTx): Promise<void> {
    const client = tx ?? createTenantDb(this.prisma, ctx.organizationId);
    await client.auditEvent.create({
      data: {
        organizationId: ctx.organizationId,
        actorType: isStaff(ctx) ? 'USER' : ctx.actor,
        actorUserId: isStaff(ctx) ? ctx.userId : null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata ? asJson(input.metadata) : undefined,
        correlationId: ctx.correlationId,
      },
    });
  }

  async list(
    ctx: OrgContext,
    query: PaginationQuery & { action?: string; resourceType?: string; resourceId?: string },
  ): Promise<Page<AuditEventDto>> {
    const db = createTenantDb(this.prisma, ctx.organizationId);
    const where = {
      action: query.action ? { contains: query.action, mode: 'insensitive' as const } : undefined,
      resourceType: query.resourceType || undefined,
      resourceId: query.resourceId || undefined,
    };
    const [items, total] = await Promise.all([
      db.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: query.limit, skip: query.offset }),
      db.auditEvent.count({ where }),
    ]);
    const userIds = Array.from(new Set(items.map((item) => item.actorUserId).filter((id): id is string => Boolean(id))));
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [];
    const emailById = new Map(users.map((user) => [user.id, user.email]));
    return {
      items: items.map((item) => ({
        id: item.id,
        actorType: item.actorType,
        actorUserId: item.actorUserId,
        actorEmail: item.actorUserId ? (emailById.get(item.actorUserId) ?? null) : null,
        action: item.action,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        metadata: (item.metadata as Record<string, unknown> | null) ?? null,
        correlationId: item.correlationId,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }
}
