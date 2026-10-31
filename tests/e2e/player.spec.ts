import { expect, test, type Page } from '@playwright/test';
import { menu } from './menu';

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
  await menu(page, 'サンプル', 'テンポ変更');
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

test('piano roll: shown by default, lights the sounding notes, jumps to the MML of a clicked note, can be hidden', async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const roll = page.getByTestId('piano-roll');
  await expect(roll).toBeVisible();
  await expect(roll).toHaveAttribute('aria-label', /ピアノロール（\d+ 音）/);

  // a note on line 2 of the MML; click it (stopped: the roll starts at 0 s)
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('TR(1) CH(1) l1\nc');
  await expect(roll).toHaveAttribute('aria-label', /（1 音）/);
  const box = (await roll.boundingBox())!;
  const keyW = 46;
  const ruler = 16;
  const playX = keyW + (box.width - keyW) * 0.25;
  const rowH = (box.height - ruler) / 25; // C4 alone: window 48..72
  await page.mouse.click(box.x + playX + 20, box.y + ruler + (72 - 60) * rowH + rowH / 2);
  await expect(page.locator('.cm-activeLine')).toHaveText('c');

  // playing lights the sounding notes
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('player-state')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(roll).toHaveAttribute('data-active', '60');
  await page.getByRole('button', { name: '停止', exact: true }).click();

  // hide / show (remembered)
  await page.getByRole('button', { name: '演奏表示を閉じる' }).click();
  await expect(roll).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('piano-roll')).toHaveCount(0);
  await page.getByRole('button', { name: /演奏表示/ }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
});

test('track show / hide in the legend, and the channel view', async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('TR(1) CH(1) @41 l1 CC(7,90) c\nTR(2) CH(2) l1 o3 e\nTR(3) CH(10) l1 n36');
  const roll = page.getByTestId('piano-roll');
  const legend = page.getByRole('group', { name: /^トラック/ });
  await expect(legend.locator('.roll-chip')).toHaveText(['TR1', 'TR2', 'TR3']);

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('player-state')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(roll).toHaveAttribute('data-active', '36,52,60');
  // hide TR2
  await legend.getByRole('button', { name: 'TR2', exact: true }).click();
  await expect(legend.getByRole('button', { name: 'TR2', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(roll).toHaveAttribute('data-active', '36,60');
  // solo TR1, then show all again
  await legend.getByRole('button', { name: 'TR1', exact: true }).click({ modifiers: ['Shift'] });
  await expect(roll).toHaveAttribute('data-active', '60');
  await legend.getByRole('button', { name: 'TR1', exact: true }).click({ modifiers: ['Shift'] });
  await expect(roll).toHaveAttribute('data-active', '36,52,60');

  // channel view: every track has a row; the sounding keys per track
  await page.getByRole('tab', { name: 'チャンネル' }).click();
  const monitor = page.getByTestId('channel-monitor');
  await expect(monitor).toHaveAttribute('aria-label', /3 トラック/);
  await expect(monitor).toHaveAttribute('data-active', 'TR1:60;TR2:52;TR3:36');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  // the chosen view is remembered
  await page.reload();
  await expect(page.getByTestId('channel-monitor')).toBeVisible();
});
