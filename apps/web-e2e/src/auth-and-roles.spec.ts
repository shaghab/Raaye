import { expect, test } from '@playwright/test';
import { ACCOUNTS, login, logout } from './helpers';

test.describe('authentication and roles (R03, R04, R05, R06)', () => {
  test('rejects a wrong password and signs in a demo admin', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-email').fill(ACCOUNTS.admin.email);
    await page.getByTestId('login-password').fill('wrong-password');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('incorrect');
    await page.getByTestId('login-password').fill(ACCOUNTS.admin.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('messaging-mode')).toHaveText(/MOCK MESSAGING/);
    await expect(page.getByTestId('mock-banner')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'WhatsApp simulator' })).toBeVisible();
    await logout(page);
  });

  test('viewer sees aggregates only', async ({ page }) => {
    await login(page, ACCOUNTS.viewer);
    await expect(page.getByRole('link', { name: 'Contacts' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await page.goto('/contacts');
    await expect(page).toHaveURL(/overview/);
    await page.getByRole('link', { name: 'Surveys' }).click();
    // Found by search, so surveys created by earlier runs cannot push the seeded one off the first page.
    await page.getByLabel('Search').fill('Access to justice');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('link', { name: /Access to justice 2026/ }).click();
    await expect(page.getByTestId('survey-heading')).toContainText('Access to justice');
    await expect(page.getByRole('tab', { name: 'Results' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Responses' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Dispatch' })).toHaveCount(0);
    await expect(page.getByTestId('survey-launch')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Results' }).click();
    await expect(page.getByTestId('result-question').first()).toBeVisible();
    await logout(page);
  });

  test('a second tenant never sees the first tenant\'s surveys or contacts (R07)', async ({ page }) => {
    await login(page, ACCOUNTS.orgB);
    await page.getByRole('link', { name: 'Surveys' }).click();
    await expect(page.getByTestId('surveys-table')).toContainText('Tenant B neighbourhood poll');
    await expect(page.getByTestId('surveys-table')).not.toContainText('Legal aid awareness');
    await page.getByRole('link', { name: 'Contacts', exact: true }).click();
    await expect(page.getByTestId('contacts-table')).toContainText('Tenant B Contact');
    await expect(page.getByTestId('contacts-table')).not.toContainText('Ayesha Khan');
    await logout(page);
  });

  test('password reset page accepts an email without revealing accounts', async ({ page }) => {
    await page.goto('/reset-password');
    await page.getByLabel('Email').fill('nobody@pilap.demo');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('a reset link has been sent')).toBeVisible();
  });
});
