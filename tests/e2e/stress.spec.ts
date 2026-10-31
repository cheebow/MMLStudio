// Phase 5: race conditions and recovery (seek spam, sound bank switching while playing,
// source switching, Worker failure fallback, large documents).
import { expect, test, type Page } from '@playwright/test';
import { build, off, on, tempo } from '../helpers/smf-build';

const state = (page: Page) => page.getByTestId('player-state');
const play = (page: Page) => page.getByRole('button', { name: '再生', exact: true });
const stop = (page: Page) => page.getByRole('button', { name: '停止', exact: true });

// 8 bars of quarter notes at 120 BPM = 16 s
const LONG_MIDI = build(0, 480, [tempo(0, 500000), ...Array.from({ length: 32 }, (_, i) => [on(i === 0 ? 0 : 0, 0, 60 + (i % 12)), off(480, 0, 60 + (i % 12))]).flat()]);
const LONG_MML = 'TR(1) CH(1) @1 o4 l4 ' + 'cdefgab>c<'.repeat(4) + '\nTR(2) CH(10) l8 ' + 'n36 n42 '.repeat(32);

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

async function setEditor(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

test('seek spam while playing and paused keeps a consistent state', async ({ page }) => {
  await setEditor(page, LONG_MML);
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  // Keyboard seeking commits on every keyup (D-011): 40 seeks in quick succession.
  const seek = page.getByLabel('再生位置');
  await seek.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press(i % 3 === 0 ? 'ArrowLeft' : 'ArrowRight');
  await page.keyboard.press('Home');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await expect(state(page)).toHaveAttribute('data-state', 'playing');
  await page.getByRole('button', { name: '一時停止' }).click();
  await seek.fill('9');
  await seek.dispatchEvent('pointerup');
  await expect(page.locator('.time')).toContainText('0:09.0');
  await page.getByRole('button', { name: '再開' }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing');
  await stop(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.time')).toContainText('0:00.0');
});

test('pause / resume / stop spam never leaves playback running after stop', async ({ page }) => {
  await setEditor(page, LONG_MML);
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: '一時停止' }).click();
    await page.getByRole('button', { name: '再開' }).click();
  }
  await stop(page).click();
  await play(page).click();
  await stop(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
  const t1 = await page.locator('.time').textContent();
  await page.waitForTimeout(600);
  await expect(page.locator('.time')).toHaveText(t1!);
});

test('switching the sound bank while playing stops, reloads and can play again', async ({ page, request }) => {
  const sf2 = await (await request.get('soundfonts/GeneralUser-GS.sf2')).body();
  await setEditor(page, LONG_MML);
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByTestId('sf2-input').setInputFiles({ name: 'other.sf2', mimeType: 'application/octet-stream', buffer: sf2 });
  // switch back to the default before the local bank has finished loading: the latest choice wins
  await page.getByRole('button', { name: '標準音源に戻す' }).click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded', { timeout: 60_000 });
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await stop(page).click();
});

test('rapid original / MML source switching while playing', async ({ page }) => {
  await page.getByTestId('midi-input').setInputFiles({ name: 'long.mid', mimeType: 'audio/midi', buffer: Buffer.from(LONG_MIDI) });
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true');
  for (let i = 0; i < 6; i++) {
    await page.getByLabel(i % 2 === 0 ? '元 MIDI（変更されません）' : 'MML（エディタの内容）').check();
    await play(page).click();
    await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  }
  await stop(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
});

test('MIDI import falls back to the main thread when the Worker cannot load', async ({ page }) => {
  await page.route('**/midi-import.worker*', (route) => route.fulfill({ status: 404, body: 'blocked' }));
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.getByTestId('midi-input').setInputFiles({ name: 'long.mid', mimeType: 'audio/midi', buffer: Buffer.from(LONG_MIDI) });
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true', { timeout: 30_000 });
  expect(warnings.join('\n')).toContain('main thread');
});

test('a large (~1 MB) MML stays editable and compiles', async ({ page }) => {
  // 8 tracks x 11,250 notes (l64) with explicit velocities: ~810 kB, 90,000 notes, within all limits.
  let big = '';
  for (let t = 1; t <= 8; t++) {
    big += `TR(${t}) CH(${t}) l64\n`;
    for (let i = 0; i < 1125; i++) big += 'v100 n60 v90 n62 v80 n64 v70 n65 v60 n67 v50 n69 v40 n71 v30 n72 v20 n74 v10 n76\n';
  }
  await page.getByTestId('mml-input').setInputFiles({ name: 'big.mml', mimeType: 'text/plain', buffer: Buffer.from(big) });
  await expect(page.getByTestId('doc-name')).toHaveText('big.mml', { timeout: 30_000 });
  await expect(page.locator('.track-table tbody tr')).toHaveCount(8, { timeout: 30_000 });
  await expect(page.getByText('問題はありません。')).toBeVisible();
  // edit at the end: an error appears, then disappears again
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' x');
  await expect(page.locator('.diag-error')).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press('Backspace');
  await expect(page.locator('.diag-error')).toHaveCount(0, { timeout: 15_000 });
});

test('a network failure while downloading the SoundFont can be retried', async ({ page }) => {
  await page.route('**/soundfonts/GeneralUser-GS.sf2', (route) => route.abort('connectionreset'));
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'error');
  await expect(page.locator('.messages')).toContainText('ネットワーク');
  await page.unroute('**/soundfonts/GeneralUser-GS.sf2');
  await play(page).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded');
});
