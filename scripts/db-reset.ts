/**
 * Development-only database reset: drops and recreates the schema, re-applies migrations and
 * re-seeds through the Prisma seed hook. Refuses to run against anything that does not look like a local database.
 * Usage: pnpm db:reset -- --yes
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
if (!process.env['DATABASE_URL'] && existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const url = process.env['DATABASE_URL'] ?? '';
const appEnv = process.env['APP_ENV'] ?? 'local';
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'db']);
if (!url || !localHosts.has(host) || appEnv === 'production' || process.env['MESSAGING_MODE'] === 'live') {
  console.error(`Refusing to reset: DATABASE_URL host "${host || 'unset'}" is not local, or APP_ENV/MESSAGING_MODE indicate a live environment.`);
  process.exit(2);
}
if (!process.argv.includes('--yes')) {
  console.error(`This drops every table in ${host}/${new URL(url).pathname.slice(1)}. Re-run with --yes to confirm.`);
  process.exit(2);
}
const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' };
// `prisma migrate reset` drops the schema, re-applies every migration and then runs the seed
// command configured in prisma.config.ts (`pnpm db:seed`).
const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force'], { cwd: root, stdio: 'inherit', env });
process.exit(result.status ?? 1);
