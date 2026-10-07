import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Role } from '@raaye/contracts';
import { map } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { label } from '../core/format';

interface NavItem {
  path: string;
  title: string;
  icon: string;
  roles?: Role[];
  simulator?: boolean;
}

const NAV: NavItem[] = [
  { path: '/overview', title: 'Overview', icon: 'dashboard' },
  { path: '/contacts', title: 'Contacts', icon: 'people', roles: ['ADMIN', 'SURVEY_MANAGER'] },
  { path: '/contacts/groups', title: 'Groups & tags', icon: 'label', roles: ['ADMIN', 'SURVEY_MANAGER'] },
  { path: '/contacts/import', title: 'Import contacts', icon: 'upload', roles: ['ADMIN', 'SURVEY_MANAGER'] },
  { path: '/surveys', title: 'Surveys', icon: 'poll' },
  { path: '/settings', title: 'Settings', icon: 'settings' },
  { path: '/audit', title: 'Audit log', icon: 'history', roles: ['ADMIN'] },
  { path: '/simulator', title: 'WhatsApp simulator', icon: 'chat', roles: ['ADMIN'], simulator: true },
];

@Component({
  selector: 'rye-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatToolbarModule, MatListModule, MatIconModule, MatButtonModule, MatMenuModule, MatTooltipModule],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav [mode]="handset() ? 'over' : 'side'" [opened]="!handset() || menuOpen()" (closedStart)="menuOpen.set(false)" class="nav">
        <div class="brand">
          <span class="brand-name">Raaye</span>
          <span class="org">{{ auth.me()?.organization?.name }}</span>
        </div>
        <mat-nav-list>
          @for (item of items(); track item.path) {
            <a mat-list-item [routerLink]="item.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: item.path === '/contacts' }" (click)="handset() && menuOpen.set(false)">
              <mat-icon matListItemIcon [svgIcon]="item.icon" />
              <span matListItemTitle>{{ item.title }}</span>
            </a>
          }
        </mat-nav-list>
        <div class="nav-footer small muted">
          Signed in as {{ auth.me()?.email }}<br />
          Role: {{ roleLabel() }}
        </div>
      </mat-sidenav>
      <mat-sidenav-content>
        <mat-toolbar class="topbar">
          @if (handset()) {
            <button mat-icon-button type="button" aria-label="Open navigation" (click)="menuOpen.set(true)"><mat-icon svgIcon="menu" /></button>
          }
          <span class="toolbar-title">{{ auth.me()?.organization?.name }}</span>
          <span class="spacer"></span>
          <span class="chip" [class.live]="auth.messagingMode() === 'live'" [class.mock]="auth.messagingMode() === 'mock'" data-testid="messaging-mode" [matTooltip]="modeTooltip()">
            {{ auth.messagingMode() === 'live' ? 'LIVE WHATSAPP' : 'MOCK MESSAGING' }}
          </span>
          @if (auth.simulatorEnabled()) {
            <span class="chip info" matTooltip="Development simulator routes are enabled">SIMULATOR ON</span>
          }
          <button mat-icon-button type="button" [matMenuTriggerFor]="userMenu" aria-label="Account menu"><mat-icon svgIcon="more" /></button>
          <mat-menu #userMenu="matMenu">
            <div class="menu-identity small muted">{{ auth.me()?.email }} · {{ roleLabel() }}</div>
            <button mat-menu-item type="button" (click)="signOut()"><mat-icon svgIcon="logout" /><span>Sign out</span></button>
          </mat-menu>
        </mat-toolbar>
        <main class="content">
          <router-outlet />
        </main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [
    `
      .shell { height: 100vh; }
      .nav { width: 248px; display: flex; flex-direction: column; }
      .brand { padding: 20px 16px 8px; display: flex; flex-direction: column; }
      .brand-name { font-weight: 700; font-size: 20px; letter-spacing: 0.02em; }
      .org { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
      .nav-footer { margin-top: auto; padding: 16px; }
      .topbar { gap: 8px; position: sticky; top: 0; z-index: 2; border-bottom: 1px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface-container-low); }
      .toolbar-title { font-size: 16px; font-weight: 600; }
      .content { min-height: calc(100vh - 64px); }
      .menu-identity { padding: 8px 16px; max-width: 280px; }
      a.active { background: var(--mat-sys-secondary-container); }
    `,
  ],
})
export class ShellComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly breakpoints = inject(BreakpointObserver);
  readonly menuOpen = signal(false);
  readonly handset = toSignal(this.breakpoints.observe('(max-width: 900px)').pipe(map((state) => state.matches)), { initialValue: false });
  readonly items = computed(() => NAV.filter((item) => (!item.roles || this.auth.hasRole(...item.roles)) && (!item.simulator || this.auth.simulatorEnabled())));
  readonly roleLabel = computed(() => label(this.auth.role()));
  readonly modeTooltip = computed(() =>
    this.auth.messagingMode() === 'live' ? 'Messages are sent to real WhatsApp numbers through the Meta Cloud API' : 'Mock provider: nothing leaves this environment; use the simulator to act as a participant',
  );

  async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
