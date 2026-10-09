import { expect, test, type Page } from '@playwright/test';
import { makePng } from '../../../../packages/core/tests/fixtures/png';

const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('create-prompt')).toBeVisible();
}

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Incorrect email or password.')).toBeVisible();
});

test('create a project, approve a brief and edit the storyboard', async ({ page }) => {
  await login(page);

  // --- New project (advanced editor) -------------------------------------
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  const name = `E2E rooftop ${Date.now()}`;
  await page.locator('input[name="name"]').fill(name);
  await page.getByRole('button', { name: '9:16' }).click();
  await page.locator('textarea[name="mainMessage"]').fill('The rooftop party is back this summer');
  await page.locator('input[name="callToAction"]').fill('Get tickets – link in bio');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText(name);
  await expect(page).toHaveURL(/\/references$/);

  // --- Reference board: upload an image ---------------------------------
  await page.getByTestId('reference-file-input').setInputFiles({
    name: 'palette.png',
    mimeType: 'image/png',
    buffer: makePng(64, 64, [0, 200, 255, 255]),
  });
  await expect(page.getByTestId('reference-card')).toHaveCount(1);
  await expect(page.getByTestId('reference-card').getByText('completed')).toBeVisible({ timeout: 60_000 });

  // --- Brief --------------------------------------------------------------
  await page.getByTestId('tab-brief').click();
  await page.getByTestId('generate-brief').click();
  const hook = page.locator('textarea[name="openingHook"]');
  await expect(hook).not.toHaveValue('', { timeout: 60_000 });
  await hook.fill('Neon countdown from 3 to 1, then the crowd jumps');
  await page.getByTestId('approve-brief').click();
  await expect(page.getByTestId('approve-brief')).toHaveText('Approved ✓');

  // --- Storyboard ------------------------------------------------------------
  await page.getByTestId('tab-storyboard').click();
  await page.getByTestId('generate-storyboard').click();
  const cards = page.getByTestId('scene-card');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  const initial = await cards.count();
  expect(initial).toBeGreaterThanOrEqual(2);

  // Edit a field
  const first = cards.first();
  if (!(await first.getByTestId('field-purpose').isVisible())) await first.getByTestId('edit-scene').click();
  await first.getByTestId('field-purpose').fill('Countdown hook');
  await first.getByTestId('field-duration').fill('3');
  await first.getByTestId('save-scene').click();
  await expect(first.getByTestId('scene-purpose')).toHaveText('Countdown hook');

  // Duplicate
  await first.getByTestId('duplicate-scene').click();
  await expect(cards).toHaveCount(initial + 1);
  await expect(cards.nth(1).getByTestId('scene-purpose')).toHaveText('Countdown hook (copy)');

  // Reorder with the keyboard (dnd-kit keyboard sensor). Collapse the edited card first so
  // every card has a similar height and each arrow press moves one position.
  if (await first.getByTestId('field-purpose').isVisible()) await first.getByTestId('edit-scene').click();
  const secondPurpose = await cards.nth(2).getByTestId('scene-purpose').textContent();
  // Keyboard moves depend on card sizes, so move until dnd-kit's live region reports the
  // item is over the first card, then drop.
  const firstId = await page.locator('[id^="scene-"]').first().getAttribute('id');
  const targetId = firstId!.replace('scene-', '');
  const live = page.locator('[id^="DndLiveRegion"]');
  await cards.nth(2).getByTestId('drag-handle').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  for (let i = 0; i < 6 && !((await live.textContent()) ?? '').includes(`droppable area ${targetId}`); i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Space');
  await expect(cards.first().getByTestId('scene-purpose')).toHaveText(secondPurpose ?? '');
  await page.reload();
  await expect(page.getByTestId('scene-card').first().getByTestId('scene-purpose')).toHaveText(
    secondPurpose ?? '',
  );

  // Add + delete (two-step confirm)
  await page.getByTestId('add-scene').click();
  await expect(page.getByTestId('scene-card')).toHaveCount(initial + 2);
  const last = page.getByTestId('scene-card').last();
  if (!(await last.getByTestId('delete-scene').isVisible())) await last.getByTestId('edit-scene').click();
  await last.getByTestId('delete-scene').click();
  await last.getByRole('button', { name: 'Delete scene?' }).click();
  await expect(page.getByTestId('scene-card')).toHaveCount(initial + 1);

  // Generate one scene and preview it
  await page.getByTestId('scene-card').first().getByTestId('generate-scene').click();
  await expect(page.getByTestId('scene-card').first().getByTestId('scene-preview')).toBeVisible({
    timeout: 120_000,
  });

  // Dashboard shows the project
  await page.goto('/projects');
  await expect(page.getByTestId('project-card').filter({ hasText: name })).toBeVisible();
});
