// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The dock state: its persisted shape, what reading it tolerates, the actions'
// writes, the split mirror, and a reload restoring the dock as it was left.
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

import {
  collapseDock, DOCK_STORAGE_KEY, DOCK_WIDTH_STORAGE_KEY, dockMirror, dockStore, openDock, readDockState, type DockState,
} from './dock';
import { dockHandle, endHost, keepRow, mountApp, net, plainRow, resetHost, residentFrame, viewOpen } from './test/pluginHost';

const CLOSED: DockState = { id: null, subpath: '/', open: false };
const stored = () => JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  dockStore.set(CLOSED);
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('readDockState', () => {
  it('round-trips a valid stored state', () => {
    // Invariant: what the dock persisted is what a reload reads.
    const state: DockState = { id: 'beta', subpath: '/x/y', open: true };
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
    expect(readDockState()).toEqual(state);
  });

  it.each([
    ['missing', null],
    ['garbage JSON', '{not json'],
    ['a non-object', '"beta"'],
    ['a numeric id', JSON.stringify({ id: 7, subpath: '/', open: true })],
    ['a subpath without its slash', JSON.stringify({ id: 'beta', subpath: 'x', open: true })],
    ['a string open', JSON.stringify({ id: 'beta', subpath: '/', open: 'yes' })],
  ])('reads %s as the closed default', (_what, raw) => {
    // Invariant: an unusable stored dock never opens anything.
    if (raw !== null) localStorage.setItem(DOCK_STORAGE_KEY, raw);
    expect(readDockState()).toEqual(CLOSED);
  });
});

describe('the dock actions', () => {
  it('persist exactly {id, subpath, open}: opening a new app at its root, reopening one at its subpath, collapsing', () => {
    // Invariant: every change is written under DOCK_STORAGE_KEY in the shape readDockState reads back.
    openDock('alpha');
    expect(stored()).toEqual({ id: 'alpha', subpath: '/', open: true });
    dockMirror('alpha', '/deep');
    collapseDock();
    expect(stored()).toEqual({ id: 'alpha', subpath: '/deep', open: false });
    openDock('alpha');
    expect(stored()).toEqual({ id: 'alpha', subpath: '/deep', open: true });
    openDock('beta');
    expect(stored()).toEqual({ id: 'beta', subpath: '/', open: true });
    expect(Object.keys(stored()).sort()).toEqual(['id', 'open', 'subpath']);
  });

  it('dockMirror records only the docked app\'s navigation', () => {
    // Invariant: another plugin's route never moves the dock's saved subpath.
    openDock('alpha');
    dockMirror('beta', '/elsewhere');
    expect(dockStore.get().subpath).toBe('/');
    dockMirror('alpha', '/here');
    expect(dockStore.get().subpath).toBe('/here');
  });
});

describe('a reload', () => {
  beforeEach(() => resetHost('/#session=sess-1'));
  afterEach(async () => {
    dockStore.set(CLOSED);
    await endHost();
  });

  it('restores split on the docked app at its subpath and width, with the hash untouched', async () => {
    // Invariant (7): the dock is restored from storage alone; the URL never carried it.
    net.catalog = [
      { id: 'alpha', name: 'Alpha', enabled: true, hasFrontend: true, frontendKeepAlive: false },
      { id: 'beta', name: 'Beta', enabled: true, hasFrontend: true, frontendKeepAlive: true },
    ];
    net.status = { alpha: plainRow(), beta: keepRow() };
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id: 'beta', subpath: '/x', open: true }));
    localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, '520');
    dockStore.set(readDockState());
    await mountApp();
    expect(viewOpen(), 'split').toBe(true);
    expect(document.querySelector('[data-view="session"]'), 'beside the session').not.toBeNull();
    expect(residentFrame('beta')?.getAttribute('src')).toBe('/plugins/beta/x');
    expect(dockHandle()?.getAttribute('aria-valuenow')).toBe('520');
    expect(location.hash).toBe('#session=sess-1');
  });
});
