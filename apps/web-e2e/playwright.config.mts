import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Critical dashboard journeys against the real API, PostgreSQL, the Firebase Auth emulator
 * and the WhatsApp simulator. `global-setup.ts` prepares the database, emulator and seed; the
 * API and the Angular dev server are started here unless already running.
 */
const envFile = path.join(workspaceRoot, '.env');
if (existsSync(envFile) && !process.env['DATABASE_URL']) process.loadEnvFile(envFile);
const baseURL = process.env['E2E_BASE_URL'] || 'http://127.0.0.1:4200';
// Honour a preinstalled Chromium (sandboxes/CI images) instead of downloading one.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' } as Record<string, string>;

export default defineConfig({
  testDir: path.join(import.meta.dirname, 'src'),
  outputDir: path.join(workspaceRoot, 'test-results'),
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  globalSetup: path.join(import.meta.dirname, 'src/global-setup.ts'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(workspaceRoot, 'playwright-report') }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: [
    {
      command: 'node dist/apps/api/main.js',
      url: 'http://127.0.0.1:3000/api/v1/health/ready',
      reuseExistingServer: true,
      cwd: workspaceRoot,
      env,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec nx serve web',
      url: baseURL,
      reuseExistingServer: true,
      cwd: workspaceRoot,
      env,
      timeout: 240_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
