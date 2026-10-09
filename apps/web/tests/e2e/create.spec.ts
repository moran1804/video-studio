import { expect, test } from '@playwright/test';
import { makePng } from '../../../../packages/core/tests/fixtures/png';

const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

test('one request in, finished video out', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();

  // Captions need a voiceover
  await page.getByTestId('opt-voiceover').uncheck();
  await expect(page.getByTestId('opt-captions')).toBeDisabled();
  await page.getByTestId('opt-voiceover').check();
  await expect(page.getByTestId('opt-captions')).toBeEnabled();
  await page.getByTestId('opt-captions').check();
  await page.getByLabel('Length').selectOption('15');
  await page.getByLabel('Brand / design system').selectOption('');

  // Attach a poster to animate and send
  await page.getByTestId('attach-input').setInputFiles({
    name: 'flyer.png',
    mimeType: 'image/png',
    buffer: makePng(300, 420, [240, 120, 20, 255]),
  });
  await expect(page.getByTestId('attachment')).toHaveCount(1);
  const request = `Animate this flyer for our rooftop party ${Date.now()}`;
  await page.getByTestId('create-prompt').fill(request);
  await page.getByTestId('create-send').click();

  const exchange = page.getByTestId('exchange').filter({ hasText: request });
  await expect(exchange).toBeVisible();
  await expect(exchange.getByTestId('exchange-progress')).toBeVisible();
  await expect(exchange.getByTestId('exchange-video')).toBeVisible({ timeout: 240_000 });
  await expect(exchange.getByText('voiceover', { exact: true })).toBeVisible();
  await expect(exchange.getByRole('link', { name: /Download/ })).toHaveAttribute('href', /download=1/);

  // It survives a reload and the options were remembered
  await page.reload();
  await expect(
    page.getByTestId('exchange').filter({ hasText: request }).getByTestId('exchange-video'),
  ).toBeVisible();
  await expect(page.getByLabel('Length')).toHaveValue('15');
});
