export type Command =
  | { kind: 'STOP' }
  | { kind: 'HELP' }
  | { kind: 'START' }
  | { kind: 'RESUME' }
  | { kind: 'PROFILE' }
  | { kind: 'EDIT'; questionNumber: number | null }
  | { kind: 'RESULTS' };

/**
 * Deterministic command parsing: case-insensitive, surrounding whitespace ignored,
 * internal whitespace collapsed. Anything else is not a command.
 */
export function parseCommand(text: string | null | undefined): Command | null {
  const normalized = (text ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalized) return null;
  switch (normalized) {
    case 'STOP':
    case 'UNSUBSCRIBE':
    case 'CANCEL MESSAGES':
      return { kind: 'STOP' };
    case 'HELP':
      return { kind: 'HELP' };
    case 'START':
    case 'JOIN':
      return { kind: 'START' };
    case 'RESUME':
      return { kind: 'RESUME' };
    case 'PROFILE':
      return { kind: 'PROFILE' };
    case 'EDIT':
      return { kind: 'EDIT', questionNumber: null };
    case 'RESULTS':
      return { kind: 'RESULTS' };
    default: {
      const edit = /^EDIT (\d{1,2})$/.exec(normalized);
      if (edit) return { kind: 'EDIT', questionNumber: Number(edit[1]) };
      return null;
    }
  }
}

/** Typed replies accepted in the enrollment consent step after an explicit prompt. */
export function parseConsentReply(text: string | null | undefined): 'ACCEPT' | 'DECLINE' | null {
  const normalized = (text ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (['YES', 'Y', 'AGREE', 'I AGREE', 'ACCEPT', 'OK'].includes(normalized)) return 'ACCEPT';
  if (['NO', 'N', 'DECLINE', 'DISAGREE', 'CANCEL'].includes(normalized)) return 'DECLINE';
  return null;
}
