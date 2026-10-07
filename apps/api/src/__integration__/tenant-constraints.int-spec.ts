import { createTenantDb } from '@raaye/server';
import { bootTestApp, resetDatabase, seedOrganization, type TestApp } from '../testing/harness';

describe('tenant-qualified database constraints (R07, R08, R09)', () => {
  let t: TestApp;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    t = await bootTestApp();
    await resetDatabase(t.prisma);
    orgA = (await seedOrganization(t.prisma, 'Org A')).id;
    orgB = (await seedOrganization(t.prisma, 'Org B')).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('allows the same phone number in two organizations with independent records (R08)', async () => {
    const a = await t.prisma.contact.create({ data: { organizationId: orgA, name: 'Same Person', phoneE164: '+923001234567' } });
    const b = await t.prisma.contact.create({ data: { organizationId: orgB, name: 'Same Person', phoneE164: '+923001234567' } });
    expect(a.id).not.toBe(b.id);
    await expect(
      t.prisma.contact.create({ data: { organizationId: orgA, name: 'Duplicate', phoneE164: '+923001234567' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await t.prisma.consentEvent.create({
      data: { organizationId: orgA, contactId: a.id, scope: 'SURVEY_INVITATIONS', type: 'GRANTED', source: 'STAFF_RECORDED', evidenceAt: new Date() },
    });
    expect(await t.prisma.consentEvent.count({ where: { contactId: b.id } })).toBe(0);
  });

  it('rejects cross-tenant and cross-question references at the database level (R09)', async () => {
    const contactA = await t.prisma.contact.create({ data: { organizationId: orgA, name: 'A', phoneE164: '+923000000001' } });
    const groupB = await t.prisma.group.create({ data: { organizationId: orgB, name: 'B Group', normalizedName: 'b group' } });
    // Contact of A cannot join a group of B even when the row claims organization B.
    await expect(
      t.prisma.contactGroup.create({ data: { organizationId: orgB, contactId: contactA.id, groupId: groupB.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      t.prisma.contactGroup.create({ data: { organizationId: orgA, contactId: contactA.id, groupId: groupB.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });

    const survey = await t.prisma.survey.create({ data: { organizationId: orgA, internalTitle: 'S' } });
    const revision = await t.prisma.surveyRevision.create({
      data: {
        organizationId: orgA,
        surveyId: survey.id,
        revisionNumber: 1,
        title: { en: 'S' },
        introduction: { en: 'Intro' },
        editWindowSeconds: 120,
        durationSeconds: 172800,
        audienceDefinition: { mode: 'EVERYONE' },
      },
    });
    const q1 = await t.prisma.question.create({
      data: { organizationId: orgA, revisionId: revision.id, position: 0, type: 'SINGLE_CHOICE', preset: 'YES_NO', prompt: { en: 'Q1' } },
    });
    const q2 = await t.prisma.question.create({
      data: { organizationId: orgA, revisionId: revision.id, position: 1, type: 'SINGLE_CHOICE', preset: 'YES_NO', prompt: { en: 'Q2' } },
    });
    const q1Yes = await t.prisma.questionOption.create({ data: { organizationId: orgA, questionId: q1.id, code: 'YES', position: 0, label: { en: 'Yes' } } });
    const q2Yes = await t.prisma.questionOption.create({ data: { organizationId: orgA, questionId: q2.id, code: 'YES', position: 0, label: { en: 'Yes' } } });
    const run = await t.prisma.surveyRun.create({
      data: {
        organizationId: orgA,
        surveyId: survey.id,
        revisionId: revision.id,
        kind: 'LIVE',
        liveSlot: 1,
        state: 'ACTIVE',
        opensAt: new Date(),
        closesAt: new Date(Date.now() + 1000 * 3600),
        audienceDefinition: { mode: 'EVERYONE' },
        audienceSummary: {},
      },
    });
    // A second LIVE run for the same survey is impossible.
    await expect(
      t.prisma.surveyRun.create({
        data: {
          organizationId: orgA,
          surveyId: survey.id,
          revisionId: revision.id,
          kind: 'LIVE',
          liveSlot: 1,
          state: 'ACTIVE',
          opensAt: new Date(),
          closesAt: new Date(Date.now() + 1000 * 3600),
          audienceDefinition: { mode: 'EVERYONE' },
          audienceSummary: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const participation = await t.prisma.participation.create({
      data: { organizationId: orgA, runId: run.id, revisionId: revision.id, contactId: contactA.id, startedAt: new Date() },
    });
    const answer = await t.prisma.answer.create({
      data: {
        organizationId: orgA,
        participationId: participation.id,
        revisionId: revision.id,
        questionId: q1.id,
        firstAcceptedAt: new Date(),
        editExpiresAt: new Date(),
        currentRevisionNumber: 1,
        currentReceivedAt: new Date(),
      },
    });
    const answerRevision = await t.prisma.answerRevision.create({
      data: { organizationId: orgA, answerId: answer.id, questionId: q1.id, revisionNumber: 1, acceptedAt: new Date(), receivedAt: new Date(), source: 'BUTTON' },
    });
    // Selecting an option from another question of the same tenant is rejected.
    await expect(
      t.prisma.answerSelection.create({ data: { organizationId: orgA, answerRevisionId: answerRevision.id, questionId: q1.id, optionId: q2Yes.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await t.prisma.answerSelection.create({ data: { organizationId: orgA, answerRevisionId: answerRevision.id, questionId: q1.id, optionId: q1Yes.id } });
    // A revision for question 2 cannot hang off an answer for question 1.
    await expect(
      t.prisma.answerRevision.create({
        data: { organizationId: orgA, answerId: answer.id, questionId: q2.id, revisionNumber: 2, acceptedAt: new Date(), receivedAt: new Date(), source: 'BUTTON' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    // Organization B cannot reference A's question even with its own participation.
    const contactB = await t.prisma.contact.create({ data: { organizationId: orgB, name: 'B', phoneE164: '+923000000002' } });
    await expect(
      t.prisma.participation.create({ data: { organizationId: orgB, runId: run.id, revisionId: revision.id, contactId: contactB.id, startedAt: new Date() } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('the tenant-scoped client cannot reach another organization (R07)', async () => {
    const contactB = await t.prisma.contact.create({ data: { organizationId: orgB, name: 'Hidden', phoneE164: '+923000000099' } });
    const dbA = createTenantDb(t.prisma, orgA);
    expect(await dbA.contact.findUnique({ where: { id: contactB.id } })).toBeNull();
    expect(await dbA.contact.findMany({ where: { phoneE164: '+923000000099' } })).toEqual([]);
    expect(await dbA.contact.count({ where: { id: contactB.id } })).toBe(0);
    expect((await dbA.contact.updateMany({ where: { id: contactB.id }, data: { name: 'Changed' } })).count).toBe(0);
    await expect(dbA.contact.update({ where: { id: contactB.id }, data: { name: 'Changed' } })).rejects.toMatchObject({ code: 'P2025' });
    const created = await dbA.contact.create({ data: { organizationId: orgB, name: 'Forced', phoneE164: '+923000000098' } });
    expect(created.organizationId).toBe(orgA);
    // Interactive transactions keep the scope.
    await dbA.$transaction(async (tx) => {
      expect(await tx.contact.findFirst({ where: { id: contactB.id } })).toBeNull();
      expect(await tx.organization.findUnique({ where: { id: orgB } })).toBeNull();
    });
    await expect(dbA.user.findMany()).rejects.toThrow(/not tenant-owned/);
  });
});
