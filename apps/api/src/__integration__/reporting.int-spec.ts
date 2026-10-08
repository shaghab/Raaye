import request from 'supertest';
import { DeliveryService, JobRunner, MessagePlanner, RetentionService, createTenantDb, resultsReplyKey } from '@raaye/server';
import { parseCsv as parseCsvDomain, readXlsx as readXlsxDomain } from '@raaye/domain';
import { drainJobs } from '../testing/jobs';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';
import { binaryParser } from '../testing/http';

const QUESTIONS = [
  { authoringType: 'YES_NO', prompt: { en: 'Do you use public transport?' } },
  { authoringType: 'MULTI_CHOICE', prompt: { en: 'Which have you used this year?' }, options: [{ label: { en: 'Legal aid' } }, { label: { en: 'Workshops' } }, { label: { en: 'None of the above' }, exclusive: true }], minSelections: 1, maxSelections: 2 },
  { authoringType: 'RATING', prompt: { en: 'Rate the service.' } },
];

interface ConvMessage {
  id: string;
  direction: string;
  kind: string;
  text: string;
  state: string;
  controls: { id: string; label: string }[];
  flow: { token: string; purpose: string; options: { id: string; label: string }[] } | null;
}

describe('reporting, exports, result sharing and retention (R06, R30, R46-R54, R56)', () => {
  let t: TestApp;
  let orgId: string;
  let admin: SeededUser;
  let manager: SeededUser;
  let viewer: SeededUser;
  let surveyId: string;
  let runId: string;
  const people: Record<string, string> = {};

  const sim = (path: string, body: Record<string, unknown>) => request(t.server).post(`/api/v1/dev/simulator/${path}`).set('Authorization', admin.authorization).send(body);
  const outbound = async (contactId: string): Promise<ConvMessage[]> => ((await request(t.server).get(`/api/v1/dev/simulator/conversation/${contactId}`).set('Authorization', admin.authorization).expect(200)).body as ConvMessage[]).filter((message) => message.direction === 'OUTBOUND');
  const tap = async (contactId: string, label: string, within: (message: ConvMessage) => boolean = () => true) => {
    const message = [...(await outbound(contactId))].reverse().find((candidate) => within(candidate) && candidate.controls.some((control) => control.label === label));
    if (!message) throw new Error(`No control ${label}`);
    await sim('tap', { contactId, messageId: message.id, controlId: message.controls.find((control) => control.label === label)?.id }).expect(200);
    await drainJobs(t);
  };
  const submitMulti = async (contactId: string, labels: string[]) => {
    const message = [...(await outbound(contactId))].reverse().find((candidate) => candidate.flow?.purpose === 'MULTI_CHOICE');
    if (!message?.flow) throw new Error('No multi flow');
    const ids = labels.map((label) => message.flow?.options.find((option) => option.label === label)?.id ?? '');
    await sim('flow', { contactId, messageId: message.id, flowToken: message.flow.token, selectedOptionIds: ids }).expect(200);
    await drainJobs(t);
  };

  async function createContact(name: string, phone: string, consent: ('SURVEY_INVITATIONS' | 'SURVEY_RESULTS')[], profile: Record<string, string> = {}): Promise<string> {
    const created = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name, phone, ...profile }).expect(201)).body;
    if (consent.length) await request(t.server).post(`/api/v1/contacts/${created.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: consent, type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    people[name] = created.id;
    return created.id;
  }

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    viewer = await seedUser(t.prisma, orgId, 'VIEWER');
    await createContact('P1', '+923002000001', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], { city: 'Lahore', gender: 'WOMAN' });
    await createContact('P2', '+923002000002', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], { city: 'Lahore', gender: 'WOMAN' });
    await createContact('P3', '+923002000003', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], { city: 'Karachi', gender: 'MAN' });
    await createContact('=P4', '+923002000004', ['SURVEY_INVITATIONS'], { city: 'Karachi', gender: 'MAN' });
    await createContact('P5', '+923002000005', ['SURVEY_INVITATIONS'], { city: 'Lahore' });
    await createContact('P6', '+923002000006', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS']);
    await createContact('P7', '+923002000007', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS']);
    await createContact('P8', '+923002000008', ['SURVEY_INVITATIONS', 'SURVEY_RESULTS']);
    const created = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({ internalTitle: 'Reporting survey', title: { en: 'Reporting survey' }, introduction: { en: 'Intro' }, questions: QUESTIONS, audience: { mode: 'EVERYONE' } }).expect(201)).body;
    surveyId = created.id;
    // A test run with P1 must never enter live reporting (R30).
    await request(t.server).post(`/api/v1/surveys/${surveyId}/test-runs`).set('Authorization', manager.authorization).send({ contactIds: [people['P1']] }).expect(201);
    await drainJobs(t);
    await tap(people['P1'], 'Start survey');
    await tap(people['P1'], 'Skip');
    await tap(people['P1'], 'Yes');
    await submitMulti(people['P1'], ['Legal aid']);
    await tap(people['P1'], '5');
    expect(await t.prisma.participation.count({ where: { contactId: people['P1'], run: { kind: 'TEST' } } })).toBe(1);
    // Live launch and responses.
    const launched = (await request(t.server).post(`/api/v1/surveys/${surveyId}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    runId = launched.liveRun.id;
    await drainJobs(t);
    const start = async (name: string) => {
      await tap(people[name], 'Start survey', (message) => message.kind === 'INVITATION' && !message.text.startsWith('[TEST]'));
      const offer = (await outbound(people[name])).some((message) => message.kind === 'PROFILE_OFFER' && message.controls.length > 0);
      if (offer) await tap(people[name], 'Skip');
    };
    await start('P1'); await tap(people['P1'], 'Yes', (message) => !message.text.startsWith('[TEST]')); await submitMulti(people['P1'], ['Legal aid', 'Workshops']); await tap(people['P1'], '5', (message) => !message.text.startsWith('[TEST]'));
    await start('P2'); await tap(people['P2'], 'Yes'); await submitMulti(people['P2'], ['Legal aid']); await tap(people['P2'], '3');
    await start('P3'); await tap(people['P3'], 'No'); await submitMulti(people['P3'], ['None of the above']); await tap(people['P3'], '4');
    await start('=P4'); await tap(people['=P4'], 'Yes'); await tap(people['=P4'], 'No', (message) => message.text.includes('Question 1 of 3')); await submitMulti(people['=P4'], ['Legal aid', 'Workshops']); await tap(people['=P4'], '1');
    await start('P5'); await tap(people['P5'], 'Yes');
    await start('P6');
  });

  afterAll(async () => {
    await t.close();
  });

  it('computes aggregates from current canonical answers with correct denominators (R46, R47, R30)', async () => {
    const results = (await request(t.server).get(`/api/v1/surveys/${surveyId}/results`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(results).toMatchObject({ runId, started: 6, responded: 5, completed: 4, isSnapshot: false });
    const [q1, q2, q3] = results.questions;
    expect(q1.validAnswers).toBe(5);
    expect(q1.unansweredAmongStarted).toBe(1);
    expect(q1.options.map((option: { code: string; count: number; percentage: number }) => [option.code, option.count, option.percentage])).toEqual([
      ['YES', 3, 60],
      ['NO', 2, 40],
    ]);
    expect(q2.validAnswers).toBe(4);
    expect(q2.percentagesMaySumOver100).toBe(true);
    expect(q2.options.map((option: { count: number; percentage: number }) => [option.count, option.percentage])).toEqual([
      [3, 75],
      [2, 50],
      [1, 25],
    ]);
    expect(q3.validAnswers).toBe(4);
    expect(q3.ratingMean).toBe(3.25);
    expect(q3.options.map((option: { ratingValue: number; count: number }) => [option.ratingValue, option.count])).toEqual([
      [1, 1],
      [2, 0],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    const dispatch = (await request(t.server).get(`/api/v1/surveys/${surveyId}/dispatch`).set('Authorization', manager.authorization).expect(200)).body;
    expect(dispatch.metrics).toMatchObject({ selected: 8, eligibleAtLaunch: 8, providerAccepted: 8, delivered: 8, started: 6, responded: 5, completed: 4, responseRate: 62.5, completionRate: 66.7, deliveredRespondents: 5 });
    const serialized = JSON.stringify(dispatch.recipients.items);
    expect(serialized).not.toContain('selections');
    expect(serialized).not.toContain('ratingValue');
    expect(dispatch.recipients.items.find((item: { contactName: string }) => item.contactName === 'P1')).toMatchObject({ participationState: 'COMPLETED', answeredCount: 3, deliveryState: 'DELIVERED' });
    const empty = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({ internalTitle: 'Unlaunched', questions: QUESTIONS, audience: { mode: 'EVERYONE' } }).expect(201)).body;
    const none = (await request(t.server).get(`/api/v1/surveys/${empty.id}/results`).set('Authorization', manager.authorization).expect(200)).body;
    expect(none).toMatchObject({ runId: null, started: 0, responded: 0, questions: [] });
    // A Viewer cannot see an unlaunched (draft) survey at all, results included.
    await request(t.server).get(`/api/v1/surveys/${empty.id}/results`).set('Authorization', viewer.authorization).expect(404);
  });

  it('breakdowns use the frozen analysis snapshot and suppress small cohorts for non-admins (R48)', async () => {
    const adminView = (await request(t.server).get(`/api/v1/surveys/${surveyId}/breakdowns?dimension=city`).set('Authorization', admin.authorization).expect(200)).body;
    expect(adminView.thresholdApplied).toBe(false);
    const q1 = adminView.questions[0];
    expect(q1.cohorts.map((cohort: { label: string; respondents: number; suppressed: boolean }) => [cohort.label, cohort.respondents, cohort.suppressed])).toEqual([
      ['Karachi', 2, false],
      ['Lahore', 3, false],
    ]);
    const lahore = q1.cohorts.find((cohort: { label: string }) => cohort.label === 'Lahore');
    expect(lahore.options.map((option: { count: number; percentage: number }) => [option.count, option.percentage])).toEqual([
      [3, 100],
      [0, 0],
    ]);
    const viewerView = (await request(t.server).get(`/api/v1/surveys/${surveyId}/breakdowns?dimension=city`).set('Authorization', viewer.authorization).expect(200)).body;
    expect(viewerView.thresholdApplied).toBe(true);
    expect(viewerView.questions[0].cohorts.every((cohort: { suppressed: boolean; respondents: number | null; options: unknown[] }) => cohort.suppressed && cohort.respondents === null && cohort.options.length === 0)).toBe(true);
    // Later profile changes do not move historical distributions.
    await request(t.server).patch(`/api/v1/contacts/${people['P1']}`).set('Authorization', manager.authorization).send({ city: 'Quetta' }).expect(200);
    const after = (await request(t.server).get(`/api/v1/surveys/${surveyId}/breakdowns?dimension=city`).set('Authorization', admin.authorization).expect(200)).body;
    expect(after.questions[0].cohorts.map((cohort: { label: string; respondents: number }) => [cohort.label, cohort.respondents])).toEqual([
      ['Karachi', 2],
      ['Lahore', 3],
    ]);
    const gender = (await request(t.server).get(`/api/v1/surveys/${surveyId}/breakdowns?dimension=gender`).set('Authorization', admin.authorization).expect(200)).body;
    expect(gender.questions[0].cohorts.map((cohort: { label: string }) => cohort.label)).toEqual(['Man', 'Woman', 'Unknown / not provided']);
  });

  it('only Admin can read identifiable answers and revision history; access is audited (R06, R49)', async () => {
    await request(t.server).get(`/api/v1/surveys/${surveyId}/responses`).set('Authorization', manager.authorization).expect(403);
    await request(t.server).get(`/api/v1/surveys/${surveyId}/responses`).set('Authorization', viewer.authorization).expect(403);
    await request(t.server).get(`/api/v1/surveys/${surveyId}/dispatch`).set('Authorization', viewer.authorization).expect(403);
    const responses = (await request(t.server).get(`/api/v1/surveys/${surveyId}/responses?search=P4`).set('Authorization', admin.authorization).expect(200)).body;
    expect(responses.total).toBe(1);
    const p4 = responses.items[0];
    expect(p4.contactName).toBe('=P4');
    expect(p4.answers[0].selections[0].code).toBe('NO');
    expect(p4.answers[0].currentRevisionNumber).toBe(2);
    expect(p4.answers[0].revisions.map((revision: { revisionNumber: number; selections: { code: string }[] }) => [revision.revisionNumber, revision.selections[0].code])).toEqual([
      [1, 'YES'],
      [2, 'NO'],
    ]);
    const audit = (await request(t.server).get('/api/v1/audit?action=responses.viewed').set('Authorization', admin.authorization).expect(200)).body;
    expect(audit.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit.items)).not.toContain('NO');
    expect(JSON.stringify(audit.items)).not.toContain('923002000004');
  });

  it('exports reconcile with results, neutralize formulas and keep phones as text (R50)', async () => {
    const csv = await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/aggregates?format=csv`).set('Authorization', viewer.authorization).expect(200);
    expect(csv.headers['cache-control']).toBe('no-store');
    const rows = parseCsvDomain(csv.text).rows;
    const header = rows[0];
    const legal = rows.find((row) => row[header.indexOf('option_label')] === 'Legal aid');
    expect(legal?.[header.indexOf('count')]).toBe('3');
    expect(legal?.[header.indexOf('percentage_of_respondents')]).toBe('75');
    expect(csv.text).not.toContain('923002000001');
    await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/responses?format=csv`).set('Authorization', manager.authorization).expect(403);
    await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/revisions?format=xlsx`).set('Authorization', viewer.authorization).expect(403);
    const responses = await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/responses?format=csv`).set('Authorization', admin.authorization).expect(200);
    const responseRows = parseCsvDomain(responses.text).rows;
    const responseHeader = responseRows[0];
    const p4Rows = responseRows.filter((row) => row[responseHeader.indexOf('contact_name')] === "'=P4");
    expect(p4Rows.filter((row) => row[responseHeader.indexOf('question_position')] === '1').map((row) => row[responseHeader.indexOf('option_code')])).toEqual(['NO']);
    expect(p4Rows.filter((row) => row[responseHeader.indexOf('question_position')] === '2')).toHaveLength(2);
    expect(p4Rows[0][responseHeader.indexOf('phone')]).toBe('+923002000004');
    const revisions = await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/revisions?format=xlsx`).set('Authorization', admin.authorization).buffer(true).parse(binaryParser).expect(200);
    const workbook = readXlsxDomain(new Uint8Array(revisions.body as Buffer));
    expect(workbook.ok).toBe(true);
    if (workbook.ok) {
      const sheet = workbook.sheets[0];
      const head = sheet.rows[0].map((cell) => cell.text);
      const p4Revisions = sheet.rows.slice(1).filter((row) => row[head.indexOf('contact_name')]?.text === "'=P4" && row[head.indexOf('question_position')]?.text === '1');
      expect(p4Revisions.map((row) => [row[head.indexOf('revision_number')]?.text, row[head.indexOf('option_code')]?.text, row[head.indexOf('is_current')]?.text])).toEqual([
        ['1', 'YES', 'no'],
        ['2', 'NO', 'yes'],
      ]);
      expect(p4Revisions[0][head.indexOf('phone')]).toMatchObject({ text: '+923002000004', isNumeric: false });
    }
    const breakdown = await request(t.server).get(`/api/v1/surveys/${surveyId}/exports/breakdowns?format=csv&dimension=city`).set('Authorization', viewer.authorization).expect(200);
    const breakdownRows = parseCsvDomain(breakdown.text).rows;
    expect(breakdownRows.slice(1).every((row) => row[breakdownRows[0].indexOf('respondents')] === 'suppressed')).toBe(true);
    const audit = (await request(t.server).get('/api/v1/audit?action=export.generated').set('Authorization', admin.authorization).expect(200)).body;
    expect(audit.total).toBeGreaterThanOrEqual(4);
  });

  it('shares one fixed snapshot after closure with consented real respondents only (R51-R54)', async () => {
    await request(t.server).post(`/api/v1/surveys/${surveyId}/results-preview`).set('Authorization', manager.authorization).expect(403);
    const early = (await request(t.server).post(`/api/v1/surveys/${surveyId}/results-preview`).set('Authorization', admin.authorization).expect(200)).body;
    expect(early.canShare).toBe(false);
    expect(early.reason).toContain('closed');
    await request(t.server).post(`/api/v1/surveys/${surveyId}/share-results`).set('Authorization', admin.authorization).send({ confirm: true }).expect(409);
    await request(t.server).post(`/api/v1/surveys/${surveyId}/close`).set('Authorization', manager.authorization).expect(200);
    // P2's service window is long closed: the results invitation must use a template (R52).
    await t.prisma.conversation.update({ where: { organizationId_contactId: { organizationId: orgId, contactId: people['P2'] } }, data: { lastInboundAt: new Date('2026-10-08T00:00:00Z') } });
    // P3 withdrew survey invitations only: results sharing has its own permission scope and still reaches them.
    await request(t.server).post(`/api/v1/contacts/${people['P3']}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-09T00:00:00Z', evidenceReference: 'Call' }).expect(201);
    const preview = (await request(t.server).post(`/api/v1/surveys/${surveyId}/results-preview`).set('Authorization', admin.authorization).expect(200)).body;
    expect(preview).toMatchObject({ canShare: true, eligibleRecipients: 3, excluded: { RESULTS_CONSENT_MISSING: 2 }, minimumRespondents: 5, alreadyShared: false });
    expect(preview.questions.map((question: { shareable: boolean }) => question.shareable)).toEqual([true, false, false]);
    expect(preview.summaryPreview.join('\n')).toContain("Not enough responses to share this question's results.");
    const shared = (await request(t.server).post(`/api/v1/surveys/${surveyId}/share-results`).set('Authorization', admin.authorization).set('Idempotency-Key', 'share-1').send({ confirm: true }).expect(200)).body;
    expect(shared.snapshot).toMatchObject({ eligibleCount: 3, suppressedCount: 2, questionsShared: 1, questionsSuppressed: 2, broadcastState: 'COMPLETED' });
    expect(shared.recipients.total).toBe(3);
    const again = (await request(t.server).post(`/api/v1/surveys/${surveyId}/share-results`).set('Authorization', admin.authorization).set('Idempotency-Key', 'share-2').send({ confirm: true }).expect(200)).body;
    expect(again.snapshot.id).toBe(shared.snapshot.id);
    expect(await t.prisma.resultSnapshot.count({ where: { surveyId } })).toBe(1);
    expect(await t.prisma.message.count({ where: { kind: 'RESULTS_INVITATION', snapshotId: shared.snapshot.id } })).toBe(3);
    const snapshot = await t.prisma.resultSnapshot.findUniqueOrThrow({ where: { id: shared.snapshot.id } });
    const aggregateText = JSON.stringify(snapshot.aggregate);
    for (const forbidden of ['P1', 'P2', 'P3', '923002', 'Lahore', 'Karachi', 'WOMAN', 'participationId', 'contactId']) expect(aggregateText).not.toContain(forbidden);
    const aggregate = snapshot.aggregate as { questions: { shareable: boolean; options: unknown[]; validAnswers: number }[] };
    expect(aggregate.questions[1]).toMatchObject({ shareable: false, options: [], validAnswers: 0 });
    // The sender is disabled when the notices leave the worker: every notice is suppressed and the
    // recipients show it; an Admin-authorized retry that is accepted makes them invited again.
    await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ enabled: false }).expect(200);
    await drainJobs(t);
    expect((await request(t.server).get(`/api/v1/surveys/${surveyId}/result-sharing`).set('Authorization', admin.authorization).expect(200)).body.recipients.byState).toEqual({ SUPPRESSED: 3 });
    expect(await t.prisma.resultRecipient.count({ where: { snapshotId: shared.snapshot.id, accessState: 'SUPPRESSED', suppressionReason: 'CONNECTION_DISABLED' } })).toBe(3);
    await request(t.server).patch('/api/v1/messaging/configuration').set('Authorization', admin.authorization).send({ enabled: true }).expect(200);
    for (const message of await t.prisma.message.findMany({ where: { kind: 'RESULTS_INVITATION', snapshotId: shared.snapshot.id } })) {
      await request(t.server).post(`/api/v1/messages/${message.id}/retry`).set('Authorization', admin.authorization).send({}).expect(202);
    }
    await drainJobs(t);
    expect((await request(t.server).get(`/api/v1/surveys/${surveyId}/result-sharing`).set('Authorization', admin.authorization).expect(200)).body.recipients.byState).toEqual({ INVITED: 3 });
    // A delivery failure the provider reports after acceptance is evidence on the message, not a loss of access:
    // P3 can still ask for the results.
    const p3Invite = await t.prisma.message.findFirstOrThrow({ where: { kind: 'RESULTS_INVITATION', contactId: people['P3'] } });
    await t.prisma.message.update({ where: { id: p3Invite.id }, data: { deliveryState: 'SENT' } });
    expect(await t.app.get(DeliveryService).recordStatus(orgId, p3Invite.connectionId, { phoneNumberId: '', providerMessageId: p3Invite.providerMessageId ?? '', recipientIdentity: null, status: 'FAILED', providerAt: new Date(t.clock.now().getTime() + 5000), errorCode: '131026', errorTitle: 'Message undeliverable' })).toBe('RECORDED');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: p3Invite.id } })).toMatchObject({ state: 'ACCEPTED', deliveryState: 'FAILED' });
    expect((await t.prisma.resultRecipient.findFirstOrThrow({ where: { invitationMessageId: p3Invite.id } })).accessState).toBe('INVITED');
    await sim('text', { contactId: people['P3'], text: 'RESULTS' }).expect(200);
    await drainJobs(t);
    expect((await outbound(people['P3'])).filter((message) => message.kind === 'RESULTS_CONTENT').length).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.resultRecipient.findFirstOrThrow({ where: { invitationMessageId: p3Invite.id } })).accessState).toBe('VIEWED');
    const p2Invite = await t.prisma.message.findFirstOrThrow({ where: { kind: 'RESULTS_INVITATION', contactId: people['P2'] } });
    expect((p2Invite.rendered as { type: string }).type).toBe('template');
    expect(p2Invite.state).toBe('ACCEPTED');
    const p1Invite = await t.prisma.message.findFirstOrThrow({ where: { kind: 'RESULTS_INVITATION', contactId: people['P1'] } });
    expect((p1Invite.rendered as { type: string }).type).toBe('buttons');
    // Every recipient the preview counted as eligible was actually sent to, P3 included.
    expect((await t.prisma.message.findFirstOrThrow({ where: { kind: 'RESULTS_INVITATION', contactId: people['P3'] } })).state).toBe('ACCEPTED');
    expect(await t.prisma.message.count({ where: { kind: 'RESULTS_INVITATION', snapshotId: shared.snapshot.id, state: 'ACCEPTED' } })).toBe(preview.eligibleRecipients);
    // P1 requests the results: the bound snapshot is delivered as chunked text (R52).
    await tap(people['P1'], 'View results');
    const content = (await outbound(people['P1'])).filter((message) => message.kind === 'RESULTS_CONTENT');
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0].text).toContain('Results of "Reporting survey" shared by Org A (5 respondents)');
    expect(content[0].text).toContain('Yes: 60.0% (3)');
    expect(content[0].text).toContain("Not enough responses to share this question's results.");
    expect(content[0].state).toBe('ACCEPTED');
    const recipient = await t.prisma.resultRecipient.findFirstOrThrow({ where: { snapshotId: shared.snapshot.id, contactId: people['P1'] } });
    expect(recipient.accessState).toBe('VIEWED');
    // Withdrawing survey invitations alone keeps the shared results reachable: P2's View results still works.
    await request(t.server).post(`/api/v1/contacts/${people['P2']}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-10-09T12:00:00Z', evidenceReference: 'Call' }).expect(201);
    await tap(people['P2'], 'View results');
    expect((await outbound(people['P2'])).filter((message) => message.kind === 'RESULTS_CONTENT').map((message) => message.state)).toContain('ACCEPTED');
    expect((await t.prisma.resultRecipient.findFirstOrThrow({ where: { snapshotId: shared.snapshot.id, contactId: people['P2'] } })).accessState).toBe('VIEWED');
    // RESULTS command lists shared snapshots; non-recipients get nothing.
    await sim('text', { contactId: people['P1'], text: 'RESULTS' }).expect(200);
    await drainJobs(t);
    expect((await outbound(people['P1'])).filter((message) => message.kind === 'RESULTS_CONTENT').length).toBeGreaterThanOrEqual(2);
    await sim('text', { contactId: people['=P4'], text: 'RESULTS' }).expect(200);
    await drainJobs(t);
    expect([...(await outbound(people['=P4']))].pop()?.text).toContain('No shared results');
    const status = (await request(t.server).get(`/api/v1/surveys/${surveyId}/result-sharing`).set('Authorization', manager.authorization).expect(200)).body;
    expect(status.recipients.byState).toEqual({ VIEWED: 3 });
    expect(status.recipients.byDelivery).toMatchObject({ FAILED: 1 });
  });

  it('revoking cancels the result notices still queued and a revoked snapshot is refused at send time (R51, R53)', async () => {
    // Five respondents who can still be invited (P2 and P3 withdrew invitations above), so the first question
    // clears the minimum sample; P5 never granted results permission, so four notices are queued.
    const respondents = ['P1', 'P5', 'P6', 'P7', 'P8'];
    const created = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({ internalTitle: 'Revocation survey', title: { en: 'Revocation survey' }, introduction: { en: 'Intro' }, questions: QUESTIONS, audience: { mode: 'SELECTED', contactIds: respondents.map((name) => people[name]) } }).expect(201)).body;
    const id: string = created.id;
    await request(t.server).post(`/api/v1/surveys/${id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200);
    await drainJobs(t);
    for (const name of respondents) {
      await tap(people[name], 'Start survey', (message) => message.kind === 'INVITATION');
      if ((await outbound(people[name])).some((message) => message.kind === 'PROFILE_OFFER' && message.controls.length > 0)) await tap(people[name], 'Skip');
      await tap(people[name], 'Yes', (message) => message.text.includes('Question 1 of 3'));
    }
    await request(t.server).post(`/api/v1/surveys/${id}/close`).set('Authorization', manager.authorization).expect(200);
    const shared = (await request(t.server).post(`/api/v1/surveys/${id}/share-results`).set('Authorization', admin.authorization).send({ confirm: true }).expect(200)).body;
    const snapshotId: string = shared.snapshot.id;
    expect(shared.snapshot).toMatchObject({ eligibleCount: 4, suppressedCount: 1 });
    const queued = await t.prisma.message.findMany({ where: { kind: 'RESULTS_INVITATION', snapshotId }, orderBy: { createdAt: 'asc' } });
    expect(queued.map((message) => message.state)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    const noticeOf = (name: string) => {
      const notice = queued.find((message) => message.contactId === people[name]);
      if (!notice) throw new Error(`no notice for ${name}`);
      return notice;
    };
    const runner = t.app.get(JobRunner);
    // Process one inbound message and send only the replies it produced, leaving the queued notices untouched.
    const converse = async (name: string, text: string) => {
      const { eventId } = (await sim('text', { contactId: people[name], text }).expect(200)).body as { eventId: string };
      expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${eventId}` } })).id)).toBe('DONE');
      for (const reply of await t.prisma.message.findMany({ where: { contactId: people[name], state: 'PENDING', kind: { not: 'RESULTS_INVITATION' } } })) {
        expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${reply.id}` } })).id)).toBe('DONE');
      }
      return [...(await outbound(people[name]))].pop();
    };
    const withdraw = (name: string, scopes: string[], evidenceAt: string) =>
      request(t.server).post(`/api/v1/contacts/${people[name]}/consent-events`).set('Authorization', manager.authorization).send({ scopes, type: 'WITHDRAWN', evidenceAt, evidenceReference: 'Call' }).expect(201);
    // P6 withdraws survey invitations only: the queued results notice and its job stay, results permission is intact.
    await withdraw('P6', ['SURVEY_INVITATIONS'], '2026-10-09T12:00:00Z');
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: noticeOf('P6').id } })).state).toBe('PENDING');
    expect((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${noticeOf('P6').id}` } })).status).toBe('PENDING');
    // P1 has two shared surveys, so RESULTS queues a menu; an invitation-only withdrawal while it is queued leaves
    // the menu, its View results controls and the queued notice alone.
    const { eventId: menuEvent } = (await sim('text', { contactId: people['P1'], text: 'RESULTS' }).expect(200)).body as { eventId: string };
    expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${menuEvent}` } })).id)).toBe('DONE');
    const menu = await t.prisma.message.findUniqueOrThrow({ where: { dedupeKey: resultsReplyKey('menu', menuEvent) } });
    expect(menu.state).toBe('PENDING');
    await withdraw('P1', ['SURVEY_INVITATIONS'], '2026-10-09T12:30:00Z');
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: menu.id } })).state).toBe('PENDING');
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: noticeOf('P1').id } })).state).toBe('PENDING');
    expect(await t.prisma.actionBinding.count({ where: { contactId: people['P1'], purpose: 'VIEW_RESULTS', expiresAt: { gt: t.clock.now() } } })).toBeGreaterThanOrEqual(2);
    expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${menu.id}` } })).id)).toBe('DONE');
    const sentMenu = [...(await outbound(people['P1']))].pop();
    expect(sentMenu).toMatchObject({ kind: 'COMMAND_REPLY', state: 'ACCEPTED' });
    expect(sentMenu?.controls).toHaveLength(2);
    // A results-only withdrawal cancels a queued results menu together with the queued notice, and a respondent
    // without current results permission gets the not-eligible reply, never a menu of titles.
    const { eventId: secondMenuEvent } = (await sim('text', { contactId: people['P1'], text: 'RESULTS' }).expect(200)).body as { eventId: string };
    expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${secondMenuEvent}` } })).id)).toBe('DONE');
    const secondMenu = await t.prisma.message.findUniqueOrThrow({ where: { dedupeKey: resultsReplyKey('menu', secondMenuEvent) } });
    expect(secondMenu.state).toBe('PENDING');
    await withdraw('P1', ['SURVEY_RESULTS'], '2026-10-09T12:40:00Z');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: secondMenu.id } })).toMatchObject({ state: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: noticeOf('P1').id } })).toMatchObject({ state: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect(await t.prisma.resultRecipient.findFirstOrThrow({ where: { snapshotId, contactId: people['P1'] } })).toMatchObject({ accessState: 'SUPPRESSED', suppressionReason: 'CONTACT_WITHDRAWN' });
    const denied = await converse('P1', 'RESULTS');
    expect(denied?.text).toContain('no longer available');
    expect(denied?.controls ?? []).toHaveLength(0);
    await request(t.server).post(`/api/v1/contacts/${people['P1']}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-10-09T12:50:00Z', evidenceReference: 'Signed form', reviewedNewEvidence: true }).expect(201);
    // A results withdrawal that arrives while a RESULTS command is being processed. The processing holds the contact
    // lock from before it reads the permission until it has queued the menu, so the withdrawal waits for it and then
    // cancels that menu and expires its controls; nothing built on the earlier read can leave. The processing is held
    // here at its conversation update, after the permission read, until the withdrawal is seen waiting for the lock.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lockWaiters = async () => (await t.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]?.waiting ?? 0;
    const untilLockWaiters = async (count: number) => {
      for (let i = 0; i < 300 && (await lockWaiters()) < count; i += 1) await sleep(10);
    };
    let releaseConversation: () => void = () => undefined;
    const conversationHeld = new Promise<void>((resolve) => {
      releaseConversation = resolve;
    });
    const holdingConversation = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM conversations WHERE contact_id = ${people['P1']}::uuid FOR UPDATE`;
        await conversationHeld;
      },
      { timeout: 20_000 },
    );
    for (let i = 0; i < 300; i += 1) {
      const free = await t.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM conversations WHERE contact_id = ${people['P1']}::uuid FOR UPDATE SKIP LOCKED`;
      if (free.length === 0) break;
      await sleep(10);
    }
    const { eventId: racedEvent } = (await sim('text', { contactId: people['P1'], text: 'RESULTS' }).expect(200)).body as { eventId: string };
    const processing = runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${racedEvent}` } })).id);
    await untilLockWaiters(1);
    const withdrawing = withdraw('P1', ['SURVEY_RESULTS'], '2026-10-09T12:55:00Z').then((response) => response.status);
    await untilLockWaiters(2);
    releaseConversation();
    await holdingConversation;
    expect(await processing).toBe('DONE');
    expect(await withdrawing).toBe(201);
    const racedMenu = await t.prisma.message.findUniqueOrThrow({ where: { dedupeKey: resultsReplyKey('menu', racedEvent) } });
    expect(racedMenu).toMatchObject({ kind: 'COMMAND_REPLY', state: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${racedMenu.id}` } })).status).toBe('CANCELED');
    expect(await t.prisma.messageAttempt.count({ where: { messageId: racedMenu.id } })).toBe(0);
    expect(await t.prisma.actionBinding.count({ where: { contactId: people['P1'], purpose: { in: ['VIEW_RESULTS', 'MENU_SELECT'] }, expiresAt: { gt: t.clock.now() } } })).toBe(0);
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: people['P1'] } })).consentResults).toBe('WITHDRAWN');
    await request(t.server).post(`/api/v1/contacts/${people['P1']}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-10-09T12:58:00Z', evidenceReference: 'Signed form', reviewedNewEvidence: true }).expect(201);
    // A queued reply about a survey (P8's HELP answer) is canceled by an invitation-only withdrawal; the notice stays.
    const { eventId: helpEvent } = (await sim('text', { contactId: people['P8'], text: 'HELP' }).expect(200)).body as { eventId: string };
    expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `inbound:${helpEvent}` } })).id)).toBe('DONE');
    const helpReply = await t.prisma.message.findFirstOrThrow({ where: { contactId: people['P8'], kind: 'COMMAND_REPLY', state: 'PENDING' } });
    await withdraw('P8', ['SURVEY_INVITATIONS'], '2026-10-09T12:45:00Z');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: helpReply.id } })).toMatchObject({ state: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: noticeOf('P8').id } })).state).toBe('PENDING');
    // P7 withdraws results permission while the notice is queued: the notice is canceled and the recipient marked;
    // valid new evidence restores access to the already-shared results without another notice.
    await withdraw('P7', ['SURVEY_RESULTS'], '2026-10-09T13:00:00Z');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: noticeOf('P7').id } })).toMatchObject({ state: 'CANCELED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${noticeOf('P7').id}` } })).status).toBe('CANCELED');
    expect(await t.prisma.resultRecipient.findFirstOrThrow({ where: { snapshotId, contactId: people['P7'] } })).toMatchObject({ accessState: 'SUPPRESSED', suppressionReason: 'CONTACT_WITHDRAWN' });
    expect((await converse('P7', 'RESULTS'))?.text).toContain('no longer available');
    expect((await outbound(people['P7'])).filter((message) => message.kind === 'RESULTS_CONTENT')).toHaveLength(0);
    await request(t.server).post(`/api/v1/contacts/${people['P7']}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-10-09T14:00:00Z', evidenceReference: 'Signed form', reviewedNewEvidence: true }).expect(201);
    expect((await converse('P7', 'RESULTS'))?.kind).toBe('RESULTS_CONTENT');
    expect((await outbound(people['P7'])).filter((message) => message.kind === 'RESULTS_CONTENT' && message.state === 'ACCEPTED').length).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.resultRecipient.findFirstOrThrow({ where: { snapshotId, contactId: people['P7'] } })).accessState).toBe('VIEWED');
    // A revocation that commits while a worker is handing a notice over: the hand-off holds a share lock on the
    // snapshot, so the revocation waits for the worker's claim and the policy recheck inside the hand-off sees it.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revocation = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM result_snapshots WHERE id = ${snapshotId}::uuid FOR UPDATE`;
        await tx.resultSnapshot.update({ where: { id: snapshotId }, data: { revokedAt: t.clock.now() } });
        await released;
      },
      { timeout: 20_000 },
    );
    for (let i = 0; i < 300; i += 1) {
      const free = await t.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM result_snapshots WHERE id = ${snapshotId}::uuid FOR UPDATE SKIP LOCKED`;
      if (free.length === 0) break;
      await sleep(10);
    }
    const raced = noticeOf('P8');
    const handoff = runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${raced.id}` } })).id);
    for (let i = 0; i < 300; i += 1) {
      const [row] = await t.prisma.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) > 0) break;
      await sleep(10);
    }
    release();
    await revocation;
    expect(await handoff).toBe('DONE');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: raced.id } })).toMatchObject({ state: 'SUPPRESSED', suppressionReason: 'RESULTS_REVOKED' });
    expect(await t.prisma.messageAttempt.findMany({ where: { messageId: raced.id } })).toEqual([expect.objectContaining({ outcome: 'FAILED', errorCode: 'RESULTS_REVOKED' })]);
    expect(await t.prisma.resultRecipient.findFirstOrThrow({ where: { invitationMessageId: raced.id } })).toMatchObject({ accessState: 'SUPPRESSED', suppressionReason: 'RESULTS_REVOKED' });
    // A notice a worker picks up once the revocation is committed is refused before any attempt.
    const late = noticeOf('P6');
    expect(await runner.runJob((await t.prisma.job.findUniqueOrThrow({ where: { dedupeKey: `send:${late.id}` } })).id)).toBe('DONE');
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ state: 'SUPPRESSED', suppressionReason: 'RESULTS_REVOKED' });
    expect(await t.prisma.messageAttempt.count({ where: { messageId: late.id } })).toBe(0);
    // The Admin's revocation finds nothing left to cancel (P1's notice went with the results withdrawal) and records that.
    const revoked = (await request(t.server).post(`/api/v1/surveys/${id}/result-sharing/revoke`).set('Authorization', admin.authorization).expect(200)).body;
    expect(revoked.snapshot.broadcastState).toBe('REVOKED');
    expect(revoked.recipients.byState).toEqual({ SUPPRESSED: 3, VIEWED: 1 });
    const audit = await t.prisma.auditEvent.findFirst({ where: { organizationId: orgId, action: 'results.revoked', resourceId: id } });
    expect(audit?.metadata).toMatchObject({ snapshotId, canceledInvitations: 0, canceledJobs: 0 });
    await drainJobs(t);
    // No notice of this broadcast ever left: two refused at send time, two canceled by withdrawals before a worker saw them.
    const states = (await t.prisma.message.findMany({ where: { snapshotId, kind: 'RESULTS_INVITATION' }, select: { state: true } })).map((message) => message.state).sort();
    expect(states).toEqual(['CANCELED', 'CANCELED', 'SUPPRESSED', 'SUPPRESSED']);
    expect(await t.prisma.messageAttempt.count({ where: { message: { snapshotId, kind: 'RESULTS_INVITATION' }, outcome: { not: 'FAILED' } } })).toBe(0);
    // Revoking the first survey's snapshot as well leaves P1 with nothing to list.
    const revokedFirst = (await request(t.server).post(`/api/v1/surveys/${surveyId}/result-sharing/revoke`).set('Authorization', admin.authorization).expect(200)).body;
    expect(revokedFirst.snapshot.revokedAt).not.toBeNull();
    await sim('text', { contactId: people['P1'], text: 'RESULTS' }).expect(200);
    await drainJobs(t);
    expect([...(await outbound(people['P1']))].pop()?.text).toContain('No shared results');
  });

  it('the page control of a results menu follows results permission like View results (R51)', async () => {
    // Ten shared surveys would page the results menu; the menu is built directly here because the suite has two snapshots.
    const snapshots = await t.prisma.resultSnapshot.findMany({ where: { organizationId: orgId }, select: { id: true } });
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    const planner = t.app.get(MessagePlanner);
    const delivery = t.app.get(DeliveryService);
    const db = createTenantDb(t.prisma, orgId);
    const items = Array.from({ length: 10 }, (_, index) => ({ label: `Shared survey ${index + 1}`, purpose: 'VIEW_RESULTS' as const, snapshotId: snapshots[index % snapshots.length].id }));
    const buildMenu = async (key: string) => {
      const message = await db.$transaction(async (tx) => {
        const rendered = await planner.menu(tx, { organizationId: orgId, contact: { id: people['P1'], connectionId: connection.id }, mode: 'LIVE', body: 'Which results?', buttonText: 'Results', items, expiresAt: new Date(t.clock.now().getTime() + 86_400_000) });
        return delivery.createMessage(tx, { organizationId: orgId, connectionId: connection.id, contactId: people['P1'], kind: 'COMMAND_REPLY', rendered, dedupeKey: resultsReplyKey('menu', key) });
      });
      await drainJobs(t);
      const next = await t.prisma.actionBinding.findFirstOrThrow({ where: { contactId: people['P1'], purpose: 'MENU_SELECT', expiresAt: { gt: t.clock.now() } }, orderBy: { createdAt: 'desc' } });
      expect(next.payload).toMatchObject({ menu: 'next', page: 1, results: true });
      return { messageId: message.id, next };
    };
    const withdraw = (scopes: string[], evidenceAt: string) =>
      request(t.server).post(`/api/v1/contacts/${people['P1']}/consent-events`).set('Authorization', manager.authorization).send({ scopes, type: 'WITHDRAWN', evidenceAt, evidenceReference: 'Call' }).expect(201);
    const liveControls = () => t.prisma.actionBinding.count({ where: { contactId: people['P1'], purpose: { in: ['VIEW_RESULTS', 'MENU_SELECT'] }, expiresAt: { gt: t.clock.now() } } });
    // Withdrawing survey invitations leaves the results menu's controls, including its page control, alive; the next page is served.
    const first = await buildMenu('page-1');
    await withdraw(['SURVEY_INVITATIONS'], '2026-10-09T15:00:00Z');
    expect(await liveControls()).toBe(10);
    await tap(people['P1'], 'Next page', (message) => message.id === first.messageId);
    const page = [...(await outbound(people['P1']))].pop();
    expect(page).toMatchObject({ kind: 'COMMAND_REPLY', state: 'ACCEPTED' });
    expect(page?.text).toBe('Which results would you like to see?');
    expect(page?.controls).toHaveLength(1);
    // Withdrawing results expires the page control with the View results controls (the served page added one row control).
    const beforeSecond = await liveControls();
    const second = await buildMenu('page-2');
    expect(await liveControls()).toBe(beforeSecond + 10);
    await withdraw(['SURVEY_RESULTS'], '2026-10-09T15:30:00Z');
    expect(await liveControls()).toBe(0);
    expect((await t.prisma.actionBinding.findUniqueOrThrow({ where: { id: second.next.id } })).expiresAt.getTime()).toBeLessThanOrEqual(t.clock.now().getTime());
    // A page control that is still live is refused for a respondent without results permission.
    const third = await buildMenu('page-3');
    const pagesBefore = await t.prisma.message.count({ where: { contactId: people['P1'], dedupeKey: { startsWith: 'results-menu:' } } });
    await tap(people['P1'], 'Next page', (message) => message.id === third.messageId);
    expect([...(await outbound(people['P1']))].pop()?.text).toContain('no longer available');
    expect(await t.prisma.message.count({ where: { contactId: people['P1'], dedupeKey: { startsWith: 'results-menu:' } } })).toBe(pagesBefore);
  });

  it('retention cleanup removes staged imports, raw webhooks and quarantine without touching answers (R56)', async () => {
    const answersBefore = await t.prisma.answer.count();
    const past = new Date('2026-10-01T00:00:00Z');
    const batch = await t.prisma.importBatch.create({ data: { organizationId: orgId, actorUserId: admin.userId, fileName: 'x.csv', fileType: 'CSV', fileSize: 10, rawBytes: new Uint8Array([1, 2, 3]), rawExpiresAt: past, state: 'PREVIEWED' } });
    await t.prisma.importRow.create({ data: { organizationId: orgId, batchId: batch.id, rowNumber: 2, status: 'ERROR', normalized: { name: 'x', phoneE164: '+923000000000' } } });
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    const event = await t.prisma.inboundEvent.create({ data: { organizationId: orgId, connectionId: connection.id, providerMessageId: 'wamid.old', senderIdentity: '923002000001', kind: 'TEXT', normalized: { kind: 'TEXT', text: 'HELP' }, providerAt: past, rawPayload: { secret: 'raw' }, rawExpiresAt: past, processingState: 'PROCESSED' } });
    await t.prisma.webhookQuarantine.create({ data: { appKey: 'k', reason: 'UNKNOWN', rawPayload: {}, expiresAt: past } });
    const result = await t.app.get(RetentionService).run();
    expect(result).toMatchObject({ importBatchesPurged: 1, importRowsDeleted: 1, quarantineDeleted: 1 });
    expect(result.rawWebhooksCleared).toBeGreaterThanOrEqual(1);
    const purged = await t.prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(purged).toMatchObject({ rawBytes: null, state: 'EXPIRED' });
    expect((await t.prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).rawPayload).toBeNull();
    expect(await t.prisma.answer.count()).toBe(answersBefore);
  });
});
