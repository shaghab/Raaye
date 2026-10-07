import { Inject, Injectable } from '@nestjs/common';
import type { ConsentEventCreate, ContactCreate, QuestionInput, Role } from '@raaye/contracts';
import { normalizePhone } from '@raaye/domain';
import { FirebaseAdminService } from '../auth/token-verifier';
import type { TenantContext } from '../common/context';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { ConsentService } from '../contacts/consent.service';
import { ContactsService } from '../contacts/contacts.service';
import { GroupsTagsService } from '../contacts/groups-tags.service';
import { JobRunner } from '../jobs/job-runner';
import { SweepService } from '../jobs/sweep.service';
import type { Prisma } from '../persistence/generated/client';
import { PrismaService } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import { SharingService } from '../reporting/sharing.service';
import { SimulatorService } from '../simulator/simulator.service';
import { LaunchService } from '../surveys/launch.service';
import { SurveysService } from '../surveys/surveys.service';

/** Local-only demo accounts. The configuration refuses demo bootstrap in live/production. */
export const DEMO_ACCOUNTS = [
  { org: 'pilap', email: 'admin@pilap.demo', password: 'Raaye-Admin-2026!', role: 'ADMIN' as Role, displayName: 'Demo Admin' },
  { org: 'pilap', email: 'manager@pilap.demo', password: 'Raaye-Manager-2026!', role: 'SURVEY_MANAGER' as Role, displayName: 'Demo Survey Manager' },
  { org: 'pilap', email: 'viewer@pilap.demo', password: 'Raaye-Viewer-2026!', role: 'VIEWER' as Role, displayName: 'Demo Viewer' },
  { org: 'lcf-demo', email: 'admin@lcf.demo', password: 'Raaye-OrgB-2026!', role: 'ADMIN' as Role, displayName: 'Second Org Admin' },
] as const;

const ORGS = [
  {
    slug: 'pilap',
    name: 'Public Interest Law Association of Pakistan (demo)',
    supportContact: 'research@pilap.demo (synthetic)',
    participantNotice: 'PILAP is a nonprofit civil-society organization. This survey is voluntary. Your answers are linked to your contact record and visible only to authorized PILAP administrators. Reply STOP at any time to receive no further messages.',
  },
  {
    slug: 'lcf-demo',
    name: 'Lahore Citizens Forum (demo tenant B)',
    supportContact: 'hello@lcf.demo (synthetic)',
    participantNotice: 'Lahore Citizens Forum runs voluntary consultations. Your answers are linked to your contact record and visible only to authorized administrators. Reply STOP at any time to receive no further messages.',
  },
] as const;

interface SeedContact {
  name: string;
  phone: string;
  consent: 'granted' | 'granted-results' | 'unknown' | 'withdrawn';
  profile?: Partial<Pick<ContactCreate, 'city' | 'district' | 'gender' | 'ageBand' | 'occupation' | 'membership'>>;
  groups?: string[];
  tags?: string[];
}

// Synthetic numbers (never valid live recipients): +92 300 100 0xxx.
const CONTACTS: SeedContact[] = [
  { name: 'Ayesha Khan', phone: '+923001000001', consent: 'granted-results', profile: { city: 'Lahore', district: 'Lahore', gender: 'WOMAN', ageBand: 'AGE_25_34', occupation: 'Lawyer', membership: 'MEMBER' }, groups: ['Members', 'Lahore chapter'], tags: ['newsletter'] },
  { name: 'Bilal Ahmed', phone: '+923001000002', consent: 'granted-results', profile: { city: 'Lahore', district: 'Lahore', gender: 'MAN', ageBand: 'AGE_35_44', occupation: 'Teacher', membership: 'MEMBER' }, groups: ['Members', 'Lahore chapter'] },
  { name: 'Sana Malik', phone: '+923001000003', consent: 'granted-results', profile: { city: 'Karachi', district: 'Karachi South', gender: 'WOMAN', ageBand: 'AGE_18_24', occupation: 'Student', membership: 'NON_MEMBER' }, groups: ['Volunteers'], tags: ['2026-cohort'] },
  { name: 'Usman Tariq', phone: '+923001000004', consent: 'granted-results', profile: { city: 'Karachi', district: 'Karachi East', gender: 'MAN', ageBand: 'AGE_45_54', occupation: 'Shopkeeper', membership: 'NON_MEMBER' }, tags: ['newsletter'] },
  { name: 'Hira Baig', phone: '+923001000005', consent: 'granted-results', profile: { city: 'Islamabad', district: 'Islamabad', gender: 'WOMAN', ageBand: 'AGE_25_34', occupation: 'Journalist', membership: 'MEMBER' }, groups: ['Members'] },
  { name: 'Omar Farooq', phone: '+923001000006', consent: 'granted-results', profile: { city: 'Lahore', district: 'Lahore', gender: 'MAN', ageBand: 'AGE_55_64', occupation: 'Retired', membership: 'MEMBER' }, groups: ['Members', 'Lahore chapter'] },
  { name: 'Zainab Raza', phone: '+923001000007', consent: 'granted-results', profile: { city: 'Peshawar', district: 'Peshawar', gender: 'WOMAN', ageBand: 'AGE_35_44', occupation: 'Nurse', membership: 'NON_MEMBER' }, groups: ['Volunteers'] },
  { name: 'Ali Hassan', phone: '+923001000008', consent: 'granted', profile: { city: 'Quetta', district: 'Quetta', gender: 'MAN', ageBand: 'AGE_25_34', occupation: 'Driver' }, tags: ['2026-cohort'] },
  { name: 'Mariam Siddiqui', phone: '+923001000009', consent: 'granted', profile: { city: 'Lahore', gender: 'WOMAN', ageBand: 'AGE_65_PLUS', membership: 'MEMBER' }, groups: ['Members'] },
  { name: 'Hamza Sheikh', phone: '+923001000010', consent: 'granted', profile: { city: 'Karachi', district: 'Karachi Central', gender: 'MAN', ageBand: 'AGE_18_24', occupation: 'Student' }, groups: ['Volunteers'], tags: ['2026-cohort'] },
  { name: 'Fatima Noor', phone: '+923001000011', consent: 'granted', profile: { city: 'Multan', district: 'Multan', gender: 'WOMAN', ageBand: 'AGE_45_54', occupation: 'Farmer', membership: 'NON_MEMBER' } },
  { name: 'Kamran Iqbal', phone: '+923001000012', consent: 'granted', profile: { city: 'Faisalabad', district: 'Faisalabad', gender: 'MAN', ageBand: 'AGE_35_44', occupation: 'Engineer', membership: 'MEMBER' }, groups: ['Members'] },
  { name: 'Nadia Hussain', phone: '+923001000013', consent: 'granted', profile: { city: 'Lahore', district: 'Lahore', gender: 'PREFER_NOT_TO_SAY', ageBand: 'PREFER_NOT_TO_SAY', occupation: 'Accountant' }, groups: ['Lahore chapter'] },
  { name: 'Saad Qureshi', phone: '+923001000014', consent: 'granted', profile: { city: 'Rawalpindi', district: 'Rawalpindi', gender: 'MAN', ageBand: 'AGE_25_34' } },
  { name: 'Rabia Anwar', phone: '+923001000015', consent: 'granted', profile: { city: 'Karachi', gender: 'WOMAN', ageBand: 'AGE_35_44', occupation: 'Doctor', membership: 'MEMBER' }, groups: ['Members'] },
  { name: 'Imran Shah', phone: '+923001000016', consent: 'granted', profile: { city: 'Lahore', district: 'Lahore', gender: 'MAN', ageBand: 'AGE_45_54', occupation: 'Lawyer', membership: 'MEMBER' }, groups: ['Members', 'Lahore chapter'] },
  { name: 'Laila Mirza', phone: '+923001000017', consent: 'granted', profile: { city: 'Hyderabad', district: 'Hyderabad', gender: 'WOMAN', ageBand: 'AGE_18_24', occupation: 'Student' }, tags: ['2026-cohort'] },
  { name: 'Tariq Mehmood', phone: '+923001000018', consent: 'granted', profile: { gender: 'MAN', ageBand: 'AGE_55_64' } },
  { name: 'Sadia Butt', phone: '+923001000019', consent: 'granted', profile: { city: 'Lahore', district: 'Lahore', gender: 'WOMAN', ageBand: 'AGE_25_34', occupation: 'Designer' }, groups: ['Lahore chapter'], tags: ['newsletter'] },
  { name: 'Waqar Younis', phone: '+923001000020', consent: 'granted', profile: { city: 'Sialkot', district: 'Sialkot', gender: 'MAN', ageBand: 'AGE_35_44', occupation: 'Exporter', membership: 'NON_MEMBER' } },
  { name: 'Unknown Consent One', phone: '+923001000021', consent: 'unknown', profile: { city: 'Lahore', gender: 'WOMAN' } },
  { name: 'Unknown Consent Two', phone: '+923001000022', consent: 'unknown', profile: { city: 'Karachi' } },
  { name: 'Unknown Consent Three', phone: '+923001000023', consent: 'unknown' },
  { name: 'Withdrawn Contact', phone: '+923001000024', consent: 'withdrawn', profile: { city: 'Lahore', district: 'Lahore', gender: 'MAN', ageBand: 'AGE_25_34' }, groups: ['Members'] },
  { name: 'Withdrawn Contact Two', phone: '+923001000025', consent: 'withdrawn', profile: { city: 'Islamabad' } },
  { name: 'Missing Profile One', phone: '+923001000026', consent: 'granted' },
  { name: 'Missing Profile Two', phone: '+923001000027', consent: 'granted' },
  { name: 'Shared Number Across Tenants', phone: '+923001000099', consent: 'granted', profile: { city: 'Lahore', gender: 'WOMAN', ageBand: 'AGE_25_34' } },
];

const FIVE_TYPES: QuestionInput[] = [
  { authoringType: 'YES_NO', prompt: { en: 'Do you use public transport at least once a week?' } },
  { authoringType: 'YES_NO_INDIFFERENT', prompt: { en: 'Should bus fares be subsidized for students?' } },
  { authoringType: 'SINGLE_CHOICE', prompt: { en: 'Which transport issue matters most to you?' }, options: [{ label: { en: 'Safety' } }, { label: { en: 'Cost' } }, { label: { en: 'Reliability' } }, { label: { en: 'Accessibility' } }] },
  { authoringType: 'MULTI_CHOICE', prompt: { en: 'Which services have you used this year?' }, options: [{ label: { en: 'Metro bus' } }, { label: { en: 'Orange line' } }, { label: { en: 'Rickshaw apps' } }, { label: { en: 'None of the above' }, exclusive: true }], minSelections: 1, maxSelections: 3 },
  { authoringType: 'RATING', prompt: { en: 'How would you rate public transport overall?' }, ratingMinLabel: { en: 'Very poor' }, ratingMaxLabel: { en: 'Excellent' } },
];

const LEGAL_AID: QuestionInput[] = [
  { authoringType: 'YES_NO', prompt: { en: 'Have you heard of free legal aid services in your area?' } },
  { authoringType: 'MULTI_CHOICE', prompt: { en: 'Which of these have you used this year?' }, options: [{ label: { en: 'Legal aid clinic' } }, { label: { en: 'Rights workshop' } }, { label: { en: 'Helpline' } }, { label: { en: 'None of the above' }, exclusive: true }], minSelections: 1, maxSelections: 3 },
  { authoringType: 'RATING', prompt: { en: 'How easy is it to reach a lawyer when you need one?' } },
];

const ACCESS_TO_JUSTICE: QuestionInput[] = [
  { authoringType: 'YES_NO_INDIFFERENT', prompt: { en: 'Do courts in your district resolve cases in reasonable time?' } },
  { authoringType: 'SINGLE_CHOICE', prompt: { en: 'What is the biggest barrier to justice for you?' }, options: [{ label: { en: 'Cost' } }, { label: { en: 'Distance' } }, { label: { en: 'Delays' } }, { label: { en: 'Information' } }] },
  { authoringType: 'RATING', prompt: { en: 'Rate your trust in the local justice system.' } },
];

export interface SeedReport {
  organizations: string[];
  accounts: { email: string; role: Role; organization: string }[];
  contacts: number;
  surveys: string[];
  skipped: string[];
}

/**
 * Idempotent synthetic demo. Everything flows through the same domain services the API uses
 * (contacts, consent, surveys, launch, simulator inbound pipeline, sharing); nothing is
 * written directly as fabricated answers. Safe to re-run: existing identities are reused.
 */
@Injectable()
export class SeedService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly firebase: FirebaseAdminService,
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly groupsTags: GroupsTagsService,
    private readonly surveys: SurveysService,
    private readonly launch: LaunchService,
    private readonly simulator: SimulatorService,
    private readonly sharing: SharingService,
    private readonly runner: JobRunner,
    private readonly sweep: SweepService,
  ) {}

  assertAllowed(): void {
    if (this.config.isProduction || this.config.isLiveMessaging || !this.config.ALLOW_DEMO_BOOTSTRAP || this.config.AUTH_MODE === 'live') {
      throw new Error('Demo seeding is disabled: it requires ALLOW_DEMO_BOOTSTRAP=true with a non-live, non-production configuration');
    }
  }

  async seed(): Promise<SeedReport> {
    this.assertAllowed();
    const report: SeedReport = { organizations: [], accounts: [], contacts: 0, surveys: [], skipped: [] };
    const contexts = new Map<string, TenantContext>();
    for (const org of ORGS) {
      const organization = await this.ensureOrganization(org);
      report.organizations.push(organization.slug);
      for (const account of DEMO_ACCOUNTS.filter((item) => item.org === org.slug)) {
        const ctx = await this.ensureAccount(organization.id, account.email, account.password, account.displayName, account.role);
        report.accounts.push({ email: account.email, role: account.role, organization: org.slug });
        if (account.role === 'ADMIN') contexts.set(org.slug, ctx);
      }
    }
    const pilap = contexts.get('pilap');
    const orgB = contexts.get('lcf-demo');
    if (!pilap || !orgB) throw new Error('Admin contexts missing');
    await this.ensureSimulatorState();
    report.contacts += await this.seedContacts(pilap, CONTACTS);
    report.contacts += await this.seedContacts(orgB, [
      { name: 'Tenant B Contact', phone: '+923001000099', consent: 'granted', profile: { city: 'Lahore' } },
      { name: 'Tenant B Second', phone: '+923001000098', consent: 'granted', profile: { city: 'Karachi' } },
      { name: 'Tenant B Unknown', phone: '+923001000097', consent: 'unknown' },
    ]);
    if (!this.config.simulatorEnabled) {
      report.skipped.push('surveys (ENABLE_SIMULATOR=false: participant conversations cannot be scripted)');
      return report;
    }
    await this.seedSurveys(pilap, report);
    await this.seedOrgBSurvey(orgB, report);
    return report;
  }

  /** 1,000 synthetic, consented contacts for the scale scenario (R59). Idempotent by phone. */
  async seedScale(count = 1000): Promise<{ created: number; existing: number }> {
    this.assertAllowed();
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { slug: 'pilap' } });
    const cities = ['Lahore', 'Karachi', 'Islamabad', 'Peshawar', 'Quetta', 'Multan', null];
    const genders = ['WOMAN', 'MAN', 'ANOTHER_IDENTITY', 'PREFER_NOT_TO_SAY', null] as const;
    const ageBands = ['UNDER_18', 'AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_64', 'AGE_65_PLUS', null] as const;
    const existing = new Set((await this.prisma.contact.findMany({ where: { organizationId: organization.id, phoneE164: { startsWith: '+9230020' } }, select: { phoneE164: true } })).map((row) => row.phoneE164));
    const evidenceAt = new Date('2026-09-01T00:00:00Z');
    let created = 0;
    for (let start = 0; start < count; start += 200) {
      const batch: Prisma.ContactCreateManyInput[] = [];
      for (let index = start; index < Math.min(count, start + 200); index += 1) {
        const phone = `+9230020${String(index).padStart(5, '0')}`;
        if (existing.has(phone)) continue;
        batch.push({
          organizationId: organization.id,
          name: `Scale Contact ${index + 1}`,
          phoneE164: phone,
          city: cities[index % cities.length],
          gender: genders[index % genders.length],
          ageBand: ageBands[index % ageBands.length],
          membership: index % 4 === 0 ? ('MEMBER' as const) : ('UNKNOWN' as const),
          consentInvitations: 'GRANTED' as const,
          consentInvitationsAt: evidenceAt,
          consentResults: index % 2 === 0 ? ('GRANTED' as const) : ('UNKNOWN' as const),
          consentResultsAt: index % 2 === 0 ? evidenceAt : null,
          isSynthetic: true,
        });
      }
      if (!batch.length) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.contact.createMany({ data: batch });
        const rows = await tx.contact.findMany({ where: { organizationId: organization.id, phoneE164: { in: batch.map((item) => item.phoneE164) } }, select: { id: true, consentResults: true } });
        await tx.consentEvent.createMany({
          data: rows.flatMap((row) => [
            { organizationId: organization.id, contactId: row.id, scope: 'SURVEY_INVITATIONS' as const, type: 'GRANTED' as const, source: 'SEED' as const, evidenceAt, evidenceReference: 'Synthetic scale seed' },
            ...(row.consentResults === 'GRANTED' ? [{ organizationId: organization.id, contactId: row.id, scope: 'SURVEY_RESULTS' as const, type: 'GRANTED' as const, source: 'SEED' as const, evidenceAt, evidenceReference: 'Synthetic scale seed' }] : []),
          ]),
        });
      });
      created += batch.length;
    }
    return { created, existing: existing.size };
  }

  private async ensureOrganization(org: (typeof ORGS)[number]) {
    return this.prisma.organization.upsert({
      where: { slug: org.slug },
      create: { slug: org.slug, name: org.name, timezone: this.config.DEFAULT_TIMEZONE, participantNotice: org.participantNotice, supportContact: org.supportContact, isDemo: true },
      update: {},
    });
  }

  private async ensureAccount(organizationId: string, email: string, password: string, displayName: string, role: Role): Promise<TenantContext> {
    const uid = this.config.AUTH_MODE === 'emulator' ? await this.firebase.ensureUser(email, password, displayName) : `seed-${email.replace(/[^a-z0-9]/gi, '-')}`;
    const user = await this.prisma.user.upsert({ where: { email }, create: { email, firebaseUid: uid, displayName }, update: { firebaseUid: uid, displayName, state: 'ACTIVE' } });
    const membership = await this.prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      create: { organizationId, userId: user.id, role },
      update: { role, status: 'ACTIVE', revokedAt: null },
    });
    await this.prisma.messagingConnection.upsert({
      where: { appKey: `mock-${(await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).slug}` },
      create: { organizationId, provider: 'MOCK', mode: 'MOCK', appKey: `mock-${(await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).slug}`, enabled: true, readinessState: 'READY' },
      update: {},
    });
    return { organizationId, userId: user.id, membershipId: membership.id, role, email, correlationId: 'seed' };
  }

  private async ensureSimulatorState(): Promise<void> {
    await this.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }

  private async seedContacts(ctx: TenantContext, contacts: SeedContact[]): Promise<number> {
    const db = this.dbFactory.for(ctx);
    const groups = new Map((await this.groupsTags.listGroups(ctx)).map((group) => [group.name, group.id]));
    const tags = new Map((await this.groupsTags.listTags(ctx)).map((tag) => [tag.name, tag.id]));
    for (const name of ['Members', 'Volunteers', 'Lahore chapter']) if (!groups.has(name) && contacts.some((contact) => contact.groups?.includes(name))) groups.set(name, (await this.groupsTags.createGroup(ctx, { name, description: `${name} (synthetic demo group)` })).id);
    for (const name of ['newsletter', '2026-cohort']) if (!tags.has(name) && contacts.some((contact) => contact.tags?.includes(name))) tags.set(name, (await this.groupsTags.createTag(ctx, { name })).id);
    let created = 0;
    for (const spec of contacts) {
      const phone = normalizePhone(spec.phone);
      if (!phone.ok) throw new Error(`Seed phone invalid: ${spec.phone}`);
      const existing = await db.contact.findFirst({ where: { phoneE164: phone.e164 } });
      if (existing) continue;
      const contact = await this.contacts.create(ctx, {
        name: spec.name,
        phone: spec.phone,
        defaultCountry: 'PK',
        ...spec.profile,
        membership: spec.profile?.membership ?? 'UNKNOWN',
        groupIds: (spec.groups ?? []).map((group) => groups.get(group)).filter((id): id is string => Boolean(id)),
        tagIds: (spec.tags ?? []).map((tag) => tags.get(tag)).filter((id): id is string => Boolean(id)),
      });
      await db.contact.update({ where: { id: contact.id }, data: { isSynthetic: true } });
      const evidence: ConsentEventCreate = { scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-01T09:00:00+05:00', evidenceReference: 'Synthetic demo consent form', wordingVersion: 'demo-v1' };
      if (spec.consent === 'granted') await this.consent.recordStaffEvent(ctx, contact.id, evidence);
      if (spec.consent === 'granted-results') await this.consent.recordStaffEvent(ctx, contact.id, { ...evidence, scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'] });
      if (spec.consent === 'withdrawn') {
        await this.consent.recordStaffEvent(ctx, contact.id, evidence);
        await this.consent.recordStaffEvent(ctx, contact.id, { scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'WITHDRAWN', evidenceAt: '2026-09-20T09:00:00+05:00', evidenceReference: 'Synthetic withdrawal request', note: 'Asked to stop by phone' });
      }
      created += 1;
    }
    return created;
  }

  private async existingSurvey(ctx: TenantContext, internalTitle: string): Promise<string | null> {
    const survey = await this.dbFactory.for(ctx).survey.findFirst({ where: { internalTitle } });
    return survey?.id ?? null;
  }

  private async contactId(ctx: TenantContext, phone: string): Promise<string> {
    const contact = await this.dbFactory.for(ctx).contact.findFirstOrThrow({ where: { phoneE164: phone } });
    return contact.id;
  }

  private async seedSurveys(ctx: TenantContext, report: SeedReport): Promise<void> {
    const script = new ParticipantScript(ctx, this.simulator, this.runner, this.sweep);
    const base = { title: { en: '' }, introduction: { en: 'Thank you for taking part. Answer one question at a time; you can change an answer within two minutes.' }, locale: 'en' };

    // 1. Editable draft with all five question types.
    const draftTitle = 'Public transport priorities (draft)';
    if (await this.existingSurvey(ctx, draftTitle)) report.skipped.push(draftTitle);
    else {
      await this.surveys.create(ctx, { ...base, internalTitle: draftTitle, title: { en: 'Public transport priorities' }, questions: FIVE_TYPES, audience: { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
      report.surveys.push(draftTitle);
    }

    // 2. Scheduled survey using the 48-hour default.
    const scheduledTitle = 'Member satisfaction 2026 (scheduled)';
    if (await this.existingSurvey(ctx, scheduledTitle)) report.skipped.push(scheduledTitle);
    else {
      const members = (await this.groupsTags.listGroups(ctx)).find((group) => group.name === 'Members');
      const created = await this.surveys.create(ctx, { ...base, internalTitle: scheduledTitle, title: { en: 'Member satisfaction 2026' }, questions: [FIVE_TYPES[0], FIVE_TYPES[2], FIVE_TYPES[4]], audience: members ? { mode: 'GROUPS_TAGS', groupIds: [members.id], groupTagMatch: 'ANY' } : { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
      const opensAt = new Date(Date.now() + 2 * 86_400_000);
      opensAt.setUTCMinutes(0, 0, 0);
      await this.launch.launch(ctx, created.id, { mode: 'SCHEDULED', opensAt: opensAt.toISOString() }, null);
      report.surveys.push(scheduledTitle);
    }

    // 3. Active survey with partial and completed responses plus delivery diagnostics.
    const activeTitle = 'Legal aid awareness (active)';
    if (await this.existingSurvey(ctx, activeTitle)) report.skipped.push(activeTitle);
    else {
      const created = await this.surveys.create(ctx, { ...base, internalTitle: activeTitle, title: { en: 'Legal aid awareness' }, questions: LEGAL_AID, audience: { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
      // Failure fixtures for the diagnostics screen: one permanent delivery failure and one
      // ambiguous (timed-out) send, scoped to two dedicated synthetic contacts.
      const [failing, ambiguous] = await Promise.all([this.contactId(ctx, '+923001000026'), this.contactId(ctx, '+923001000027')]);
      await this.simulator.setFaults(ctx, { failForContactId: failing, timeoutForContactId: ambiguous });
      await this.launch.launch(ctx, created.id, { mode: 'NOW' }, null);
      await script.drain();
      await this.simulator.setFaults(ctx, { failForContactId: null, timeoutForContactId: null });
      const [ayesha, bilal, sana, usman, hira, omar, zainab, ali] = await Promise.all(['+923001000001', '+923001000002', '+923001000003', '+923001000004', '+923001000005', '+923001000006', '+923001000007', '+923001000008'].map((phone) => this.contactId(ctx, phone)));
      // Completed responses (profile step skipped or completed).
      await script.start(ayesha, 'skip');
      await script.tap(ayesha, 'Yes');
      await script.multi(ayesha, ['Legal aid clinic', 'Helpline']);
      await script.tap(ayesha, '4');
      await script.start(bilal, 'skip');
      await script.tap(bilal, 'No');
      await script.multi(bilal, ['None of the above']);
      await script.tap(bilal, '2');
      await script.start(sana, 'skip');
      await script.tap(sana, 'Yes');
      await script.multi(sana, ['Rights workshop']);
      await script.tap(sana, '5');
      // Edited answer within the window (revision history example).
      await script.start(usman, 'skip');
      await script.tap(usman, 'No');
      await script.tap(usman, 'Yes', (text) => text.includes('Question 1 of'));
      await script.multi(usman, ['Legal aid clinic']);
      await script.tap(usman, '3');
      // Partial responses.
      await script.start(hira, 'skip');
      await script.tap(hira, 'Yes');
      await script.start(omar, 'skip');
      // Started then opted out.
      await script.start(zainab, 'skip');
      await script.tap(zainab, 'No');
      await script.text(zainab, 'STOP');
      // Asked for help without starting.
      await script.text(ali, 'HELP');
      report.surveys.push(activeTitle);
    }

    // 4. Closed survey with enough respondents to share aggregates.
    const closedTitle = 'Access to justice 2026 (closed, results shared)';
    if (await this.existingSurvey(ctx, closedTitle)) report.skipped.push(closedTitle);
    else {
      const created = await this.surveys.create(ctx, { ...base, internalTitle: closedTitle, title: { en: 'Access to justice 2026' }, questions: ACCESS_TO_JUSTICE, audience: { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
      await this.launch.launch(ctx, created.id, { mode: 'NOW' }, null);
      await script.drain();
      const answers: [string, string, string, string][] = [
        ['+923001000001', 'Yes', 'Cost', '4'],
        ['+923001000002', 'No', 'Delays', '2'],
        ['+923001000003', 'Indifferent', 'Information', '3'],
        ['+923001000004', 'No', 'Delays', '1'],
        ['+923001000005', 'Yes', 'Cost', '5'],
        ['+923001000006', 'No', 'Distance', '2'],
        ['+923001000011', 'Yes', 'Cost', '4'],
        ['+923001000009', 'No', 'Delays', '3'],
        ['+923001000012', 'Indifferent', 'Information', '3'],
        ['+923001000016', 'No', 'Delays', '2'],
      ];
      for (const [phone, q1, q2, q3] of answers) {
        const id = await this.contactId(ctx, phone);
        await script.start(id, 'skip');
        await script.tap(id, q1);
        await script.tap(id, q2);
        await script.tap(id, q3);
      }
      const partial = await this.contactId(ctx, '+923001000010');
      await script.start(partial, 'skip');
      await script.tap(partial, 'Yes');
      await this.launch.close(ctx, created.id);
      await script.drain();
      await this.sharing.share(ctx, created.id, null);
      await script.drain();
      // Two respondents open the shared results.
      for (const phone of ['+923001000001', '+923001000003']) {
        const id = await this.contactId(ctx, phone);
        await script.tap(id, 'View results');
      }
      report.surveys.push(closedTitle);
    }

    // 5. Archived survey.
    const archivedTitle = 'Pilot survey 2025 (archived)';
    if (await this.existingSurvey(ctx, archivedTitle)) report.skipped.push(archivedTitle);
    else {
      const created = await this.surveys.create(ctx, { ...base, internalTitle: archivedTitle, title: { en: 'Pilot survey 2025' }, questions: [FIVE_TYPES[0]], audience: { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
      await this.launch.launch(ctx, created.id, { mode: 'NOW' }, null);
      await script.drain();
      for (const phone of ['+923001000001', '+923001000002']) {
        const id = await this.contactId(ctx, phone);
        await script.start(id, 'skip');
        await script.tap(id, phone.endsWith('1') ? 'Yes' : 'No');
      }
      await this.launch.close(ctx, created.id);
      await this.launch.archive(ctx, created.id);
      report.surveys.push(archivedTitle);
    }
  }

  private async seedOrgBSurvey(ctx: TenantContext, report: SeedReport): Promise<void> {
    const title = 'Tenant B neighbourhood poll (active)';
    if (await this.existingSurvey(ctx, title)) {
      report.skipped.push(title);
      return;
    }
    const script = new ParticipantScript(ctx, this.simulator, this.runner, this.sweep);
    const created = await this.surveys.create(ctx, { internalTitle: title, title: { en: 'Neighbourhood poll' }, introduction: { en: 'A short voluntary poll from Lahore Citizens Forum.' }, locale: 'en', questions: [FIVE_TYPES[0], FIVE_TYPES[4]], audience: { mode: 'EVERYONE', groupTagMatch: 'ANY' } });
    await this.launch.launch(ctx, created.id, { mode: 'NOW' }, null);
    await script.drain();
    const shared = await this.contactId(ctx, '+923001000099');
    await script.start(shared, 'skip');
    await script.tap(shared, 'Yes');
    await script.tap(shared, '5');
    report.surveys.push(title);
  }
}

interface ConversationMessage {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  kind: string;
  text: string;
  controls: { id: string; label: string }[];
  flow: { token: string; purpose: string; options: { id: string; label: string }[] } | null;
}

/** Drives a synthetic participant through the real simulator ingress (same pipeline as webhooks). */
class ParticipantScript {
  constructor(
    private readonly ctx: TenantContext,
    private readonly simulator: SimulatorService,
    private readonly runner: JobRunner,
    private readonly sweep: SweepService,
  ) {}

  async drain(): Promise<void> {
    await this.sweep.run();
    for (let round = 0; round < 30; round += 1) {
      const processed = await this.runner.runOnce(50, 4);
      if (processed === 0) break;
    }
  }

  private async outbound(contactId: string): Promise<ConversationMessage[]> {
    const messages = (await this.simulator.conversation(this.ctx, contactId)) as unknown as ConversationMessage[];
    return messages.filter((message) => message.direction === 'OUTBOUND');
  }

  /** Taps Start on the latest invitation, switches surveys when asked, and skips the optional profile step. */
  async start(contactId: string, profile: 'skip'): Promise<void> {
    await this.tap(contactId, 'Start survey', (_text, message) => message.kind === 'INVITATION');
    const latest = (await this.outbound(contactId)).at(-1);
    if (latest?.controls.some((control) => control.label === 'Switch survey')) await this.tap(contactId, 'Switch survey', (_text, message) => message.id === latest.id);
    const offer = (await this.outbound(contactId)).at(-1);
    if (offer && offer.kind === 'PROFILE_OFFER' && offer.controls.length > 0 && profile === 'skip') await this.tap(contactId, 'Skip', (_text, message) => message.id === offer.id);
  }

  /** Without an explicit scope only the last three outbound messages are searched, so stale controls are never tapped by accident. */
  async tap(contactId: string, label: string, within?: (text: string, message: ConversationMessage) => boolean): Promise<void> {
    const outbound = await this.outbound(contactId);
    const candidates = within ? outbound.reverse() : outbound.slice(-3).reverse();
    const matches = (control: { label: string }) => control.label === label || control.label.startsWith(`${label} `);
    const message = candidates.find((candidate) => (within ? within(candidate.text, candidate) : true) && candidate.controls.some(matches));
    if (!message) throw new Error(`Seed script: no control "${label}" for contact ${contactId}`);
    const control = message.controls.find(matches);
    if (!control) throw new Error(`Seed script: control "${label}" vanished`);
    await this.simulator.tap(this.ctx, { contactId, messageId: message.id, controlId: control.id });
    await this.drain();
  }

  async multi(contactId: string, labels: string[]): Promise<void> {
    const message = (await this.outbound(contactId)).reverse().find((candidate) => candidate.flow?.purpose === 'MULTI_CHOICE');
    if (!message?.flow) throw new Error(`Seed script: no multi-choice flow for contact ${contactId}`);
    const ids = labels.map((label) => message.flow?.options.find((option) => option.label === label)?.id).filter((id): id is string => Boolean(id));
    await this.simulator.submitFlow(this.ctx, { contactId, messageId: message.id, flowToken: message.flow.token, selectedOptionIds: ids });
    await this.drain();
  }

  async text(contactId: string, text: string): Promise<void> {
    await this.simulator.sendText(this.ctx, { contactId, text });
    await this.drain();
  }
}
