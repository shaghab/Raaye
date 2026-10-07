import { Injectable } from '@nestjs/common';
import type { AudienceDefinition, AudiencePreviewDto, AudienceSummaryDto } from '@raaye/contracts';
import { outreachEligibility } from '@raaye/domain';
import type { OrgContext } from '../common/context';
import { contactFilterWhere } from '../contacts/contact-filter';
import type { Prisma } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';

export interface ResolvedRecipient {
  contactId: string;
  name: string;
  eligible: boolean;
  reason: string | null;
  snapshot: Record<string, unknown>;
}

export interface ResolvedAudience {
  recipients: ResolvedRecipient[];
  summary: AudienceSummaryDto;
}

/**
 * Resolves an audience definition into a deduplicated, tenant-scoped recipient set and
 * applies outreach eligibility independently. Everyone means every active contact of this
 * organization; it never bypasses consent.
 */
@Injectable()
export class AudienceService {
  constructor(private readonly dbFactory: TenantDbFactory) {}

  async resolve(ctx: OrgContext, definition: AudienceDefinition): Promise<ResolvedAudience> {
    const db = this.dbFactory.for(ctx);
    const where = this.baseWhere(definition);
    const contacts = await db.contact.findMany({
      where,
      select: {
        id: true,
        name: true,
        archivedAt: true,
        consentInvitations: true,
        city: true,
        district: true,
        gender: true,
        ageBand: true,
        occupation: true,
        membership: true,
        groups: { select: { groupId: true, group: { select: { name: true } } } },
        tags: { select: { tagId: true, tag: { select: { name: true } } } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 100_000,
    });
    const excludeContacts = new Set(definition.exclude?.contactIds ?? []);
    const excludeGroups = new Set(definition.exclude?.groupIds ?? []);
    const excludeTags = new Set(definition.exclude?.tagIds ?? []);
    const exclusions: Record<string, number> = {};
    const seen = new Set<string>();
    const recipients: ResolvedRecipient[] = [];
    for (const contact of contacts) {
      if (seen.has(contact.id)) continue;
      seen.add(contact.id);
      const snapshot = {
        city: contact.city,
        district: contact.district,
        gender: contact.gender,
        ageBand: contact.ageBand,
        occupation: contact.occupation,
        membership: contact.membership,
        groupIds: contact.groups.map((membership) => membership.groupId),
        groupNames: contact.groups.map((membership) => membership.group.name),
        tagIds: contact.tags.map((membership) => membership.tagId),
        tagNames: contact.tags.map((membership) => membership.tag.name),
      };
      let reason: string | null = null;
      if (excludeContacts.has(contact.id) || contact.groups.some((membership) => excludeGroups.has(membership.groupId)) || contact.tags.some((membership) => excludeTags.has(membership.tagId))) {
        reason = 'EXPLICITLY_EXCLUDED';
      } else {
        const eligibility = outreachEligibility({ archived: Boolean(contact.archivedAt), invitationConsent: contact.consentInvitations });
        if (!eligibility.eligible) reason = eligibility.reason;
      }
      if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      recipients.push({ contactId: contact.id, name: contact.name, eligible: reason === null, reason, snapshot });
    }
    const eligible = recipients.filter((recipient) => recipient.eligible).length;
    return { recipients, summary: { selected: recipients.length, eligible, exclusions } };
  }

  async preview(ctx: OrgContext, definition: AudienceDefinition): Promise<AudiencePreviewDto> {
    const resolved = await this.resolve(ctx, definition);
    return {
      mode: definition.mode,
      selected: resolved.summary.selected,
      eligible: resolved.summary.eligible,
      exclusions: resolved.summary.exclusions,
      sample: resolved.recipients.slice(0, 10).map((recipient) => ({ contactId: recipient.contactId, name: recipient.name, eligible: recipient.eligible, reason: recipient.reason })),
    };
  }

  private baseWhere(definition: AudienceDefinition): Prisma.ContactWhereInput {
    const groupTag = this.groupTagWhere(definition);
    switch (definition.mode) {
      case 'EVERYONE':
        return { archivedAt: null };
      case 'SELECTED':
        return { id: { in: definition.contactIds ?? [] } };
      case 'GROUPS_TAGS':
        return { archivedAt: null, ...groupTag };
      case 'FILTERED': {
        // Both helpers may produce a top-level OR (occupation list, ANY group/tag match);
        // spreading them would let one silently replace the other, so they are ANDed.
        const predicates = [contactFilterWhere(definition.filters), groupTag].filter((clause) => Object.keys(clause).length > 0);
        return predicates.length ? { archivedAt: null, AND: predicates } : { archivedAt: null };
      }
    }
  }

  private groupTagWhere(definition: AudienceDefinition): Prisma.ContactWhereInput {
    const groupIds = definition.groupIds ?? [];
    const tagIds = definition.tagIds ?? [];
    if (groupIds.length === 0 && tagIds.length === 0) return {};
    if (definition.groupTagMatch === 'ALL') {
      return {
        AND: [
          ...groupIds.map((groupId) => ({ groups: { some: { groupId } } })),
          ...tagIds.map((tagId) => ({ tags: { some: { tagId } } })),
        ],
      };
    }
    const clauses: Prisma.ContactWhereInput[] = [];
    if (groupIds.length) clauses.push({ groups: { some: { groupId: { in: groupIds } } } });
    if (tagIds.length) clauses.push({ tags: { some: { tagId: { in: tagIds } } } });
    return { OR: clauses };
  }
}
