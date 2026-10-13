// The plugin dock in a real browser, with two probe plugins (one keep-alive,
// one plain): the desktop column right of the session whose width is its mode
// (an icon rail, a split beside the transcript, the full view), its handle's
// drag, keys and snaps, a window too narrow for it, a reload, the session width
// presets beside it, and the phone layout without it. A reload of a probe page
// makes a new nonce, so every "same page" check fails on one. The bodies are
// shared by the spec file; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, spawnSession } from './harness/api.ts';
import { installProbePlugin, probeFrame, readProbe, type Probe, type ProbePlugin } from './harness/pluginProbe.ts';
import { next } from './flows/ui.ts';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH } from '../src/features/views/dockLayout.ts';
import { RESIZE_KEY_STEP } from '../src/lib/useResizableWidth.ts';

type Args = { page: Page; cc: Cc };
type Box = { x: number; y: number; width: number; height: number };

export const KEEP: ProbePlugin = { id: 'dock-keep', name: 'Dock keep', keepAlive: true };
export const PLAIN: ProbePlugin = { id: 'dock-plain', name: 'Dock plain', keepAlive: false };
// DOCK_STORAGE_KEY (web/src/features/views/dock.ts).
const DOCK_KEY = 'code-conductor:plugin-dock';
// SESSION_COLUMN_MAX_W (web/src/app/sessionWidth.ts): max-w-3xl and max-w-5xl.
const PRESET_MAX = [['Normal', 768], ['Wide', 1024]] as const;
const W = 520;

/** Installs both probe plugins on this spec's cc. */
export async function installProbes(cc: Cc): Promise<void> {
  for (const p of [KEEP, PLAIN]) await installProbePlugin(cc, p);
}

const isDesktop = () => test.info().project.name === 'desktop';
const desktopOnly = () => test.skip(!isDesktop(), 'the dock is a desktop-layout feature');

const column = (page: Page) => page.locator('[data-plugin-column]');
const section = (page: Page) => page.locator('section[data-view="plugin"]');
const rail = (page: Page) => page.locator('nav[aria-label="Plugin dock"]');
const railApp = (page: Page, p: ProbePlugin) => rail(page).locator(`[data-rail-app="${p.id}"]`);
const railControl = (page: Page, label: string) => rail(page).getByRole('button', { name: label, exact: true });
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize plugin dock' });
const main = (page: Page) => page.locator('main').first();
const historyLength = (page: Page) => page.evaluate(() => history.length);
const valueNow = async (page: Page) => Number(await handle(page).getAttribute('aria-valuenow'));
const framePath = (page: Page, id: string) => {
  const f = probeFrame(page, id);
  return f ? new URL(f.url()).pathname : null;
};

async function boxOf(l: Locator, what: string): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, `${what} has a box`).not.toBeNull();
  return b!;
}
const right = (b: Box) => b.x + b.width;

/** A session of its own, open, with the rail listing both probes. */
async function onSession(page: Page, cc: Cc, flow: string): Promise<string> {
  const { sessionId } = await spawnSession(cc, `dock-${flow}-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  if (isDesktop()) {
    await expect(railApp(page, KEEP)).toBeVisible();
    await expect(railApp(page, PLAIN)).toBeVisible();
  }
  return sessionId;
}

/** Waits until plugin `id`'s page answers, and returns its counters. */
async function loaded(page: Page, id: string, what: string): Promise<Probe> {
  await expect.poll(async () => (await readProbe(page, id).catch(() => null))?.nonce ?? null, { message: `${what}: ${id}'s page loaded`, timeout: 20_000 }).not.toBeNull();
  return (await readProbe(page, id))!;
}

/** Split: the plugin section shown beside the session. */
async function expectSplit(page: Page, what: string) {
  await expect(section(page), `${what}: the plugin section`).toBeVisible();
  await expect(main(page), `${what}: beside the session`).toBeVisible();
}
/** Rail: the strip alone, no section. */
async function expectRail(page: Page, what: string) {
  await expect(rail(page), `${what}: the rail`).toBeVisible();
  await expect(section(page), `${what}: no plugin section`).toBeHidden();
}

/** Escape with the pointer clear of every tooltip (a closing tooltip takes the Escape). */
async function escape(page: Page) {
  await page.mouse.move(10, 450);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
}

/** A real mouse drag of the dock handle by `dx` px, from its centre. */
async function dragHandle(page: Page, dx: number) {
  const h = await boxOf(handle(page), 'the dock handle');
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** Docks `p` open in split at W, by its icon then a drag. */
async function dockAtW(page: Page, p: ProbePlugin) {
  await railApp(page, p).click();
  await expectSplit(page, `fixture check: ${p.name} docked`);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(DOCK_PANEL_DEFAULT_WIDTH));
  await dragHandle(page, DOCK_PANEL_DEFAULT_WIDTH - W);
  await expect(handle(page), 'fixture check: docked at W').toHaveAttribute('aria-valuenow', String(W));
}

// ── flows ────────────────────────────────────────────────────────────────

export async function railGeometryFlow({ page, cc }: Args): Promise<void> {
  // Invariant (1, 2, 7): the rail is the column's strip at the viewport's right edge with the session right beside it; docking an app opens split at the default width beside the session, with no route or history change.
  desktopOnly();
  await onSession(page, cc, 'geometry');
  const viewport = page.viewportSize()!;
  const r = await boxOf(rail(page), 'the rail');
  expect(Math.abs(right(r) - viewport.width), 'the rail ends at the viewport edge').toBeLessThanOrEqual(0.5);
  expect(Math.abs(r.width - DOCK_RAIL_WIDTH), 'the rail width').toBeLessThanOrEqual(0.5);
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - (await boxOf(column(page), 'the column')).x), 'the session meets the rail').toBeLessThanOrEqual(0.5);
  const entries = await historyLength(page);

  await railApp(page, PLAIN).click();
  await expectSplit(page, 'docked');
  const s = await boxOf(section(page), 'the section');
  expect(Math.abs(s.width - DOCK_PANEL_DEFAULT_WIDTH), 'split at the default width').toBeLessThanOrEqual(1);
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - (await boxOf(column(page), 'the column')).x), 'the session meets the column').toBeLessThanOrEqual(0.5);
  await expect(page).toHaveURL(/#session=/);
  expect(await historyLength(page), 'no history entry').toBe(entries);
}

/** Split → full → split → (switcher) full → split for probe `p`, all one page load. */
export function noReloadFlow(p: ProbePlugin) {
  return async ({ page, cc }: Args): Promise<void> => {
    // Invariant (4, 5, 6): moving between split and the full view — Expand, Escape, the switcher, Dock to side — never reloads the plugin's page.
    desktopOnly();
    await onSession(page, cc, `noreload-${p.id}`);
    await railApp(page, p).click();
    await expectSplit(page, 'docked');
    const { nonce } = await loaded(page, p.id, 'docked');

    await railControl(page, 'Expand to full view').click();
    await expect(page).toHaveURL(new RegExp(`#plugin/${p.id}/$`));
    await expect(main(page), 'the session view is gone').toHaveCount(0);
    expect((await readProbe(page, p.id))?.nonce, 'expanded: the same page').toBe(nonce);

    await escape(page);
    await expect(page).toHaveURL(/#session=/);
    await expectSplit(page, 'Escape from full');
    expect((await readProbe(page, p.id))?.nonce, 'back in split: the same page').toBe(nonce);

    await next.openPlugin(page, p.id);
    await expect(section(page)).toBeVisible();
    expect((await readProbe(page, p.id))?.nonce, 'the switcher\'s full view: the same page').toBe(nonce);

    await railControl(page, 'Dock to side').click();
    await expect(page).toHaveURL(/#session=/);
    await expectSplit(page, 'docked from full');
    expect((await readProbe(page, p.id))?.nonce, 'docked again: the same page').toBe(nonce);
  };
}

export async function dragFlow({ page, cc }: Args): Promise<void> {
  // Invariant (3): a drag keeps working while the pointer crosses the plugin's iframe (pointer capture carries it in Chromium; this does not show the body[data-resizing] rule is needed), snaps to the rail below the minimum and to the full view (one history entry) past the transcript limit, reopens from the rail, and a double-click toggles rail ↔ the width it had.
  desktopOnly();
  await onSession(page, cc, 'drag');
  await dockAtW(page, PLAIN);
  await loaded(page, PLAIN.id, 'docked');

  await dragHandle(page, 150);
  await expect(handle(page), 'dragged right, crossing the iframe').toHaveAttribute('aria-valuenow', String(W - 150));
  expect(Math.abs((await boxOf(section(page), 'the section')).width - (W - 150)), 'the section follows').toBeLessThanOrEqual(1);

  expect(W - 150 - 200, 'fixture check: the next drag ends below the minimum').toBeLessThan(DOCK_PANEL_MIN_WIDTH);
  await dragHandle(page, 200);
  await expectRail(page, 'dragged below the minimum');

  await dragHandle(page, -450);
  await expectSplit(page, 'dragged open from the rail');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '450');

  const entries = await historyLength(page);
  await dragHandle(page, -400);
  await expect(page, 'dragged past the transcript limit').toHaveURL(new RegExp(`#plugin/${PLAIN.id}/$`));
  expect(await historyLength(page), 'one entry pushed').toBe(entries + 1);

  await escape(page);
  await expect(page).toHaveURL(/#session=/);
  await expectSplit(page, 'Escape from full');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '450');

  const h = await boxOf(handle(page), 'the handle');
  await page.mouse.dblclick(h.x + h.width / 2, h.y + h.height / 2);
  await expectRail(page, 'double-click in split');
  const r = await boxOf(handle(page), 'the handle on the rail');
  await page.mouse.dblclick(r.x + r.width / 2, r.y + r.height / 2);
  await expectSplit(page, 'double-click on the rail');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '450');
}

export async function keyboardFlow({ page, cc }: Args): Promise<void> {
  // Invariant (9): both resize handles are keyboard splitters whose aria value is the box they size: the dock's grows with ArrowLeft, the sidebar's with ArrowRight.
  desktopOnly();
  await onSession(page, cc, 'keys');
  await railApp(page, PLAIN).click();
  await expectSplit(page, 'docked');
  await handle(page).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const dock = DOCK_PANEL_DEFAULT_WIDTH + 2 * RESIZE_KEY_STEP;
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(dock));
  expect(Math.abs((await boxOf(section(page), 'the section')).width - dock), 'the section is the value').toBeLessThanOrEqual(0.5);
  expect(Math.abs((await boxOf(column(page), 'the column')).width - (dock + DOCK_RAIL_WIDTH)), 'the column adds the rail').toBeLessThanOrEqual(0.5);

  const sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  const before = Number(await sidebar.getAttribute('aria-valuenow'));
  await sidebar.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveAttribute('aria-valuenow', String(before + RESIZE_KEY_STEP));
  expect(Math.abs((await boxOf(page.locator('aside[data-sidebar]').first(), 'the sidebar')).width - (before + RESIZE_KEY_STEP)), 'the sidebar is the value').toBeLessThanOrEqual(0.5);
}

export async function autoCollapseFlow({ page, cc }: Args): Promise<void> {
  // Invariant (8): a window that cannot keep the transcript beside the dock shows the rail without writing anything, and widening it restores split at the same width on the same app.
  desktopOnly();
  await onSession(page, cc, 'collapse');
  await dockAtW(page, PLAIN);
  const docked = await rail(page).locator('[aria-current="true"]').getAttribute('data-rail-app');
  const stored = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const before = await stored();

  const { height } = page.viewportSize()!;
  await page.setViewportSize({ width: 1100, height });
  await expectRail(page, 'a narrow window');
  expect(await stored(), 'nothing written').toBe(before);

  await page.setViewportSize({ width: 1440, height });
  await expectSplit(page, 'wide again');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
  await expect(rail(page).locator('[aria-current="true"]')).toHaveAttribute('data-rail-app', docked!);
}

export async function persistFlow({ page, cc }: Args): Promise<void> {
  // Invariant (7): the docked page's own navigation stays off the URL, and a reload restores split on that app at its width and its route.
  desktopOnly();
  await onSession(page, cc, 'persist');
  await dockAtW(page, KEEP);
  await loaded(page, KEEP.id, 'docked');
  await probeFrame(page, KEEP.id)!.evaluate((p) => history.pushState(null, '', p), `/plugins/${KEEP.id}/inner`);
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.subpath, DOCK_KEY), { message: 'the page\'s route reaches the dock' }).toBe('/inner');
  await expect(page, 'the URL stays on the session').toHaveURL(/#session=/);

  await page.reload();
  await expectSplit(page, 'reloaded');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
  await expect(railApp(page, KEEP)).toHaveAttribute('aria-current', 'true');
  await loaded(page, KEEP.id, 'reloaded');
  expect(framePath(page, KEEP.id)).toBe(`/plugins/${KEEP.id}/inner`);
  await expect(page).toHaveURL(/#session=/);
}

export async function sessionWidthFlow({ page, cc }: Args): Promise<void> {
  // Invariant (10): beside the dock the session width presets still apply — Normal is capped at its maximum in a transcript wider than it, Wide grows past it within its own — and the transcript never runs under the column.
  desktopOnly();
  await onSession(page, cc, 'width');
  const list = page.locator('[data-conversation] [data-session-width]').first();
  await expect(list).toBeVisible();
  await railApp(page, PLAIN).click();
  await expectSplit(page, 'docked');
  await dragHandle(page, DOCK_PANEL_DEFAULT_WIDTH - DOCK_PANEL_MIN_WIDTH);
  await expect(handle(page), 'fixture check: docked at the minimum').toHaveAttribute('aria-valuenow', String(DOCK_PANEL_MIN_WIDTH));
  const [[, normalMax]] = PRESET_MAX;
  expect((await boxOf(main(page), 'the transcript')).width, 'fixture check: the transcript is wider than Normal\'s maximum').toBeGreaterThan(normalMax + 1);
  const widths: Record<string, number> = {};
  for (const [label, max] of PRESET_MAX) {
    const button = page.locator('[data-sidebar-footer]').getByRole('button', { name: `Session width: ${label}` });
    if (!(await button.count())) await page.locator('[data-sidebar-footer]').getByRole('button', { name: /^Session width:/ }).click();
    await expect(button).toBeVisible();
    await expect(list).toHaveAttribute('data-session-width', label.toLowerCase());
    const l = await boxOf(list, `${label}: the list`);
    widths[label] = l.width;
    expect(l.width, `${label}: no wider than its maximum`).toBeLessThanOrEqual(max + 0.5);
    expect(right(l), `${label}: left of the column`).toBeLessThanOrEqual((await boxOf(column(page), 'the column')).x + 0.5);
  }
  expect(Math.abs(widths.Normal - normalMax), 'Normal is capped at its maximum').toBeLessThanOrEqual(0.5);
  expect(widths.Wide, 'Wide grows past Normal\'s maximum').toBeGreaterThan(normalMax + 1);
}

export async function phoneFlow({ page, cc }: Args): Promise<void> {
  // Invariant (mobile): below md an open dock in storage shows nothing beside the session; the switcher's full view works as before and leaving it hides it.
  test.skip(isDesktop(), 'the phone layout has no dock');
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [DOCK_KEY, JSON.stringify({ id: PLAIN.id, subpath: '/', open: true })] as const);
  await onSession(page, cc, 'phone');
  await next.openSidebar(page);
  await expect(page.getByRole('button', { name: 'Switch app' }).filter({ visible: true }), 'fixture check: the catalog loaded').toBeVisible();
  await expect(page.locator('[data-plugin-rail]')).toHaveCount(0);
  await expect(section(page)).toBeHidden();

  await next.openPlugin(page, PLAIN.id);
  await expect(section(page)).toBeVisible();
  await loaded(page, PLAIN.id, 'full view');
  await expect(page.locator('[data-plugin-rail]')).toHaveCount(0);

  await next.leavePlugin(page);
  await expect(section(page)).toBeHidden();
  await expect(page.locator('[data-plugin-rail]')).toHaveCount(0);
}

export async function toastClearsRailFlow({ page, cc }: Args): Promise<void> {
  // Invariant (6): with the rail shown, a toast ends left of the rail, clear of it and of the dock handle's hit area.
  desktopOnly();
  const { id, sessionId } = await spawnSession(cc, `dock-toast-${test.info().project.name}`, { worktree: true, temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }, { message: 'fixture check: the worktree session is idle', timeout: 20_000 }).toBe(true);
  await page.goto(`/#session=${sessionId}`);
  await expect(railApp(page, PLAIN)).toBeVisible();
  // The worktree matches its parent, so Sync answers ok and toasts that it is up to date.
  await page.locator('[data-session-header]').getByRole('button', { name: 'Sync', exact: true }).click();
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast, 'fixture check: Sync raised a toast').toHaveCount(1);
  await expect(toast).toBeVisible();
  const t = await boxOf(toast, 'the toast');
  const h = await boxOf(handle(page), 'the dock handle');
  expect(right(t), 'the toast ends left of the rail').toBeLessThanOrEqual((await boxOf(rail(page), 'the rail')).x);
  expect(right(t), 'and of the handle\'s hit area').toBeLessThanOrEqual(h.x);
}

