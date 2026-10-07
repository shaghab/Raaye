import { parseCommand, parseConsentReply } from '../commands';

describe('commands', () => {
  it('parses commands case-insensitively with surrounding whitespace', () => {
    expect(parseCommand('  stop ')).toEqual({ kind: 'STOP' });
    expect(parseCommand('Unsubscribe')).toEqual({ kind: 'STOP' });
    expect(parseCommand('cancel   messages')).toEqual({ kind: 'STOP' });
    expect(parseCommand('join')).toEqual({ kind: 'START' });
    expect(parseCommand('EDIT')).toEqual({ kind: 'EDIT', questionNumber: null });
    expect(parseCommand('edit 2')).toEqual({ kind: 'EDIT', questionNumber: 2 });
    expect(parseCommand('results')).toEqual({ kind: 'RESULTS' });
    expect(parseCommand('profile')).toEqual({ kind: 'PROFILE' });
    expect(parseCommand('help')).toEqual({ kind: 'HELP' });
    expect(parseCommand('resume')).toEqual({ kind: 'RESUME' });
  });

  it('does not guess', () => {
    expect(parseCommand('yes')).toBeNull();
    expect(parseCommand('stop please')).toBeNull();
    expect(parseCommand('edit 123')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('parses explicit consent replies only', () => {
    expect(parseConsentReply(' yes ')).toBe('ACCEPT');
    expect(parseConsentReply('No')).toBe('DECLINE');
    expect(parseConsentReply('maybe')).toBeNull();
  });
});
