import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { login, logout } from './helpers';

const workspaceRoot = path.resolve(__dirname, '../../..');

/**
 * The live-deployment path for the first Admin (issue #13): an operator runs `bootstrap:org`
 * through the worker bundle, and the invited person turns the printed single-use link into an
 * account (password chosen in the browser, created in the Auth emulator) and an Admin membership.
 */
test('an operator bootstraps an organization and the invited Admin joins from the printed link', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const name = `Civic Trust ${stamp}`;
  const email = `lead-${stamp}@civic.example`;
  const password = 'Civic-Lead-2026!';
  const output = execFileSync(process.execPath, ['dist/apps/worker/main.js', 'bootstrap:org', '--name', name, '--slug', `civic-${stamp}`, '--admin-email', email], {
    cwd: workspaceRoot,
    env: { ...process.env, LOG_LEVEL: 'warn' },
    encoding: 'utf8',
  });
  const acceptUrl = /"acceptUrl": "([^"]+)"/.exec(output)?.[1];
  expect(acceptUrl).toBeTruthy();
  // WEB_ORIGIN points at the Docker dashboard; the journey runs against the dev server, so keep the path and token.
  const link = new URL(String(acceptUrl));
  await page.goto(`${link.pathname}${link.search}`);
  await expect(page.getByText(`You were invited to ${name} as Admin using ${email}`)).toBeVisible();
  await page.getByLabel('Your name').fill('Civic Lead');
  await page.getByLabel('Choose a password (8+ characters)').fill(password);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page.getByText(`You are now a member of ${name}`)).toBeVisible();

  // The link is single use.
  await page.goto(`${link.pathname}${link.search}`);
  await expect(page.getByRole('alert')).toContainText('invalid, expired or already used');

  // The new account signs in as the Admin of the new organization.
  await login(page, { email, password });
  await expect(page.locator('.toolbar-title')).toHaveText(name);
  await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('organization.bootstrapped')).toBeVisible();
  await logout(page);
});
