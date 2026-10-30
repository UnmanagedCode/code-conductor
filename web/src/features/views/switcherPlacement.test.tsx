// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// Where the one app switcher shows, as the app mounts it: the plugin column's
// bar while the column shows a plugin at split or full width, else the sidebar
// copy of the current breakpoint (the desktop column, or the phone drawer). Every
// copy is counted in the DOM, CSS-hidden ones included, since happy-dom applies
// no stylesheet. Also: a pick from the bar keeps the column's mode, nothing
// listed leaves plain titles, and the bar's copy adds no catalog read.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/views/CommitsView', () => ({ CommitsView: () => <div data-view="commits" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { uiStore } from '@/app/ui';
import { notifyPluginsChanged, pluginsChangedSignal } from '@/features/settings/pluginsSignal';
import { openCommits } from './api';
import {
  ACTIVE, checkedApps, closeSwitcher, column, DOCK_CATALOG, dockSplit, emitWidth, endHost, entryId, go, keepRow, mountApp, net, pickApp,
  plainRow, pluginView, pressColumn, resetHost, settle, sidebar, stubResizeObserver, switcherEntries,
} from './test/pluginHost';
import { DOCK_PANEL_MIN_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH } from './dockLayout';
import { dockStore, readDockState, setDockCollapsed } from './dock';

const ANCHOR = `#session=${ACTIVE.sessionId}`;
/** The narrowest main row a split fits in. */
const SPLIT_MIN_ROW = DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH;
const WIDE = 1100;

const drawer = () => document.querySelector('[data-slot="sheet-content"]') as HTMLElement | null;
/** Every switcher trigger in the DOM, CSS-hidden copies included. */
const switchers = () => [...document.querySelectorAll<HTMLElement>('[data-app-switcher]')];
/** Where each switcher sits: the plugin column's bar, the phone drawer, or the desktop sidebar. */
const placement = () => switchers().map((el) => (
  el.closest('[data-view="plugin"] header') ? 'pane'
    : el.closest('[data-slot="sheet-content"]') ? 'drawer'
      : el.closest('[data-sidebar]') ? 'sidebar' : 'elsewhere'
));
const paneSwitcher = () => pluginView().querySelector<HTMLElement>('header [data-app-switcher]');
/** The level-1 headings' text in `scope`. */
const h1s = (scope: HTMLElement) => [...scope.querySelectorAll('h1')].map((h) => h.textContent);
/** The bar's level-1 headings' text. */
const paneH1s = () => h1s(pluginView().querySelector('header') as HTMLElement);
const mode = () => column()!.dataset.dockMode;

async function openDrawer() {
  await act(async () => { uiStore.set({ sidebarOpen: true }); });
  await settle();
  expect(drawer(), 'fixture check: the drawer opened').not.toBeNull();
}

/** Opens the bar's switcher (asserted present) and returns its menu. */
async function openBarSwitcher(): Promise<HTMLElement> {
  const trigger = paneSwitcher();
  expect(trigger, 'the bar holds the switcher').not.toBeNull();
  await act(async () => { trigger!.focus(); fireEvent.keyDown(trigger!, { key: 'ArrowDown' }); });
  await settle();
  return screen.getByRole('menu');
}
/** Picks entry `id` ('conductor' for Conductor) from the bar's switcher. */
async function pickFromBar(id: string) {
  const menu = await openBarSwitcher();
  const entry = switcherEntries(menu).find((e) => entryId(e) === id);
  expect(entry, `the bar switcher's "${id}" entry`).toBeTruthy();
  await act(async () => { fireEvent.click(entry!); });
  await settle();
}

/** In a pane state: the one switcher is the bar's, it reads `label`, and the sidebar's title is the static app name. */
function expectInPane(what: string, label: string) {
  expect(placement(), `${what}: one switcher, in the bar`).toEqual(['pane']);
  expect(paneSwitcher()?.textContent ?? '', `${what}: the bar's switcher reads the plugin`).toContain(label);
  expect(h1s(sidebar()), `${what}: the sidebar's title is static`).toEqual(['Code Conductor']);
}

const happyDOM = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  setDockCollapsed(false);
  resetHost(`/${ANCHOR}`);
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow(), zeta: plainRow() };
});
afterEach(async () => {
  await go(ANCHOR);
  await endHost();
});

describe('one switcher, by layout state, on desktop', () => {
  it('on a session it is the sidebar\'s; with the drawer open across a live crossing of md it moves to the drawer and back', async () => {
    // Invariant: both sidebar copies follow the live breakpoint query, not the value at mount: above md the desktop sidebar's alone, below md the open drawer's alone.
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
    expect(placement(), 'hidden').toEqual(['sidebar']);
    await openDrawer();
    expect(placement(), 'hidden, the drawer open on desktop').toEqual(['sidebar']);
    await cross(false);
    expect(uiStore.get().sidebarOpen, 'fixture check: the drawer stays open across the crossing').toBe(true);
    expect(placement(), 'crossed below md').toEqual(['drawer']);
    await cross(true);
    expect(placement(), 'crossed back above md').toEqual(['sidebar']);
  });

  it('in the full view it is the bar\'s', async () => {
    // Invariant: the full view's bar holds the one switcher, reading the plugin; the sidebar title goes static.
    await mountApp();
    await pickApp('beta');
    expect(mode(), 'fixture check: full').toBe('full');
    expectInPane('full', 'Beta');
  });

  it('in split it is the bar\'s', async () => {
    // Invariant: the split's bar holds the one switcher, reading the docked plugin.
    await mountApp();
    await dockSplit('alpha');
    expect(mode(), 'fixture check: split').toBe('split');
    expectInPane('split', 'Alpha');
  });

  it('in the rail it is the sidebar\'s, and the hidden bar keeps a plain title', async () => {
    // Invariant: the rail's section is inert and invisible, so the switcher goes back to the sidebar, which still reads the docked plugin.
    await mountApp();
    await dockSplit('alpha');
    await pressColumn('Collapse plugin dock');
    expect(mode(), 'fixture check: rail').toBe('rail');
    expect(placement(), 'rail').toEqual(['sidebar']);
    expect(switchers()[0]?.textContent ?? '', 'the sidebar\'s switcher reads the docked plugin').toContain('Alpha');
    expect(paneH1s(), 'the bar\'s title is a plain heading').toEqual(['Alpha']);
  });

  it('in a split too narrow to fit (shown full) it is the bar\'s', async () => {
    // Invariant: the placement follows the mode, not the measured width: a forced-full split is a pane state.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockSplit('alpha');
    emitWidth(SPLIT_MIN_ROW - 1);
    await settle();
    expect(mode(), 'fixture check: forced full').toBe('full');
    expectInPane('forced full', 'Alpha');
  });

  it('with Commits covering a split it is the sidebar\'s', async () => {
    // Invariant: a view that hides the column takes the switcher back to the sidebar.
    await mountApp();
    await dockSplit('alpha');
    await act(async () => { openCommits('p'); });
    await settle();
    expect(document.querySelector('[data-view="commits"]'), 'fixture check: Commits shows').not.toBeNull();
    expect(mode(), 'fixture check: the column hidden').toBe('hidden');
    expect(placement(), 'under Commits').toEqual(['sidebar']);
  });
});

describe('one switcher, by layout state, on a phone', () => {
  let prev = { width: 0, height: 0 };
  beforeEach(() => {
    prev = { width: window.innerWidth, height: window.innerHeight };
    happyDOM().setViewport({ width: 412, height: 915 });
  });
  afterEach(() => { happyDOM().setViewport(prev); });

  it('on a session the open drawer holds the only one, the CSS-hidden desktop aside none', async () => {
    // Invariant: below md the hidden-mode switcher is the drawer's alone.
    await mountApp();
    expect(placement(), 'drawer closed: no switcher in the page').toEqual([]);
    await openDrawer();
    expect(placement(), 'drawer open').toEqual(['drawer']);
  });

  it('in the full view the bar holds it, and opening the drawer adds none: its title is static', async () => {
    // Invariant: the phone's full view puts the switcher in the bar, and the drawer then reads a static "Code Conductor".
    await mountApp();
    await go('#plugin/beta/');
    expect(mode(), 'fixture check: full').toBe('full');
    expect(placement(), 'full').toEqual(['pane']);
    await openDrawer();
    expect(placement(), 'full, the drawer open').toEqual(['pane']);
    expect(h1s(drawer()!), 'the drawer\'s title').toEqual(['Code Conductor']);
  });

  it('a pick from the bar opens the plugin in the full view', async () => {
    // Invariant: below md a bar pick stays the full view, on the picked plugin.
    await mountApp();
    await go('#plugin/alpha/');
    await pickFromBar('beta');
    expect(location.hash).toBe('#plugin/beta/');
    expect(mode()).toBe('full');
  });
});

describe('a pick from the bar', () => {
  it('in split swaps the docked plugin and stays split, with no route or history change', async () => {
    // Invariant: a bar pick in split keeps split: only the dock selection changes.
    await mountApp();
    await dockSplit('alpha');
    const hash = location.hash;
    const length = history.length;
    await pickFromBar('beta');
    expect(mode()).toBe('split');
    expect(dockStore.get().id).toBe('beta');
    expect(location.hash).toBe(hash);
    expect(history.length).toBe(length);
  });

  it('in the full view opens the picked plugin full, replacing the entry', async () => {
    // Invariant: a bar pick in full stays full and costs no history entry.
    await mountApp();
    await pickApp('alpha');
    const length = history.length;
    await pickFromBar('beta');
    expect(location.hash).toBe('#plugin/beta/');
    expect(mode()).toBe('full');
    expect(history.length).toBe(length);
  });

  it('in a split too narrow to fit swaps the docked plugin and stays full on the session\'s hash', async () => {
    // Invariant: a bar pick in a forced-full split keeps the split selection model: the route stays on the session.
    stubResizeObserver();
    await mountApp();
    emitWidth(WIDE);
    await dockSplit('alpha');
    emitWidth(SPLIT_MIN_ROW - 1);
    await settle();
    await pickFromBar('beta');
    expect(mode()).toBe('full');
    expect(dockStore.get().id).toBe('beta');
    expect(location.hash).toBe(ANCHOR);
  });

  it('Conductor from the split\'s bar ends the split and keeps the remembered mode', async () => {
    // Invariant: the bar's Conductor is exitToConductor: nothing docked, the session's anchor, the remembered mode untouched.
    await mountApp();
    await dockSplit('alpha');
    const remembered = dockStore.get().mode;
    await pickFromBar('conductor');
    expect(mode()).toBe('hidden');
    expect(location.hash).toBe(ANCHOR);
    expect(dockStore.get().id).toBeNull();
    expect(dockStore.get().mode).toBe(remembered);
  });

  it('Conductor from the full view\'s bar leaves it for the session and keeps the remembered mode', async () => {
    // Invariant: the bar's Conductor leaves the full view for the active session's anchor.
    await mountApp();
    await pickApp('beta');
    const remembered = dockStore.get().mode;
    await pickFromBar('conductor');
    expect(mode()).toBe('hidden');
    expect(location.hash).toBe(ANCHOR);
    expect(dockStore.get().id).toBeNull();
    expect(dockStore.get().mode).toBe(remembered);
  });
});

describe('nothing listed', () => {
  it('on a session there is no switcher and the sidebar title is plain', async () => {
    // Invariant: with no listed app neither slot renders a switcher.
    net.catalog = [];
    await mountApp();
    expect(placement()).toEqual([]);
    expect(h1s(sidebar())).toEqual(['Code Conductor']);
  });

  it('an unlisted plugin\'s full view has no switcher: the bar reads its id as a plain title', async () => {
    // Invariant: with no listed app the bar keeps its plain heading, named by the route's plugin id.
    net.catalog = [];
    await mountApp();
    await go('#plugin/zeta/');
    expect(mode(), 'fixture check: full').toBe('full');
    expect(placement()).toEqual([]);
    expect(h1s(sidebar())).toEqual(['Code Conductor']);
    expect(paneH1s()).toEqual(['zeta']);
  });

  it('the catalog emptying while a plugin is full turns the bar\'s switcher back into a plain title', async () => {
    // Invariant: the last app leaving the catalog removes the switcher wherever it shows; the bar then names the plugin by its id.
    await mountApp();
    await pickApp('beta');
    net.catalog = [];
    await act(async () => { notifyPluginsChanged(undefined); });
    await settle();
    expect(location.hash, 'fixture check: still on the plugin').toBe('#plugin/beta/');
    expect(placement()).toEqual([]);
    expect(paneH1s()).toEqual(['beta']);
  });
});

describe('the bar\'s switcher', () => {
  it('adds no catalog read: the sidebar\'s one at boot, none on entering the full view or docking', async () => {
    // Invariant: only the sidebar copy reads the catalog on mount; the bar's copy, mounted with the column, reads none.
    // PluginView also refreshes on mount once any plugin change was announced (an earlier test's bump), so boot counts that one too.
    const boot = 1 + (pluginsChangedSignal.version() === 0 ? 0 : 1);
    await mountApp();
    const reads = () => net.calls.filter((c) => c === 'GET /api/plugins').length;
    expect(reads(), 'boot').toBe(boot);
    await pickApp('beta');
    expect(reads(), 'full').toBe(boot);
    await pressColumn('Dock to side');
    expect(mode(), 'fixture check: split').toBe('split');
    expect(reads(), 'split').toBe(boot);
  });

  it('on an unlisted plugin\'s full view, with apps listed, reads its id and checks Conductor', async () => {
    // Invariant: the bar's switcher names an unlisted plugin by its id, and the checked entry rule is unchanged (Conductor).
    await mountApp();
    await go('#plugin/zeta/');
    expect(mode(), 'fixture check: full').toBe('full');
    expect(placement(), 'one switcher, in the bar').toEqual(['pane']);
    expect(paneSwitcher()?.textContent ?? '').toContain('zeta');
    const menu = await openBarSwitcher();
    expect(checkedApps(menu)).toEqual(['conductor']);
    await closeSwitcher();
    expect(within(sidebar()).queryAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Code Conductor']);
  });
});
