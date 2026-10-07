import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildXlsx, parseCsv, readXlsx } from '@raaye/domain';
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
