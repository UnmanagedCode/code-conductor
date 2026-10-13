// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The dock state: its persisted shape, what reading it accepts, the writes the
// screen makes, the split mirror, and a reload restoring the dock as it was left.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', async () => {
  const { createElement } = await import('react');
  return { SessionView: () => createElement('div', { 'data-view': 'session' }) };
});
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { DOCK_STORAGE_KEY, DOCK_WIDTH_STORAGE_KEY, dockMirror, dockStore, readDockState } from './dock';
import {
  checkedNow, column, DOCK_CATALOG, dockHandle, dockSplit, endHost, keepRow, mountApp, net, pickApp, plainRow, postRoute, pressColumn, resetHost,
  residentFrame, sessionShown, sharedFrame, standInWindow, viewOpen,
} from './test/pluginHost';

/** Nothing selected, the full view remembered: the default. */
const NOTHING = { id: null, subpath: '/', mode: 'full' };
const stored = () => JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('readDockState', () => {
  it.each([
    { id: 'beta', subpath: '/x/y', mode: 'split' },
    { id: null, subpath: '/', mode: 'split' },
  ])('round-trips a valid stored state: %o', (state) => {
    // Invariant: what the dock persisted is what a reload reads.
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
    expect(readDockState()).toEqual(state);
  });

  it.each([
    ['missing', null],
    ['garbage JSON', '{not json'],
    ['a non-object', '"beta"'],
    ['a numeric id', JSON.stringify({ id: 7, subpath: '/', mode: 'split' })],
    ['a subpath without its slash', JSON.stringify({ id: 'beta', subpath: 'x', mode: 'split' })],
    ['an {id, subpath, open} shape, open', JSON.stringify({ id: 'beta', subpath: '/x', open: true })],
    ['an {id, subpath, open} shape, closed', JSON.stringify({ id: 'beta', subpath: '/', open: false })],
    ['an {id, subpath, open} shape with nothing selected', JSON.stringify({ id: null, subpath: '/', open: false })],
    ['a selection with the full view remembered', JSON.stringify({ id: 'beta', subpath: '/', mode: 'full' })],
    ['an unknown mode', JSON.stringify({ id: null, subpath: '/', mode: 'docked' })],
  ])('reads %s as nothing selected', (_what, raw) => {
    // Invariant (F11): only the current shape {id, subpath, mode} with a selection only in split is read; anything else selects nothing.
    if (raw !== null) localStorage.setItem(DOCK_STORAGE_KEY, raw);
    expect(readDockState()).toEqual(NOTHING);
  });
});

describe('the dock\'s split mirror', () => {
  it('dockMirror records only the docked app\'s navigation', () => {
    // Invariant: another plugin's route never moves the dock's saved subpath.
    dockStore.set({ id: 'alpha', subpath: '/', mode: 'split' });
    dockMirror('beta', '/elsewhere');
    expect(dockStore.get().subpath).toBe('/');
    dockMirror('alpha', '/here');
    expect(dockStore.get().subpath).toBe('/here');
  });
});

describe('mounted', () => {
  beforeEach(() => {
    resetHost('/#session=sess-1');
    net.catalog = DOCK_CATALOG;
    net.status = { alpha: plainRow(), beta: keepRow() };
  });
  afterEach(async () => {
    localStorage.clear();
    dockStore.set(readDockState());
    await endHost();
  });

  it('a stored dock of an unknown shape mounts as nothing selected: no column, Conductor checked, and a pick opens the default full view', async () => {
    // Invariant (F11): a value the current format does not describe never opens a plugin, and the full view stays the default.
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id: 'beta', subpath: '/x', open: true }));
    dockStore.set(readDockState());
    await mountApp();
    expect(column()!.dataset.dockMode, 'the column hidden').toBe('hidden');
    expect(await checkedNow()).toEqual(['conductor']);
    await pickApp('alpha');
    expect(location.hash).toBe('#plugin/alpha/');
  });

  it('the stored dock follows the screen: {id, subpath, mode} through a pick, Dock to side, the page\'s route, Conductor and Expand', async () => {
    // Invariant: every change is written under DOCK_STORAGE_KEY in exactly the shape readDockState reads back, and only the toggle writes the mode.
    await mountApp();
    expect(dockStore.get(), 'mounted').toEqual(NOTHING);
    await dockSplit('alpha');
    expect(stored(), 'Dock to side').toEqual({ id: 'alpha', subpath: '/', mode: 'split' });
    postRoute(standInWindow(sharedFrame()!), '/deep');
    expect(stored(), 'the page\'s route').toEqual({ id: 'alpha', subpath: '/deep', mode: 'split' });
    await pickApp('conductor');
    expect(stored(), 'Conductor').toEqual({ id: null, subpath: '/', mode: 'split' });
    await pickApp('alpha');
    expect(viewOpen() && sessionShown(), 'fixture check: the remembered split').toBe(true);
    await pressColumn('Expand to full view');
    expect(stored(), 'Expand').toEqual(NOTHING);
    expect(Object.keys(stored()).sort()).toEqual(['id', 'mode', 'subpath']);
  });

  it('a reload restores split on the docked app at its subpath and width, with the hash untouched', async () => {
    // Invariant: the dock is restored from storage alone; the URL never carried it.
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id: 'beta', subpath: '/x', mode: 'split' }));
    localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, '520');
    dockStore.set(readDockState());
    await mountApp();
    expect(viewOpen(), 'split').toBe(true);
    expect(sessionShown(), 'beside the session').toBe(true);
    expect(residentFrame('beta')?.getAttribute('src')).toBe('/plugins/beta/x');
    expect(dockHandle()?.getAttribute('aria-valuenow')).toBe('520');
    expect(location.hash).toBe('#session=sess-1');
  });
});
