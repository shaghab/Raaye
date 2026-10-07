import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'rye-login',
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatProgressBarModule, RouterLink],
  template: `
    <div class="auth-page">
      <mat-card class="auth-card">
        <mat-card-header>
          <mat-card-title>Sign in to Raaye</mat-card-title>
          <mat-card-subtitle>Staff access with email and password</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          @if (auth.config()?.authMode === 'emulator') {
            <p class="banner warn small">Local authentication emulator. Demo accounts are listed in the README; nothing here reaches a real Firebase project.</p>
          }
          @if (reason() === 'expired') {
            <p class="banner small">Your session ended. Sign in again.</p>
          }
          <form (ngSubmit)="submit()" class="stack">
            <mat-form-field>
              <mat-label>Email</mat-label>
              <input matInput type="email" name="email" [(ngModel)]="email" required autocomplete="username" data-testid="login-email" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Password</mat-label>
              <input matInput type="password" name="password" [(ngModel)]="password" required autocomplete="current-password" data-testid="login-password" />
            </mat-form-field>
            @if (error()) {
              <p class="danger" role="alert" data-testid="login-error">{{ error() }}</p>
            }
            @if (busy()) {
              <mat-progress-bar mode="indeterminate" />
            }
            <button mat-flat-button type="submit" [disabled]="busy()" data-testid="login-submit">Sign in</button>
          </form>
        </mat-card-content>
        <mat-card-actions>
          <a mat-button routerLink="/reset-password">Forgot password?</a>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: ['.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 16px; } .auth-card { width: 100%; max-width: 420px; }'],
})
export class LoginComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly reason = signal<string | null>(this.route.snapshot.queryParamMap.get('reason'));

  async submit(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.auth.signIn(this.email.trim(), this.password);
      if (!this.auth.me()) {
        await this.router.navigate(['/no-access']);
        return;
      }
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      await this.router.navigateByUrl(returnUrl && returnUrl.startsWith('/') ? returnUrl : '/overview');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
      this.error.set(code.includes('network') ? 'The authentication service is not reachable. Is the Firebase Auth emulator running?' : 'Email or password is incorrect.');
    } finally {
      this.busy.set(false);
    }
  }
}
