/**
 * Docker startup smoke test (R01/R02): builds and starts the Compose stack, waits for the
 * dashboard and API, signs in through the emulator, checks seeded data, restarts, and checks
 * that user-created data survived. Requires Docker with Compose v2.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const WEB = `http://127.0.0.1:${process.env['WEB_PORT'] ?? '8080'}`;
const AUTH = `http://127.0.0.1:${process.env['AUTH_PORT'] ?? '9099'}`;
const compose = (...args: string[]) => {
  const result = spawnSync('docker', ['compose', ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
};

async function waitFor(url: string, attempts = 120): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`Emulator sign-in failed: ${response.status}`);
  const body = (await response.json()) as { idToken: string };
  return body.idToken;
}

async function api<T>(token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${WEB}/api/v1${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${pathname} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  compose('up', '--build', '-d');
  await waitFor(`${WEB}/`);
  await waitFor(`${WEB}/api/v1/health/ready`);
  const token = await signIn('admin@pilap.demo', 'Raaye-Admin-2026!');
  const me = await api<{ role: string; organization: { slug: string } }>(token, '/me');
  if (me.role !== 'ADMIN' || me.organization.slug !== 'pilap') throw new Error('Demo admin membership missing');
  const surveys = await api<{ total: number }>(token, '/surveys?limit=1');
  if (surveys.total < 4) throw new Error(`Expected seeded surveys, found ${surveys.total}`);
  const marker = `Smoke contact ${Date.now()}`;
  const created = await api<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ name: marker, phone: '+923009990001' }) });
  compose('restart', 'api', 'worker');
  await waitFor(`${WEB}/api/v1/health/ready`);
  const after = await api<{ name: string }>(await signIn('admin@pilap.demo', 'Raaye-Admin-2026!'), `/contacts/${created.id}`);
  if (after.name !== marker) throw new Error('User-created contact did not survive restart');
  const again = await api<{ total: number }>(token, '/surveys?limit=1');
  if (again.total !== surveys.total) throw new Error('Seed re-run changed survey count');
  console.log('Docker smoke test passed');
  if (!keep) compose('down');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
