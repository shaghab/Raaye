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
