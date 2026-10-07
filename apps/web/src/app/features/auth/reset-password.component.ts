import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'rye-reset-password',
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, RouterLink],
  template: `
    <div class="auth-page">
      <mat-card class="auth-card">
        <mat-card-header><mat-card-title>Reset your password</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (sent()) {
            <p class="banner ok">If an account exists for that email, a reset link has been sent.
              @if (auth.config()?.authMode === 'emulator') {
                <span> With the local emulator the link appears in the simulator's <em>Emulator outbox</em> panel or the emulator log.</span>
              }
            </p>
          } @else {
            <form (ngSubmit)="submit()" class="stack">
              <mat-form-field>
                <mat-label>Email</mat-label>
                <input matInput type="email" name="email" [(ngModel)]="email" required autocomplete="username" />
              </mat-form-field>
              @if (error()) {
                <p class="danger" role="alert">{{ error() }}</p>
              }
              <button mat-flat-button type="submit" [disabled]="busy()">Send reset link</button>
            </form>
          }
        </mat-card-content>
        <mat-card-actions><a mat-button routerLink="/login">Back to sign in</a></mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: ['.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 16px; } .auth-card { width: 100%; max-width: 420px; }'],
})
export class ResetPasswordComponent {
  readonly auth = inject(AuthService);
  email = '';
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.resetPassword(this.email.trim());
      this.sent.set(true);
    } catch {
      // Do not reveal whether the account exists.
      this.sent.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}
