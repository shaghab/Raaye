import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { DEMOGRAPHIC_DIMENSIONS, type BreakdownDto, type DispatchDto, type IndividualResponseDto, type MessageDto, type Page, type ResultSharePreviewDto, type ResultSharingDto, type ResultsDto } from '@raaye/contracts';
import { firstValueFrom } from 'rxjs';
import { ApiError, ApiService, idempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { NotifyService } from '../../core/notify.service';
import { ConfirmService, SHARED } from '../../shared/ui';
import { MessageDialogComponent } from './survey-dialogs';

@Component({
  selector: 'rye-results-panel',
  imports: [...SHARED, MatCardModule, MatMenuModule],
  template: `
    <div class="row" style="margin-bottom: 12px">
      <button mat-stroked-button type="button" (click)="load()"><mat-icon svgIcon="refresh" /> Refresh</button>
      <button mat-stroked-button type="button" [matMenuTriggerFor]="exportMenu"><mat-icon svgIcon="download" /> Export aggregates</button>
      <mat-menu #exportMenu="matMenu">
        <button mat-menu-item type="button" (click)="export('csv')">CSV</button>
        <button mat-menu-item type="button" (click)="export('xlsx')">XLSX</button>
      </mat-menu>
      @if (results(); as r) { <span class="small muted">Refreshed {{ r.refreshedAt | dt }} @if (r.isSnapshot) { · frozen snapshot } · revision {{ r.revisionNumber }}</span> }
    </div>
    <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
    @if (results(); as r) {
      @if (!r.runId) {
        <rye-state [empty]="true" emptyText="No live run yet. Results appear once the survey is launched." />
      } @else {
        <div class="cards">
          <mat-card class="metric"><div class="value">{{ r.started }}</div><div class="label">Started</div></mat-card>
          <mat-card class="metric"><div class="value">{{ r.responded }}</div><div class="label">Responded (≥1 valid answer)</div></mat-card>
          <mat-card class="metric"><div class="value">{{ r.completed }}</div><div class="label">Completed</div></mat-card>
        </div>
        @for (q of r.questions; track q.questionId) {
          <mat-card data-testid="result-question">
            <mat-card-header>
              <mat-card-title>{{ q.position + 1 }}. {{ q.prompt | ltext }}</mat-card-title>
              <mat-card-subtitle>{{ q.type | label }} · {{ q.validAnswers }} valid answers · {{ q.unansweredAmongStarted }} started without answering @if (q.ratingMean !== null) { · mean {{ q.ratingMean }} } @if (q.percentagesMaySumOver100) { · percentages are of respondents and may exceed 100% in total }</mat-card-subtitle>
            </mat-card-header>
            <mat-card-content>
              @for (o of q.options; track o.optionId) {
                <div class="result-row">
                  <span>{{ o.label | ltext }}</span>
                  <div class="bar" role="img" [attr.aria-label]="(o.percentage ?? 0) + ' percent'"><span [style.width.%]="o.percentage ?? 0"></span></div>
                  <span class="mono">{{ o.count }} · {{ o.percentage | pct }}</span>
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
      }
    }
  `,
})
export class ResultsPanelComponent {
  readonly surveyId = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly results = signal<ResultsDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.results.set(await this.api.get<ResultsDto>(`/surveys/${this.surveyId()}/results`));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async export(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      await this.api.download(`/surveys/${this.surveyId()}/exports/aggregates`, { format });
    } catch (error) {
      this.notify.error(error);
    }
  }
}

@Component({
  selector: 'rye-breakdowns-panel',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatSelectModule, MatMenuModule, MatTableModule],
  template: `
    <div class="row" style="margin-bottom: 12px">
      <mat-form-field><mat-label>Dimension</mat-label><mat-select [(ngModel)]="dimension" (selectionChange)="load()">@for (d of dimensions; track d) { <mat-option [value]="d">{{ d | label }}</mat-option> }</mat-select></mat-form-field>
      <button mat-stroked-button type="button" [matMenuTriggerFor]="exportMenu"><mat-icon svgIcon="download" /> Export</button>
      <mat-menu #exportMenu="matMenu">
        <button mat-menu-item type="button" (click)="export('csv')">CSV</button>
        <button mat-menu-item type="button" (click)="export('xlsx')">XLSX</button>
      </mat-menu>
      @if (data(); as b) { <span class="small muted">Cohorts under {{ b.threshold }} respondents are {{ b.thresholdApplied ? 'suppressed for your role' : 'shown (Admin)' }}. Profiles are frozen at participation start.</span> }
    </div>
    <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
    @if (data(); as b) {
      @if (!b.questions.length) { <rye-state [empty]="true" emptyText="No results to break down yet." /> }
      @for (q of b.questions; track q.questionId) {
        <mat-card>
          <mat-card-header><mat-card-title>{{ q.position + 1 }}. {{ q.prompt | ltext }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="table-wrap">
              <table class="grid">
                <thead><tr><th>{{ b.dimension | label }}</th><th>Respondents</th>@for (o of q.options; track o.optionId) { <th>{{ o.label | ltext }}</th> }</tr></thead>
                <tbody>
                  @for (c of q.cohorts; track c.cohort) {
                    <tr>
                      <td>{{ c.label }}</td>
                      <td>{{ c.suppressed ? 'suppressed' : c.respondents }}</td>
                      @for (o of q.options; track o.optionId) {
                        <td>@if (c.suppressed) { — } @else { {{ cell(c, o.optionId) }} }</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </mat-card-content>
        </mat-card>
      }
    }
  `,
  styles: ['.grid { border-collapse: collapse; width: 100%; } .grid th, .grid td { padding: 6px 10px; border-bottom: 1px solid var(--mat-sys-outline-variant); text-align: left; font-size: 13px; }'],
})
export class BreakdownsPanelComponent {
  readonly surveyId = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly dimensions = DEMOGRAPHIC_DIMENSIONS;
  dimension: (typeof DEMOGRAPHIC_DIMENSIONS)[number] = 'city';
  readonly data = signal<BreakdownDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  cell(cohort: BreakdownDto['questions'][number]['cohorts'][number], optionId: string): string {
    const option = cohort.options.find((item) => item.optionId === optionId);
    if (!option) return '—';
    return `${option.count} (${option.percentage === null ? 'N/A' : option.percentage.toFixed(1) + '%'})`;
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.api.get<BreakdownDto>(`/surveys/${this.surveyId()}/breakdowns`, { dimension: this.dimension }));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async export(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      await this.api.download(`/surveys/${this.surveyId()}/exports/breakdowns`, { format, dimension: this.dimension });
    } catch (error) {
      this.notify.error(error);
    }
  }
}

@Component({
  selector: 'rye-dispatch-panel',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTableModule, MatPaginatorModule],
  template: `
    <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
    @if (data(); as d) {
      @if (!d.run) {
        <rye-state [empty]="true" emptyText="No live run yet." />
      } @else {
        @if (d.run.dispatchBlockReason) { <div class="banner bad">Dispatch blocked: {{ d.run.dispatchBlockReason }}</div> }
        @if (d.metrics; as m) {
          <div class="cards">
            <mat-card class="metric"><div class="value">{{ m.selected }}</div><div class="label">Selected</div><div class="small muted">{{ m.eligibleAtLaunch }} eligible at launch</div></mat-card>
            <mat-card class="metric"><div class="value">{{ m.providerAccepted }}</div><div class="label">Accepted by provider</div><div class="small muted">{{ m.queued }} queued · {{ m.failed }} failed · {{ m.suppressed }} suppressed · {{ m.unknown }} unknown</div></mat-card>
            <mat-card class="metric"><div class="value">{{ m.delivered }}</div><div class="label">Delivered (evidence)</div></mat-card>
            <mat-card class="metric"><div class="value">{{ m.responseRate | pct }}</div><div class="label">Response rate</div><div class="small muted">{{ m.deliveredRespondents }} respondents among delivered</div></mat-card>
            <mat-card class="metric"><div class="value">{{ m.completionRate | pct }}</div><div class="label">Completion rate</div><div class="small muted">{{ m.completed }} of {{ m.started }} started</div></mat-card>
          </div>
        }
        <div class="toolbar-row">
          <mat-form-field><mat-label>Search</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="apply()" /></mat-form-field>
          <mat-form-field><mat-label>Invitation state</mat-label><mat-select [(ngModel)]="state" (selectionChange)="apply()"><mat-option [value]="null">Any</mat-option>@for (s of states; track s) { <mat-option [value]="s">{{ s | label }}</mat-option> }</mat-select></mat-form-field>
          <button mat-stroked-button type="button" (click)="apply()"><mat-icon svgIcon="refresh" /> Refresh</button>
        </div>
        <div class="table-wrap">
          <table mat-table [dataSource]="d.recipients.items" data-testid="dispatch-table">
            <ng-container matColumnDef="contact"><th mat-header-cell *matHeaderCellDef>Contact</th><td mat-cell *matCellDef="let r">{{ r.contactName }}<div class="mono small">{{ r.phoneE164 }}</div></td></ng-container>
            <ng-container matColumnDef="eligible"><th mat-header-cell *matHeaderCellDef>At freeze</th><td mat-cell *matCellDef="let r">{{ r.eligibleAtFreeze ? 'eligible' : (r.exclusionReason | label) }}</td></ng-container>
            <ng-container matColumnDef="invitation"><th mat-header-cell *matHeaderCellDef>Invitation</th><td mat-cell *matCellDef="let r"><rye-chip [code]="r.invitationState" /></td></ng-container>
            <ng-container matColumnDef="delivery"><th mat-header-cell *matHeaderCellDef>Delivery</th><td mat-cell *matCellDef="let r"><rye-chip [code]="r.deliveryState" /> @if (r.lastErrorCode) { <span class="small danger">{{ r.lastErrorCode }}</span> }</td></ng-container>
            <ng-container matColumnDef="participation"><th mat-header-cell *matHeaderCellDef>Participation</th><td mat-cell *matCellDef="let r"><rye-chip [code]="r.participationState" /> <span class="small muted">{{ r.answeredCount }} answered</span></td></ng-container>
            <ng-container matColumnDef="actions"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let r">@if (r.messageId) { <button mat-button type="button" (click)="openMessage(r.messageId)">Details</button> }</td></ng-container>
            <tr mat-header-row *matHeaderRowDef="columns"></tr>
            <tr mat-row *matRowDef="let row; columns: columns"></tr>
          </table>
        </div>
        <mat-paginator [length]="d.recipients.total" [pageSize]="d.recipients.limit" [pageIndex]="d.recipients.offset / d.recipients.limit" [pageSizeOptions]="[25, 50, 100]" (page)="paginate($event)" />
      }
    }
  `,
})
export class DispatchPanelComponent {
  readonly surveyId = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly dialog = inject(MatDialog);
  readonly states = ['PENDING', 'QUEUED', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SUPPRESSED', 'CANCELED'];
  readonly columns = ['contact', 'eligible', 'invitation', 'delivery', 'participation', 'actions'];
  readonly data = signal<DispatchDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  search = '';
  state: string | null = null;
  limit = 25;
  offset = 0;

  constructor() {
    queueMicrotask(() => void this.load());
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.api.get<DispatchDto>(`/surveys/${this.surveyId()}/dispatch`, { search: this.search, state: this.state, limit: this.limit, offset: this.offset }));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  apply(): void {
    this.offset = 0;
    void this.load();
  }

  paginate(event: PageEvent): void {
    this.limit = event.pageSize;
    this.offset = event.pageIndex * event.pageSize;
    void this.load();
  }

  async openMessage(messageId: string): Promise<void> {
    try {
      const message = await this.api.get<MessageDto>(`/messages/${messageId}`);
      const ref = this.dialog.open(MessageDialogComponent, { data: { message }, width: '640px' });
      if (await firstValueFrom(ref.afterClosed())) await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }
}

@Component({
  selector: 'rye-responses-panel',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatExpansionModule, MatPaginatorModule, MatMenuModule],
  template: `
    <div class="banner warn">Identifiable answers. Access is audited; exports are restricted to Admins.</div>
    <div class="toolbar-row">
      <mat-form-field><mat-label>Search name or phone</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="apply()" /></mat-form-field>
      <mat-form-field><mat-label>State</mat-label><mat-select [(ngModel)]="state" (selectionChange)="apply()"><mat-option [value]="null">Any</mat-option><mat-option value="STARTED">Started</mat-option><mat-option value="COMPLETED">Completed</mat-option></mat-select></mat-form-field>
      <button mat-stroked-button type="button" (click)="apply()">Apply</button>
      <button mat-stroked-button type="button" [matMenuTriggerFor]="exportMenu"><mat-icon svgIcon="download" /> Export</button>
      <mat-menu #exportMenu="matMenu">
        <button mat-menu-item type="button" (click)="export('responses', 'csv')">Current answers (CSV)</button>
        <button mat-menu-item type="button" (click)="export('responses', 'xlsx')">Current answers (XLSX)</button>
        <button mat-menu-item type="button" (click)="export('revisions', 'csv')">Answer revisions (CSV)</button>
        <button mat-menu-item type="button" (click)="export('revisions', 'xlsx')">Answer revisions (XLSX)</button>
      </mat-menu>
    </div>
    <rye-state [loading]="loading()" [error]="error()" [retry]="load" [empty]="!loading() && !error() && page()?.items?.length === 0" emptyText="No responses yet." />
    @if (page(); as p) {
      <mat-accordion>
        @for (r of p.items; track r.participationId) {
          <mat-expansion-panel>
            <mat-expansion-panel-header>
              <mat-panel-title>{{ r.contactName }} <span class="mono small" style="margin-left: 8px">{{ r.phoneE164 }}</span></mat-panel-title>
              <mat-panel-description><rye-chip [code]="r.state" /> &nbsp; {{ r.answers.length }} answers · started {{ r.startedAt | dt }}</mat-panel-description>
            </mat-expansion-panel-header>
            @if (r.analysisProfile) { <p class="small muted">Frozen profile: {{ profile(r.analysisProfile) }}</p> }
            @for (a of r.answers; track a.questionId) {
              <div class="answer">
                <strong>Q{{ a.position + 1 }}</strong>: {{ selections(a.selections) }}
                <span class="small muted">· revision {{ a.currentRevisionNumber }} · first {{ a.firstAcceptedAt | dt }} · edit window until {{ a.editExpiresAt | dt }}</span>
                @if (a.revisions.length > 1) {
                  <div class="small muted">History: @for (rev of a.revisions; track rev.revisionNumber) { <span>#{{ rev.revisionNumber }} {{ selections(rev.selections) }} ({{ rev.source }}, {{ rev.acceptedAt | dt }})</span> }</div>
                }
              </div>
            }
          </mat-expansion-panel>
        }
      </mat-accordion>
      <mat-paginator [length]="p.total" [pageSize]="p.limit" [pageIndex]="p.offset / p.limit" [pageSizeOptions]="[25, 50, 100]" (page)="paginate($event)" />
    }
  `,
  styles: ['.answer { padding: 6px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); } .answer span + span { margin-left: 8px; }'],
})
export class ResponsesPanelComponent {
  readonly surveyId = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly page = signal<Page<IndividualResponseDto> | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  search = '';
  state: string | null = null;
  limit = 25;
  offset = 0;

  constructor() {
    queueMicrotask(() => void this.load());
  }

  selections(items: { label: Record<string, string>; ratingValue: number | null }[]): string {
    return items.map((item) => (item.ratingValue !== null ? String(item.ratingValue) : item.label['en'] ?? '')).join(', ') || '—';
  }

  profile(profile: Record<string, string | null>): string {
    return Object.entries(profile).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'none';
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.page.set(await this.api.get<Page<IndividualResponseDto>>(`/surveys/${this.surveyId()}/responses`, { search: this.search, state: this.state, limit: this.limit, offset: this.offset }));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  apply(): void {
    this.offset = 0;
    void this.load();
  }

  paginate(event: PageEvent): void {
    this.limit = event.pageSize;
    this.offset = event.pageIndex * event.pageSize;
    void this.load();
  }

  async export(type: 'responses' | 'revisions', format: 'csv' | 'xlsx'): Promise<void> {
    try {
      await this.api.download(`/surveys/${this.surveyId()}/exports/${type}`, { format });
    } catch (error) {
      this.notify.error(error);
    }
  }
}

@Component({
  selector: 'rye-sharing-panel',
  imports: [...SHARED, MatCardModule],
  template: `
    <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
    @if (status(); as s) {
      @if (s.snapshot; as snap) {
        <mat-card>
          <mat-card-header><mat-card-title>Shared snapshot</mat-card-title><mat-card-subtitle>Generated {{ snap.generatedAt | dt }} by {{ snap.createdByEmail || snap.createdByUserId }} · <rye-chip [code]="snap.broadcastState" /></mat-card-subtitle></mat-card-header>
          <mat-card-content>
            <p>{{ snap.eligibleCount }} eligible recipients · {{ snap.suppressedCount }} excluded · {{ snap.questionsShared }} questions shared, {{ snap.questionsSuppressed }} withheld for small samples.</p>
            @if (snap.revokedAt) { <div class="banner warn">Revoked {{ snap.revokedAt | dt }}. Participants no longer receive results on request.</div> }
            @if (s.recipients; as rec) {
              <p class="small">Recipients: @for (entry of entries(rec.byState); track entry[0]) { <span><rye-chip [code]="entry[0]" /> {{ entry[1] }} &nbsp;</span> }</p>
              <p class="small muted">Delivery of invitations: @for (entry of entries(rec.byDelivery); track entry[0]) { <span>{{ entry[0] | label }} {{ entry[1] }} · </span> }</p>
            }
            @if (auth.hasRole('ADMIN') && !snap.revokedAt) {
              <button mat-stroked-button type="button" (click)="revoke()">Revoke sharing</button>
            }
          </mat-card-content>
        </mat-card>
      } @else if (auth.hasRole('ADMIN')) {
        <mat-card>
          <mat-card-header><mat-card-title>Share aggregate results with respondents</mat-card-title></mat-card-header>
          <mat-card-content class="stack">
            <p class="muted">Available after closure. One frozen aggregate snapshot is sent once to real respondents who have result-sharing permission and are not opted out. Questions with fewer than the minimum respondents are withheld.</p>
            <button mat-stroked-button type="button" (click)="preview()" data-testid="share-preview">Preview eligibility</button>
            @if (previewData(); as p) {
              <div class="banner" [class.ok]="p.canShare" [class.warn]="!p.canShare">
                @if (p.canShare) { Ready: {{ p.eligibleRecipients }} recipients will be invited. } @else { Cannot share yet: {{ p.reason }} }
                @if (p.alreadyShared) { Already shared. }
              </div>
              <p class="small">Excluded: @for (entry of entries(p.excluded); track entry[0]) { <span>{{ entry[0] | label }}: {{ entry[1] }} · </span> } @if (!entries(p.excluded).length) { none }</p>
              <ul class="small">
                @for (q of p.questions; track q.questionId) { <li>Q{{ q.position + 1 }} {{ q.prompt | ltext }} — {{ q.shareable ? 'shared (' + q.validAnswers + ' answers)' : 'withheld: ' + q.reason }}</li> }
              </ul>
              <details><summary>Message preview</summary><div class="wa-chat"><div class="wa-bubble out">{{ p.messagePreview }}</div>@for (chunk of p.summaryPreview; track $index) { <div class="wa-bubble out">{{ chunk }}</div> }</div></details>
              @if (p.canShare && !p.alreadyShared) {
                <button mat-flat-button type="button" [disabled]="sharing()" (click)="share()" data-testid="share-confirm">Share results now</button>
              }
            }
          </mat-card-content>
        </mat-card>
      } @else {
        <rye-state [empty]="true" emptyText="Results have not been shared with participants. Only an Admin can share them after closure." />
      }
    }
  `,
})
export class SharingPanelComponent {
  readonly surveyId = input.required<string>();
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly confirm = inject(ConfirmService);
  readonly status = signal<ResultSharingDto | null>(null);
  readonly previewData = signal<ResultSharePreviewDto | null>(null);
  readonly loading = signal(false);
  readonly sharing = signal(false);
  readonly error = signal<string | null>(null);
  readonly canShare = computed(() => this.previewData()?.canShare ?? false);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  entries(record: Record<string, number>): [string, number][] {
    return Object.entries(record);
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.status.set(await this.api.get<ResultSharingDto>(`/surveys/${this.surveyId()}/result-sharing`));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async preview(): Promise<void> {
    try {
      this.previewData.set(await this.api.post<ResultSharePreviewDto>(`/surveys/${this.surveyId()}/results-preview`));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async share(): Promise<void> {
    const preview = this.previewData();
    if (!preview) return;
    const ok = await this.confirm.ask({ title: 'Share results', message: `Send the results invitation to ${preview.eligibleRecipients} respondent(s)? This happens once and freezes the shared aggregate.`, confirmLabel: 'Share' });
    if (!ok) return;
    this.sharing.set(true);
    try {
      this.status.set(await this.api.post<ResultSharingDto>(`/surveys/${this.surveyId()}/share-results`, { confirm: true }, { idempotencyKey: idempotencyKey(`share-${this.surveyId()}`) }));
      this.notify.success('Results shared');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.sharing.set(false);
    }
  }

  async revoke(): Promise<void> {
    const ok = await this.confirm.ask({ title: 'Revoke result sharing', message: 'Participants will no longer receive the shared summary when they ask for it. Messages already delivered cannot be recalled.', confirmLabel: 'Revoke', destructive: true });
    if (!ok) return;
    try {
      this.status.set(await this.api.post<ResultSharingDto>(`/surveys/${this.surveyId()}/result-sharing/revoke`));
      this.notify.success('Sharing revoked');
    } catch (error) {
      this.notify.error(error);
    }
  }
}
