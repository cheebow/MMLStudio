// Phase 6a: convert PC-9801 PLAY data pasted into the dialog, apply it to the editor and play.
import { expect, test } from '@playwright/test';

const PC98 = `"0001","テスト曲",2,3,6
01 "MBQ7L8@46T140@V110Z0,3","MBL4@13T140V12","R1"
02 "O5CDEFG4.R8","O3C2G2","O2C1"
03 "{CDE}4C..C32>C2","O3F2G2","O2F1"
"0002","二曲目",1,1,1
01 "T120O4CDEC"`;

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('paste PC-9801 data, pick a song, convert, apply and play; the previous MML can be restored', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('変換する MML').fill(PC98);
  await expect(dialog).toContainText('自動判定: PC-9801 PLAY 文');
  await expect(dialog.getByLabel('変換する曲').locator('option')).toHaveCount(2);
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('3 パート');
  await expect(dialog.getByTestId('dialect-warnings')).toContainText('Z は意味が確認できない');
  await expect(dialog.getByLabel('変換結果のプレビュー')).toContainText('// @46 HARPSIC → @7 Harpsichord');

  await dialog.getByRole('button', { name: 'エディタに反映' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('PC-9801 PLAY から変換: テスト曲');
  await expect(page.getByTestId('doc-name')).toContainText('テスト曲.mml');
  await expect(page.locator('.track-table tbody tr')).toHaveCount(3);
  await expect(page.getByText('問題はありません。')).toBeVisible();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('player-state')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();

  // the second song
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  await dialog.getByLabel('変換する MML').fill(PC98);
  await dialog.getByLabel('変換する曲').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('1 パート・4 音');
  page.once('dialog', (d) => d.accept());
  await dialog.getByRole('button', { name: 'エディタに反映' }).click();
  await expect(page.locator('.cm-content')).toContainText('二曲目');

  await page.getByRole('button', { name: '変換前の MML に戻す' }).click();
  await expect(page.locator('.cm-content')).toContainText('テスト曲');
});

test('conversion errors are shown with line and column; nothing is applied', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('変換する MML').fill('10 "CDX"\n20 GOTO 10');
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-errors')).toContainText('2行4列');
  await expect(dialog.getByRole('button', { name: 'エディタに反映' })).toHaveCount(0);
});

test('picosakura (Japanese MML) is detected, converted, applied and played', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('変換する MML').fill('曲名{"ドレミの歌"}\nテンポ１２０\nトラック１ 音色１ 音階５ 八分音符\nドレミファソーラシ 「ドミソ」４\nトラック２ 音色３３ 音階３ ド２ ソ２');
  await expect(dialog).toContainText('自動判定: picosakura');
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('2 トラック');
  await expect(dialog.getByLabel('変換結果のプレビュー')).toContainText('picosakura から変換: ドレミの歌');
  await dialog.getByRole('button', { name: 'エディタに反映' }).click();
  await expect(page.getByTestId('doc-name')).toContainText('ドレミの歌.mml');
  await expect(page.getByText('問題はありません。')).toBeVisible();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('player-state')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
});

test('picosakura programs show the MIDI export hint; best-effort mode skips what cannot be converted', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('方言').selectOption('sakura');
  await dialog.getByLabel('変換する MML').fill('TR 1\nInclude(delay.h) For(Int I = 0; I < 4; I++){ c }\nMidiDelay({d},8,!2)');
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-errors')).toContainText('2行1列');
  await expect(dialog.getByTestId('dialect-errors')).toContainText('picosakura も Include に対応していない');
  await expect(dialog.getByTestId('dialect-errors')).toContainText('近似変換');

  // best-effort: Include and the unknown MidiDelay are skipped with warnings; For is interpreted
  await dialog.getByLabel('変換できない命令はスキップする（近似変換）').check();
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('1 トラック・5 音');
  await expect(dialog.getByTestId('dialect-status')).toContainText('近似変換');
  await expect(dialog.getByTestId('dialect-approximate')).toBeVisible();
  await expect(dialog.getByTestId('dialect-warnings')).toContainText('Include');
  await expect(dialog.getByTestId('dialect-warnings')).toContainText('MidiDelay');
  await dialog.getByRole('button', { name: 'エディタに反映' }).click();
  await expect(page.getByText('問題はありません。')).toBeVisible();
});

test('a Shift_JIS text file (Sakura board download) is read and converted', async ({ page }) => {
  // "曲名{"テスト"}\nトラック１ ドレミ" in Shift_JIS
  const sjis = Buffer.from([
    0x8b, 0xc8, 0x96, 0xbc, 0x7b, 0x22, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x22, 0x7d, 0x0d, 0x0a, 0x83, 0x67, 0x83, 0x89, 0x83, 0x62, 0x83, 0x4e,
    0x82, 0x50, 0x20, 0x83, 0x68, 0x83, 0x8c, 0x83, 0x7e,
  ]);
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('dialect-file').setInputFiles({ name: 'sakura.mml', mimeType: 'text/plain', buffer: sjis });
  await expect(dialog.getByTestId('dialect-file-note')).toContainText('Shift_JIS');
  await expect(dialog.getByLabel('変換する MML')).toHaveValue(/トラック１ ドレミ/);
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('1 トラック・3 音');
});

test('an MSX-BASIC program is detected, converted, applied and played', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('変換する MML').fill(`10 ' テストの曲
20 CALL MUSIC
30 A$="T140@16O5L8CDEFGAB>C":B$="O3L2CGCG"
40 PLAY #2,A$,"@33"+B$,"","B8H8S8H8B8H8S8H8","O4L1C"
50 GOTO 40`);
  await expect(dialog).toContainText('自動判定: MSX-BASIC');
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('4 パート');
  await expect(dialog.getByTestId('dialect-warnings')).toContainText('1 回だけ演奏');
  await expect(dialog.getByLabel('変換結果のプレビュー')).toContainText('MSX-BASIC PLAY から変換: テストの曲');
  await dialog.getByRole('button', { name: 'エディタに反映' }).click();
  await expect(page.getByText('問題はありません。')).toBeVisible();
  await expect(page.locator('.track-table tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('player-state')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
});

test('a PC-8801 CMD PLAY program is detected and converted', async ({ page }) => {
  await page.getByRole('button', { name: '他の MML から変換' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('変換する MML').fill('10 S=2:T=13\n20 CMD PLAY #S,"@=T;T120O4L8CDEFG","@4O2L2CG",,"V10O5C1"');
  await expect(dialog).toContainText('自動判定: PC-8801');
  await dialog.getByRole('button', { name: '変換', exact: true }).click();
  await expect(dialog.getByTestId('dialect-status')).toContainText('3 パート');
  await expect(dialog.getByLabel('変換結果のプレビュー')).toContainText('// @13 PIANO → @1 Acoustic Grand Piano');
});
