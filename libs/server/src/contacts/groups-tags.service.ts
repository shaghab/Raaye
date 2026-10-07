import { Injectable } from '@nestjs/common';
import type { GroupDto, GroupUpsert, TagDto, TagUpsert } from '@raaye/contracts';
import { normalizeText } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import type { TenantContext } from '../common/context';
import { DomainError, notFound } from '../common/errors';
import { isUniqueViolation } from '../persistence/db-errors';
import { TenantDbFactory } from '../persistence/tenant-db.factory';

@Injectable()
export class GroupsTagsService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
  ) {}

  async listGroups(ctx: TenantContext): Promise<GroupDto[]> {
    const groups = await this.dbFactory.for(ctx).group.findMany({ include: { _count: { select: { contacts: true } } }, orderBy: { name: 'asc' } });
    return groups.map((group) => ({ id: group.id, name: group.name, description: group.description, contactCount: group._count.contacts, createdAt: group.createdAt.toISOString() }));
  }

  async createGroup(ctx: TenantContext, input: GroupUpsert): Promise<GroupDto> {
    try {
      const group = await this.dbFactory.for(ctx).group.create({
        data: { organizationId: ctx.organizationId, name: input.name, normalizedName: normalizeText(input.name) ?? input.name.toLowerCase(), description: input.description ?? null },
      });
      await this.audit.record(ctx, { action: 'group.created', resourceType: 'group', resourceId: group.id });
      return { id: group.id, name: group.name, description: group.description, contactCount: 0, createdAt: group.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('VALIDATION_FAILED', 'A group with this name already exists', undefined, [{ path: 'name', message: 'Already exists' }], 409);
      throw error;
    }
  }

  async updateGroup(ctx: TenantContext, id: string, input: GroupUpsert): Promise<GroupDto> {
    const db = this.dbFactory.for(ctx);
    const existing = await db.group.findUnique({ where: { id } });
    if (!existing) throw notFound('Group');
    try {
      const group = await db.group.update({
        where: { id },
        data: { name: input.name, normalizedName: normalizeText(input.name) ?? input.name.toLowerCase(), description: input.description ?? null },
        include: { _count: { select: { contacts: true } } },
      });
      return { id: group.id, name: group.name, description: group.description, contactCount: group._count.contacts, createdAt: group.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('VALIDATION_FAILED', 'A group with this name already exists', undefined, [{ path: 'name', message: 'Already exists' }], 409);
      throw error;
    }
  }

  async setGroupMembership(ctx: TenantContext, groupId: string, contactId: string, member: boolean): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const [group, contact] = await Promise.all([db.group.findUnique({ where: { id: groupId } }), db.contact.findUnique({ where: { id: contactId } })]);
    if (!group) throw notFound('Group');
    if (!contact) throw notFound('Contact');
    if (member) {
      await db.contactGroup.upsert({
        where: { organizationId_contactId_groupId: { organizationId: ctx.organizationId, contactId, groupId } },
        create: { organizationId: ctx.organizationId, contactId, groupId },
        update: {},
      });
    } else {
      await db.contactGroup.deleteMany({ where: { contactId, groupId } });
    }
  }

  async listTags(ctx: TenantContext): Promise<TagDto[]> {
    const tags = await this.dbFactory.for(ctx).tag.findMany({ include: { _count: { select: { contacts: true } } }, orderBy: { name: 'asc' } });
    return tags.map((tag) => ({ id: tag.id, name: tag.name, contactCount: tag._count.contacts, createdAt: tag.createdAt.toISOString() }));
  }

  async createTag(ctx: TenantContext, input: TagUpsert): Promise<TagDto> {
    try {
      const tag = await this.dbFactory.for(ctx).tag.create({
        data: { organizationId: ctx.organizationId, name: input.name, normalizedName: normalizeText(input.name) ?? input.name.toLowerCase() },
      });
      await this.audit.record(ctx, { action: 'tag.created', resourceType: 'tag', resourceId: tag.id });
      return { id: tag.id, name: tag.name, contactCount: 0, createdAt: tag.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('VALIDATION_FAILED', 'A tag with this name already exists', undefined, [{ path: 'name', message: 'Already exists' }], 409);
      throw error;
    }
  }

  async updateTag(ctx: TenantContext, id: string, input: TagUpsert): Promise<TagDto> {
    const db = this.dbFactory.for(ctx);
    const existing = await db.tag.findUnique({ where: { id } });
    if (!existing) throw notFound('Tag');
    try {
      const tag = await db.tag.update({
        where: { id },
        data: { name: input.name, normalizedName: normalizeText(input.name) ?? input.name.toLowerCase() },
        include: { _count: { select: { contacts: true } } },
      });
      return { id: tag.id, name: tag.name, contactCount: tag._count.contacts, createdAt: tag.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('VALIDATION_FAILED', 'A tag with this name already exists', undefined, [{ path: 'name', message: 'Already exists' }], 409);
      throw error;
    }
  }

  async setTagMembership(ctx: TenantContext, tagId: string, contactId: string, member: boolean): Promise<void> {
    const db = this.dbFactory.for(ctx);
    const [tag, contact] = await Promise.all([db.tag.findUnique({ where: { id: tagId } }), db.contact.findUnique({ where: { id: contactId } })]);
    if (!tag) throw notFound('Tag');
    if (!contact) throw notFound('Contact');
    if (member) {
      await db.contactTag.upsert({
        where: { organizationId_contactId_tagId: { organizationId: ctx.organizationId, contactId, tagId } },
        create: { organizationId: ctx.organizationId, contactId, tagId },
        update: {},
      });
    } else {
      await db.contactTag.deleteMany({ where: { contactId, tagId } });
    }
  }
}
