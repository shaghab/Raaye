import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CONSENT_STATUSES, type ContactSummaryDto, type GroupDto, type Page, type TagDto } from '@raaye/contracts';
import { ApiError, ApiService, type Query } from '../../core/api.service';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-contacts-list',
  imports: [...SHARED, FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatTableModule, MatPaginatorModule, MatMenuModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Contacts</h1>
        <div class="actions">
          <button mat-stroked-button type="button" [matMenuTriggerFor]="exportMenu"><mat-icon svgIcon="download" /> Export</button>
          <mat-menu #exportMenu="matMenu">
            <button mat-menu-item type="button" (click)="export('csv')">CSV (current filters)</button>
            <button mat-menu-item type="button" (click)="export('xlsx')">XLSX (current filters)</button>
          </mat-menu>
          <a mat-stroked-button routerLink="/contacts/import"><mat-icon svgIcon="upload" /> Import</a>
          <a mat-flat-button routerLink="/contacts/new" data-testid="add-contact"><mat-icon svgIcon="add" /> Add contact</a>
        </div>
      </div>
      <div class="toolbar-row">
        <mat-form-field>
          <mat-label>Search name or phone</mat-label>
          <input matInput [(ngModel)]="search" (keyup.enter)="apply()" data-testid="contact-search" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Invitation consent</mat-label>
          <mat-select [(ngModel)]="consentStatus" (selectionChange)="apply()" multiple>
            @for (status of consentStatuses; track status) {
              <mat-option [value]="status">{{ status | label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Group</mat-label>
          <mat-select [(ngModel)]="groupId" (selectionChange)="apply()">
            <mat-option [value]="null">Any</mat-option>
            @for (group of groups(); track group.id) {
              <mat-option [value]="group.id">{{ group.name }} ({{ group.contactCount }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Tag</mat-label>
          <mat-select [(ngModel)]="tagId" (selectionChange)="apply()">
            <mat-option [value]="null">Any</mat-option>
            @for (tag of tags(); track tag.id) {
              <mat-option [value]="tag.id">{{ tag.name }} ({{ tag.contactCount }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-checkbox [(ngModel)]="archived" (change)="apply()">Archived</mat-checkbox>
        <button mat-stroked-button type="button" (click)="apply()">Apply</button>
      </div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" [empty]="!loading() && !error() && page()?.items?.length === 0" emptyText="No contacts match these filters." />
      @if (page(); as p) {
        @if (p.items.length) {
          <div class="table-wrap">
            <table mat-table [dataSource]="p.items" data-testid="contacts-table">
              <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th><td mat-cell *matCellDef="let c"><a [routerLink]="['/contacts', c.id]">{{ c.name }}</a> @if (c.isSynthetic) { <span class="chip small">synthetic</span> }</td></ng-container>
              <ng-container matColumnDef="phone"><th mat-header-cell *matHeaderCellDef>Phone</th><td mat-cell *matCellDef="let c" class="mono">{{ c.phoneE164 }}</td></ng-container>
              <ng-container matColumnDef="location"><th mat-header-cell *matHeaderCellDef>City / district</th><td mat-cell *matCellDef="let c">{{ c.city || '—' }}@if (c.district) { / {{ c.district }} }</td></ng-container>
              <ng-container matColumnDef="invitations"><th mat-header-cell *matHeaderCellDef>Invitations</th><td mat-cell *matCellDef="let c"><rye-chip [code]="c.consent.invitations" /></td></ng-container>
              <ng-container matColumnDef="results"><th mat-header-cell *matHeaderCellDef>Results</th><td mat-cell *matCellDef="let c"><rye-chip [code]="c.consent.results" /></td></ng-container>
              <ng-container matColumnDef="groups"><th mat-header-cell *matHeaderCellDef>Groups / tags</th><td mat-cell *matCellDef="let c" class="small">{{ names(c) }}</td></ng-container>
              <ng-container matColumnDef="membership"><th mat-header-cell *matHeaderCellDef>Membership</th><td mat-cell *matCellDef="let c">{{ c.membership | label }}</td></ng-container>
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
export class ContactsListComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly route = inject(ActivatedRoute);
  readonly consentStatuses = CONSENT_STATUSES;
  readonly columns = ['name', 'phone', 'location', 'invitations', 'results', 'groups', 'membership'];
  readonly page = signal<Page<ContactSummaryDto> | null>(null);
  readonly groups = signal<GroupDto[]>([]);
  readonly tags = signal<TagDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  search = '';
  consentStatus: string[] = [];
  groupId: string | null = null;
  tagId: string | null = null;
  archived = false;
  limit = 25;
  offset = 0;

  constructor() {
    // Filters given in the URL (`/contacts?search=...&consent=...&group=...&tag=...&archived=true`) seed
    // the controls, so a link can open a filtered view instead of the first unfiltered page.
    const params = this.route.snapshot.queryParamMap;
    this.search = params.get('search') ?? '';
    this.consentStatus = params.getAll('consent').filter((status) => (CONSENT_STATUSES as readonly string[]).includes(status));
    this.groupId = params.get('group');
    this.tagId = params.get('tag');
    this.archived = params.get('archived') === 'true';
    void this.load();
    void this.loadGroupsTags();
  }

  names(contact: ContactSummaryDto): string {
    return [...contact.groups.map((group) => group.name), ...contact.tags.map((tag) => `#${tag.name}`)].join(', ') || '—';
  }

  private query(): Query {
    return { search: this.search, consentStatus: this.consentStatus, groupId: this.groupId, tagId: this.tagId, archived: this.archived, limit: this.limit, offset: this.offset };
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.page.set(await this.api.get<Page<ContactSummaryDto>>('/contacts', this.query()));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async loadGroupsTags(): Promise<void> {
    try {
      const [groups, tags] = await Promise.all([this.api.get<GroupDto[]>('/groups'), this.api.get<TagDto[]>('/tags')]);
      this.groups.set(groups);
      this.tags.set(tags);
    } catch (error) {
      this.notify.error(error);
    }
  }

  apply(): void {
    this.offset = 0;
    void this.load();
  }

  paginate(event: PageEvent): void {
    this.limit = event.pageSize;
    this.offset = event.pageIndex * event.pageSize;
    void this.load();
  }

  async export(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      const name = await this.api.download('/contacts/export', { ...this.query(), format, limit: undefined, offset: undefined });
      this.notify.success(`Downloaded ${name}`);
    } catch (error) {
      this.notify.error(error);
    }
  }
}
