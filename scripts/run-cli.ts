/**
 * Runs an operational command (seed, seed:scale, sweep, run-once, retention) through the
 * built worker bundle so Nest decorator metadata is available. Usage: tsx scripts/run-cli.ts seed
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const command = process.argv[2];
if (!command) {
  console.error('Usage: run-cli <seed|seed:scale|sweep|run-once|retention> [args]');
  process.exit(2);
}
if (!existsSync(path.join(root, '.env')) && !process.env['DATABASE_URL']) {
  console.error('No .env found. Copy .env.example to .env first (PowerShell: Copy-Item .env.example .env).');
  process.exit(2);
}
if (!process.env['DATABASE_URL']) process.loadEnvFile(path.join(root, '.env'));
const bundle = path.join(root, 'dist/apps/worker/main.js');
if (!existsSync(bundle) || process.env['RAAYE_REBUILD'] === '1') {
  const build = spawnSync('pnpm', ['exec', 'nx', 'build', 'worker', '--configuration=development'], { cwd: root, stdio: 'inherit', env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' } });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const run = spawnSync(process.execPath, [bundle, command, ...process.argv.slice(3)], { cwd: root, stdio: 'inherit', env: process.env });
process.exit(run.status ?? 1);
