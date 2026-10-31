import type { Page } from '@playwright/test';

/** Opens a header menu and chooses an item (SPEC 6.2). */
export async function menu(page: Page, menuName: string, item: string): Promise<void> {
  await page.getByRole('navigation', { name: 'メニュー' }).getByRole('button', { name: menuName, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
