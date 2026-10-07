/**
 * Host development without Docker: starts the Firebase Auth emulator, applies migrations, seeds,
 * then runs the API, worker and Angular dev server together. Requires a local PostgreSQL that
 * DATABASE_URL points at (for example `docker compose up -d db`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
if (!existsSync(path.join(root, '.env'))) {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(2);
}
process.loadEnvFile(path.join(root, '.env'));
const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' };
const children: ChildProcess[] = [];

function run(name: string, command: string, args: string[], cwd = root): ChildProcess {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.on('exit', (code) => console.log(`[dev] ${name} exited with ${code}`));
  children.push(child);
  return child;
}

function step(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[dev] ${command} ${args.join(' ')} failed`);
    shutdown(result.status ?? 1);
  }
}

function shutdown(code: number): void {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

async function waitFor(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main(): Promise<void> {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (env['AUTH_MODE'] === 'emulator') {
    run('auth-emulator', 'pnpm', ['exec', 'firebase', 'emulators:start', '--only', 'auth', '--project', env['FIREBASE_PROJECT_ID'] ?? 'demo-raaye'], path.join(root, 'infra/firebase'));
    await waitFor(`http://${env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099'}/`);
  }
  step('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);
  step('pnpm', ['exec', 'nx', 'run-many', '-t', 'build', '-p', 'api,worker', '--configuration=development']);
  step('node', ['dist/apps/worker/main.js', 'seed']);
  run('api', 'node', ['dist/apps/api/main.js']);
  run('worker', 'node', ['dist/apps/worker/main.js', 'worker']);
  run('web', 'pnpm', ['exec', 'nx', 'serve', 'web']);
  console.log('\n[dev] Dashboard: http://127.0.0.1:4200  API: http://127.0.0.1:3000/api/docs  (Ctrl+C stops everything)\n');
}

main().catch((error: unknown) => {
  console.error(error);
  shutdown(1);
});
