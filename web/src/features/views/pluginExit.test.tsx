// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin bar's exit, over the real controller: its far-right control is
// Collapse where a rail can show and Close plugin where none can, the switcher's
// Conductor pick returns to Conductor without ever stopping a keep-alive plugin,
// and Close does the same.
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
/** The class lucide stamps on the icon inside the column's button `name`. */
const iconClass = (name: string) => within(column()!).getByRole('button', { name }).querySelector('svg')?.getAttribute('class') ?? null;

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
  it('the bar ends in Collapse plugin dock, with no Close plugin, in split and in the full view of a listed plugin', async () => {
    // Invariant: where a rail can show, the far-right control is Collapse (the same icon in both modes), after the toggle and the switcher; Close plugin is absent.
    await mountApp();
    await dockSplit('beta');
    expect(columnButtons(), 'split').toEqual(['Expand to full view', 'Switch app', 'Collapse plugin dock']);
    expect(noClose(), 'split: no Close plugin').toBe(true);
    const splitIcon = iconClass('Collapse plugin dock');
    expect(splitIcon, 'fixture check: Collapse carries an icon').toBeTruthy();
    await pressColumn('Expand to full view');
    expect(location.hash, 'fixture check: expanded').toBe('#plugin/beta/');
    expect(columnButtons(), 'full').toEqual(['Dock to side', 'Switch app', 'Collapse plugin dock']);
    expect(noClose(), 'full: no Close plugin').toBe(true);
    expect(iconClass('Collapse plugin dock'), 'the same icon in both modes').toBe(splitIcon);
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

  it('a plugin the switcher does not list shows no toggle and no Collapse, and Close plugin and the switcher\'s Conductor leave its view', async () => {
    // Invariant: no rail can show for an unlisted plugin, so its bar ends in Close plugin, which is the Conductor pick (back on the anchor, column hidden).
    net.status.ghost = plainRow();
    await mountApp();
    await go('#plugin/ghost/');
    expect(viewOpen(), 'fixture check: Ghost shown').toBe(true);
    expect(columnButtons(), 'the switcher, then Close').toEqual(['Switch app', 'Close plugin']);
    await pressColumn('Close plugin');
    expect(location.hash, 'Close').toBe(ANCHOR);
    expect(column()!.dataset.dockMode).toBe('hidden');
    await go('#plugin/ghost/');
    expect(viewOpen(), 'fixture check: Ghost shown again').toBe(true);
    await pickApp('conductor');
    expect(location.hash, 'Conductor').toBe(ANCHOR);
    expect(column()!.dataset.dockMode).toBe('hidden');
  });

  it('with nothing listed the bar holds only Close plugin, which leaves the view, as does selecting a session from the sidebar', async () => {
    // Invariant: with no switcher, Close plugin is the bar's way out, and the sidebar's session pick still leaves too.
    net.catalog = [];
    net.status.zeta = plainRow();
    await mountApp();
    await go('#plugin/zeta/');
    expect(column()!.dataset.dockMode, 'fixture check: full').toBe('full');
    expect(columnButtons(), 'only Close in the bar').toEqual(['Close plugin']);
    await pressColumn('Close plugin');
    expect(location.hash, 'Close: back on the session anchor').toBe(ANCHOR);
    expect(column()!.dataset.dockMode, 'Close: the column hidden').toBe('hidden');
    await go('#plugin/zeta/');
    expect(column()!.dataset.dockMode, 'fixture check: full again').toBe('full');
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
  it('in split the bar reads Expand to full view, the plugin\'s name, then Collapse plugin dock', async () => {
    // Invariant: the mode toggle sits left of the plugin's name and Collapse at the bar's far right.
    await mountApp();
    await dockSplit('beta');
    expect(inOrder({
      name: barName(), Expand: barButton('Expand to full view'), Collapse: barButton('Collapse plugin dock'),
    })).toEqual(['Expand', 'name', 'Collapse']);
  });

  it('in the full view the bar reads Dock to side, the plugin\'s name, then Collapse plugin dock', async () => {
    // Invariant: in full the mode toggle is left of the plugin's name and Collapse at the far right.
    await mountApp();
    await pickApp('beta');
    expect(location.hash, 'fixture check: Beta in the full view').toBe('#plugin/beta/');
    expect(inOrder({ name: barName(), Dock: barButton('Dock to side'), Collapse: barButton('Collapse plugin dock') })).toEqual(['Dock', 'name', 'Collapse']);
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

  it('the bar holds Open sidebar, the switcher, then Close plugin, and Close returns to Conductor keeping the keep-alive frame', async () => {
    // Invariant: on a drawer viewport no rail can show, so the bar ends in Close plugin, the same non-stopping return to Conductor as the switcher's pick, with the drawer left closed.
    await mountApp();
    await go('#plugin/beta/');
    expect(viewOpen(), 'fixture check: Beta shown').toBe(true);
    expect(columnButtons()).toEqual(['Open sidebar', 'Switch app', 'Close plugin']);
    expect(column()!.contains(switcher()), 'the switcher sits in the bar, with the drawer closed').toBe(true);
    expect(uiStore.get().sidebarOpen, 'fixture check: the drawer closed').toBe(false);
    const frame = residentFrame('beta')!;
    expect(frame, 'fixture check: Beta\'s resident frame').not.toBeNull();
    const p = posts();
    const l = lifecycle();

    await pressColumn('Close plugin');
    expect(location.hash).toBe(ANCHOR);
    expect(uiStore.get().sidebarOpen, 'the drawer stays closed').toBe(false);
    expect(residentFrame('beta') === frame, 'the same frame node').toBe(true);
    expect(frame.hidden, 'the frame hidden').toBe(true);
    expect(posts() - p, 'no POST').toBe(0);
    expect(lifecycle() - l, 'no start/stop/restart/disable').toBe(0);
  });
});
