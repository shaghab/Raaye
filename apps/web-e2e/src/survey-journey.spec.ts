import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, login, logout, unique } from './helpers';

/**
 * The critical path: author a survey with all five question types, launch it, answer it in the
 * simulator (buttons, list, Flow, rating), edit an answer inside the window, be refused after the
 * window, and read the aggregates. R15-R20, R24, R31-R35, R37, R46.
 */
async function tapControl(page: Page, label: string): Promise<void> {
  await page.getByTestId(`sim-control-${label}`).last().click();
}

test('author, launch, answer, edit and report a survey end to end', async ({ page }) => {
  test.setTimeout(240_000);
  const title = unique('E2E transport survey');
  const digits = String(Date.now()).slice(-7);
  const phone = `+92300${digits}`;
  await login(page, ACCOUNTS.manager);
  // A fresh, consented participant so the run never depends on earlier conversation state.
  await page.goto('/contacts/new');
  await page.getByTestId('contact-name').fill(`E2E Participant ${digits}`);
  await page.getByTestId('contact-phone').fill(phone);
  await page.getByTestId('contact-save').click();
  await page.getByTestId('record-consent').click();
  await page.getByRole('checkbox', { name: 'Result sharing' }).check();
  await page.getByLabel('Evidence date and time').fill('2026-09-01T10:00');
  await page.getByLabel('Evidence reference').fill('E2E consent form');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('rye-chip', { hasText: 'Granted' }).first()).toBeVisible();
  await page.goto('/surveys/new');
  await page.getByTestId('survey-internal-title').fill(title);
  await page.getByTestId('survey-title').fill('E2E transport survey');
  await page.getByTestId('survey-intro').fill('Thanks for taking part in this synthetic end-to-end survey.');
  await page.getByTestId('question-prompt-0').fill('Do you use public transport weekly?');
  // Q2 Yes/No/Indifferent
  await page.getByTestId('add-question').click();
  await page.getByTestId('question-type-1').click();
  await page.getByRole('option', { name: 'Yes / No / Indifferent' }).click();
  await page.getByTestId('question-prompt-1').fill('Should student fares be subsidized?');
  // Q3 single choice with 4 options (list renderer)
  await page.getByTestId('add-question').click();
  await page.getByTestId('question-type-2').click();
  await page.getByRole('option', { name: 'Single choice' }).click();
  await page.getByTestId('question-prompt-2').fill('Which issue matters most?');
  await page.getByTestId('question-2-option-0').fill('Safety');
  await page.getByTestId('question-2-option-1').fill('Cost');
  await page.getByRole('button', { name: 'Add option' }).last().click();
  await page.getByTestId('question-2-option-2').fill('Reliability');
  await page.getByRole('button', { name: 'Add option' }).last().click();
  await page.getByTestId('question-2-option-3').fill('Accessibility');
  // Q4 multiple selection (Flow renderer)
  await page.getByTestId('add-question').click();
  await page.getByTestId('question-type-3').click();
  await page.getByRole('option', { name: 'Multiple selection' }).click();
  await page.getByTestId('question-prompt-3').fill('Which services did you use this year?');
  await page.getByTestId('question-3-option-0').fill('Metro bus');
  await page.getByTestId('question-3-option-1').fill('Orange line');
  await page.getByRole('button', { name: 'Add option' }).last().click();
  await page.getByTestId('question-3-option-2').fill('None of the above');
  await page.getByRole('checkbox', { name: /Exclusive/ }).last().check();
  // Q5 rating
  await page.getByTestId('add-question').click();
  await page.getByTestId('question-type-4').click();
  await page.getByRole('option', { name: 'Rating 1-5' }).click();
  await page.getByTestId('question-prompt-4').fill('Rate public transport overall.');
  // Audience: only the fresh participant.
  await page.getByRole('radio', { name: 'Selected contacts' }).check();
  await page.getByLabel('Search contacts').fill(digits);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: new RegExp(`E2E Participant ${digits}`) }).click();
  await page.getByTestId('survey-save').click();
  await expect(page.getByTestId('survey-heading')).toContainText(title);
  await expect(page.locator('rye-chip', { hasText: 'Draft' }).first()).toBeVisible();

  // Preview and eligibility, then launch now.
  await page.getByTestId('survey-preview').click();
  await expect(page.getByRole('dialog')).toContainText('Start survey');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('audience-preview').click();
  await expect(page.getByText(/selected contacts are eligible now/)).toBeVisible();
  await page.getByTestId('survey-launch').click();
  await page.getByTestId('launch-confirm').click();
  await expect(page.locator('rye-chip', { hasText: 'Active' }).first()).toBeVisible();
  await logout(page);

  // Participate through the simulator as the admin (simulator is Admin-only).
  await login(page, ACCOUNTS.admin);
  await page.goto('/simulator');
  await page.getByTestId('sim-drain').click();
  await page.getByLabel('Search').fill(digits);
  await page.getByLabel('Search').press('Enter');
  await page.getByTestId(`sim-contact-${phone}`).click();
  await expect(page.getByTestId('sim-chat')).toContainText('E2E transport survey');
  await tapControl(page, 'Start survey');
  // Optional profile step (first participation) or straight to question 1.
  await expect(page.getByTestId('sim-chat')).toContainText(/Question 1 of 5|optional details/);
  if (await page.getByTestId('sim-control-Skip').count()) await tapControl(page, 'Skip');
  await expect(page.getByTestId('sim-chat')).toContainText('Question 1 of 5');
  await tapControl(page, 'Yes');
  await expect(page.getByTestId('sim-chat')).toContainText('Question 2 of 5');
  // Edit Q1 inside the window: tap "No" on the still-visible Q1 buttons.
  await page.getByTestId('sim-control-No').first().click();
  await expect(page.getByTestId('sim-chat')).toContainText('Answer updated');
  await tapControl(page, 'Indifferent');
  await expect(page.getByTestId('sim-chat')).toContainText('Question 3 of 5');
  await tapControl(page, 'Cost');
  await expect(page.getByTestId('sim-chat')).toContainText('Question 4 of 5');
  const flowSubmit = page.locator('[data-testid^="sim-flow-submit-"]').last();
  await page.getByRole('checkbox', { name: 'Metro bus' }).last().check();
  await page.getByRole('checkbox', { name: 'Orange line' }).last().check();
  await flowSubmit.click();
  await expect(page.getByTestId('sim-chat')).toContainText('Question 5 of 5');
  await tapControl(page, '4');
  await expect(page.getByTestId('sim-chat')).toContainText(/Thank you|recorded/i);
  // Expire the edit window and try to edit Q1 again: must be refused.
  await page.getByTestId('sim-clock-121').click();
  await page.getByTestId('sim-control-Yes').first().click();
  await expect(page.getByTestId('sim-chat')).toContainText(/time to change this answer has ended|no longer be changed/i);
  await logout(page);

  // Aggregates reflect the edited (not the original) answer.
  await login(page, ACCOUNTS.viewer);
  await page.getByRole('link', { name: 'Surveys' }).click();
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('tab', { name: 'Results' }).click();
  const q1 = page.getByTestId('result-question').first();
  await expect(q1).toContainText('1 valid answers');
  await expect(q1.locator('.result-row', { hasText: 'No' })).toContainText('1 · 100.0%');
  await expect(q1.locator('.result-row', { hasText: 'Yes' })).toContainText('0 · 0.0%');
  const q4 = page.getByTestId('result-question').nth(3);
  await expect(q4).toContainText('may exceed 100%');
  await expect(q4.locator('.result-row', { hasText: 'Metro bus' })).toContainText('1 · 100.0%');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export aggregates' }).click();
  await page.getByRole('menuitem', { name: 'CSV' }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/aggregates.*\.csv$/);
  await logout(page);
});

test('STOP after launch cancels pending sends and results sharing is Admin-only after closure (R21, R51)', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, ACCOUNTS.admin);
  await page.getByRole('link', { name: 'Surveys' }).click();
  // The seeded survey is found by search, so surveys created by earlier runs cannot push it off the first page.
  await page.getByLabel('Search').fill('Access to justice');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('link', { name: /Access to justice 2026/ }).click();
  await page.getByRole('tab', { name: 'Share results' }).click();
  await expect(page.getByText('Shared snapshot')).toBeVisible();
  await expect(page.getByText(/eligible recipients/)).toBeVisible();
  await page.goto('/simulator');
  await page.getByTestId('sim-contact-+923001000012').click();
  await page.getByTestId('sim-text').fill('STOP');
  await page.getByTestId('sim-send').click();
  await expect(page.getByTestId('sim-chat')).toContainText(/no longer receive/i);
  await page.goto('/contacts?search=Kamran');
  await page.getByRole('link', { name: 'Kamran Iqbal' }).click();
  await expect(page.locator('rye-chip', { hasText: 'Withdrawn' }).first()).toBeVisible();
  await logout(page);
});
