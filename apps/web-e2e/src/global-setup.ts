import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const workspaceRoot = path.resolve(__dirname, '../../..');

const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' } as Record<string, string>;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(args: string[]): void {
  const result = spawnSync('pnpm', args, { cwd: workspaceRoot, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}

/** Ensures the auth emulator, migrations, API/worker bundles and the demo seed exist before the journeys run. */
export default async function globalSetup(): Promise<void> {
  const emulator = `http://${env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099'}/`;
  if (!(await reachable(emulator))) {
    const child = spawn('pnpm', ['exec', 'firebase', 'emulators:start', '--only', 'auth', '--project', env['FIREBASE_PROJECT_ID'] ?? 'demo-raaye'], { cwd: `${workspaceRoot}/infra/firebase`, env, stdio: 'ignore', detached: true });
    child.unref();
    await waitFor(emulator, 90);
  }
  run(['exec', 'prisma', 'migrate', 'deploy']);
  run(['exec', 'nx', 'run-many', '-t', 'build', '-p', 'api,worker', '--configuration=development']);
  const seed = spawnSync('node', ['dist/apps/worker/main.js', 'seed'], { cwd: workspaceRoot, stdio: 'inherit', env: { ...env, LOG_LEVEL: 'warn' } });
  if (seed.status !== 0) throw new Error('Seeding failed');
}
