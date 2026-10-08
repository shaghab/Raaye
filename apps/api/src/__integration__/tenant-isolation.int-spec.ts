import request from 'supertest';
import { DeliveryService, JobRunner, JobsService, createTenantDb, signWebhookBody } from '@raaye/server';
import { drainJobs } from '../testing/jobs';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

/** The same number belongs to a contact of each organization (R07, R08). */
const PHONE = '+923009100001';
const WA_ID = '923009100001';

const QUESTIONS = [
  { authoringType: 'YES_NO', prompt: { en: 'Do you use public transport?' } },
  { authoringType: 'RATING', prompt: { en: 'Rate the service.' } },
];

interface Side {
  key: 'A' | 'B';
  orgId: string;
  admin: SeededUser;
  manager: SeededUser;
  contactId: string;
  contactName: string;
  groupId: string;
  tagId: string;
  surveyId: string;
  surveyTitle: string;
  runId: string;
  phoneNumberId: string;
  appKey: string;
}

interface ConvMessage {
  id: string;
  direction: string;
  kind: string;
  text: string;
  controls: { id: string; label: string }[];
}

describe('two organizations with the same phone number stay separate (R07, R08, R58)', () => {
  let t: TestApp;
  let A: Side;
  let B: Side;
  let runner: JobRunner;
  let jobs: JobsService;
  let delivery: DeliveryService;

  const api = (side: Side, user: SeededUser = side.admin) => ({
    get: (path: string) => request(t.server).get(`/api/v1${path}`).set('Authorization', user.authorization),
    post: (path: string, body: Record<string, unknown> = {}) => request(t.server).post(`/api/v1${path}`).set('Authorization', user.authorization).send(body),
    patch: (path: string, body: Record<string, unknown> = {}) => request(t.server).patch(`/api/v1${path}`).set('Authorization', user.authorization).send(body),
  });
  const outbound = async (side: Side): Promise<ConvMessage[]> => ((await api(side).get(`/dev/simulator/conversation/${side.contactId}`).expect(200)).body as ConvMessage[]).filter((message) => message.direction === 'OUTBOUND');
  const tap = async (side: Side, label: string, within: (message: ConvMessage) => boolean = () => true) => {
    const message = [...(await outbound(side))].reverse().find((candidate) => within(candidate) && candidate.controls.some((control) => control.label === label));
    if (!message) throw new Error(`No control ${label} for ${side.key}`);
    await api(side).post('/dev/simulator/tap', { contactId: side.contactId, messageId: message.id, controlId: message.controls.find((control) => control.label === label)?.id }).expect(200);
    await drainJobs(t);
  };
  const jsonOf = (value: unknown) => JSON.stringify(value);
  const describeResponse = (response: request.Response) => `${response.status} ${String(response.text ?? jsonOf(response.body)).slice(0, 200)}`;

  async function build(key: 'A' | 'B'): Promise<Side> {
    const org = await seedOrganization(t.prisma, `Isolation ${key}`);
    const admin = await seedUser(t.prisma, org.id, 'ADMIN');
    const manager = await seedUser(t.prisma, org.id, 'SURVEY_MANAGER');
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: org.id } });
    await t.prisma.messagingConnection.update({ where: { id: connection.id }, data: { phoneNumberId: `PNID-${key}`, appSecretRef: 'TEST_ISOLATION_SECRET', verifyTokenRef: 'TEST_ISOLATION_VERIFY' } });
    const side = { key, orgId: org.id, admin, manager, contactName: `Shared Phone ${key}`, surveyTitle: `Isolation survey ${key}`, phoneNumberId: `PNID-${key}`, appKey: connection.appKey } as Side;
    const as = api(side, manager);
    side.contactId = (await as.post('/contacts', { name: side.contactName, phone: PHONE, city: 'Lahore' }).expect(201)).body.id;
    await as.post(`/contacts/${side.contactId}/consent-events`, { scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    side.groupId = (await as.post('/groups', { name: `Group ${key}` }).expect(201)).body.id;
    side.tagId = (await as.post('/tags', { name: `Tag ${key}` }).expect(201)).body.id;
    await as.post(`/groups/${side.groupId}/contacts/${side.contactId}`).expect(204);
    side.surveyId = (await as.post('/surveys', { internalTitle: side.surveyTitle, title: { en: side.surveyTitle }, introduction: { en: 'Intro' }, questions: QUESTIONS, audience: { mode: 'SELECTED', contactIds: [side.contactId] } }).expect(201)).body.id;
    side.runId = (await as.post(`/surveys/${side.surveyId}/launch`, { mode: 'NOW' }).expect(200)).body.liveRun.id;
    return side;
  }

  beforeAll(async () => {
    process.env['TEST_ISOLATION_SECRET'] = 'isolation-secret';
    process.env['TEST_ISOLATION_VERIFY'] = 'isolation-verify';
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    A = await build('A');
    B = await build('B');
    runner = t.app.get(JobRunner);
    jobs = t.app.get(JobsService);
    delivery = t.app.get(DeliveryService);
    await drainJobs(t);
    // Each contact takes part in its own organization's survey with a different answer.
    for (const [side, choice, rating] of [[A, 'Yes', '5'], [B, 'No', '1']] as const) {
      await tap(side, 'Start survey', (message) => message.kind === 'INVITATION');
      if ((await outbound(side)).some((message) => message.kind === 'PROFILE_OFFER' && message.controls.length > 0)) await tap(side, 'Skip');
      await tap(side, choice, (message) => message.text.includes('Question 1 of 2'));
      await tap(side, rating, (message) => message.text.includes('Question 2 of 2'));
    }
  });

  afterAll(async () => {
    await t.close();
  });

  /** Everything an organization owns that a foreign request could change. */
  const footprint = async (side: Side) => ({
    surveys: await t.prisma.survey.findMany({ where: { organizationId: side.orgId }, select: { id: true, internalTitle: true, state: true, archivedAt: true, currentRevisionNumber: true }, orderBy: { id: 'asc' } }),
    runs: await t.prisma.surveyRun.findMany({ where: { organizationId: side.orgId }, select: { id: true, state: true, kind: true }, orderBy: { id: 'asc' } }),
    contacts: await t.prisma.contact.findMany({ where: { organizationId: side.orgId }, select: { id: true, name: true, archivedAt: true, consentInvitations: true, consentResults: true }, orderBy: { id: 'asc' } }),
    counts: {
      consentEvents: await t.prisma.consentEvent.count({ where: { organizationId: side.orgId } }),
      messages: await t.prisma.message.count({ where: { organizationId: side.orgId } }),
      answers: await t.prisma.answer.count({ where: { organizationId: side.orgId } }),
      snapshots: await t.prisma.resultSnapshot.count({ where: { organizationId: side.orgId } }),
      contactGroups: await t.prisma.contactGroup.count({ where: { organizationId: side.orgId } }),
      contactTags: await t.prisma.contactTag.count({ where: { organizationId: side.orgId } }),
      recipients: await t.prisma.surveyRecipient.count({ where: { organizationId: side.orgId } }),
    },
  });

  it('direct object requests, mutations, reports and exports by the other organization find nothing and change nothing', async () => {
    const before = { A: await footprint(A), B: await footprint(B) };
    const messageOf = async (side: Side) => (await t.prisma.message.findFirstOrThrow({ where: { organizationId: side.orgId, kind: 'INVITATION' } })).id;
    const consent = { scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-09T10:00:00Z', evidenceReference: 'Call' };
    for (const [attacker, victim] of [[A, B], [B, A]] as const) {
      const as = api(attacker);
      const message = await messageOf(victim);
      const attempts: [string, () => request.Test][] = [
        ['GET survey', () => as.get(`/surveys/${victim.surveyId}`)],
        ['PATCH survey', () => as.patch(`/surveys/${victim.surveyId}`, { internalTitle: 'Hijacked' })],
        ['clone', () => as.post(`/surveys/${victim.surveyId}/clone`)],
        ['preview', () => as.post(`/surveys/${victim.surveyId}/preview`)],
        ['audience preview', () => as.post(`/surveys/${victim.surveyId}/audience-preview`)],
        ['test run', () => as.post(`/surveys/${victim.surveyId}/test-runs`, { contactIds: [attacker.contactId] })],
        ['launch', () => as.post(`/surveys/${victim.surveyId}/launch`, { mode: 'NOW' })],
        ['unschedule', () => as.post(`/surveys/${victim.surveyId}/unschedule`)],
        ['close', () => as.post(`/surveys/${victim.surveyId}/close`)],
        ['archive', () => as.post(`/surveys/${victim.surveyId}/archive`)],
        ['unarchive', () => as.post(`/surveys/${victim.surveyId}/unarchive`)],
        ['results', () => as.get(`/surveys/${victim.surveyId}/results`)],
        ['breakdowns', () => as.get(`/surveys/${victim.surveyId}/breakdowns?dimension=city`)],
        ['dispatch', () => as.get(`/surveys/${victim.surveyId}/dispatch`)],
        ['responses', () => as.get(`/surveys/${victim.surveyId}/responses`)],
        ['export aggregates', () => as.get(`/surveys/${victim.surveyId}/exports/aggregates?format=csv`)],
        ['export breakdowns', () => as.get(`/surveys/${victim.surveyId}/exports/breakdowns?format=csv&dimension=city`)],
        ['export responses', () => as.get(`/surveys/${victim.surveyId}/exports/responses?format=csv`)],
        ['export revisions', () => as.get(`/surveys/${victim.surveyId}/exports/revisions?format=csv`)],
        ['results preview', () => as.post(`/surveys/${victim.surveyId}/results-preview`)],
        ['share results', () => as.post(`/surveys/${victim.surveyId}/share-results`, { confirm: true })],
        ['sharing status', () => as.get(`/surveys/${victim.surveyId}/result-sharing`)],
        ['revoke sharing', () => as.post(`/surveys/${victim.surveyId}/result-sharing/revoke`)],
        ['GET contact', () => as.get(`/contacts/${victim.contactId}`)],
        ['PATCH contact', () => as.patch(`/contacts/${victim.contactId}`, { name: 'Hijacked' })],
        ['archive contact', () => as.post(`/contacts/${victim.contactId}/archive`)],
        ['unarchive contact', () => as.post(`/contacts/${victim.contactId}/unarchive`)],
        ['consent history', () => as.get(`/contacts/${victim.contactId}/consent-events`)],
        ['withdraw consent', () => as.post(`/contacts/${victim.contactId}/consent-events`, consent)],
        ['message detail', () => as.get(`/messages/${message}`)],
        ['message retry', () => as.post(`/messages/${message}/retry`)],
        ['rename group', () => as.patch(`/groups/${victim.groupId}`, { name: 'Hijacked' })],
        ['rename tag', () => as.patch(`/tags/${victim.tagId}`, { name: 'Hijacked' })],
        ['add own contact to foreign group', () => as.post(`/groups/${victim.groupId}/contacts/${attacker.contactId}`)],
        ['add foreign contact to own group', () => as.post(`/groups/${attacker.groupId}/contacts/${victim.contactId}`)],
        ['remove foreign contact from foreign group', () => as.post(`/groups/${victim.groupId}/contacts/${victim.contactId}`)],
        ['simulator conversation', () => as.get(`/dev/simulator/conversation/${victim.contactId}`)],
      ];
      for (const [label, attempt] of attempts) {
        const response = await attempt();
        if (response.status !== 404) throw new Error(`${attacker.key} → ${victim.key}: ${label} answered ${describeResponse(response)}`);
        expect(jsonOf(response.body)).not.toContain(victim.contactName);
      }
    }
    // The same requests against the caller's own objects succeed, so the 404s above are isolation and not a wrong route.
    for (const side of [A, B]) {
      const as = api(side);
      for (const path of [`/surveys/${side.surveyId}`, `/surveys/${side.surveyId}/results`, `/surveys/${side.surveyId}/dispatch`, `/surveys/${side.surveyId}/responses`, `/surveys/${side.surveyId}/breakdowns?dimension=city`, `/surveys/${side.surveyId}/exports/aggregates?format=csv`, `/surveys/${side.surveyId}/exports/breakdowns?format=csv&dimension=city`, `/surveys/${side.surveyId}/exports/responses?format=csv`, `/surveys/${side.surveyId}/exports/revisions?format=csv`, `/surveys/${side.surveyId}/result-sharing`, `/contacts/${side.contactId}`, `/contacts/${side.contactId}/consent-events`, `/messages/${await messageOf(side)}`, `/dev/simulator/conversation/${side.contactId}`]) {
        const response = await as.get(path);
        if (response.status !== 200) throw new Error(`${side.key}: control GET ${path} answered ${describeResponse(response)}`);
      }
    }
    // Nothing of either organization changed, and the same phone number is still two separate contacts.
    expect(await footprint(A)).toEqual(before.A);
    expect(await footprint(B)).toEqual(before.B);
    expect((await t.prisma.contact.findMany({ where: { phoneE164: PHONE } })).map((contact) => contact.organizationId).sort()).toEqual([A.orgId, B.orgId].sort());
  });

  it('lists, searches, counts and exports only contain the caller\'s organization', async () => {
    for (const [mine, other] of [[A, B], [B, A]] as const) {
      const as = api(mine);
      const contacts = (await as.get('/contacts').expect(200)).body;
      expect(contacts.items.map((item: { id: string }) => item.id)).toEqual([mine.contactId]);
      const search = (await as.get(`/contacts?q=${encodeURIComponent(PHONE)}`).expect(200)).body;
      expect(search.items.map((item: { id: string }) => item.id)).toEqual([mine.contactId]);
      const surveys = (await as.get('/surveys').expect(200)).body;
      expect(surveys.items.map((item: { id: string }) => item.id)).toEqual([mine.surveyId]);
      const forbidden = [other.contactName, other.surveyTitle, other.contactId, other.surveyId, other.groupId, other.tagId, other.admin.email, other.manager.email];
      for (const path of ['/groups', '/tags', '/members', '/audit', '/overview', '/messaging/readiness', '/contact-imports', '/contacts/export?format=csv']) {
        const response = await as.get(path);
        if (response.status !== 200) throw new Error(`${mine.key}: GET ${path} answered ${response.status}`);
        const body = jsonOf(response.body) + String(response.text ?? '');
        for (const value of forbidden) expect(body).not.toContain(value);
      }
      const overview = (await as.get('/overview').expect(200)).body;
      expect(overview.contacts.total).toBe(1);
      expect(overview.surveys.active).toBe(1);
      expect((await as.get('/groups').expect(200)).body.map((group: { id: string }) => group.id)).toEqual([mine.groupId]);
      expect((await as.get('/tags').expect(200)).body.map((tag: { id: string }) => tag.id)).toEqual([mine.tagId]);
    }
  });

  it('relation connects to another organization\'s groups, tags, contacts and audiences are refused', async () => {
    const before = { A: await footprint(A), B: await footprint(B) };
    const as = api(B, B.manager);
    expect((await as.patch(`/contacts/${B.contactId}`, { groupIds: [A.groupId] })).status).toBe(404);
    expect((await as.patch(`/contacts/${B.contactId}`, { tagIds: [A.tagId] })).status).toBe(404);
    expect((await as.post('/contacts', { name: 'Connected', phone: '+923009100002', groupIds: [A.groupId] })).status).toBe(404);
    expect((await as.post('/contacts', { name: 'Connected', phone: '+923009100002', tagIds: [A.tagId] })).status).toBe(404);
    expect((await as.post(`/surveys/${B.surveyId}/test-runs`, { contactIds: [A.contactId] })).status).toBe(404);
    expect(await t.prisma.surveyRun.count({ where: { surveyId: B.surveyId, kind: 'TEST' } })).toBe(0);
    expect(await t.prisma.contact.count({ where: { organizationId: B.orgId, phoneE164: '+923009100002' } })).toBe(0);
    // An audience that names a foreign contact reaches only the caller's own: the foreign contact never becomes a recipient.
    const survey = (await as.post('/surveys', { internalTitle: 'Connect attempt', title: { en: 'Connect attempt' }, introduction: { en: 'Intro' }, questions: QUESTIONS, audience: { mode: 'SELECTED', contactIds: [A.contactId, B.contactId] } })).body;
    const preview = (await as.post(`/surveys/${survey.id}/audience-preview`)).body;
    expect(jsonOf(preview)).not.toContain(A.contactName);
    const launched = await as.post(`/surveys/${survey.id}/launch`, { mode: 'NOW' });
    expect(launched.status).toBe(200);
    await drainJobs(t);
    const run = await t.prisma.surveyRun.findFirstOrThrow({ where: { surveyId: survey.id, kind: 'LIVE' } });
    expect((await t.prisma.surveyRecipient.findMany({ where: { runId: run.id } })).map((recipient) => recipient.contactId)).toEqual([B.contactId]);
    expect(await t.prisma.message.count({ where: { runId: run.id, contactId: A.contactId } })).toBe(0);
    await as.post(`/surveys/${survey.id}/close`).expect(200);
    // Organization A did not change at all, and organization B's only change is the survey it created itself.
    expect(await footprint(A)).toEqual(before.A);
    const after = await footprint(B);
    expect({ ...after.counts, messages: 0, recipients: 0 }).toEqual({ ...before.B.counts, messages: 0, recipients: 0 });
  });

  it('reports and exports carry only the organization\'s own respondent, although both contacts share a phone number', async () => {
    const options = (results: { questions: { options: { code: string; count: number }[] }[] }) => results.questions[0].options.filter((option) => option.count > 0).map((option) => [option.code, option.count]);
    const resultsA = (await api(A).get(`/surveys/${A.surveyId}/results`).expect(200)).body;
    const resultsB = (await api(B).get(`/surveys/${B.surveyId}/results`).expect(200)).body;
    expect(resultsA).toMatchObject({ started: 1, responded: 1, completed: 1 });
    expect(resultsB).toMatchObject({ started: 1, responded: 1, completed: 1 });
    expect(options(resultsA)).toEqual([['YES', 1]]);
    expect(options(resultsB)).toEqual([['NO', 1]]);
    for (const [mine, other] of [[A, B], [B, A]] as const) {
      const as = api(mine);
      const dispatch = (await as.get(`/surveys/${mine.surveyId}/dispatch`).expect(200)).body;
      expect(dispatch.recipients.total).toBe(1);
      expect(dispatch.recipients.items.map((item: { contactId: string }) => item.contactId)).toEqual([mine.contactId]);
      const responses = (await as.get(`/surveys/${mine.surveyId}/responses`).expect(200)).body;
      expect(responses.total).toBe(1);
      expect(jsonOf(responses)).toContain(mine.contactName);
      expect(jsonOf(responses)).not.toContain(other.contactName);
      expect(jsonOf(responses)).not.toContain(other.contactId);
      for (const type of ['aggregates', 'responses', 'revisions']) {
        const file = await as.get(`/surveys/${mine.surveyId}/exports/${type}?format=csv`).expect(200);
        const text = String(file.text ?? '');
        expect(text).not.toContain(other.contactName);
        expect(text).not.toContain(other.contactId);
        expect(text).not.toContain(other.surveyId);
        if (type === 'responses') expect(text).toContain(mine.contactName);
      }
      const breakdown = await as.get(`/surveys/${mine.surveyId}/exports/breakdowns?format=csv&dimension=city`).expect(200);
      expect(String(breakdown.text ?? '')).not.toContain(other.contactName);
    }
    // Each organization's answer belongs to its own participation, whichever contact shares the number.
    const participations = await t.prisma.participation.findMany({ select: { organizationId: true, contactId: true, runId: true } });
    expect(participations.filter((participation) => participation.organizationId === A.orgId).map((participation) => participation.contactId)).toEqual([A.contactId]);
    expect(participations.filter((participation) => participation.organizationId === B.orgId).map((participation) => participation.contactId).includes(A.contactId)).toBe(false);
  });

  it('a job that names another organization\'s object does nothing to it (workers, R58)', async () => {
    const now = t.clock.now();
    // Organization A has a queued message, an unprocessed inbound event and a running survey.
    const db = createTenantDb(t.prisma, A.orgId);
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: A.orgId } });
    const queued = await db.$transaction((tx) => delivery.createMessage(tx, { organizationId: A.orgId, connectionId: connection.id, contactId: A.contactId, kind: 'COMMAND_REPLY', rendered: { type: 'text', body: 'Isolation probe' }, dedupeKey: 'isolation-probe-a' }));
    const inbound = (await api(A).post('/dev/simulator/text', { contactId: A.contactId, text: 'hello' }).expect(200)).body as { eventId: string };
    const forged = [
      { kind: 'SEND_MESSAGE' as const, entityId: queued.id },
      { kind: 'PROCESS_INBOUND' as const, entityId: inbound.eventId },
      { kind: 'CLOSE_SURVEY' as const, entityId: A.runId },
      { kind: 'ACTIVATE_SURVEY' as const, entityId: A.runId },
    ];
    for (const job of forged) {
      const created = await jobs.enqueue(t.prisma, { organizationId: B.orgId, kind: job.kind, entityId: job.entityId, dedupeKey: `forged:${job.kind}:${job.entityId}`, dueAt: now });
      await runner.runJob(created.id);
      expect(await t.prisma.job.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ organizationId: B.orgId });
    }
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ state: 'PENDING', organizationId: A.orgId });
    expect(await t.prisma.messageAttempt.count({ where: { messageId: queued.id } })).toBe(0);
    expect(await t.prisma.inboundEvent.findUniqueOrThrow({ where: { id: inbound.eventId } })).toMatchObject({ processingState: 'PENDING', organizationId: A.orgId });
    expect(await t.prisma.surveyRun.findUniqueOrThrow({ where: { id: A.runId } })).toMatchObject({ state: 'ACTIVE', closedAt: null });
    expect(await t.prisma.survey.findUniqueOrThrow({ where: { id: A.surveyId } })).toMatchObject({ state: 'ACTIVE' });
    // Organization A's own jobs still run normally afterwards.
    await drainJobs(t);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('ACCEPTED');
    expect((await t.prisma.inboundEvent.findUniqueOrThrow({ where: { id: inbound.eventId } })).processingState).toBe('PROCESSED');
  });

  it('webhooks act inside the organization of the connection that received them, including a STOP from the shared number (webhooks, R40, R58)', async () => {
    const now = t.clock.now();
    const stamp = String(Math.floor(now.getTime() / 1000));
    const post = async (side: Side, phoneNumberId: string, value: Record<string, unknown>) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: phoneNumberId }, ...value } }] }] });
      return request(t.server).post(`/api/v1/webhooks/whatsapp/${side.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(Buffer.from(body, 'utf8'), 'isolation-secret')).send(body).expect(200);
    };
    const text = (id: string, body: string) => ({ contacts: [{ profile: { name: 'Shared' }, wa_id: WA_ID }], messages: [{ from: WA_ID, id, timestamp: stamp, type: 'text', text: { body } }] });
    const conversation = (side: Side) => t.prisma.conversation.findUnique({ where: { organizationId_contactId: { organizationId: side.orgId, contactId: side.contactId } } });
    const eventJob = async (providerMessageId: string) => {
      const event = await t.prisma.inboundEvent.findFirstOrThrow({ where: { providerMessageId } });
      return { event, jobId: (await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${event.id}` } })).id };
    };

    // 1. A message from the shared number to B's connection is B's: it lands in B and nowhere in A.
    const aBefore = { events: await t.prisma.inboundEvent.count({ where: { organizationId: A.orgId } }), conversation: (await conversation(A))?.lastInboundAt, messages: await t.prisma.message.count({ where: { organizationId: A.orgId } }) };
    expect((await post(B, B.phoneNumberId, text('wamid.iso.help', 'HELP'))).body).toMatchObject({ accepted: 1 });
    const help = await eventJob('wamid.iso.help');
    expect(help.event.organizationId).toBe(B.orgId);
    expect(await runner.runJob(help.jobId)).toBe('DONE');
    expect(await t.prisma.message.count({ where: { organizationId: B.orgId, contactId: B.contactId, kind: 'COMMAND_REPLY', dedupeKey: { contains: help.event.id } } })).toBeGreaterThanOrEqual(1);
    expect({ events: await t.prisma.inboundEvent.count({ where: { organizationId: A.orgId } }), conversation: (await conversation(A))?.lastInboundAt, messages: await t.prisma.message.count({ where: { organizationId: A.orgId } }) }).toEqual(aBefore);

    // 2. A payload addressed to A's phone number id but delivered to B's webhook is quarantined, not processed anywhere.
    const crossed = await post(B, A.phoneNumberId, text('wamid.iso.crossed', 'HELP'));
    expect(crossed.body).toMatchObject({ accepted: 0 });
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.iso.crossed' } })).toBe(0);
    expect(await t.prisma.webhookQuarantine.count({ where: { appKey: B.appKey, phoneNumberId: A.phoneNumberId } })).toBe(1);

    // 3. A status callback for B's message, posted to A's connection, cannot change B's message.
    const bInvitation = await t.prisma.message.findFirstOrThrow({ where: { organizationId: B.orgId, kind: 'INVITATION' } });
    expect(bInvitation.deliveryState).not.toBe('READ');
    await post(A, A.phoneNumberId, { statuses: [{ id: bInvitation.providerMessageId, status: 'read', timestamp: stamp, recipient_id: WA_ID }] });
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: bInvitation.id } })).deliveryState).toBe(bInvitation.deliveryState);
    expect(await t.prisma.messageStatusEvent.count({ where: { organizationId: B.orgId, providerMessageId: bInvitation.providerMessageId, status: 'READ' } })).toBe(0);

    // 4. STOP from the shared number to B's connection withdraws B's contact and leaves A's contact and A's queued message alone.
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: A.orgId } });
    const pending = await createTenantDb(t.prisma, A.orgId).$transaction((tx) => delivery.createMessage(tx, { organizationId: A.orgId, connectionId: connection.id, contactId: A.contactId, kind: 'COMMAND_REPLY', rendered: { type: 'text', body: 'Isolation probe two' }, dedupeKey: 'isolation-probe-a-2' }));
    expect((await post(B, B.phoneNumberId, text('wamid.iso.stop', 'STOP'))).body).toMatchObject({ accepted: 1 });
    const stop = await eventJob('wamid.iso.stop');
    expect(stop.event.organizationId).toBe(B.orgId);
    expect(await runner.runJob(stop.jobId)).toBe('DONE');
    expect(await t.prisma.contact.findUniqueOrThrow({ where: { id: B.contactId } })).toMatchObject({ consentInvitations: 'WITHDRAWN', consentResults: 'WITHDRAWN' });
    expect(await t.prisma.contact.findUniqueOrThrow({ where: { id: A.contactId } })).toMatchObject({ consentInvitations: 'GRANTED', consentResults: 'GRANTED' });
    expect(await t.prisma.consentEvent.count({ where: { organizationId: A.orgId, source: 'PARTICIPANT_STOP' } })).toBe(0);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('PENDING');
    await drainJobs(t);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('ACCEPTED');
  });
});
