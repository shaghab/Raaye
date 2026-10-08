import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  LIMITS,
  type ImportBatchDto,
  type ImportField,
  type ImportMapping,
  type ImportPreviewDto,
  type ImportPreviewRowDto,
  type ImportRowErrorDto,
  type ImportSummaryDto,
} from '@raaye/contracts';
import { parseCsv, buildXlsx, type Clock, type NormalizedImportRow, normalizeText, toCsv, type ParsedCell, readXlsx, suggestMapping, validateImportRow } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, invalid, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getLogger } from '../observability/logger';
import { asJson } from '../persistence/json';
import type { ImportBatch, Prisma } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantDb, TenantTx } from '../persistence/tenant-db';
import { ConsentService } from './consent.service';

export interface UploadedImportFile {
  originalName: string;
  size: number;
  buffer: Buffer;
}

interface ParsedTable {
  headers: string[];
  rows: ParsedCell[][];
}

const PREVIEW_ROWS = 200;
const CHUNK = 200;
const EMPTY_SUMMARY: ImportSummaryDto = { totalRows: 0, create: 0, update: 0, skip: 0, error: 0, consentGrantedRows: 0, withdrawnProtected: 0 };

/** A batch whose processing stopped can continue while its staged rows are still there and within the retention window. */
function isResumable(batch: Pick<ImportBatch, 'state' | 'rawExpiresAt' | 'stagingPurgedAt'>, now: Date): boolean {
  return (batch.state === 'CONFIRMED' || batch.state === 'FAILED') && batch.stagingPurgedAt === null && batch.rawExpiresAt.getTime() > now.getTime();
}

function toBatchDto(batch: ImportBatch, now: Date): ImportBatchDto {
  return {
    id: batch.id,
    fileName: batch.fileName,
    fileType: batch.fileType,
    fileSize: batch.fileSize,
    sheetNames: (batch.sheetNames as string[] | null) ?? null,
    sheetName: batch.sheetName,
    headers: (batch.headers as string[] | null) ?? null,
    columnMapping: (batch.columnMapping as Record<string, ImportField> | null) ?? null,
    defaultCountry: batch.defaultCountry,
    duplicateMode: batch.duplicateMode,
    state: batch.state,
    summary: (batch.summary as ImportSummaryDto | null) ?? null,
    resumable: isResumable(batch, now),
    hasConsentAttestation: Boolean(batch.consentAttestation),
    rawExpiresAt: batch.rawExpiresAt.toISOString(),
    stagingPurgedAt: batch.stagingPurgedAt?.toISOString() ?? null,
    previewedAt: batch.previewedAt?.toISOString() ?? null,
    confirmedAt: batch.confirmedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    errorMessage: batch.errorMessage,
    createdAt: batch.createdAt.toISOString(),
  };
}

@Injectable()
export class ImportService {
  private readonly logger = getLogger('imports');

  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    private readonly consent: ConsentService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Step 1: store the upload in staging and detect sheets/headers. Nothing is imported. */
  async upload(ctx: TenantContext, file: UploadedImportFile): Promise<ImportBatchDto & { suggestedMapping: Record<string, ImportField> }> {
    if (file.size > LIMITS.importFile.maxBytes || file.buffer.length > LIMITS.importFile.maxBytes) {
      throw invalid(`The file exceeds the ${LIMITS.importFile.maxBytes / (1024 * 1024)} MB limit`);
    }
    const extension = file.originalName.toLowerCase().split('.').pop();
    const fileType = extension === 'csv' ? 'CSV' : extension === 'xlsx' ? 'XLSX' : null;
    if (!fileType) throw invalid('Only .csv and .xlsx files are supported');
    const sheetNames = fileType === 'XLSX' ? this.sheetNames(file.buffer) : null;
    const table = this.parseTable(file.buffer, fileType, sheetNames?.[0] ?? null);
    if (table.rows.length > LIMITS.importFile.maxRows) {
      throw invalid(`The file has ${table.rows.length} data rows; the limit is ${LIMITS.importFile.maxRows}`);
    }
    const now = this.clock.now();
    const batch = await this.dbFactory.for(ctx).importBatch.create({
      data: {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        fileName: file.originalName.replace(/[^\w.\- ]/g, '_').slice(0, 200),
        fileType,
        fileSize: file.buffer.length,
        sheetNames: sheetNames ? asJson(sheetNames) : undefined,
        sheetName: sheetNames?.[0] ?? null,
        headers: asJson(table.headers),
        rawBytes: new Uint8Array(file.buffer),
        rawExpiresAt: new Date(now.getTime() + this.config.IMPORT_STAGING_RETENTION_HOURS * 3600 * 1000),
        state: 'UPLOADED',
      },
    });
    await this.audit.record(ctx, { action: 'import.uploaded', resourceType: 'import_batch', resourceId: batch.id, metadata: { fileType, size: file.buffer.length, rows: table.rows.length } });
    return { ...toBatchDto(batch, now), suggestedMapping: suggestMapping(table.headers) };
  }

  /** Step 2: map columns, validate every row and stage the plan. Still nothing imported. */
  async preview(ctx: TenantContext, batchId: string, mapping: ImportMapping): Promise<ImportPreviewDto> {
    const db = this.dbFactory.for(ctx);
    const batch = await db.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Import');
    if (!['UPLOADED', 'PREVIEWED'].includes(batch.state)) throw new DomainError('IMPORT_STATE_INVALID', `Import is ${batch.state.toLowerCase()} and cannot be previewed`);
    if (!batch.rawBytes) throw new DomainError('IMPORT_STATE_INVALID', 'The staged file has expired; upload it again');
    const mapped = new Set(Object.values(mapping.columns));
    if (!mapped.has('name') || !mapped.has('phone')) {
      throw invalid('Map both the name and phone columns', [{ path: 'columns', message: 'name and phone are required' }]);
    }
    const sheetName = batch.fileType === 'XLSX' ? (mapping.sheetName ?? batch.sheetName) : null;
    const table = this.parseTable(Buffer.from(batch.rawBytes), batch.fileType, sheetName);
    if (table.rows.length > LIMITS.importFile.maxRows) throw invalid(`The sheet has ${table.rows.length} data rows; the limit is ${LIMITS.importFile.maxRows}`);
    const headerIndex = new Map(table.headers.map((header, index) => [header, index]));
    for (const header of Object.keys(mapping.columns)) {
      if (!headerIndex.has(header)) throw invalid(`Column "${header}" does not exist in the file`, [{ path: 'columns', message: header }]);
    }
    const importDate = this.clock.now().toISOString().slice(0, 10);
    const validated: { rowNumber: number; normalized: NormalizedImportRow | null; errors: ImportRowErrorDto[] }[] = table.rows.map((row, index) => {
      const rowNumber = index + 2;
      const cells: Partial<Record<ImportField, ParsedCell>> = {};
      for (const [header, field] of Object.entries(mapping.columns)) {
        const cell = row[headerIndex.get(header) ?? -1];
        if (cell) cells[field] = cell;
      }
      const result = validateImportRow(rowNumber, cells, mapping.defaultCountry, importDate);
      return { rowNumber, ...result };
    });
    // Consent evidence can never be dated in the future: a later STOP would otherwise lose to it.
    const now = this.clock.now();
    if (mapping.consentAttestation && isFutureEvidence(mapping.consentAttestation.collectedAt, now)) {
      throw invalid('The consent attestation date cannot be in the future', [{ path: 'consentAttestation.collectedAt', message: 'In the future' }]);
    }
    for (const entry of validated) {
      if (entry.normalized?.consentEvidenceAt && isFutureEvidence(entry.normalized.consentEvidenceAt, now)) {
        entry.errors.push({ rowNumber: entry.rowNumber, field: 'consentEvidenceAt', message: FUTURE_EVIDENCE_MESSAGE });
        entry.normalized = null;
      }
    }
    // Duplicates inside the file: only the first valid row for a number can be used.
    const seen = new Map<string, number>();
    for (const entry of validated) {
      if (!entry.normalized) continue;
      const first = seen.get(entry.normalized.phoneE164);
      if (first !== undefined) {
        entry.errors.push({ rowNumber: entry.rowNumber, field: 'phone', message: `Duplicate of row ${first} in this file; only the first row is used` });
        entry.normalized = null;
      } else {
        seen.set(entry.normalized.phoneE164, entry.rowNumber);
      }
    }
    const phones = Array.from(seen.keys());
    const existing = phones.length
      ? await db.contact.findMany({ where: { phoneE164: { in: phones } }, select: { id: true, phoneE164: true, consentInvitations: true, consentResults: true, archivedAt: true } })
      : [];
    const existingByPhone = new Map(existing.map((contact) => [contact.phoneE164, contact]));
    const attestation = mapping.consentAttestation ?? null;
    const summary: ImportSummaryDto = { totalRows: validated.length, create: 0, update: 0, skip: 0, error: 0, consentGrantedRows: 0, withdrawnProtected: 0 };
    const rowsData: Prisma.ImportRowCreateManyInput[] = validated.map((entry) => {
      let status: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR';
      let consentEligible = false;
      let contactId: string | null = null;
      if (!entry.normalized) {
        status = 'ERROR';
      } else {
        const match = existingByPhone.get(entry.normalized.phoneE164);
        if (match) {
          contactId = match.id;
          status = mapping.duplicateMode === 'UPDATE_NON_EMPTY_FIELDS' ? 'UPDATE' : 'SKIP';
          const withdrawn = match.consentInvitations === 'WITHDRAWN' || match.consentResults === 'WITHDRAWN';
          if (attestation && status === 'UPDATE') {
            if (withdrawn) {
              summary.withdrawnProtected += 1;
              entry.errors.push({ rowNumber: entry.rowNumber, field: 'consent', message: 'Contact withdrew permission; import evidence does not re-enable them' });
            } else {
              consentEligible = true;
            }
          } else if (withdrawn && attestation) {
            summary.withdrawnProtected += 1;
          }
        } else {
          status = 'CREATE';
          consentEligible = Boolean(attestation);
        }
      }
      summary[status.toLowerCase() as 'create' | 'update' | 'skip' | 'error'] += 1;
      if (consentEligible) summary.consentGrantedRows += 1;
      return {
        organizationId: ctx.organizationId,
        batchId: batch.id,
        rowNumber: entry.rowNumber,
        status,
        errors: entry.errors.length ? asJson(entry.errors) : undefined,
        normalized: entry.normalized ? asJson({ ...entry.normalized, consentEligible }) : undefined,
        contactId,
      };
    });
    await db.$transaction(async (tx) => {
      await tx.importRow.deleteMany({ where: { batchId: batch.id } });
      for (let i = 0; i < rowsData.length; i += 1000) await tx.importRow.createMany({ data: rowsData.slice(i, i + 1000) });
      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          state: 'PREVIEWED',
          sheetName,
          headers: asJson(table.headers),
          columnMapping: asJson(mapping.columns),
          defaultCountry: mapping.defaultCountry,
          duplicateMode: mapping.duplicateMode,
          consentAttestation: attestation ? asJson(attestation) : undefined,
          summary: asJson(summary),
          previewedAt: now,
        },
      });
    });
    const updated = await db.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    return this.previewDto(updated, rowsData);
  }

  /**
   * Step 3: explicit confirmation applies the staged plan transactionally in chunks. Confirming a
   * batch whose processing stopped (a crash left it CONFIRMED, or a failure marked it FAILED)
   * resumes it: processing is idempotent per row, so rows already applied are never applied twice.
   */
  async confirm(ctx: TenantContext, batchId: string, idempotencyKey: string | null): Promise<ImportBatchDto> {
    const db = this.dbFactory.for(ctx);
    const batch = await db.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Import');
    const now = this.clock.now();
    if (batch.state === 'COMPLETED') return toBatchDto(batch, now);
    if (batch.state === 'CONFIRMED' || batch.state === 'FAILED') {
      if (!isResumable(batch, now)) {
        throw new DomainError('IMPORT_STATE_INVALID', 'The staged rows of this import have expired and it can no longer be resumed; rows already imported are kept. Upload the file again to import the rest.', { batchId });
      }
      if (batch.state === 'FAILED') {
        const reopened = await db.importBatch.updateMany({ where: { id: batchId, state: 'FAILED' }, data: { state: 'CONFIRMED', errorMessage: null } });
        if (reopened.count !== 1) return toBatchDto(await db.importBatch.findUniqueOrThrow({ where: { id: batchId } }), now);
      }
      await this.audit.record(ctx, { action: 'import.resumed', resourceType: 'import_batch', resourceId: batchId, metadata: { from: batch.state } });
      return this.process(ctx, batchId);
    }
    if (batch.state === 'EXPIRED') {
      throw new DomainError('IMPORT_STATE_INVALID', batch.confirmedAt ? 'The staged rows of this import expired before it finished; rows already imported are kept. Upload the file again to import the rest.' : 'The staged file has expired; upload it again', { batchId });
    }
    if (batch.state !== 'PREVIEWED') throw new DomainError('IMPORT_STATE_INVALID', 'Preview the import before confirming it');
    if (batch.rawExpiresAt.getTime() <= now.getTime()) throw new DomainError('IMPORT_STATE_INVALID', 'The staged file has expired; upload it again');
    const claimed = await db.importBatch.updateMany({ where: { id: batchId, state: 'PREVIEWED' }, data: { state: 'CONFIRMED', confirmedAt: now } });
    if (claimed.count !== 1) {
      const current = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
      return toBatchDto(current, now);
    }
    await this.audit.record(ctx, { action: 'import.confirmed', resourceType: 'import_batch', resourceId: batchId, metadata: { idempotencyKey: idempotencyKey ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16) : null } });
    return this.process(ctx, batchId);
  }

  /**
   * Apply a confirmed batch. Idempotent per row: a row is applied inside a chunk transaction that
   * also stamps `appliedAt`, so a re-run (after a crash or a failure) only applies the rows that
   * never committed. Concurrent runs of the same batch serialize on the batch row and re-read each
   * chunk under that lock, so no row is applied twice. A failure that aborts a chunk records the
   * batch as FAILED with the partial summary and is reported to the caller as an error.
   */
  async process(ctx: TenantContext, batchId: string): Promise<ImportBatchDto> {
    const db = this.dbFactory.for(ctx);
    const batch = await db.importBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.state !== 'CONFIRMED') throw new DomainError('IMPORT_STATE_INVALID', 'The import is not confirmed');
    const attestation = batch.consentAttestation as ImportMapping['consentAttestation'] | null;
    const processedAt = this.clock.now();
    if (attestation && isFutureEvidence(attestation.collectedAt, processedAt)) throw new DomainError('IMPORT_VALIDATION_FAILED', 'The consent attestation date is in the future; preview the import again');
    const pending = await db.importRow.findMany({ where: { batchId, status: { in: ['CREATE', 'UPDATE'] }, appliedAt: null }, orderBy: { rowNumber: 'asc' }, select: { id: true } });
    const groupCache = new Map<string, string>();
    const tagCache = new Map<string, string>();
    const failures: ImportRowErrorDto[] = [];
    let created = 0;
    let updated = 0;
    let alreadyApplied = 0;
    try {
      for (let i = 0; i < pending.length; i += CHUNK) {
        const chunkIds = pending.slice(i, i + CHUNK).map((row) => row.id);
        await db.$transaction(async (tx) => {
          // Serialize concurrent runs of the same batch and re-read the chunk under the lock: a row
          // another run applied meanwhile is no longer pending.
          await tx.$queryRaw`SELECT id FROM import_batches WHERE id = ${batchId}::uuid AND organization_id = ${ctx.organizationId}::uuid FOR UPDATE`;
          const chunk = await tx.importRow.findMany({ where: { id: { in: chunkIds }, appliedAt: null }, orderBy: { rowNumber: 'asc' } });
          for (const row of chunk) {
            const normalized = row.normalized as (NormalizedImportRow & { consentEligible: boolean }) | null;
            if (!normalized) {
              await this.markRow(tx, row.id, processedAt, 'ERROR', [{ rowNumber: row.rowNumber, field: null, message: 'The staged row has no plan; preview the import again' }]);
              continue;
            }
            if (normalized.consentEligible && normalized.consentEvidenceAt && isFutureEvidence(normalized.consentEvidenceAt, processedAt)) {
              // Revalidated at processing time: the staged plan is never trusted over the clock.
              failures.push({ rowNumber: row.rowNumber, field: 'consentEvidenceAt', message: FUTURE_EVIDENCE_MESSAGE });
              await this.markRow(tx, row.id, processedAt, 'ERROR', [{ rowNumber: row.rowNumber, field: 'consentEvidenceAt', message: FUTURE_EVIDENCE_MESSAGE }]);
              continue;
            }
            try {
              if (row.status === 'CREATE') {
                if (row.contactId) {
                  // Applied before the marker existed (a CREATE row only carries a contact once it was created).
                  await tx.importRow.update({ where: { id: row.id }, data: { appliedAt: processedAt } });
                  alreadyApplied += 1;
                  continue;
                }
                const existing = await tx.contact.findUnique({ where: { organizationId_phoneE164: { organizationId: ctx.organizationId, phoneE164: normalized.phoneE164 } } });
                if (existing) {
                  await tx.importRow.update({ where: { id: row.id }, data: { status: 'SKIP', contactId: existing.id, appliedAt: processedAt } });
                  continue;
                }
                const contact = await tx.contact.create({ data: this.createData(ctx, batch, normalized) });
                await this.linkGroupsTags(tx, ctx, contact.id, normalized, groupCache, tagCache);
                if (normalized.consentEligible && attestation) await this.grantFromImport(tx, contact.id, batch, attestation, normalized, ctx);
                await tx.importRow.update({ where: { id: row.id }, data: { contactId: contact.id, appliedAt: processedAt } });
                created += 1;
              } else if (row.status === 'UPDATE') {
                const existing = row.contactId ? await tx.contact.findUnique({ where: { id: row.contactId } }) : null;
                if (!existing) {
                  await this.markRow(tx, row.id, processedAt, 'ERROR', [{ rowNumber: row.rowNumber, field: 'phone', message: 'The matched contact no longer exists; preview the import again' }]);
                  continue;
                }
                if (existing.importBatchId === batch.id) {
                  // Applied before the marker existed: the contact already records this batch as its last import.
                  await tx.importRow.update({ where: { id: row.id }, data: { appliedAt: processedAt } });
                  alreadyApplied += 1;
                  continue;
                }
                await tx.contact.update({ where: { id: existing.id }, data: this.updateData(existing, normalized, batch) });
                await this.linkGroupsTags(tx, ctx, existing.id, normalized, groupCache, tagCache);
                const withdrawn = existing.consentInvitations === 'WITHDRAWN' || existing.consentResults === 'WITHDRAWN';
                if (normalized.consentEligible && attestation && !withdrawn) await this.grantFromImport(tx, existing.id, batch, attestation, normalized, ctx);
                await tx.importRow.update({ where: { id: row.id }, data: { appliedAt: processedAt } });
                updated += 1;
              }
            } catch (error) {
              // Only a domain rule turns into a row error. Anything else (a database error leaves
              // the transaction unusable) aborts the chunk and fails the batch, which can be resumed.
              if (!(error instanceof DomainError)) throw error;
              failures.push({ rowNumber: row.rowNumber, field: null, message: error.message.slice(0, 200) });
              await this.markRow(tx, row.id, processedAt, 'ERROR', [{ rowNumber: row.rowNumber, field: null, message: error.message.slice(0, 200) }]);
            }
          }
        });
      }
      // Every row that was pending when this run started is applied now (by this run or a concurrent
      // one), so the batch is complete even if a concurrent run recorded a failure meanwhile. The
      // raw file is dropped here; the staged rows stay until the retention sweep purges them.
      const summary = await this.summarize(db, batch);
      const completedAt = this.clock.now();
      const completed = await db.importBatch.updateMany({
        where: { id: batchId, state: { in: ['CONFIRMED', 'FAILED'] } },
        data: { state: 'COMPLETED', completedAt, summary: asJson(summary), rawBytes: null, errorMessage: null },
      });
      if (completed.count === 1) await this.audit.record(ctx, { action: 'import.completed', resourceType: 'import_batch', resourceId: batchId, metadata: { created, updated, alreadyApplied, failures: failures.length } });
      return toBatchDto(await db.importBatch.findUniqueOrThrow({ where: { id: batchId } }), completedAt);
    } catch (error) {
      // The first line of the message names the failure without echoing row data; the log gets only the error kind.
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '').trim().slice(0, 200) || error.name : 'Import failed';
      this.logger.error({ batchId, errorKind: error instanceof Error ? error.name : typeof error, created, updated }, 'Import processing stopped');
      let summary: ImportSummaryDto;
      let settled: ImportBatch;
      try {
        // Record the failure with what was applied so far, unless a concurrent run settled the batch.
        summary = await this.summarize(db, batch);
        const failed = await db.importBatch.updateMany({
          where: { id: batchId, state: 'CONFIRMED' },
          data: { state: 'FAILED', errorMessage: reason, summary: asJson(summary), rawBytes: null },
        });
        if (failed.count === 1) await this.audit.record(ctx, { action: 'import.failed', resourceType: 'import_batch', resourceId: batchId, metadata: { created, updated, alreadyApplied, failures: failures.length } });
        settled = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
      } catch (recording) {
        // The database is unreachable: the batch stays CONFIRMED and the next confirmation resumes it.
        this.logger.error({ batchId, err: recording instanceof Error ? recording.message : String(recording) }, 'Import failure could not be recorded');
        throw error;
      }
      if (settled.state === 'COMPLETED') return toBatchDto(settled, this.clock.now());
      throw new DomainError(
        'IMPORT_PROCESSING_FAILED',
        'The import stopped before every row was applied. Rows already imported are kept; confirm the import again to continue with the remaining rows, or download the error report.',
        { batchId, state: settled.state, errorMessage: settled.errorMessage ?? reason, summary: (settled.summary as ImportSummaryDto | null) ?? summary },
      );
    }
  }

  private async markRow(tx: TenantTx, rowId: string, appliedAt: Date, status: 'ERROR', errors: ImportRowErrorDto[]): Promise<void> {
    await tx.importRow.update({ where: { id: rowId }, data: { status, errors: asJson(errors), appliedAt } });
  }

  /**
   * Outcome counts from the rows themselves: planned rows that were not applied yet are in no
   * bucket, so `create + update + skip + error` is below `totalRows` while a batch is unfinished.
   */
  private async summarize(db: TenantDb, batch: ImportBatch): Promise<ImportSummaryDto> {
    const previous = (batch.summary as ImportSummaryDto | null) ?? EMPTY_SUMMARY;
    const [create, update, skip, error] = await Promise.all([
      db.importRow.count({ where: { batchId: batch.id, status: 'CREATE', appliedAt: { not: null } } }),
      db.importRow.count({ where: { batchId: batch.id, status: 'UPDATE', appliedAt: { not: null } } }),
      db.importRow.count({ where: { batchId: batch.id, status: 'SKIP' } }),
      db.importRow.count({ where: { batchId: batch.id, status: 'ERROR' } }),
    ]);
    return { ...previous, create, update, skip, error };
  }

  async get(ctx: TenantContext, batchId: string): Promise<ImportBatchDto> {
    const batch = await this.dbFactory.for(ctx).importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Import');
    return toBatchDto(batch, this.clock.now());
  }

  async list(ctx: TenantContext): Promise<ImportBatchDto[]> {
    const batches = await this.dbFactory.for(ctx).importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const now = this.clock.now();
    return batches.map((batch) => toBatchDto(batch, now));
  }

  async previewRows(ctx: TenantContext, batchId: string): Promise<ImportPreviewDto> {
    const db = this.dbFactory.for(ctx);
    const batch = await db.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Import');
    const rows = await db.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: 'asc' }, take: PREVIEW_ROWS });
    return this.previewDto(batch, rows.map((row) => ({ organizationId: ctx.organizationId, batchId, rowNumber: row.rowNumber, status: row.status, errors: row.errors ?? undefined, normalized: row.normalized ?? undefined, contactId: row.contactId })));
  }

  /** Row-error report as CSV, formula-safe. */
  async errorReport(ctx: TenantContext, batchId: string): Promise<{ filename: string; body: Buffer }> {
    const db = this.dbFactory.for(ctx);
    const batch = await db.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound('Import');
    if (batch.stagingPurgedAt) throw new DomainError('IMPORT_STATE_INVALID', 'The staged rows of this import were purged at the end of the staging window; the error report is no longer available', { batchId });
    const rows = await db.importRow.findMany({ where: { batchId, status: 'ERROR' }, orderBy: { rowNumber: 'asc' } });
    const lines: (string | number)[][] = [['row_number', 'field', 'message']];
    for (const row of rows) {
      const errors = (row.errors as ImportRowErrorDto[] | null) ?? [];
      for (const error of errors) lines.push([row.rowNumber, error.field ?? '', error.message]);
    }
    await this.audit.record(ctx, { action: 'import.errors_downloaded', resourceType: 'import_batch', resourceId: batchId, metadata: { rows: rows.length } });
    return { filename: `import-${batchId.slice(0, 8)}-errors.csv`, body: Buffer.from(toCsv(lines), 'utf8') };
  }

  private previewDto(batch: ImportBatch, rows: Prisma.ImportRowCreateManyInput[]): ImportPreviewDto {
    const preview: ImportPreviewRowDto[] = rows.slice(0, PREVIEW_ROWS).map((row) => {
      const normalized = (row.normalized as (NormalizedImportRow & { consentEligible?: boolean }) | undefined) ?? null;
      return {
        rowNumber: row.rowNumber,
        status: row.status,
        name: normalized?.name ?? null,
        phoneE164: normalized?.phoneE164 ?? null,
        consentEligible: Boolean(normalized?.consentEligible),
        errors: ((row.errors as ImportRowErrorDto[] | undefined) ?? []).map((error) => ({ ...error })),
      };
    });
    return { batch: toBatchDto(batch, this.clock.now()), rows: preview, rowsShown: preview.length };
  }

  private sheetNames(buffer: Buffer): string[] {
    const workbook = readXlsx(new Uint8Array(buffer));
    if (!workbook.ok) throw this.xlsxError(workbook.reason);
    return workbook.sheets.map((sheet) => sheet.name);
  }

  private xlsxError(reason: string): DomainError {
    const message =
      reason === 'ENCRYPTED_OR_LEGACY'
        ? 'Encrypted workbooks and legacy .xls files are not supported; save as an unencrypted .xlsx'
        : reason === 'TOO_LARGE'
          ? 'The workbook is too large to process'
          : 'The file is not a readable .xlsx workbook';
    return invalid(message);
  }

  private parseTable(buffer: Buffer, fileType: 'CSV' | 'XLSX', sheetName: string | null): ParsedTable {
    let grid: ParsedCell[][];
    if (fileType === 'CSV') {
      const text = buffer.toString('utf8');
      if (text.includes('\u0000')) throw invalid('The CSV file does not look like UTF-8 text');
      const parsed = parseCsv(text);
      grid = parsed.rows.map((row) => row.map((cell) => ({ text: cell, isFormula: false, isNumeric: false })));
    } else {
      const workbook = readXlsx(new Uint8Array(buffer));
      if (!workbook.ok) throw this.xlsxError(workbook.reason);
      const sheet = (sheetName ? workbook.sheets.find((candidate) => candidate.name === sheetName) : workbook.sheets[0]) ?? workbook.sheets[0];
      if (!sheet) throw invalid('The workbook has no worksheets');
      grid = sheet.rows;
    }
    const headerRow = grid[0] ?? [];
    const headers = headerRow.map((cell, index) => (cell?.text ?? '').trim() || `Column ${index + 1}`);
    const rows = grid.slice(1).filter((row) => row.some((cell) => cell && cell.text.trim() !== ''));
    return { headers, rows };
  }

  private createData(ctx: TenantContext, batch: ImportBatch, row: NormalizedImportRow): Prisma.ContactUncheckedCreateInput {
    const now = this.clock.now().toISOString();
    const fields = ['city', 'district', 'gender', 'ageBand', 'occupation', 'membership'] as const;
    const prov: Record<string, { source: string; at: string }> = {};
    for (const field of fields) if (row[field]) prov[field] = { source: 'IMPORT', at: now };
    return {
      organizationId: ctx.organizationId,
      name: row.name,
      phoneE164: row.phoneE164,
      city: row.city,
      cityNormalized: normalizeText(row.city),
      district: row.district,
      districtNormalized: normalizeText(row.district),
      gender: row.gender,
      ageBand: row.ageBand,
      ageYears: row.ageYears,
      ageAsOf: row.ageAsOf ? new Date(`${row.ageAsOf}T00:00:00Z`) : null,
      occupation: row.occupation,
      membership: row.membership ?? 'UNKNOWN',
      membershipSource: row.membership ? 'IMPORT' : null,
      preferredLocale: row.preferredLocale ?? 'en',
      importBatchId: batch.id,
      createdByUserId: batch.actorUserId,
      profileProvenance: asJson(prov),
    };
  }

  private updateData(existing: { profileProvenance: unknown }, row: NormalizedImportRow, batch: ImportBatch): Prisma.ContactUpdateInput {
    const now = this.clock.now().toISOString();
    const data: Prisma.ContactUpdateInput = { importBatchId: batch.id };
    const prov = { ...((existing.profileProvenance as Record<string, unknown> | null) ?? {}) };
    if (row.name) data.name = row.name;
    if (row.city) {
      data.city = row.city;
      data.cityNormalized = normalizeText(row.city);
      prov['city'] = { source: 'IMPORT', at: now };
    }
    if (row.district) {
      data.district = row.district;
      data.districtNormalized = normalizeText(row.district);
      prov['district'] = { source: 'IMPORT', at: now };
    }
    if (row.gender) {
      data.gender = row.gender;
      prov['gender'] = { source: 'IMPORT', at: now };
    }
    if (row.ageBand) {
      data.ageBand = row.ageBand;
      prov['ageBand'] = { source: 'IMPORT', at: now };
    }
    if (row.ageYears !== null) {
      data.ageYears = row.ageYears;
      data.ageAsOf = row.ageAsOf ? new Date(`${row.ageAsOf}T00:00:00Z`) : null;
    }
    if (row.occupation) {
      data.occupation = row.occupation;
      prov['occupation'] = { source: 'IMPORT', at: now };
    }
    if (row.membership) {
      data.membership = row.membership;
      data.membershipSource = 'IMPORT';
      prov['membership'] = { source: 'IMPORT', at: now };
    }
    if (row.preferredLocale) data.preferredLocale = row.preferredLocale;
    data.profileProvenance = asJson(prov);
    return data;
  }

  private async linkGroupsTags(tx: TenantTx, ctx: TenantContext, contactId: string, row: NormalizedImportRow, groupCache: Map<string, string>, tagCache: Map<string, string>): Promise<void> {
    for (const name of row.groups) {
      const key = normalizeText(name) ?? name.toLowerCase();
      let groupId = groupCache.get(key);
      if (!groupId) {
        const group = await tx.group.upsert({
          where: { organizationId_normalizedName: { organizationId: ctx.organizationId, normalizedName: key } },
          create: { organizationId: ctx.organizationId, name, normalizedName: key },
          update: {},
        });
        groupId = group.id;
        groupCache.set(key, groupId);
      }
      await tx.contactGroup.upsert({
        where: { organizationId_contactId_groupId: { organizationId: ctx.organizationId, contactId, groupId } },
        create: { organizationId: ctx.organizationId, contactId, groupId },
        update: {},
      });
    }
    for (const name of row.tags) {
      const key = normalizeText(name) ?? name.toLowerCase();
      let tagId = tagCache.get(key);
      if (!tagId) {
        const tag = await tx.tag.upsert({
          where: { organizationId_normalizedName: { organizationId: ctx.organizationId, normalizedName: key } },
          create: { organizationId: ctx.organizationId, name, normalizedName: key },
          update: {},
        });
        tagId = tag.id;
        tagCache.set(key, tagId);
      }
      await tx.contactTag.upsert({
        where: { organizationId_contactId_tagId: { organizationId: ctx.organizationId, contactId, tagId } },
        create: { organizationId: ctx.organizationId, contactId, tagId },
        update: {},
      });
    }
  }

  private async grantFromImport(tx: TenantTx, contactId: string, batch: ImportBatch, attestation: NonNullable<ImportMapping['consentAttestation']>, row: NormalizedImportRow, ctx: TenantContext): Promise<void> {
    const evidenceAt = new Date(row.consentEvidenceAt ?? attestation.collectedAt);
    await this.consent.applyEvents(
      tx,
      contactId,
      attestation.scopes.map((scope) => ({
        scope,
        type: 'GRANTED' as const,
        source: 'IMPORT_ATTESTATION' as const,
        evidenceAt,
        wordingVersion: attestation.wordingVersion,
        evidenceReference: row.consentReference ?? `${attestation.source} (import ${batch.id})`,
        actorUserId: ctx.userId,
        importBatchId: batch.id,
      })),
    );
  }
}

const FUTURE_EVIDENCE_MESSAGE = 'Consent evidence date cannot be in the future';

/** Same one-minute clock tolerance as staff-recorded consent. */
function isFutureEvidence(value: string, now: Date): boolean {
  return new Date(value).getTime() > now.getTime() + 60_000;
}

/** Downloadable import templates. */
export function importTemplate(format: 'csv' | 'xlsx'): { filename: string; contentType: string; body: Buffer } {
  const header = ['name', 'phone', 'city', 'district', 'gender', 'age_band', 'age', 'age_as_of', 'occupation', 'membership', 'groups', 'tags', 'consent_date', 'consent_reference'];
  const sample = ['Example Person', '+923001234567', 'Lahore', 'Lahore', 'woman', '25-34', '', '', 'Teacher', 'member', 'Members; Volunteers', 'pilot', '2026-09-01', 'Signed form #12'];
  if (format === 'xlsx') {
    return { filename: 'raaye-contacts-template.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(buildXlsx([{ name: 'Contacts', rows: [header, sample] }])) };
  }
  return { filename: 'raaye-contacts-template.csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from(toCsv([header, sample]), 'utf8') };
}
