// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin bar's Close plugin button, over the real controller: where it sits
// (after the mode toggle, or alone where no toggle shows), that it is the
// switcher's Conductor pick, and that it never stops a keep-alive plugin.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
  syncWorktree: vi.fn(), mergeWorktree: vi.fn(), setWorktreeLock: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { uiStore } from '@/app/ui';
import { dockStore, readDockState } from './dock';
import {
  checkedNow, column, columnButtons, DOCK_CATALOG, dockSplit, endHost, go, keepRow, mountApp, net, pickApp, plainRow,
  pressColumn, resetHost, residentFrame, sessionShown, settle, viewOpen,
} from './test/pluginHost';

const ANCHOR = '#session=sess-1';

/** Every POST the app made. */
const posts = () => net.calls.filter((c) => c.startsWith('POST ')).length;
/** Every request that starts, stops, restarts or disables a plugin. */
const lifecycle = () => net.calls.filter((c) => /\/api\/plugins\/[^/]+\/(stop|disable|restart|start)$/.test(c)).length;
const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
const closeBtn = () => within(column()!).getByRole('button', { name: 'Close plugin' });
const noClose = () => within(column()!).queryByRole('button', { name: 'Close plugin' }) === null;
async function close() {
  await act(async () => { fireEvent.click(closeBtn()); });
  await settle();
}
/** Everything a return to Conductor decides. */
const snapshot = () => ({
  hash: location.hash, dock: dockStore.get(), mode: column()!.dataset.dockMode, entries: history.length, session: sessionShown(),
});

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await endHost();
});

describe('the plugin bar\'s Close plugin', () => {
  it('Close plugin sits right after the mode toggle in split and in full', async () => {
    // Invariant: the bar's controls are the mode toggle then Close plugin, in that order, in both layouts.
    await mountApp();
    await dockSplit('beta');
    expect(columnButtons(), 'split').toEqual(['Expand to full view', 'Close plugin']);
    expect(closeBtn(), 'Close is a button named Close plugin').toBeTruthy();
    await pressColumn('Expand to full view');
    expect(location.hash, 'fixture check: expanded').toBe('#plugin/beta/');
    expect(columnButtons(), 'full').toEqual(['Dock to side', 'Close plugin']);
  });

  it('Close from the full view returns to Conductor and keeps a keep-alive frame: same node, hidden, same src, no request that starts or stops it', async () => {
    // Invariant: Close is a return to Conductor, never a stop: the keep-alive page stays resident and the server hears nothing.
    await mountApp();
    await pickApp('beta');
    expect(location.hash, 'fixture check: Beta in the full view').toBe('#plugin/beta/');
    expect(await checkedNow(), 'fixture check: Beta checked').toEqual(['beta']);
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const p = posts();
    const l = lifecycle();
    const s = starts();

    await close();
    expect(location.hash, 'back on the session anchor').toBe(ANCHOR);
    expect(column()!.dataset.dockMode, 'the column hidden').toBe('hidden');
    expect(sessionShown(), 'the session shown').toBe(true);
    expect(await checkedNow(), 'Conductor checked').toEqual(['conductor']);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(frame.hidden, 'the frame hidden, not removed').toBe(true);
    expect(frame.getAttribute('src'), 'the same src').toBe('/plugins/beta/');
    expect(posts() - p, 'no POST').toBe(0);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
    expect(noClose(), 'no Close once the column is hidden').toBe(true);

    await pickApp('beta');
    expect(residentFrame('beta') === frame, 're-entry: the same frame node').toBe(true);
    expect(frame.hidden, 're-entry: the frame shown').toBe(false);
    expect(starts(), 're-entry: no start').toBe(s);
  });

  it('Close in split matches the switcher\'s Conductor pick: same hash, dock state, mode, history and session', async () => {
    // Invariant: Close and the switcher's Conductor are one action; from split both keep split as the remembered mode.
    await mountApp();
    await dockSplit('beta');
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const l = lifecycle();

    await close();
    const viaClose = snapshot();
    expect(viaClose.dock, 'nothing docked, split remembered').toEqual({ id: null, subpath: '/', mode: 'split' });
    expect(viaClose.mode, 'the column hidden').toBe('hidden');
    expect(viaClose.session, 'the session shown').toBe(true);
    expect(residentFrame('beta') === frame, 'after Close: the same frame node').toBe(true);

    await pickApp('beta');
    expect(viewOpen() && sessionShown(), 'fixture check: Beta re-docked in split').toBe(true);
    expect(residentFrame('beta') === frame, 're-docked: the same frame node').toBe(true);
    await pickApp('conductor');
    expect(snapshot(), 'the switcher\'s Conductor ends where Close did').toEqual(viaClose);
    expect(residentFrame('beta') === frame, 'after Conductor: the same frame node').toBe(true);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
  });

  it('with nothing shown the column holds no Close', async () => {
    // Invariant: Close exists only while the column shows a plugin.
    await mountApp();
    expect(location.hash, 'fixture check: on the session').toBe(ANCHOR);
    expect(column()!.dataset.dockMode, 'fixture check: hidden').toBe('hidden');
    expect(noClose()).toBe(true);
  });

  it('a plugin the switcher does not list shows Close alone, and Close leaves its view', async () => {
    // Invariant: Close does not depend on the toggle: an unlisted plugin has no toggle but still has Close.
    net.status.ghost = plainRow();
    await mountApp();
    await go('#plugin/ghost/');
    expect(viewOpen(), 'fixture check: Ghost shown').toBe(true);
    expect(columnButtons()).toEqual(['Close plugin']);
    await close();
    expect(location.hash).toBe(ANCHOR);
    expect(column()!.dataset.dockMode).toBe('hidden');
  });
});

describe('below md', () => {
  const happyDOM = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
  let prev = { width: 0, height: 0 };
  beforeEach(() => {
    prev = { width: window.innerWidth, height: window.innerHeight };
    happyDOM().setViewport({ width: 412, height: 915 });
  });
  afterEach(() => { happyDOM().setViewport(prev); });

  it('the bar holds Open sidebar then Close plugin, and Close returns to Conductor keeping the keep-alive frame', async () => {
    // Invariant: on a drawer viewport Close is in the bar too, and is the same non-stopping return to Conductor.
    await mountApp();
    await go('#plugin/beta/');
    expect(viewOpen(), 'fixture check: Beta shown').toBe(true);
    expect(columnButtons()).toEqual(['Open sidebar', 'Close plugin']);
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const p = posts();
    const l = lifecycle();

    await close();
    expect(location.hash).toBe(ANCHOR);
    expect(uiStore.get().sidebarOpen, 'the drawer stays closed').toBe(false);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(frame.hidden, 'the frame hidden').toBe(true);
    expect(posts() - p, 'no POST').toBe(0);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
  });
});
