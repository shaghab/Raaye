/**
 * Secrets are referenced by name (for example an environment variable injected from
 * Secret Manager) and resolved only at the provider boundary. Values never reach the
 * database, API responses or logs.
 */
export function resolveSecret(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  const name = ref.startsWith('env:') ? ref.slice(4) : ref;
  const value = env[name];
  return value && value.length > 0 ? value : null;
}

export type SecretLookup = { value: string; source: 'reference' | 'default' } | { value: null; source: 'unresolved' | 'missing' };

/**
 * Resolve a connection-bound secret for the webhook route. A bound reference that does not resolve
 * fails closed: readiness already reports it as SECRET_UNRESOLVED, and the request must never be
 * authenticated with the process-wide default instead. The default applies only when nothing is bound.
 */
export function lookupSecret(ref: string | null | undefined, fallback: string | null | undefined, env: NodeJS.ProcessEnv = process.env): SecretLookup {
  if (ref) {
    const value = resolveSecret(ref, env);
    return value ? { value, source: 'reference' } : { value: null, source: 'unresolved' };
  }
  return fallback ? { value: fallback, source: 'default' } : { value: null, source: 'missing' };
}
