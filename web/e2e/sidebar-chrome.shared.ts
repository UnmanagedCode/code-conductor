// The sidebar's two forms: a drawer on drawer viewports (phone, android), a fixed column on desktop.
// The bodies are shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
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
  await page.goto(`/#session=${a}`);
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
  await page.goto(`/#session=${a}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const column = page.locator('[data-sidebar]:visible');
  await expect(column).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true })).toHaveCount(0);

  await (await next.sessionRow(page, project, b)).click();
  await expect(page).toHaveURL(new RegExp(`#session=${b}`));
  await expect(column).toBeVisible();
  await expect(openSheet(page)).toHaveCount(0);
}

// Invariant: the header's controls share one line and end on the content column's right edge; on a drawer the close × is one of them.
/** The sidebar header's controls line up: one vertical centre, one right edge with the Conduct button. */
export async function headerAlignFlow({ page, cc }: Ctx): Promise<void> {
  const { sessionId: sid } = await spawnSession(cc, `e2e-chrome-align-${test.info().project.name}`);
  await page.goto(`/#session=${sid}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await next.openSidebar(page);
  const root = isDesktop() ? page.locator('[data-sidebar]:visible') : openSheet(page);
  await expect(root).toBeVisible();
  const sidebar = isDesktop() ? root : root.locator('[data-sidebar]');
  // Measure after the slide-in, not mid-animation.
  await root.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  const rect = async (loc: Locator, name: string) => {
    const b = await loc.boundingBox();
    expect(b, name).not.toBeNull();
    expect(b!.width, name).toBeGreaterThan(0);
    expect(b!.height, name).toBeGreaterThan(0);
    return { midY: b!.y + b!.height / 2, right: b!.x + b!.width };
  };
  const settings = await rect(sidebar.getByRole('button', { name: 'Settings', exact: true }), 'settings');
  const bell = await rect(sidebar.getByRole('button', { name: /^Turn notifications (on|off)$/ }), 'bell');
  const conduct = await rect(sidebar.locator('[data-conduct]'), 'conduct');
  const close = root.getByRole('button', { name: 'Close', exact: true });

  expect(Math.abs(settings.midY - bell.midY), '⚙ and 🔔 on one line').toBeLessThanOrEqual(1);
  if (isDesktop()) {
    await expect(close).toHaveCount(0);
    expect(Math.abs(settings.right - conduct.right), "⚙ ends on the content column's right edge").toBeLessThanOrEqual(1);
    return;
  }
  const x = await rect(close, 'close');
  expect(Math.abs(x.midY - settings.midY), "× on the header controls' line").toBeLessThanOrEqual(1);
  expect(Math.abs(x.midY - bell.midY), '× on the bell\'s line').toBeLessThanOrEqual(1);
  expect(Math.abs(x.right - conduct.right), "× ends on the content column's right edge").toBeLessThanOrEqual(1);
}
