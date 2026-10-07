import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiError } from './api.service';

@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 4000 });
  }

  info(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 6000 });
  }

  /** Shows the API's actionable message (never a stack trace) with the correlation id for support. */
  error(error: unknown, fallback = 'Something went wrong'): ApiError {
    const apiError = ApiError.from(error);
    const detail = apiError.fieldErrors.length ? ` ${apiError.fieldErrors.map((field) => `${field.path}: ${field.message}`).join('; ')}` : '';
    const reference = apiError.correlationId ? ` (ref ${apiError.correlationId.slice(0, 8)})` : '';
    this.snackBar.open(`${apiError.message || fallback}${detail}${reference}`, 'Dismiss', { duration: 9000 });
    return apiError;
  }
}
