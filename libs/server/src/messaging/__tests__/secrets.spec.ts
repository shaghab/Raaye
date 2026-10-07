import { lookupSecret, resolveSecret } from '../secrets';

describe('secret references', () => {
  const env = { BOUND: 'bound-value', EMPTY: '' };

  it('resolves environment references with or without the env: prefix and treats empty values as unset', () => {
    expect(resolveSecret('env:BOUND', env)).toBe('bound-value');
    expect(resolveSecret('BOUND', env)).toBe('bound-value');
    expect(resolveSecret('EMPTY', env)).toBeNull();
    expect(resolveSecret('MISSING', env)).toBeNull();
    expect(resolveSecret(null, env)).toBeNull();
  });

  it('falls back to the default only when no reference is bound', () => {
    expect(lookupSecret(null, 'default', env)).toEqual({ value: 'default', source: 'default' });
    expect(lookupSecret('', 'default', env)).toEqual({ value: 'default', source: 'default' });
    expect(lookupSecret('BOUND', 'default', env)).toEqual({ value: 'bound-value', source: 'reference' });
    expect(lookupSecret('env:BOUND', 'default', env)).toEqual({ value: 'bound-value', source: 'reference' });
    expect(lookupSecret('MISSING', 'default', env)).toEqual({ value: null, source: 'unresolved' });
    expect(lookupSecret('EMPTY', 'default', env)).toEqual({ value: null, source: 'unresolved' });
    expect(lookupSecret(null, undefined, env)).toEqual({ value: null, source: 'missing' });
  });
});
