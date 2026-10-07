import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { StaffInvitationInspectDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { label } from '../../core/format';

@Component({
  selector: 'rye-accept-invitation',
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, RouterLink],
  template: `
    <div class="auth-page">
      <mat-card class="auth-card">
        <mat-card-header><mat-card-title>Join an organization</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (error()) {
            <p class="banner bad" role="alert">{{ error() }}</p>
          } @else if (!invitation()) {
            <p>Checking the invitation…</p>
          } @else if (done()) {
            <p class="banner ok">You are now a member of {{ invitation()?.organizationName }}. Sign in with {{ invitation()?.email }} to continue.</p>
          } @else {
            <p>You were invited to <strong>{{ invitation()?.organizationName }}</strong> as <strong>{{ roleLabel() }}</strong> using <strong>{{ invitation()?.email }}</strong>. The invitation expires {{ invitation()?.expiresAt }}.</p>
            @if (invitation()?.existingAccount) {
              <p class="muted small">An account already exists for this email. Sign in with it first, then return to this link; the invitation is bound to that identity.</p>
              @if (auth.user()?.email?.toLowerCase() === invitation()?.email?.toLowerCase()) {
                <button mat-flat-button type="button" [disabled]="busy()" (click)="accept()">Accept invitation</button>
              } @else {
                <a mat-flat-button [routerLink]="['/login']" [queryParams]="{ returnUrl: currentUrl }">Sign in</a>
              }
            } @else {
              <form (ngSubmit)="accept()" class="stack">
                <mat-form-field>
                  <mat-label>Your name</mat-label>
                  <input matInput name="displayName" [(ngModel)]="displayName" autocomplete="name" />
                </mat-form-field>
                <mat-form-field>
                  <mat-label>Choose a password (8+ characters)</mat-label>
                  <input matInput type="password" name="password" [(ngModel)]="password" minlength="8" required autocomplete="new-password" />
                </mat-form-field>
                <button mat-flat-button type="submit" [disabled]="busy() || password.length < 8">Create account and join</button>
              </form>
            }
          }
        </mat-card-content>
        <mat-card-actions><a mat-button routerLink="/login">Sign in</a></mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: ['.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 16px; } .auth-card { width: 100%; max-width: 460px; }'],
})
export class AcceptInvitationComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  readonly currentUrl = this.router.url;
  readonly invitation = signal<StaffInvitationInspectDto | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly done = signal(false);
  displayName = '';
  password = '';

  constructor() {
    void this.inspect();
  }

  roleLabel(): string {
    return label(this.invitation()?.role);
  }

  private async inspect(): Promise<void> {
    if (!this.token) {
      this.error.set('This invitation link is missing its token.');
      return;
    }
    try {
      this.invitation.set(await this.api.post<StaffInvitationInspectDto>('/staff-invitations/inspect', { token: this.token }));
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    }
  }

  async accept(): Promise<void> {
    this.busy.set(true);
    try {
      const body: Record<string, string> = { token: this.token };
      if (!this.invitation()?.existingAccount) {
        body['password'] = this.password;
        if (this.displayName.trim()) body['displayName'] = this.displayName.trim();
      }
      await this.api.post('/staff-invitations/accept', body);
      this.done.set(true);
      if (this.auth.user()) await this.auth.loadMe();
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
