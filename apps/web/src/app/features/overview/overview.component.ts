import { Component, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { OverviewDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-overview',
  imports: [...SHARED, MatCardModule, MatTableModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Overview</h1>
        <div class="actions">
          <button mat-stroked-button type="button" (click)="load()"><mat-icon svgIcon="refresh" /> Refresh</button>
          @if (auth.hasRole('ADMIN', 'SURVEY_MANAGER')) {
            <a mat-flat-button routerLink="/surveys/new"><mat-icon svgIcon="add" /> New survey</a>
          }
        </div>
      </div>
      @if (auth.messagingMode() === 'mock') {
        <div class="banner warn" data-testid="mock-banner"><strong>Mock messaging.</strong> No WhatsApp messages leave this environment. Act as a participant in the simulator.</div>
      }
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
      @if (data(); as d) {
        <div class="cards">
          <mat-card class="metric"><div class="value">{{ d.contacts.total }}</div><div class="label">Contacts</div><div class="small muted">{{ d.contacts.eligibleForInvitations }} eligible for invitations · {{ d.contacts.withdrawn }} withdrawn · {{ d.contacts.unknown }} unknown</div></mat-card>
          <mat-card class="metric"><div class="value">{{ d.surveys.active }}</div><div class="label">Active surveys</div><div class="small muted">{{ d.surveys.scheduled }} scheduled · {{ d.surveys.draft }} draft · {{ d.surveys.closed }} closed · {{ d.surveys.archived }} archived</div></mat-card>
          <mat-card class="metric" [class.attention]="d.attention.failedMessages + d.attention.unknownOutcomes + d.attention.deadJobs > 0">
            <div class="value">{{ d.attention.failedMessages + d.attention.unknownOutcomes }}</div>
            <div class="label">Messages needing attention</div>
            <div class="small muted">{{ d.attention.failedMessages }} failed · {{ d.attention.unknownOutcomes }} unknown outcome · {{ d.attention.deadJobs }} dead jobs</div>
          </mat-card>
        </div>
        @if (d.attention.blockedRuns.length) {
          <div class="banner bad">
            <strong>Blocked dispatch</strong>
            <ul>
              @for (run of d.attention.blockedRuns; track run.surveyId) {
                <li><a [routerLink]="['/surveys', run.surveyId]">{{ run.internalTitle }}</a>: {{ run.reason }}</li>
              }
            </ul>
          </div>
        }
        <mat-card>
          <mat-card-header><mat-card-title>Recent surveys</mat-card-title></mat-card-header>
          <mat-card-content>
            @if (d.recent.length === 0) {
              <rye-state [empty]="true" emptyText="No surveys yet." />
            } @else {
              <div class="table-wrap">
                <table mat-table [dataSource]="d.recent">
                  <ng-container matColumnDef="title"><th mat-header-cell *matHeaderCellDef>Survey</th><td mat-cell *matCellDef="let s"><a [routerLink]="['/surveys', s.id]">{{ s.internalTitle }}</a></td></ng-container>
                  <ng-container matColumnDef="state"><th mat-header-cell *matHeaderCellDef>State</th><td mat-cell *matCellDef="let s"><rye-chip [code]="s.state" /></td></ng-container>
                  <ng-container matColumnDef="opens"><th mat-header-cell *matHeaderCellDef>Opens</th><td mat-cell *matCellDef="let s">{{ s.opensAt | dt }}</td></ng-container>
                  <ng-container matColumnDef="closes"><th mat-header-cell *matHeaderCellDef>Closes</th><td mat-cell *matCellDef="let s">{{ s.closesAt | dt }}</td></ng-container>
                  <ng-container matColumnDef="responded"><th mat-header-cell *matHeaderCellDef>Responded</th><td mat-cell *matCellDef="let s">{{ s.responded }}</td></ng-container>
                  <ng-container matColumnDef="completed"><th mat-header-cell *matHeaderCellDef>Completed</th><td mat-cell *matCellDef="let s">{{ s.completed }}</td></ng-container>
                  <tr mat-header-row *matHeaderRowDef="columns"></tr>
                  <tr mat-row *matRowDef="let row; columns: columns"></tr>
                </table>
              </div>
            }
          </mat-card-content>
        </mat-card>
        <p class="small muted">Refreshed {{ d.refreshedAt | dt }}</p>
      }
    </div>
  `,
  styles: ['.attention { border: 2px solid #e39a94; }'],
})
export class OverviewComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  readonly data = signal<OverviewDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly columns = ['title', 'state', 'opens', 'closes', 'responded', 'completed'];
  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.api.get<OverviewDto>('/overview'));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  constructor() {
    void this.load();
  }
}
