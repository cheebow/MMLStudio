import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const state = (page: Page) => page.getByTestId('player-state');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

async function replaceEditor(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

test('open .mml, save .mml, export .mid', async ({ page }) => {
  await page.getByTestId('mml-input').setInputFiles({
    name: 'my-song.mml',
    mimeType: 'text/plain',
    buffer: Buffer.from('TR(1) CH(1) @1 o4 l8 cdefgab>c\n', 'utf8'),
  });
  await expect(page.locator('.cm-content')).toContainText('cdefgab>c');
  await expect(page.getByTestId('doc-name')).toHaveText('my-song.mml');

  const [mml] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'MML保存' }).click()]);
  expect(mml.suggestedFilename()).toBe('my-song.mml');
  expect(readFileSync((await mml.path())!, 'utf8')).toBe('TR(1) CH(1) @1 o4 l8 cdefgab>c\n');

  const [mid] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'MIDI書き出し' }).click()]);
  expect(mid.suggestedFilename()).toBe('my-song.mid');
  const bytes = readFileSync((await mid.path())!);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd');
  expect(bytes.readUInt16BE(8)).toBe(1); // format 1
  expect(bytes.readUInt16BE(12)).toBe(480); // PPQ
});

test('MIDI export is disabled while the MML has errors', async ({ page }) => {
  await replaceEditor(page, 'c4 x');
  await expect(page.getByRole('button', { name: 'MIDI書き出し' })).toBeDisabled();
  await replaceEditor(page, 'c4');
  await expect(page.getByRole('button', { name: 'MIDI書き出し' })).toBeEnabled();
});

test('unsaved edits require confirmation before opening another file', async ({ page }) => {
  await replaceEditor(page, 'o5 c d e');
  let asked = '';
  page.once('dialog', async (d) => {
    asked = d.message();
    await d.dismiss();
  });
  await page.getByLabel('サンプルを読み込む').selectOption('scale');
  expect(asked).toContain('破棄');
  await expect(page.locator('.cm-content')).toHaveText('o5 c d e');

  page.once('dialog', (d) => d.accept());
  await page.getByLabel('サンプルを読み込む').selectOption('scale');
  await expect(page.locator('.cm-content')).toContainText('cdef gab>c');
});

test('draft is restored after reload', async ({ page }) => {
  await replaceEditor(page, '// draft test\nTR(1) o4 c e g');
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('// draft test');
  await expect(page.getByText('前回の下書きを復元しました。')).toBeVisible();
});

test('app still works when localStorage throws', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('TR(3) CH(10)');
  await replaceEditor(page, 'c d e');
  await page.waitForTimeout(1000);
  await expect(page.locator('.diag-error')).toHaveCount(0);
});

test('instrument list search and help / license dialogs', async ({ page }) => {
  await page.getByRole('button', { name: '音色一覧' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('音色を検索').fill('string ensemble');
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  await expect(dialog.locator('tbody tr').first()).toContainText('@49');
  // In a search field the first Esc clears the text; the second closes the dialog.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'ヘルプ' }).click();
  await expect(page.getByRole('dialog')).toContainText('サクラ MML と完全互換ではありません');
  await page.getByRole('button', { name: '閉じる' }).click();

  await page.getByRole('button', { name: '音源情報・ライセンス' }).click();
  await expect(page.getByRole('dialog')).toContainText('GeneralUser GS v2.0.3');
  await expect(page.getByRole('dialog').locator('.license-text').first()).toContainText('License v2.0');
  await expect(page.getByRole('dialog').locator('.license-text').nth(1)).toContainText('Apache License');
});

test('invalid local SF2 shows an error, then switching back to the default works and plays', async ({ page }) => {
  await page.getByTestId('sf2-input').setInputFiles({ name: 'broken.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from('not a soundfont') });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'error', { timeout: 30_000 });
  await expect(state(page)).toHaveAttribute('data-state', 'error');

  await page.getByRole('button', { name: '標準音源に戻す' }).click();
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded', { timeout: 30_000 });
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
});

test('local SF2 (copy of the bundled bank) can be loaded and used', async ({ page, request }) => {
  const sf2 = await (await request.get('soundfonts/GeneralUser-GS.sf2')).body();
  await page.getByTestId('sf2-input').setInputFiles({ name: 'my-bank.sf2', mimeType: 'application/octet-stream', buffer: sf2 });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded', { timeout: 60_000 });
  await expect(page.locator('.sf-current strong')).toHaveText('my-bank.sf2');
  await expect(page.locator('.msg-warning')).toHaveCount(0); // full GM coverage
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
});

test('rapid play clicks create a single playback', async ({ page }) => {
  const play = page.getByRole('button', { name: '再生', exact: true });
  await play.click();
  await play.click({ force: true }).catch(() => undefined);
  await play.click({ force: true }).catch(() => undefined);
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'ready');
});

test('missing default SoundFont (404) is reported with guidance and a local SF2 still works', async ({ page, request }) => {
  const sf2 = await (await request.get('soundfonts/GeneralUser-GS.sf2')).body();
  await page.route('**/soundfonts/GeneralUser-GS.sf2', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.locator('.messages')).toContainText('404');
  await expect(page.locator('.messages')).toContainText('ローカル SF2');

  await page.getByTestId('sf2-input').setInputFiles({ name: 'local.sf2', mimeType: 'application/octet-stream', buffer: sf2 });
  await expect(page.getByTestId('soundfont-status')).toHaveAttribute('data-status', 'loaded', { timeout: 60_000 });
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(state(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
});

test('クリア empties the editor (confirming unsaved edits) and the previous content can be restored', async ({ page }) => {
  await replaceEditor(page, 'TR(1) CH(1) o4 c d e');
  await expect(page.getByTestId('doc-name')).toContainText('●');
  // cancel keeps the text
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('o4 c d e');
  // accept clears it
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('');
  await expect(page.getByTestId('doc-name')).toHaveText('無題');
  await expect(page.getByText('演奏トラックはまだありません。')).toBeVisible();
  await expect(page.getByText('エディタをクリアしました。')).toBeVisible();
  // typing works right away (the editor has focus)
  await page.keyboard.insertText('TR(1) CH(1) g');
  await expect(page.locator('.cm-content')).toHaveText('TR(1) CH(1) g');
  // restore
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  await page.getByRole('button', { name: 'クリア前の MML に戻す' }).click();
  await expect(page.locator('.cm-content')).toHaveText('TR(1) CH(1) g');
  await expect(page.getByText('クリア前の MML に戻しました。')).toBeVisible();
});

test('クリア without unsaved edits does not ask for confirmation', async ({ page }) => {
  let asked = false;
  page.on('dialog', (d) => {
    asked = true;
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('');
  expect(asked).toBe(false);
});
