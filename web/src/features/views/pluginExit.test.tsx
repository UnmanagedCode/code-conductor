// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin bar's exit, over the real controller: the bar holds no Close plugin
// in any layout, the switcher's Conductor pick returns to Conductor without ever
// stopping a keep-alive plugin, and with nothing listed the sidebar leaves the view.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
  syncWorktree: vi.fn(), mergeWorktree: vi.fn(), setWorktreeLock: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { selectInstance } from '@/app/controller';
import { uiStore } from '@/app/ui';
import { dockStore, readDockState } from './dock';
import {
  ACTIVE, checkedNow, column, columnButtons, DOCK_CATALOG, dockSplit, endHost, go, keepRow, mountApp, net, pickApp, plainRow,
  pressColumn, resetHost, residentFrame, sessionShown, settle, switcher, viewOpen,
} from './test/pluginHost';

const ANCHOR = '#session=sess-1';

/** Every POST the app made. */
const posts = () => net.calls.filter((c) => c.startsWith('POST ')).length;
/** Every request that starts, stops, restarts or disables a plugin. */
const lifecycle = () => net.calls.filter((c) => /\/api\/plugins\/[^/]+\/(stop|disable|restart|start)$/.test(c)).length;
const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
/** The column holds no button named Close plugin. */
const noClose = () => within(column()!).queryByRole('button', { name: 'Close plugin' }) === null;

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

describe('the plugin bar\'s exit', () => {
  it('the bar holds no Close plugin in split and in full: Collapse (split only), the mode toggle, then the switcher', async () => {
    // Invariant: the bar's buttons are Collapse (split only), the mode toggle and the switcher, in that order, and no Close plugin.
    await mountApp();
    await dockSplit('beta');
    expect(columnButtons(), 'split').toEqual(['Collapse plugin dock', 'Expand to full view', 'Switch app']);
    expect(noClose(), 'split: no Close plugin').toBe(true);
    await pressColumn('Expand to full view');
    expect(location.hash, 'fixture check: expanded').toBe('#plugin/beta/');
    expect(columnButtons(), 'full').toEqual(['Dock to side', 'Switch app']);
    expect(noClose(), 'full: no Close plugin').toBe(true);
  });

  it('the switcher\'s Conductor from the full view returns to Conductor and keeps a keep-alive frame: same node, hidden, same src, no request that starts or stops it', async () => {
    // Invariant: the Conductor pick is a return to Conductor, never a stop: the keep-alive page stays resident and the server hears nothing.
    await mountApp();
    await pickApp('beta');
    expect(location.hash, 'fixture check: Beta in the full view').toBe('#plugin/beta/');
    expect(await checkedNow(), 'fixture check: Beta checked').toEqual(['beta']);
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const p = posts();
    const l = lifecycle();
    const s = starts();

    await pickApp('conductor');
    expect(location.hash, 'back on the session anchor').toBe(ANCHOR);
    expect(column()!.dataset.dockMode, 'the column hidden').toBe('hidden');
    expect(sessionShown(), 'the session shown').toBe(true);
    expect(await checkedNow(), 'Conductor checked').toEqual(['conductor']);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(frame.hidden, 'the frame hidden, not removed').toBe(true);
    expect(frame.getAttribute('src'), 'the same src').toBe('/plugins/beta/');
    expect(posts() - p, 'no POST').toBe(0);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);

    await pickApp('beta');
    expect(residentFrame('beta') === frame, 're-entry: the same frame node').toBe(true);
    expect(frame.hidden, 're-entry: the frame shown').toBe(false);
    expect(starts(), 're-entry: no start').toBe(s);
  });

  it('the switcher\'s Conductor from split hides the column, keeps split remembered and the keep-alive frame resident, and stops nothing', async () => {
    // Invariant: from split the Conductor pick empties the dock but keeps split as the remembered mode, and never stops the plugin.
    await mountApp();
    await dockSplit('beta');
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const l = lifecycle();

    await pickApp('conductor');
    expect(dockStore.get(), 'nothing docked, split remembered').toEqual({ id: null, subpath: '/', mode: 'split' });
    expect(column()!.dataset.dockMode, 'the column hidden').toBe('hidden');
    expect(sessionShown(), 'the session shown').toBe(true);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
  });

  it('a plugin the switcher does not list shows no toggle, and the switcher\'s Conductor leaves its view', async () => {
    // Invariant: with other apps listed, an unlisted plugin's bar still holds the switcher, whose Conductor pick leaves the view.
    net.status.ghost = plainRow();
    await mountApp();
    await go('#plugin/ghost/');
    expect(viewOpen(), 'fixture check: Ghost shown').toBe(true);
    expect(columnButtons(), 'only the switcher, no toggle').toEqual(['Switch app']);
    await pickApp('conductor');
    expect(location.hash).toBe(ANCHOR);
    expect(column()!.dataset.dockMode).toBe('hidden');
  });

  it('with nothing listed the bar holds no button, and selecting a session from the sidebar leaves the view', async () => {
    // Invariant: with no switcher and no Close the sidebar's session pick is the on-screen way out of the plugin view.
    net.catalog = [];
    net.status.zeta = plainRow();
    await mountApp();
    await go('#plugin/zeta/');
    expect(column()!.dataset.dockMode, 'fixture check: full').toBe('full');
    expect(columnButtons(), 'no button in the bar').toEqual([]);
    expect(noClose(), 'no Close plugin').toBe(true);
    await act(async () => { selectInstance(ACTIVE.id); });
    await settle();
    expect(location.hash, 'back on the session anchor').toBe(ANCHOR);
    expect(column()!.dataset.dockMode, 'the column hidden').toBe('hidden');
  });
});

/** The keys of `els` in document order. */
const inOrder = (els: Record<string, Element>) =>
  Object.keys(els).sort((a, b) => (els[a].compareDocumentPosition(els[b]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
const barButton = (name: string) => within(column()!).getByRole('button', { name });
/** The bar's title (the switcher reading Beta), asserted present. */
function barName(): Element {
  const t = column()!.querySelector('[data-plugin-title]');
  expect(t, 'the bar\'s title').not.toBeNull();
  expect(t!.textContent, 'the title reads the plugin').toContain('Beta');
  return t!;
}

describe('the plugin bar\'s order', () => {
  it('in split the bar reads Collapse plugin dock, Expand to full view, then the plugin\'s name', async () => {
    // Invariant: the layout controls sit together at the bar's inner edge, left of the plugin's name.
    await mountApp();
    await dockSplit('beta');
    expect(inOrder({
      name: barName(), Expand: barButton('Expand to full view'), Collapse: barButton('Collapse plugin dock'),
    })).toEqual(['Collapse', 'Expand', 'name']);
  });

  it('in the full view the bar reads Dock to side, then the plugin\'s name', async () => {
    // Invariant: in full the mode toggle is the bar's first control, left of the plugin's name.
    await mountApp();
    await pickApp('beta');
    expect(location.hash, 'fixture check: Beta in the full view').toBe('#plugin/beta/');
    expect(inOrder({ name: barName(), Dock: barButton('Dock to side') })).toEqual(['Dock', 'name']);
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

  it('the bar holds Open sidebar then the switcher, no Close plugin, and the switcher\'s Conductor returns to Conductor keeping the keep-alive frame', async () => {
    // Invariant: on a drawer viewport the bar's switcher is the way out, the same non-stopping return to Conductor, with the drawer left closed.
    await mountApp();
    await go('#plugin/beta/');
    expect(viewOpen(), 'fixture check: Beta shown').toBe(true);
    expect(columnButtons()).toEqual(['Open sidebar', 'Switch app']);
    expect(noClose(), 'no Close plugin').toBe(true);
    expect(column()!.contains(switcher()), 'the switcher sits in the bar, with the drawer closed').toBe(true);
    expect(uiStore.get().sidebarOpen, 'fixture check: the drawer closed').toBe(false);
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const p = posts();
    const l = lifecycle();

    await pickApp('conductor');
    expect(location.hash).toBe(ANCHOR);
    expect(uiStore.get().sidebarOpen, 'the drawer stays closed').toBe(false);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(frame.hidden, 'the frame hidden').toBe(true);
    expect(posts() - p, 'no POST').toBe(0);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
  });
});
