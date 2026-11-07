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
  openSwitcher, pickApp, plainRow, pressColumn, residentFrame, resetHost, sessionShown, settle, sharedFrame, sidebar, standInWindow, stubResizeObserver, viewOpen,
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
  it('in split the bar\'s last control is Collapse plugin dock, after the plugin\'s title', async () => {
    // Invariant: Collapse ends the split bar, right of the name.
    await mountApp();
    await dockSplit('alpha');
    const b = ctl(COLLAPSE);
    expect(b, 'the Collapse control').not.toBeNull();
    expect(columnButtons().at(-1)).toBe(COLLAPSE);
    const title = column()!.querySelector('[data-plugin-title]');
    expect(title, 'the bar\'s title').not.toBeNull();
    expect(b!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_PRECEDING, 'after the title').toBeTruthy();
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

  it('the switcher\'s Conductor after a collapse round trip still ends a plain frame and hides a keep-alive one', async () => {
    // Invariant: a collapse round trip leaves the Conductor pick's teardown intact: a plain frame ends, a keep-alive one stays resident hidden.
    await mountApp();
    await dockSplit('alpha');
    await press(COLLAPSE);
    await press(EXPAND);
    await pickApp('conductor');
    expect(sharedFrame()).toBeNull();
    expect(mode()).toBe('hidden');
    await pickApp('beta');
    const frame = residentFrame('beta')!;
    await press(COLLAPSE);
    await press(EXPAND);
    await pickApp('conductor');
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
    expect(columnButtons()).toEqual(['Dock to side', 'Switch app', COLLAPSE]);
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

  it('below md a collapse shows nothing beside the session and no dock control; a pick opens the full view with Open sidebar, the switcher and Close plugin, and no Collapse', async () => {
    // Invariant: the phone layout has no rail and no Collapse; its far-right control is Close plugin.
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

/** Escape, keyed on `el` (default: the focused element, else the body), so the listener's focus scope is exercised. */
async function escapeOn(el: Element = document.activeElement ?? document.body) {
  await act(async () => { fireEvent.keyDown(el, { key: 'Escape' }); });
  await settle();
}
/** A focusable sidebar control with no tooltip (an open Radix tooltip takes the Escape itself, which would make a test of the pane's own Escape vacuous). */
function sidebarControl(): HTMLElement {
  const el = sidebar().querySelector<HTMLElement>('button:not([data-slot="tooltip-trigger"]):not([disabled])');
  expect(el, 'fixture check: a sidebar button with no tooltip').not.toBeNull();
  return el!;
}
/** Alpha's full view with the full mode remembered: picked from Conductor. */
async function openFull() {
  await pickApp('alpha');
  expect(mode(), 'fixture check: full').toBe('full');
  expect(location.hash, 'fixture check: the full view').toBe('#plugin/alpha/');
}

describe('full-pane collapse', () => {
  it('Collapse in the full view of a listed plugin docks it as the rail beside the session, on the same frame with no reload', async () => {
    // Invariant: the full-pane Collapse is "dock collapsed, then leave the view": rail beside the session on that plugin, the URL back on the anchor, the page never reloaded.
    await mountApp();
    await openFull();
    const frame = sharedFrame()!;
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    const startsBefore = starts();
    await press(COLLAPSE);
    expect(mode()).toBe('rail');
    expect(rail()!.textContent, 'the rail names Alpha').toContain('Alpha');
    expect(sessionShown()).toBe(true);
    expect(location.hash).toBe(ANCHOR);
    expect(sharedFrame() === frame && !frame.hidden, 'the same frame node, shown').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/alpha/');
    expect(starts()).toBe(startsBefore);
  });

  it('the full mode stays remembered after a full-pane Collapse: a Conductor pick then a pick of the plugin opens its full view', async () => {
    // Invariant: only the toggle writes the remembered mode, so Collapse from full keeps it and the next pick from Conductor opens full again.
    await mountApp();
    await openFull();
    await press(COLLAPSE);
    expect(dockStore.get().mode, 'the store').toBe('full');
    expect(JSON.parse(localStorage.getItem('code-conductor:plugin-dock')!).mode, 'the stored JSON').toBe('full');
    await pickApp('conductor');
    expect(mode(), 'fixture check: Conductor hides the column').toBe('hidden');
    await pickApp('alpha');
    expect(location.hash).toBe('#plugin/alpha/');
    expect(mode()).toBe('full');
  });

  it('Expand plugin dock after a full-pane Collapse gives split, and a pick of the other plugin then swaps it in split instead of opening full', async () => {
    // Invariant: a pick from a plugin showing beside the session keeps split even though the remembered mode is full; only a pick with nothing beside it opens full.
    await mountApp();
    await openFull();
    await press(COLLAPSE);
    await press(EXPAND);
    expect(mode()).toBe('split');
    await pickApp('beta');
    expect(mode(), 'still split').toBe('split');
    expect(location.hash, 'on the session, not a full view').toBe(ANCHOR);
    expect(dockStore.get().id).toBe('beta');
    expect(sessionShown()).toBe(true);
  });

  it('a split too narrow to fit offers Collapse, which gives the rail; a keyboard Expand there hands focus back to Collapse', async () => {
    // Invariant: the forced-full split's Collapse is setDockCollapsed (a rail always fits), and Expand's keyboard handoff lands on the bar's Collapse.
    stubResizeObserver();
    await mountApp();
    emitWidth(1100);
    await dockSplit('alpha');
    emitWidth(DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH - 1);
    await settle();
    expect(mode(), 'fixture check: forced full').toBe('full');
    expect(columnButtons()).toEqual(['Switch app', COLLAPSE]);
    await press(COLLAPSE, 0);
    expect(mode()).toBe('rail');
    expect(sessionShown()).toBe(true);
    expect(document.activeElement, 'focus on Expand').toBe(ctl(EXPAND));
    await press(EXPAND, 0);
    expect(mode(), 'forced full again').toBe('full');
    expect(document.activeElement, 'focus back on Collapse').toBe(ctl(COLLAPSE));
  });

  it('Escape with focus on the bar\'s Collapse collapses the full view to the rail and focuses Expand plugin dock', async () => {
    // Invariant: Escape in the full pane is a keyboard Collapse where Collapse is offered.
    await mountApp();
    await openFull();
    const b = ctl(COLLAPSE)!;
    // A pointer-down first keeps Radix from opening the button's tooltip on focus, which would take the Escape itself.
    await act(async () => { fireEvent.pointerDown(b); b.focus(); });
    expect(document.activeElement, 'fixture check: focus in the column').toBe(b);
    await escapeOn();
    expect(mode()).toBe('rail');
    expect(location.hash).toBe(ANCHOR);
    expect(document.activeElement, 'focus handed to Expand').toBe(ctl(EXPAND));
  });

  it('Escape with focus on the page body collapses the full view to the rail', async () => {
    // Invariant: nothing focused means the pane owns Escape.
    await mountApp();
    await openFull();
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    await escapeOn(document.body);
    expect(mode()).toBe('rail');
    expect(dockStore.get().mode, 'full stays remembered').toBe('full');
  });

  it('Escape with focus on a sidebar control leaves the full pane full', async () => {
    // Invariant: Escape collapses only while focus is in the plugin column or on the body; elsewhere it is that control's own.
    await mountApp();
    await openFull();
    const other = sidebarControl();
    await act(async () => { other.focus(); });
    expect(document.activeElement, 'fixture check: focus in the sidebar').toBe(other);
    await escapeOn();
    expect(mode()).toBe('full');
    expect(location.hash).toBe('#plugin/alpha/');
  });

  it('with the switcher\'s menu open Escape closes the menu only; a second Escape collapses', async () => {
    // Invariant: an open Radix menu keeps its Escape; the pane collapses on the next one.
    await mountApp();
    await openFull();
    const menu = await openSwitcher();
    await act(async () => { fireEvent.keyDown(menu, { key: 'Escape' }); });
    await settle();
    expect(document.querySelector('[role="menu"]'), 'the menu closed').toBeNull();
    expect(mode(), 'the pane stays full').toBe('full');
    await escapeOn();
    expect(mode(), 'the second Escape collapses').toBe('rail');
  });

  it('with an open listbox (a Select) or dialog on the page, Escape leaves the full pane full', async () => {
    // Invariant: an open Select or dialog owns Escape, so the pane does not collapse under it.
    await mountApp();
    await openFull();
    for (const role of ['listbox', 'dialog']) {
      const el = document.body.appendChild(document.createElement('div'));
      el.setAttribute('role', role);
      el.setAttribute('data-state', 'open');
      await escapeOn(document.body);
      expect(mode(), `an open ${role}`).toBe('full');
      el.remove();
    }
  });

  it('an unlisted plugin\'s full view has no rail to collapse to: Escape leaves the view', async () => {
    // Invariant: where Close is offered Escape keeps closing, even with focus elsewhere.
    net.status.ghost = plainRow();
    await mountApp();
    await go('#plugin/ghost/');
    expect(mode(), 'fixture check: full').toBe('full');
    const other = sidebarControl();
    await act(async () => { other.focus(); });
    await escapeOn();
    expect(location.hash).toBe(ANCHOR);
    expect(mode()).toBe('hidden');
  });

  describe('below md', () => {
    const happyDOM = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
    let prev = { width: 0, height: 0 };
    beforeEach(() => {
      prev = { width: window.innerWidth, height: window.innerHeight };
      happyDOM().setViewport({ width: 412, height: 915 });
    });
    afterEach(() => { happyDOM().setViewport(prev); });

    it('Escape in a plugin\'s full view leaves the view, as there is no rail', async () => {
      // Invariant: the phone layout keeps Escape-to-close.
      await mountApp();
      await go('#plugin/alpha/');
      expect(mode(), 'fixture check: full').toBe('full');
      await escapeOn(document.body);
      expect(location.hash).toBe(ANCHOR);
      expect(mode()).toBe('hidden');
    });
  });
});
