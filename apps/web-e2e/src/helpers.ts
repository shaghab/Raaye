import { expect, type Page } from '@playwright/test';

export const ACCOUNTS = {
  admin: { email: 'admin@pilap.demo', password: 'Raaye-Admin-2026!' },
  manager: { email: 'manager@pilap.demo', password: 'Raaye-Manager-2026!' },
  viewer: { email: 'viewer@pilap.demo', password: 'Raaye-Viewer-2026!' },
  orgB: { email: 'admin@lcf.demo', password: 'Raaye-OrgB-2026!' },
} as const;

export async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(account.email);
  await page.getByTestId('login-password').fill(account.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('messaging-mode')).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByTestId('login-submit')).toBeVisible();
}

export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}
