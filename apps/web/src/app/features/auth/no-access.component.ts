import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'rye-no-access',
  imports: [MatCardModule, MatButtonModule],
  template: `
    <div class="auth-page">
      <mat-card class="auth-card">
        <mat-card-header><mat-card-title>No organization access</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (auth.user()) {
            <p>{{ auth.user()?.email }} is signed in but has no active membership in any organization. Ask an administrator for an invitation, or accept a pending one.</p>
            @if (auth.membershipError(); as err) {
              <p class="muted small">{{ err.message }}</p>
            }
          } @else {
            <p>You are not signed in.</p>
          }
        </mat-card-content>
        <mat-card-actions>
          <button mat-button type="button" (click)="retry()">Check again</button>
          <button mat-flat-button type="button" (click)="signOut()">Sign out</button>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: ['.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 16px; } .auth-card { width: 100%; max-width: 460px; }'],
})
export class NoAccessComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async retry(): Promise<void> {
    if (await this.auth.loadMe()) await this.router.navigate(['/overview']);
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
