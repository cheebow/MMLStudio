// Phase 4 browser tests: MIDI open -> MML, original/MML playback switch (L45), reconvert, D&D.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { build, cc, off, on, program, tempo, text } from '../helpers/smf-build';

const state = (page: Page) => page.getByTestId('player-state');

const SONG = build(
  1,
  96,
  [tempo(0, 500000), text(0, 0x05, 'la'), text(3840, 0x01, 'end')], // 40 beats = 20.0 s
  [text(0, 0x03, 'Piano'), program(0, 0, 0), on(0, 0, 60, 90), on(0, 0, 64, 90), on(0, 0, 67, 90), off(90, 0, 60), off(0, 0, 64), off(0, 0, 67), cc(6, 0, 64, 127), on(0, 0, 72, 70), off(45, 0, 72), cc(0, 0, 64, 0)],
  [on(0, 9, 36, 110), off(24, 9, 36), on(72, 9, 38, 100), off(24, 9, 38), on(3696, 9, 42, 60), off(24, 9, 42)], // last note ends at 20.0 s
);

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

async function openMidi(page: Page, bytes: Uint8Array = SONG, name = 'song.mid') {
  await page.getByTestId('midi-input').setInputFiles({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) });
}

async function replaceEditor(page: Page, value: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}

test('open MIDI -> fidelity MML, verified, lost events listed', async ({ page }) => {
  await openMidi(page);
  const panel = page.getByTestId('midi-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('roundtrip-status')).toContainText('一致');
  await expect(panel).toContainText('96 → 480');
  await expect(page.getByTestId('lost-events')).toContainText('歌詞 × 1');
  await expect(page.locator('.cm-content')).toContainText("q%450 'n60 n64 n67'%480");
  await expect(page.locator('.cm-content')).toContainText('TR(10) CH(10)');
  await expect(page.getByTestId('doc-name')).toHaveText('song.mml');
  await expect(page.getByText('問題はありません。')).toBeVisible();
  // The tall import panel must not make the whole page scroll (hidden inputs stay inside the side pane).
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  // MIDI export of the converted MML works
  const [mid] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'MIDI書き出し' }).click()]);
  expect(mid.suggestedFilename()).toBe('song.mid');
  expect(readFileSync((await mid.path())!).subarray(0, 4).toString('latin1')).toBe('MThd');
});

test('L45 original MIDI and MML playback switch; editing MML does not change the original', async ({ page }) => {
  await openMidi(page);
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true');

  // MML playback
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.locator('.time')).toContainText('/ 0:20.0');
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10_000 });

  // Original playback
  await page.getByLabel('元 MIDI（変更されません）').check();
  await expect(page.getByText('元 MIDI を再生します')).toBeVisible();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  const originalLength = (await page.locator('.time').textContent())!.split('/')[1].trim();
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10_000 });

  // Edit the MML (make it longer and even invalid): original playback is unaffected.
  await replaceEditor(page, 'TR(1) CH(1) o4 c1 c1 c1 c1 c1 c1 x');
  await expect(page.locator('.diag-error')).toHaveCount(1);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.locator('.time')).toContainText(`/ ${originalLength}`);
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10_000 });

  // Back to MML: the edited (fixed) MML plays with its own length; same SoundFont.
  await replaceEditor(page, 'TR(1) CH(1) o4 c1 c1 c1 c1 c1 c1');
  await page.getByLabel('MML（エディタの内容）').check();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.locator('.time')).toContainText('/ 0:11.8'); // SpessaSynth ends at the last Note Off (q90)
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10_000 });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded');
});

test('reconvert in readable mode asks before discarding edits and keeps a backup', async ({ page }) => {
  await openMidi(page);
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true');
  await replaceEditor(page, '// my edit\nTR(1) CH(1) c');

  await page.getByLabel('変換モード').selectOption('readable');
  await page.getByLabel('量子化単位').selectOption('1/8');
  let asked = '';
  page.once('dialog', async (d) => {
    asked = d.message();
    await d.accept();
  });
  await page.getByRole('button', { name: 'このモードで再変換' }).click();
  await expect(page.getByTestId('roundtrip-status')).toContainText('読みやすさ優先');
  expect(asked).toContain('再変換');
  await expect(page.locator('.cm-content')).toContainText('q100');
  await expect(page.locator('.cm-content')).toContainText("'ceg'");
  await expect(page.getByTestId('quantize-diff')).toBeVisible();

  await page.getByRole('button', { name: '変換前の MML に戻す' }).click();
  await expect(page.locator('.cm-content')).toContainText('// my edit');
});

test('broken MIDI is rejected with a reason; drag & drop opens a MIDI file', async ({ page }) => {
  await openMidi(page, new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 1, 0xe0]), 'type2.mid');
  await expect(page.locator('.messages')).toContainText('Format 2');
  await expect(page.getByTestId('midi-panel')).toHaveCount(0);

  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'dropped.mid', { type: 'audio/midi' }));
    const app = document.querySelector('.app')!;
    app.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    app.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...SONG]);
  await expect(page.getByTestId('midi-panel')).toContainText('dropped.mid');
  await expect(page.getByTestId('roundtrip-status')).toHaveAttribute('data-ok', 'true');
});
