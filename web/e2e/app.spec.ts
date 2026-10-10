import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';

const isPhone = () => test.info().project.name === 'phone';

/** On a phone the sidebar lives in a drawer; open it before using it. */
async function sidebar(page: Page) {
  if (isPhone()) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
  return page.locator('[data-sidebar]').last();
}

test('create a project from the sidebar and start a session in it', async ({ page }) => {
  const name = `e2e-proj-${test.info().project.name}`;
  await page.goto('/next/');
  let side = await sidebar(page);
  await side.getByRole('tab', { name: 'Projects' }).click();
  await side.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'New project' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New project' })).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  // A project with no scaffold directive closes the dialog on success.
  await expect(dialog).toBeHidden();

  side = await sidebar(page);
  const row = side.locator(`[data-project-row="${name}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: 'New session' }).click();

  const spawn = page.getByRole('dialog');
  await expect(spawn.getByRole('heading', { name: 'New session' })).toBeVisible();
  await spawn.getByRole('button', { name: 'Start session' }).click();
  await expect(page.locator('[data-session-header]')).toContainText(name);
  await expect(page.locator('#composer-input')).toBeEnabled();
});

test('Conduct starts a conductor session straight away', async ({ page }) => {
  await page.goto('/next/');
  if (isPhone()) {
    await page.getByRole('button', { name: 'Start conducting' }).click();
  } else {
    await page.locator('[data-sidebar]').getByRole('button', { name: /^Conduct/ }).click();
  }
  await expect(page.locator('[data-session-header]')).toBeVisible();
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(page).toHaveURL(/#session=/);
});

test('Settings opens from the sidebar, switches sections, and Back returns', async ({ page }) => {
  await page.goto('/next/');
  const side = await sidebar(page);
  await side.getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#settings/);
  await expect(page.getByRole('heading', { name: 'Models', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: 'Conventions' }).or(page.getByRole('button', { name: 'Conventions' })).first().click();
  await expect(page).toHaveURL(/#settings\/conventions/);
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page).not.toHaveURL(/#settings/);
});

test('the costs view opens from the sidebar menu and Escape closes it', async ({ page }) => {
  await page.goto('/next/');
  const side = await sidebar(page);
  await side.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: /Costs/ }).click();
  await expect(page).toHaveURL(/#costs/);
  await expect(page.getByText('Spend by project, model and day')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/#costs/);
});
