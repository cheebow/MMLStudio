// SPEC 6.4: mute / solo of the playback, player mode (MIDI player use).
import { expect, test, type Page } from '@playwright/test';
import { menu } from './menu';
import { build, off, on, program, tempo } from '../helpers/smf-build';

const state = (page: Page) => page.getByTestId('player-state');

// 2 channels + drums, 4 s
const SONG = build(
  1,
  480,
  [tempo(0, 500000)],
  [program(0, 0, 0), on(0, 0, 60, 90), off(3840, 0, 60)],
  [program(0, 1, 48), on(0, 1, 67, 90), off(3840, 1, 67)],
  [on(0, 9, 36, 110), off(3840, 9, 36)],
);

async function drop(page: Page, bytes: Uint8Array, name: string) {
  await page.evaluate(
    ({ bytes, name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'audio/midi' }));
      const app = document.querySelector('.app')!;
      app.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      app.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { bytes: [...bytes], name },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('mute and solo silence channels, during playback too, and survive recompiles', async ({ page }) => {
  const roll = page.getByTestId('roll-panel');
  await expect(roll).toHaveAttribute('data-silenced', '');
  await page.getByRole('button', { name: 'TR2 をミュート' }).click();
  await expect(page.getByRole('button', { name: 'TR2 をミュート' })).toHaveAttribute('aria-pressed', 'true');
  await expect(roll).toHaveAttribute('data-silenced', '1');

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: 'TR3 をソロ' }).click();
  // solo of the drum track (CH10): every other channel is silenced
  await expect(roll).toHaveAttribute('data-silenced', '0,1,2,3,4,5,6,7,8,10,11,12,13,14,15');
  await expect(state(page)).toHaveAttribute('data-state', 'playing');

  // editing the MML keeps the choice (by track name)
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n// edit');
  await page.waitForTimeout(600);
  await expect(page.getByRole('button', { name: 'TR3 をソロ' })).toHaveAttribute('aria-pressed', 'true');

  await menu(page, '表示', 'ミュート・ソロを解除');
  await expect(roll).toHaveAttribute('data-silenced', '');
  await expect(page.getByRole('button', { name: 'TR2 をミュート' })).toHaveAttribute('aria-pressed', 'false');
});

test('player mode hides the editor, plays a dropped MIDI as it is, and is remembered', async ({ page }) => {
  await page.getByRole('button', { name: '▶ プレーヤーモード' }).click();
  await expect(page.locator('.cm-editor')).toBeHidden();
  await expect(page.locator('.side-pane')).toBeHidden();
  await expect(page.getByTestId('roll-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '演奏表示を閉じる' })).toHaveCount(0);
  const rollBox = await page.getByTestId('roll-panel').boundingBox();
  expect(rollBox!.height).toBeGreaterThan(300);

  // first drop: audio is not unlocked yet (a drop is not a user gesture), so it waits for 再生
  await drop(page, SONG, 'first.mid');
  await expect(page.getByTestId('doc-name')).toHaveText('first.mid');
  await expect(page.getByRole('radio', { name: '元 MIDI' })).toBeChecked();
  await expect(page.locator('.track-rail')).toContainText('CH10');
  await expect(state(page)).not.toHaveAttribute('data-state', 'playing');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await expect(page.locator('.messages')).toContainText('元 MIDI を再生します');

  // CH muting works on the original MIDI's channels
  await page.getByRole('button', { name: 'CH2 をミュート' }).click();
  await expect(page.getByTestId('roll-panel')).toHaveAttribute('data-silenced', '1');

  // second drop while audio is unlocked: starts playing by itself
  await drop(page, SONG, 'second.mid');
  await expect(page.getByTestId('doc-name')).toHaveText('second.mid');
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });

  await page.getByRole('radio', { name: '変換した MML' }).check();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');

  await page.reload();
  await expect(page.getByRole('button', { name: '✎ エディタに戻る' })).toBeVisible();
  await menu(page, '表示', 'エディタに戻る');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('.side-pane')).toBeVisible();
});
