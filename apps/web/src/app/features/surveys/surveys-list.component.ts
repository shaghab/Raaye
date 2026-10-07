import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { SURVEY_STATES, type Page, type SurveyListItemDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-surveys-list',
  imports: [...SHARED, FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatTableModule, MatPaginatorModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Surveys</h1>
        <div class="actions">
          @if (auth.hasRole('ADMIN', 'SURVEY_MANAGER')) {
            <a mat-flat-button routerLink="/surveys/new" data-testid="new-survey"><mat-icon svgIcon="add" /> New survey</a>
          }
        </div>
      </div>
      <div class="toolbar-row">
        <mat-form-field><mat-label>Search</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="apply()" /></mat-form-field>
        <mat-form-field>
          <mat-label>State</mat-label>
          <mat-select [(ngModel)]="state" (selectionChange)="apply()">
            <mat-option [value]="null">Any</mat-option>
            @for (s of states; track s) { <mat-option [value]="s">{{ s | label }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-checkbox [(ngModel)]="archived" (change)="apply()">Archived</mat-checkbox>
        <button mat-stroked-button type="button" (click)="apply()">Apply</button>
      </div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" [empty]="!loading() && !error() && page()?.items?.length === 0" emptyText="No surveys match these filters." />
      @if (page(); as p) {
        @if (p.items.length) {
          <div class="table-wrap">
            <table mat-table [dataSource]="p.items" data-testid="surveys-table">
              <ng-container matColumnDef="title"><th mat-header-cell *matHeaderCellDef>Survey</th><td mat-cell *matCellDef="let s"><a [routerLink]="['/surveys', s.id]">{{ s.internalTitle }}</a><div class="small muted">{{ s.title | ltext }}</div></td></ng-container>
              <ng-container matColumnDef="state"><th mat-header-cell *matHeaderCellDef>State</th><td mat-cell *matCellDef="let s"><rye-chip [code]="s.state" /> @if (s.archivedAt) { <rye-chip text="Archived" tone="warn" /> }</td></ng-container>
              <ng-container matColumnDef="questions"><th mat-header-cell *matHeaderCellDef>Questions</th><td mat-cell *matCellDef="let s">{{ s.questionCount }}</td></ng-container>
              <ng-container matColumnDef="opens"><th mat-header-cell *matHeaderCellDef>Opens</th><td mat-cell *matCellDef="let s">{{ s.opensAt | dt }}</td></ng-container>
              <ng-container matColumnDef="closes"><th mat-header-cell *matHeaderCellDef>Closes</th><td mat-cell *matCellDef="let s">{{ s.closesAt | dt }}</td></ng-container>
              <ng-container matColumnDef="responded"><th mat-header-cell *matHeaderCellDef>Responded</th><td mat-cell *matCellDef="let s">{{ s.respondedCount }}</td></ng-container>
              <ng-container matColumnDef="updated"><th mat-header-cell *matHeaderCellDef>Updated</th><td mat-cell *matCellDef="let s">{{ s.updatedAt | dt }}</td></ng-container>
              <tr mat-header-row *matHeaderRowDef="columns"></tr>
              <tr mat-row *matRowDef="let row; columns: columns"></tr>
            </table>
          </div>
          <mat-paginator [length]="p.total" [pageSize]="p.limit" [pageIndex]="p.offset / p.limit" [pageSizeOptions]="[25, 50, 100]" (page)="paginate($event)" />
        }
      }
    </div>
  `,
})
export class SurveysListComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  /** Viewers never see drafts, so the filter does not offer them. */
  get states(): readonly string[] {
    return this.auth.hasRole('VIEWER') ? SURVEY_STATES.filter((state) => state !== 'DRAFT') : SURVEY_STATES;
  }
  readonly columns = ['title', 'state', 'questions', 'opens', 'closes', 'responded', 'updated'];
  readonly page = signal<Page<SurveyListItemDto> | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  search = '';
  state: string | null = null;
  archived = false;
  limit = 25;
  offset = 0;

  constructor() {
    void this.load();
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.page.set(await this.api.get<Page<SurveyListItemDto>>('/surveys', { search: this.search, state: this.state, archived: this.archived, limit: this.limit, offset: this.offset }));
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
}
