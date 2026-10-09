import { expect, test } from '@playwright/test';
import { makePng } from '../../../../packages/core/tests/fixtures/png';

const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

test('create a character from turnaround sheets and make a video with them', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();

  // New character: sheets in, consent, references out
  await page.getByRole('link', { name: 'New character' }).first().click();
  await expect(page.getByTestId('character-dropzone')).toBeVisible();
  await page.getByTestId('character-files-input').setInputFiles([
    { name: 'turnaround.png', mimeType: 'image/png', buffer: makePng(160, 90, [200, 120, 90, 255]) },
    { name: 'face.png', mimeType: 'image/png', buffer: makePng(80, 100, [60, 90, 140, 255]) },
  ]);
  const name = `Maya ${Date.now()}`;
  await page.getByTestId('character-name').fill(name);
  await expect(page.getByTestId('build-character')).toBeDisabled(); // consent required
  await page.getByTestId('character-consent').check();
  await page.getByTestId('build-character').click();
  await expect(page.getByTestId('character-building')).toBeVisible();

  await expect(page).toHaveURL(/\/characters\?character=/, { timeout: 120_000 });
  const board = page.getByTestId('character-board');
  await expect(board.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByTestId('character-refs').locator('img')).toHaveCount(2);
  await expect(page.getByTestId('character-description')).not.toHaveValue('');
  await expect(page.getByTestId('character-upload')).toHaveCount(2);
  await page.getByTestId('approve-character').click();
  await expect(board.getByText('ready', { exact: true })).toBeVisible();

  // Test the likeness
  await page.getByTestId('test-shot').click();
  await expect(page.getByTestId('test-shots').locator('img')).toHaveCount(1, { timeout: 60_000 });

  // Use the character on the Create screen
  await page.getByRole('link', { name: 'Create' }).first().click();
  await page.getByTestId('create-character').selectOption({ label: `${name} ✓` });
  await expect(page.getByTestId('create-look')).toBeVisible();
  await page.getByTestId('create-look').selectOption('cinematic');
  await page.getByLabel('Length').selectOption('8');
  await page.getByTestId('opt-voiceover').uncheck();
  const request = `${name} sipping coffee at a café window ${Date.now()}`;
  await page.getByTestId('create-prompt').fill(request);
  await page.getByTestId('create-send').click();
  const exchange = page.getByTestId('exchange').filter({ hasText: request });
  await expect(exchange.getByTestId('exchange-video')).toBeVisible({ timeout: 240_000 });
  await expect(exchange.getByTestId('ai-label-reminder')).toBeVisible();
});
