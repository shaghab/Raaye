import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatStepperModule } from '@angular/material/stepper';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { IMPORT_FIELDS, type ImportBatchDto, type ImportField, type ImportMapping, type ImportPreviewDto } from '@raaye/contracts';
import { ApiService, idempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { localToIso } from '../../core/format';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Name (required)',
  phone: 'Phone (required)',
  city: 'City',
  district: 'District',
  gender: 'Gender',
  ageBand: 'Age band',
  age: 'Age in years',
  ageAsOf: 'Age as-of date',
  occupation: 'Occupation',
  membership: 'Membership',
  preferredLocale: 'Preferred locale',
  groups: 'Groups (comma separated)',
  tags: 'Tags (comma separated)',
  consentEvidenceAt: 'Consent evidence date',
  consentReference: 'Consent reference',
};

function guessField(header: string): ImportField | '' {
  const key = header.trim().toLowerCase().replace(/[^a-z]/g, '');
  const guesses: Record<string, ImportField> = {
    name: 'name',
    fullname: 'name',
    phone: 'phone',
    phonenumber: 'phone',
    mobile: 'phone',
    whatsapp: 'phone',
    city: 'city',
    district: 'district',
    gender: 'gender',
    sex: 'gender',
    ageband: 'ageBand',
    age: 'age',
    ageasof: 'ageAsOf',
    occupation: 'occupation',
    membership: 'membership',
    member: 'membership',
    locale: 'preferredLocale',
    language: 'preferredLocale',
    groups: 'groups',
    group: 'groups',
    tags: 'tags',
    tag: 'tags',
    consentevidenceat: 'consentEvidenceAt',
    consentdate: 'consentEvidenceAt',
    consentreference: 'consentReference',
    consentref: 'consentReference',
  };
  return guesses[key] ?? '';
}

@Component({
  selector: 'rye-import-wizard',
  imports: [...SHARED, FormsModule, MatCardModule, MatStepperModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatRadioModule, MatTableModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Import contacts</h1>
        <div class="actions">
          <button mat-stroked-button type="button" (click)="template('csv')"><mat-icon svgIcon="download" /> CSV template</button>
          <button mat-stroked-button type="button" (click)="template('xlsx')"><mat-icon svgIcon="download" /> XLSX template</button>
        </div>
      </div>
      <mat-card>
        <mat-card-content>
          <mat-stepper [linear]="false" #stepper>
            <mat-step label="Upload" [completed]="!!batch()">
              <p class="muted">CSV or XLSX, up to 5 MB and 10,000 rows. Name and phone columns are required. The raw file is kept for 24 hours only.</p>
              <input type="file" accept=".csv,.xlsx" (change)="onFile($event)" data-testid="import-file" />
              @if (uploading()) { <p>Uploading…</p> }
              @if (batch(); as b) {
                <p class="banner ok">Uploaded <strong>{{ b.fileName }}</strong> ({{ b.fileType }}, {{ b.fileSize }} bytes). Detected columns: {{ b.headers?.join(', ') }}</p>
                <button mat-flat-button type="button" (click)="stepper.next()">Map columns</button>
              }
            </mat-step>
            <mat-step label="Map columns and rules" [completed]="!!preview()">
              @if (batch(); as b) {
                @if (b.sheetNames?.length) {
                  <mat-form-field><mat-label>Sheet</mat-label>
                    <mat-select [(ngModel)]="sheetName">@for (sheet of b.sheetNames; track sheet) { <mat-option [value]="sheet">{{ sheet }}</mat-option> }</mat-select>
                  </mat-form-field>
                }
                <div class="form-grid">
                  @for (header of b.headers ?? []; track header) {
                    <mat-form-field>
                      <mat-label>{{ header }}</mat-label>
                      <mat-select [(ngModel)]="columns[header]">
                        <mat-option value="">Ignore</mat-option>
                        @for (field of fields; track field) { <mat-option [value]="field">{{ fieldLabel(field) }}</mat-option> }
                      </mat-select>
                    </mat-form-field>
                  }
                </div>
                <div class="form-grid">
                  <mat-form-field><mat-label>Default country for national numbers</mat-label><input matInput [(ngModel)]="defaultCountry" maxlength="2" /></mat-form-field>
                  <div>
                    <strong>Existing contacts (same phone)</strong>
                    <mat-radio-group [(ngModel)]="duplicateMode" class="stack">
                      <mat-radio-button value="SKIP_EXISTING">Skip existing contacts</mat-radio-button>
                      <mat-radio-button value="UPDATE_NON_EMPTY_FIELDS">Update empty fields from the file</mat-radio-button>
                    </mat-radio-group>
                  </div>
                </div>
                <div class="banner warn">
                  <mat-checkbox [(ngModel)]="attest">This file documents permission already collected from these people (consent attestation)</mat-checkbox>
                  @if (attest) {
                    <div class="form-grid">
                      <div>
                        <mat-checkbox [(ngModel)]="attestInvitations">Survey invitations</mat-checkbox>
                        <mat-checkbox [(ngModel)]="attestResults">Result sharing</mat-checkbox>
                      </div>
                      <mat-form-field><mat-label>Where the consent evidence is kept</mat-label><input matInput [(ngModel)]="attestSource" maxlength="200" /></mat-form-field>
                      <mat-form-field><mat-label>Collected at</mat-label><input matInput type="datetime-local" [(ngModel)]="attestCollectedAt" /></mat-form-field>
                      <mat-form-field><mat-label>Consent wording version</mat-label><input matInput [(ngModel)]="attestWording" maxlength="50" /></mat-form-field>
                      <mat-checkbox class="full" [(ngModel)]="attestStatement">I confirm each listed person gave this permission and that withdrawn contacts must not be re-enabled by this import.</mat-checkbox>
                    </div>
                  } @else {
                    <p class="small">Without an attestation, imported contacts are created with <strong>unknown</strong> permission and cannot be invited until consent is recorded.</p>
                  }
                </div>
                <div class="row">
                  <button mat-flat-button type="button" [disabled]="previewing() || !mappingValid()" (click)="runPreview(stepper)" data-testid="import-preview">Preview</button>
                  <button mat-button type="button" (click)="stepper.previous()">Back</button>
                </div>
              }
            </mat-step>
            <mat-step label="Review" [completed]="!!result()">
              @if (preview(); as p) {
                @if (p.batch.summary; as s) {
                  <div class="cards">
                    <div class="metric"><div class="value">{{ s.totalRows }}</div><div class="label">Rows</div></div>
                    <div class="metric"><div class="value">{{ s.create }}</div><div class="label">To create</div></div>
                    <div class="metric"><div class="value">{{ s.update }}</div><div class="label">To update</div></div>
                    <div class="metric"><div class="value">{{ s.skip }}</div><div class="label">Skipped</div></div>
                    <div class="metric"><div class="value danger">{{ s.error }}</div><div class="label">Errors</div></div>
                    <div class="metric"><div class="value">{{ s.consentGrantedRows }}</div><div class="label">Consent rows</div><div class="small muted">{{ s.withdrawnProtected }} withdrawn protected</div></div>
                  </div>
                }
                <div class="table-wrap">
                  <table mat-table [dataSource]="p.rows">
                    <ng-container matColumnDef="row"><th mat-header-cell *matHeaderCellDef>Row</th><td mat-cell *matCellDef="let r">{{ r.rowNumber }}</td></ng-container>
                    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th><td mat-cell *matCellDef="let r"><rye-chip [code]="r.status" /></td></ng-container>
                    <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th><td mat-cell *matCellDef="let r">{{ r.name || '—' }}</td></ng-container>
                    <ng-container matColumnDef="phone"><th mat-header-cell *matHeaderCellDef>Phone</th><td mat-cell *matCellDef="let r" class="mono">{{ r.phoneE164 || '—' }}</td></ng-container>
                    <ng-container matColumnDef="consent"><th mat-header-cell *matHeaderCellDef>Consent</th><td mat-cell *matCellDef="let r">{{ r.consentEligible ? 'eligible' : 'unknown' }}</td></ng-container>
                    <ng-container matColumnDef="errors"><th mat-header-cell *matHeaderCellDef>Errors</th><td mat-cell *matCellDef="let r" class="small danger">@for (e of r.errors; track $index) { <div>{{ e.field ? e.field + ': ' : '' }}{{ e.message }}</div> }</td></ng-container>
                    <tr mat-header-row *matHeaderRowDef="previewColumns"></tr>
                    <tr mat-row *matRowDef="let row; columns: previewColumns"></tr>
                  </table>
                </div>
                <p class="small muted">Showing {{ p.rowsShown }} of {{ p.batch.summary?.totalRows }} rows. Rows with errors are skipped; everything else is applied in one transaction per batch.</p>
                <div class="row">
                  <button mat-flat-button type="button" [disabled]="confirming() || (p.batch.summary?.create ?? 0) + (p.batch.summary?.update ?? 0) === 0" (click)="confirm(stepper)" data-testid="import-confirm">Confirm import</button>
                  @if ((p.batch.summary?.error ?? 0) > 0) {
                    <button mat-stroked-button type="button" (click)="downloadErrors(p.batch.id)"><mat-icon svgIcon="download" /> Error report</button>
                  }
                  <button mat-button type="button" (click)="stepper.previous()">Back</button>
                </div>
              }
            </mat-step>
            <mat-step label="Done">
              @if (result(); as r) {
                @if (r.state === 'COMPLETED') {
                  <div class="banner ok" data-testid="import-done">Import {{ r.state | label }}: {{ r.summary?.create }} created, {{ r.summary?.update }} updated, {{ r.summary?.skip }} skipped, {{ r.summary?.error }} errors.</div>
                } @else {
                  <div class="banner bad" data-testid="import-done">
                    <strong>Import {{ r.state | label }}: it stopped before every row was applied.</strong>
                    So far {{ r.summary?.create ?? 0 }} created, {{ r.summary?.update ?? 0 }} updated, {{ r.summary?.skip ?? 0 }} skipped, {{ r.summary?.error ?? 0 }} errors; {{ remaining(r) }} rows not applied yet.
                    @if (r.errorMessage) { <div class="small">Reason: {{ r.errorMessage }}</div> }
                    @if (r.resumable) {
                      <div class="small">Rows already imported are kept. Resume to continue with the remaining rows; nothing is imported twice. The staged rows expire {{ r.rawExpiresAt | dt }}.</div>
                    } @else {
                      <div class="small">The staged rows have expired. Rows already imported are kept; upload the file again to import the rest.</div>
                    }
                  </div>
                }
                <div class="row">
                  @if (r.resumable) { <button mat-flat-button type="button" [disabled]="confirming()" (click)="resume(r.id)" data-testid="import-resume">Resume import</button> }
                  <a mat-flat-button routerLink="/contacts">Go to contacts</a>
                  @if ((r.summary?.error ?? 0) > 0) { <button mat-stroked-button type="button" (click)="downloadErrors(r.id)">Error report</button> }
                </div>
              }
            </mat-step>
          </mat-stepper>
        </mat-card-content>
      </mat-card>
      <mat-card>
        <mat-card-header><mat-card-title>Previous imports</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (history().length === 0) { <rye-state [empty]="true" emptyText="No imports yet." /> } @else {
            <div class="table-wrap">
              <table mat-table [dataSource]="history()">
                <ng-container matColumnDef="file"><th mat-header-cell *matHeaderCellDef>File</th><td mat-cell *matCellDef="let b">{{ b.fileName }}</td></ng-container>
                <ng-container matColumnDef="state"><th mat-header-cell *matHeaderCellDef>State</th><td mat-cell *matCellDef="let b"><rye-chip [code]="b.state" /></td></ng-container>
                <ng-container matColumnDef="summary"><th mat-header-cell *matHeaderCellDef>Summary</th><td mat-cell *matCellDef="let b" class="small">@if (b.summary) { {{ b.summary.create }} created · {{ b.summary.update }} updated · {{ b.summary.skip }} skipped · {{ b.summary.error }} errors } @else { — }</td></ng-container>
                <ng-container matColumnDef="when"><th mat-header-cell *matHeaderCellDef>Uploaded</th><td mat-cell *matCellDef="let b">{{ b.createdAt | dt }}</td></ng-container>
                <ng-container matColumnDef="actions"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let b">
                  @if (b.resumable) { <button mat-button type="button" [disabled]="confirming()" (click)="resume(b.id)">Resume</button> }
                  @if ((b.summary?.error ?? 0) > 0 && b.state !== 'EXPIRED') { <button mat-button type="button" (click)="downloadErrors(b.id)">Errors</button> }
                </td></ng-container>
                <tr mat-header-row *matHeaderRowDef="historyColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: historyColumns"></tr>
              </table>
            </div>
          }
        </mat-card-content>
      </mat-card>
    </div>
  `,
})
export class ImportWizardComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly auth = inject(AuthService);
  readonly fields = IMPORT_FIELDS;
  readonly batch = signal<ImportBatchDto | null>(null);
  readonly preview = signal<ImportPreviewDto | null>(null);
  readonly result = signal<ImportBatchDto | null>(null);
  readonly history = signal<ImportBatchDto[]>([]);
  readonly uploading = signal(false);
  readonly previewing = signal(false);
  readonly confirming = signal(false);
  readonly previewColumns = ['row', 'status', 'name', 'phone', 'consent', 'errors'];
  readonly historyColumns = ['file', 'state', 'summary', 'when', 'actions'];
  columns: Record<string, ImportField | ''> = {};
  sheetName = '';
  defaultCountry = 'PK';
  duplicateMode: 'SKIP_EXISTING' | 'UPDATE_NON_EMPTY_FIELDS' = 'SKIP_EXISTING';
  attest = false;
  attestInvitations = true;
  attestResults = false;
  attestSource = '';
  attestCollectedAt = '';
  attestWording = '';
  attestStatement = false;

  constructor() {
    void this.loadHistory();
  }

  fieldLabel(field: ImportField): string {
    return FIELD_LABELS[field];
  }

  async loadHistory(): Promise<void> {
    try {
      this.history.set(await this.api.get<ImportBatchDto[]>('/contact-imports'));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async template(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      await this.api.download('/contact-imports/template', { format });
    } catch (error) {
      this.notify.error(error);
    }
  }

  async onFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.uploading.set(true);
    try {
      const batch = await this.api.upload<ImportBatchDto>('/contact-imports', file);
      this.batch.set(batch);
      this.preview.set(null);
      this.result.set(null);
      this.columns = {};
      for (const header of batch.headers ?? []) this.columns[header] = guessField(header);
      this.sheetName = batch.sheetName ?? batch.sheetNames?.[0] ?? '';
      await this.loadHistory();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.uploading.set(false);
    }
  }

  mappingValid(): boolean {
    const mapped = Object.values(this.columns);
    if (!mapped.includes('name') || !mapped.includes('phone')) return false;
    if (this.attest && (!(this.attestInvitations || this.attestResults) || !this.attestSource.trim() || !this.attestCollectedAt || !this.attestWording.trim() || !this.attestStatement)) return false;
    return true;
  }

  private mapping(): ImportMapping {
    const columns: Record<string, ImportField> = {};
    for (const [header, field] of Object.entries(this.columns)) if (field) columns[header] = field;
    const mapping: ImportMapping = { columns, defaultCountry: this.defaultCountry.trim().toUpperCase() || 'PK', duplicateMode: this.duplicateMode, sheetName: this.sheetName || undefined };
    if (this.attest) {
      const collectedAt = localToIso(this.attestCollectedAt, this.auth.timezone()) ?? new Date().toISOString();
      const scopes: ('SURVEY_INVITATIONS' | 'SURVEY_RESULTS')[] = [];
      if (this.attestInvitations) scopes.push('SURVEY_INVITATIONS');
      if (this.attestResults) scopes.push('SURVEY_RESULTS');
      mapping.consentAttestation = { scopes, source: this.attestSource.trim(), collectedAt, wordingVersion: this.attestWording.trim(), statement: true };
    }
    return mapping;
  }

  async runPreview(stepper: { next: () => void }): Promise<void> {
    const batch = this.batch();
    if (!batch) return;
    this.previewing.set(true);
    try {
      this.preview.set(await this.api.post<ImportPreviewDto>(`/contact-imports/${batch.id}/preview`, this.mapping()));
      stepper.next();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.previewing.set(false);
    }
  }

  async confirm(stepper: { next: () => void }): Promise<void> {
    const batch = this.batch();
    if (!batch) return;
    this.confirming.set(true);
    try {
      this.result.set(await this.api.post<ImportBatchDto>(`/contact-imports/${batch.id}/confirm`, {}, { idempotencyKey: idempotencyKey(`import-${batch.id}`) }));
      stepper.next();
    } catch (error) {
      // Processing stopped part-way: show the failed batch with what was applied and the resume path.
      if (await this.showFailure(error, batch.id)) stepper.next();
    } finally {
      this.confirming.set(false);
      await this.loadHistory();
    }
  }

  /** Continue a batch whose processing stopped; rows already applied are never applied twice. */
  async resume(batchId: string): Promise<void> {
    this.confirming.set(true);
    try {
      const resumed = await this.api.post<ImportBatchDto>(`/contact-imports/${batchId}/confirm`, {}, { idempotencyKey: idempotencyKey(`import-resume-${batchId}`) });
      this.result.set(resumed);
      this.notify.info(`Import ${resumed.state.toLowerCase()}: ${resumed.summary?.create ?? 0} created, ${resumed.summary?.update ?? 0} updated, ${resumed.summary?.skip ?? 0} skipped, ${resumed.summary?.error ?? 0} errors.`);
    } catch (error) {
      await this.showFailure(error, batchId);
    } finally {
      this.confirming.set(false);
      await this.loadHistory();
    }
  }

  /** Rows that were planned as create/update but not applied yet (unfinished batches only). */
  remaining(batch: ImportBatchDto): number {
    const summary = batch.summary;
    if (!summary) return 0;
    return Math.max(0, summary.totalRows - summary.create - summary.update - summary.skip - summary.error);
  }

  private async showFailure(error: unknown, batchId: string): Promise<boolean> {
    const apiError = this.notify.error(error);
    if (apiError.code !== 'IMPORT_PROCESSING_FAILED') return false;
    try {
      this.result.set(await this.api.get<ImportBatchDto>(`/contact-imports/${batchId}`));
      return true;
    } catch (reload) {
      this.notify.error(reload);
      return false;
    }
  }

  async downloadErrors(batchId: string): Promise<void> {
    try {
      await this.api.download(`/contact-imports/${batchId}/errors`);
    } catch (error) {
      this.notify.error(error);
    }
  }
}
