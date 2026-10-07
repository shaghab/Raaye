import { expect, test } from '@playwright/test';
import path from 'node:path';
import { ACCOUNTS, login, unique } from './helpers';

test.describe('contacts and consent (R10, R11, R12, R14)', () => {
  test('manager creates a contact, records consent evidence and exports the directory', async ({ page }) => {
    await login(page, ACCOUNTS.manager);
    await page.getByRole('link', { name: 'Contacts', exact: true }).click();
    await page.getByTestId('add-contact').click();
    const name = unique('E2E Contact');
    const digits = String(Date.now()).slice(-7);
    await page.getByTestId('contact-name').fill(name);
    await page.getByTestId('contact-phone').fill(`0300 ${digits}`);
    await page.getByTestId('contact-save').click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText(`+92300${digits}`)).toBeVisible();
    await expect(page.locator('rye-chip', { hasText: 'Unknown' }).first()).toBeVisible();
    await page.getByTestId('record-consent').click();
    await page.getByLabel('Evidence date and time').fill('2026-09-01T10:00');
    await page.getByLabel('Evidence reference').fill('Consent form E2E-1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('rye-chip', { hasText: 'Granted' }).first()).toBeVisible();
    await expect(page.getByText('Consent form E2E-1')).toBeVisible();
    await page.getByRole('link', { name: 'Contacts', exact: true }).click();
    await page.getByTestId('contact-search').fill(digits);
    await page.getByTestId('contact-search').press('Enter');
    await expect(page.getByTestId('contacts-table')).toContainText(name);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: /CSV/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('import wizard previews a fixture and reports invalid rows', async ({ page }) => {
    await login(page, ACCOUNTS.manager);
    await page.goto('/contacts/import');
    await page.getByTestId('import-file').setInputFiles(path.resolve(__dirname, '../../../fixtures/imports/contacts-invalid.csv'));
    await page.getByRole('button', { name: 'Map columns' }).click();
    await page.getByTestId('import-preview').click();
    await expect(page.getByText('Errors').first()).toBeVisible();
    await expect(page.locator('rye-chip', { hasText: 'Error' }).first()).toBeVisible();
  });
});
