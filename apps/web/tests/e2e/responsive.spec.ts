import { expect, test } from '@playwright/test';

const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

test('works on a phone-sized screen', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('service-openai')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
