// The session width toggle and the column's edge handles in a real browser. The bodies are
// shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, reveal, sendAll, tallPrompt } from './flows/stickyPin.ts';
import { SESSION_WIDTH_GUTTER, sessionWidthKey, sessionWidthLabel } from '../src/app/sessionWidthScale.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };
type Setting = { width?: number; full?: boolean };
type Edge = 'left' | 'right';

export const widthToggle = (page: Page) => page.locator('[data-sidebar-footer]').getByRole('button', { name: /^Session width:/ });
export const sessionHandle = (page: Page, edge: Edge) => page.locator(`[data-session-handle=${edge}]`);
const layer = (page: Page) => page.locator('[data-session-handles]');

/** Move the pointer to a spot with no interactive element under it, so no tooltip trigger holds a tooltip open. */
export async function parkPointer(page: Page) {
  const spot = await page.evaluate(() => {
    for (let y = window.innerHeight - 8; y > 0; y -= 24) {
      for (let x = window.innerWidth - 8; x > 0; x -= 24) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('button, a, input, textarea, select, iframe, [role], [tabindex], [data-slot*="trigger"]')) return { x, y };
      }
    }
    return null;
  });
  if (!spot) throw new Error('no spot clear of interactive elements to park the pointer');
  await page.mouse.move(spot.x, spot.y);
}

/** A real mouse drag of a session handle by `dx` px from its centre; releases only on request. */
export async function dragSessionHandle(page: Page, edge: Edge, dx: number, { release }: { release: boolean }) {
  const h = await sessionHandle(page, edge).boundingBox();
  if (!h) throw new Error(`the ${edge} session handle is not rendered`);
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  if (release) await page.mouse.up();
}

/** The room a drag is bounded by: the handle layer's width (main's). */
export const layerWidth = async (page: Page) => (await layer(page).boundingBox())!.width;

/** Drag the right handle far past the room and release: the column ends at the limit. */
export async function dragToLimit(page: Page) {
  await dragSessionHandle(page, 'right', Math.ceil((await layerWidth(page)) / 2) + 40, { release: true });
}

/** Reach a setting through the real controls: Full by the toggle; a width by a double-click reset to Normal, then a right-handle drag (2x gain). */
export async function setWidth(page: Page, s: Setting) {
  // A bare width means Full off.
  const full = s.full ?? (s.width === undefined ? undefined : false);
  const setFull = async (want: boolean) => {
    if (((await widthToggle(page).getAttribute('aria-label')) === 'Session width: Full') !== want) await widthToggle(page).click();
  };
  if (s.width !== undefined) {
    await setFull(false);
    await sessionHandle(page, 'right').dblclick();
    await expect(layerList(page)).toHaveAttribute('data-session-width', '768');
    if (s.width !== 768) {
      await dragSessionHandle(page, 'right', (s.width - 768) / 2, { release: true });
      await expect(layerList(page)).toHaveAttribute('data-session-width', String(s.width));
    }
  }
  if (full !== undefined) await setFull(full);
  await expect(widthToggle(page)).toHaveAccessibleName(full === true ? 'Session width: Full' : /^Session width: Resizable/);
  await parkPointer(page);
}

const layerList = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();

/** The states the flows walk, in ascending list width. */
export const WIDTH_STATES: Setting[] = [{ width: 768, full: false }, { width: 896, full: false }, { width: 1024, full: false }, { full: true }];
/** A state's `data-session-width` value. */
export const stateKey = (s: Setting) => sessionWidthKey({ width: s.width ?? 768, full: s.full ?? false });
/** A state's name in the trigger label and in assertion messages. */
export const stateLabel = (s: Setting) => sessionWidthLabel({ width: s.width ?? 768, full: s.full ?? false });

const list = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();
const bottom = (page: Page) => page.locator('[data-session-body] > div[data-session-width]');

async function measure(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-conversation]') as HTMLElement;
    const listEl = scroller.querySelector('[data-session-width]') as HTMLElement;
    const bottomEl = document.querySelector('[data-session-body] > div[data-session-width]') as HTMLElement;
    const main = document.querySelector('main') as HTMLElement;
    const bodies = document.querySelectorAll('[data-item=assistant] [data-assistant-body]');
    const body = bodies[bodies.length - 1] as HTMLElement;
    const pinColumn = document.querySelector('[data-pinned-prompt] > [data-session-width]') as HTMLElement;
    const lr = listEl.getBoundingClientRect();
    const cs = getComputedStyle(listEl);
    const pr = pinColumn.getBoundingClientRect();
    const pcs = getComputedStyle(pinColumn);
    const pinBubble = document.querySelector('[data-pinned-prompt] [data-pin-body]') as HTMLElement;
    const liveBubble = document.querySelector('[data-item=user] [data-user-text]') as HTMLElement;
    const pb = pinBubble.getBoundingClientRect();
    const lb = liveBubble.getBoundingClientRect();
    return {
      listWidth: lr.width,
      listLeft: lr.left,
      listContentLeft: lr.left + parseFloat(cs.paddingLeft),
      pinContentLeft: pr.left + parseFloat(pcs.paddingLeft),
      pinContentRight: pr.right - parseFloat(pcs.paddingRight),
      pinBubbleLeft: pb.left,
      pinBubbleRight: pb.right,
      liveBubbleLeft: lb.left,
      liveBubbleRight: lb.right,
      listContentRight: lr.right - parseFloat(cs.paddingRight),
      bottomLeft: bottomEl.getBoundingClientRect().left,
      bottomWidth: bottomEl.getBoundingClientRect().width,
      mainWidth: main.getBoundingClientRect().width,
      scrollerClient: scroller.clientWidth,
      gutter: scroller.offsetWidth - scroller.clientWidth,
      bodyRight: body.getBoundingClientRect().right,
      pinWidth: pinColumn.getBoundingClientRect().width,
      layerWidth: (document.querySelector('[data-session-handles]') as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
    };
  });
}

// Invariants: list width ascends Normal < 896 < Wide < Full; a fixed width is the list's width, below the scroller; Full fills the area, keeps the width and has no handles; a drag to the limit stores the shown px and leaves a gutter per side; the transcript and bottom columns stay aligned; the pin column has the list's box and content box; the pinned bubble's edges are the live prompt bubble's; the last assistant body tracks the list's content edge; the setting survives a reload.
/** Desktop: walks the width states on a rendered turn through the real controls and measures the column. */
export async function widthsFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the width control is a desktop-layout feature');
  const { sessionId } = await spawnSession(cc, 'e2e-session-width');
  await page.goto(`/#session=${sessionId}`);
  // A tall prompt, so the turn overflows and its prompt can be scrolled under the header and pinned.
  await sendAll(page, next, [tallPrompt('WIDTH-PIN')]);
  const showPin = async () => {
    await bringTo(next.transcript(page), next.userMessages(page).nth(0), -150);
    await reveal(page, next);
    await expect(next.pin(page)).toHaveAttribute('role', 'button');
  };
  const expectColumnFollows = async (where: string, expected: { width?: number; full?: boolean }) => {
    await expect(widthToggle(page)).toHaveAccessibleName(`Session width: ${stateLabel(expected)}`);
    await expect(list(page)).toHaveAttribute('data-session-width', stateKey(expected));
    await expect(bottom(page)).toHaveAttribute('data-session-width', stateKey(expected));
    await showPin();
    const m = await measure(page);
    expect(m.pinWidth, `${where}: the pin is rendered`).toBeGreaterThan(0);
    const tol = m.gutter / 2 + 0.5;
    expect(Math.abs(m.listLeft - m.bottomLeft), `${where}: columns aligned`).toBeLessThanOrEqual(tol);
    expect(Math.abs(m.pinWidth - m.listWidth), `${where}: the pin column has the list's box`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinContentLeft - m.listContentLeft), `${where}: the pin column's content box is the list's`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinContentRight - m.listContentRight), `${where}: the pin column's content box is the list's`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinBubbleRight - m.liveBubbleRight), `${where}: the pinned bubble's right edge is the live prompt's`).toBeLessThanOrEqual(1);
    // Both bubbles span the column from its content left edge to its right edge, whatever the prompt's length.
    expect(Math.abs(m.pinBubbleLeft - m.liveBubbleLeft), `${where}: no horizontal shift into the pinned state`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.bodyRight - m.listContentRight), `${where}: assistant content tracks the column edge`).toBeLessThanOrEqual(1);
    return m;
  };
  const expectFills = (where: string, m: Awaited<ReturnType<typeof measure>>) => {
    expect(Math.abs(m.listWidth - m.scrollerClient), `${where}: the list fills the scroller`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.bottomWidth - m.mainWidth), `${where}: the bottom column fills main`).toBeLessThanOrEqual(0.5);
  };

  const widths: number[] = [];
  for (const state of WIDTH_STATES) {
    const where = stateLabel(state);
    await setWidth(page, state);
    const m = await expectColumnFollows(where, state);
    widths.push(m.listWidth);
    if (state.full) expectFills(where, m);
    else {
      expect(Math.abs(m.listWidth - state.width!), `${where}: the list is the setting's width`).toBeLessThanOrEqual(0.5);
      expect(m.listWidth, `${where} is below the available width`).toBeLessThan(m.scrollerClient - 1);
    }
    await test.info().attach(`width-${where.toLowerCase().replace(/\W+/g, '-')}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
  expect(widths[0], 'Normal < 896').toBeLessThan(widths[1]);
  expect(widths[1], '896 < Wide').toBeLessThan(widths[2]);
  expect(widths[2], 'Wide < Full').toBeLessThan(widths[3]);

  // (a) Dragged to the limit, the width stored is the shown px: the room less a gutter per side.
  await setWidth(page, { width: 768 });
  await dragToLimit(page);
  await expect(widthToggle(page)).toHaveAccessibleName(/^Session width: Resizable, \d+ px$/);
  const limit = Math.floor((await measure(page)).layerWidth - 2 * SESSION_WIDTH_GUTTER);
  const limited = await expectColumnFollows('limit', { width: limit });
  expect(Math.abs(limited.listWidth - (limited.scrollerClient - 2 * SESSION_WIDTH_GUTTER)), 'limit: a gutter clear per side').toBeLessThanOrEqual(0.5);

  // (b) Full keeps the width and has no handles; Resizable again restores both.
  await setWidth(page, { width: 896 });
  await widthToggle(page).click();
  await expect(widthToggle(page)).toHaveAccessibleName('Session width: Full');
  await expect(sessionHandle(page, 'right')).toHaveCount(0);
  await widthToggle(page).click();
  await expect(widthToggle(page)).toHaveAccessibleName('Session width: Resizable, 896 px');
  await expect(sessionHandle(page, 'right')).toHaveCount(1);
  await parkPointer(page);
  const restored = await expectColumnFollows('Full off again', { width: 896 });
  expect(Math.abs(restored.listWidth - 896), 'Full off: the list is the kept width again').toBeLessThanOrEqual(0.5);

  // (c) Both the width and Full survive a reload.
  await setWidth(page, { width: 896, full: true });
  await page.reload();
  await expect(widthToggle(page)).toHaveAccessibleName('Session width: Full');
  await expectFills('Full after reload', await expectColumnFollows('Full after reload', { full: true }));
  await setWidth(page, { full: false });
  const after = await expectColumnFollows('reload then Full off', { width: 896 });
  expect(Math.abs(after.listWidth - 896), 'the width survived the reload').toBeLessThanOrEqual(0.5);
}

/** The column's and handles' rects, in one evaluate. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => { const r = el!.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
    const scroller = document.querySelector('[data-conversation]') as HTMLElement;
    const handleRect = (edge: string) => rect(document.querySelector(`[data-session-handle=${edge}]`));
    return {
      list: rect(scroller.querySelector('[data-session-width]')),
      bottom: rect(document.querySelector('[data-session-body] > div[data-session-width]')),
      scroller: rect(scroller),
      scrollerClientLeft: scroller.clientLeft,
      scrollerClient: scroller.clientWidth,
      main: rect(document.querySelector('main')),
      layer: rect(document.querySelector('[data-session-handles]')),
      left: handleRect('left'),
      right: handleRect('right'),
      gutter: scroller.offsetWidth - scroller.clientWidth - 2 * scroller.clientLeft,
      cursors: ['left', 'right'].map((e) => getComputedStyle(document.querySelector(`[data-session-handle=${e}]`)!).cursor),
    };
  });
}
type Geometry = Awaited<ReturnType<typeof geometry>>;
const mid = (r: { left: number; width: number }) => r.left + r.width / 2;

async function onSessionPage(page: Page, cc: Ctx['cc'], name: string) {
  const { sessionId } = await spawnSession(cc, name);
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(sessionHandle(page, 'right')).toHaveCount(1);
}

// Invariants: both handles show a col-resize cursor, sit on the column's edges and span the transcript top to main's bottom; dragging either edge mirrors (2x) and keeps the column centred, live before release; a drag near Wide snaps; a double-click resets to Normal.
/** Desktop: real mouse drags of both handles, measured mid-drag and after release. */
export async function dragFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the handles are a desktop-layout feature');
  // Wide enough that Normal + 400 stays under the room.
  await page.setViewportSize({ width: 1760, height: 900 });
  await onSessionPage(page, cc, 'e2e-session-width-drag');
  await setWidth(page, { width: 768 });
  const centred = (g: Geometry, where: string) =>
    expect(Math.abs(mid(g.list) - mid(g.scroller)), `${where}: the column stays centred`).toBeLessThanOrEqual(g.gutter / 2 + 0.5);

  const g0 = await geometry(page);
  expect(g0.cursors, 'both handles show a col-resize cursor').toEqual(['col-resize', 'col-resize']);
  const tol = g0.gutter / 2 + 0.5;
  expect(Math.abs(mid(g0.left) - g0.bottom.left), 'left handle on the bottom box edge').toBeLessThanOrEqual(0.5);
  expect(Math.abs(mid(g0.right) - g0.bottom.right), 'right handle on the bottom box edge').toBeLessThanOrEqual(0.5);
  expect(Math.abs(mid(g0.left) - g0.list.left), 'left handle on the list edge').toBeLessThanOrEqual(tol);
  expect(Math.abs(mid(g0.right) - g0.list.right), 'right handle on the list edge').toBeLessThanOrEqual(tol);
  expect(Math.abs(g0.layer.top - g0.scroller.top), 'the handles start at the transcript top').toBeLessThanOrEqual(0.5);
  expect(Math.abs(g0.layer.bottom - g0.main.bottom), 'the handles end at main\'s bottom').toBeLessThanOrEqual(0.5);

  await dragSessionHandle(page, 'right', 100, { release: false });
  await expect.poll(async () => (await geometry(page)).list.width, { message: 'mid-drag: the list is 968 wide, live' }).toBeCloseTo(968, 0);
  const live = await geometry(page);
  expect(Math.abs(live.bottom.width - 968), 'mid-drag: the bottom box moves with it').toBeLessThanOrEqual(0.5);
  centred(live, 'mid-drag');
  await expect(layerList(page), 'mid-drag: the setting is not yet written').toHaveAttribute('data-session-width', '768');
  await page.mouse.up();
  await expect(layerList(page)).toHaveAttribute('data-session-width', '968');

  await dragSessionHandle(page, 'left', -100, { release: true });
  await expect(layerList(page)).toHaveAttribute('data-session-width', '1168');
  const wider = await geometry(page);
  expect(Math.abs(wider.list.width - 1168), 'the left handle grows the column').toBeLessThanOrEqual(0.5);
  centred(wider, 'after the left drag');

  await sessionHandle(page, 'left').dblclick();
  await expect(layerList(page), 'a double-click resets to Normal').toHaveAttribute('data-session-width', '768');

  await dragSessionHandle(page, 'right', 124, { release: false });
  await expect.poll(async () => (await geometry(page)).list.width, { message: 'mid-drag near Wide: snapped to 1024' }).toBeCloseTo(1024, 0);
  await page.mouse.up();
  await expect(layerList(page)).toHaveAttribute('data-session-width', '1024');
  await test.info().attach('width-drag-wide', { body: await page.screenshot(), contentType: 'image/png' });
}

// Invariants: there is no fixed maximum (a width past the old cap works and persists); a drag stops a gutter clear per side of the room and stores that px; a stored width wider than the window renders clamped and survives.
/** Desktop on a very wide window: past the old cap, the limit, and a narrower window. */
export async function roomFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the handles are a desktop-layout feature');
  await page.setViewportSize({ width: 2560, height: 1000 });
  await onSessionPage(page, cc, 'e2e-session-width-room');
  await setWidth(page, { width: 768 });
  await dragSessionHandle(page, 'right', 500, { release: true });
  await expect(layerList(page)).toHaveAttribute('data-session-width', '1768');
  const wide = await geometry(page);
  expect(Math.abs(wide.list.width - 1768), 'a width past the old cap').toBeLessThanOrEqual(0.5);
  expect(Math.abs(mid(wide.list) - mid(wide.scroller)), 'centred').toBeLessThanOrEqual(wide.gutter / 2 + 0.5);
  await page.reload();
  await expect(layerList(page)).toHaveAttribute('data-session-width', '1768');

  await setWidth(page, { width: 768 });
  await dragToLimit(page);
  const limit = Math.floor((await geometry(page)).layer.width - 2 * SESSION_WIDTH_GUTTER);
  await expect(layerList(page), 'the limit stores the shown px').toHaveAttribute('data-session-width', String(limit));
  const g = await geometry(page);
  expect(Math.abs(g.list.left - (g.scroller.left + g.scrollerClientLeft + SESSION_WIDTH_GUTTER)), 'a gutter clear on the left').toBeLessThanOrEqual(0.5);

  await setWidth(page, { width: 1768 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => { const n = await geometry(page); return n.list.width; }, { message: 'a narrower window clamps the shown width' })
    .toBeCloseTo((await geometry(page)).scrollerClient - 2 * SESSION_WIDTH_GUTTER, 0);
  await expect(layerList(page), 'the preference outlives the narrower window').toHaveAttribute('data-session-width', '1768');
  await page.setViewportSize({ width: 2560, height: 1000 });
  await expect.poll(async () => (await geometry(page)).list.width, { message: 'widening restores the width' }).toBeCloseTo(1768, 0);
}

// Invariant: the phone drawer offers no width control, and the session page has no handles.
/** Drawer viewports: the open drawer has the theme toggle but no width control. */
export async function drawerHasNoControlFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'a desktop has the column, not the drawer');
  const { sessionId } = await spawnSession(cc, `e2e-session-width-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  // The composer is the must-match query: the session is rendered, so no handle is absent for want of a page.
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(page.locator('[data-session-handle]')).toHaveCount(0);
  await next.openSidebar(page);
  // Must-match query first: while the drawer closes the page is aria-hidden and an absence check passes vacuously.
  await expect(page.getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Session width/ })).toHaveCount(0);
}
