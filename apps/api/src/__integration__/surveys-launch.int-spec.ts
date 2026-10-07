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
    const detail = (await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body;
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
    const preview = (await request(t.server).post(`/api/v1/surveys/${id}/preview`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(preview.map((message: { kind: string }) => message.kind)).toEqual(['INVITATION', 'INTRODUCTION', 'PROFILE_OFFER', 'QUESTION', 'QUESTION', 'QUESTION', 'QUESTION', 'QUESTION', 'COMPLETION']);
    expect(preview[3].controls.map((control: { label: string }) => control.label)).toEqual(['Yes', 'No']);
    expect(preview[6].flow.purpose).toBe('MULTI_CHOICE');
    expect(preview[7].controls).toHaveLength(5);
    await request(t.server).post('/api/v1/surveys').set('Authorization', viewer.authorization).send({ internalTitle: 'Nope' }).expect(403);
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
    expect((await request(t.server).get(`/api/v1/surveys/${id}`).set('Authorization', viewer.authorization).expect(200)).body.state).toBe('DRAFT');
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
});
