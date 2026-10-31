import { expect, test, type Page } from '@playwright/test';

const state = (page: Page) => page.getByTestId('player-state');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('initial sample is shown with tracks and no errors', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'MML Studio' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('TR(3) CH(10)');
  const rows = page.locator('.track-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('String Ensemble 1');
  await expect(rows.nth(2)).toContainText('GM ドラム');
  await expect(page.getByText('問題はありません。')).toBeVisible();
  await expect(state(page)).toHaveAttribute('data-state', 'idle');
});

test('play, pause, resume, seek and stop', async ({ page }) => {
  await page.getByLabel('サンプルを読み込む').selectOption('tempo-change');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.locator('.time')).toContainText('/ 0:04.6');
  // Worklet and SoundFont must be served (no 404) — playback would not start otherwise.
  await page.getByRole('button', { name: '一時停止' }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'paused');
  const pausedAt = await page.locator('.time').textContent();
  await page.waitForTimeout(400);
  await expect(page.locator('.time')).toHaveText(pausedAt!);

  const seek = page.getByLabel('再生位置');
  await seek.fill('3');
  await seek.dispatchEvent('pointerup');
  await expect(page.locator('.time')).toContainText('0:03.0');

  await page.getByRole('button', { name: '再開' }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.time')).toContainText('0:00.0');
});

test('song plays to the end and returns to ready', async ({ page }) => {
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(state(page)).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
});

test('compile errors disable playback and jump to source', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\no10 x');
  await expect(page.locator('.diag-error')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeDisabled();
  await expect(page.getByText('MML にエラーがあります')).toBeVisible();

  await page.locator('.diag-error').nth(1).click();
  const selected = await page.evaluate(() => String(window.getSelection()));
  expect(selected).toBe('x');
  await expect(page.locator('.diag-error').nth(1)).toContainText('19行5列');
});

test('empty source does not play', async ({ page }) => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByText('演奏する音符がありません。')).toBeVisible({ timeout: 30_000 });
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
});
