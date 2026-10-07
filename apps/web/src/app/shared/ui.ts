import { Component, Injectable, Pipe, PipeTransform, computed, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { LocalizedText } from '@raaye/contracts';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { formatDate, formatDateTime, label, percent, text } from '../core/format';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const TONES: Record<string, Tone> = {
  ACTIVE: 'ok',
  GRANTED: 'ok',
  DELIVERED: 'ok',
  READ: 'ok',
  COMPLETED: 'ok',
  ACCEPTED: 'info',
  SENT: 'info',
  SCHEDULED: 'info',
  STARTED: 'info',
  INVITED: 'info',
  VIEWED: 'ok',
  QUEUED: 'neutral',
  PENDING: 'neutral',
  DRAFT: 'neutral',
  CLOSED: 'neutral',
  NOT_STARTED: 'neutral',
  UNKNOWN: 'warn',
  SUPPRESSED: 'warn',
  WITHDRAWN: 'bad',
  FAILED: 'bad',
  CANCELED: 'neutral',
  EXPIRED: 'warn',
  APPROVED: 'ok',
  PUBLISHED: 'ok',
  REJECTED: 'bad',
  PAUSED: 'warn',
  MISSING: 'bad',
  ERROR: 'bad',
  CREATE: 'ok',
  UPDATE: 'info',
  SKIP: 'neutral',
};

@Component({
  selector: 'rye-chip',
  template: '<span class="chip" [class]="classes()">{{ display() }}</span>',
})
export class ChipComponent {
  readonly code = input<string | null | undefined>(null);
  readonly tone = input<Tone | null>(null);
  readonly text = input<string | null>(null);
  readonly display = computed(() => this.text() ?? label(this.code()));
  readonly classes = computed(() => `chip ${this.tone() ?? TONES[this.code() ?? ''] ?? 'neutral'}`);
}

@Component({
  selector: 'rye-state',
  imports: [MatProgressBarModule, MatButtonModule],
  template: `
    @if (loading()) {
      <div class="state-panel" role="status" aria-live="polite">
        <mat-progress-bar mode="indeterminate" />
        <p>{{ loadingText() }}</p>
      </div>
    } @else if (error()) {
      <div class="state-panel" role="alert">
        <p class="danger">{{ error() }}</p>
        @if (retry()) {
          <button mat-stroked-button type="button" (click)="retry()?.()">Try again</button>
        }
      </div>
    } @else if (empty()) {
      <div class="state-panel">
        <p>{{ emptyText() }}</p>
        <ng-content />
      </div>
    }
  `,
})
export class StateComponent {
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly empty = input(false);
  readonly loadingText = input('Loading…');
  readonly emptyText = input('Nothing here yet.');
  readonly retry = input<(() => void) | null>(null);
}

export interface ConfirmData {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this text to enable confirmation. */
  typeToConfirm?: string;
}

@Component({
  selector: 'rye-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p style="white-space: pre-wrap">{{ data.message }}</p>
      @if (data.typeToConfirm) {
        <p>
          <label>Type <strong>{{ data.typeToConfirm }}</strong> to confirm<br />
            <input class="confirm-input" #typed (input)="typedValue = typed.value" autocomplete="off" />
          </label>
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close(false)">Cancel</button>
      <button mat-flat-button type="button" [disabled]="data.typeToConfirm !== undefined && typedValue !== data.typeToConfirm" (click)="ref.close(true)">{{ data.confirmLabel ?? 'Confirm' }}</button>
    </mat-dialog-actions>
  `,
  styles: ['.confirm-input { font: inherit; padding: 6px 8px; width: 100%; box-sizing: border-box; margin-top: 4px; }'],
})
export class ConfirmDialogComponent {
  readonly ref = inject<MatDialogRef<ConfirmDialogComponent, boolean>>(MatDialogRef);
  readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  typedValue = '';
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(MatDialog);

  async ask(data: ConfirmData): Promise<boolean> {
    const ref = this.dialog.open(ConfirmDialogComponent, { data, width: '480px' });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }
}

@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return label(value);
  }
}

@Pipe({ name: 'ltext' })
export class LocalizedTextPipe implements PipeTransform {
  transform(value: LocalizedText | null | undefined): string {
    return text(value);
  }
}

@Pipe({ name: 'dt' })
export class DateTimePipe implements PipeTransform {
  private readonly auth = inject(AuthService);
  transform(value: string | null | undefined, mode: 'datetime' | 'date' = 'datetime'): string {
    return mode === 'date' ? formatDate(value, this.auth.timezone()) : formatDateTime(value, this.auth.timezone());
  }
}

@Pipe({ name: 'pct' })
export class PercentPipe implements PipeTransform {
  transform(value: number | null | undefined, digits = 1): string {
    return percent(value, digits);
  }
}

export const SHARED = [ChipComponent, StateComponent, LabelPipe, LocalizedTextPipe, DateTimePipe, PercentPipe, MatIconModule, MatButtonModule] as const;
