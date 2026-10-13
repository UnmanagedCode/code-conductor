// The plugin view's top bar: on drawer viewports the drawer button sits in a bar above the
// plugin's page, never over it, and stays reachable while the start overlay is up; on desktop
// the same bar carries the plugin's name and Dock to side.
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

// Invariant: below md the view has a bar with the drawer button and the plugin's name; the frame starts under it and nothing covers the frame's top-left corner.
/** Drawer viewports: the bar, the frame under it, an uncovered corner, and the button opens the drawer. */
export async function barAboveFrameFlow({ page }: Ctx): Promise<void> {
  test.skip(isDesktop(), 'a desktop has no phone top bar');
  await page.goto(`/#plugin/${PROBE.id}/`);
  await pageLoaded(page);
  const v = view(page);
  const bar = v.locator('header');
  const menu = v.getByRole('button', { name: 'Open sidebar' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
  await expect(bar.getByRole('heading', { name: PROBE.name })).toBeVisible();

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

  const shot = test.info().outputPath('plugin-view.png');
  await page.screenshot({ path: shot });
  await test.info().attach('plugin-view', { path: shot, contentType: 'image/png' });
  await drawerOpensFrom(page, menu);
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

// Invariant: on desktop the view's bar holds the plugin's name and Dock to side, no drawer button, and the frame fills the rest of the view below it.
/** Desktop: the bar with the name and Dock to side, no drawer button, and the frame from the bar's bottom to the view's. */
export async function desktopStripFlow({ page }: Ctx): Promise<void> {
  test.skip(!isDesktop(), 'drawer viewports have the phone bar');
  await page.goto(`/#plugin/${PROBE.id}/`);
  await pageLoaded(page);
  const v = view(page);
  const bar = v.locator('header');
  await expect(v.getByRole('button', { name: 'Open sidebar' })).toHaveCount(0);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('heading', { name: PROBE.name })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Dock to side', exact: true })).toBeVisible();
  const barBox = await boxOf(bar, 'the bar');
  const viewBox = await boxOf(v, 'the view');
  const frameBox = await boxOf(v.locator('iframe:visible'), 'the frame');
  expect(frameBox.y, 'the frame starts below the bar').toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  expect(Math.abs(frameBox.y + frameBox.height - (viewBox.y + viewBox.height)), 'the frame reaches the view\'s bottom edge').toBeLessThanOrEqual(0.5);
}
