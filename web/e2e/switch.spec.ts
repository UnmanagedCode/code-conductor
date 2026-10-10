import { test, expect } from './harness/fixtures.ts';
import { expectOldUiRunning, openOldDrawer } from './parity/ui.ts';

// The two UIs link to each other from their sidebar footers: the old UI at / (and
// /legacy/) offers "Try the new UI", the web UI at /next/ offers "Classic UI".
const isPhone = () => test.info().project.name === 'phone';

test('the old UI links to the new one, and the new one back to the classic UI', async ({ page }) => {
  await page.goto('/');
  await openOldDrawer(page);
  await page.getByRole('link', { name: 'Try the new UI' }).click();

  await expect(page).toHaveURL(/\/next\/$/);
  if (isPhone()) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
  const side = page.locator('[data-sidebar]').last();
  await expect(side.getByRole('tab', { name: 'Projects' })).toBeVisible();
  await side.getByRole('link', { name: 'Classic UI' }).click();

  await expect(page).toHaveURL(/\/legacy\/$/);
  await expect(page.locator('#conversation')).toBeAttached();
  await expectOldUiRunning(page);
});
