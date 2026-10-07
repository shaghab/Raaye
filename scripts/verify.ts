/**
 * Full local verification: lint, strict types, unit tests, integration tests, WhatsApp asset
 * validation, production builds and (optionally) Playwright journeys and the Docker smoke test.
 *   pnpm verify                # everything that needs only PostgreSQL
 *   pnpm verify -- --e2e       # also the Playwright critical journeys (needs the auth emulator)
 *   pnpm verify -- --docker    # also `docker compose up --build` smoke test
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
if (!process.env['DATABASE_URL'] && existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', CI: '1' };
const args = process.argv.slice(2);
const steps: { name: string; command: string; args: string[]; enabled: boolean }[] = [
  { name: 'lint', command: 'pnpm', args: ['lint'], enabled: true },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'], enabled: true },
  { name: 'unit tests', command: 'pnpm', args: ['test'], enabled: true },
  { name: 'integration tests', command: 'pnpm', args: ['test:integration'], enabled: true },
  { name: 'whatsapp assets', command: 'pnpm', args: ['whatsapp:validate'], enabled: true },
  { name: 'production builds', command: 'pnpm', args: ['build'], enabled: true },
  { name: 'e2e journeys', command: 'pnpm', args: ['test:e2e'], enabled: args.includes('--e2e') },
  { name: 'docker smoke', command: 'pnpm', args: ['exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'scripts/docker-smoke.ts'], enabled: args.includes('--docker') },
];
const results: { name: string; status: 'passed' | 'failed' | 'skipped'; seconds: number }[] = [];
for (const step of steps) {
  if (!step.enabled) {
    results.push({ name: step.name, status: 'skipped', seconds: 0 });
    continue;
  }
  console.log(`\n=== ${step.name} ===`);
  const started = Date.now();
  const result = spawnSync(step.command, step.args, { cwd: root, env, stdio: 'inherit' });
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ name: step.name, status: result.status === 0 ? 'passed' : 'failed', seconds });
  if (result.status !== 0 && !args.includes('--keep-going')) break;
}
console.log('\n=== Summary ===');
for (const result of results) console.log(`${result.status.padEnd(8)} ${result.name}${result.seconds ? ` (${result.seconds}s)` : ''}`);
process.exit(results.some((result) => result.status === 'failed') ? 1 : 0);
