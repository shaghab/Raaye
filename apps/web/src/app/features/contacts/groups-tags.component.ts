import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { GroupDto, TagDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-groups-tags',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatTableModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header"><h1>Groups and tags</h1></div>
      <p class="muted">Groups describe durable cohorts (for example members of a chapter); tags are lightweight labels. Both can be used to build survey audiences. Membership is managed on each contact.</p>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
      <div class="cards">
        <mat-card>
          <mat-card-header><mat-card-title>Groups</mat-card-title></mat-card-header>
          <mat-card-content>
            <form class="row" (ngSubmit)="createGroup()">
              <mat-form-field><mat-label>New group</mat-label><input matInput name="groupName" [(ngModel)]="groupName" maxlength="80" required /></mat-form-field>
              <mat-form-field><mat-label>Description</mat-label><input matInput name="groupDescription" [(ngModel)]="groupDescription" maxlength="300" /></mat-form-field>
              <button mat-flat-button type="submit" [disabled]="!groupName.trim()">Add</button>
            </form>
            <div class="table-wrap">
              <table mat-table [dataSource]="groups()">
                <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th><td mat-cell *matCellDef="let g"><input class="inline" [value]="g.name" (change)="renameGroup(g, $any($event.target).value)" aria-label="Group name" /></td></ng-container>
                <ng-container matColumnDef="description"><th mat-header-cell *matHeaderCellDef>Description</th><td mat-cell *matCellDef="let g" class="small">{{ g.description || '—' }}</td></ng-container>
                <ng-container matColumnDef="count"><th mat-header-cell *matHeaderCellDef>Contacts</th><td mat-cell *matCellDef="let g"><a [routerLink]="['/contacts']" [queryParams]="{ groupId: g.id }">{{ g.contactCount }}</a></td></ng-container>
                <tr mat-header-row *matHeaderRowDef="groupColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: groupColumns"></tr>
              </table>
            </div>
          </mat-card-content>
        </mat-card>
        <mat-card>
          <mat-card-header><mat-card-title>Tags</mat-card-title></mat-card-header>
          <mat-card-content>
            <form class="row" (ngSubmit)="createTag()">
              <mat-form-field><mat-label>New tag</mat-label><input matInput name="tagName" [(ngModel)]="tagName" maxlength="80" required /></mat-form-field>
              <button mat-flat-button type="submit" [disabled]="!tagName.trim()">Add</button>
            </form>
            <div class="table-wrap">
              <table mat-table [dataSource]="tags()">
                <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th><td mat-cell *matCellDef="let t"><input class="inline" [value]="t.name" (change)="renameTag(t, $any($event.target).value)" aria-label="Tag name" /></td></ng-container>
                <ng-container matColumnDef="count"><th mat-header-cell *matHeaderCellDef>Contacts</th><td mat-cell *matCellDef="let t">{{ t.contactCount }}</td></ng-container>
                <tr mat-header-row *matHeaderRowDef="tagColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: tagColumns"></tr>
              </table>
            </div>
          </mat-card-content>
        </mat-card>
      </div>
    </div>
  `,
  styles: ['.inline { font: inherit; border: 1px solid transparent; background: transparent; padding: 4px; width: 100%; } .inline:focus { border-color: var(--mat-sys-primary); background: white; }'],
})
export class GroupsTagsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly groups = signal<GroupDto[]>([]);
  readonly tags = signal<TagDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly groupColumns = ['name', 'description', 'count'];
  readonly tagColumns = ['name', 'count'];
  groupName = '';
  groupDescription = '';
  tagName = '';

  constructor() {
    void this.load();
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [groups, tags] = await Promise.all([this.api.get<GroupDto[]>('/groups'), this.api.get<TagDto[]>('/tags')]);
      this.groups.set(groups);
      this.tags.set(tags);
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  async createGroup(): Promise<void> {
    try {
      await this.api.post('/groups', { name: this.groupName.trim(), description: this.groupDescription.trim() || undefined });
      this.groupName = '';
      this.groupDescription = '';
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async renameGroup(group: GroupDto, name: string): Promise<void> {
    if (!name.trim() || name.trim() === group.name) return;
    try {
      await this.api.patch(`/groups/${group.id}`, { name: name.trim() });
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async createTag(): Promise<void> {
    try {
      await this.api.post('/tags', { name: this.tagName.trim() });
      this.tagName = '';
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async renameTag(tag: TagDto, name: string): Promise<void> {
    if (!name.trim() || name.trim() === tag.name) return;
    try {
      await this.api.patch(`/tags/${tag.id}`, { name: name.trim() });
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }
}
