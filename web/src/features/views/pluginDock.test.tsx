// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin dock as the app mounts it: the desktop column right of the session
// whose width is its mode — hidden, a split beside the transcript, or the whole
// row — with its one mode toggle in the column's bar, the handle's clamps and
// reset, a window too narrow for a split, and the one frame host never moving,
// so no mode change reloads a page.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';

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
  checkedNow, column, columnButtons, DOCK_CATALOG, dockHandle, dockSplit, dragBy, emitWidth, endHost, go, host, keepRow, mountApp, net,
  pickApp, plainRow, postRoute, pressColumn, residentFrame, resetHost, sessionShown, settle, sharedFrame, standInWindow, stubResizeObserver,
  viewOpen,
} from './test/pluginHost';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from './dockLayout';
import { DOCK_WIDTH_STORAGE_KEY, dockStore, readDockState } from './dock';

const ANCHOR = '#session=sess-1';
/** The fixture width: not the dock's default. */
const W = 520;
const WIDE = 1100;

const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
const statusReads = (id: string) => net.calls.filter((c) => c === `GET /api/plugins/${id}/status`).length;
const colWidth = () => parseInt(column()!.style.width, 10);
const widthWrites = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === DOCK_WIDTH_STORAGE_KEY);

/** The dock handle, asserted present. */
function handle() {
  const h = dockHandle();
  expect(h, 'the dock resize handle').not.toBeNull();
  return h!;
}
/** The handle's aria-valuenow. */
const now = () => Number(handle().getAttribute('aria-valuenow'));

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
/** Alpha in split at W. */
async function dockAtW() {
  await dockSplit('alpha');
  await drag(DOCK_PANEL_DEFAULT_WIDTH - W);
  expect(now(), 'fixture check: docked at W').toBe(W);
}

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await go(ANCHOR);
  await endHost();
});

describe('the plugin dock', () => {
  it('with no app in the catalog there is no handle and no mode toggle, and the column is hidden', async () => {
    // Invariant (characterization): the dock costs nothing until a plugin contributes a frontend.
    net.catalog = [];
    await mountApp();
    expect(dockHandle()).toBeNull();
    expect(columnButtons()).not.toContain('Dock to side');
    expect(columnButtons()).not.toContain('Expand to full view');
    expect(column(), 'the column is mounted').not.toBeNull();
    expect(column()!.dataset.dockMode).toBe('hidden');
    expect(viewOpen()).toBe(false);
  });

  it('the column\'s only control is the mode toggle: Expand to full view in split, Dock to side in full, and there is no rail', async () => {
    // Invariant (F1): the switcher picks the plugin; the column carries nothing but the full ⇄ split toggle.
    await mountApp();
    await dockSplit('alpha');
    expect(columnButtons(), 'split').toEqual(['Expand to full view']);
    await pressColumn('Expand to full view');
    expect(location.hash, 'fixture check: expanded').toBe('#plugin/alpha/');
    expect(columnButtons(), 'full').toEqual(['Dock to side']);
    expect(column()!.querySelector('nav'), 'no navigation strip').toBeNull();
  });

  it('Expand to full view and Dock to side keep a plain plugin\'s frame: same node, same src, no status read, nothing posted', async () => {
    // Invariant (F1, characterization): split ↔ full is a width change of the same column; Expand pushes one entry, Dock to side steps back, and the page never reloads.
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    const reads = statusReads('alpha');
    await pressColumn('Expand to full view');
    expect(location.hash).toBe('#plugin/alpha/');
    expect(history.state?.ccView).toBe(1);
    expect(sessionShown(), 'the session view is gone').toBe(false);
    expect(viewOpen()).toBe(true);
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(statusReads('alpha'), 'no extra status read').toBe(reads);
    expect(win.posted, 'nothing posted').toEqual([]);
    await pressColumn('Dock to side');
    expect(location.hash).toBe(ANCHOR);
    expectSplit('docked again');
    expect(sharedFrame() === frame, 'still the same frame node').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(win.posted).toEqual([]);
  });

  it('the same round trip keeps a keep-alive plugin\'s resident frame with no /start', async () => {
    // Invariant (F1, characterization): full ↔ split never re-creates a resident frame.
    await mountApp();
    await dockSplit('beta');
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const startsBefore = starts();
    await pressColumn('Expand to full view');
    expect(location.hash).toBe('#plugin/beta/');
    expect(residentFrame('beta') === frame && !frame.hidden, 'the same node, shown').toBe(true);
    await pressColumn('Dock to side');
    expectSplit('docked again');
    expect(residentFrame('beta') === frame && !frame.hidden, 'the same node, shown').toBe(true);
    expect(starts()).toBe(startsBefore);
  });

  it('Dock to side from a linked full view lands in split at the page\'s own route with the same frame, posting nothing', async () => {
    // Invariant (F1, characterization): the full view's in-frame navigation carries into the dock, so docking sends no stale navigate.
    await mountApp();
    await go('#plugin/alpha/');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    postRoute(win, '/inner');
    await settle();
    expect(location.hash).toBe('#plugin/alpha/inner');
    await pressColumn('Dock to side');
    expect(location.hash).toBe(ANCHOR);
    expectSplit('docked from full');
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(win.posted, 'nothing posted').toEqual([]);
  });

  it('a docked page\'s own navigation never reaches the hash, and Expand to full view carries it into the URL', async () => {
    // Invariant (characterization): in split the frame's route mirrors into the dock's saved subpath, not the URL; expanding opens the full view there.
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const replace = vi.spyOn(history, 'replaceState');
    const win = standInWindow(frame);
    postRoute(win, '/deep');
    await settle();
    expect(location.hash).toBe(ANCHOR);
    expect(replace.mock.calls.filter((c) => String(c[2]).includes('#plugin')), 'no #plugin URL written').toEqual([]);
    await pressColumn('Expand to full view');
    expect(location.hash).toBe('#plugin/alpha/deep');
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(win.posted, 'nothing posted').toEqual([]);
  });

  it('the frame host keeps its node through split, full, split and hidden', async () => {
    // Invariant (characterization): the host the frames live in is never re-parented or re-created by a mode change.
    await mountApp();
    const h = host();
    expect(h, 'the host').not.toBeNull();
    await dockSplit('alpha');
    expect(host() === h, 'split').toBe(true);
    await pressColumn('Expand to full view');
    expect(host() === h, 'full').toBe(true);
    await pressColumn('Dock to side');
    expect(host() === h, 'split again').toBe(true);
    await pickApp('conductor');
    expect(host() === h, 'hidden').toBe(true);
  });
});

describe('the handle', () => {
  it('a drag below the minimum stops at DOCK_PANEL_MIN_WIDTH and split stays', async () => {
    // Invariant (F8): the handle only resizes; its floor is DOCK_PANEL_MIN_WIDTH, never a snap to another mode.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockSplit('alpha');
    await drag(400);
    expectSplit('dragged below the minimum');
    expect(now()).toBe(DOCK_PANEL_MIN_WIDTH);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_PANEL_MIN_WIDTH));
  });

  it('a drag past the transcript limit stops there: split stays, no route change, no history entry', async () => {
    // Invariant (F8): the handle's ceiling leaves the transcript DOCK_TRANSCRIPT_MIN_WIDTH; a drag never opens the full view.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockSplit('alpha');
    const entries = history.length;
    await drag(-2000);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length, 'no history entry').toBe(entries);
    expectSplit('dragged past the limit');
    expect(now()).toBe(WIDE - DOCK_TRANSCRIPT_MIN_WIDTH);
  });

  it.each(['a double-click', 'Enter'] as const)('%s on the handle resets split to the default width', async (how) => {
    // Invariant (F8): the handle's toggle resets the width to DOCK_PANEL_DEFAULT_WIDTH and forgets the stored one; split stays.
    await mountApp();
    await dockAtW();
    if (how === 'Enter') await key('Enter');
    else { await act(async () => { fireEvent.doubleClick(handle()); }); await settle(); }
    expectSplit(how);
    expect(now()).toBe(DOCK_PANEL_DEFAULT_WIDTH);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY), 'the stored width removed').toBeNull();
  });

  it('the handle is keyboard operable: focusable, its range is DOCK_PANEL_MIN_WIDTH to what the transcript leaves, the arrows resize', async () => {
    // Invariant (F8): the dock handle is a window splitter whose range is the panel floor to what the transcript leaves free.
    stubResizeObserver();
    await mountApp();
    emitWidth(1000);
    await dockAtW();
    expect(handle().tabIndex).toBe(0);
    expect(handle().getAttribute('aria-valuemin')).toBe(String(DOCK_PANEL_MIN_WIDTH));
    expect(handle().getAttribute('aria-valuemax')).toBe(String(1000 - DOCK_TRANSCRIPT_MIN_WIDTH));
    emitWidth(WIDE);
    expect(handle().getAttribute('aria-valuemax'), 'the maximum follows the window').toBe(String(WIDE - DOCK_TRANSCRIPT_MIN_WIDTH));
    await key('ArrowLeft');
    expect(now()).toBeGreaterThan(W);
    await key('ArrowRight');
    expect(now()).toBe(W);
  });

  it('mid-drag the column follows the live panel width, before the release', async () => {
    // Invariant: the column's width is the live width while the pointer moves, not only after pointerup.
    await mountApp();
    await dockSplit('alpha');
    const start = now();
    const h = handle();
    act(() => {
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 540, pointerId: 1 }));
    });
    expect(now(), 'the live width').toBe(start - 40);
    expect(colWidth(), 'the column follows mid-drag').toBe(start - 40);
    act(() => { h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 540, pointerId: 1 })); });
    await settle();
  });

  it('before the first measurement the handle has a finite maximum and a drag can commit no unbounded width', async () => {
    // Invariant (characterization): aria-valuemax is always a finite number and a committed width is always finite and bounded, even before the main row is measured.
    await mountApp();
    await dockSplit('alpha');
    const max = Number(handle().getAttribute('aria-valuemax'));
    expect(Number.isFinite(max), `aria-valuemax ${handle().getAttribute('aria-valuemax')}`).toBe(true);
    await drag(-5000);
    const stored = localStorage.getItem(DOCK_WIDTH_STORAGE_KEY);
    expect(stored === null || Number(stored) <= max, `stored width ${stored} within ${max}`).toBe(true);
  });
});

describe('a narrow window', () => {
  it('a window too narrow for any split shows the plugin full-screen over the session, writes nothing and offers no toggle; widening restores split at the stored width', async () => {
    // Invariant (F9): forced full is derived from the window, never written: the plugin fills the row, the remembered split and width survive.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockAtW();
    const setItem = vi.spyOn(localStorage, 'setItem');
    emitWidth(DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH - 1);
    await settle();
    expect(viewOpen(), 'the plugin shown').toBe(true);
    expect(sessionShown(), 'over the session').toBe(false);
    expect(dockHandle(), 'no handle').toBeNull();
    expect(columnButtons(), 'no toggle').toEqual([]);
    expect(location.hash).toBe(ANCHOR);
    expect(setItem, 'nothing written').not.toHaveBeenCalled();
    expect(await checkedNow()).toEqual(['alpha']);
    emitWidth(WIDE);
    await settle();
    expectSplit('wide again');
    expect(now()).toBe(W);
  });

  it('a window too narrow for the stored width but wide enough for a split shows split at the widest width that fits, writing nothing; an arrow a limit stops writes nothing', async () => {
    // Invariant (F9, F8): a stored width that does not fit shows clamped, and the stored preference survives.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockAtW();
    const narrow = 900;
    expect(narrow - DOCK_TRANSCRIPT_MIN_WIDTH, 'fixture check: W does not fit the narrow window').toBeLessThan(W);
    const setItem = vi.spyOn(localStorage, 'setItem');
    emitWidth(narrow);
    await settle();
    expectSplit('narrow');
    expect(now(), 'the widest split that fits').toBe(narrow - DOCK_TRANSCRIPT_MIN_WIDTH);
    expect(widthWrites(setItem), 'no width written').toEqual([]);
    await key('ArrowLeft');
    expect(now(), 'the panel did not move').toBe(narrow - DOCK_TRANSCRIPT_MIN_WIDTH);
    expect(widthWrites(setItem), 'no width written by the stopped key').toEqual([]);
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(W));
    emitWidth(WIDE);
    await settle();
    expect(now()).toBe(W);
  });
});

describe('below md', () => {
  it('below md there is no split, no handle and no toggle: a remembered split is not shown beside the session, a pick opens the full-page view, and back above md the split returns', async () => {
    // Invariant (F10, characterization): the phone layout is always full; the remembered split waits for a desktop width.
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
    const cross = async (v: boolean) => { act(() => { wide = v; for (const fn of [...listeners]) fn(); }); await settle(); };
    await mountApp();
    await dockSplit('alpha');
    await cross(false);
    expect(viewOpen(), 'the section hidden').toBe(false);
    expect(dockHandle(), 'no handle').toBeNull();
    expect(await checkedNow()).toEqual(['conductor']);
    await cross(true);
    expectSplit('desktop again');
    await cross(false);
    await pickApp('beta');
    expect(location.hash, 'the full-page view').toBe('#plugin/beta/');
    expect(columnButtons(), 'the phone bar alone').toEqual(['Open sidebar']);
  });
});
