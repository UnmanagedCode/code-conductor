// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin dock as the app mounts it: the desktop column right of the session
// whose width is its mode — an icon rail, a split beside the transcript, or the
// full view — with the one frame host never moving, so no mode change reloads a
// page, and the dock's own place kept off the hash.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import {
  column, dockHandle, dragBy, emitWidth, endHost, go, host, keepRow, mountApp, net, plainRow, pluginView, postRoute, rail, railButton,
  residentFrame, resetHost, settle, sharedFrame, shownFrames, standInWindow, stubResizeObserver, viewOpen,
} from './test/pluginHost';
import { DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from './dockLayout';
import { DOCK_STORAGE_KEY, DOCK_WIDTH_STORAGE_KEY } from './dock';

const ANCHOR = '#session=sess-1';
/** Two apps, one plain and one keep-alive, in catalog order. */
const CATALOG = [
  { id: 'alpha', name: 'Alpha', enabled: true, hasFrontend: true, frontendKeepAlive: false, state: 'ready' },
  { id: 'beta', name: 'Beta', enabled: true, hasFrontend: true, frontendKeepAlive: true, state: 'ready' },
];
/** The fixture width: not the dock's default. */
const W = 520;

const sessionShown = () => document.querySelector('[data-view="session"]') !== null;
const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
const statusReads = (id: string) => net.calls.filter((c) => c === `GET /api/plugins/${id}/status`).length;
const current = () => rail()?.querySelector('[aria-current="true"]')?.getAttribute('aria-label') ?? null;
const colWidth = () => parseInt(column()!.style.width, 10);

/** The dock handle, asserted present. */
function handle() {
  const h = dockHandle();
  expect(h, 'the dock resize handle').not.toBeNull();
  return h!;
}
/** The handle's aria-valuenow. */
const now = () => Number(handle().getAttribute('aria-valuenow'));

/** Clicks a rail control, asserted present. */
async function press(label: string) {
  const b = railButton(label);
  expect(b, `the rail's "${label}" control`).not.toBeNull();
  await act(async () => { fireEvent.click(b!); });
  await settle();
}
/** Escape, as the user presses it with nothing else open. */
async function escape() {
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await settle();
}
async function key(k: string) {
  await act(async () => { fireEvent.keyDown(handle(), { key: k }); });
  await settle();
}
async function drag(dx: number) {
  dragBy(handle(), dx);
  await settle();
}

/** Split: the plugin section shown beside the session. */
function expectSplit(what: string) {
  expect(viewOpen(), `${what}: the plugin section shown`).toBe(true);
  expect(sessionShown(), `${what}: beside the session`).toBe(true);
}
/** Rail: the icon strip only, no frame shown, the session full width. */
function expectRail(what: string) {
  expect(rail(), `${what}: the rail`).not.toBeNull();
  expect(viewOpen(), `${what}: the plugin section hidden`).toBe(false);
  expect(shownFrames(), `${what}: no frame shown`).toEqual([]);
  expect(sessionShown(), `${what}: the session`).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  resetHost(`/${ANCHOR}`);
  net.catalog = CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});

// The dock's place outlives a mount (it is the user's, persisted), so each
// test hands the next one a closed dock on Alpha at '/' through the rail itself.
afterEach(async () => {
  vi.restoreAllMocks();
  await go(ANCHOR);
  emitWidth(10_000);
  if (rail()) {
    if (current() !== 'Beta') await press('Beta');
    await press('Alpha');
    await press('Alpha');
  }
  await endHost();
});

describe('the plugin dock', () => {
  it('with no app in the catalog there is no rail and no handle, and the column is hidden', async () => {
    // Invariant (characterization): the dock costs nothing until a plugin contributes a frontend.
    net.catalog = [];
    await mountApp();
    expect(rail()).toBeNull();
    expect(dockHandle()).toBeNull();
    expect(column(), 'the column is mounted').not.toBeNull();
    expect(column()!.dataset.dockMode).toBe('hidden');
    expect(viewOpen()).toBe(false);
  });

  it('beside a session the rail lists one button per app in catalog order, and the hash is untouched', async () => {
    // Invariant (1): on desktop a session view shows the rail with every catalog app, without moving the route.
    await mountApp();
    expect(rail(), 'the rail').not.toBeNull();
    const apps = [...rail()!.querySelectorAll('[data-rail-app]')];
    expect(apps.map((b) => b.getAttribute('data-rail-app'))).toEqual(['alpha', 'beta']);
    expect(apps.map((b) => b.getAttribute('aria-label'))).toEqual(['Alpha', 'Beta']);
    expect(location.hash).toBe(ANCHOR);
    expect(viewOpen(), 'nothing docked open yet').toBe(false);
  });

  it('clicking an app opens it in split beside the session, with no route or history change, and marks it current', async () => {
    // Invariant (2, 7): split shows the plugin and the session together; the dock is not a route, so the hash and history stay put.
    await mountApp();
    const entries = history.length;
    await press('Alpha');
    expectSplit('Alpha docked');
    expect(pluginView().getAttribute('aria-hidden')).toBe('false');
    expect(sharedFrame()?.getAttribute('src')).toBe('/plugins/alpha/');
    expect(now()).toBeGreaterThan(0);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(entries);
    expect(current()).toBe('Alpha');
  });

  it('the docked app\'s icon collapses it, another icon swaps, and collapsing leaves a keep-alive frame resident', async () => {
    // Invariant (2, 6): rail clicks collapse or swap; leaving split by either ends a plain frame and only hides a keep-alive one.
    await mountApp();
    await press('Alpha');
    const a = sharedFrame();
    expect(a, 'fixture check: Alpha\'s frame').not.toBeNull();
    await press('Alpha');
    expectRail('Alpha collapsed');
    expect(a!.isConnected, 'a plain frame ends').toBe(false);
    await press('Beta');
    expectSplit('Beta docked');
    const b = residentFrame('beta');
    expect(b, 'Beta\'s resident frame').not.toBeNull();
    const startsBefore = starts();
    await press('Alpha');
    expectSplit('Alpha swapped in');
    expect(current()).toBe('Alpha');
    expect(b!.isConnected && b!.hidden, 'Beta\'s resident frame stays, hidden').toBe(true);
    await press('Beta');
    expect(residentFrame('beta') === b, 'Beta swapped back is the same node').toBe(true);
    await press('Beta');
    expectRail('Beta collapsed');
    expect(b!.isConnected && b!.hidden, 'collapsing keeps Beta resident').toBe(true);
    expect(starts(), 'no new /start').toBe(startsBefore);
  });

  it('Expand to full view and Escape back to split keep a plain plugin\'s frame: same node, same src, no status read, nothing posted', async () => {
    // Invariant (4, 5, 6): split ↔ full is a width change of the same column; entering full pushes one entry, Escape steps back to split, and the page never reloads.
    await mountApp();
    await press('Alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    const reads = statusReads('alpha');
    await press('Expand to full view');
    expect(location.hash).toBe('#plugin/alpha/');
    expect(history.state?.ccView).toBe(1);
    expect(sessionShown(), 'the session view is gone').toBe(false);
    expect(viewOpen()).toBe(true);
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(statusReads('alpha'), 'no extra status read').toBe(reads);
    expect(win.posted, 'nothing posted').toEqual([]);
    await escape();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('Escape from full');
    expect(sharedFrame() === frame, 'still the same frame node').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(win.posted).toEqual([]);
  });

  it('the same round trip keeps a keep-alive plugin\'s resident frame with no /start', async () => {
    // Invariant (6): full ↔ split never re-creates a resident frame.
    await mountApp();
    await press('Beta');
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const startsBefore = starts();
    await press('Expand to full view');
    expect(location.hash).toBe('#plugin/beta/');
    expect(residentFrame('beta') === frame && !frame.hidden, 'the same node, shown').toBe(true);
    await escape();
    expectSplit('Escape from full');
    expect(residentFrame('beta') === frame && !frame.hidden, 'the same node, shown').toBe(true);
    expect(starts()).toBe(startsBefore);
  });

  it('Dock to side from full view lands in split at the page\'s own route with the same frame, posting nothing', async () => {
    // Invariant (4, 6): the full view's in-frame navigation carries into the dock, so docking sends no stale navigate.
    await mountApp();
    await go('#plugin/alpha/');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    postRoute(win, '/inner');
    await settle();
    expect(location.hash).toBe('#plugin/alpha/inner');
    await press('Dock to side');
    expect(location.hash).toBe(ANCHOR);
    expectSplit('docked from full');
    expect(current()).toBe('Alpha');
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(win.posted, 'nothing posted').toEqual([]);
  });

  it('Escape from the full view of an undocked plugin leaves the dock as it was: split on the docked app, or the rail', async () => {
    // Invariant (5): Escape only leaves the full view; where it lands is the dock state, which it never changes.
    await mountApp();
    await press('Beta');
    const beta = residentFrame('beta')!;
    expect(beta, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const startsBefore = starts();
    await go('#plugin/alpha/');
    const alpha = sharedFrame();
    expect(alpha, 'fixture check: Alpha in full view').not.toBeNull();
    await escape();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('Escape with Beta docked');
    expect(current()).toBe('Beta');
    expect(residentFrame('beta') === beta && beta.isConnected && !beta.hidden, 'Beta\'s same node, shown').toBe(true);
    expect(alpha!.isConnected, 'Alpha\'s plain frame ended').toBe(false);
    expect(starts(), 'no new /start').toBe(startsBefore);

    await press('Beta');
    expectRail('fixture check: Beta collapsed');
    await go('#plugin/alpha/');
    expect(viewOpen(), 'fixture check: Alpha in full view').toBe(true);
    await escape();
    expect(location.hash).toBe(ANCHOR);
    expectRail('Escape with the dock closed');
  });

  it('Escape in split changes nothing', async () => {
    // Invariant (5): only the full view closes on Escape; split is not a view to leave.
    await mountApp();
    await press('Alpha');
    const frame = sharedFrame();
    const back = vi.spyOn(history, 'back');
    await escape();
    expect(back).not.toHaveBeenCalled();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('after Escape');
    expect(sharedFrame() === frame, 'the same frame').toBe(true);
  });

  it('a docked page\'s own navigation never reaches the hash, and reopening the dock resumes there', async () => {
    // Invariant (7): in split the frame's route mirrors into the dock's saved subpath, not the URL.
    await mountApp();
    await press('Alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const replace = vi.spyOn(history, 'replaceState');
    postRoute(standInWindow(frame), '/deep');
    await settle();
    expect(location.hash).toBe(ANCHOR);
    expect(replace.mock.calls.filter((c) => String(c[2]).includes('#plugin')), 'no #plugin URL written').toEqual([]);
    await press('Alpha');
    expectRail('fixture check: collapsed');
    await press('Alpha');
    const fresh = sharedFrame();
    expect(fresh !== null && fresh !== frame, 'a fresh frame').toBe(true);
    expect(fresh!.getAttribute('src')).toBe('/plugins/alpha/deep');
  });

  it('dragging the handle resizes split, past the minimum collapses to the rail, from the rail opens split, and past the transcript limit opens the full view', async () => {
    // Invariant (3, 7): the drag's release decides the mode on the raw width; only the snap to full pushes history.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await press('Alpha');
    expectSplit('fixture check: Alpha docked');
    const entries = history.length;
    const before = now();
    const colBefore = colWidth();
    await drag(40);
    expect(now(), 'narrowed by 40').toBe(before - 40);
    expect(colWidth(), 'the column follows').toBe(colBefore - 40);
    await drag(400);
    expectRail('dragged past the minimum');
    await drag(-450);
    expectSplit('dragged open from the rail');
    expect(now()).toBe(450);
    expect(history.length, 'drags inside the dock push nothing').toBe(entries);
    await drag(-2000);
    expect(location.hash).toBe('#plugin/alpha/');
    expect(history.length, 'one entry pushed').toBe(entries + 1);
    expect(sessionShown()).toBe(false);
  });

  it('a double-click collapses split and a second reopens it at the width it had', async () => {
    // Invariant (3): collapsing keeps the stored width, so reopening restores it.
    await mountApp();
    expect(rail(), 'fixture check: the rail').not.toBeNull();
    await drag(-W);
    expectSplit('fixture check: dragged open');
    expect(now()).toBe(W);
    await act(async () => { fireEvent.doubleClick(handle()); });
    await settle();
    expectRail('double-click in split');
    expect(now()).toBe(0);
    await act(async () => { fireEvent.doubleClick(handle()); });
    await settle();
    expectSplit('double-click on the rail');
    expect(now()).toBe(W);
  });

  it('the handle is keyboard operable: focusable, its maximum follows the window, the arrows resize and Enter toggles', async () => {
    // Invariant (9): the dock handle is a window splitter whose range is what the transcript leaves free.
    stubResizeObserver();
    await mountApp();
    emitWidth(1000);
    await drag(-W);
    expectSplit('fixture check: docked at W');
    expect(handle().tabIndex).toBe(0);
    const max1000 = Number(handle().getAttribute('aria-valuemax'));
    emitWidth(1100);
    expect(Number(handle().getAttribute('aria-valuemax')) - max1000).toBe(100);
    await key('ArrowLeft');
    const grown = now();
    expect(grown).toBeGreaterThan(W);
    await key('ArrowRight');
    expect(now()).toBe(W);
    await key('Enter');
    expectRail('Enter in split');
    await key('Enter');
    expectSplit('Enter on the rail');
    expect(now()).toBe(W);
  });

  it('a window too narrow for the transcript beside the dock collapses it to the rail without forgetting it, and widening restores it', async () => {
    // Invariant (8): auto-collapse is derived from the window, never written: the preferred width and the docked app survive.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await drag(-W);
    expectSplit('fixture check: docked at W');
    const docked = current();
    const frame = sharedFrame();
    const setItem = vi.spyOn(localStorage, 'setItem');
    emitWidth(700);
    await settle();
    expectRail('narrow window');
    expect(frame!.isConnected, 'the plain frame left').toBe(false);
    expect(setItem, 'nothing written').not.toHaveBeenCalled();
    emitWidth(1100);
    await settle();
    expectSplit('wide again');
    expect(now()).toBe(W);
    expect(current()).toBe(docked);
  });

  it('the frame host keeps its node through rail, split, full, split and rail', async () => {
    // Invariant (6, structure): the host the frames live in is never re-parented or re-created by a mode change.
    await mountApp();
    const h = host();
    expect(h, 'the host').not.toBeNull();
    await press('Alpha');
    expect(host() === h, 'split').toBe(true);
    await press('Expand to full view');
    expect(host() === h, 'full').toBe(true);
    await escape();
    expect(host() === h, 'split again').toBe(true);
    await press('Alpha');
    expect(host() === h, 'rail').toBe(true);
  });

  it('below md the dock is gone: no rail, no handle, the section hidden; a plugin hash still opens the full view; back above md split returns', async () => {
    // Invariant (mobile): the phone layout is unchanged; the dock state waits for a desktop width.
    let wide = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      get matches() { return /min-width/.test(query) && wide; },
      onchange: null,
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
      addListener: (fn: () => void) => listeners.add(fn),
      removeListener: (fn: () => void) => listeners.delete(fn),
      dispatchEvent: () => true,
    }));
    const cross = (v: boolean) => act(() => { wide = v; for (const fn of [...listeners]) fn(); });
    await mountApp();
    await press('Alpha');
    expectSplit('fixture check: docked on desktop');
    cross(false);
    await settle();
    expect(rail(), 'no rail').toBeNull();
    expect(dockHandle(), 'no handle').toBeNull();
    expect(viewOpen(), 'the section hidden').toBe(false);
    await go('#plugin/alpha/');
    expect(viewOpen(), 'a plugin hash opens the full view').toBe(true);
    expect(rail(), 'without a rail').toBeNull();
    await go(ANCHOR);
    expect(viewOpen()).toBe(false);
    cross(true);
    await settle();
    expectSplit('desktop again');
    expect(current()).toBe('Alpha');
  });
});

/** A main row `px` wider than what the rail and the transcript floor take. */
const roomFor = (px: number) => px + DOCK_RAIL_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH;
const widthWrites = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === DOCK_WIDTH_STORAGE_KEY);
const storedDock = () => JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null');

/** The rail actions that open the dock: an app's icon, and the handle's Enter, double-click and grow key. */
const OPENERS = {
  'the app icon': () => press('Alpha'),
  'Enter on the handle': () => key('Enter'),
  'a double-click on the handle': async () => { await act(async () => { fireEvent.doubleClick(handle()); }); await settle(); },
  'the grow key': () => key('ArrowLeft'),
} as const;
const openerNames = Object.keys(OPENERS) as (keyof typeof OPENERS)[];

describe('opening the dock from the rail', () => {
  it('the grow key on a collapsed dock reopens split at the stored width and writes no width', async () => {
    // Invariant: opening from the rail never overwrites the stored width; only a resize within split or a drag release persists one.
    await mountApp();
    await drag(-W);
    expectSplit('fixture check: docked at W');
    await press('Alpha');
    expectRail('fixture check: collapsed');
    const setItem = vi.spyOn(localStorage, 'setItem');
    await key('ArrowLeft');
    expectSplit('the grow key');
    expect(now()).toBe(W);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(W));
    expect(widthWrites(setItem), 'no width written').toEqual([]);
  });

  it.each(openerNames)('when no split width fits, %s opens the full view with one history entry', async (opener) => {
    // Invariant: a window too narrow for any split turns every rail open into the full view instead of a silent no-op.
    stubResizeObserver();
    await mountApp();
    emitWidth(roomFor(DOCK_PANEL_MIN_WIDTH - 1));
    expectRail('fixture check: on the rail');
    const entries = history.length;
    await OPENERS[opener]();
    expect(location.hash).toBe('#plugin/alpha/');
    expect(history.length, 'one entry pushed').toBe(entries + 1);
    expect(viewOpen()).toBe(true);
    expect(sessionShown(), 'the full view').toBe(false);
  });

  it.each([
    ['below the minimum stays on the rail', DOCK_PANEL_MIN_WIDTH - 1, null],
    ['at the minimum opens the full view', DOCK_PANEL_MIN_WIDTH, '#plugin/alpha/'],
  ] as const)('when no split width fits, a drag from the rail released %s', async (_what, dx, hash) => {
    // Invariant: with no room for split a release snaps to the rail below DOCK_PANEL_MIN_WIDTH and to the full view otherwise.
    stubResizeObserver();
    await mountApp();
    emitWidth(roomFor(DOCK_PANEL_MIN_WIDTH - 1));
    await drag(-dx);
    if (hash === null) {
      expectRail('released below the minimum');
      expect(location.hash).toBe(ANCHOR);
    } else {
      expect(location.hash).toBe(hash);
      expect(sessionShown()).toBe(false);
    }
  });

  it.each(openerNames)('on a dock auto-collapsed by a narrow window, %s opens split at the widest width that fits and keeps the stored width', async (opener) => {
    // Invariant: a rail open always shows something and never rewrites the stored width or flips the persisted dock; widening returns to the stored width.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await drag(-W);
    expectSplit('fixture check: docked at W');
    const narrow = 900;
    expect(roomFor(W), 'fixture check: W does not fit the narrow window').toBeGreaterThan(narrow);
    emitWidth(narrow);
    await settle();
    expectRail('fixture check: auto-collapsed');
    const setItem = vi.spyOn(localStorage, 'setItem');
    await OPENERS[opener]();
    expectSplit(opener);
    expect(current()).toBe('Alpha');
    expect(now(), 'the widest split that fits').toBe(narrow - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY), 'the stored width kept').toBe(String(W));
    expect(widthWrites(setItem), 'no width written').toEqual([]);
    expect(storedDock()).toMatchObject({ id: 'alpha', open: true });
    emitWidth(1100);
    await settle();
    expectSplit('wide again');
    expect(now()).toBe(W);
  });

  it('before the first measurement the handle has a finite maximum and a drag can commit no unbounded width', async () => {
    // Invariant: aria-valuemax is always a finite number and a committed width is always finite and bounded, even before the main row is measured.
    await mountApp();
    await press('Alpha');
    expectSplit('fixture check: docked');
    const max = Number(handle().getAttribute('aria-valuemax'));
    expect(Number.isFinite(max), `aria-valuemax ${handle().getAttribute('aria-valuemax')}`).toBe(true);
    await drag(-5000);
    const stored = localStorage.getItem(DOCK_WIDTH_STORAGE_KEY);
    expect(stored === null || Number(stored) <= max, `stored width ${stored} within ${max}`).toBe(true);
  });

  it('a collapsed dock marks its docked app current on the rail, and the full view marks the shown app alone', async () => {
    // Invariant: the rail always tells which app it shows or would reopen: aria-current on the shown app, else on the docked one.
    await mountApp();
    await press('Alpha');
    await press('Alpha');
    expectRail('fixture check: collapsed');
    expect(current(), 'the docked app').toBe('Alpha (docked)');
    await go('#plugin/beta/');
    expect(rail()!.querySelectorAll('[aria-current="true"]').length).toBe(1);
    expect(current(), 'the shown app').toBe('Beta');
  });
});

describe('a squeezed split and the rail\'s names', () => {
  it('an arrow key that cannot move a squeezed split writes nothing', async () => {
    // Invariant: a key that does not change the shown width writes no width; the stored preference survives.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await drag(-W);
    expectSplit('fixture check: docked at W');
    const narrow = 900;
    emitWidth(narrow);
    await settle();
    await key('Enter');
    const squeezed = narrow - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH;
    expectSplit('fixture check: squeezed open');
    expect(now(), 'fixture check: squeezed to the widest fit').toBe(squeezed);
    const setItem = vi.spyOn(localStorage, 'setItem');
    await key('ArrowLeft');
    expect(now(), 'the panel did not move').toBe(squeezed);
    expect(widthWrites(setItem), 'no width written').toEqual([]);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(W));
  });

  it('the docked app\'s icon is named "<label> (docked)" while collapsed and "<label>" while shown, current in both', async () => {
    // Invariant: a screen reader tells the shown app from the docked-but-collapsed one by name, while aria-current marks either.
    await mountApp();
    await press('Alpha');
    const shown = within(rail()!).queryByRole('button', { name: 'Alpha' });
    expect(shown, 'shown: named by its label').not.toBeNull();
    expect(shown!.getAttribute('aria-current')).toBe('true');
    await press('Alpha');
    expectRail('fixture check: collapsed');
    const docked = within(rail()!).queryByRole('button', { name: 'Alpha (docked)' });
    expect(docked, 'collapsed: named as docked').not.toBeNull();
    expect(docked!.getAttribute('aria-current')).toBe('true');
    expect(within(rail()!).queryByRole('button', { name: 'Beta' }), 'another app keeps its label').not.toBeNull();
  });
});

describe('the dock\'s own place', () => {
  it('a drag from the rail opens the docked app, not the first in the catalog', async () => {
    // Invariant: dockTarget prefers the docked app while the catalog lists it.
    await mountApp();
    await press('Beta');
    await press('Beta');
    expectRail('fixture check: Beta docked and collapsed');
    await drag(-W);
    expectSplit('dragged open');
    expect(current()).toBe('Beta');
    expect(residentFrame('beta'), 'Beta\'s frame').not.toBeNull();
    expect(sharedFrame(), 'no Alpha frame').toBeNull();
  });

  it('the docked app\'s navigation in the full view carries back into split with no stale navigate', async () => {
    // Invariant: fullMirror records the docked plugin's route into the dock as well as the hash, so Escape back to split posts nothing and keeps the frame.
    await mountApp();
    await press('Alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    await press('Expand to full view');
    expect(location.hash, 'fixture check: full view').toBe('#plugin/alpha/');
    postRoute(win, '/moved');
    await settle();
    expect(location.hash, 'the hash follows in full view').toBe('#plugin/alpha/moved');
    await escape();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('Escape from full');
    expect(current()).toBe('Alpha');
    expect(storedDock()?.subpath, 'the dock\'s subpath').toBe('/moved');
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(win.posted, 'nothing posted').toEqual([]);
  });
});

describe('round-2 gaps', () => {
  it('a squeeze ends once the stored width fits again, so the next narrowing collapses to the rail', async () => {
    // Invariant: the transient squeeze never outlives its need; auto-collapse (criterion 8) holds after a squeezed open.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await drag(-W);
    emitWidth(900);
    await settle();
    await key('Enter');
    expectSplit('fixture check: squeezed open');
    emitWidth(1100);
    await settle();
    expectSplit('fixture check: wide again');
    expect(now(), 'fixture check: at the stored width').toBe(W);
    emitWidth(900);
    await settle();
    expectRail('narrowed again');
  });

  it('a drag from a collapsed rail past the transcript limit docks its target, so Escape lands in split', async () => {
    // Invariant: a release snapping to the full view from a closed dock opens the dock on that app first.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await press('Alpha');
    await press('Alpha');
    expect(storedDock(), 'fixture check: Alpha docked and closed').toMatchObject({ id: 'alpha', open: false });
    await drag(-(1100 - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH + 1));
    expect(location.hash, 'fixture check: snapped to the full view').toBe('#plugin/alpha/');
    await escape();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('Escape from full');
    expect(current()).toBe('Alpha');
  });

  it('mid-drag the column follows the live panel width, before the release', async () => {
    // Invariant: the column's width is the live width plus the rail while the pointer moves, not only after pointerup.
    await mountApp();
    await press('Alpha');
    expectSplit('fixture check: docked');
    const start = now();
    const h = handle();
    act(() => {
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 540, pointerId: 1 }));
    });
    expect(now(), 'the live width').toBe(start - 40);
    expect(colWidth(), 'the column follows mid-drag').toBe(start - 40 + DOCK_RAIL_WIDTH);
    act(() => { h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 540, pointerId: 1 })); });
    await settle();
  });
});

