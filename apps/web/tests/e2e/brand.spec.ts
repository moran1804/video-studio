import { expect, test } from '@playwright/test';
import { makePng } from '../../../../packages/core/tests/fixtures/png';

const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

test('build a brand from dropped logos and posters', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();

  // Upload-first: files in, brand out
  await page.getByRole('link', { name: 'New brand' }).first().click();
  await expect(page.getByTestId('brand-dropzone')).toBeVisible();
  await expect(page.getByTestId('build-brand')).toBeDisabled();
  await page.getByTestId('brand-files-input').setInputFiles([
    { name: 'logo.png', mimeType: 'image/png', buffer: makePng(80, 40, [255, 0, 128, 255]) },
    { name: 'flyer.png', mimeType: 'image/png', buffer: makePng(60, 90, [20, 20, 40, 255]) },
  ]);
  await expect(page.getByTestId('brand-picked').locator('img')).toHaveCount(2);
  await page.getByTestId('build-brand').click();
  await expect(page.getByTestId('brand-building')).toBeVisible();

  // Lands on the brand board
  await expect(page).toHaveURL(/\/brands\?brand=.+&tab=overview/, { timeout: 90_000 });
  const board = page.getByTestId('brand-board');
  await expect(board.getByRole('heading', { name: 'Mock Brand Co' })).toBeVisible();
  await expect(page.getByTestId('board-palette').locator('button').first()).toBeVisible();
  await expect(page.getByTestId('board-type')).toContainText('Montserrat');
  await expect(page.getByTestId('brand-asset')).toHaveCount(2);
  await expect(page.getByTestId('brand-asset').getByText('overlay logo', { exact: true })).toBeVisible();

  // Add another asset on the board; the AI sorts it on the next run
  await page.getByTestId('brand-asset-input').setInputFiles({
    name: 'product.png',
    mimeType: 'image/png',
    buffer: makePng(64, 64, [20, 160, 90, 255]),
  });
  await expect(page.getByTestId('brand-asset')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Analyse now' })).toBeVisible();
  await page.getByRole('button', { name: 'Analyse now' }).click();
  // Sorted once the run finishes: no upload is left on "Not analysed yet".
  await expect(page.getByTestId('brand-asset').locator('option[value="auto"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'Analyse now' })).toHaveCount(0);

  // Approve, then edit in the design-system tab
  await page.getByTestId('board-approve').click();
  await expect(board.getByText('approved ✓')).toBeVisible();
  await page.getByTestId('brand-tab-design').click();
  await page.getByTestId('ds-summary').fill('Playful neon nightlife brand for students.');
  await page.getByTestId('approve-design').click();
  await expect(page.getByTestId('approve-design')).toHaveText('Approved ✓');
  await page.getByTestId('brand-tab-context').click();
  await expect(page.getByTestId('brand-guide')).toContainText('Brand: Mock Brand Co');
  await expect(page.getByTestId('brand-guide')).toContainText(
    'Essence: Playful neon nightlife brand for students.',
  );
});

test('new brand menu and optional brand picker on new projects', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();

  // "New brand" menu → set up manually → continues on the brand's overview
  await page.getByRole('link', { name: 'New brand' }).first().click();
  await expect(page).toHaveURL(/\/brands\/new$/);
  await page.getByTestId('manual-brand').click();
  const brandName = `Picker Brand ${Date.now()}`;
  await page.getByTestId('brand-name').fill(brandName);
  await page.getByTestId('save-brand').click();
  await expect(page).toHaveURL(/\/brands\?brand=.+&tab=overview/);
  await expect(page.getByTestId('brand-board').getByRole('heading', { name: brandName })).toBeVisible();
  await expect(page.getByTestId('upload-brand-asset')).toBeVisible();

  // New project: branding is off by default; switching it on lists the brands
  await page.goto('/projects/new');
  await expect(page.getByTestId('brand-picker')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Use a brand / design system' }).click();
  await expect(page.getByTestId('brand-picker')).toBeVisible();
  await expect(page.getByTestId('create-brand-link')).toHaveAttribute('href', '/brands/new');
  await page.locator('input[name="name"]').fill(`Branded project ${Date.now()}`);
  await page.getByTestId('create-project').click();
  await expect(page.getByText('Pick a brand, or switch "Use a brand" off.')).toBeVisible();
  await page.getByTestId('brand-option').filter({ hasText: brandName }).click();
  await expect(page.getByTestId('brand-option').filter({ hasText: brandName })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('create-project').click();
  await expect(page).toHaveURL(/\/references$/);
  await page.getByTestId('tab-brand').click();
  await expect(page.getByTestId('project-brand-name')).toHaveText(brandName);
});

test('animate a poster straight from the new project form', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();

  await page.goto('/projects/new');
  await page.locator('input[name="name"]').fill(`Poster ${Date.now()}`);
  await page.getByTestId('artwork-input').setInputFiles({
    name: 'gig-poster.png',
    mimeType: 'image/png',
    buffer: makePng(300, 420, [240, 120, 20, 255]),
  });
  await expect(page.getByTestId('artwork-item')).toHaveCount(1);
  await expect(page.getByLabel('How to use gig-poster.png')).toHaveValue('animate');
  await page.getByTestId('create-project').click();

  // Lands on the storyboard with a ready-to-generate scene that animates the poster
  await expect(page).toHaveURL(/\/storyboard$/, { timeout: 30_000 });
  const card = page.getByTestId('scene-card').first();
  await expect(card.getByTestId('scene-purpose')).toHaveText('Animate gig-poster.png');
  await expect(card.getByTestId('scene-animates')).toBeVisible();
  await card.getByTestId('generate-scene').click();
  await expect(card.getByTestId('scene-preview')).toBeVisible({ timeout: 120_000 });
});
