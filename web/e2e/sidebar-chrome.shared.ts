// The sidebar's two forms under /next/: a drawer on drawer viewports (phone, android), a fixed column on desktop.
// The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };

const isDesktop = () => test.info().project.name === 'desktop';
const openSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]');

async function twoSessions(cc: Ctx['cc']) {
  const project = `e2e-chrome-${test.info().project.name}`;
  const a = await spawnSession(cc, project);
  const b = await spawnSession(cc, project);
  return { project, a: a.sessionId, b: b.sessionId };
}

// Invariant: the drawer opens from its toggle and closes from the scrim, Escape and navigating.
/** Drawer viewports: the toggle opens it; the scrim, Escape and navigating to a session close it. */
export async function drawerFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(isDesktop(), 'a desktop has a column, not a drawer');
  const { project, a, b } = await twoSessions(cc);
  await page.goto(`/next/#session=${a}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(openSheet(page)).toHaveCount(0);

  await next.openSidebar(page);
  await expect(openSheet(page)).toBeVisible();

  // A press on the scrim, outside the drawer, closes it.
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width - 4, Math.round(vp.height / 2));
  await expect(openSheet(page)).toHaveCount(0);

  await next.openSidebar(page);
  await page.keyboard.press('Escape');
  await expect(openSheet(page)).toHaveCount(0);

  // Choosing a session in the drawer navigates there and closes it.
  await next.openSidebar(page);
  await (await next.sessionRow(page, project, b)).click();
  await expect(page).toHaveURL(new RegExp(`#session=${b}`));
  await expect(openSheet(page)).toHaveCount(0);
}

// Invariant: the desktop column has no toggle and is never collapsed by navigating.
/** Desktop: no drawer toggle, and navigating to a session never collapses the column. */
export async function desktopColumnFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(!isDesktop(), 'drawer viewports have no fixed column');
  const { project, a, b } = await twoSessions(cc);
  await page.goto(`/next/#session=${a}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const column = page.locator('[data-sidebar]:visible');
  await expect(column).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true })).toHaveCount(0);

  await (await next.sessionRow(page, project, b)).click();
  await expect(page).toHaveURL(new RegExp(`#session=${b}`));
  await expect(column).toBeVisible();
  await expect(openSheet(page)).toHaveCount(0);
}
