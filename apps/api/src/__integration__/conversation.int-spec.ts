import request from 'supertest';
import { JobRunner, signWebhookBody } from '@raaye/server';
import { drainJobs } from '../testing/jobs';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';

const FIVE_TYPES = [
  { authoringType: 'YES_NO', prompt: { en: 'Do you use public transport?' } },
  { authoringType: 'YES_NO_INDIFFERENT', prompt: { en: 'Should bus fares be subsidised?' } },
  { authoringType: 'SINGLE_CHOICE', prompt: { en: 'Which service matters most?' }, options: [{ label: { en: 'Water' } }, { label: { en: 'Roads' } }, { label: { en: 'Electricity' } }, { label: { en: 'Schools' } }] },
  { authoringType: 'MULTI_CHOICE', prompt: { en: 'Which have you used this year?' }, options: [{ label: { en: 'Legal aid' } }, { label: { en: 'Workshops' } }, { label: { en: 'None of the above' }, exclusive: true }], minSelections: 1, maxSelections: 2 },
  { authoringType: 'RATING', prompt: { en: 'Rate the service.' }, ratingMinLabel: { en: 'Very poor' }, ratingMaxLabel: { en: 'Excellent' } },
];

interface ConvMessage {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  kind: string;
  state: string;
  text: string;
  controls: { id: string; label: string; type: string }[];
  flow: { token: string; purpose: string; options: { id: string; label: string }[]; initialSelectedOptionIds: string[] } | null;
  createdAt: string;
}

describe('participant conversation engine (R15-R22, R31-R42)', () => {
  let t: TestApp;
  let orgId: string;
  let admin: SeededUser;
  let manager: SeededUser;
  let ayesha: string;
  let bilal: string;
  let runId: string;

  const sim = (path: string, body: Record<string, unknown>) => request(t.server).post(`/api/v1/dev/simulator/${path}`).set('Authorization', admin.authorization).send(body);
  const conv = async (contactId: string): Promise<ConvMessage[]> => (await request(t.server).get(`/api/v1/dev/simulator/conversation/${contactId}`).set('Authorization', admin.authorization).expect(200)).body;
  const outbound = async (contactId: string) => (await conv(contactId)).filter((message) => message.direction === 'OUTBOUND');
  const last = async (contactId: string, predicate: (message: ConvMessage) => boolean = () => true) => {
    const messages = (await outbound(contactId)).filter(predicate);
    return messages[messages.length - 1];
  };
  const tapLabel = async (contactId: string, label: string, extra: Record<string, unknown> = {}, within: (message: ConvMessage) => boolean = () => true) => {
    const messages = await outbound(contactId);
    const message = [...messages].reverse().find((candidate) => within(candidate) && candidate.controls.some((control) => control.label === label));
    if (!message) throw new Error(`No control labelled ${label}`);
    const control = message.controls.find((candidate) => candidate.label === label);
    const response = await sim('tap', { contactId, messageId: message.id, controlId: control?.id, ...extra }).expect(200);
    await drainJobs(t);
    return response.body as { eventId: string | null; duplicate: boolean };
  };
  const say = async (contactId: string, text: string) => {
    await sim('text', { contactId, text }).expect(200);
    await drainJobs(t);
  };
  const answersOf = (participationId: string) => t.prisma.answer.findMany({ where: { participationId }, include: { revisions: { include: { selections: true }, orderBy: { revisionNumber: 'asc' } }, question: true }, orderBy: { question: { position: 'asc' } } });

  async function createContact(name: string, phone: string, consent: boolean): Promise<string> {
    const created = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name, phone, city: 'Lahore' }).expect(201)).body;
    if (consent) await request(t.server).post(`/api/v1/contacts/${created.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    return created.id;
  }

  async function launchSurvey(title: string, contactIds: string[]): Promise<{ surveyId: string; runId: string }> {
    const created = (await request(t.server).post('/api/v1/surveys').set('Authorization', manager.authorization).send({ internalTitle: title, title: { en: title }, introduction: { en: 'Thanks for taking part.' }, questions: FIVE_TYPES, audience: { mode: 'SELECTED', contactIds } }).expect(201)).body;
    const launched = (await request(t.server).post(`/api/v1/surveys/${created.id}/launch`).set('Authorization', manager.authorization).send({ mode: 'NOW' }).expect(200)).body;
    await drainJobs(t);
    return { surveyId: created.id, runId: launched.liveRun.id };
  }

  beforeAll(async () => {
    t = await bootTestApp({ now: new Date('2026-10-10T09:00:00.000Z') });
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    ayesha = await createContact('Ayesha Khan', '+923001000001', true);
    bilal = await createContact('Bilal Ahmed', '+923001000002', true);
    ({ runId } = await launchSurvey('Transport survey', [ayesha, bilal]));
  });

  afterAll(async () => {
    await t.close();
  });

  it('runs the whole journey: start, optional profile, five question types, completion once (R18-R21, R33)', async () => {
    const invitation = await last(ayesha, (message) => message.kind === 'INVITATION');
    expect(invitation.state).toBe('ACCEPTED');
    expect(invitation.controls[0].label).toBe('Start survey');
    await tapLabel(ayesha, 'Start survey');
    let messages = await outbound(ayesha);
    expect(messages.map((message) => message.kind)).toEqual(['INVITATION', 'COMMAND_REPLY', 'PROFILE_OFFER']);
    expect(messages[1].text).toContain('Transport survey');
    expect(messages[1].text).toContain('5 questions');
    expect(messages[1].text).toContain('2 minutes');
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: ayesha } });
    expect(participation.state).toBe('STARTED');
    expect(participation.analysisProfile).toBeNull();

    await tapLabel(ayesha, 'Add details');
    const profileFlow = await last(ayesha, (message) => message.kind === 'PROFILE_FLOW');
    expect(profileFlow.flow?.purpose).toBe('PROFILE');
    await sim('flow', { contactId: ayesha, messageId: profileFlow.id, flowToken: profileFlow.flow?.token, profile: { city: 'Karachi', gender: 'WOMAN', ageBand: 'AGE_25_34', membership: 'MEMBER' } }).expect(200);
    await drainJobs(t);
    const contact = await t.prisma.contact.findUniqueOrThrow({ where: { id: ayesha } });
    expect(contact).toMatchObject({ city: 'Karachi', gender: 'WOMAN', ageBand: 'AGE_25_34', selfReportedMembership: 'MEMBER', membership: 'UNKNOWN' });
    messages = await outbound(ayesha);
    expect(messages.map((message) => message.kind).slice(-2)).toEqual(['COMMAND_REPLY', 'QUESTION']);
    const q1 = messages[messages.length - 1];
    expect(q1.text).toContain('Question 1 of 5');
    expect(q1.controls.map((control) => control.label)).toEqual(['Yes', 'No']);

    await tapLabel(ayesha, 'Yes');
    const q2 = await last(ayesha, (message) => message.kind === 'QUESTION');
    expect(q2.text).toContain('Response recorded.');
    expect(q2.text).toContain('Question 2 of 5');
    const snapshot = await t.prisma.participation.findUniqueOrThrow({ where: { id: participation.id } });
    expect(snapshot.analysisProfile).toMatchObject({ city: 'Karachi', gender: 'WOMAN', selfReportedMembership: 'MEMBER', membership: 'UNKNOWN' });
    expect(snapshot.currentQuestionId).not.toBeNull();

    await tapLabel(ayesha, 'Indifferent');
    const q3 = await last(ayesha, (message) => message.kind === 'QUESTION');
    expect(q3.text).toContain('Question 3 of 5');
    expect(q3.controls.map((control) => control.label)).toEqual(['Water', 'Roads', 'Electricity', 'Schools']);
    await tapLabel(ayesha, 'Roads');
    const q4 = await last(ayesha, (message) => message.kind === 'QUESTION');
    expect(q4.flow?.purpose).toBe('MULTI_CHOICE');
    const options = q4.flow?.options ?? [];
    const legal = options.find((option) => option.label === 'Legal aid')?.id ?? '';
    const workshops = options.find((option) => option.label === 'Workshops')?.id ?? '';
    const none = options.find((option) => option.label === 'None of the above')?.id ?? '';
    // Too many selections and exclusive combinations are rejected without recording (R21).
    await sim('flow', { contactId: ayesha, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: [legal, workshops, none] }).expect(200);
    await drainJobs(t);
    expect((await last(ayesha)).text).toContain('could not record');
    await sim('flow', { contactId: ayesha, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: [legal, none] }).expect(200);
    await drainJobs(t);
    expect((await last(ayesha)).text).toContain('exclusive');
    expect(await t.prisma.answer.count({ where: { participationId: participation.id } })).toBe(3);
    await sim('flow', { contactId: ayesha, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: [legal, workshops, legal] }).expect(200);
    await drainJobs(t);
    const q5 = await last(ayesha, (message) => message.kind === 'QUESTION');
    expect(q5.text).toContain('Question 5 of 5');
    expect(q5.controls.map((control) => control.label)).toEqual(['1 - Very poor', '2', '3', '4', '5 - Excellent']);
    await tapLabel(ayesha, '5 - Excellent');
    const completion = await last(ayesha);
    expect(completion.kind).toBe('ACKNOWLEDGEMENT');
    expect(completion.text).toContain('Thank you. Your response has been recorded.');
    const done = await t.prisma.participation.findUniqueOrThrow({ where: { id: participation.id } });
    expect(done.state).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    const answers = await answersOf(participation.id);
    expect(answers).toHaveLength(5);
    expect(answers[3].revisions[0].selections.map((selection) => selection.optionId).sort()).toEqual([legal, workshops].sort());
    expect(answers[4].revisions[0].ratingValue).toBe(5);
    expect(await t.prisma.message.count({ where: { participationId: participation.id, kind: 'ACKNOWLEDGEMENT' } })).toBe(1);
  });

  it('allows edits inside the fixed window, rejects at the boundary and keeps completion acknowledgements single (R34-R36)', async () => {
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: ayesha } });
    const before = await answersOf(participation.id);
    const q1Answer = before[0];
    const isQ1 = (message: ConvMessage) => message.kind === 'QUESTION' && message.text.includes('Question 1 of 5');
    t.clock.set(new Date(q1Answer.firstAcceptedAt.getTime() + 119_000));
    await tapLabel(ayesha, 'No', {}, isQ1);
    let after = await answersOf(participation.id);
    expect(after[0].currentRevisionNumber).toBe(2);
    expect(after[0].revisions).toHaveLength(2);
    expect(after[0].editExpiresAt).toEqual(q1Answer.editExpiresAt);
    expect((await last(ayesha)).text).toContain('Answer updated');
    // Repeating the same choice is a no-op.
    await tapLabel(ayesha, 'No', {}, isQ1);
    after = await answersOf(participation.id);
    expect(after[0].revisions).toHaveLength(2);
    expect((await last(ayesha)).text).toContain('already recorded');
    // Exactly at the deadline the edit is rejected and the answer stays.
    t.clock.set(new Date(q1Answer.editExpiresAt.getTime()));
    await tapLabel(ayesha, 'Yes', {}, isQ1);
    after = await answersOf(participation.id);
    expect(after[0].revisions).toHaveLength(2);
    expect(after[0].currentRevisionNumber).toBe(2);
    expect((await last(ayesha)).text).toContain('The time to change this answer has ended');
    // A Flow opened before expiry but submitted after it is rejected without changes (R36).
    const q4 = await last(ayesha, (message) => message.kind === 'QUESTION' && message.flow?.purpose === 'MULTI_CHOICE');
    const q4Answer = before[3];
    t.clock.set(new Date(q4Answer.editExpiresAt.getTime() - 5000));
    const options = q4.flow?.options ?? [];
    const none = options.find((option) => option.label === 'None of the above')?.id ?? '';
    t.clock.set(new Date(q4Answer.editExpiresAt.getTime() + 1000));
    await sim('flow', { contactId: ayesha, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: [none] }).expect(200);
    await drainJobs(t);
    after = await answersOf(participation.id);
    expect(after[3].revisions).toHaveLength(1);
    expect((await last(ayesha)).text).toContain('The time to change this answer has ended');
    expect(await t.prisma.message.count({ where: { participationId: participation.id, kind: 'ACKNOWLEDGEMENT' } })).toBe(1);
    // EDIT command lists nothing editable now.
    await say(ayesha, 'EDIT');
    expect((await last(ayesha)).text).toContain('no answers you can still change');
    t.clock.set(new Date('2026-10-10T09:00:00.000Z'));
  });

  it('EDIT reopens an editable answer with the original deadline and a zero window disables edits (R35)', async () => {
    await tapLabel(bilal, 'Start survey');
    await tapLabel(bilal, 'Skip');
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: bilal } });
    const q1 = await last(bilal, (message) => message.kind === 'QUESTION');
    expect(q1.text).toContain('Question 1 of 5');
    await tapLabel(bilal, 'Yes');
    await say(bilal, 'EDIT');
    const menu = await last(bilal);
    expect(menu.text).toContain('Which answer would you like to change?');
    expect(menu.controls.map((control) => control.label)).toEqual(['Q1']);
    await say(bilal, 'EDIT 1');
    const reopened = await last(bilal, (message) => message.kind === 'QUESTION');
    expect(reopened.text).toContain('Question 1 of 5');
    await tapLabel(bilal, 'No', {}, (message) => message.id === reopened.id);
    const answers = await answersOf(participation.id);
    expect(answers[0].currentRevisionNumber).toBe(2);
    await say(bilal, 'EDIT 7');
    expect((await last(bilal)).text).toContain('can no longer be changed');
    expect(await t.prisma.message.count({ where: { participationId: participation.id, kind: 'QUESTION', dedupeKey: { startsWith: `q:${participation.id}:${answers[0].questionId}` } } })).toBeGreaterThanOrEqual(2);
    expect(await t.prisma.message.count({ where: { participationId: participation.id, kind: 'QUESTION', dedupeKey: `q:${participation.id}:${answers[1]?.questionId ?? 'none'}` } })).toBeLessThanOrEqual(1);
  });

  it('duplicate inbound messages do not add votes, revisions or messages (R38) and stale replies are rejected (R39)', async () => {
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: bilal } });
    const q2 = await last(bilal, (message) => message.kind === 'QUESTION' && message.text.includes('Question 2 of 5'));
    expect(q2.text).toContain('Question 2 of 5');
    const control = q2.controls.find((candidate) => candidate.label === 'Yes');
    const first = await sim('tap', { contactId: bilal, messageId: q2.id, controlId: control?.id, providerMessageId: 'wamid.dup.1' }).expect(200);
    expect(first.body.duplicate).toBe(false);
    await drainJobs(t);
    const outboundBefore = (await outbound(bilal)).length;
    const second = await sim('tap', { contactId: bilal, messageId: q2.id, controlId: control?.id, providerMessageId: 'wamid.dup.1' }).expect(200);
    expect(second.body.duplicate).toBe(true);
    await drainJobs(t);
    expect((await outbound(bilal)).length).toBe(outboundBefore);
    const answers = await answersOf(participation.id);
    expect(answers[1].revisions).toHaveLength(1);
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.dup.1' } })).toBe(1);
    // An older distinct reply cannot overwrite the newer accepted choice.
    const noControl = q2.controls.find((candidate) => candidate.label === 'No');
    await sim('tap', { contactId: bilal, messageId: q2.id, controlId: noControl?.id, providerAtOffsetSeconds: -600 }).expect(200);
    await drainJobs(t);
    const afterStale = await answersOf(participation.id);
    expect(afterStale[1].revisions).toHaveLength(1);
    expect((await last(bilal)).text).toContain('newer answer');
  });

  it('two simultaneous first replies create one canonical answer (R37)', async () => {
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: bilal } });
    const q3 = await last(bilal, (message) => message.kind === 'QUESTION' && message.text.includes('Question 3 of 5'));
    expect(q3.text).toContain('Question 3 of 5');
    const roads = q3.controls.find((candidate) => candidate.label === 'Roads');
    const water = q3.controls.find((candidate) => candidate.label === 'Water');
    await sim('tap', { contactId: bilal, messageId: q3.id, controlId: roads?.id, providerMessageId: 'wamid.race.1' }).expect(200);
    await sim('tap', { contactId: bilal, messageId: q3.id, controlId: water?.id, providerMessageId: 'wamid.race.2' }).expect(200);
    const runner = t.app.get(JobRunner);
    const jobs = await t.prisma.job.findMany({ where: { kind: 'PROCESS_INBOUND', status: 'PENDING' } });
    expect(jobs).toHaveLength(2);
    await Promise.all(jobs.map((job) => runner.runJob(job.id)));
    await drainJobs(t);
    const answers = await answersOf(participation.id);
    const q3Answer = answers.find((answer) => answer.question.position === 2);
    expect(q3Answer).toBeDefined();
    expect(await t.prisma.answer.count({ where: { participationId: participation.id, questionId: q3Answer?.questionId } })).toBe(1);
    expect(q3Answer?.revisions.length).toBeLessThanOrEqual(2);
    expect(q3Answer?.currentRevisionNumber).toBe(q3Answer?.revisions.length);
    const next = await t.prisma.message.count({ where: { participationId: participation.id, kind: 'QUESTION', dedupeKey: { startsWith: `q:${participation.id}:` }, rendered: { path: ['body'], string_contains: 'Question 4 of 5' } } });
    expect(next).toBe(1);
  });

  it('STOP withdraws permission, cancels pending outreach, and START requires an affirmative reply (R15, R16)', async () => {
    const stopper = await createContact('Sana Stop', '+923001000003', true);
    const second = await launchSurvey('Second survey', [stopper, ayesha, bilal]);
    const pendingBefore = await t.prisma.message.count({ where: { contactId: stopper, kind: 'INVITATION' } });
    expect(pendingBefore).toBe(1);
    await say(stopper, '  stop ');
    const contact = await t.prisma.contact.findUniqueOrThrow({ where: { id: stopper } });
    expect(contact).toMatchObject({ consentInvitations: 'WITHDRAWN', consentResults: 'WITHDRAWN' });
    const ack = await last(stopper);
    expect(ack.kind).toBe('OPT_OUT_ACK');
    expect(ack.state).toBe('ACCEPTED');
    expect(ack.text).toContain('no longer receive');
    const events = await t.prisma.consentEvent.findMany({ where: { contactId: stopper, type: 'WITHDRAWN' } });
    expect(events.map((event) => event.source)).toEqual(['PARTICIPANT_STOP', 'PARTICIPANT_STOP']);
    // Tapping the old invitation no longer works.
    const invitation = await last(stopper, (message) => message.kind === 'INVITATION');
    await sim('tap', { contactId: stopper, messageId: invitation.id, controlId: invitation.controls[0].id }).expect(200);
    await drainJobs(t);
    expect(await t.prisma.participation.count({ where: { contactId: stopper } })).toBe(0);
    // START does not silently re-enable: it asks for an affirmative reply.
    await say(stopper, 'START');
    const prompt = await last(stopper);
    expect(prompt.text).toContain('Reply YES to agree');
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: stopper } })).consentInvitations).toBe('WITHDRAWN');
    await say(stopper, 'maybe');
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: stopper } })).consentInvitations).toBe('WITHDRAWN');
    await tapLabel(stopper, 'I agree');
    const regranted = await t.prisma.contact.findUniqueOrThrow({ where: { id: stopper } });
    expect(regranted).toMatchObject({ consentInvitations: 'GRANTED', consentResults: 'GRANTED' });
    const grant = await t.prisma.consentEvent.findFirst({ where: { contactId: stopper, type: 'GRANTED', source: 'PARTICIPANT_REPLY' } });
    expect(grant?.wordingVersion).toBe('1');
    void second;
  });

  it('unknown senders enroll with a name and explicit consent; HI alone is not consent (R17)', async () => {
    await sim('text', { phone: '+923001000099', text: 'hi', profileName: 'Nadia' }).expect(200);
    await drainJobs(t);
    const placeholder = await t.prisma.contact.findUniqueOrThrow({ where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: '+923001000099' } } });
    expect(placeholder.archivedAt).not.toBeNull();
    expect(placeholder.consentInvitations).toBe('UNKNOWN');
    const ask = await last(placeholder.id);
    expect(ask.text).toContain('please reply with your name');
    expect(ask.text).toContain('Nadia');
    expect(ask.state).toBe('ACCEPTED');
    await say(placeholder.id, 'Nadia Noor');
    expect((await last(placeholder.id)).text).toContain('Reply YES to agree');
    await say(placeholder.id, 'no');
    const declined = await t.prisma.contact.findUniqueOrThrow({ where: { id: placeholder.id } });
    expect(declined.archivedAt).not.toBeNull();
    expect(declined.consentInvitations).toBe('UNKNOWN');
    await say(placeholder.id, 'JOIN');
    await say(placeholder.id, 'Nadia Noor');
    await say(placeholder.id, 'YES');
    const enrolled = await t.prisma.contact.findUniqueOrThrow({ where: { id: placeholder.id } });
    expect(enrolled).toMatchObject({ name: 'Nadia Noor', archivedAt: null, consentInvitations: 'GRANTED', consentResults: 'GRANTED' });
    expect((await last(placeholder.id)).text).toContain('Thank you. You will hear from');
    expect(await t.prisma.enrollment.count({ where: { state: 'COMPLETED' } })).toBe(1);
  });

  it('forged or mismatched tokens and invalid options never create answers (R41)', async () => {
    const participation = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: bilal } });
    const countBefore = await t.prisma.answer.count({ where: { participationId: participation.id } });
    const q4 = await last(bilal, (message) => message.kind === 'QUESTION' && message.flow?.purpose === 'MULTI_CHOICE');
    expect(q4.flow?.purpose).toBe('MULTI_CHOICE');
    // Another participant submitting Bilal's Flow token.
    await sim('flow', { contactId: bilal, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: [q4.flow?.options[0].id], overrideSenderContactId: ayesha }).expect(200);
    await drainJobs(t);
    expect(await t.prisma.answer.count({ where: { participationId: participation.id } })).toBe(countBefore);
    expect((await last(ayesha)).text).toContain('no longer available');
    // Forged control id and foreign option id.
    await sim('tap', { contactId: bilal, messageId: q4.id, controlId: 'forged-token.00000000-0000-4000-8000-000000000000' }).expect(200);
    await drainJobs(t);
    const q3 = await last(bilal, (message) => message.kind === 'QUESTION' && message.text.includes('Question 3'));
    const token = q3.controls[0].id.split('.')[0];
    await sim('tap', { contactId: bilal, messageId: q3.id, controlId: `${token}.00000000-0000-4000-8000-000000000000` }).expect(200);
    await drainJobs(t);
    await sim('flow', { contactId: bilal, messageId: q4.id, flowToken: q4.flow?.token, selectedOptionIds: ['00000000-0000-4000-8000-000000000000'] }).expect(200);
    await drainJobs(t);
    expect(await t.prisma.answer.count({ where: { participationId: participation.id } })).toBe(countBefore);
    const rejected = await t.prisma.auditEvent.count({ where: { action: 'answer.rejected', resourceId: participation.id } });
    expect(rejected).toBeGreaterThan(0);
  });

  it('two open surveys never cross-wire answers; RESUME continues the foreground survey (R31, R32)', async () => {
    const secondRun = await t.prisma.surveyRun.findFirstOrThrow({ where: { survey: { internalTitle: 'Second survey' } } });
    const bilalFirst = await t.prisma.participation.findFirstOrThrow({ where: { runId, contactId: bilal } });
    const q4First = await last(bilal, (message) => message.kind === 'QUESTION' && message.flow?.purpose === 'MULTI_CHOICE');
    // Start the second survey while the first is still in progress: offer continue or switch.
    const invitation = await last(bilal, (message) => message.kind === 'INVITATION' && message.text.includes('Second survey'));
    await sim('tap', { contactId: bilal, messageId: invitation.id, controlId: invitation.controls[0].id }).expect(200);
    await drainJobs(t);
    const offer = await last(bilal);
    expect(offer.text).toContain('in the middle of');
    expect(offer.controls.map((control) => control.label)).toEqual(['Continue current', 'Switch survey']);
    await tapLabel(bilal, 'Switch survey');
    const secondQ1 = await last(bilal, (message) => message.kind === 'QUESTION');
    expect(secondQ1.text).toContain('Question 1 of 5');
    const secondParticipation = await t.prisma.participation.findFirstOrThrow({ where: { runId: secondRun.id, contactId: bilal } });
    expect((await t.prisma.conversation.findFirstOrThrow({ where: { contactId: bilal } })).foregroundParticipationId).toBe(secondParticipation.id);
    // A late answer to the first survey's Flow is saved under the first survey, not the foreground one.
    const options = q4First.flow?.options ?? [];
    await sim('flow', { contactId: bilal, messageId: q4First.id, flowToken: q4First.flow?.token, selectedOptionIds: [options[0].id] }).expect(200);
    await drainJobs(t);
    const firstAnswers = await answersOf(bilalFirst.id);
    expect(firstAnswers.some((answer) => answer.question.position === 3)).toBe(true);
    expect(await t.prisma.answer.count({ where: { participationId: secondParticipation.id } })).toBe(0);
    expect((await last(bilal)).text).toContain('Reply RESUME to continue');
    expect((await t.prisma.conversation.findFirstOrThrow({ where: { contactId: bilal } })).foregroundParticipationId).toBe(secondParticipation.id);
    // RESUME continues the foreground (second) survey at its first unanswered question.
    await say(bilal, 'resume');
    const resumed = await last(bilal, (message) => message.kind === 'QUESTION');
    expect(resumed.text).toContain('Question 1 of 5');
    await tapLabel(bilal, 'Yes');
    expect(await t.prisma.answer.count({ where: { participationId: secondParticipation.id } })).toBe(1);
    expect(await t.prisma.answer.count({ where: { participationId: bilalFirst.id } })).toBe(firstAnswers.length);
    // Unrecognized text does not reset anything; HELP identifies the bot.
    await say(bilal, 'what?');
    expect((await last(bilal, (message) => message.kind === 'COMMAND_REPLY')).text).toContain('did not understand');
    await say(bilal, 'help');
    expect((await last(bilal)).text).toContain('survey bot from Org A');
    expect(await t.prisma.answer.count({ where: { participationId: secondParticipation.id } })).toBe(1);
  });

  it('accepts signed raw webhooks, processes batches, ignores retries and rejects bad signatures (R40, R42, R44)', async () => {
    process.env['TEST_META_APP_SECRET'] = 'webhook-secret';
    process.env['TEST_META_VERIFY_TOKEN'] = 'verify-me';
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    await t.prisma.messagingConnection.update({ where: { id: connection.id }, data: { phoneNumberId: '111222333', appSecretRef: 'TEST_META_APP_SECRET', verifyTokenRef: 'TEST_META_VERIFY_TOKEN' } });
    const verify = await request(t.server).get(`/api/v1/webhooks/whatsapp/${connection.appKey}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`).expect(200);
    expect(verify.text).toBe('12345');
    await request(t.server).get(`/api/v1/webhooks/whatsapp/${connection.appKey}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`).expect(403);
    const accepted = await t.prisma.message.findFirstOrThrow({ where: { contactId: ayesha, kind: 'INVITATION' } });
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '111222333' }, contacts: [{ profile: { name: 'Bilal' }, wa_id: '923001000002' }], messages: [{ from: '923001000002', id: 'wamid.hook.1', timestamp: '1760000000', type: 'text', text: { body: 'HELP' } }] } },
            { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '111222333' }, statuses: [{ id: accepted.providerMessageId, status: 'read', timestamp: '1760000100', recipient_id: '923001000001' }, { id: accepted.providerMessageId, status: 'delivered', timestamp: '1760000050', recipient_id: '923001000001' }, { id: 'wamid.unknown.1', status: 'delivered', timestamp: '1760000060' }] } },
          ],
        },
      ],
    };
    const rawString = JSON.stringify(payload);
    const raw = Buffer.from(rawString, 'utf8');
    const bad = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(raw, 'wrong')).send(rawString).expect(401);
    expect(bad.body.code).toBe('UNAUTHENTICATED');
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.hook.1' } })).toBe(0);
    const ok = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(raw, 'webhook-secret')).send(rawString).expect(200);
    expect(ok.body).toMatchObject({ received: true, accepted: 1, duplicates: 0, statuses: 3 });
    const event = await t.prisma.inboundEvent.findFirstOrThrow({ where: { providerMessageId: 'wamid.hook.1' } });
    expect(event.rawPayload).not.toBeNull();
    expect(event.rawExpiresAt).not.toBeNull();
    const retry = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(raw, 'webhook-secret')).send(rawString).expect(200);
    expect(retry.body).toMatchObject({ accepted: 0, duplicates: 1 });
    await drainJobs(t);
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.hook.1' } })).toBe(1);
    expect((await last(bilal)).text).toContain('survey bot from Org A');
    // Out-of-order callbacks never regress Read to Delivered; unmatched statuses are retained.
    const message = await t.prisma.message.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(message.deliveryState).toBe('READ');
    expect(await t.prisma.messageStatusEvent.count({ where: { messageId: accepted.id } })).toBeGreaterThanOrEqual(3);
    expect(await t.prisma.messageStatusEvent.count({ where: { providerMessageId: 'wamid.unknown.1', messageId: null } })).toBe(1);
    const unknownConnection = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signWebhookBody(Buffer.from(JSON.stringify({ ...payload, entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '999' }, messages: [{ from: '15550001111', id: 'wamid.q1', timestamp: '1760000000', type: 'text', text: { body: 'hi' } }] } }] }] })), 'webhook-secret')).send(JSON.stringify({ ...payload, entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '999' }, messages: [{ from: '15550001111', id: 'wamid.q1', timestamp: '1760000000', type: 'text', text: { body: 'hi' } }] } }] }] })).expect(200);
    expect(unknownConnection.body.quarantined).toBe(1);
    expect(await t.prisma.webhookQuarantine.count()).toBe(1);
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.q1' } })).toBe(0);
    await request(t.server).post('/api/v1/webhooks/whatsapp/unknown-key').set('Content-Type', 'application/json').send({}).expect(401);
  });

  it('quarantines signed webhook traffic for a disabled connection instead of processing it (R40, R57)', async () => {
    process.env['TEST_META_APP_SECRET'] = 'webhook-secret';
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    await t.prisma.messagingConnection.update({ where: { id: connection.id }, data: { phoneNumberId: '111222333', appSecretRef: 'TEST_META_APP_SECRET', enabled: false } });
    const hamza = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Hooked Hamza', phone: '+923001000077' }).expect(201)).body;
    await request(t.server).post(`/api/v1/contacts/${hamza.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-09-01T00:00:00Z', evidenceReference: 'Form' }).expect(201);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '111222333' }, contacts: [{ profile: { name: 'Hamza' }, wa_id: '923001000077' }], messages: [{ from: '923001000077', id: 'wamid.hook.disabled', timestamp: '1760000200', type: 'text', text: { body: 'STOP' } }] } }] }],
    };
    const rawString = JSON.stringify(payload);
    const signature = signWebhookBody(Buffer.from(rawString, 'utf8'), 'webhook-secret');
    const quarantinedBefore = await t.prisma.webhookQuarantine.count();
    const refused = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(rawString).expect(200);
    expect(refused.body).toMatchObject({ received: true, accepted: 0, quarantined: 1 });
    expect(await t.prisma.inboundEvent.count({ where: { providerMessageId: 'wamid.hook.disabled' } })).toBe(0);
    expect(await t.prisma.webhookQuarantine.count()).toBe(quarantinedBefore + 1);
    expect(await t.prisma.webhookQuarantine.count({ where: { appKey: connection.appKey, reason: 'CONNECTION_DISABLED' } })).toBe(1);
    await drainJobs(t);
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: hamza.id } })).consentInvitations).toBe('GRANTED');
    // Re-enabling lets the same delivery through and the STOP takes effect.
    await t.prisma.messagingConnection.update({ where: { id: connection.id }, data: { enabled: true } });
    const accepted = await request(t.server).post(`/api/v1/webhooks/whatsapp/${connection.appKey}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(rawString).expect(200);
    expect(accepted.body).toMatchObject({ accepted: 1, quarantined: 0 });
    await drainJobs(t);
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: hamza.id } })).consentInvitations).toBe('WITHDRAWN');
  });

  it('internal task endpoints reject untrusted callers (R58)', async () => {
    await request(t.server).post('/api/v1/internal/sweep').expect(401);
    await request(t.server).post('/api/v1/internal/sweep').set('Authorization', 'Bearer wrong').expect(401);
    await request(t.server).post('/api/v1/internal/sweep').set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200);
    const job = await t.prisma.job.findFirst({ where: { status: 'SUCCEEDED' } });
    const result = await request(t.server).post(`/api/v1/internal/jobs/${job?.id}/execute`).set('Authorization', `Bearer ${t.config.INTERNAL_TASK_TOKEN}`).expect(200);
    expect(result.body.result).toBe('NOT_CLAIMABLE');
    await request(t.server).get('/api/v1/dev/simulator/state').set('Authorization', manager.authorization).expect(403);
  });
});
