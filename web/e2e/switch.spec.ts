import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';

// The two UIs link to each other from their sidebar footers: the old UI at / (and
// /legacy/) offers "Try the new UI", the web UI at /next/ offers "Classic UI".
const isPhone = () => test.info().project.name === 'phone';

/** The old UI is live: its JS (not just its HTML) ran, so the lens toggle answers. */
async function expectOldUiRunning(page: Page) {
  if (isPhone()) await page.locator('#sidebar-toggle').click();
  const projects = page.locator('.sidebar-lens button[data-lens="projects"]');
  await projects.click();
  await expect(projects).toHaveAttribute('aria-pressed', 'true');
}

test('the old UI links to the new one, and the new one back to the classic UI', async ({ page }) => {
  await page.goto('/');
  if (isPhone()) await page.locator('#sidebar-toggle').click();
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
