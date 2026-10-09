import { Inject, Injectable } from '@nestjs/common';
import {
  type ContactCreate,
  type ContactDetailDto,
  type ContactListQuery,
  type ContactSummaryDto,
  type ContactUpdate,
  type Page,
} from '@raaye/contracts';
import { buildXlsx, normalizePhone, normalizeText, toCsv, type Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, invalid, notFound } from '../common/errors';
import { isUniqueViolation } from '../persistence/db-errors';
import { asJson, asJsonOrNull } from '../persistence/json';
import type { Prisma } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';
import { ConsentService } from './consent.service';
import { contactFilterWhere, searchWhere } from './contact-filter';
import { lockContact } from './contact-lock';
import { cancelPendingOutreach } from './outreach-cancellation';

const contactInclude = {
  groups: { include: { group: { select: { id: true, name: true } } } },
  tags: { include: { tag: { select: { id: true, name: true } } } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

export function toContactSummary(contact: ContactRow): ContactSummaryDto {
  return {
    id: contact.id,
    name: contact.name,
    phoneE164: contact.phoneE164,
    city: contact.city,
    district: contact.district,
    gender: contact.gender,
    ageBand: contact.ageBand,
    occupation: contact.occupation,
    membership: contact.membership,
    membershipSource: contact.membershipSource,
    selfReportedMembership: contact.selfReportedMembership,
    preferredLocale: contact.preferredLocale,
    isSynthetic: contact.isSynthetic,
    archivedAt: contact.archivedAt?.toISOString() ?? null,
    consent: {
      invitations: contact.consentInvitations,
      results: contact.consentResults,
      invitationsEvidenceAt: contact.consentInvitationsAt?.toISOString() ?? null,
      resultsEvidenceAt: contact.consentResultsAt?.toISOString() ?? null,
    },
    groups: contact.groups.map((membership) => membership.group).sort((a, b) => a.name.localeCompare(b.name)),
    tags: contact.tags.map((membership) => membership.tag).sort((a, b) => a.name.localeCompare(b.name)),
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

export function listWhere(query: ContactListQuery): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {
    archivedAt: query.archived ? { not: null } : null,
    ...contactFilterWhere({
      city: query.city,
      district: query.district,
      gender: query.gender,
      ageBand: query.ageBand,
      occupation: query.occupation,
      membership: query.membership,
    }),
  };
  const search = searchWhere(query.search);
  const and: Prisma.ContactWhereInput[] = [];
  if (search.OR) and.push(search);
  if (query.consentStatus?.length) where.consentInvitations = { in: query.consentStatus };
  if (query.groupId?.length) where.groups = { some: { groupId: { in: query.groupId } } };
  if (query.tagId?.length) where.tags = { some: { tagId: { in: query.tagId } } };
  if (query.synthetic !== undefined) where.isSynthetic = query.synthetic === true || query.synthetic === 'true';
  if (and.length) where.AND = and;
  return where;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    private readonly consent: ConsentService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext, query: ContactListQuery): Promise<Page<ContactSummaryDto>> {
    const db = this.dbFactory.for(ctx);
    const where = listWhere(query);
    const [items, total] = await Promise.all([
      db.contact.findMany({ where, include: contactInclude, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit, skip: query.offset }),
      db.contact.count({ where }),
    ]);
    return { items: items.map(toContactSummary), total, limit: query.limit, offset: query.offset };
  }

  async get(ctx: TenantContext, id: string): Promise<ContactDetailDto> {
    const db = this.dbFactory.for(ctx);
    const contact = await db.contact.findUnique({ where: { id }, include: contactInclude });
    if (!contact) throw notFound('Contact');
    const [recipients, participations] = await Promise.all([
      db.surveyRecipient.findMany({
        where: { contactId: id },
        include: { invitation: { select: { state: true } }, run: { include: { survey: { select: { id: true, internalTitle: true } }, revision: { select: { title: true, questions: { select: { id: true } } } } } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      db.participation.findMany({ where: { contactId: id }, include: { _count: { select: { answers: true } } } }),
    ]);
    const participationByRun = new Map(participations.map((participation) => [participation.runId, participation]));
    return {
      ...toContactSummary(contact),
      ageYears: contact.ageYears,
      ageAsOf: contact.ageAsOf?.toISOString().slice(0, 10) ?? null,
      profileProvenance: (contact.profileProvenance as ContactDetailDto['profileProvenance']) ?? null,
      participations: recipients.map((recipient) => {
        const participation = participationByRun.get(recipient.runId);
        return {
          surveyId: recipient.run.survey.id,
          surveyTitle: recipient.run.survey.internalTitle,
          runKind: recipient.run.kind,
          state: participation ? (participation.state === 'COMPLETED' ? 'COMPLETED' : 'STARTED') : 'INVITED',
          invitationState: recipient.invitation?.state ?? null,
          startedAt: participation?.startedAt.toISOString() ?? null,
          completedAt: participation?.completedAt?.toISOString() ?? null,
          answeredCount: participation?._count.answers ?? 0,
          questionCount: recipient.run.revision.questions.length,
        };
      }),
    };
  }

  async create(ctx: TenantContext, input: ContactCreate): Promise<ContactDetailDto> {
    const phone = normalizePhone(input.phone, input.defaultCountry);
    if (!phone.ok) throw new DomainError('PHONE_INVALID', 'The phone number is not valid', { reason: phone.reason }, [{ path: 'phone', message: 'Invalid phone number' }]);
    const db = this.dbFactory.for(ctx);
    await this.assertGroupsAndTags(db, input.groupIds ?? [], input.tagIds ?? []);
    const now = this.clock.now();
    try {
      const contactId = await db.$transaction(async (tx) => {
        const contact = await tx.contact.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            phoneE164: phone.e164,
            city: input.city ?? null,
            cityNormalized: normalizeText(input.city),
            district: input.district ?? null,
            districtNormalized: normalizeText(input.district),
            gender: input.gender ?? null,
            ageBand: input.ageBand ?? null,
            occupation: input.occupation ?? null,
            membership: input.membership ?? 'UNKNOWN',
            membershipSource: input.membership ? 'ADMIN' : null,
            preferredLocale: input.preferredLocale ?? 'en',
            createdByUserId: ctx.userId,
            profileProvenance: asJson(provenance(['city', 'district', 'gender', 'ageBand', 'occupation', 'membership'], input, 'ADMIN', now)),
          },
        });
        const groupIds = Array.from(new Set(input.groupIds ?? []));
        const tagIds = Array.from(new Set(input.tagIds ?? []));
        if (groupIds.length) await tx.contactGroup.createMany({ data: groupIds.map((groupId) => ({ organizationId: ctx.organizationId, contactId: contact.id, groupId })) });
        if (tagIds.length) await tx.contactTag.createMany({ data: tagIds.map((tagId) => ({ organizationId: ctx.organizationId, contactId: contact.id, tagId })) });
        await this.audit.record(ctx, { action: 'contact.created', resourceType: 'contact', resourceId: contact.id }, tx);
        return contact.id;
      });
      return this.get(ctx, contactId);
    } catch (error) {
      if (isUniqueViolation(error, 'phone')) {
        throw new DomainError('CONTACT_DUPLICATE', 'A contact with this phone number already exists', undefined, [{ path: 'phone', message: 'Already exists' }]);
      }
      throw error;
    }
  }

  async update(ctx: TenantContext, id: string, input: ContactUpdate): Promise<ContactDetailDto> {
    const db = this.dbFactory.for(ctx);
    const existing = await db.contact.findUnique({ where: { id } });
    if (!existing) throw notFound('Contact');
    const now = this.clock.now();
    let newPhone: string | null = null;
    if (input.phone !== undefined) {
      const phone = normalizePhone(input.phone, input.defaultCountry ?? 'PK');
      if (!phone.ok) throw new DomainError('PHONE_INVALID', 'The phone number is not valid', { reason: phone.reason }, [{ path: 'phone', message: 'Invalid phone number' }]);
      if (phone.e164 !== existing.phoneE164) {
        if (!input.confirmPhoneChange) {
          throw invalid('Changing the phone number requires explicit confirmation; existing consent will not carry over', [
            { path: 'confirmPhoneChange', message: 'Confirm the phone number change' },
          ]);
        }
        newPhone = phone.e164;
      }
    }
    await this.assertGroupsAndTags(db, input.groupIds ?? [], input.tagIds ?? []);
    const data: Prisma.ContactUpdateInput = {};
    const changed: string[] = [];
    const set = (field: string, apply: () => void) => {
      apply();
      changed.push(field);
    };
    if (input.name !== undefined) set('name', () => (data.name = input.name));
    if (input.city !== undefined) {
      set('city', () => {
        data.city = input.city;
        data.cityNormalized = normalizeText(input.city);
      });
    }
    if (input.district !== undefined) {
      set('district', () => {
        data.district = input.district;
        data.districtNormalized = normalizeText(input.district);
      });
    }
    if (input.gender !== undefined) set('gender', () => (data.gender = input.gender));
    if (input.ageBand !== undefined) set('ageBand', () => (data.ageBand = input.ageBand));
    if (input.occupation !== undefined) set('occupation', () => (data.occupation = input.occupation));
    if (input.membership !== undefined) {
      set('membership', () => {
        data.membership = input.membership;
        data.membershipSource = 'ADMIN';
      });
    }
    if (input.preferredLocale !== undefined) set('preferredLocale', () => (data.preferredLocale = input.preferredLocale));
    const previousProvenance = (existing.profileProvenance as Record<string, unknown> | null) ?? {};
    data.profileProvenance = asJson({
      ...previousProvenance,
      ...provenance(changed.filter((field) => field !== 'name' && field !== 'preferredLocale'), input, 'ADMIN', now),
    });
    try {
      await db.$transaction(async (tx) => {
        if (newPhone) {
          // Under the contact lock, so a reply an inbound message is queuing at this moment is canceled too.
          await lockContact(tx, id);
          data.phoneE164 = newPhone;
          data.providerIdentity = null;
          changed.push('phone');
          await cancelPendingOutreach(tx, id, 'PHONE_CHANGED', now);
          // The new number has never written to the organization: no open service window,
          // no survey in the foreground, no pending prompt carried over from the old number.
          await tx.conversation.updateMany({ where: { contactId: id }, data: { lastInboundAt: null, foregroundParticipationId: null, pendingInput: null, pendingContext: asJsonOrNull(null) } });
          await this.consent.applyEvents(
            tx,
            id,
            (['SURVEY_INVITATIONS', 'SURVEY_RESULTS'] as const).map((scope) => ({
              scope,
              type: 'RESET' as const,
              source: 'PHONE_CHANGED' as const,
              evidenceAt: now,
              actorUserId: ctx.userId,
              note: 'Phone number changed; new consent evidence is required for the new number',
            })),
          );
        }
        await tx.contact.update({ where: { id }, data });
        if (input.groupIds !== undefined) {
          await tx.contactGroup.deleteMany({ where: { contactId: id, groupId: { notIn: input.groupIds } } });
          for (const groupId of input.groupIds) {
            await tx.contactGroup.upsert({
              where: { organizationId_contactId_groupId: { organizationId: ctx.organizationId, contactId: id, groupId } },
              create: { organizationId: ctx.organizationId, contactId: id, groupId },
              update: {},
            });
          }
        }
        if (input.tagIds !== undefined) {
          await tx.contactTag.deleteMany({ where: { contactId: id, tagId: { notIn: input.tagIds } } });
          for (const tagId of input.tagIds) {
            await tx.contactTag.upsert({
              where: { organizationId_contactId_tagId: { organizationId: ctx.organizationId, contactId: id, tagId } },
              create: { organizationId: ctx.organizationId, contactId: id, tagId },
              update: {},
            });
          }
        }
        await this.audit.record(ctx, { action: 'contact.updated', resourceType: 'contact', resourceId: id, metadata: { fields: changed, phoneChanged: Boolean(newPhone) } }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'phone')) {
        throw new DomainError('CONTACT_DUPLICATE', 'Another contact already uses this phone number', undefined, [{ path: 'phone', message: 'Already exists' }]);
      }
      throw error;
    }
    return this.get(ctx, id);
  }

  async archive(ctx: TenantContext, id: string): Promise<ContactDetailDto> {
    const db = this.dbFactory.for(ctx);
    const existing = await db.contact.findUnique({ where: { id } });
    if (!existing) throw notFound('Contact');
    const now = this.clock.now();
    await db.$transaction(async (tx) => {
      // Under the contact lock, so a reply an inbound message is queuing at this moment is canceled too, and the
      // archive state is the one the lock finds: a concurrent archive that committed first is not repeated.
      const locked = await lockContact(tx, id);
      if (!locked.archivedAt) {
        await tx.contact.update({ where: { id }, data: { archivedAt: now } });
        await cancelPendingOutreach(tx, id, 'CONTACT_ARCHIVED', now);
      }
      await this.audit.record(ctx, { action: 'contact.archived', resourceType: 'contact', resourceId: id }, tx);
    });
    return this.get(ctx, id);
  }

  async unarchive(ctx: TenantContext, id: string): Promise<ContactDetailDto> {
    const db = this.dbFactory.for(ctx);
    const existing = await db.contact.findUnique({ where: { id } });
    if (!existing) throw notFound('Contact');
    await db.contact.update({ where: { id }, data: { archivedAt: null } });
    await this.audit.record(ctx, { action: 'contact.unarchived', resourceType: 'contact', resourceId: id });
    return this.get(ctx, id);
  }

  /** Contact directory export for Admin and Survey Manager. */
  async exportContacts(ctx: TenantContext, query: ContactListQuery, format: 'csv' | 'xlsx'): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const db = this.dbFactory.for(ctx);
    const where = listWhere(query);
    const contacts = await db.contact.findMany({ where, include: contactInclude, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 50_000 });
    const header = [
      'contact_id',
      'name',
      'phone',
      'city',
      'district',
      'gender',
      'age_band',
      'occupation',
      'membership',
      'membership_source',
      'self_reported_membership',
      'consent_invitations',
      'consent_invitations_at',
      'consent_results',
      'consent_results_at',
      'groups',
      'tags',
      'preferred_locale',
      'synthetic',
      'archived_at',
      'created_at',
    ];
    const rows = contacts.map((contact) => {
      const summary = toContactSummary(contact);
      return [
        contact.id,
        contact.name,
        contact.phoneE164,
        contact.city ?? '',
        contact.district ?? '',
        contact.gender ?? '',
        contact.ageBand ?? '',
        contact.occupation ?? '',
        contact.membership,
        contact.membershipSource ?? '',
        contact.selfReportedMembership ?? '',
        summary.consent.invitations,
        summary.consent.invitationsEvidenceAt ?? '',
        summary.consent.results,
        summary.consent.resultsEvidenceAt ?? '',
        summary.groups.map((group) => group.name).join('; '),
        summary.tags.map((tag) => tag.name).join('; '),
        contact.preferredLocale,
        contact.isSynthetic ? 'true' : 'false',
        summary.archivedAt ?? '',
        summary.createdAt,
      ];
    });
    await this.audit.record(ctx, { action: 'contacts.exported', resourceType: 'contact', metadata: { format, rowCount: rows.length, filters: Object.keys(query) } });
    const stamp = this.clock.now().toISOString().slice(0, 10);
    if (format === 'xlsx') {
      return { filename: `contacts-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(buildXlsx([{ name: 'Contacts', rows: [header, ...rows] }])) };
    }
    return { filename: `contacts-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(toCsv([header, ...rows]), 'utf8') };
  }

  private async assertGroupsAndTags(db: ReturnType<TenantDbFactory['for']>, groupIds: string[], tagIds: string[]): Promise<void> {
    if (groupIds.length) {
      const count = await db.group.count({ where: { id: { in: groupIds } } });
      if (count !== new Set(groupIds).size) throw notFound('Group');
    }
    if (tagIds.length) {
      const count = await db.tag.count({ where: { id: { in: tagIds } } });
      if (count !== new Set(tagIds).size) throw notFound('Tag');
    }
  }
}

function provenance(fields: string[], input: Record<string, unknown>, source: 'ADMIN' | 'IMPORT' | 'SELF_REPORTED', at: Date): Record<string, { source: string; at: string }> {
  const result: Record<string, { source: string; at: string }> = {};
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null) result[field] = { source, at: at.toISOString() };
  }
  return result;
}

export type { TenantTx };
