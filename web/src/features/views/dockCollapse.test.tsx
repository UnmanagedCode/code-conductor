// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin dock's collapse: a split parked as a rail beside the session, the
// plugin's page left mounted and live behind it, restored by Expand.
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
  column, columnButtons, DOCK_CATALOG, dockHandle, dockSplit, dragBy, emitWidth, endHost, go, keepRow, mountApp, net,
  pickApp, plainRow, pressColumn, residentFrame, resetHost, sessionShown, settle, sharedFrame, standInWindow, stubResizeObserver, viewOpen,
} from './test/pluginHost';
import { DOCK_PANEL_DEFAULT_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from './dockLayout';
import { closeDock, DOCK_WIDTH_STORAGE_KEY, dockStore, readDockState } from './dock';

const ANCHOR = '#session=sess-1';
const COLLAPSED_KEY = 'code-conductor:plugin-dock-collapsed';
const COLLAPSE = 'Collapse plugin dock';
const EXPAND = 'Expand plugin dock';
/** The fixture width: not the dock's default. */
const W = 520;

const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
const statusReads = (id: string) => net.calls.filter((c) => c === `GET /api/plugins/${id}/status`).length;
const rail = () => column()?.querySelector('[data-dock-rail]') ?? null;
const ctl = (name: string) => within(column()!).queryByRole('button', { name });
const mode = () => column()!.dataset.dockMode;
const sectionEl = () => document.querySelector('[data-view="plugin"]') as HTMLElement;

/** Clicks the control `name` (a mouse click unless `detail` is 0), asserted present. */
async function press(name: string, detail = 0) {
  const b = ctl(name);
  expect(b, `the "${name}" control`).not.toBeNull();
  await act(async () => { fireEvent.click(b!, { detail }); });
  await settle();
}
/** Alpha in split at W. */
async function dockAtW() {
  await dockSplit('alpha');
  dragBy(dockHandle()!, DOCK_PANEL_DEFAULT_WIDTH - W);
  await settle();
  expect(Number(dockHandle()!.getAttribute('aria-valuenow')), 'fixture check: docked at W').toBe(W);
}

beforeEach(() => {
  closeDock();
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

describe('the plugin dock collapse', () => {
  it('in split the bar\'s first control is Collapse plugin dock, before the plugin\'s title', async () => {
    // Invariant: Collapse leads the split bar, left of the name.
    await mountApp();
    await dockSplit('alpha');
    const b = ctl(COLLAPSE);
    expect(b, 'the Collapse control').not.toBeNull();
    expect(columnButtons()[0]).toBe(COLLAPSE);
    const title = column()!.querySelector('[data-plugin-title]');
    expect(title, 'the bar\'s title').not.toBeNull();
    expect(b!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the title').toBeTruthy();
  });

  it('Collapse shows the rail beside the session: rail mode, Expand plugin dock and the plugin\'s name in it, the section hidden from AT, no handle', async () => {
    // Invariant: collapsing parks the split as a rail without leaving the session or touching the route.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    expect(mode()).toBe('rail');
    expect(rail(), 'the rail').not.toBeNull();
    expect(within(rail() as HTMLElement).queryByRole('button', { name: EXPAND }), 'Expand in the rail').not.toBeNull();
    expect(rail()!.textContent).toContain('Alpha');
    expect(sectionEl().getAttribute('aria-hidden')).toBe('true');
    expect(sectionEl().hasAttribute('inert')).toBe(true);
    expect(dockHandle()).toBeNull();
    expect(sessionShown()).toBe(true);
    expect(location.hash).toBe(ANCHOR);
  });

  it('Expand plugin dock restores the split at the width it had, writing no width', async () => {
    // Invariant: the width is untouched by a collapse round trip.
    await mountApp();
    await dockAtW();
    const setItem = vi.spyOn(localStorage, 'setItem');
    await press(COLLAPSE);
    await press(EXPAND);
    expect(mode()).toBe('split');
    expect(Number(dockHandle()!.getAttribute('aria-valuenow'))).toBe(W);
    expect(parseInt(column()!.style.width, 10)).toBe(W);
    expect(setItem.mock.calls.filter((c) => c[0] === DOCK_WIDTH_STORAGE_KEY)).toEqual([]);
  });

  it('collapse and expand keep a plain plugin\'s frame: same node, same src, never hidden, no status read, no /start, nothing posted, same host', async () => {
    // Invariant: Collapse is not leave(): the shared frame stays mounted and untouched.
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const win = standInWindow(frame);
    const reads = statusReads('alpha');
    const startsBefore = starts();
    const h = column()!.querySelector('[data-plugin-host]');
    await press(COLLAPSE);
    expect(sharedFrame() === frame && !frame.hidden, 'same node while collapsed, shown').toBe(true);
    await press(EXPAND);
    expect(sharedFrame() === frame && !frame.hidden, 'same node after').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(statusReads('alpha')).toBe(reads);
    expect(starts()).toBe(startsBefore);
    expect(win.posted).toEqual([]);
    expect(column()!.querySelector('[data-plugin-host]') === h).toBe(true);
  });

  it('collapse and expand keep a keep-alive plugin\'s resident frame visible to its host with no /start', async () => {
    // Invariant: a resident frame is neither hidden nor re-created by a collapse round trip.
    await mountApp();
    await dockSplit('beta');
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const startsBefore = starts();
    await press(COLLAPSE);
    expect(residentFrame('beta') === frame && frame.hidden === false, 'same node, not hidden while collapsed').toBe(true);
    await press(EXPAND);
    expect(residentFrame('beta') === frame && frame.hidden === false).toBe(true);
    expect(starts()).toBe(startsBefore);
  });

  it('Close plugin after a collapse round trip still ends a plain frame and hides a keep-alive one', async () => {
    // Invariant: Close behaves as before after a collapse.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await press(EXPAND);
    await pressColumn('Close plugin');
    expect(sharedFrame()).toBeNull();
    expect(mode()).toBe('hidden');
    await pickApp('beta');
    const frame = residentFrame('beta')!;
    await press(COLLAPSE);
    await press(EXPAND);
    await pressColumn('Close plugin');
    expect(residentFrame('beta') === frame && frame.hidden, 'resident hidden, not removed').toBe(true);
  });

  it('a Conductor pick while collapsed ends the plain frame, and the next pick docks expanded', async () => {
    // Invariant: closeDock clears the collapse.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await pickApp('conductor');
    expect(sharedFrame()).toBeNull();
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');
    await pickApp('alpha');
    expect(mode()).toBe('split');
    expect(ctl(COLLAPSE)).not.toBeNull();
    expect(rail()).toBeNull();
  });

  it('picking another plugin while collapsed shows it in split, not as a rail', async () => {
    // Invariant: selectApp's split branch clears the collapse.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await pickApp('beta');
    expect(mode()).toBe('split');
    expect(rail()).toBeNull();
    expect(ctl(COLLAPSE)).not.toBeNull();
  });

  it('the collapse is stored per browser: \'true\' on Collapse, \'false\' on Expand', async () => {
    // Invariant: the write side of persistence, under its own key.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('true');
    await press(EXPAND);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');
  });

  it('a link to a plugin\'s full view while collapsed shows it expanded, and Dock to side docks expanded', async () => {
    // Invariant: entering the full view ends the collapse.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await go('#plugin/alpha/');
    expect(mode()).toBe('full');
    expect(columnButtons()).toEqual(['Dock to side', 'Switch app', 'Close plugin']);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe('false');
    await pressColumn('Dock to side');
    expect(mode()).toBe('split');
  });

  it('a window too narrow for a split keeps the rail beside the session and writes nothing; Expand there shows the split full-screen', async () => {
    // Invariant: a rail always fits, so it is not replaced by the forced-full cover.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await dockSplit('alpha');
    await press(COLLAPSE);
    const setItem = vi.spyOn(localStorage, 'setItem');
    emitWidth(DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH - 1);
    await settle();
    expect(mode()).toBe('rail');
    expect(sessionShown()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    await press(EXPAND);
    expect(mode()).toBe('full');
  });

  it('closing or picking while already expanded writes no collapse flag', async () => {
    // Invariant: setting the flag to the value it already has persists nothing.
    await mountApp();
    await dockSplit('alpha');
    const setItem = vi.spyOn(localStorage, 'setItem');
    const flagWrites = () => setItem.mock.calls.filter((c) => c[0] === COLLAPSED_KEY);
    await pickApp('beta');
    await pickApp('conductor');
    expect(mode(), 'fixture check: the Conductor pick closed it').toBe('hidden');
    await pickApp('alpha');
    expect(mode(), 'fixture check: split again').toBe('split');
    expect(setItem.mock.calls.some((c) => c[0] === 'code-conductor:plugin-dock'), 'control: the spy records writes').toBe(true);
    expect(flagWrites()).toEqual([]);
  });

  it('Escape in the rail changes nothing', async () => {
    // Invariant: only a full column closes on Escape.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await settle();
    expect(mode()).toBe('rail');
    expect(location.hash).toBe(ANCHOR);
  });

  it('a keyboard Collapse moves focus to Expand plugin dock and a keyboard Expand back to Collapse plugin dock; a mouse click moves none', async () => {
    // Invariant: focus follows a keyboard activation across the swap, and only that.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE, 0);
    expect(document.activeElement).toBe(ctl(EXPAND));
    await press(EXPAND, 0);
    expect(document.activeElement).toBe(ctl(COLLAPSE));
    (document.activeElement as HTMLElement).blur();
    await press(COLLAPSE, 1);
    expect(document.activeElement).not.toBe(ctl(EXPAND));
  });

  it('below md a collapse shows nothing beside the session and no dock control; a pick opens the full view with only Open sidebar, the switcher and Close', async () => {
    // Invariant: the phone layout has no rail and no Collapse.
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
    await press(COLLAPSE);
    await cross(false);
    expect(viewOpen()).toBe(false);
    expect(mode()).toBe('hidden');
    expect(rail()).toBeNull();
    expect(ctl(EXPAND)).toBeNull();
    await cross(true);
    expect(mode(), 'back above md the rail returns').toBe('rail');
    await cross(false);
    await pickApp('beta');
    expect(columnButtons()).toEqual(['Open sidebar', 'Switch app', 'Close plugin']);
  });
});
