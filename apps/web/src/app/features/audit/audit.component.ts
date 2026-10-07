import { JsonPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import type { AuditEventDto, Page } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-audit',
  imports: [...SHARED, JsonPipe, FormsModule, MatFormFieldModule, MatInputModule, MatTableModule, MatPaginatorModule],
  template: `
    <div class="page">
      <div class="page-header"><h1>Audit log</h1></div>
      <p class="muted">Sensitive actions (identifiable access, exports, consent changes, retries, configuration) are recorded without personal data or selected answers.</p>
      <div class="toolbar-row">
        <mat-form-field><mat-label>Action (e.g. responses.viewed)</mat-label><input matInput [(ngModel)]="action" (keyup.enter)="apply()" /></mat-form-field>
        <mat-form-field><mat-label>Resource type</mat-label><input matInput [(ngModel)]="resourceType" (keyup.enter)="apply()" /></mat-form-field>
        <mat-form-field><mat-label>Resource id</mat-label><input matInput [(ngModel)]="resourceId" (keyup.enter)="apply()" /></mat-form-field>
        <button mat-stroked-button type="button" (click)="apply()">Apply</button>
      </div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" [empty]="!loading() && !error() && page()?.items?.length === 0" emptyText="No audit events match." />
      @if (page(); as p) {
        @if (p.items.length) {
          <div class="table-wrap">
            <table mat-table [dataSource]="p.items">
              <ng-container matColumnDef="when"><th mat-header-cell *matHeaderCellDef>When</th><td mat-cell *matCellDef="let e">{{ e.createdAt | dt }}</td></ng-container>
              <ng-container matColumnDef="actor"><th mat-header-cell *matHeaderCellDef>Actor</th><td mat-cell *matCellDef="let e">{{ e.actorEmail || e.actorType.toLowerCase() }}</td></ng-container>
              <ng-container matColumnDef="action"><th mat-header-cell *matHeaderCellDef>Action</th><td mat-cell *matCellDef="let e" class="mono">{{ e.action }}</td></ng-container>
              <ng-container matColumnDef="resource"><th mat-header-cell *matHeaderCellDef>Resource</th><td mat-cell *matCellDef="let e" class="small">{{ e.resourceType }} {{ e.resourceId || '' }}</td></ng-container>
              <ng-container matColumnDef="metadata"><th mat-header-cell *matHeaderCellDef>Details</th><td mat-cell *matCellDef="let e" class="small mono">{{ e.metadata ? (e.metadata | json) : '' }}</td></ng-container>
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
export class AuditComponent {
  private readonly api = inject(ApiService);
  readonly columns = ['when', 'actor', 'action', 'resource', 'metadata'];
  readonly page = signal<Page<AuditEventDto> | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  action = '';
  resourceType = '';
  resourceId = '';
  limit = 25;
  offset = 0;

  constructor() {
    void this.load();
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.page.set(await this.api.get<Page<AuditEventDto>>('/audit', { action: this.action, resourceType: this.resourceType, resourceId: this.resourceId, limit: this.limit, offset: this.offset }));
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
