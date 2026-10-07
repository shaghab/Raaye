import { Component, inject, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { ConsentEventCreate, ConsentEventDto, ContactDetailDto } from '@raaye/contracts';
import { firstValueFrom } from 'rxjs';
import { ApiError, ApiService } from '../../core/api.service';
import { NotifyService } from '../../core/notify.service';
import { ConfirmService, SHARED } from '../../shared/ui';
import { ConsentDialogComponent } from './consent-dialog.component';

@Component({
  selector: 'rye-contact-detail',
  imports: [...SHARED, MatCardModule, MatTableModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <a mat-icon-button routerLink="/contacts" aria-label="Back to contacts"><mat-icon svgIcon="back" /></a>
        <h1>{{ contact()?.name ?? 'Contact' }}</h1>
        @if (contact(); as c) {
          @if (c.archivedAt) { <rye-chip text="Archived" tone="warn" /> }
          @if (c.isSynthetic) { <rye-chip text="Synthetic (never messaged live)" tone="info" /> }
          <div class="actions">
            <button mat-stroked-button type="button" (click)="recordConsent()" data-testid="record-consent"><mat-icon svgIcon="check" /> Record consent</button>
            <a mat-stroked-button [routerLink]="['/contacts', c.id, 'edit']"><mat-icon svgIcon="edit" /> Edit</a>
            @if (c.archivedAt) {
              <button mat-stroked-button type="button" (click)="unarchive()">Unarchive</button>
            } @else {
              <button mat-stroked-button type="button" (click)="archive()"><mat-icon svgIcon="archive" /> Archive</button>
            }
          </div>
        }
      </div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
      @if (contact(); as c) {
        <div class="cards">
          <mat-card>
            <mat-card-header><mat-card-title>Profile</mat-card-title></mat-card-header>
            <mat-card-content>
              <dl class="dl">
                <dt>Phone</dt><dd class="mono">{{ c.phoneE164 }}</dd>
                <dt>City</dt><dd>{{ c.city || '—' }}</dd>
                <dt>District</dt><dd>{{ c.district || '—' }}</dd>
                <dt>Gender</dt><dd>{{ c.gender | label }}</dd>
                <dt>Age band</dt><dd>{{ c.ageBand | label }} @if (c.ageYears !== null) { <span class="muted small">({{ c.ageYears }} as of {{ c.ageAsOf | dt: 'date' }})</span> }</dd>
                <dt>Occupation</dt><dd>{{ c.occupation || '—' }}</dd>
                <dt>Membership</dt><dd>{{ c.membership | label }} <span class="muted small">{{ c.membershipSource ? '(' + (c.membershipSource | label) + ')' : '' }}</span>@if (c.selfReportedMembership && c.selfReportedMembership !== c.membership) { <span class="muted small">· self-reported: {{ c.selfReportedMembership | label }}</span> }</dd>
                <dt>Groups</dt><dd>{{ c.groups.length ? joinNames(c.groups) : '—' }}</dd>
                <dt>Tags</dt><dd>{{ c.tags.length ? joinNames(c.tags) : '—' }}</dd>
                <dt>Created</dt><dd>{{ c.createdAt | dt }}</dd>
              </dl>
            </mat-card-content>
          </mat-card>
          <mat-card>
            <mat-card-header><mat-card-title>Permissions</mat-card-title></mat-card-header>
            <mat-card-content>
              <dl class="dl">
                <dt>Survey invitations</dt><dd><rye-chip [code]="c.consent.invitations" /> <span class="small muted">{{ c.consent.invitationsEvidenceAt ? 'evidence ' + (c.consent.invitationsEvidenceAt | dt) : '' }}</span></dd>
                <dt>Result sharing</dt><dd><rye-chip [code]="c.consent.results" /> <span class="small muted">{{ c.consent.resultsEvidenceAt ? 'evidence ' + (c.consent.resultsEvidenceAt | dt) : '' }}</span></dd>
              </dl>
              <p class="small muted">Unknown permission means no proactive outreach. Imports never grant consent by themselves.</p>
            </mat-card-content>
          </mat-card>
        </div>
        <mat-card>
          <mat-card-header><mat-card-title>Consent history</mat-card-title></mat-card-header>
          <mat-card-content>
            @if (events().length === 0) {
              <rye-state [empty]="true" emptyText="No consent events recorded." />
            } @else {
              <div class="table-wrap">
                <table mat-table [dataSource]="events()">
                  <ng-container matColumnDef="when"><th mat-header-cell *matHeaderCellDef>Evidence</th><td mat-cell *matCellDef="let e">{{ e.evidenceAt | dt }}</td></ng-container>
                  <ng-container matColumnDef="scope"><th mat-header-cell *matHeaderCellDef>Scope</th><td mat-cell *matCellDef="let e">{{ e.scope | label }}</td></ng-container>
                  <ng-container matColumnDef="type"><th mat-header-cell *matHeaderCellDef>Event</th><td mat-cell *matCellDef="let e"><rye-chip [code]="e.type" /></td></ng-container>
                  <ng-container matColumnDef="source"><th mat-header-cell *matHeaderCellDef>Source</th><td mat-cell *matCellDef="let e">{{ e.source | label }}</td></ng-container>
                  <ng-container matColumnDef="reference"><th mat-header-cell *matHeaderCellDef>Reference / wording</th><td mat-cell *matCellDef="let e" class="small">{{ e.evidenceReference || '—' }} {{ e.wordingVersion ? '· ' + e.wordingVersion : '' }} {{ e.note ? '· ' + e.note : '' }}</td></ng-container>
                  <ng-container matColumnDef="actor"><th mat-header-cell *matHeaderCellDef>Recorded by</th><td mat-cell *matCellDef="let e" class="small">{{ e.actorEmail || 'system' }} · {{ e.recordedAt | dt }}</td></ng-container>
                  <tr mat-header-row *matHeaderRowDef="eventColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: eventColumns"></tr>
                </table>
              </div>
            }
          </mat-card-content>
        </mat-card>
        <mat-card>
          <mat-card-header><mat-card-title>Survey participation</mat-card-title></mat-card-header>
          <mat-card-content>
            @if (c.participations.length === 0) {
              <rye-state [empty]="true" emptyText="This contact has not been invited to any survey." />
            } @else {
              <div class="table-wrap">
                <table mat-table [dataSource]="c.participations">
                  <ng-container matColumnDef="survey"><th mat-header-cell *matHeaderCellDef>Survey</th><td mat-cell *matCellDef="let p"><a [routerLink]="['/surveys', p.surveyId]">{{ p.surveyTitle }}</a> @if (p.runKind === 'TEST') { <span class="chip">test</span> }</td></ng-container>
                  <ng-container matColumnDef="state"><th mat-header-cell *matHeaderCellDef>Participation</th><td mat-cell *matCellDef="let p"><rye-chip [code]="p.state" /></td></ng-container>
                  <ng-container matColumnDef="invitation"><th mat-header-cell *matHeaderCellDef>Invitation</th><td mat-cell *matCellDef="let p"><rye-chip [code]="p.invitationState" /></td></ng-container>
                  <ng-container matColumnDef="answers"><th mat-header-cell *matHeaderCellDef>Answered</th><td mat-cell *matCellDef="let p">{{ p.answeredCount }} / {{ p.questionCount }}</td></ng-container>
                  <ng-container matColumnDef="started"><th mat-header-cell *matHeaderCellDef>Started</th><td mat-cell *matCellDef="let p">{{ p.startedAt | dt }}</td></ng-container>
                  <tr mat-header-row *matHeaderRowDef="participationColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: participationColumns"></tr>
                </table>
              </div>
              <p class="small muted">Individual answers are visible to Admins on the survey's Responses tab.</p>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: ['.dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; } .dl dt { color: var(--mat-sys-on-surface-variant); } .dl dd { margin: 0; }'],
})
export class ContactDetailComponent {
  readonly id = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmService);
  readonly contact = signal<ContactDetailDto | null>(null);
  readonly events = signal<ConsentEventDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly eventColumns = ['when', 'scope', 'type', 'source', 'reference', 'actor'];
  readonly participationColumns = ['survey', 'state', 'invitation', 'answers', 'started'];

  constructor() {
    queueMicrotask(() => void this.load());
  }

  joinNames(items: { name: string }[]): string {
    return items.map((item) => item.name).join(', ');
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [contact, events] = await Promise.all([this.api.get<ContactDetailDto>(`/contacts/${this.id()}`), this.api.get<ConsentEventDto[]>(`/contacts/${this.id()}/consent-events`)]);
      this.contact.set(contact);
      this.events.set(events);
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async recordConsent(): Promise<void> {
    const contact = this.contact();
    if (!contact) return;
    const ref = this.dialog.open(ConsentDialogComponent, { data: { contact }, width: '520px' });
    const result = (await firstValueFrom(ref.afterClosed())) as ConsentEventCreate | null | undefined;
    if (!result) return;
    try {
      await this.api.post(`/contacts/${contact.id}/consent-events`, result);
      this.notify.success('Consent recorded');
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async archive(): Promise<void> {
    const contact = this.contact();
    if (!contact) return;
    const ok = await this.confirm.ask({ title: 'Archive contact', message: `${contact.name} will be excluded from new audiences and pending sends will be canceled. Research history is kept.`, confirmLabel: 'Archive' });
    if (!ok) return;
    try {
      await this.api.post(`/contacts/${contact.id}/archive`);
      this.notify.success('Contact archived');
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async unarchive(): Promise<void> {
    const contact = this.contact();
    if (!contact) return;
    try {
      await this.api.post(`/contacts/${contact.id}/unarchive`);
      this.notify.success('Contact restored');
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }
}
