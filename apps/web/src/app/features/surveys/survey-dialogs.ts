import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import type { ContactSummaryDto, MessageDto, Page, PreviewMessageDto, SurveyDetailDto } from '@raaye/contracts';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { isoToLocal, localToIso } from '../../core/format';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

export interface LaunchResult {
  mode: 'NOW' | 'SCHEDULED';
  opensAt?: string;
  acknowledgeCharges?: boolean;
}

@Component({
  selector: 'rye-launch-dialog',
  imports: [...SHARED, FormsModule, MatDialogModule, MatRadioModule, MatFormFieldModule, MatInputModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>Launch "{{ data.survey.internalTitle }}"</h2>
    <mat-dialog-content class="stack">
      @if (!data.survey.readiness.ok) {
        <div class="banner bad">Launch is blocked:
          <ul>@for (b of data.survey.readiness.blockers; track b.code) { <li>{{ b.message }}</li> }</ul>
        </div>
      }
      <mat-radio-group [(ngModel)]="mode" class="stack">
        <mat-radio-button value="NOW">Send now</mat-radio-button>
        <mat-radio-button value="SCHEDULED">Schedule opening</mat-radio-button>
      </mat-radio-group>
      @if (mode === 'SCHEDULED') {
        <mat-form-field><mat-label>Opens at ({{ auth.timezone() }})</mat-label><input matInput type="datetime-local" [(ngModel)]="opensAt" required data-testid="launch-opens-at" /></mat-form-field>
      }
      <p class="small muted">The survey closes {{ hours }} hours after it opens. Audience membership is frozen now; permission is rechecked before each send.</p>
      @if (auth.messagingMode() === 'live') {
        <div class="banner warn">
          <mat-checkbox [(ngModel)]="acknowledgeCharges">I understand this sends real WhatsApp template messages to {{ eligible }} contacts and may incur Meta conversation charges.</mat-checkbox>
        </div>
      } @else {
        <div class="banner">Mock messaging: nothing leaves this environment.</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close(null)">Cancel</button>
      <button mat-flat-button type="button" [disabled]="!data.survey.readiness.ok || (mode === 'SCHEDULED' && !opensAt) || (auth.messagingMode() === 'live' && !acknowledgeCharges)" (click)="submit()" data-testid="launch-confirm">{{ mode === 'NOW' ? 'Launch now' : 'Schedule' }}</button>
    </mat-dialog-actions>
  `,
})
export class LaunchDialogComponent {
  readonly ref = inject<MatDialogRef<LaunchDialogComponent, LaunchResult | null>>(MatDialogRef);
  readonly data = inject<{ survey: SurveyDetailDto; eligible: number | null }>(MAT_DIALOG_DATA);
  readonly auth = inject(AuthService);
  mode: 'NOW' | 'SCHEDULED' = this.data.survey.revision.scheduledOpensAt ? 'SCHEDULED' : 'NOW';
  opensAt = isoToLocal(this.data.survey.revision.scheduledOpensAt, this.auth.timezone());
  acknowledgeCharges = false;
  readonly hours = Math.round(this.data.survey.revision.durationSeconds / 3600);
  readonly eligible = this.data.eligible ?? '?';

  submit(): void {
    const opensAt = this.mode === 'SCHEDULED' ? localToIso(this.opensAt, this.auth.timezone()) : null;
    if (this.mode === 'SCHEDULED' && !opensAt) return;
    this.ref.close({ mode: this.mode, opensAt: opensAt ?? undefined, acknowledgeCharges: this.acknowledgeCharges || undefined });
  }
}

@Component({
  selector: 'rye-test-run-dialog',
  imports: [...SHARED, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Send a test</h2>
    <mat-dialog-content class="stack">
      <p class="muted small">Test runs use a separate clock and never count in results. In live mode only contacts with permission can receive a test; in mock mode use the simulator to reply.</p>
      <div class="row">
        <mat-form-field class="spacer"><mat-label>Search contacts</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="find()" /></mat-form-field>
        <button mat-stroked-button type="button" (click)="find()">Search</button>
      </div>
      <div class="row">
        @for (c of results(); track c.id) { <button mat-stroked-button type="button" [disabled]="has(c.id)" (click)="add(c)">{{ c.name }} · {{ c.phoneE164 }}</button> }
      </div>
      <div class="row">
        @for (c of selected(); track c.id) { <span class="chip">{{ c.name }} <button type="button" class="chip-x" aria-label="Remove" (click)="remove(c.id)">×</button></span> }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close(null)">Cancel</button>
      <button mat-flat-button type="button" [disabled]="!selected().length" (click)="ref.close(ids())" data-testid="test-run-confirm">Send test to {{ selected().length }} contact(s)</button>
    </mat-dialog-actions>
  `,
  styles: ['.chip-x { border: none; background: none; cursor: pointer; }'],
})
export class TestRunDialogComponent {
  readonly ref = inject<MatDialogRef<TestRunDialogComponent, string[] | null>>(MatDialogRef);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  search = '';
  readonly results = signal<ContactSummaryDto[]>([]);
  readonly selected = signal<{ id: string; name: string }[]>([]);

  constructor() {
    void this.find();
  }

  async find(): Promise<void> {
    try {
      this.results.set((await this.api.get<Page<ContactSummaryDto>>('/contacts', { search: this.search, limit: 10 })).items);
    } catch (error) {
      this.notify.error(error);
    }
  }

  has(id: string): boolean {
    return this.selected().some((contact) => contact.id === id);
  }

  add(contact: ContactSummaryDto): void {
    if (!this.has(contact.id) && this.selected().length < 20) this.selected.update((list) => [...list, { id: contact.id, name: contact.name }]);
  }

  remove(id: string): void {
    this.selected.update((list) => list.filter((contact) => contact.id !== id));
  }

  ids(): string[] {
    return this.selected().map((contact) => contact.id);
  }
}

@Component({
  selector: 'rye-preview-dialog',
  imports: [...SHARED, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Message preview</h2>
    <mat-dialog-content>
      <p class="muted small">Exactly how each step is rendered for WhatsApp. Controls show the participant's choices; Flows open an in-WhatsApp form.</p>
      <div class="wa-chat">
        @for (m of data.messages; track $index) {
          <div class="wa-bubble out">
            <div class="small muted">{{ m.kind | label }} · {{ m.renderer | label }}</div>
            {{ m.text }}
            @if (m.controls.length) {
              <div class="wa-controls">@for (c of m.controls; track c.id) { <span class="chip">{{ c.label }}</span> }</div>
            }
            @if (m.flow) { <div class="small muted">Opens Flow: {{ m.flow.purpose | label }}</div> }
          </div>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-flat-button type="button" mat-dialog-close>Close</button></mat-dialog-actions>
  `,
})
export class PreviewDialogComponent {
  readonly data = inject<{ messages: PreviewMessageDto[] }>(MAT_DIALOG_DATA);
}

@Component({
  selector: 'rye-message-dialog',
  imports: [...SHARED, FormsModule, MatDialogModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Message {{ data.message.kind | label }}</h2>
    <mat-dialog-content class="stack">
      <div class="row"><rye-chip [code]="data.message.deliveryState" /> <rye-chip [code]="data.message.state" tone="neutral" /> @if (data.message.isTest) { <rye-chip text="Test" tone="info" /> }</div>
      <div class="small">To {{ data.message.contactName }} · created {{ data.message.createdAt | dt }} · provider id {{ data.message.providerMessageId || '—' }}</div>
      @if (data.message.suppressionReason) { <div class="banner warn">Suppressed: {{ data.message.suppressionReason | label }}</div> }
      <div class="wa-chat"><div class="wa-bubble out">{{ data.message.renderedSummary }}</div></div>
      <h3>Attempts</h3>
      @if (!data.message.attempts.length) { <p class="muted small">No send attempt yet.</p> }
      @for (a of data.message.attempts; track a.attemptNumber) {
        <div class="small">#{{ a.attemptNumber }} {{ a.startedAt | dt }} → <rye-chip [code]="a.outcome" /> {{ a.errorCode ? a.errorCode + ': ' + a.errorDetail : '' }} {{ a.authorizedByUserId ? '(explicit retry)' : '' }}</div>
      }
      <h3>Delivery events</h3>
      @if (!data.message.statusEvents.length) { <p class="muted small">No provider status events.</p> }
      @for (e of data.message.statusEvents; track $index) {
        <div class="small">{{ e.providerAt | dt }} <rye-chip [code]="e.status" /> {{ e.errorCode || '' }}</div>
      }
      @if (auth.hasRole('ADMIN') && retryable()) {
        <div class="banner warn stack">
          <strong>Explicit retry</strong>
          @if (data.message.deliveryState === 'UNKNOWN') {
            <mat-checkbox [(ngModel)]="acknowledge">The previous attempt timed out with an unknown outcome. I accept that the participant may receive this message twice.</mat-checkbox>
          }
          <mat-form-field><mat-label>Reason (audited)</mat-label><input matInput [(ngModel)]="reason" maxlength="300" /></mat-form-field>
          <button mat-flat-button type="button" [disabled]="data.message.deliveryState === 'UNKNOWN' && !acknowledge" (click)="retry()">Retry send</button>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-button type="button" mat-dialog-close>Close</button></mat-dialog-actions>
  `,
})
export class MessageDialogComponent {
  readonly data = inject<{ message: MessageDto }>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<MessageDialogComponent, boolean>>(MatDialogRef);
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  acknowledge = false;
  reason = '';

  retryable(): boolean {
    return ['FAILED', 'UNKNOWN', 'SUPPRESSED'].includes(this.data.message.deliveryState);
  }

  async retry(): Promise<void> {
    try {
      await this.api.post(`/messages/${this.data.message.id}/retry`, { acknowledgeDuplicateRisk: this.acknowledge || undefined, reason: this.reason.trim() || undefined });
      this.notify.success('Retry queued');
      this.ref.close(true);
    } catch (error) {
      this.notify.error(error);
    }
  }
}
