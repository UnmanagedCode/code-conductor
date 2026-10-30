// The plugin view's top bar: on drawer viewports the drawer button sits in a bar above the
// plugin's page, never over it, and stays reachable while the start overlay is up; on desktop
// the same bar carries Dock to side. Every viewport's bar holds the app switcher (labelled
// with the plugin's name) and ends in Close plugin.
// The bodies are shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { readProbe } from './harness/pluginProbe.ts';

type Ctx = { page: Page };
type Box = { x: number; y: number; width: number; height: number };

export const PROBE = { id: 'topbar-probe', name: 'Topbar probe', keepAlive: false } as const;

const isDesktop = () => test.info().project.name === 'desktop';
const view = (page: Page) => page.locator('section[data-view="plugin"][aria-hidden="false"]');
const openDrawerRoot = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"] [data-sidebar]');

/** A laid-out box: the hidden desktop column's rects are all zero. */
async function boxOf(l: Locator, what: string): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, `${what} has a box`).not.toBeNull();
  expect(b!.width, `${what} width`).toBeGreaterThan(0);
  expect(b!.height, `${what} height`).toBeGreaterThan(0);
  return b!;
}

/** What `elementFromPoint` finds at a point: the tag, and whether it is `within` (an element in the page matching the selector, or inside it). */
const hitIs = (page: Page, x: number, y: number, selector: string) => page.evaluate(({ x, y, selector }) => {
  const el = document.elementFromPoint(x, y);
  return !!el && !!el.closest(selector);
}, { x, y, selector });

async function pageLoaded(page: Page) {
  await expect.poll(async () => (await readProbe(page, PROBE.id).catch(() => null))?.nonce ?? null, { message: 'the probe page loaded', timeout: 20_000 }).not.toBeNull();
}

async function drawerOpensFrom(page: Page, menu: Locator) {
  await menu.click();
  await expect(openDrawerRoot(page)).toBeVisible();
  await boxOf(openDrawerRoot(page), 'the open drawer');
}

/** A navigation label no phone bar fits on one line. */
const LONG_LABEL = 'A plugin whose navigation label runs far past the width of a phone bar';

/** `GET /api/plugins` (that exact path) answers with the probe's row carrying LONG_LABEL as its nav label. */
async function longLabel(page: Page) {
  await page.route((u) => u.pathname === '/api/plugins', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json() as { rows: { id: string; navLabel?: string }[] };
    await route.fulfill({ response: res, json: { ...body, rows: body.rows.map((r) => (r.id === PROBE.id ? { ...r, navLabel: LONG_LABEL } : r)) } });
  });
}

// Invariant: below md the view has a bar with the drawer button, the app switcher (even with a long name) and Close plugin, each hit at its centre; the frame starts under it, nothing covers the frame's top-left corner, and the drawer then holds a static title, not a second switcher.
/** Drawer viewports: the bar, the frame under it, an uncovered corner, and the button opens the drawer. */
export async function barAboveFrameFlow({ page }: Ctx): Promise<void> {
  test.skip(isDesktop(), 'a desktop has no phone top bar');
  await longLabel(page);
  await page.goto(`/#plugin/${PROBE.id}/`);
  await pageLoaded(page);
  const v = view(page);
  const bar = v.locator('header');
  const menu = v.getByRole('button', { name: 'Open sidebar' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
  const sw = bar.getByRole('button', { name: 'Switch app', exact: true });
  await expect(sw).toBeVisible();
  await expect(sw, 'the switcher reads the plugin').toContainText(LONG_LABEL);

  const barBox = await boxOf(bar, 'the bar');
  const frameBox = await boxOf(v.locator('iframe:visible'), 'the frame');
  const menuBox = await boxOf(menu, 'the drawer button');
  const viewBox = await boxOf(v, 'the view');
  expect(Math.abs(frameBox.y + frameBox.height - (viewBox.y + viewBox.height)), 'the frame reaches the view\'s bottom edge').toBeLessThanOrEqual(0.5);
  expect(frameBox.y, 'the frame starts below the bar').toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  expect(menuBox.x, 'button within the bar (left)').toBeGreaterThanOrEqual(barBox.x - 0.5);
  expect(menuBox.y, 'button within the bar (top)').toBeGreaterThanOrEqual(barBox.y - 0.5);
  expect(menuBox.x + menuBox.width, 'button within the bar (right)').toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
  expect(menuBox.y + menuBox.height, 'button within the bar (bottom)').toBeLessThanOrEqual(barBox.y + barBox.height + 0.5);

  expect(await hitIs(page, frameBox.x + 4, frameBox.y + 4, 'iframe'), 'the frame owns its top-left corner').toBe(true);
  expect(await hitIs(page, menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, 'button[aria-label="Open sidebar"]'), 'the button is hit at its centre').toBe(true);

  const close = bar.getByRole('button', { name: 'Close plugin', exact: true });
  await expect(close).toBeVisible();
  const closeBox = await boxOf(close, 'Close plugin');
  expect(closeBox.x >= barBox.x - 0.5 && closeBox.y >= barBox.y - 0.5 && closeBox.x + closeBox.width <= barBox.x + barBox.width + 0.5 && closeBox.y + closeBox.height <= barBox.y + barBox.height + 0.5, 'Close within the bar').toBe(true);
  expect(await hitIs(page, closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2, 'button[aria-label="Close plugin"]'), 'Close is hit at its centre').toBe(true);

  const swBox = await boxOf(sw, 'the switcher');
  expect(swBox.x >= barBox.x - 0.5 && swBox.y >= barBox.y - 0.5 && swBox.x + swBox.width <= barBox.x + barBox.width + 0.5 && swBox.y + swBox.height <= barBox.y + barBox.height + 0.5, 'the switcher within the bar').toBe(true);
  expect(swBox.x, 'the switcher is right of Open sidebar').toBeGreaterThanOrEqual(menuBox.x + menuBox.width - 0.5);
  expect(swBox.x + swBox.width, 'the switcher is left of Close').toBeLessThanOrEqual(closeBox.x + 0.5);
  expect(await hitIs(page, swBox.x + swBox.width / 2, swBox.y + swBox.height / 2, 'button[aria-label="Switch app"]'), 'the switcher is hit at its centre').toBe(true);

  const shot = test.info().outputPath('plugin-view.png');
  await page.screenshot({ path: shot });
  await test.info().attach('plugin-view', { path: shot, contentType: 'image/png' });
  await drawerOpensFrom(page, menu);
  await expect(openDrawerRoot(page).getByRole('heading', { level: 1 }), 'the drawer\'s title is static').toHaveText('Code Conductor');
  await expect(page.locator('[data-app-switcher]'), 'one switcher in the page').toHaveCount(1);
  await expect(v.locator('[data-app-switcher]'), 'and it is the bar\'s').toHaveCount(1);
}

// Invariant: while the plugin fails to start, the start overlay sits below the bar and the drawer button stays tappable.
/** Drawer viewports: the failed-start overlay starts under the bar and leaves the button reachable. */
export async function overlayBelowBarFlow({ page }: Ctx): Promise<void> {
  test.skip(isDesktop(), 'a desktop has no phone top bar');
  await page.route(`**/api/plugins/${PROBE.id}/status`, (r) => r.fulfill({ json: { state: 'stopped', name: PROBE.name, frontendKeepAlive: false } }));
  await page.route(`**/api/plugins/${PROBE.id}/start`, (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
  await page.goto(`/#plugin/${PROBE.id}/`);
  const v = view(page);
  const overlay = v.locator('[data-plugin-overlay]');
  await expect(overlay.getByRole('button', { name: 'Retry' })).toBeVisible();

  const bar = v.locator('header');
  const menu = v.getByRole('button', { name: 'Open sidebar' });
  await expect(bar, 'the bar is above the overlay').toBeVisible();
  const barBox = await boxOf(bar, 'the bar');
  const overlayBox = await boxOf(overlay, 'the overlay');
  expect(overlayBox.y, 'the overlay starts below the bar').toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  const menuBox = await boxOf(menu, 'the drawer button');
  expect(await hitIs(page, menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, 'button[aria-label="Open sidebar"]'), 'the overlay does not cover the button').toBe(true);

  await drawerOpensFrom(page, menu);
}

// Invariant: on desktop the view's bar holds the app switcher (the plugin's name), Dock to side and Close plugin, no drawer button, and the frame fills the rest of the view below it.
/** Desktop: the bar with the switcher, Dock to side and Close plugin, no drawer button, and the frame from the bar's bottom to the view's. */
export async function desktopStripFlow({ page }: Ctx): Promise<void> {
  test.skip(!isDesktop(), 'drawer viewports have the phone bar');
  await page.goto(`/#plugin/${PROBE.id}/`);
  await pageLoaded(page);
  const v = view(page);
  const bar = v.locator('header');
  await expect(v.getByRole('button', { name: 'Open sidebar' })).toHaveCount(0);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Switch app', exact: true })).toContainText(PROBE.name);
  await expect(bar.getByRole('button', { name: 'Dock to side', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Close plugin', exact: true })).toBeVisible();
  const barBox = await boxOf(bar, 'the bar');
  const viewBox = await boxOf(v, 'the view');
  const frameBox = await boxOf(v.locator('iframe:visible'), 'the frame');
  expect(frameBox.y, 'the frame starts below the bar').toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  expect(Math.abs(frameBox.y + frameBox.height - (viewBox.y + viewBox.height)), 'the frame reaches the view\'s bottom edge').toBeLessThanOrEqual(0.5);
}
