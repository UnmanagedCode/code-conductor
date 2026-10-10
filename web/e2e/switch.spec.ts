import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';

// The two UIs link to each other from their sidebar footers: the old UI at / (and
// /legacy/) offers "Try the new UI", the web UI at /next/ offers "Classic UI".
const isPhone = () => test.info().project.name === 'phone';

// The old UI's controls are static HTML whose listeners public/app.js attaches
// while its module evaluates, after the document has parsed: a click that lands
// first is lost. So each action is retried until the state it drives shows,
// and the drawer toggle — not idempotent — is clicked only while it reads closed.

/** On the phone, the old UI's drawer is open (its toggle's listener ran). */
async function openOldDrawer(page: Page) {
  if (!isPhone()) return;
  const toggle = page.locator('#sidebar-toggle');
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.locator('#sidebar')).toHaveClass(/\bopen\b/, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** The old UI is live: its JS (not just its HTML) ran, so the lens toggle answers. */
async function expectOldUiRunning(page: Page) {
  await openOldDrawer(page);
  const projects = page.locator('.sidebar-lens button[data-lens="projects"]');
  // Choosing a lens is idempotent, so a lost click is simply clicked again.
  await expect(async () => {
    await projects.click();
    await expect(projects).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

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
