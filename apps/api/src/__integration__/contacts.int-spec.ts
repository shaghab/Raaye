import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildXlsx, deriveConsent, parseCsv, readXlsx } from '@raaye/domain';
import { ConsentService, RetentionService } from '@raaye/server';
import request from 'supertest';
import { bootTestApp, resetDatabase, seedOrganization, seedUser, type SeededUser, type TestApp } from '../testing/harness';
import { binaryParser } from '../testing/http';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures/imports');

describe('contacts, consent and imports (R10-R14, R50)', () => {
  let t: TestApp;
  let orgId: string;
  let otherOrgId: string;
  let manager: SeededUser;
  let admin: SeededUser;
  let viewer: SeededUser;
  let otherAdmin: SeededUser;

  beforeAll(async () => {
    t = await bootTestApp();
    await resetDatabase(t.prisma);
    orgId = (await seedOrganization(t.prisma, 'Org A')).id;
    otherOrgId = (await seedOrganization(t.prisma, 'Org B')).id;
    manager = await seedUser(t.prisma, orgId, 'SURVEY_MANAGER');
    admin = await seedUser(t.prisma, orgId, 'ADMIN');
    viewer = await seedUser(t.prisma, orgId, 'VIEWER');
    otherAdmin = await seedUser(t.prisma, otherOrgId, 'ADMIN');
  });

  afterAll(async () => {
    await t.close();
  });

  it('manual creation requires name and phone and grants no consent (R10)', async () => {
    const missing = await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: '  ', phone: '' }).expect(400);
    expect(missing.body.code).toBe('VALIDATION_FAILED');
    expect(missing.body.fieldErrors.map((error: { path: string }) => error.path)).toEqual(expect.arrayContaining(['name', 'phone']));
    const created = await request(t.server)
      .post('/api/v1/contacts')
      .set('Authorization', manager.authorization)
      .send({ name: 'Ayesha Khan', phone: '0300-1234567', city: 'Lahore', gender: 'WOMAN' })
      .expect(201);
    expect(created.body.phoneE164).toBe('+923001234567');
    expect(created.body.consent).toMatchObject({ invitations: 'UNKNOWN', results: 'UNKNOWN' });
    const duplicate = await request(t.server)
      .post('/api/v1/contacts')
      .set('Authorization', manager.authorization)
      .send({ name: 'Again', phone: '+92 300 1234567' })
      .expect(409);
    expect(duplicate.body.code).toBe('CONTACT_DUPLICATE');
    await request(t.server).post('/api/v1/contacts').set('Authorization', viewer.authorization).send({ name: 'X', phone: '+923001234568' }).expect(403);
    const invalidPhone = await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'X', phone: '12345' }).expect(422);
    expect(invalidPhone.body.code).toBe('PHONE_INVALID');
  });

  it('records consent with scope, source, dates, wording version and actor (R14)', async () => {
    const contact = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Consent Person', phone: '+923001234570' }).expect(201)).body;
    const events = (
      await request(t.server)
        .post(`/api/v1/contacts/${contact.id}/consent-events`)
        .set('Authorization', manager.authorization)
        .send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt: '2026-09-01T10:00:00Z', wordingVersion: 'v1', evidenceReference: 'Signed form #12' })
        .expect(201)
    ).body;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'GRANTED', source: 'STAFF_RECORDED', wordingVersion: 'v1', evidenceReference: 'Signed form #12', actorEmail: manager.email });
    const detail = (await request(t.server).get(`/api/v1/contacts/${contact.id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(detail.consent).toMatchObject({ invitations: 'GRANTED', results: 'GRANTED', invitationsEvidenceAt: '2026-09-01T10:00:00.000Z' });

    // Withdrawal, then an older grant cannot re-enable; a reviewed newer grant can.
    await request(t.server)
      .post(`/api/v1/contacts/${contact.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt: '2026-09-05T10:00:00Z', evidenceReference: 'Phone call' })
      .expect(201);
    const withdrawn = (await request(t.server).get(`/api/v1/contacts/${contact.id}`).set('Authorization', manager.authorization)).body;
    expect(withdrawn.consent.invitations).toBe('WITHDRAWN');
    const notReviewed = await request(t.server)
      .post(`/api/v1/contacts/${contact.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-06T10:00:00Z', evidenceReference: 'New form' })
      .expect(400);
    expect(notReviewed.body.message).toContain('reviewed new evidence');
    await request(t.server)
      .post(`/api/v1/contacts/${contact.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-02T10:00:00Z', evidenceReference: 'Old form', reviewedNewEvidence: true })
      .expect(400);
    await request(t.server)
      .post(`/api/v1/contacts/${contact.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-06T10:00:00Z', evidenceReference: 'New form', reviewedNewEvidence: true })
      .expect(201);
    const regranted = (await request(t.server).get(`/api/v1/contacts/${contact.id}`).set('Authorization', manager.authorization)).body;
    expect(regranted.consent.invitations).toBe('GRANTED');
  });

  it('phone changes require confirmation and reset consent for the new number', async () => {
    const contact = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Mover', phone: '+923001234580' }).expect(201)).body;
    await request(t.server)
      .post(`/api/v1/contacts/${contact.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS'], type: 'GRANTED', evidenceAt: '2026-09-01T10:00:00Z', evidenceReference: 'Form' })
      .expect(201);
    await request(t.server).patch(`/api/v1/contacts/${contact.id}`).set('Authorization', manager.authorization).send({ phone: '+923001234581' }).expect(400);
    // The old number wrote to the organization moments ago: an open service window and a pending prompt.
    const connection = await t.prisma.messagingConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    await t.prisma.conversation.create({ data: { organizationId: orgId, contactId: contact.id, connectionId: connection.id, lastInboundAt: t.clock.now(), pendingInput: 'EDIT_PICK', pendingContext: { questionIds: [] } } });
    const changed = (await request(t.server).patch(`/api/v1/contacts/${contact.id}`).set('Authorization', manager.authorization).send({ phone: '+923001234581', confirmPhoneChange: true }).expect(200)).body;
    expect(changed.phoneE164).toBe('+923001234581');
    expect(changed.consent.invitations).toBe('UNKNOWN');
    const conversation = await t.prisma.conversation.findUniqueOrThrow({ where: { organizationId_contactId: { organizationId: orgId, contactId: contact.id } } });
    expect(conversation.lastInboundAt).toBeNull();
    expect(conversation.foregroundParticipationId).toBeNull();
    expect(conversation.pendingInput).toBeNull();
    expect(conversation.pendingContext).toBeNull();
  });

  it('filters, searches, paginates and archives contacts; archived contacts leave the default list', async () => {
    const group = (await request(t.server).post('/api/v1/groups').set('Authorization', manager.authorization).send({ name: 'Members' }).expect(201)).body;
    await request(t.server).post('/api/v1/groups').set('Authorization', manager.authorization).send({ name: 'members' }).expect(409);
    const tag = (await request(t.server).post('/api/v1/tags').set('Authorization', manager.authorization).send({ name: 'pilot' }).expect(201)).body;
    const c1 = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Filter One', phone: '+923001234590', city: 'Lahore', gender: 'WOMAN', ageBand: 'AGE_25_34', groupIds: [group.id], tagIds: [tag.id] }).expect(201)).body;
    const c2 = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Filter Two', phone: '+923001234591', city: 'Karachi', gender: 'MAN' }).expect(201)).body;
    const byCity = (await request(t.server).get('/api/v1/contacts?city=lahore&gender=WOMAN').set('Authorization', manager.authorization).expect(200)).body;
    expect(byCity.items.map((item: { id: string }) => item.id)).toContain(c1.id);
    expect(byCity.items.map((item: { id: string }) => item.id)).not.toContain(c2.id);
    const byGroup = (await request(t.server).get(`/api/v1/contacts?groupId=${group.id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(byGroup.total).toBe(1);
    const search = (await request(t.server).get('/api/v1/contacts?search=1234591').set('Authorization', manager.authorization).expect(200)).body;
    expect(search.items[0].id).toBe(c2.id);
    const page = (await request(t.server).get('/api/v1/contacts?limit=1&offset=0').set('Authorization', manager.authorization).expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    await request(t.server).post(`/api/v1/contacts/${c2.id}/archive`).set('Authorization', manager.authorization).expect(201);
    const active = (await request(t.server).get('/api/v1/contacts?search=Filter').set('Authorization', manager.authorization).expect(200)).body;
    expect(active.items.map((item: { id: string }) => item.id)).not.toContain(c2.id);
    const archived = (await request(t.server).get('/api/v1/contacts?archived=true').set('Authorization', manager.authorization).expect(200)).body;
    expect(archived.items.map((item: { id: string }) => item.id)).toContain(c2.id);
    // Group membership routes and cross-tenant invisibility.
    await request(t.server).post(`/api/v1/groups/${group.id}/contacts/${c2.id}`).set('Authorization', manager.authorization).expect(204);
    await request(t.server).get(`/api/v1/contacts/${c1.id}`).set('Authorization', otherAdmin.authorization).expect(404);
    await request(t.server).post(`/api/v1/groups/${group.id}/contacts/${c1.id}`).set('Authorization', otherAdmin.authorization).expect(404);
    await request(t.server).get('/api/v1/contacts').set('Authorization', viewer.authorization).expect(403);
  });

  it('imports CSV through upload, preview and confirm with correct counts (R11, R12, R13)', async () => {
    const valid = readFileSync(path.join(FIXTURES, 'contacts-valid.csv'));
    const uploaded = (
      await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', valid, 'contacts-valid.csv').expect(201)
    ).body;
    expect(uploaded.state).toBe('UPLOADED');
    expect(uploaded.suggestedMapping).toMatchObject({ name: 'name', phone: 'phone', city: 'city' });
    // Nothing imported yet.
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: '+923001234501' } })).toBe(0);
    const mapping = {
      columns: { name: 'name', phone: 'phone', city: 'city', district: 'district', gender: 'gender', age_band: 'ageBand', age: 'age', age_as_of: 'ageAsOf', occupation: 'occupation', membership: 'membership', groups: 'groups', tags: 'tags', consent_date: 'consentEvidenceAt', consent_reference: 'consentReference' },
      defaultCountry: 'PK',
      duplicateMode: 'SKIP_EXISTING',
      consentAttestation: { scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], source: 'Signed membership forms', collectedAt: '2026-09-01T00:00:00Z', wordingVersion: 'v1', statement: true },
    };
    const preview = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200)).body;
    expect(preview.batch.summary).toMatchObject({ totalRows: 5, create: 5, update: 0, skip: 0, error: 0, consentGrantedRows: 5 });
    expect(preview.rows.map((row: { phoneE164: string }) => row.phoneE164)).toEqual(['+923001234501', '+923001234502', '+923001234503', '+923001234504', '+923001234505']);
    const confirmed = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).set('Idempotency-Key', 'import-valid-1').expect(200)).body;
    expect(confirmed.state).toBe('COMPLETED');
    expect(confirmed.summary).toMatchObject({ create: 5, update: 0, error: 0 });
    const again = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).set('Idempotency-Key', 'import-valid-1').expect(200)).body;
    expect(again.state).toBe('COMPLETED');
    const bilal = await t.prisma.contact.findUnique({ where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: '+923001234502' } }, include: { groups: { include: { group: true } } } });
    expect(bilal).toMatchObject({ name: 'Bilal Ahmed', ageYears: 41, ageBand: 'AGE_35_44', membership: 'NON_MEMBER', consentInvitations: 'GRANTED', consentResults: 'GRANTED' });
    expect(bilal?.groups.map((membership) => membership.group.name)).toEqual(['Volunteers']);
    const batchRow = await t.prisma.importBatch.findUnique({ where: { id: uploaded.id } });
    expect(batchRow?.rawBytes).toBeNull();
    const consent = await t.prisma.consentEvent.findFirst({ where: { contactId: bilal?.id, scope: 'SURVEY_INVITATIONS' } });
    expect(consent).toMatchObject({ source: 'IMPORT_ATTESTATION', wordingVersion: 'v1', evidenceReference: 'Signed form #13', importBatchId: uploaded.id });
    expect(consent?.evidenceAt.toISOString()).toBe('2026-09-02T00:00:00.000Z');

    // Withdraw Bilal, then re-import the same file with updates: no resurrection, older evidence ignored (R13).
    await request(t.server)
      .post(`/api/v1/contacts/${bilal?.id}/consent-events`)
      .set('Authorization', manager.authorization)
      .send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'WITHDRAWN', evidenceAt: '2026-09-10T10:00:00Z', evidenceReference: 'STOP by phone' })
      .expect(201);
    const second = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', valid, 'contacts-valid.csv').expect(201)).body;
    const preview2 = (
      await request(t.server).post(`/api/v1/contact-imports/${second.id}/preview`).set('Authorization', manager.authorization).send({ ...mapping, duplicateMode: 'UPDATE_NON_EMPTY_FIELDS' }).expect(200)
    ).body;
    expect(preview2.batch.summary).toMatchObject({ create: 0, update: 5, withdrawnProtected: 1, consentGrantedRows: 4 });
    await request(t.server).post(`/api/v1/contact-imports/${second.id}/confirm`).set('Authorization', manager.authorization).expect(200);
    const bilalAfter = await t.prisma.contact.findUnique({ where: { id: bilal?.id ?? '' } });
    expect(bilalAfter?.consentInvitations).toBe('WITHDRAWN');
    expect(bilalAfter?.consentResults).toBe('WITHDRAWN');
  });

  it('a failure during processing answers with an error, keeps the applied rows and resumes exactly once per row (R11)', async () => {
    const total = 450;
    const phone = (index: number) => `+9230020${String(index).padStart(5, '0')}`;
    const csv = ['name,phone,groups', ...Array.from({ length: total }, (_, index) => `Bulk Person ${index + 1},${phone(index + 1)},Bulk`)].join('\n');
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), 'bulk.csv').expect(201)).body;
    const mapping = { columns: { name: 'name', phone: 'phone', groups: 'groups' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING', consentAttestation: { scopes: ['SURVEY_INVITATIONS'], source: 'Signed forms', collectedAt: '2026-09-01T00:00:00Z', wordingVersion: 'v1', statement: true } };
    const preview = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200)).body;
    expect(preview.batch.summary).toMatchObject({ totalRows: total, create: total, error: 0 });
    // The database connection drops while the second 200-row chunk is being applied.
    const consent = t.app.get(ConsentService);
    const applyEvents = consent.applyEvents.bind(consent);
    let grants = 0;
    const outage = jest.spyOn(consent, 'applyEvents').mockImplementation(async (tx, contactId, events) => {
      grants += 1;
      if (grants === 201) throw new Error('connection terminated unexpectedly');
      return applyEvents(tx, contactId, events);
    });
    const failed = await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).set('Idempotency-Key', 'import-bulk-1').expect(500);
    outage.mockRestore();
    expect(failed.body.code).toBe('IMPORT_PROCESSING_FAILED');
    expect(failed.body.message).toContain('confirm the import again');
    expect(failed.body.details).toMatchObject({ batchId: uploaded.id, state: 'FAILED', errorMessage: 'connection terminated unexpectedly', summary: { totalRows: total, create: 200, update: 0, skip: 0, error: 0 } });
    const stopped = await t.prisma.importBatch.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(stopped).toMatchObject({ state: 'FAILED', errorMessage: 'connection terminated unexpectedly', rawBytes: null });
    expect(stopped.summary).toMatchObject({ create: 200 });
    // Exactly the first chunk committed: 200 contacts, 200 rows stamped as applied, 250 still pending.
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: { startsWith: '+9230020' } } })).toBe(200);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, appliedAt: { not: null } } })).toBe(200);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, status: 'CREATE', appliedAt: null } })).toBe(250);
    const shown = (await request(t.server).get(`/api/v1/contact-imports/${uploaded.id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(shown).toMatchObject({ state: 'FAILED', resumable: true });
    // Confirming again resumes from the first unapplied row; nothing is applied twice.
    const resumed = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).set('Idempotency-Key', 'import-bulk-2').expect(200)).body;
    expect(resumed).toMatchObject({ state: 'COMPLETED', resumable: false, errorMessage: null });
    expect(resumed.summary).toEqual({ totalRows: total, create: total, update: 0, skip: 0, error: 0, consentGrantedRows: total, withdrawnProtected: 0 });
    const contacts = await t.prisma.contact.findMany({ where: { organizationId: orgId, phoneE164: { startsWith: '+9230020' } }, select: { id: true } });
    expect(contacts).toHaveLength(total);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, status: 'CREATE', appliedAt: { not: null }, contactId: { not: null } } })).toBe(total);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, status: { in: ['SKIP', 'ERROR'] } } })).toBe(0);
    // One consent event per contact and scope, and every contact in the group once.
    expect(await t.prisma.consentEvent.count({ where: { contactId: { in: contacts.map((contact) => contact.id) }, scope: 'SURVEY_INVITATIONS' } })).toBe(total);
    expect(await t.prisma.contactGroup.count({ where: { contactId: { in: contacts.map((contact) => contact.id) } } })).toBe(total);
    const actions = await t.prisma.auditEvent.findMany({ where: { organizationId: orgId, resourceId: uploaded.id }, select: { action: true } });
    expect(actions.map((event) => event.action)).toEqual(expect.arrayContaining(['import.confirmed', 'import.failed', 'import.resumed', 'import.completed']));
    // A completed batch stays completed.
    const again = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200)).body;
    expect(again.state).toBe('COMPLETED');
  });

  it('an import left CONFIRMED by a crash resumes once even when confirmed concurrently, and expired rows report a clear error (R11, R56)', async () => {
    const csv = 'name,phone\nCrash One,+923002100001\nCrash Two,+923002100002\nCrash Three,+923002100003\n';
    const mapping = { columns: { name: 'name', phone: 'phone' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING' };
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), 'crash.csv').expect(201)).body;
    await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200);
    // The API process died right after claiming the batch: CONFIRMED, nothing applied.
    await t.prisma.importBatch.update({ where: { id: uploaded.id }, data: { state: 'CONFIRMED', confirmedAt: t.clock.now() } });
    const shown = (await request(t.server).get(`/api/v1/contact-imports/${uploaded.id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(shown).toMatchObject({ state: 'CONFIRMED', resumable: true, summary: { create: 3 } });
    const [first, second] = await Promise.all([
      request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200),
      request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200),
    ]);
    expect(first.body.state).toBe('COMPLETED');
    expect(second.body.state).toBe('COMPLETED');
    expect(first.body.summary).toMatchObject({ totalRows: 3, create: 3, update: 0, skip: 0, error: 0 });
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: { startsWith: '+9230021' } } })).toBe(3);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, appliedAt: { not: null } } })).toBe(3);
    expect(await t.prisma.auditEvent.count({ where: { organizationId: orgId, resourceId: uploaded.id, action: 'import.completed' } })).toBe(1);

    // A stopped batch whose staged rows passed the retention window cannot be resumed.
    const stale = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from('name,phone\nStale Sana,+923002100009\n'), 'stale.csv').expect(201)).body;
    await request(t.server).post(`/api/v1/contact-imports/${stale.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200);
    await t.prisma.importBatch.update({ where: { id: stale.id }, data: { state: 'CONFIRMED', confirmedAt: t.clock.now(), rawExpiresAt: new Date(t.clock.now().getTime() - 1000) } });
    expect((await request(t.server).get(`/api/v1/contact-imports/${stale.id}`).set('Authorization', manager.authorization).expect(200)).body.resumable).toBe(false);
    const expired = await request(t.server).post(`/api/v1/contact-imports/${stale.id}/confirm`).set('Authorization', manager.authorization).expect(409);
    expect(expired.body.code).toBe('IMPORT_STATE_INVALID');
    expect(expired.body.message).toContain('expired');
    // Retention purges its rows; the batch is reported as expired, not resumable, and nothing was imported.
    await t.app.get(RetentionService).run();
    expect(await t.prisma.importBatch.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ state: 'EXPIRED', rawBytes: null });
    expect(await t.prisma.importRow.count({ where: { batchId: stale.id } })).toBe(0);
    const purged = await request(t.server).post(`/api/v1/contact-imports/${stale.id}/confirm`).set('Authorization', manager.authorization).expect(409);
    expect(purged.body.message).toContain('expired');
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: '+923002100009' } })).toBe(0);

    // Staged rows of stopped and finished batches are purged at the end of the window too, which ends the resume and the error report.
    const stoppedCsv = 'name,phone\nPurged Pari,+923002100010\nBad Row,not-a-number\n';
    const stopped = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(stoppedCsv), 'stopped.csv').expect(201)).body;
    await request(t.server).post(`/api/v1/contact-imports/${stopped.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200);
    await t.prisma.importBatch.update({ where: { id: stopped.id }, data: { state: 'FAILED', confirmedAt: t.clock.now(), errorMessage: 'connection terminated unexpectedly', rawBytes: null, rawExpiresAt: new Date(t.clock.now().getTime() - 1000) } });
    await request(t.server).get(`/api/v1/contact-imports/${stopped.id}/errors`).set('Authorization', manager.authorization).expect(200);
    await t.prisma.importBatch.update({ where: { id: uploaded.id }, data: { rawExpiresAt: new Date(t.clock.now().getTime() - 1000) } });
    await t.app.get(RetentionService).run();
    for (const [id, state] of [[stopped.id, 'FAILED'], [uploaded.id, 'COMPLETED']] as const) {
      const after = await t.prisma.importBatch.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe(state);
      expect(after.stagingPurgedAt).not.toBeNull();
      expect(await t.prisma.importRow.count({ where: { batchId: id } })).toBe(0);
    }
    expect((await t.prisma.importBatch.findUniqueOrThrow({ where: { id: uploaded.id } })).summary).toMatchObject({ create: 3 });
    const purgedDto = (await request(t.server).get(`/api/v1/contact-imports/${stopped.id}`).set('Authorization', manager.authorization).expect(200)).body;
    expect(purgedDto.resumable).toBe(false);
    expect(purgedDto.stagingPurgedAt).not.toBeNull();
    expect((await request(t.server).post(`/api/v1/contact-imports/${stopped.id}/confirm`).set('Authorization', manager.authorization).expect(409)).body.message).toContain('expired');
    const report = await request(t.server).get(`/api/v1/contact-imports/${stopped.id}/errors`).set('Authorization', manager.authorization).expect(409);
    expect(report.body.code).toBe('IMPORT_STATE_INVALID');
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: '+923002100010' } })).toBe(0);
  });

  it('rows applied before the applied_at marker existed are not applied twice on resume (R11, R13)', async () => {
    const existing = await Promise.all(
      ['+923002200001', '+923002200002'].map(async (phone, index) => (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: `Legacy ${index + 1}`, phone }).expect(201)).body as { id: string }),
    );
    const csv = 'name,phone,city\nLegacy One,+923002200001,Lahore\nLegacy Two,+923002200002,Karachi\nLegacy Three,+923002200003,Multan\n';
    const mapping = { columns: { name: 'name', phone: 'phone', city: 'city' }, defaultCountry: 'PK', duplicateMode: 'UPDATE_NON_EMPTY_FIELDS', consentAttestation: { scopes: ['SURVEY_INVITATIONS'], source: 'Signed forms', collectedAt: '2026-09-01T00:00:00Z', wordingVersion: 'v1', statement: true } };
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), 'legacy.csv').expect(201)).body;
    const preview = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200)).body;
    expect(preview.batch.summary).toMatchObject({ create: 1, update: 2, error: 0 });
    const first = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200)).body;
    expect(first.summary).toMatchObject({ create: 1, update: 2, skip: 0, error: 0 });
    const contactIds = [...existing.map((contact) => contact.id), (await t.prisma.contact.findUniqueOrThrow({ where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: '+923002200003' } } })).id];
    expect(await t.prisma.consentEvent.count({ where: { contactId: { in: contactIds } } })).toBe(3);
    // The batch as an upgrade would find it: in flight, every row applied, none stamped.
    await t.prisma.importBatch.update({ where: { id: uploaded.id }, data: { state: 'CONFIRMED', completedAt: null } });
    await t.prisma.importRow.updateMany({ where: { batchId: uploaded.id }, data: { appliedAt: null } });
    expect((await request(t.server).get(`/api/v1/contact-imports/${uploaded.id}`).set('Authorization', manager.authorization).expect(200)).body.resumable).toBe(true);
    const resumed = (await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200)).body;
    expect(resumed.state).toBe('COMPLETED');
    expect(resumed.summary).toMatchObject({ totalRows: 3, create: 1, update: 2, skip: 0, error: 0 });
    // Nothing was applied twice: no extra consent evidence, no reclassified rows, every row stamped.
    expect(await t.prisma.consentEvent.count({ where: { contactId: { in: contactIds } } })).toBe(3);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, appliedAt: { not: null } } })).toBe(3);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, status: 'SKIP' } })).toBe(0);
    const completion = await t.prisma.auditEvent.findFirst({ where: { organizationId: orgId, resourceId: uploaded.id, action: 'import.completed' }, orderBy: { createdAt: 'desc' } });
    expect(completion?.metadata).toMatchObject({ created: 0, updated: 0, alreadyApplied: 3 });
  });

  it('the applied_at migration classifies legacy rows by durable evidence and refuses the rest (R11, R13)', async () => {
    const contact = async (name: string, phone: string) => (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name, phone }).expect(201)).body as { id: string };
    const run = async (file: string, csv: string, attest: boolean) => {
      const mapping = { columns: { name: 'name', phone: 'phone', city: 'city' }, defaultCountry: 'PK', duplicateMode: 'UPDATE_NON_EMPTY_FIELDS', ...(attest ? { consentAttestation: { scopes: ['SURVEY_INVITATIONS'], source: 'Signed forms', collectedAt: '2026-09-01T00:00:00Z', wordingVersion: 'v1', statement: true } } : {}) };
      const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), file).expect(201)).body;
      await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200);
      expect((await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200)).body.state).toBe('COMPLETED');
      return uploaded.id as string;
    };
    const overwritten = await contact('Overwritten Omar', '+923002400001');
    const evidenced = await contact('Evidenced Erum', '+923002400003');
    // Batch A updated Omar and created a contact; batch B then updated Omar again, so Omar's last import is B.
    const a = await run('a.csv', 'name,phone,city\nOverwritten Omar,+923002400001,Lahore\nNew Nadia,+923002400002,Lahore\n', false);
    const b = await run('b.csv', 'name,phone,city\nOverwritten Omar,+923002400001,Karachi\n', false);
    // Batch C granted consent for Erum (durable evidence naming C); batch D updated her afterwards.
    const c = await run('c.csv', 'name,phone,city\nEvidenced Erum,+923002400003,Quetta\n', true);
    const d = await run('d.csv', 'name,phone,city\nEvidenced Erum,+923002400003,Peshawar\n', false);
    // The database as the upgrade finds it: A and C were in flight, no row carries the marker yet.
    await t.prisma.importBatch.updateMany({ where: { id: { in: [a, c] } }, data: { state: 'CONFIRMED', completedAt: null } });
    await t.prisma.importRow.updateMany({ where: { batchId: { in: [a, b, c, d] } }, data: { appliedAt: null } });
    const migration = readFileSync(path.resolve(__dirname, '../../../../prisma/migrations/20261007170000_import_row_applied_at/migration.sql'), 'utf8');
    const backfill = migration
      .split(/;\s*\n/)
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.startsWith('UPDATE'));
    expect(backfill).toHaveLength(4);
    for (const statement of backfill) await t.prisma.$executeRawUnsafe(statement);
    const rows = async (batchId: string) => t.prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' } });
    // Completed batches: every planned row stamped.
    for (const id of [b, d]) expect((await rows(id)).every((row) => row.appliedAt !== null && row.status === 'UPDATE')).toBe(true);
    // In-flight A: the created contact proves its CREATE row; Omar's UPDATE row has no evidence left and is refused.
    const [omar, nadia] = await rows(a);
    expect(nadia).toMatchObject({ status: 'CREATE' });
    expect(nadia.appliedAt).not.toBeNull();
    expect(nadia.contactId).not.toBeNull();
    expect(omar.status).toBe('ERROR');
    expect(omar.appliedAt).not.toBeNull();
    expect(omar.errors).toEqual([{ rowNumber: 2, field: null, message: expect.stringContaining('re-import the file') }]);
    // In-flight C: the consent evidence recorded under C proves its UPDATE row.
    const [erum] = await rows(c);
    expect(erum).toMatchObject({ status: 'UPDATE' });
    expect(erum.appliedAt).not.toBeNull();
    // Resuming A replays nothing: Omar keeps batch B's city, no consent evidence appears, the refused row is reported.
    const resumed = (await request(t.server).post(`/api/v1/contact-imports/${a}/confirm`).set('Authorization', manager.authorization).expect(200)).body;
    expect(resumed.state).toBe('COMPLETED');
    expect(resumed.summary).toMatchObject({ totalRows: 2, create: 1, update: 0, skip: 0, error: 1 });
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: overwritten.id } })).city).toBe('Karachi');
    expect(await t.prisma.consentEvent.count({ where: { contactId: { in: [overwritten.id, evidenced.id] } } })).toBe(1);
    const report = await request(t.server).get(`/api/v1/contact-imports/${a}/errors`).set('Authorization', manager.authorization).expect(200);
    expect(report.text).toContain('re-import the file');
  });

  it('a failure in one of two concurrent runs never marks a batch failed that the other run completed (R11)', async () => {
    const csv = ['name,phone', ...Array.from({ length: 4 }, (_, index) => `Race ${index + 1},+92300230000${index + 1}`)].join('\n');
    const mapping = { columns: { name: 'name', phone: 'phone' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING', consentAttestation: { scopes: ['SURVEY_INVITATIONS'], source: 'Signed forms', collectedAt: '2026-09-01T00:00:00Z', wordingVersion: 'v1', statement: true } };
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), 'race.csv').expect(201)).body;
    await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/preview`).set('Authorization', manager.authorization).send(mapping).expect(200);
    await t.prisma.importBatch.update({ where: { id: uploaded.id }, data: { state: 'CONFIRMED', confirmedAt: t.clock.now() } });
    const consent = t.app.get(ConsentService);
    const applyEvents = consent.applyEvents.bind(consent);
    let grants = 0;
    const outage = jest.spyOn(consent, 'applyEvents').mockImplementation(async (tx, contactId, events) => {
      grants += 1;
      if (grants === 2) throw new Error('connection terminated unexpectedly');
      return applyEvents(tx, contactId, events);
    });
    // Whichever run hits the outage rolls its chunk back; the other applies every row and completes the batch.
    const responses = await Promise.all([
      request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization),
      request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization),
    ]);
    outage.mockRestore();
    const statuses = responses.map((response) => response.status).sort();
    expect([[200, 200], [200, 500]]).toContainEqual(statuses);
    expect(responses.some((response) => response.status === 200 && response.body.state === 'COMPLETED')).toBe(true);
    for (const response of responses) if (response.status === 500) expect(response.body.code).toBe('IMPORT_PROCESSING_FAILED');
    const final = await t.prisma.importBatch.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(final).toMatchObject({ state: 'COMPLETED', errorMessage: null });
    expect(final.summary).toMatchObject({ totalRows: 4, create: 4, update: 0, skip: 0, error: 0 });
    const contacts = await t.prisma.contact.findMany({ where: { organizationId: orgId, phoneE164: { startsWith: '+9230023' } }, select: { id: true } });
    expect(contacts).toHaveLength(4);
    expect(await t.prisma.consentEvent.count({ where: { contactId: { in: contacts.map((contact) => contact.id) } } })).toBe(4);
    expect(await t.prisma.importRow.count({ where: { batchId: uploaded.id, appliedAt: { not: null } } })).toBe(4);
    expect(await t.prisma.auditEvent.count({ where: { organizationId: orgId, resourceId: uploaded.id, action: 'import.completed' } })).toBe(1);
  });

  it('rejects future-dated consent evidence from attestations and rows (R12, R14)', async () => {
    const valid = readFileSync(path.join(FIXTURES, 'contacts-valid.csv'));
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', valid, 'contacts-valid.csv').expect(201)).body;
    const columns = { name: 'name', phone: 'phone', consent_date: 'consentEvidenceAt', consent_reference: 'consentReference' };
    const future = await request(t.server)
      .post(`/api/v1/contact-imports/${uploaded.id}/preview`)
      .set('Authorization', manager.authorization)
      .send({ columns, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING', consentAttestation: { scopes: ['SURVEY_INVITATIONS'], source: 'Forms', collectedAt: '2026-10-11T00:00:00Z', wordingVersion: 'v1', statement: true } })
      .expect(400);
    expect(future.body.code).toBe('VALIDATION_FAILED');
    expect(future.body.fieldErrors.map((error: { path: string }) => error.path)).toContain('consentAttestation.collectedAt');
    // A row whose own evidence date is in the future is rejected even though the attestation is valid.
    const csv = 'name,phone,consent_date\nFuture Fatima,+923001234801,2026-10-12\nPresent Parveen,+923001234802,2026-09-15\n';
    const rows = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(csv), 'future.csv').expect(201)).body;
    const preview = (
      await request(t.server)
        .post(`/api/v1/contact-imports/${rows.id}/preview`)
        .set('Authorization', manager.authorization)
        .send({ columns: { name: 'name', phone: 'phone', consent_date: 'consentEvidenceAt' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING', consentAttestation: { scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], source: 'Forms', collectedAt: '2026-09-20T00:00:00Z', wordingVersion: 'v1', statement: true } })
        .expect(200)
    ).body;
    expect(preview.batch.summary).toMatchObject({ totalRows: 2, create: 1, error: 1, consentGrantedRows: 1 });
    expect(preview.rows[0].errors[0].message).toContain('cannot be in the future');
    await request(t.server).post(`/api/v1/contact-imports/${rows.id}/confirm`).set('Authorization', manager.authorization).expect(200);
    expect(await t.prisma.contact.count({ where: { organizationId: orgId, phoneE164: '+923001234801' } })).toBe(0);
    const parveen = await t.prisma.contact.findUnique({ where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: '+923001234802' } } });
    expect(parveen?.consentInvitations).toBe('GRANTED');
  });

  it('reports row-level errors for the invalid fixture and produces a downloadable report (R12)', async () => {
    const invalid = readFileSync(path.join(FIXTURES, 'contacts-invalid.csv'));
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', invalid, 'contacts-invalid.csv').expect(201)).body;
    const preview = (
      await request(t.server)
        .post(`/api/v1/contact-imports/${uploaded.id}/preview`)
        .set('Authorization', manager.authorization)
        .send({ columns: { name: 'name', phone: 'phone', city: 'city', gender: 'gender', age_band: 'ageBand', age: 'age', membership: 'membership' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING' })
        .expect(200)
    ).body;
    expect(preview.batch.summary).toMatchObject({ totalRows: 10, create: 2, error: 8 });
    const errorsByRow = new Map<number, string[]>(preview.rows.map((row: { rowNumber: number; errors: { message: string }[] }) => [row.rowNumber, row.errors.map((error) => error.message)]));
    expect(errorsByRow.get(3)?.[0]).toContain('Name is required');
    expect(errorsByRow.get(4)?.[0]).toContain('Phone number is required');
    expect(errorsByRow.get(5)?.[0]).toContain('invalid');
    expect(errorsByRow.get(6)?.[0]).toContain('floating-point');
    expect(errorsByRow.get(7)?.[0]).toContain('conflicts');
    expect(errorsByRow.get(8)?.[0]).toContain('between 0 and 120');
    expect(errorsByRow.get(9)?.[0]).toContain('gender');
    expect(errorsByRow.get(10)?.[0]).toContain('Duplicate of row 2');
    expect(errorsByRow.get(11)).toEqual([]);
    const report = await request(t.server).get(`/api/v1/contact-imports/${uploaded.id}/errors`).set('Authorization', manager.authorization).expect(200);
    expect(report.headers['content-disposition']).toContain('attachment');
    expect(report.headers['cache-control']).toBe('no-store');
    const parsed = parseCsv(report.text);
    expect(parsed.rows[0]).toEqual(['row_number', 'field', 'message']);
    expect(parsed.rows.length).toBeGreaterThan(8);
    await request(t.server).post(`/api/v1/contact-imports/${uploaded.id}/confirm`).set('Authorization', manager.authorization).expect(200);
    const created = await t.prisma.contact.findUnique({ where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: '+923001234607' } } });
    expect(created?.name).toBe('=HYPERLINK("http://evil")');
  });

  it('imports XLSX workbooks, rejects formula cells and encrypted files (R11, R12)', async () => {
    const workbook = buildXlsx([
      { name: 'Contacts', rows: [['name', 'phone', 'age', 'city'], ['Sheet Person', 3001234701, 30, 'Multan'], ['Second Person', '+923001234702', null, 'Quetta']] },
      { name: 'Other', rows: [['x']] },
    ]);
    const uploaded = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(workbook), 'contacts.xlsx').expect(201)).body;
    expect(uploaded.sheetNames).toEqual(['Contacts', 'Other']);
    const preview = (
      await request(t.server)
        .post(`/api/v1/contact-imports/${uploaded.id}/preview`)
        .set('Authorization', manager.authorization)
        .send({ sheetName: 'Contacts', columns: { name: 'name', phone: 'phone', age: 'age', city: 'city' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING' })
        .expect(200)
    ).body;
    expect(preview.batch.summary).toMatchObject({ totalRows: 2, create: 2, error: 0 });
    expect(preview.rows[0].phoneE164).toBe('+923001234701');

    // Formula cell in a mapped column.
    const formulaWorkbook = buildXlsx([{ name: 'Contacts', rows: [['name', 'phone'], ['Formula Person', '+923001234703']] }]);
    const patched = patchFormula(formulaWorkbook);
    const formulaUpload = (await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from(patched), 'formula.xlsx').expect(201)).body;
    const formulaPreview = (
      await request(t.server)
        .post(`/api/v1/contact-imports/${formulaUpload.id}/preview`)
        .set('Authorization', manager.authorization)
        .send({ columns: { name: 'name', phone: 'phone' }, defaultCountry: 'PK', duplicateMode: 'SKIP_EXISTING' })
        .expect(200)
    ).body;
    expect(formulaPreview.rows[0].errors[0].message).toContain('Formula cells are not accepted');

    const encrypted = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const rejected = await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', encrypted, 'secret.xlsx').expect(400);
    expect(rejected.body.message).toContain('Encrypted');
    await request(t.server).post('/api/v1/contact-imports').set('Authorization', manager.authorization).attach('file', Buffer.from('hello'), 'notes.txt').expect(400);
  });

  it('exports contacts as CSV and XLSX with neutralized formulas and phone text (R50)', async () => {
    await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: '=cmd|calc', phone: '+923001234799', city: '@home' }).expect(201);
    const csv = await request(t.server).get('/api/v1/contacts/export?format=csv&search=1234799').set('Authorization', manager.authorization).expect(200);
    const rows = parseCsv(csv.text).rows;
    const nameIndex = rows[0].indexOf('name');
    const phoneIndex = rows[0].indexOf('phone');
    expect(rows[1][nameIndex]).toBe("'=cmd|calc");
    expect(rows[1][phoneIndex]).toBe('+923001234799');
    expect(rows[1][rows[0].indexOf('city')]).toBe("'@home");
    const xlsx = await request(t.server).get('/api/v1/contacts/export?format=xlsx&search=1234799').set('Authorization', manager.authorization).buffer(true).parse(binaryParser).expect(200);
    const workbook = readXlsx(new Uint8Array(xlsx.body as Buffer));
    expect(workbook.ok).toBe(true);
    if (workbook.ok) {
      expect(workbook.sheets[0].rows[1][nameIndex].text).toBe("'=cmd|calc");
      expect(workbook.sheets[0].rows[1][phoneIndex]).toMatchObject({ text: '+923001234799', isNumeric: false });
    }
    await request(t.server).get('/api/v1/contacts/export').set('Authorization', viewer.authorization).expect(403);
    const audit = (await request(t.server).get('/api/v1/audit?action=contacts.exported').set('Authorization', admin.authorization).expect(200)).body;
    expect(audit.total).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.items)).not.toContain('923001234799');
  });

  it('concurrent consent decisions serialize so the cached status always matches the event history (R14)', async () => {
    const contact = (await request(t.server).post('/api/v1/contacts').set('Authorization', manager.authorization).send({ name: 'Racing Rani', phone: '+923009990001' }).expect(201)).body;
    const grant = (evidenceAt: string) => request(t.server).post(`/api/v1/contacts/${contact.id}/consent-events`).set('Authorization', manager.authorization).send({ scopes: ['SURVEY_INVITATIONS', 'SURVEY_RESULTS'], type: 'GRANTED', evidenceAt, evidenceReference: 'Form', reviewedNewEvidence: true });
    const withdraw = (evidenceAt: string) => request(t.server).post(`/api/v1/contacts/${contact.id}/consent-events`).set('Authorization', admin.authorization).send({ scopes: ['SURVEY_INVITATIONS'], type: 'WITHDRAWN', evidenceAt, evidenceReference: 'Call' });
    await grant('2026-09-01T00:00:00Z').expect(201);
    for (let round = 0; round < 6; round += 1) {
      const day = String(10 + round).padStart(2, '0');
      // Even rounds: the grant carries the later evidence; odd rounds: the withdrawal does.
      const grantAt = round % 2 === 0 ? `2026-09-${day}T12:00:00Z` : `2026-09-${day}T08:00:00Z`;
      const responses = await Promise.all([withdraw(`2026-09-${day}T10:00:00Z`), grant(grantAt)]);
      expect(responses[0].status).toBe(201);
      expect([201, 400]).toContain(responses[1].status);
      const events = await t.prisma.consentEvent.findMany({ where: { contactId: contact.id }, select: { scope: true, type: true, evidenceAt: true, recordedAt: true }, orderBy: [{ evidenceAt: 'asc' }, { recordedAt: 'asc' }] });
      const cached = await t.prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      expect(cached.consentInvitations).toBe(deriveConsent(events, 'SURVEY_INVITATIONS').status);
      expect(cached.consentResults).toBe(deriveConsent(events, 'SURVEY_RESULTS').status);
      expect(cached.consentInvitations).toBe(round % 2 === 0 ? 'GRANTED' : 'WITHDRAWN');
      expect(cached.consentResults).toBe('GRANTED');
    }
  });
});


/** Rewrite the name cell of row 2 into a formula cell to exercise rejection. */
function patchFormula(workbook: Uint8Array): Uint8Array {
  const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate') as typeof import('fflate');
  const files = unzipSync(workbook);
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  const patched = sheet.replace(/<c r="A2" t="inlineStr"><is><t xml:space="preserve">Formula Person<\/t><\/is><\/c>/, '<c r="A2" t="str"><f>CONCAT("Formula"," Person")</f><v>Formula Person</v></c>');
  files['xl/worksheets/sheet1.xml'] = strToU8(patched);
  return zipSync(files);
}
