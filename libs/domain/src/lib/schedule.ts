import { LIMITS } from '@raaye/contracts';
import { addSeconds } from './clock';

export interface TimingInput {
  opensAt: Date;
  durationSeconds: number;
  explicitClosesAt: Date | null;
}

/** closes_at = opens_at + duration unless an explicit closing instant was configured. */
export function computeClosesAt(input: TimingInput): Date {
  return input.explicitClosesAt ?? addSeconds(input.opensAt, input.durationSeconds);
}

export interface TimingError {
  code: 'DURATION_OUT_OF_RANGE' | 'EDIT_WINDOW_OUT_OF_RANGE' | 'EXPLICIT_CLOSE_OUT_OF_RANGE' | 'OPENS_IN_PAST';
  message: string;
}

export function validateTiming(params: {
  now: Date;
  opensAt: Date;
  durationSeconds: number;
  editWindowSeconds: number;
  explicitClosesAt: Date | null;
  scheduled: boolean;
}): TimingError[] {
  const errors: TimingError[] = [];
  const { durationSeconds, editWindowSeconds, explicitClosesAt, opensAt, now, scheduled } = params;
  if (durationSeconds < LIMITS.durationSeconds.min || durationSeconds > LIMITS.durationSeconds.max) {
    errors.push({
      code: 'DURATION_OUT_OF_RANGE',
      message: `Duration must be between 1 hour and 30 days (got ${durationSeconds} seconds)`,
    });
  }
  if (editWindowSeconds < LIMITS.editWindowSeconds.min || editWindowSeconds > LIMITS.editWindowSeconds.max) {
    errors.push({
      code: 'EDIT_WINDOW_OUT_OF_RANGE',
      message: 'Answer edit window must be between 0 and 3,600 seconds',
    });
  }
  if (explicitClosesAt) {
    const delta = (explicitClosesAt.getTime() - opensAt.getTime()) / 1000;
    if (delta < LIMITS.durationSeconds.min || delta > LIMITS.durationSeconds.max) {
      errors.push({
        code: 'EXPLICIT_CLOSE_OUT_OF_RANGE',
        message: 'The closing time must be between 1 hour and 30 days after the opening time',
      });
    }
  }
  // Allow a small clock skew for scheduled openings.
  if (scheduled && opensAt.getTime() < now.getTime() - 60_000) {
    errors.push({ code: 'OPENS_IN_PAST', message: 'The scheduled opening time is in the past' });
  }
  return errors;
}
