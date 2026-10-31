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
