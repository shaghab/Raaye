import { Component, computed, inject, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import type { AudiencePreviewDto, PreviewMessageDto, SurveyDetailDto } from '@raaye/contracts';
import { firstValueFrom } from 'rxjs';
import { ApiError, ApiService, idempotencyKey } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { describeSeconds } from '../../core/format';
import { NotifyService } from '../../core/notify.service';
import { ConfirmService, SHARED } from '../../shared/ui';
import { BreakdownsPanelComponent, DispatchPanelComponent, ResponsesPanelComponent, ResultsPanelComponent, SharingPanelComponent } from './results-panels';
import { LaunchDialogComponent, PreviewDialogComponent, TestRunDialogComponent, type LaunchResult } from './survey-dialogs';

@Component({
  selector: 'rye-survey-detail',
  imports: [...SHARED, MatCardModule, MatTabsModule, MatMenuModule, RouterLink, ResultsPanelComponent, BreakdownsPanelComponent, DispatchPanelComponent, ResponsesPanelComponent, SharingPanelComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <a mat-icon-button routerLink="/surveys" aria-label="Back to surveys"><mat-icon svgIcon="back" /></a>
        <h1 data-testid="survey-heading">{{ survey()?.internalTitle ?? 'Survey' }}</h1>
        @if (survey(); as s) {
          <rye-chip [code]="s.state" />
          @if (s.archivedAt) { <rye-chip text="Archived" tone="warn" /> }
          @if (canManage()) {
            <div class="actions">
              @if (s.state === 'DRAFT') { <a mat-stroked-button [routerLink]="['/surveys', s.id, 'edit']" data-testid="survey-edit"><mat-icon svgIcon="edit" /> Edit</a> }
              <button mat-stroked-button type="button" (click)="preview()" data-testid="survey-preview"><mat-icon svgIcon="visibility" /> Preview messages</button>
              @if (s.state === 'DRAFT') {
                <button mat-stroked-button type="button" (click)="testRun()" data-testid="survey-test">Send test</button>
                <button mat-flat-button type="button" (click)="launch()" data-testid="survey-launch"><mat-icon svgIcon="send" /> Launch / schedule</button>
              }
              @if (s.state === 'SCHEDULED') { <button mat-stroked-button type="button" (click)="unschedule()">Unschedule</button> }
              @if (s.state === 'ACTIVE') { <button mat-stroked-button type="button" (click)="close()" data-testid="survey-close"><mat-icon svgIcon="stop" /> Close now</button> }
              <button mat-icon-button type="button" [matMenuTriggerFor]="moreMenu" aria-label="More actions"><mat-icon svgIcon="more" /></button>
              <mat-menu #moreMenu="matMenu">
                <button mat-menu-item type="button" (click)="clone()">Clone as new draft</button>
                @if (!s.archivedAt && (s.state === 'CLOSED' || s.state === 'DRAFT')) { <button mat-menu-item type="button" (click)="archive()">Archive</button> }
                @if (s.archivedAt) { <button mat-menu-item type="button" (click)="unarchive()">Unarchive</button> }
              </mat-menu>
            </div>
          }
        }
      </div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
      @if (survey(); as s) {
        @if (s.contentErrors.length) {
          <div class="banner bad"><strong>Content problems</strong><ul>@for (e of s.contentErrors; track $index) { <li>{{ e.questionIndex !== null ? 'Q' + (e.questionIndex + 1) + ': ' : '' }}{{ e.message }}</li> }</ul></div>
        }
        @if (!s.readiness.ok) {
          <div class="banner warn" data-testid="readiness-blockers"><strong>Not ready to send</strong><ul>@for (b of s.readiness.blockers; track b.code) { <li>{{ b.message }}</li> }</ul></div>
        }
        @if (s.liveRun?.dispatchBlockReason) { <div class="banner bad">Dispatch blocked: {{ s.liveRun?.dispatchBlockReason }}</div> }
        <mat-tab-group [selectedIndex]="tab()" (selectedIndexChange)="tab.set($event)" animationDuration="0ms">
          <mat-tab label="Overview">
            <div class="cards" style="margin-top: 16px">
              <mat-card>
                <mat-card-header><mat-card-title>Live run</mat-card-title></mat-card-header>
                <mat-card-content>
                  @if (s.liveRun; as run) {
                    <dl class="dl">
                      <dt>State</dt><dd><rye-chip [code]="run.state" /></dd>
                      <dt>Opens</dt><dd>{{ run.opensAt | dt }}</dd>
                      <dt>Closes</dt><dd>{{ run.closesAt | dt }} @if (run.closeReason) { <span class="small muted">({{ run.closeReason | label }})</span> }</dd>
                      <dt>Audience</dt><dd>{{ run.audienceSummary.selected }} selected · {{ run.audienceSummary.eligible }} eligible @if (exclusions(run.audienceSummary.exclusions)) { <span class="small muted">· excluded: {{ exclusions(run.audienceSummary.exclusions) }}</span> }</dd>
                      <dt>Content</dt><dd>Revision {{ run.revisionNumber }} (frozen)</dd>
                    </dl>
                  } @else {
                    <p class="muted">Not launched. @if (s.revision.scheduledOpensAt) { Planned opening {{ s.revision.scheduledOpensAt | dt }}. }</p>
                    @if (canManage()) { <button mat-stroked-button type="button" (click)="audiencePreview()" data-testid="audience-preview">Check audience eligibility</button> }
                    @if (audience(); as a) {
                      <p style="margin-top: 8px"><strong>{{ a.eligible }}</strong> of {{ a.selected }} selected contacts are eligible now ({{ a.mode | label }}). @if (exclusions(a.exclusions)) { Excluded: {{ exclusions(a.exclusions) }}. }</p>
                    }
                  }
                </mat-card-content>
              </mat-card>
              <mat-card>
                <mat-card-header><mat-card-title>Settings</mat-card-title></mat-card-header>
                <mat-card-content>
                  <dl class="dl">
                    <dt>Title</dt><dd>{{ s.revision.title | ltext }}</dd>
                    <dt>Duration</dt><dd>{{ duration(s) }}</dd>
                    <dt>Edit window</dt><dd>{{ s.revision.editWindowSeconds === 0 ? 'Edits disabled' : s.revision.editWindowSeconds + ' seconds after the first answer' }}</dd>
                    <dt>Audience</dt><dd>{{ s.revision.audience.mode | label }}</dd>
                    <dt>Messaging</dt><dd>{{ s.readiness.messagingMode === 'live' ? 'Live WhatsApp' : 'Mock provider' }}</dd>
                  </dl>
                  @for (w of s.readiness.warnings; track w.code) { <p class="small muted">{{ w.message }}</p> }
                </mat-card-content>
              </mat-card>
            </div>
            <mat-card>
              <mat-card-header><mat-card-title>Questions</mat-card-title><mat-card-subtitle>{{ s.revision.introduction | ltext }}</mat-card-subtitle></mat-card-header>
              <mat-card-content>
                @for (q of s.revision.questions; track q.id) {
                  <div class="question-line">
                    <strong>{{ q.position + 1 }}.</strong> {{ q.prompt | ltext }}
                    <span class="chip info">{{ q.authoringType | label }}</span>
                    <span class="chip">{{ q.renderer | label }}</span>
                    @if (q.type !== 'RATING') { <div class="small muted">{{ optionLabels(q.options) }}</div> }
                    @if (q.type === 'MULTI_CHOICE') { <div class="small muted">Select {{ q.minSelections }}–{{ q.maxSelections }}</div> }
                  </div>
                }
              </mat-card-content>
            </mat-card>
            @if (s.testRuns.length) {
              <mat-card>
                <mat-card-header><mat-card-title>Test runs</mat-card-title></mat-card-header>
                <mat-card-content>
                  @for (run of s.testRuns; track run.id) {
                    <div class="small"><rye-chip [code]="run.state" /> created {{ run.createdAt | dt }} · {{ run.audienceSummary.selected }} contact(s) · closes {{ run.closesAt | dt }}</div>
                  }
                  <p class="small muted">Test participation never enters results.</p>
                </mat-card-content>
              </mat-card>
            }
          </mat-tab>
          <mat-tab label="Results"><div class="tab-body"><rye-results-panel [surveyId]="s.id" /></div></mat-tab>
          <mat-tab label="Breakdowns"><div class="tab-body"><rye-breakdowns-panel [surveyId]="s.id" /></div></mat-tab>
          @if (canManage()) { <mat-tab label="Dispatch"><div class="tab-body"><rye-dispatch-panel [surveyId]="s.id" /></div></mat-tab> }
          @if (auth.hasRole('ADMIN')) { <mat-tab label="Responses"><div class="tab-body"><rye-responses-panel [surveyId]="s.id" /></div></mat-tab> }
          @if (canManage()) { <mat-tab label="Share results"><div class="tab-body"><rye-sharing-panel [surveyId]="s.id" /></div></mat-tab> }
        </mat-tab-group>
      }
    </div>
  `,
  styles: ['.dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; } .dl dt { color: var(--mat-sys-on-surface-variant); } .dl dd { margin: 0; } .question-line { padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); } .tab-body { padding-top: 16px; }'],
})
export class SurveyDetailComponent {
  readonly id = input.required<string>();
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  readonly survey = signal<SurveyDetailDto | null>(null);
  readonly audience = signal<AudiencePreviewDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly tab = signal(0);
  readonly canManage = computed(() => this.auth.hasRole('ADMIN', 'SURVEY_MANAGER'));

  constructor() {
    queueMicrotask(() => void this.load());
  }

  duration(survey: SurveyDetailDto): string {
    return survey.revision.explicitClosesAt ? `until ${survey.revision.explicitClosesAt}` : describeSeconds(survey.revision.durationSeconds);
  }

  exclusions(record: Record<string, number>): string {
    return Object.entries(record).map(([key, value]) => `${key.toLowerCase().replace(/_/g, ' ')} ${value}`).join(', ');
  }

  optionLabels(options: { label: Record<string, string> }[]): string {
    return options.map((option) => option.label['en'] ?? '').join(' · ');
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.survey.set(await this.api.get<SurveyDetailDto>(`/surveys/${this.id()}`));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async preview(): Promise<void> {
    try {
      const messages = await this.api.post<PreviewMessageDto[]>(`/surveys/${this.id()}/preview`);
      this.dialog.open(PreviewDialogComponent, { data: { messages }, width: '560px' });
    } catch (error) {
      this.notify.error(error);
    }
  }

  async audiencePreview(): Promise<void> {
    try {
      this.audience.set(await this.api.post<AudiencePreviewDto>(`/surveys/${this.id()}/audience-preview`));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async testRun(): Promise<void> {
    const ref = this.dialog.open(TestRunDialogComponent, { width: '560px' });
    const contactIds = (await firstValueFrom(ref.afterClosed())) as string[] | null | undefined;
    if (!contactIds?.length) return;
    try {
      this.survey.set(await this.api.post<SurveyDetailDto>(`/surveys/${this.id()}/test-runs`, { contactIds }));
      this.notify.success('Test invitations queued');
    } catch (error) {
      this.notify.error(error);
    }
  }

  async launch(): Promise<void> {
    const survey = this.survey();
    if (!survey) return;
    let eligible: number | null = this.audience()?.eligible ?? null;
    if (eligible === null) {
      try {
        const preview = await this.api.post<AudiencePreviewDto>(`/surveys/${this.id()}/audience-preview`);
        this.audience.set(preview);
        eligible = preview.eligible;
      } catch (error) {
        this.notify.error(error);
        return;
      }
    }
    const ref = this.dialog.open(LaunchDialogComponent, { data: { survey, eligible }, width: '520px' });
    const result = (await firstValueFrom(ref.afterClosed())) as LaunchResult | null | undefined;
    if (!result) return;
    try {
      this.survey.set(await this.api.post<SurveyDetailDto>(`/surveys/${this.id()}/launch`, result, { idempotencyKey: idempotencyKey(`launch-${this.id()}`) }));
      this.notify.success(result.mode === 'NOW' ? 'Survey launched' : 'Survey scheduled');
    } catch (error) {
      this.notify.error(error);
    }
  }

  async unschedule(): Promise<void> {
    if (!(await this.confirm.ask({ title: 'Unschedule survey', message: 'The scheduled run is canceled and the survey returns to draft. Nothing has been sent yet.', confirmLabel: 'Unschedule' }))) return;
    await this.run('unschedule', 'Survey unscheduled');
  }

  async close(): Promise<void> {
    if (!(await this.confirm.ask({ title: 'Close survey now', message: 'Participants can no longer answer or edit. Results freeze at the current canonical answers. This cannot be undone.', confirmLabel: 'Close survey', destructive: true }))) return;
    await this.run('close', 'Survey closed');
  }

  async archive(): Promise<void> {
    if (!(await this.confirm.ask({ title: 'Archive survey', message: 'The survey leaves the active list but keeps its research history. Surveys are never deleted.', confirmLabel: 'Archive' }))) return;
    await this.run('archive', 'Survey archived');
  }

  async unarchive(): Promise<void> {
    await this.run('unarchive', 'Survey restored');
  }

  async clone(): Promise<void> {
    try {
      const copy = await this.api.post<SurveyDetailDto>(`/surveys/${this.id()}/clone`);
      this.notify.success('Draft created from this survey');
      await this.router.navigate(['/surveys', copy.id]);
    } catch (error) {
      this.notify.error(error);
    }
  }

  private async run(action: string, message: string): Promise<void> {
    try {
      this.survey.set(await this.api.post<SurveyDetailDto>(`/surveys/${this.id()}/${action}`));
      this.notify.success(message);
    } catch (error) {
      this.notify.error(error);
    }
  }
}
