import { DeliveryService, JobRunner, LaunchService, MESSAGING_PROVIDER, TenantDbFactory, createTenantDb, type ProviderAdapter } from '@raaye/server';
import request from 'supertest';
import { drainJobs, sweepOnly } from '../testing/jobs';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

const FIVE_TYPES = [
  { authoringType: 'YES_NO', prompt: { en: 'Do you use public transport?' } },
  { authoringType: 'YES_NO_INDIFFERENT', prompt: { en: 'Should bus fares be subsidised?' } },
  { authoringType: 'SINGLE_CHOICE', prompt: { en: 'Which service matters most?' }, options: [{ label: { en: 'Water' } }, { label: { en: 'Roads' } }, { label: { en: 'Electricity' } }, { label: { en: 'Schools' } }] },
  { authoringType: 'MULTI_CHOICE', prompt: { en: 'Which have you used this year?' }, options: [{ label: { en: 'Legal aid' } }, { label: { en: 'Workshops' } }, { label: { en: 'None of the above' }, exclusive: true }], minSelections: 1, maxSelections: 2 },
  { authoringType: 'RATING', prompt: { en: 'Rate the service.' }, ratingMinLabel: { en: 'Very poor' }, ratingMaxLabel: { en: 'Excellent' } },
];

describe('survey authoring, audience, launch and lifecycle (R20-R30, R43-R45, R55)', () => {
  let t: TestApp;
  let orgId: string;
  let admin: SeededUser;
  let manager: SeededUser;
  let viewer: SeededUser;
  const contacts: Record<string, string> = {};

  async function createContact(name: string, phone: string, consent: 'GRANTED' | 'WITHDRAWN' | 'UNKNOWN' | 'ARCHIVED'): Promise<string> {
    const created = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name, phone, city: 'Lahore' }).expect(201)).body;
    if (consent === 'GRANTED' || consent === 'WITHDRAWN' || consent === 'ARCHIVED') {
      await request(t.server).post(`/api/v1/contacts/${created.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    }
    if (consent === 'WITHDRAWN') {
      await request(t.server).post(`/api/v1/contacts/${created.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-09-02T00:00:00Z', evidenceReference: 'Call' }).expect(201);
    }
    if (consent === 'ARCHIVED') await request(t.server).post(`/api/v1/contacts/${created.id}/archive`).set('Authorization', manager.authorization).expect(201);
    contacts[name] = created.id;
    return created.id;
  }

  async function createSurvey(title: string, extra: Record<string, unknown> = {}, as: SeededUser = manager): Promise<string> {
    const created = (await request(t.server).post('/api/v1/surveys').set('Authorization', as.authorization).send({ internalTitle: title, title: { en: title }, introduction: { en: 'Thanks for taking part.' }, questions: FIVE_TYPES, audience: { mode: 'EVERYONE' }, ...extra }).expect(201)).body;
    return created.id;
  }

  /** Admin toggles the organization's sender through the real Settings route. */
  async function setConnectionEnabled(enabled: boolean): Promise<{ ok: boolean; blockers: { code: string }[]; connection: { enabled: boolean } | null }> {
    return (await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ enabled }).expect(200)).body;
  }

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    viewer = await seedUser(t.prisma, orgId, 'VIEWER');
    for (const [index, name] of ['Ayesha', 'Bilal', 'Chaudhry', 'Dua', 'Ehsan'].entries()) await createContact(name, `+92300100000${index}`, 'GRANTED');
    await createContact('Unknown Umar', '+923001000010', 'UNKNOWN');
    await createContact('Withdrawn Wasim', '+923001000011', 'WITHDRAWN');
    await createContact('Archived Asma', '+923001000012', 'ARCHIVED');
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates a survey with all five question types and previews every message (R20)', async () => {
    const id = await createSurvey('Transport survey');
    const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(detail.state).toBe('DRAFT');
    expect(detail.revision.questions.map((question: { authoringType: string; renderer: string }) => [question.authoringType, question.renderer])).toEqual([
      ['YES_NO', 'BUTTONS'],
      ['YES_NO_INDIFFERENT', 'BUTTONS'],
      ['SINGLE_CHOICE', 'LIST'],
      ['MULTI_CHOICE', 'FLOW_MULTI'],
      ['RATING', 'LIST'],
    ]);
    expect(detail.revision.questions[1].options.map((option: { code: string }) => option.code)).toEqual(['YES', 'NO', 'INDIFFERENT']);
    expect(detail.revision.editWindowSeconds).toBe(120);
    expect(detail.revision.durationSeconds).toBe(172800);
    expect(detail.contentErrors).toEqual([]);
    const preview = (await request(t.server).post(`/api/v1/surveys/${id}/preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(preview.map((message: { kind: string }) => message.kind)).toEqual(['INVITATION', 'INTRODUCTION', 'PROFILE_OFFER', 'QUESTION', 'QUESTION', 'QUESTION', 'QUESTION', 'QUESTION', 'COMPLETION']);
    expect(preview[3].controls.map((control: { label: string }) => control.label)).toEqual(['Yes', 'No']);
    expect(preview[6].flow.purpose).toBe('MULTI_CHOICE');
    expect(preview[7].controls).toHaveLength(5);
    await request(t.server).post('/api/v1/surveys').set('Authorization', viewer.authorization).send({ internalTitle: 'Nope' }).expect(403);
  });

  it('Viewers never see draft surveys, in the list or by id (R06)', async () => {
    const draftId = await createSurvey('Viewer-hidden draft');
    const archivedDraftId = await createSurvey('Viewer-hidden archived draft');
    await request(t.server).post(`/api/v1/surveys/${archivedDraftId}/archive`).set('Authorization', manager.authorization).expect(200);
    const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
    const managerList = (await request(t.server).get('/api/v1/surveys?limit=100').set('Authorization', manager.authorization).expect(200)).body;
    expect(ids(managerList)).toContain(draftId);
    const viewerList = (await request(t.server).get('/api/v1/surveys?limit=100').set('Authorization', viewer.authorization).expect(200)).body;
    expect(ids(viewerList)).not.toContain(draftId);
    expect(viewerList.items.some((item: { state: string }) => item.state === 'DRAFT')).toBe(false);
    expect(viewerList.total).toBe(managerList.items.filter((item: { state: string }) => item.state !== 'DRAFT').length);
    expect((await request(t.server).get('/api/v1/surveys?state=DRAFT&limit=100').set('Authorization', viewer.authorization).expect(200)).body).toMatchObject({ total: 0, items: [] });
    expect(ids((await request(t.server).get('/api/v1/surveys?archived=true&limit=100').set('Authorization', viewer.authorization).expect(200)).body)).not.toContain(archivedDraftId);
    expect(ids((await request(t.server).get('/api/v1/surveys?archived=true&limit=100').set('Authorization', manager.authorization).expect(200)).body)).toContain(archivedDraftId);
    const hidden = await request(t.server).get(`/api/v1/surveys/${draftId}`).set('Authorization', viewer.authorization).expect(404);
    expect(hidden.body.code).toBe('TENANT_RESOURCE_NOT_FOUND');
    await request(t.server).post(`/api/v1/surveys/${draftId}/preview`).set('Authorization', viewer.authorization).expect(404);
    await request(t.server).get(`/api/v1/surveys/${draftId}/results`).set('Authorization', viewer.authorization).expect(404);
    await request(t.server).get(`/api/v1/surveys/${draftId}/breakdowns?dimension=city`).set('Authorization', viewer.authorization).expect(404);
    expect((await request(t.server).get(`/api/v1/surveys/${draftId}/results`).set('Authorization', manager.authorization).expect(200)).body.runId).toBeNull();
    await request(t.server).get(`/api/v1/surveys/${draftId}`).set('Authorization', manager.authorization).expect(200);
    await request(t.server).get(`/api/v1/surveys/${draftId}`).set('Authorization', admin.authorization).expect(200);
    await request(t.server).post(`/api/v1/surveys/${draftId}/preview`).set('Authorization', admin.authorization).expect(200);
    // The overview applies the same rule: no draft in the recent list or the counts.
    const viewerOverview = (await request(t.server).get('/api/v1/overview').set('Authorization', viewer.authorization).expect(200)).body;
    expect(viewerOverview.recent.some((item: { id: string; state: string }) => item.id === draftId || item.state === 'DRAFT')).toBe(false);
    expect(viewerOverview.surveys.draft).toBe(0);
    const managerOverview = (await request(t.server).get('/api/v1/overview').set('Authorization', manager.authorization).expect(200)).body;
    expect(managerOverview.recent.some((item: { id: string }) => item.id === draftId)).toBe(true);
    const archivedDrafts = await t.prisma.survey.count({ where: { organizationId: orgId, archivedAt: { not: null }, state: 'DRAFT' } });
    expect(viewerOverview.surveys.archived).toBe(managerOverview.surveys.archived - archivedDrafts);
    // A draft's test run whose dispatch is blocked is listed for the Survey Manager but never for the Viewer.
    await request(t.server).post(`/api/v1/surveys/${draftId}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts['Ayesha']] }).expect(201);
    await setConnectionEnabled(false);
    await drainJobs(t);
    const blockedIds = (page: { attention: { blockedRuns: { surveyId: string }[] } }) => page.attention.blockedRuns.map((run) => run.surveyId);
    expect(blockedIds((await request(t.server).get('/api/v1/overview').set('Authorization', manager.authorization).expect(200)).body)).toContain(draftId);
    expect(blockedIds((await request(t.server).get('/api/v1/overview').set('Authorization', viewer.authorization).expect(200)).body)).not.toContain(draftId);
    await request(t.server).post(`/api/v1/surveys/${draftId}/archive`).set('Authorization', manager.authorization).expect(200);
    await setConnectionEnabled(true);
  });

  it('enforces authoring limits and Admin-only timing (R20, matrix)', async () => {
    const id = await createSurvey('Timing survey');
    const forbidden = await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ editWindowSeconds: 300 }).expect(403);
    expect(forbidden.body.code).toBe('ROLE_FORBIDDEN');
    await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ editWindowSeconds: 120 }).expect(200);
    const updated = (await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).send({ editWindowSeconds: 300, durationSeconds: 7200 }).expect(200)).body;
    expect(updated.revision).toMatchObject({ editWindowSeconds: 300, durationSeconds: 7200 });
    const tooMany = await request(t.server)
      .patch(`/api/v1/surveys/${id}`)
      .set('Authorization', admin.authorization)
      .send({ questions: [{ authoringType: 'SINGLE_CHOICE', prompt: { en: 'Q' }, options: Array.from({ length: 11 }, (_, i) => ({ label: { en: `Option ${i}` } })) }] })
      .expect(400);
    expect(tooMany.body.code).toBe('VALIDATION_FAILED');
    const duplicateLabels = (await request(t.server)
      .patch(`/api/v1/surveys/${id}`)
      .set('Authorization', admin.authorization)
      .send({ questions: [{ authoringType: 'SINGLE_CHOICE', prompt: { en: 'Q' }, options: [{ label: { en: 'Same' } }, { label: { en: 'same' } }] }] })
      .expect(200)).body;
    expect(duplicateLabels.contentErrors.map((error: { code: string }) => error.code)).toContain('OPTION_LABEL_DUPLICATE');
    const launch = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', admin.authorization).send({ mode: 'NOW' }).expect(422);
    expect(launch.body.code).toBe('SURVEY_CONTENT_INVALID');
  });

  it('resolves every audience mode into deduplicated eligible recipients (R23)', async () => {
    const group = (await request(t.server).post('/api/v1/groups').set('Authorization', manager.authorization).send({ name: 'Members' }).expect(201)).body;
    const tag = (await request(t.server).post('/api/v1/tags').set('Authorization', manager.authorization).send({ name: 'pilot' }).expect(201)).body;
    await request(t.server).post(`/api/v1/groups/${group.id}/contacts/${contacts['Ayesha']}`).set('Authorization', manager.authorization).expect(204);
    await request(t.server).post(`/api/v1/groups/${group.id}/contacts/${contacts['Bilal']}`).set('Authorization', manager.authorization).expect(204);
    await request(t.server).post(`/api/v1/tags/${tag.id}/contacts/${contacts['Bilal']}`).set('Authorization', manager.authorization).expect(204);
    await request(t.server).post(`/api/v1/tags/${tag.id}/contacts/${contacts['Unknown Umar']}`).set('Authorization', manager.authorization).expect(204);
    const everyone = await createSurvey('Everyone');
    const preview = (await request(t.server).post(`/api/v1/surveys/${everyone}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(preview).toMatchObject({ mode: 'EVERYONE', selected: 7, eligible: 5, exclusions: { CONTACT_CONSENT_MISSING: 1, CONTACT_WITHDRAWN: 1 } });
    const groupsTags = await createSurvey('Groups', { audience: { mode: 'GROUPS_TAGS', groupIds: [group.id], tagIds: [tag.id], groupTagMatch: 'ANY' } });
    const anyPreview = (await request(t.server).post(`/api/v1/surveys/${groupsTags}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(anyPreview).toMatchObject({ selected: 3, eligible: 2 });
    await request(t.server).patch(`/api/v1/surveys/${groupsTags}`).set('Authorization', manager.authorization).send({ audience: { mode: 'GROUPS_TAGS', groupIds: [group.id], tagIds: [tag.id], groupTagMatch: 'ALL' } }).expect(200);
    const allPreview = (await request(t.server).post(`/api/v1/surveys/${groupsTags}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(allPreview).toMatchObject({ selected: 1, eligible: 1 });
    const filtered = await createSurvey('Filtered', { audience: { mode: 'FILTERED', filters: { city: ['lahore'], gender: [] }, exclude: { contactIds: [contacts['Ayesha']] } } });
    const filteredPreview = (await request(t.server).post(`/api/v1/surveys/${filtered}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(filteredPreview).toMatchObject({ selected: 7, eligible: 4, exclusions: { EXPLICITLY_EXCLUDED: 1 } });
    // An occupation filter (an OR of occupations) combined with an ANY group/tag match (another OR)
    // must narrow the audience to contacts that satisfy both.
    await request(t.server).patch(`/api/v1/contacts/${contacts['Ayesha']}`).set('Authorization', manager.authorization).send({ occupation: 'Lawyer' }).expect(200);
    await request(t.server).patch(`/api/v1/contacts/${contacts['Bilal']}`).set('Authorization', manager.authorization).send({ occupation: 'Teacher' }).expect(200);
    const combined = await createSurvey('Filtered with groups', { audience: { mode: 'FILTERED', filters: { occupation: ['lawyer', 'Nurse'] }, groupIds: [group.id], tagIds: [tag.id], groupTagMatch: 'ANY' } });
    const combinedPreview = (await request(t.server).post(`/api/v1/surveys/${combined}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(combinedPreview).toMatchObject({ selected: 1, eligible: 1 });
    expect(combinedPreview.sample.map((item: { contactId: string }) => item.contactId)).toEqual([contacts['Ayesha']]);
    const selected = await createSurvey('Selected', { audience: { mode: 'SELECTED', contactIds: [contacts['Ayesha'], contacts['Ayesha'], contacts['Archived Asma']] } });
    const selectedPreview = (await request(t.server).post(`/api/v1/surveys/${selected}/audience-preview`).set('Authorization', manager.authorization).expect(200)).body;
    expect(selectedPreview).toMatchObject({ selected: 2, eligible: 1, exclusions: { CONTACT_ARCHIVED: 1 } });
  });

  it('launches now idempotently, freezes the audience and dispatches invitations through the worker (R24, R28, R15)', async () => {
    const id = await createSurvey('Launch now');
    const first = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'launch-key-1').send({ mode: 'NOW' }).expect(200)).body;
    expect(first.state).toBe('ACTIVE');
    expect(first.liveRun).toMatchObject({ kind: 'LIVE', state: 'ACTIVE', audienceSummary: { selected: 7, eligible: 5 } });
    expect(first.revision.frozenAt).not.toBeNull();
    const repeat = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'launch-key-1').send({ mode: 'NOW' }).expect(200)).body;
    expect(repeat.liveRun.id).toBe(first.liveRun.id);
    const conflict = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'launch-key-1').send({ mode: 'SCHEDULED', opensAt: '2026-10-11T09:00:00Z' }).expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const again = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(409);
    expect(again.body.code).toBe('SURVEY_STATE_INVALID');
    expect(await t.prisma.surveyRun.count({ where: { surveyId: id, kind: 'LIVE' } })).toBe(1);
    expect(await t.prisma.surveyRecipient.count({ where: { runId: first.liveRun.id } })).toBe(7);
    expect(await t.prisma.invitation.count({ where: { runId: first.liveRun.id } })).toBe(5);
    // Questions are immutable after launch (R29).
    const edit = await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).send({ internalTitle: 'Changed' }).expect(409);
    expect(edit.body.code).toBe('SURVEY_STATE_INVALID');
    // A contact added after launch is not appended (R24).
    await createContact('Late Laila', '+923001000020', 'GRANTED');
    await drainJobs(t);
    expect(await t.prisma.surveyRecipient.count({ where: { runId: first.liveRun.id } })).toBe(7);
    const messages = await t.prisma.message.findMany({ where: { runId: first.liveRun.id } });
    expect(messages).toHaveLength(5);
    expect(messages.every((message) => message.kind === 'INVITATION' && message.state === 'ACCEPTED' && message.deliveryState === 'DELIVERED')).toBe(true);
    expect(messages.every((message) => message.providerMessageId?.startsWith('wamid.mock.'))).toBe(true);
    const withdrawnMessages = await t.prisma.message.count({ where: { contactId: contacts['Withdrawn Wasim'] } });
    expect(withdrawnMessages).toBe(0);
    const invitations = await t.prisma.invitation.findMany({ where: { runId: first.liveRun.id } });
    expect(invitations.every((invitation) => invitation.state === 'ACCEPTED')).toBe(true);
    // Template sends do not open the service window (R45).
    const conversation = await t.prisma.conversation.findFirst({ where: { contactId: contacts['Ayesha'] } });
    expect(conversation?.lastInboundAt).toBeNull();
  });

  it('withdrawal between queueing and sending suppresses the queued invitation (R15)', async () => {
    const stopper = await createContact('Stopper Sana', '+923001000030', 'GRANTED');
    const id = await createSurvey('Stop before send', { audience: { mode: 'SELECTED', contactIds: [stopper] } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    const runner = t.app.get(JobRunner);
    // Only the activation job runs: the invitation message is now PENDING.
    await runner.runOnce(1, 1);
    const pending = await t.prisma.message.findFirst({ where: { runId: launched.liveRun.id } });
    expect(pending?.state).toBe('PENDING');
    await request(t.server).post(`/api/v1/contacts/${stopper}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-10T09:00:30Z', evidenceReference: 'Phone' }).expect(201);
    await drainJobs(t);
    const after = await t.prisma.message.findFirst({ where: { runId: launched.liveRun.id } });
    expect(['CANCELED', 'SUPPRESSED']).toContain(after?.state);
    expect(after?.providerMessageId).toBeNull();
    expect(await t.prisma.messageAttempt.count({ where: { messageId: after?.id ?? '' } })).toBe(0);
  });

  it('a STOP that commits after the policy snapshot is never overtaken by the send (R15)', async () => {
    const racer = await createContact('Racing Rida', '+923001000031', 'GRANTED');
    const id = await createSurvey('Stop during send', { audience: { mode: 'SELECTED', contactIds: [racer] } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await t.app.get(JobRunner).runOnce(1, 1);
    const pending = await t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id } });
    expect(pending.state).toBe('PENDING');
    const tenantDb = createTenantDb(t.prisma, orgId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An uncommitted STOP holds the contact lock, cancels the queued message and withdraws consent.
    const stop = tenantDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${racer}::uuid FOR UPDATE`;
        await tx.message.updateMany({ where: { id: pending.id }, data: { state: 'CANCELED', deliveryState: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' } });
        await tx.contact.update({ where: { id: racer }, data: { consentInvitations: 'WITHDRAWN' } });
        await gate;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The worker starts sending while the STOP is still uncommitted; it must wait for the decision.
    const sending = t.app.get(DeliveryService).send(orgId, pending.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await stop;
    expect(await sending).toBe('SKIPPED');
    const after = await t.prisma.message.findUniqueOrThrow({ where: { id: pending.id }, include: { attempts: true } });
    expect(after.state).toBe('CANCELED');
    expect(after.attempts).toHaveLength(0);
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a STOP between the claim and the hand-off is honoured, and one arriving during the hand-off waits for it (R15)', async () => {
    const first = await createContact('Handoff Hina', '+923001000032', 'GRANTED');
    const second = await createContact('Handoff Hadi', '+923001000033', 'GRANTED');
    const id = await createSurvey('Stop during hand-off', { audience: { mode: 'SELECTED', contactIds: [first, second] } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await t.app.get(JobRunner).runOnce(1, 1);
    const messages = await t.prisma.message.findMany({ where: { runId: launched.liveRun.id } });
    const firstMessage = messages.find((message) => message.contactId === first);
    const secondMessage = messages.find((message) => message.contactId === second);
    if (!firstMessage || !secondMessage) throw new Error('expected one pending invitation per contact');
    const delivery = t.app.get(DeliveryService);
    const provider = t.app.get<ProviderAdapter>(MESSAGING_PROVIDER);
    const sendSpy = jest.spyOn(provider, 'send');
    const withdraw = (contactId: string) =>
      request(t.server).post(`/api/v1/contacts/${contactId}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-10T09:00:30Z', evidenceReference: 'Phone' }).expect(201);
    // 1. The STOP commits after the claim but before the hand-off: the re-check under the lock suppresses the message.
    const factory = t.app.get(TenantDbFactory);
    const realDb = factory.forOrganization(orgId);
    let transactions = 0;
    const forOrganization = jest.spyOn(factory, 'forOrganization').mockImplementation(
      () =>
        new Proxy(realDb, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (property !== '$transaction') return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              transactions += 1;
              if (transactions === 2) await withdraw(first);
              return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
            };
          },
        }),
    );
    try {
      expect(await delivery.send(orgId, firstMessage.id)).toBe('SUPPRESSED');
    } finally {
      forOrganization.mockRestore();
    }
    expect(sendSpy).not.toHaveBeenCalled();
    const suppressed = await t.prisma.message.findUniqueOrThrow({ where: { id: firstMessage.id }, include: { attempts: true } });
    expect(suppressed).toMatchObject({ state: 'SUPPRESSED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect(suppressed.attempts.map((attempt) => [attempt.outcome, attempt.errorCode])).toEqual([['FAILED', 'CONTACT_WITHDRAWN']]);
    // 2. A STOP arriving while the hand-off holds the lock waits for the provider's answer instead of racing it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendSpy.mockImplementationOnce(async (req) => {
      await gate;
      return { outcome: 'ACCEPTED', providerMessageId: `wamid.gate.${req.messageId}` };
    });
    const sending = delivery.send(orgId, secondMessage.id);
    for (let i = 0; i < 100 && sendSpy.mock.calls.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    let withdrawn = false;
    const stopping = withdraw(second).then(() => {
      withdrawn = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(withdrawn).toBe(false);
    release();
    expect(await sending).toBe('ACCEPTED');
    await stopping;
    expect(withdrawn).toBe(true);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: secondMessage.id } })).state).toBe('ACCEPTED');
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: second } })).consentInvitations).toBe('WITHDRAWN');
    sendSpy.mockRestore();
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a survey that closes while the worker waits for the contact lock is not sent (R27, R45)', async () => {
    const waiter = await createContact('Deadline Dawood', '+923001000034', 'GRANTED');
    const id = await createSurvey('Closes during hand-off', { audience: { mode: 'SELECTED', contactIds: [waiter] } });
    await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).send({ durationSeconds: 3600 }).expect(200);
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await t.app.get(JobRunner).runOnce(1, 1);
    const pending = await t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id } });
    expect(pending.state).toBe('PENDING');
    const provider = t.app.get<ProviderAdapter>(MESSAGING_PROVIDER);
    const sendSpy = jest.spyOn(provider, 'send');
    // Hold the contact lock while the clock passes the closing time, then let the worker in.
    const tenantDb = createTenantDb(t.prisma, orgId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = tenantDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${waiter}::uuid FOR UPDATE`;
        await gate;
      },
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sending = t.app.get(DeliveryService).send(orgId, pending.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    t.clock.set(new Date('2026-10-10T10:00:01.000Z'));
    release();
    await holding;
    expect(await sending).toBe('SUPPRESSED');
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
    const after = await t.prisma.message.findUniqueOrThrow({ where: { id: pending.id }, include: { attempts: true } });
    expect(after).toMatchObject({ state: 'SUPPRESSED', suppressionReason: 'SURVEY_CLOSED' });
    expect(after.attempts.map((attempt) => [attempt.outcome, attempt.errorCode])).toEqual([['FAILED', 'SURVEY_CLOSED']]);
    t.clock.set(new Date('2026-10-10T09:00:00.000Z'));
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
    // Keep the organization-wide audience of later tests unchanged.
    await request(t.server).post(`/api/v1/contacts/${waiter}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-10T09:00:30Z', evidenceReference: 'Phone' }).expect(201);
  });

  it('draft edits and launch of the same survey serialize: a launched survey freezes exactly what was validated (R29)', async () => {
    for (let round = 0; round < 4; round += 1) {
      const id = await createSurvey(`Edit race ${round}`, { audience: { mode: 'SELECTED', contactIds: [contacts['Ehsan']] } });
      const [edited, launched] = await Promise.all([
        request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ questions: FIVE_TYPES.slice(0, 2) }),
        request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }),
      ]);
      expect([200, 409]).toContain(edited.status);
      expect([200, 409]).toContain(launched.status);
      const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).expect(200)).body;
      if (detail.state === 'ACTIVE') {
        const run = await t.prisma.surveyRun.findFirstOrThrow({ where: { surveyId: id, kind: 'LIVE' } });
        const frozen = await t.prisma.surveyRevision.findUniqueOrThrow({ where: { id: run.revisionId } });
        expect(frozen.frozenAt).not.toBeNull();
        expect(frozen.revisionNumber).toBe(detail.revision.revisionNumber);
        expect(await t.prisma.surveyRevision.count({ where: { surveyId: id } })).toBe(1);
        // An edit that succeeded committed before the launch validated the survey, so the frozen content includes it.
        expect(await t.prisma.question.count({ where: { revisionId: run.revisionId } })).toBe(edited.status === 200 ? 2 : 5);
        await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
      } else {
        expect(detail.state).toBe('DRAFT');
        expect(launched.status).toBe(409);
        expect(detail.revision.questions).toHaveLength(2);
      }
    }
  });

  /** Hold the survey row from another transaction until `release` is called, as a launch, an edit or an archive would. */
  async function holdSurvey(surveyId: string): Promise<{ release: () => void; held: Promise<void> }> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM surveys WHERE id = ${surveyId}::uuid FOR UPDATE`;
        await released;
      },
      { timeout: 20_000 },
    );
    for (let i = 0; i < 300; i += 1) {
      const free = await t.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM surveys WHERE id = ${surveyId}::uuid FOR UPDATE SKIP LOCKED`;
      if (free.length === 0) break;
      await sleep(10);
    }
    return { release, held };
  }

  /** Wait until `count` backends of this database are waiting on a lock. */
  async function untilLockWaiters(count: number): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      const [row] = await t.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('concurrent launch retries with the same idempotency key both receive the launch (R24)', async () => {
    const id = await createSurvey('Double click', { audience: { mode: 'SELECTED', contactIds: [contacts['Ayesha']] } });
    // Both requests pass the key lookup and their validation while the row is held, then queue on it: the second
    // finds the survey launched by its twin.
    const { release, held } = await holdSurvey(id);
    const launch = () => request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'double-click').send({ mode: 'NOW' }).then((response) => response);
    const first = launch();
    await untilLockWaiters(1);
    const second = launch();
    await untilLockWaiters(2);
    release();
    await held;
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[1].body.liveRun.id).toBe(responses[0].body.liveRun.id);
    expect(responses[1].body.state).toBe('ACTIVE');
    expect(await t.prisma.surveyRun.count({ where: { surveyId: id, kind: 'LIVE' } })).toBe(1);
    expect(await t.prisma.idempotencyKey.count({ where: { organizationId: orgId, scope: `launch:${id}`, key: 'double-click' } })).toBe(1);
    // The same key with a different request, another key and no key keep their own answers.
    const conflict = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'double-click').send({ mode: 'SCHEDULED', opensAt: '2026-10-11T09:00:00Z' }).expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const other = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).set('Idempotency-Key', 'another-key').send({ mode: 'NOW' }).expect(409);
    expect(other.body.code).toBe('SURVEY_STATE_INVALID');
    const bare = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(409);
    expect(bare.body.code).toBe('SURVEY_STATE_INVALID');
    await drainJobs(t);
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a draft edit and a test send of the same survey serialize: the test run never mixes two revisions (R29, R30)', async () => {
    const id = await createSurvey('Edit versus test');
    const edit = (questions: typeof FIVE_TYPES) => request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ questions }).then((response) => response);
    const sendTest = () => request(t.server).post(`/api/v1/surveys/${id}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts['Ayesha']] }).then((response) => response);
    const detail = async () => (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).expect(200)).body;
    // The edit reaches the row first: the test send validated the content before the edit and is refused.
    let hold = await holdSurvey(id);
    const editFirst = edit(FIVE_TYPES.slice(0, 2));
    await untilLockWaiters(1);
    const testSecond = sendTest();
    await untilLockWaiters(2);
    hold.release();
    await hold.held;
    expect((await editFirst).status).toBe(200);
    const refused = await testSecond;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SURVEY_STATE_INVALID');
    expect(await t.prisma.surveyRun.count({ where: { surveyId: id, kind: 'TEST' } })).toBe(0);
    let current = await detail();
    expect(current.revision.revisionNumber).toBe(1);
    expect(current.revision.questions).toHaveLength(2);
    // The test send reaches the row first: the run keeps the content it validated and the edit moves to a new revision.
    hold = await holdSurvey(id);
    const testFirst = sendTest();
    await untilLockWaiters(1);
    const editSecond = edit(FIVE_TYPES);
    await untilLockWaiters(2);
    hold.release();
    await hold.held;
    expect((await testFirst).status).toBe(201);
    expect((await editSecond).status).toBe(200);
    const run = await t.prisma.surveyRun.findFirstOrThrow({ where: { surveyId: id, kind: 'TEST' } });
    expect(await t.prisma.question.count({ where: { revisionId: run.revisionId } })).toBe(2);
    current = await detail();
    expect(current.revision.revisionNumber).toBe(2);
    expect(current.revision.questions).toHaveLength(5);
    expect(run.revisionId).not.toBe(current.revision.id);
    // The test invitation renders what the test run validated.
    await drainJobs(t);
    const invitation = await t.prisma.message.findFirstOrThrow({ where: { runId: run.id, kind: 'INVITATION' } });
    expect(invitation.state).toBe('ACCEPTED');
    expect((invitation.rendered as { previewText?: string }).previewText ?? '').toContain('[TEST]');
  });

  it('archiving cancels an active test run and its queued test sends (R30, R55)', async () => {
    await drainJobs(t);
    const id = await createSurvey('Archived with test run', { audience: { mode: 'SELECTED', contactIds: [contacts['Ehsan']] } });
    const withTest = (await request(t.server).post(`/api/v1/surveys/${id}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts['Ayesha']] })).body;
    const testRun = withTest.testRuns[0];
    expect(testRun.state).toBe('ACTIVE');
    // Only the activation runs: the test invitation is queued, its send job still pending.
    await t.app.get(JobRunner).runOnce(1, 1);
    expect(await t.prisma.message.count({ where: { runId: testRun.id, state: 'PENDING' } })).toBe(1);
    const archived = (await request(t.server).post(`/api/v1/surveys/${id}/archive`).set('Authorization', manager.authorization).expect(200)).body;
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.testRuns[0].state).toBe('CANCELED');
    await drainJobs(t);
    expect((await t.prisma.message.findMany({ where: { runId: testRun.id } })).map((message) => message.state)).toEqual(['CANCELED']);
    expect(await t.prisma.job.count({ where: { entityId: testRun.id, status: 'PENDING' } })).toBe(0);
  });

  it('archive and test-run creation of the same draft serialize: an archived survey never sends test invitations (R30, R55)', async () => {
    for (let round = 0; round < 4; round += 1) {
      const id = await createSurvey(`Test race ${round}`, { audience: { mode: 'SELECTED', contactIds: [contacts['Ehsan']] } });
      const [archived, tested] = await Promise.all([
        request(t.server).post(`/api/v1/surveys/${id}/archive`).set('Authorization', manager.authorization),
        request(t.server).post(`/api/v1/surveys/${id}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts['Ayesha']] }),
      ]);
      expect(archived.status).toBe(200);
      expect([201, 409]).toContain(tested.status);
      await drainJobs(t);
      const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).expect(200)).body;
      expect(detail.archivedAt).not.toBeNull();
      expect(detail.testRuns.map((run: { state: string }) => run.state)).toEqual(tested.status === 201 ? ['CANCELED'] : []);
      expect(await t.prisma.message.count({ where: { run: { surveyId: id }, state: { in: ['PENDING', 'SENDING', 'ACCEPTED'] } } })).toBe(0);
    }
  });

  it('archive and launch of the same draft serialize: an archived survey never has live outreach (R55)', async () => {
    for (let round = 0; round < 4; round += 1) {
      const id = await createSurvey(`Race survey ${round}`, { audience: { mode: 'SELECTED', contactIds: [contacts['Ehsan']] } });
      const [archived, launched] = await Promise.all([
        request(t.server).post(`/api/v1/surveys/${id}/archive`).set('Authorization', manager.authorization),
        request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }),
      ]);
      expect([200, 409]).toContain(archived.status);
      expect([200, 409]).toContain(launched.status);
      const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).expect(200)).body;
      await drainJobs(t);
      if (detail.archivedAt) {
        expect(detail.state).not.toBe('ACTIVE');
        expect(detail.liveRun).toBeNull();
        expect(await t.prisma.message.count({ where: { contactId: contacts['Ehsan'], run: { surveyId: id } } })).toBe(0);
      } else {
        expect(detail.state).toBe('ACTIVE');
        expect(detail.liveRun.state).toBe('ACTIVE');
        await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
      }
    }
  });

  it('schedules with a 48-hour default, survives restart via durable jobs, unschedules, activates and closes on time (R25, R26, R27, R29)', async () => {
    const id = await createSurvey('Scheduled survey');
    const opensAt = '2026-10-11T04:00:00.000Z'; // 09:00 Asia/Karachi
    const scheduled = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'SCHEDULED', opensAt }).expect(200)).body;
    expect(scheduled.state).toBe('SCHEDULED');
    expect(scheduled.liveRun).toMatchObject({ state: 'SCHEDULED', opensAt, closesAt: '2026-10-13T04:00:00.000Z' });
    const jobs = await t.prisma.job.findMany({ where: { entityId: scheduled.liveRun.id } });
    expect(jobs.map((job) => [job.kind, job.dueAt.toISOString()]).sort()).toEqual([
      ['ACTIVATE_SURVEY', opensAt],
      ['CLOSE_SURVEY', '2026-10-13T04:00:00.000Z'],
    ]);
    // Nothing is sent before the opening time even when the worker runs.
    await drainJobs(t);
    expect(await t.prisma.message.count({ where: { runId: scheduled.liveRun.id } })).toBe(0);
    // Unschedule before outreach: back to draft, jobs canceled.
    const unscheduled = (await request(t.server).post(`/api/v1/surveys/${id}/unschedule`).set('Authorization', manager.authorization).expect(200)).body;
    expect(unscheduled.state).toBe('DRAFT');
    expect(unscheduled.liveRun).toBeNull();
    const canceled = await t.prisma.job.findMany({ where: { entityId: scheduled.liveRun.id } });
    expect(canceled.every((job) => job.status === 'CANCELED')).toBe(true);
    // Editing after unschedule creates a new revision; the frozen one is retained.
    const edited = (await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ internalTitle: 'Scheduled survey v2' }).expect(200)).body;
    expect(edited.revision.revisionNumber).toBe(2);
    expect(await t.prisma.surveyRevision.count({ where: { surveyId: id } })).toBe(2);
    // Admin explicit closing time override is respected (R26).
    await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).send({ explicitClosesAt: '2026-10-11T10:00:00Z' }).expect(200);
    const rescheduled = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'SCHEDULED', opensAt }).expect(200)).body;
    expect(rescheduled.liveRun).toMatchObject({ state: 'SCHEDULED', closesAt: '2026-10-11T10:00:00.000Z' });
    // Advance the clock past the opening time: sweep + jobs activate and dispatch (restart safe: everything is in PostgreSQL).
    t.clock.set(new Date('2026-10-11T04:05:00.000Z'));
    await drainJobs(t);
    const active = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(active.state).toBe('ACTIVE');
    expect(active.liveRun.activatedAt).toBe('2026-10-11T04:05:00.000Z');
    expect(await t.prisma.message.count({ where: { runId: rescheduled.liveRun.id, state: 'ACCEPTED' } })).toBe(6);
    // Closing happens at the configured instant even though the worker runs late (R27).
    t.clock.set(new Date('2026-10-11T10:30:00.000Z'));
    await drainJobs(t);
    const closed = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(closed.state).toBe('CLOSED');
    expect(closed.liveRun.closeReason).toBe('SCHEDULED_CLOSE');
    t.clock.set(new Date('2026-10-10T09:00:00.000Z'));
  });

  it('a run whose worker resumes after closing closes without sending stale invitations (R27)', async () => {
    const id = await createSurvey('Stale survey');
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'SCHEDULED', opensAt: '2026-10-12T04:00:00Z' }).expect(200)).body;
    t.clock.set(new Date('2026-10-15T00:00:00.000Z'));
    await drainJobs(t);
    const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(detail.state).toBe('CLOSED');
    // Activation and the scheduled close may run concurrently; either path closes without sending.
    expect(['EXPIRED_BEFORE_ACTIVATION', 'SCHEDULED_CLOSE']).toContain(detail.liveRun.closeReason);
    expect(await t.prisma.message.count({ where: { runId: launched.liveRun.id } })).toBe(0);
    t.clock.set(new Date('2026-10-10T09:00:00.000Z'));
  });

  it('manual close cancels remaining work; archive is non-destructive and no delete route exists (R55)', async () => {
    const id = await createSurvey('Manual close');
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    const runner = t.app.get(JobRunner);
    await runner.runOnce(1, 1); // activation only; invitation messages are pending
    expect(await t.prisma.message.count({ where: { runId: launched.liveRun.id, state: 'PENDING' } })).toBeGreaterThan(0);
    const archiveActive = await request(t.server).post(`/api/v1/surveys/${id}/archive`).set('Authorization', manager.authorization).expect(409);
    expect(archiveActive.body.code).toBe('SURVEY_STATE_INVALID');
    const closed = (await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200)).body;
    expect(closed.state).toBe('CLOSED');
    expect(closed.liveRun.closeReason).toBe('MANUAL');
    await drainJobs(t);
    expect(await t.prisma.message.count({ where: { runId: launched.liveRun.id, state: 'ACCEPTED' } })).toBe(0);
    expect(await t.prisma.message.count({ where: { runId: launched.liveRun.id, state: 'CANCELED' } })).toBeGreaterThan(0);
    const archived = (await request(t.server).post(`/api/v1/surveys/${id}/archive`).set('Authorization', manager.authorization).expect(200)).body;
    expect(archived.archivedAt).not.toBeNull();
    expect(await t.prisma.survey.count({ where: { id } })).toBe(1);
    expect(await t.prisma.surveyRevision.count({ where: { surveyId: id } })).toBe(1);
    await request(t.server).delete(`/api/v1/surveys/${id}`).set('Authorization', admin.authorization).expect(404);
    const list = (await request(t.server).get('/api/v1/surveys?archived=true').set('Authorization', viewer.authorization).expect(200)).body;
    expect(list.items.map((item: { id: string }) => item.id)).toContain(id);
    const cloned = (await request(t.server).post(`/api/v1/surveys/${id}/clone`).set('Authorization', manager.authorization).expect(201)).body;
    expect(cloned).toMatchObject({ state: 'DRAFT', internalTitle: 'Manual close (copy)', clonedFromSurveyId: id });
    expect(cloned.revision.questions).toHaveLength(5);
    expect(cloned.liveRun).toBeNull();
  });

  it('test runs are distinct, independently timed and flagged (R30)', async () => {
    const id = await createSurvey('Test run survey');
    const detail = (await request(t.server).post(`/api/v1/surveys/${id}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts['Unknown Umar']], durationSeconds: 3600 }).expect(201)).body;
    expect(detail.state).toBe('DRAFT');
    expect(detail.testRuns).toHaveLength(1);
    expect(detail.testRuns[0]).toMatchObject({ kind: 'TEST', state: 'ACTIVE' });
    await drainJobs(t);
    const messages = await t.prisma.message.findMany({ where: { runId: detail.testRuns[0].id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ isTest: true, state: 'ACCEPTED' });
    const rendered = messages[0].rendered as { previewText: string };
    expect(rendered.previewText.startsWith('[TEST]')).toBe(true);
    // The draft stays editable; the edit produces a new revision so the test run keeps its own.
    const edited = (await request(t.server).patch(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).send({ internalTitle: 'Edited after test' }).expect(200)).body;
    expect(edited.revision.revisionNumber).toBe(2);
  });

  it('known failures retry with backoff, ambiguous sends stop and need an explicit Admin retry, leases recover (R43)', async () => {
    const target = await createContact('Faulty Farah', '+923001000040', 'GRANTED');
    await t.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1, faults: { nextSendOutcome: 'FAILED_TEMPORARY' } }, update: { faults: { nextSendOutcome: 'FAILED_TEMPORARY' } } });
    const id = await createSurvey('Fault survey', { audience: { mode: 'SELECTED', contactIds: [target] } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    const message = await t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id }, include: { attempts: true } });
    expect(message.state).toBe('PENDING');
    expect(message.attempts).toHaveLength(1);
    expect(message.attempts[0]).toMatchObject({ outcome: 'FAILED', errorCode: 'MOCK_RATE_LIMIT', retryable: true });
    const job = await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${message.id}` } });
    expect(job.status).toBe('PENDING');
    expect(job.dueAt.getTime()).toBeGreaterThan(t.clock.now().getTime());
    t.clock.advance(10 * 60 * 1000);
    await drainJobs(t);
    const retried = await t.prisma.message.findUniqueOrThrow({ where: { id: message.id }, include: { attempts: true } });
    expect(retried.state).toBe('ACCEPTED');
    expect(retried.attempts).toHaveLength(2);

    // Ambiguous outcome: no automatic resend.
    const target2 = await createContact('Timeout Tariq', '+923001000041', 'GRANTED');
    await t.prisma.simulatorState.update({ where: { id: 1 }, data: { faults: { nextSendOutcome: 'TIMEOUT' } } });
    const id2 = await createSurvey('Timeout survey', { audience: { mode: 'SELECTED', contactIds: [target2] } });
    const launched2 = (await request(t.server).post(`/api/v1/surveys/${id2}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    t.clock.advance(10 * 60 * 1000);
    await drainJobs(t);
    const unknown = await t.prisma.message.findFirstOrThrow({ where: { runId: launched2.liveRun.id }, include: { attempts: true } });
    expect(unknown.state).toBe('UNKNOWN');
    expect(unknown.attempts).toHaveLength(1);
    const noAck = await request(t.server).post(`/api/v1/messages/${unknown.id}/retry`).set('Authorization', admin.authorization).send({}).expect(422);
    expect(noAck.body.code).toBe('SEND_OUTCOME_UNKNOWN');
    await request(t.server).post(`/api/v1/messages/${unknown.id}/retry`).set('Authorization', manager.authorization).send({ acknowledgeDuplicateRisk: true }).expect(403);
    await request(t.server).post(`/api/v1/messages/${unknown.id}/retry`).set('Authorization', admin.authorization).send({ acknowledgeDuplicateRisk: true, reason: 'Provider confirmed no delivery' }).expect(202);
    await drainJobs(t);
    const afterRetry = await t.prisma.message.findUniqueOrThrow({ where: { id: unknown.id }, include: { attempts: { orderBy: { attemptNumber: 'asc' } } } });
    expect(afterRetry.state).toBe('ACCEPTED');
    expect(afterRetry.attempts.map((attempt) => attempt.outcome)).toEqual(['UNKNOWN', 'ACCEPTED']);
    expect(afterRetry.attempts[1].authorizedByUserId).toBe(admin.userId);

    // Lease recovery: a job stuck RUNNING with an expired lease becomes claimable again.
    const stuck = await t.prisma.job.create({ data: { organizationId: orgId, kind: 'SWEEP_DUE_WORK', dedupeKey: 'stuck-lease', dueAt: t.clock.now(), status: 'RUNNING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(t.clock.now().getTime() - 1000), attempts: 1 } });
    await sweepOnly(t);
    const recovered = await t.prisma.job.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(recovered).toMatchObject({ status: 'PENDING', leaseOwner: null, lastErrorCode: 'LEASE_EXPIRED' });
    await t.prisma.job.delete({ where: { id: stuck.id } });
  });

  it('free-form messages outside the service window are suppressed, not sent (R45)', async () => {
    const contactId = contacts['Dua'];
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    const delivery = t.app.get(DeliveryService);
    const db = createTenantDb(t.prisma, orgId);
    const created = await db.$transaction((tx) =>
      delivery.createMessage(tx, { organizationId: orgId, connectionId: connection.id, contactId, kind: 'QUESTION', rendered: { type: 'text', body: 'Question 1 of 5' }, dedupeKey: 'window-test-1' }),
    );
    await drainJobs(t);
    const suppressed = await t.prisma.message.findUniqueOrThrow({ where: { id: created.id } });
    expect(suppressed).toMatchObject({ state: 'SUPPRESSED', suppressionReason: 'SERVICE_WINDOW_CLOSED' });
    await t.prisma.conversation.upsert({ where: { organizationId_contactId: { organizationId: orgId, contactId } }, create: { organizationId: orgId, contactId, connectionId: connection.id, lastInboundAt: t.clock.now() }, update: { lastInboundAt: t.clock.now() } });
    const inside = await db.$transaction((tx) =>
      delivery.createMessage(tx, { organizationId: orgId, connectionId: connection.id, contactId, kind: 'QUESTION', rendered: { type: 'text', body: 'Question 1 of 5' }, dedupeKey: 'window-test-2' }),
    );
    await drainJobs(t);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: inside.id } })).state).toBe('ACCEPTED');
    t.clock.advance(25 * 3600 * 1000);
    const late = await db.$transaction((tx) =>
      delivery.createMessage(tx, { organizationId: orgId, connectionId: connection.id, contactId, kind: 'QUESTION', rendered: { type: 'text', body: 'Question 2 of 5' }, dedupeKey: 'window-test-3' }),
    );
    await drainJobs(t);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: late.id } })).suppressionReason).toBe('SERVICE_WINDOW_CLOSED');
    t.clock.advance(-25 * 3600 * 1000);
  });

  it('a disabled messaging connection blocks readiness, launches, test runs and queued sends until it is re-enabled (R22, R43)', async () => {
    const id = await createSurvey('Disabled connection survey', { audience: { mode: 'SELECTED', contactIds: [contacts.Ayesha, contacts.Bilal] } });
    const blocked = await setConnectionEnabled(false);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['CONNECTION_DISABLED']);
    expect(blocked.connection?.enabled).toBe(false);
    const launch = await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(422);
    expect(launch.body.code).toBe('TEMPLATE_NOT_READY');
    const testRun = await request(t.server).post(`/api/v1/surveys/${id}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [contacts.Ayesha] }).expect(422);
    expect(testRun.body.code).toBe('TEMPLATE_NOT_READY');
    expect((await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', manager.authorization).expect(200)).body.state).toBe('DRAFT');
    // Messages queued while the sender was enabled are rechecked when they are about to leave the worker.
    expect((await setConnectionEnabled(true)).ok).toBe(true);
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    const runId: string = launched.liveRun.id;
    await t.app.get(LaunchService).activateRun({ organizationId: orgId, correlationId: 'test', actor: 'SYSTEM' }, runId);
    expect(await t.prisma.message.count({ where: { runId, state: 'PENDING' } })).toBe(2);
    await setConnectionEnabled(false);
    await drainJobs(t);
    const messages = await t.prisma.message.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map((message) => [message.state, message.suppressionReason])).toEqual([
      ['SUPPRESSED', 'CONNECTION_DISABLED'],
      ['SUPPRESSED', 'CONNECTION_DISABLED'],
    ]);
    expect(await t.prisma.invitation.count({ where: { runId, state: 'SUPPRESSED' } })).toBe(2);
    expect((await t.prisma.surveyRun.findUniqueOrThrow({ where: { id: runId } })).dispatchBlockReason).toBe('CONNECTION_DISABLED');
    // Re-enabling clears the block on the next sweep; suppressed messages still need an explicit Admin retry.
    await setConnectionEnabled(true);
    await request(t.server).post(`/api/v1/messages/${messages[0].id}/retry`).set('Authorization', admin.authorization).send({}).expect(202);
    await drainJobs(t);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: messages[0].id } })).state).toBe('ACCEPTED');
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: messages[1].id } })).state).toBe('SUPPRESSED');
    expect((await t.prisma.surveyRun.findUniqueOrThrow({ where: { id: runId } })).dispatchBlockReason).toBeNull();
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a run whose readiness breaks before activation keeps its state and is retried by the sweep until repaired (R25, R43)', async () => {
    const id = await createSurvey('Blocked activation survey', { audience: { mode: 'SELECTED', contactIds: [contacts.Chaudhry, contacts.Dua] } });
    const opensAt = '2026-10-11T04:00:00.000Z';
    const scheduled = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'SCHEDULED', opensAt }).expect(200)).body;
    const runId: string = scheduled.liveRun.id;
    await setConnectionEnabled(false);
    t.clock.set(new Date('2026-10-11T04:05:00.000Z'));
    await drainJobs(t);
    let detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(detail.state).toBe('SCHEDULED');
    expect(detail.liveRun).toMatchObject({ state: 'SCHEDULED', activatedAt: null, dispatchBlockReason: 'CONNECTION_DISABLED' });
    expect(await t.prisma.message.count({ where: { runId } })).toBe(0);
    expect(await t.prisma.auditEvent.count({ where: { action: 'survey.activation_blocked', resourceId: id } })).toBe(1);
    // Still blocked a minute later: the sweep retries without duplicating work or audit noise.
    t.clock.set(new Date('2026-10-11T04:06:00.000Z'));
    await drainJobs(t);
    expect((await t.prisma.surveyRun.findUniqueOrThrow({ where: { id: runId } })).state).toBe('SCHEDULED');
    expect(await t.prisma.auditEvent.count({ where: { action: 'survey.activation_blocked', resourceId: id } })).toBe(1);
    // Repaired: the next sweep activates the run and dispatches every pending invitation.
    await setConnectionEnabled(true);
    t.clock.set(new Date('2026-10-11T04:07:30.000Z'));
    await drainJobs(t);
    detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(detail.state).toBe('ACTIVE');
    expect(detail.liveRun).toMatchObject({ state: 'ACTIVE', activatedAt: '2026-10-11T04:07:30.000Z', dispatchBlockReason: null });
    expect(await t.prisma.message.count({ where: { runId, state: 'ACCEPTED' } })).toBe(2);
    t.clock.set(new Date('2026-10-10T09:00:00.000Z'));
  });

  it('delivery state never regresses under concurrent status callbacks (R44)', async () => {
    const reader = await createContact('Reader Rabia', '+923001000035', 'GRANTED');
    const id = await createSurvey('Status race', { audience: { mode: 'SELECTED', contactIds: [reader] } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    const message = await t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id } });
    expect(message.deliveryState).toBe('DELIVERED');
    const delivery = t.app.get(DeliveryService);
    const base = t.clock.now().getTime() + 60_000;
    for (let round = 0; round < 5; round += 1) {
      const at = (offset: number) => new Date(base + round * 10_000 + offset);
      const status = (name: 'SENT' | 'DELIVERED' | 'READ', offset: number) =>
        delivery.recordStatus(orgId, message.connectionId, { phoneNumberId: '', providerMessageId: message.providerMessageId ?? '', recipientIdentity: null, status: name, providerAt: at(offset), errorCode: null, errorTitle: null });
      await Promise.all([status('READ', 3000), status('SENT', 1000), status('DELIVERED', 2000)]);
      const after = await t.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(after.deliveryState).toBe('READ');
      // The first READ fixes the timestamp; later lower-ranked callbacks never touch the row again.
      expect(after.lastStatusAt?.toISOString()).toBe(new Date(base + 3000).toISOString());
    }
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a failure report and later delivery evidence settle on one state for the message and its invitation, in any order (R44)', async () => {
    const ids: string[] = [];
    for (const [index, name] of ['Order Omar', 'Order Orhan', 'Order Osman', 'Order Owais'].entries()) ids.push(await createContact(name, `+92300100006${index}`, 'GRANTED'));
    const id = await createSurvey('Status order', { audience: { mode: 'SELECTED', contactIds: ids } });
    // Keep the mock provider's automatic sent/delivered callbacks away so every message is still ACCEPTED.
    await t.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1, faults: { suppressAutoStatus: true } }, update: { faults: { suppressAutoStatus: true } } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    await t.prisma.simulatorState.update({ where: { id: 1 }, data: { faults: {} } });
    const delivery = t.app.get(DeliveryService);
    const base = t.clock.now().getTime() + 60_000;
    const messageOf = (contactId: string) => t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id, contactId } });
    const report = (message: { connectionId: string; providerMessageId: string | null }, status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED', offset: number) =>
      delivery.recordStatus(orgId, message.connectionId, { phoneNumberId: '', providerMessageId: message.providerMessageId ?? '', recipientIdentity: null, status, providerAt: new Date(base + offset), errorCode: status === 'FAILED' ? '131026' : null, errorTitle: status === 'FAILED' ? 'Message undeliverable' : null });
    const stateOf = async (message: { id: string }) => {
      const [fresh, invitation] = await Promise.all([t.prisma.message.findUniqueOrThrow({ where: { id: message.id } }), t.prisma.invitation.findFirstOrThrow({ where: { messageId: message.id } })]);
      return { delivery: fresh.deliveryState, error: fresh.lastErrorCode, invitation: invitation.state, reason: invitation.stateReason };
    };
    // The failure first, then the read receipt: the receipt supersedes the failure and the invitation follows.
    const first = await messageOf(ids[0]);
    expect(await stateOf(first)).toEqual({ delivery: 'ACCEPTED', error: null, invitation: 'ACCEPTED', reason: null });
    await report(first, 'FAILED', 1000);
    expect(await stateOf(first)).toEqual({ delivery: 'FAILED', error: '131026', invitation: 'FAILED', reason: '131026' });
    await report(first, 'READ', 3000);
    expect(await stateOf(first)).toEqual({ delivery: 'READ', error: null, invitation: 'ACCEPTED', reason: null });
    // The read receipt first: a failure reported afterwards is refused.
    const second = await messageOf(ids[1]);
    await report(second, 'READ', 3000);
    await report(second, 'FAILED', 1000);
    expect(await stateOf(second)).toEqual(await stateOf(first));
    // A sent receipt never outranks a failure, whichever arrives first: the message was sent and then failed.
    const third = await messageOf(ids[2]);
    await report(third, 'SENT', 500);
    await report(third, 'FAILED', 2000);
    await report(third, 'SENT', 1000);
    expect(await stateOf(third)).toEqual({ delivery: 'FAILED', error: '131026', invitation: 'FAILED', reason: '131026' });
    // Concurrent failure and read receipts settle on the read receipt whichever commits first.
    const fourth = await messageOf(ids[3]);
    await Promise.all([report(fourth, 'FAILED', 1000), report(fourth, 'READ', 3000)]);
    expect(await stateOf(fourth)).toEqual({ delivery: 'READ', error: null, invitation: 'ACCEPTED', reason: null });
    // The dispatch summary counts each recipient once (three delivered, one failed) and shows the same
    // diagnostics for a failure superseded by a read receipt as for a read receipt alone.
    const dispatch = (await request(t.server).get(`/api/v1/surveys/${id}/dispatch`).set('Authorization', manager.authorization).expect(200)).body;
    expect(dispatch.metrics).toMatchObject({ providerAccepted: 4, delivered: 3, failed: 1 });
    const rowOf = (contactId: string) => dispatch.recipients.items.find((row: { contactId: string }) => row.contactId === contactId);
    expect(rowOf(ids[0])).toMatchObject({ invitationState: 'ACCEPTED', deliveryState: 'READ', lastErrorCode: null });
    expect(rowOf(ids[1])).toMatchObject({ invitationState: 'ACCEPTED', deliveryState: 'READ', lastErrorCode: null });
    expect(rowOf(ids[2])).toMatchObject({ invitationState: 'FAILED', deliveryState: 'FAILED', lastErrorCode: '131026' });
    // The failure's history stays with the append-only status events.
    expect(await t.prisma.messageStatusEvent.count({ where: { messageId: first.id, status: 'FAILED', errorCode: '131026' } })).toBe(1);
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });

  it('a status whose projection failed is applied by the provider retry and by the sweep instead of being dismissed as a duplicate (R44)', async () => {
    const reader = await createContact('Retry Rida', '+923001000036', 'GRANTED');
    const id = await createSurvey('Status retry', { audience: { mode: 'SELECTED', contactIds: [reader] } });
    // Keep the mock provider's automatic sent/delivered callbacks away so the message is still ACCEPTED.
    await t.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1, faults: { suppressAutoStatus: true } }, update: { faults: { suppressAutoStatus: true } } });
    const launched = (await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    await t.prisma.simulatorState.update({ where: { id: 1 }, data: { faults: {} } });
    const message = await t.prisma.message.findFirstOrThrow({ where: { runId: launched.liveRun.id } });
    expect(message.deliveryState).toBe('ACCEPTED');
    const delivery = t.app.get(DeliveryService);
    const delivered = { phoneNumberId: '', providerMessageId: message.providerMessageId ?? '', recipientIdentity: null, status: 'DELIVERED' as const, providerAt: new Date(t.clock.now().getTime() + 5000), errorCode: null, errorTitle: null };
    // The projection fails once after the event insert (a transient database error).
    const projection = jest.spyOn(delivery, 'applyStatus').mockRejectedValueOnce(new Error('connection reset'));
    await expect(delivery.recordStatus(orgId, message.connectionId, delivered)).rejects.toThrow('connection reset');
    // Nothing of the failed delivery persisted: the event rolled back together with its projection.
    expect(await t.prisma.messageStatusEvent.count({ where: { messageId: message.id, status: 'DELIVERED' } })).toBe(0);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deliveryState).toBe('ACCEPTED');
    // The provider's retry of the same status is applied, not treated as a duplicate.
    expect(await delivery.recordStatus(orgId, message.connectionId, delivered)).toBe('RECORDED');
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deliveryState).toBe('DELIVERED');
    expect(await t.prisma.messageStatusEvent.count({ where: { messageId: message.id, status: 'DELIVERED' } })).toBe(1);
    // A genuine duplicate of an applied status still creates no second event.
    expect(await delivery.recordStatus(orgId, message.connectionId, delivered)).toBe('DUPLICATE');
    expect(await t.prisma.messageStatusEvent.count({ where: { messageId: message.id, status: 'DELIVERED' } })).toBe(1);
    const dispatch = (await request(t.server).get(`/api/v1/surveys/${id}/dispatch`).set('Authorization', manager.authorization).expect(200)).body;
    expect(dispatch.metrics).toMatchObject({ providerAccepted: 1, delivered: 1 });

    // Sweep path: a READ that arrived before the message could be matched is linked and applied together.
    const read = { ...delivered, providerMessageId: 'wamid.early.read', status: 'READ' as const, providerAt: new Date(t.clock.now().getTime() + 6000) };
    expect(await delivery.recordStatus(orgId, message.connectionId, read)).toBe('UNMATCHED');
    await t.prisma.message.update({ where: { id: message.id }, data: { providerMessageId: 'wamid.early.read' } });
    projection.mockRejectedValueOnce(new Error('connection reset'));
    await expect(sweepOnly(t)).rejects.toThrow('connection reset');
    const unapplied = await t.prisma.messageStatusEvent.findFirstOrThrow({ where: { providerMessageId: 'wamid.early.read' } });
    expect(unapplied.messageId).toBeNull();
    expect(unapplied.reconciledAt).toBeNull();
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deliveryState).toBe('DELIVERED');
    await sweepOnly(t);
    const applied = await t.prisma.messageStatusEvent.findFirstOrThrow({ where: { providerMessageId: 'wamid.early.read' } });
    expect(applied.messageId).toBe(message.id);
    expect(applied.reconciledAt).not.toBeNull();
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: message.id } })).deliveryState).toBe('READ');
    projection.mockRestore();
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
  });
});
