// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The app switcher as the plugin dock's sole selector, over the real controller:
// the entry it checks in split and in full, what a pick opens (the remembered
// mode), Conductor hiding the column, a session pick and Escape in each layout,
// and the history each step costs.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
  syncWorktree: vi.fn(), mergeWorktree: vi.fn(), setWorktreeLock: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { selectInstance, type SelectOptions } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { openCosts, openSettings } from './api';
import { dockStore, readDockState } from './dock';
import { DOCK_PANEL_MIN_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from './dockLayout';
import {
  ACTIVE, checkedNow, column, columnButtons, DOCK_CATALOG, dockSplit, emitWidth, endHost, go, keepRow, mountApp, net, pickApp, plainRow,
  postRoute, pressColumn, resetHost, residentFrame, sessionShown, settle, sharedFrame, shownFrames, standInWindow, stubResizeObserver, viewOpen,
} from './test/pluginHost';

const ANCHOR = '#session=sess-1';
const OTHER: Instance = { id: 'i2', project: 'p', status: 'idle', sessionId: 'sess-2', mode: 'default' };
/** A main row one px too narrow for the smallest split beside the transcript floor. */
const NARROW = DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH - 1;
const WIDE = 1100;
const GAMMA = { id: 'gamma', name: 'Gamma', enabled: true, hasFrontend: true, frontendKeepAlive: false, state: 'ready' };

/** Escape, as the user presses it with nothing else open. */
async function escape() {
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await settle();
}
async function select(id: string, opts: SelectOptions = {}) {
  await act(async () => { selectInstance(id, opts); });
  await settle();
}
async function back() {
  await act(async () => { history.back(); });
  await settle();
}
const mode = () => column()!.dataset.dockMode;
/** Split: the plugin section shown beside the session. */
function expectSplit(what: string) {
  expect(viewOpen(), `${what}: the plugin section shown`).toBe(true);
  expect(sessionShown(), `${what}: beside the session`).toBe(true);
}
/** A split on Alpha in a wide row, then the row narrowed past any split. */
async function narrowSplit() {
  stubResizeObserver();
  await mountApp();
  emitWidth(WIDE);
  await dockSplit('alpha');
  emitWidth(NARROW);
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  appStore.set({ instances: [ACTIVE, OTHER] });
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await endHost();
});

describe('the switcher selects the plugin on screen', () => {
  it('in split the switcher checks the docked plugin, as it checks the full view\'s', async () => {
    // Invariant (F2): the checked entry is the plugin on screen, whether it fills the row or sits beside the session.
    await mountApp();
    await pickApp('alpha');
    expect(location.hash, 'fixture check: the pick opened the full view').toBe('#plugin/alpha/');
    expect(await checkedNow(), 'control: the full view\'s plugin is checked').toEqual(['alpha']);
    await pressColumn('Dock to side');
    expectSplit('fixture check: docked');
    expect(await checkedNow()).toEqual(['alpha']);
  });

  it('picking Conductor hides the plugin column completely, from split and from full', async () => {
    // Invariant (F3): Conductor leaves no plugin on screen and no control in the column, whichever layout it was in.
    await mountApp();
    await dockSplit('alpha');
    await pickApp('conductor');
    expect(mode(), 'from split').toBe('hidden');
    expect(columnButtons(), 'from split: no control').toEqual([]);
    expect(shownFrames(), 'from split: no frame shown').toEqual([]);
    expect(location.hash).toBe(ANCHOR);
    await go('#plugin/beta/');
    expect(viewOpen() && !sessionShown(), 'fixture check: Beta in the full view').toBe(true);
    await pickApp('conductor');
    expect(mode(), 'from full').toBe('hidden');
    expect(columnButtons(), 'from full: no control').toEqual([]);
    expect(location.hash).toBe(ANCHOR);
  });

  it('on a session with nothing selected the column is hidden and holds no control', async () => {
    // Invariant (F3): with no plugin selected the column costs the session nothing: no control at all.
    await mountApp();
    expect(location.hash, 'fixture check: on the session').toBe(ANCHOR);
    expect(columnButtons()).toEqual([]);
    expect(mode()).toBe('hidden');
  });

  it('with nothing remembered a pick opens the full view', async () => {
    // Invariant (F4, characterization): the remembered mode defaults to full.
    await mountApp();
    await pickApp('alpha');
    expect(location.hash).toBe('#plugin/alpha/');
    expect(sessionShown(), 'the session is not shown').toBe(false);
    expect(viewOpen()).toBe(true);
  });

  it('switching A→B in split keeps split: the session stays, the hash and history stay put, B is checked', async () => {
    // Invariant (F4): a pick in split swaps the docked plugin in place; split is no route, so it costs no history entry.
    await mountApp();
    await dockSplit('alpha');
    const entries = history.length;
    await pickApp('beta');
    expect(sessionShown(), 'the session stays').toBe(true);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length, 'no history entry').toBe(entries);
    const beta = residentFrame('beta');
    expect(beta !== null && !beta.hidden, 'Beta\'s frame shown').toBe(true);
    expect(viewOpen()).toBe(true);
    expect(await checkedNow()).toEqual(['beta']);
  });

  it('switching A→B in full keeps full', async () => {
    // Invariant (F4, characterization): a pick from the full view opens the next plugin full.
    await mountApp();
    await pickApp('alpha');
    await pickApp('beta');
    expect(location.hash).toBe('#plugin/beta/');
    expect(sessionShown(), 'the session is not shown').toBe(false);
    expect(await checkedNow()).toEqual(['beta']);
  });

  it('a pick after Conductor opens the last mode: split after Dock to side, full after Expand to full view', async () => {
    // Invariant (F4): the toggle writes the remembered mode, and Conductor keeps it for the next pick.
    await mountApp();
    await dockSplit('alpha');
    await pickApp('conductor');
    await pickApp('beta');
    expectSplit('split remembered');
    expect(location.hash).toBe(ANCHOR);
    await pressColumn('Expand to full view');
    expect(location.hash, 'fixture check: expanded').toBe('#plugin/beta/');
    await pickApp('conductor');
    await pickApp('alpha');
    expect(location.hash, 'full remembered').toBe('#plugin/alpha/');
    expect(sessionShown()).toBe(false);
  });
});

describe('a pick over a covering view', () => {
  /** Opens a full-page view and waits until it shows (Settings loads lazily). */
  async function cover(open: () => void, selector: string) {
    await act(async () => { open(); });
    await waitFor(() => expect(document.querySelector(selector), `fixture check: ${selector} shows`).not.toBeNull(), { timeout: 10_000 });
  }

  it('with split remembered, a pick over Settings closes it and shows the pick in split beside the session', async () => {
    // Invariant (F4): a pick from a view covering the session lands on the session with the picked plugin in split.
    await mountApp();
    await dockSplit('alpha');
    await cover(() => openSettings(), '[data-settings-view]');
    await pickApp('beta');
    expect(location.hash).toBe(ANCHOR);
    expect(document.querySelector('[data-settings-view]'), 'Settings closed').toBeNull();
    expectSplit('the pick');
    const beta = residentFrame('beta');
    expect(beta !== null && !beta.hidden, 'Beta\'s frame shown').toBe(true);
    expect(await checkedNow()).toEqual(['beta']);
  });

  it('with split remembered, a pick over Settings opened from Costs lands on the session, not on Costs', async () => {
    // Invariant (F4): the pick's landing does not depend on what history holds beneath the covering view.
    const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (url === '/api/costs/summary' ? Promise.resolve(new Response(JSON.stringify({ row_count: 0 }))) : inner(url, init))));
    await mountApp();
    await dockSplit('alpha');
    await cover(() => openCosts(), 'main[data-view="costs"]');
    await cover(() => openSettings(), '[data-settings-view]');
    await pickApp('beta');
    expect(location.hash).toBe(ANCHOR);
    expectSplit('the pick');
    expect(document.querySelector('main[data-view="costs"]'), 'Costs not shown').toBeNull();
    expect(await checkedNow()).toEqual(['beta']);
  });

  it('with split remembered, a pick over Settings opened on a linked full view docks the pick beside the session, not that full view', async () => {
    // Invariant (F4): a covering view's pick is never lost to a plugin full view beneath it, which would end the split it wrote.
    net.catalog = [...DOCK_CATALOG, GAMMA];
    net.status.gamma = plainRow();
    await mountApp();
    await dockSplit('alpha');
    await go('#plugin/beta/');
    expect(viewOpen() && !sessionShown(), 'fixture check: Beta in full').toBe(true);
    await cover(() => openSettings(), '[data-settings-view]');
    await pickApp('gamma');
    expect(location.hash).toBe(ANCHOR);
    expectSplit('the pick');
    expect(dockStore.get().id).toBe('gamma');
    expect(await checkedNow()).toEqual(['gamma']);
  });
});

describe('a pick while a full view shows', () => {
  it('with split remembered, a pick from a linked full view opens the next plugin full, replacing the entry', async () => {
    // Invariant (F4): a switch while a full view shows stays full, even with split remembered.
    net.catalog = [...DOCK_CATALOG, GAMMA];
    net.status.gamma = plainRow();
    await mountApp();
    await dockSplit('beta');
    await go('#plugin/alpha/');
    expect(dockStore.get(), 'fixture check: split remembered, nothing docked').toMatchObject({ id: null, mode: 'split' });
    const entries = history.length;
    await pickApp('gamma');
    expect(location.hash).toBe('#plugin/gamma/');
    expect(history.length, 'the entry replaced').toBe(entries);
    expect(sessionShown(), 'not docked beside the session').toBe(false);
    expect(dockStore.get().id).toBeNull();
  });
});

describe('Dock to side', () => {
  it('a route the frame publishes while Dock to side\'s Back is still in flight leaves the new split selected', async () => {
    // Invariant: only entering a plugin view ends split; a route change within the full view, before Back lands, keeps the dock Dock to side wrote.
    await mountApp();
    await pickApp('alpha');
    expect(history.state?.ccView, 'fixture check: the full view was pushed, so Dock to side steps back').toBe(1);
    const win = standInWindow(sharedFrame()!);
    // Chromium queues a Back; happy-dom runs it in-call. Hold it, as the browser does, until the frame has posted.
    const historyBack = vi.spyOn(history, 'back').mockImplementation(() => {});
    await pressColumn('Dock to side');
    expect(historyBack, 'fixture check: Dock to side stepped back').toHaveBeenCalledTimes(1);
    expect(location.hash, 'fixture check: Back not landed yet').toBe('#plugin/alpha/');
    postRoute(win, '/moved');
    await settle();
    expect(location.hash, 'fixture check: the frame\'s route reached the hash').toBe('#plugin/alpha/moved');
    expect(dockStore.get().id, 'the dock survives the in-view route change').toBe('alpha');
    historyBack.mockRestore();
    await back();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('Back landed');
    expect(await checkedNow()).toEqual(['alpha']);
  });
});

describe('a session pick', () => {
  it('in full a session pick closes the plugin and the switcher reads Conductor, even for a plugin expanded from split', async () => {
    // Invariant (F5): full and split never coexist, so leaving the full view by a session pick lands on Conductor, never on a split.
    await mountApp();
    await dockSplit('alpha');
    await pressColumn('Expand to full view');
    expect(location.hash, 'control: the full view').toBe('#plugin/alpha/');
    await select(OTHER.id, { userGesture: true });
    expect(location.hash, 'fixture check: the picked session').toBe('#session=sess-2');
    expect(mode()).toBe('hidden');
    expect(sessionShown()).toBe(true);
    expect(await checkedNow()).toEqual(['conductor']);
  });

  it('in split a session pick swaps the session beside the plugin, which keeps its frame', async () => {
    // Invariant (F6, characterization): split survives a user's session pick, with the same frame and the same docked plugin.
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame();
    expect(frame, 'fixture check: Alpha\'s frame').not.toBeNull();
    await select(OTHER.id, { userGesture: true });
    expect(location.hash).toBe('#session=sess-2');
    expectSplit('after the pick');
    expect(sharedFrame() === frame, 'the same frame node').toBe(true);
    expect(dockStore.get().id).toBe('alpha');
  });
});

describe('a window too narrow for any split', () => {
  it('in a window too narrow for any split, a session pick closes the plugin and keeps the remembered split', async () => {
    // Invariant (F9, F5): a split shown full-screen leaves like the full view on a user's session pick, but the split stays remembered.
    await narrowSplit();
    await select(OTHER.id, { userGesture: true });
    expect(location.hash).toBe('#session=sess-2');
    expect(sessionShown(), 'the picked session shows').toBe(true);
    expect(mode()).toBe('hidden');
    expect(shownFrames(), 'no frame shown').toEqual([]);
    expect(await checkedNow()).toEqual(['conductor']);
    expect(dockStore.get().mode, 'split stays remembered').toBe('split');
    expect(dockStore.get().id, 'nothing selected').toBeNull();
    emitWidth(WIDE);
    await settle();
    expect(mode(), 'widening reopens nothing').toBe('hidden');
    await pickApp('beta');
    expectSplit('the next pick');
    expect(location.hash).toBe('#session=sess-2');
  });

  it('in a window too narrow for any split, a non-gesture selection leaves the full-screen plugin up', async () => {
    // Invariant (F9): only a user's pick closes it; the first-connect restore (no gesture) keeps what a reload restored.
    await narrowSplit();
    await select(OTHER.id);
    expect(viewOpen(), 'the plugin is still up').toBe(true);
    expect(dockStore.get().id).toBe('alpha');
  });

  it('in a window too narrow for any split, Escape closes the plugin and keeps the remembered split', async () => {
    // Invariant (F9, F7): Escape closes a split shown full-screen without a history step, and the split stays remembered.
    await narrowSplit();
    const historyBack = vi.spyOn(history, 'back');
    await escape();
    expect(mode()).toBe('hidden');
    expect(sessionShown()).toBe(true);
    expect(location.hash).toBe(ANCHOR);
    expect(historyBack, 'no history step').not.toHaveBeenCalled();
    expect(dockStore.get().mode, 'split stays remembered').toBe('split');
    expect(dockStore.get().id, 'nothing selected').toBeNull();
    emitWidth(WIDE);
    await settle();
    await pickApp('beta');
    expectSplit('the next pick');
  });
});

describe('leaving the full view', () => {
  const EXITS: [string, () => Promise<void>][] = [
    ['Escape from a full view entered by Expand lands on Conductor, never split', async () => {
      await dockSplit('alpha');
      await pressColumn('Expand to full view');
      expect(location.hash, 'fixture check: expanded').toBe('#plugin/alpha/');
      await escape();
    }],
    ['Back from a full view entered by Expand lands on Conductor, never split', async () => {
      await dockSplit('alpha');
      await pressColumn('Expand to full view');
      expect(location.hash, 'fixture check: expanded').toBe('#plugin/alpha/');
      await back();
    }],
    ['Back after switching A→B in full lands on Conductor', async () => {
      await pickApp('alpha');
      await pickApp('beta');
      expect(location.hash, 'fixture check: B in full').toBe('#plugin/beta/');
      await back();
    }],
    ['Escape from a linked full view while another plugin is docked lands on Conductor', async () => {
      await dockSplit('beta');
      await go('#plugin/alpha/');
      expect(viewOpen() && !sessionShown(), 'fixture check: Alpha in full').toBe(true);
      await escape();
    }],
  ];

  it.each(EXITS)('%s', async (_title, exit) => {
    // Invariant (F7): every exit from the full view lands on the session with no plugin on screen.
    await mountApp();
    await exit();
    expect(location.hash).toBe(ANCHOR);
    expect(mode()).toBe('hidden');
    expect(sessionShown()).toBe(true);
    expect(await checkedNow()).toEqual(['conductor']);
  });

  it('Escape in split changes nothing', async () => {
    // Invariant (F7, characterization): only a full-screen plugin closes on Escape; split is not a view to leave.
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame();
    const historyBack = vi.spyOn(history, 'back');
    await escape();
    expect(historyBack).not.toHaveBeenCalled();
    expect(location.hash).toBe(ANCHOR);
    expectSplit('after Escape');
    expect(sharedFrame() === frame, 'the same frame').toBe(true);
  });
});
