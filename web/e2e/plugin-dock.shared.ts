// The plugin dock in a real browser, with two probe plugins (one keep-alive,
// one plain): the desktop column right of the session whose width is its mode
// (hidden, a split beside the transcript, a rail, the whole row), Collapse, the one
// mode toggle and Close plugin in its header strip, the handle's drag clamps, reset and keys, Back and Escape
// from the full view, a window too narrow for a split, a reload, a session
// width (handle drags) beside it, a toast beside the strip, and the phone layout
// without it. A reload of a probe page makes a new nonce, so every "same page"
// check fails on one. The bodies are shared by the spec files; this module
// declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, spawnSession } from './harness/api.ts';
import { installProbePlugin, probeFrame, readProbe, type Probe, type ProbePlugin } from './harness/pluginProbe.ts';
import { next } from './flows/ui.ts';
import { dragSessionHandle, dragToLimit, parkPointer, sessionHandle, setWidth } from './session-width.shared.ts';
import { SESSION_WIDTH_GUTTER, SESSION_WIDTH_SNAPS } from '../src/app/sessionWidthScale.ts';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from '../src/features/views/dockLayout.ts';
import { RESIZE_KEY_STEP } from '../src/lib/useResizableWidth.ts';
import { TOAST_EDGE_GAP } from '../src/ui/toastLayout.ts';

type Args = { page: Page; cc: Cc };
type Box = { x: number; y: number; width: number; height: number };

export const KEEP: ProbePlugin = { id: 'dock-keep', name: 'Dock keep', keepAlive: true };
export const PLAIN: ProbePlugin = { id: 'dock-plain', name: 'Dock plain', keepAlive: false };
// DOCK_STORAGE_KEY (web/src/features/views/dock.ts).
const DOCK_KEY = 'code-conductor:plugin-dock';
// DOCK_COLLAPSED_STORAGE_KEY (web/src/features/views/dock.ts).
const COLLAPSED_KEY = 'code-conductor:plugin-dock-collapsed';
const W = 520;
/** Window widths on the desktop project: the main row (window − the default sidebar) fits no split, a clamped W, and W. */
const NO_SPLIT = 900;
const CLAMPED = 1100;
const ROOMY = 1440;

/** Installs both probe plugins on this spec's cc. */
export async function installProbes(cc: Cc): Promise<void> {
  for (const p of [KEEP, PLAIN]) await installProbePlugin(cc, p);
}

const isDesktop = () => test.info().project.name === 'desktop';
const desktopOnly = () => test.skip(!isDesktop(), 'the dock is a desktop-layout feature');
const label = (flow: string) => `dock-${flow}-${test.info().project.name}`;

const column = (page: Page) => page.locator('[data-plugin-column]');
const section = (page: Page) => page.locator('section[data-view="plugin"]');
const header = (page: Page) => section(page).locator('header');
/** The column's mode toggle named `name`, in its header strip. */
const toggle = (page: Page, name: 'Dock to side' | 'Expand to full view') => header(page).getByRole('button', { name, exact: true });
/** The strip's Close plugin, the switcher's Conductor pick. */
const closeBtn = (page: Page) => header(page).getByRole('button', { name: 'Close plugin', exact: true });
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize plugin dock' });
const main = (page: Page) => page.locator('main').first();
const desktopSidebar = (page: Page) => page.locator('[data-sidebar]:visible');
const historyLength = (page: Page) => page.evaluate(() => history.length);
const storedDock = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), DOCK_KEY);
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
const bottom = (b: Box) => b.y + b.height;

/** A session of its own, open, with the switcher listing the probes. */
async function onSession(page: Page, cc: Cc, flow: string): Promise<string> {
  const { sessionId } = await spawnSession(cc, label(flow));
  await page.goto(`/#session=${sessionId}`);
  if (isDesktop()) await expect(desktopSidebar(page).getByRole('button', { name: 'Switch app' }), 'fixture check: the catalog loaded').toBeVisible();
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
/** Nothing selected: the column hidden, the session alone. */
async function expectHidden(page: Page, what: string) {
  await expect(section(page), `${what}: no plugin section`).toBeHidden();
  await expect(column(page), `${what}: the column hidden`).toHaveAttribute('data-dock-mode', 'hidden');
}

/** Picks `p` from the desktop switcher, whatever it opens (the URL is the session's for a split). */
async function pick(page: Page, p: ProbePlugin) {
  await desktopSidebar(page).getByRole('button', { name: 'Switch app' }).click();
  await page.locator(`[data-app-id="${p.id}"]`).click();
}

/** Escape with the pointer clear of every tooltip (a closing tooltip takes the Escape). */
async function escape(page: Page) {
  await parkPointer(page);
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

/** `p` in split, from the full view a pick opens with the full view remembered: the pick, then Dock to side. */
async function dockSplit(page: Page, p: ProbePlugin) {
  await next.openPlugin(page, p.id);
  await toggle(page, 'Dock to side').click();
  await expect(page).toHaveURL(/#session=/);
  await expectSplit(page, `fixture check: ${p.name} docked`);
}

/** `p` in split at W. */
async function dockSplitAtW(page: Page, p: ProbePlugin) {
  await dockSplit(page, p);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(DOCK_PANEL_DEFAULT_WIDTH));
  await dragHandle(page, DOCK_PANEL_DEFAULT_WIDTH - W);
  await expect(handle(page), 'fixture check: docked at W').toHaveAttribute('aria-valuenow', String(W));
}

// ── flows ────────────────────────────────────────────────────────────────

export async function toggleGeometryFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F1, F3): the column holds Collapse (split only) and its mode toggle left of the plugin's name, then Close plugin at the strip's end, in a header strip above the frame: across the row in full, at the default width beside the session in split, and nothing on Conductor.
  desktopOnly();
  await onSession(page, cc, 'geometry');
  const viewport = page.viewportSize()!;
  await expect(column(page).locator('nav'), 'no navigation strip').toHaveCount(0);
  await expectHidden(page, 'on a session');
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - viewport.width), 'the session reaches the viewport edge').toBeLessThanOrEqual(0.5);

  await next.openPlugin(page, PLAIN.id);
  await expect(section(page)).toBeVisible();
  const s = await boxOf(section(page), 'the section');
  const h = await boxOf(header(page), 'the strip');
  expect(Math.abs(h.y - s.y), 'the strip tops the section').toBeLessThanOrEqual(0.5);
  const dock = await boxOf(toggle(page, 'Dock to side'), 'Dock to side');
  expect(dock.y >= h.y - 0.5 && bottom(dock) <= bottom(h) + 0.5 && dock.x >= h.x - 0.5 && right(dock) <= right(h) + 0.5, 'Dock to side sits in the strip').toBe(true);
  const c = await boxOf(closeBtn(page), 'Close plugin');
  expect(c.x, 'full: Close is right of Dock to side').toBeGreaterThanOrEqual(right(dock) - 0.5);
  expect(c.y < bottom(dock) && bottom(c) > dock.y, 'full: Close is on the toggle\'s row').toBe(true);
  expect(right(c), 'full: Close is inside the strip').toBeLessThanOrEqual(right(h) + 0.5);
  const name = await boxOf(header(page).locator('h1'), 'the heading');
  expect(right(dock), 'full: Dock to side is left of the name').toBeLessThanOrEqual(name.x + 0.5);
  expect(right(name), 'full: the name is left of Close').toBeLessThanOrEqual(c.x + 0.5);
  const f = await boxOf(section(page).locator('iframe:visible'), 'the frame');
  expect(f.y, 'the frame starts below the strip').toBeGreaterThanOrEqual(bottom(h) - 0.5);
  expect(Math.abs(bottom(f) - bottom(s)), 'the frame reaches the section\'s bottom').toBeLessThanOrEqual(0.5);
  expect(Math.abs(right(await boxOf(column(page), 'the column')) - viewport.width), 'full: the column reaches the viewport edge').toBeLessThanOrEqual(0.5);

  await toggle(page, 'Dock to side').click();
  await expect(page).toHaveURL(/#session=/);
  await expectSplit(page, 'docked');
  expect(Math.abs((await boxOf(section(page), 'the section')).width - DOCK_PANEL_DEFAULT_WIDTH), 'split at the default width').toBeLessThanOrEqual(1);
  const col = await boxOf(column(page), 'the column');
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - col.x), 'the session meets the column').toBeLessThanOrEqual(0.5);
  expect(Math.abs(right(col) - viewport.width), 'split: the column reaches the viewport edge').toBeLessThanOrEqual(0.5);
  const sh = await boxOf(header(page), 'the strip in split');
  const expand = await boxOf(toggle(page, 'Expand to full view'), 'Expand to full view');
  expect(expand.y >= sh.y - 0.5 && bottom(expand) <= bottom(sh) + 0.5, 'Expand sits in the strip').toBe(true);
  const sc = await boxOf(closeBtn(page), 'Close plugin in split');
  expect(sc.x, 'split: Close is right of Expand to full view').toBeGreaterThanOrEqual(right(expand) - 0.5);
  expect(sc.y < bottom(expand) && bottom(sc) > expand.y, 'split: Close is on the toggle\'s row').toBe(true);
  expect(right(sc), 'split: Close is inside the strip').toBeLessThanOrEqual(right(sh) + 0.5);
  await expect(header(page).getByRole('button'), 'three controls: Collapse, the toggle and Close').toHaveCount(3);
  const collapseBox = await boxOf(header(page).getByRole('button', { name: 'Collapse plugin dock', exact: true }), 'Collapse plugin dock');
  expect(right(collapseBox), 'split: Collapse is left of Expand to full view').toBeLessThanOrEqual(expand.x + 0.5);
  const sname = await boxOf(header(page).locator('h1'), 'the heading in split');
  expect(right(expand), 'split: Expand to full view is left of the name').toBeLessThanOrEqual(sname.x + 0.5);
  expect(right(sname), 'split: the name is left of Close').toBeLessThanOrEqual(sc.x + 0.5);

  await next.leavePlugin(page);
  await expectHidden(page, 'Conductor');
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - viewport.width), 'the session reaches the viewport edge again').toBeLessThanOrEqual(0.5);
}

/** Full → split → full → split for probe `p`, all one page load. */
export function noReloadFlow(p: ProbePlugin) {
  return async ({ page, cc }: Args): Promise<void> => {
    // Invariant (F1): Dock to side and Expand to full view never reload the plugin's page.
    desktopOnly();
    await onSession(page, cc, `noreload-${p.id}`);
    await next.openPlugin(page, p.id);
    const { nonce } = await loaded(page, p.id, 'full view');

    await toggle(page, 'Dock to side').click();
    await expect(page).toHaveURL(/#session=/);
    await expectSplit(page, 'docked');
    expect((await readProbe(page, p.id))?.nonce, 'docked: the same page').toBe(nonce);

    await toggle(page, 'Expand to full view').click();
    await expect(page).toHaveURL(new RegExp(`#plugin/${p.id}/$`));
    await expect(main(page), 'the session view is gone').toHaveCount(0);
    expect((await readProbe(page, p.id))?.nonce, 'expanded: the same page').toBe(nonce);

    await toggle(page, 'Dock to side').click();
    await expect(page).toHaveURL(/#session=/);
    await expectSplit(page, 'docked again');
    expect((await readProbe(page, p.id))?.nonce, 'docked again: the same page').toBe(nonce);
  };
}

export async function fullExitFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F7): Back and Escape from the full view land on Conductor, never on a split, and a switch between plugins in full costs no history entry (Chromium's queued Back, which happy-dom cannot model).
  desktopOnly();
  await onSession(page, cc, 'exit');
  await dockSplit(page, PLAIN);
  await toggle(page, 'Expand to full view').click();
  await expect(page).toHaveURL(new RegExp(`#plugin/${PLAIN.id}/$`));
  await page.goBack();
  await expect(page).toHaveURL(/#session=/);
  await expectHidden(page, 'Back from an expanded split');

  await dockSplit(page, PLAIN);
  await toggle(page, 'Expand to full view').click();
  await expect(page).toHaveURL(new RegExp(`#plugin/${PLAIN.id}/$`));
  await escape(page);
  await expect(page).toHaveURL(/#session=/);
  await expectHidden(page, 'Escape from an expanded split');

  await next.openPlugin(page, PLAIN.id);
  const entries = await historyLength(page);
  await next.openPlugin(page, KEEP.id);
  expect(await historyLength(page), 'a switch in full costs no entry').toBe(entries);
  await page.goBack();
  await expect(page).toHaveURL(/#session=/);
  await expectHidden(page, 'Back after a switch in full');
}

export async function dragClampFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F8): a drag keeps working while the pointer crosses the plugin's iframe (pointer capture carries it in Chromium; this does not show the body[data-resizing] rule is needed), stops at DOCK_PANEL_MIN_WIDTH and at the transcript limit without leaving split, and a double-click resets the default width.
  desktopOnly();
  await onSession(page, cc, 'drag');
  await dockSplitAtW(page, PLAIN);
  await loaded(page, PLAIN.id, 'docked');

  await dragHandle(page, 150);
  await expect(handle(page), 'dragged right, crossing the iframe').toHaveAttribute('aria-valuenow', String(W - 150));
  expect(Math.abs((await boxOf(section(page), 'the section')).width - (W - 150)), 'the section follows').toBeLessThanOrEqual(1);

  await dragHandle(page, 400);
  await expect(handle(page), 'stopped at the minimum').toHaveAttribute('aria-valuenow', String(DOCK_PANEL_MIN_WIDTH));
  await expectSplit(page, 'below the minimum');
  await expect(page).toHaveURL(/#session=/);

  const entries = await historyLength(page);
  await dragHandle(page, -1000);
  await expectSplit(page, 'past the transcript limit');
  await expect(page).toHaveURL(/#session=/);
  expect(await historyLength(page), 'no history entry').toBe(entries);
  expect((await boxOf(main(page), 'the transcript')).width, 'the transcript keeps its floor').toBeGreaterThanOrEqual(DOCK_TRANSCRIPT_MIN_WIDTH - 0.5);

  const h = await boxOf(handle(page), 'the handle');
  await page.mouse.dblclick(h.x + h.width / 2, h.y + h.height / 2);
  await expect(handle(page), 'a double-click resets').toHaveAttribute('aria-valuenow', String(DOCK_PANEL_DEFAULT_WIDTH));
}

export async function keyboardFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F8): both resize handles are keyboard splitters whose aria value is the box they size: the dock's grows with ArrowLeft, the sidebar's with ArrowRight.
  desktopOnly();
  await onSession(page, cc, 'keys');
  await dockSplit(page, PLAIN);
  await handle(page).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const dock = DOCK_PANEL_DEFAULT_WIDTH + 2 * RESIZE_KEY_STEP;
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(dock));
  expect(Math.abs((await boxOf(section(page), 'the section')).width - dock), 'the section is the value').toBeLessThanOrEqual(0.5);
  expect(Math.abs((await boxOf(column(page), 'the column')).width - dock), 'the column is the value').toBeLessThanOrEqual(0.5);

  const sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  const before = Number(await sidebar.getAttribute('aria-valuenow'));
  await sidebar.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveAttribute('aria-valuenow', String(before + RESIZE_KEY_STEP));
  expect(Math.abs((await boxOf(page.locator('aside[data-sidebar]').first(), 'the sidebar')).width - (before + RESIZE_KEY_STEP)), 'the sidebar is the value').toBeLessThanOrEqual(0.5);
}

export async function narrowWindowFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F9, F5, F7): a window too narrow for any split shows the plugin over the session without writing anything, and Escape or a user's session pick closes it keeping the remembered split; a window too narrow for the stored width clamps split; widening restores the stored width.
  desktopOnly();
  const otherProject = label('narrow-other');
  const { sessionId: other } = await spawnSession(cc, otherProject);
  const sessionId = await onSession(page, cc, 'narrow');
  await dockSplitAtW(page, PLAIN);
  const stored = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const before = await stored();
  const { height } = page.viewportSize()!;

  // (1) No split fits: the plugin covers the session; a clamped split; the stored width again.
  await page.setViewportSize({ width: NO_SPLIT, height });
  await expect(section(page), 'no split fits: the plugin shown').toBeVisible();
  await expect(main(page), 'over the session').toBeHidden();
  const s = await boxOf(section(page), 'the section');
  expect(Math.abs(s.x - right(await boxOf(page.locator('aside[data-sidebar]').first(), 'the sidebar'))), 'from the sidebar').toBeLessThanOrEqual(0.5);
  expect(Math.abs(right(s) - NO_SPLIT), 'to the viewport edge').toBeLessThanOrEqual(0.5);
  await expect(toggle(page, 'Dock to side'), 'no toggle').toHaveCount(0);
  await expect(toggle(page, 'Expand to full view'), 'no toggle').toHaveCount(0);
  await expect(closeBtn(page), 'only Close').toBeVisible();
  expect(await stored(), 'nothing written').toBe(before);

  await page.setViewportSize({ width: CLAMPED, height });
  await expectSplit(page, 'a clamped split');
  expect(Number(await handle(page).getAttribute('aria-valuenow')), 'narrower than W').toBeLessThan(W);
  expect((await boxOf(main(page), 'the transcript')).width, 'the transcript keeps its floor').toBeGreaterThanOrEqual(DOCK_TRANSCRIPT_MIN_WIDTH - 0.5);
  expect(await stored(), 'nothing written').toBe(before);

  await page.setViewportSize({ width: ROOMY, height });
  await expect(handle(page), 'wide again: the stored width').toHaveAttribute('aria-valuenow', String(W));

  // (2) Escape closes the covering plugin, with the split remembered.
  await page.setViewportSize({ width: NO_SPLIT, height });
  await expect(main(page), 'fixture check: covered').toBeHidden();
  await escape(page);
  await expect(section(page), 'Escape closed it').toBeHidden();
  await expect(main(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#session=${sessionId}$`));
  expect(await storedDock(page)).toMatchObject({ id: null, mode: 'split' });

  // (3) A pick covers again; a session row click closes it.
  await pick(page, PLAIN);
  await expect(section(page), 'fixture check: picked').toBeVisible();
  await expect(main(page), 'fixture check: covered again').toBeHidden();
  await (await next.sessionRow(page, otherProject, other)).click();
  await expect(page).toHaveURL(new RegExp(`#session=${other}$`));
  await expect(section(page), 'the session pick closed it').toBeHidden();
  await expect(main(page)).toBeVisible();
  expect((await storedDock(page))?.mode, 'split stays remembered').toBe('split');

  // (4) Widening reopens nothing; the next pick is the split at the stored width.
  await page.setViewportSize({ width: ROOMY, height });
  await expectHidden(page, 'wide again');
  await pick(page, PLAIN);
  await expectSplit(page, 'the next pick');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
}

export async function collapseFlow({ page, cc }: Args): Promise<void> {
  // Invariant: Collapse parks the split as a rail at the viewport edge and the session widens by the freed width; the plain page behind it stays mounted, live and scrolled, Expand restores the width, and a reload keeps the rail.
  desktopOnly();
  await onSession(page, cc, 'collapse');
  await dockSplitAtW(page, PLAIN);
  const before = await loaded(page, PLAIN.id, 'docked');
  const probe = probeFrame(page, PLAIN.id)!;
  await probe.evaluate(() => { document.body.style.minHeight = '5000px'; scrollTo(0, 1234); });
  expect(await probe.evaluate(() => scrollY), 'fixture check: scrolled').toBe(1234);
  const viewport = page.viewportSize()!;

  const collapseBtn = header(page).getByRole('button').first();
  await expect(collapseBtn).toHaveAccessibleName('Collapse plugin dock');
  expect(right(await boxOf(collapseBtn, 'Collapse')), 'Collapse is left of the heading').toBeLessThanOrEqual((await boxOf(header(page).locator('h1'), 'the heading')).x + 0.5);
  const mainBefore = await boxOf(main(page), 'the session');
  await collapseBtn.click();

  await expect(column(page)).toHaveAttribute('data-dock-mode', 'rail');
  const col = await boxOf(column(page), 'the rail');
  expect(Math.abs(col.width - DOCK_RAIL_WIDTH), 'the rail width').toBeLessThanOrEqual(0.5);
  expect(Math.abs(right(col) - viewport.width), 'the rail at the viewport edge').toBeLessThanOrEqual(0.5);
  const mainAfter = await boxOf(main(page), 'the session collapsed');
  expect(Math.abs(right(mainAfter) - col.x), 'the session meets the rail').toBeLessThanOrEqual(0.5);
  expect(Math.abs(mainAfter.width - mainBefore.width - (W - DOCK_RAIL_WIDTH)), 'the session widened by the freed width').toBeLessThanOrEqual(1);
  await expect(section(page)).toBeHidden();
  const expandBtn = column(page).getByRole('button', { name: 'Expand plugin dock', exact: true });
  await expect(expandBtn).toBeVisible();
  const eb = await boxOf(expandBtn, 'Expand');
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), [eb.x + eb.width / 2, eb.y + eb.height / 2] as const), 'Expand is what a click at its centre hits').toBe('Expand plugin dock');
  await expect(column(page).locator('[data-dock-rail]')).toContainText(PLAIN.name);
  // The label's own box includes its padding, so it touches the divider either way; the text's range rect is what moves.
  const bar = await boxOf(column(page).locator('[data-dock-rail] > div').first(), 'the rail bar');
  const ink = await page.evaluate(() => {
    const label = document.querySelector('[data-dock-rail-label]')!;
    const r = document.createRange();
    r.selectNodeContents(label);
    const b = r.getBoundingClientRect();
    const spacing = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing')) * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { top: b.top, centreX: b.left + b.width / 2, spacing };
  });
  expect(Math.abs(ink.centreX - (eb.x + eb.width / 2)), 'the rail name is centred under Expand').toBeLessThanOrEqual(1);
  expect(ink.top - (bar.y + bar.height), 'the rail name starts a pt-2 below the divider').toBeGreaterThanOrEqual(2 * ink.spacing - 0.5);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), 'the parked page adds no horizontal overflow').toBe(true);

  await expect.poll(async () => { const p = await readProbe(page, PLAIN.id); return !!p && p.ticks > before.ticks && p.ws > before.ws; }, { message: 'the page stays live while collapsed' }).toBe(true);
  expect((await readProbe(page, PLAIN.id))?.nonce, 'same page load').toBe(before.nonce);

  await expandBtn.click();
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
  expect(Math.abs((await boxOf(section(page), 'the section')).width - W), 'split restored at W').toBeLessThanOrEqual(1);
  expect(Math.abs(right(await boxOf(main(page), 'the session')) - (await boxOf(column(page), 'the column')).x), 'the session meets the column').toBeLessThanOrEqual(0.5);
  expect((await readProbe(page, PLAIN.id))?.nonce, 'same page load after Expand').toBe(before.nonce);
  expect(await probe.evaluate(() => scrollY), 'scroll position kept').toBe(1234);

  await header(page).getByRole('button', { name: 'Collapse plugin dock', exact: true }).click();
  await expect(column(page)).toHaveAttribute('data-dock-mode', 'rail');
  await page.reload();
  await expect(column(page)).toHaveAttribute('data-dock-mode', 'rail');
  await expect(column(page).getByRole('button', { name: 'Expand plugin dock', exact: true })).toBeVisible();
  await column(page).getByRole('button', { name: 'Expand plugin dock', exact: true }).click();
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
}

export async function persistFlow({ page, cc }: Args): Promise<void> {
  // Invariant (reload): the docked page's own navigation stays off the URL, and a reload restores split on that plugin at its width and its route, checked in the switcher.
  desktopOnly();
  await onSession(page, cc, 'persist');
  await dockSplitAtW(page, KEEP);
  await loaded(page, KEEP.id, 'docked');
  await probeFrame(page, KEEP.id)!.evaluate((p) => history.pushState(null, '', p), `/plugins/${KEEP.id}/inner`);
  await expect.poll(async () => (await storedDock(page))?.subpath, { message: 'the page\'s route reaches the dock' }).toBe('/inner');
  await expect(page, 'the URL stays on the session').toHaveURL(/#session=/);

  await page.reload();
  await expectSplit(page, 'reloaded');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(W));
  await desktopSidebar(page).getByRole('button', { name: 'Switch app' }).click();
  await expect(page.getByRole('menuitemradio', { name: new RegExp(`^${KEEP.name}`) }), 'checked in the switcher').toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await loaded(page, KEEP.id, 'reloaded');
  expect(framePath(page, KEEP.id)).toBe(`/plugins/${KEEP.id}/inner`);
  await expect(page).toHaveURL(/#session=/);
}

export async function sessionWidthFlow({ page, cc }: Args): Promise<void> {
  // Invariant: beside the dock a session width still applies — Normal is capped at its width in a transcript wider than it, a Wide set before docking renders clamped to the narrowed transcript (a gutter clear per side) and stays the setting, a session dragged to its limit leaves a gutter clear per side — and the transcript never runs under the column.
  desktopOnly();
  await onSession(page, cc, 'width');
  const list = page.locator('[data-conversation] [data-session-width]').first();
  await expect(list).toBeVisible();
  const [normal, wide] = SESSION_WIDTH_SNAPS;
  // Wide fits the full-width row, not the narrowed transcript beside the dock: set it first, so docking only clamps its rendering.
  await setWidth(page, { width: wide.px, full: false });
  await dockSplit(page, PLAIN);
  await dragHandle(page, DOCK_PANEL_DEFAULT_WIDTH - DOCK_PANEL_MIN_WIDTH);
  await expect(handle(page), 'fixture check: docked at the minimum').toHaveAttribute('aria-valuenow', String(DOCK_PANEL_MIN_WIDTH));
  const transcript = (await boxOf(main(page), 'the transcript')).width;
  expect(transcript, 'fixture check: the transcript is wider than Normal').toBeGreaterThan(normal.px + 1);
  expect(transcript, 'fixture check: the transcript is narrower than Wide').toBeLessThan(wide.px);
  const room = () => page.locator('[data-conversation]').evaluate((el) => el.clientWidth);
  const leftOfColumn = async (name: string) => {
    const l = await boxOf(list, `${name}: the list`);
    expect(right(l), `${name}: left of the column`).toBeLessThanOrEqual((await boxOf(column(page), 'the column')).x + 0.5);
    return l;
  };
  await expect(list, 'Wide stays the setting').toHaveAttribute('data-session-width', String(wide.px));
  const clamped = await leftOfColumn(wide.label);
  expect(clamped.width, `${wide.label}: grows past Normal`).toBeGreaterThan(normal.px + 1);
  expect(Math.abs(clamped.width - ((await room()) - 2 * SESSION_WIDTH_GUTTER)), `${wide.label}: clamped a gutter clear per side`).toBeLessThanOrEqual(0.5);
  await setWidth(page, { width: normal.px, full: false });
  expect(Math.abs((await leftOfColumn(normal.label)).width - normal.px), 'Normal is capped at its width').toBeLessThanOrEqual(0.5);
  await dragToLimit(page);
  const limit = await leftOfColumn('Limit');
  expect(Math.abs(limit.width - ((await room()) - 2 * SESSION_WIDTH_GUTTER)), 'the limit leaves a gutter clear per side').toBeLessThanOrEqual(0.5);
}

export async function sessionHandleCoexistFlow({ page, cc }: Args): Promise<void> {
  // Invariant: at the session limit with the dock at its minimum, the session handles are physically disjoint from the dock handle, the sidebar handle and the scrollbar, and each grab moves only its own box.
  desktopOnly();
  await onSession(page, cc, 'coexist');
  await dockSplit(page, PLAIN);
  await dragHandle(page, DOCK_PANEL_DEFAULT_WIDTH - DOCK_PANEL_MIN_WIDTH);
  await expect(handle(page), 'fixture check: docked at the minimum').toHaveAttribute('aria-valuenow', String(DOCK_PANEL_MIN_WIDTH));
  await expect(sessionHandle(page, 'right')).toHaveCount(1);
  await dragToLimit(page);
  const sessionWidth = () => page.locator('[data-conversation] [data-session-width]').first().getAttribute('data-session-width');
  const limit = await sessionWidth();
  expect(Number(limit), 'fixture check: dragged off Normal').toBeGreaterThan(768);

  const sidebarHandle = page.getByRole('separator', { name: 'Resize sidebar' });
  const [sl, sr, dock, sidebar] = [
    await boxOf(sessionHandle(page, 'left'), 'the session left handle'),
    await boxOf(sessionHandle(page, 'right'), 'the session right handle'),
    await boxOf(handle(page), 'the dock handle'),
    await boxOf(sidebarHandle, 'the sidebar handle'),
  ];
  const scrollerEdge = await page.locator('[data-conversation]').evaluate((el) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
  expect(right(sr), 'the right handle is clear of the scrollbar').toBeLessThanOrEqual(scrollerEdge + 0.5);
  expect(right(sr), 'the right handle is left of the dock handle').toBeLessThan(dock.x);
  expect(sl.x, 'the left handle is right of the sidebar handle').toBeGreaterThanOrEqual(right(sidebar) - 0.5);
  for (const [edge, b] of [['left', sl], ['right', sr]] as const) {
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-session-handle]')?.getAttribute('data-session-handle') ?? null, [b.x + b.width / 2, b.y + b.height / 2]);
    expect(hit, `a press at the ${edge} handle's centre lands on it`).toBe(edge);
  }

  await dragHandle(page, -40);
  await expect(handle(page), 'the dock grab moves the dock').not.toHaveAttribute('aria-valuenow', String(DOCK_PANEL_MIN_WIDTH));
  expect(await sessionWidth(), 'the dock grab leaves the session setting').toBe(limit);

  const dockNow = await handle(page).getAttribute('aria-valuenow');
  await dragSessionHandle(page, 'right', -40, { release: true });
  await expect.poll(sessionWidth, { message: 'the session grab moves the session setting' }).not.toBe(limit);
  await expect(handle(page), 'the session grab leaves the dock').toHaveAttribute('aria-valuenow', dockNow!);
}

export async function phoneFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F10): below md a remembered split shows nothing beside the session, a pick opens the full-page view with the phone bar, Close and no toggle, and leaving it hides it.
  test.skip(isDesktop(), 'the phone layout has no split');
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [DOCK_KEY, JSON.stringify({ id: PLAIN.id, subpath: '/', mode: 'split' })] as const);
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [COLLAPSED_KEY, 'true'] as const);
  await onSession(page, cc, 'phone');
  await expect(column(page).locator('[data-dock-rail]'), 'no rail below md').toHaveCount(0);
  await next.openSidebar(page);
  await expect(page.getByRole('button', { name: 'Switch app' }).filter({ visible: true }), 'fixture check: the catalog loaded').toBeVisible();
  await expect(section(page)).toBeHidden();

  await next.openPlugin(page, PLAIN.id);
  await expect(section(page)).toBeVisible();
  await loaded(page, PLAIN.id, 'full view');
  await expect(header(page).getByRole('button', { name: 'Open sidebar' }), 'the phone bar').toBeVisible();
  await expect(toggle(page, 'Dock to side')).toHaveCount(0);
  await expect(toggle(page, 'Expand to full view')).toHaveCount(0);
  await expect(closeBtn(page), 'Close in the phone bar').toBeVisible();
  await expect(header(page).getByRole('button', { name: 'Collapse plugin dock' }), 'no Collapse in the full view').toHaveCount(0);
  await expect(column(page)).toHaveAttribute('data-dock-mode', 'full');

  await next.leavePlugin(page);
  await expect(section(page)).toBeHidden();
}

export async function toastClearsToggleFlow({ page, cc }: Args): Promise<void> {
  // Invariant (F1): a toast sits below the column's strip, so its toggle and Close stay hit-testable, and keeps TOAST_EDGE_GAP from the window's edge.
  desktopOnly();
  const { id, sessionId } = await spawnSession(cc, label('toast'), { worktree: true, temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }, { message: 'fixture check: the worktree session is idle', timeout: 20_000 }).toBe(true);
  await page.goto(`/#session=${sessionId}`);
  await dockSplit(page, PLAIN);
  // The worktree matches its parent, so Sync answers ok and toasts that it is up to date.
  await page.locator('[data-session-header]').getByRole('button', { name: 'Sync', exact: true }).click();
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast, 'fixture check: Sync raised a toast').toHaveCount(1);
  await expect(toast).toBeVisible();
  // Sonner slides a toast in from above, so its box is read once it has landed.
  const strip = bottom(await boxOf(header(page), 'the strip'));
  await expect.poll(async () => (await boxOf(toast, 'the toast')).y, { message: 'the toast starts below the strip' }).toBeGreaterThanOrEqual(strip - 0.5);
  const b = await boxOf(toggle(page, 'Expand to full view'), 'the toggle');
  const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('button[aria-label="Expand to full view"]'), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  expect(hit, 'the toggle is hit at its centre').toBe(true);
  const cb = await boxOf(closeBtn(page), 'Close plugin');
  const closeHit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('button[aria-label="Close plugin"]'), { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 });
  expect(closeHit, 'Close is hit at its centre').toBe(true);
  expect(right(await boxOf(toast, 'the toast')), 'the toast keeps the edge gap').toBeCloseTo(page.viewportSize()!.width - TOAST_EDGE_GAP, 0);
}
