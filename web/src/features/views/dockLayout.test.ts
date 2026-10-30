// The plugin column's mode rules and the plugin on screen, one per test, the split limit at its boundary, and where the app switcher shows.
import { describe, expect, it } from 'vitest';
import { canSplit, DOCK_PANEL_MIN_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH, dockLayout, type DockMode, maxPanel, shownApp, switcherSlot } from './dockLayout';

/** The narrowest main row a split fits in. */
const SPLIT_MIN_ROW = DOCK_PANEL_MIN_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH;
const CATALOG = ['alpha', 'beta'];
type Input = Parameters<typeof dockLayout>[0];
const input = (over: Partial<Input> = {}): Input => ({
  desktop: true, view: 'session', routePluginId: null, catalogIds: CATALOG, dockId: null, available: 1100, collapsed: false, ...over,
});

describe('dockLayout', () => {
  it('with no catalog app the column is hidden beside a session', () => {
    // Invariant: no frontend plugin, no dock.
    expect(dockLayout(input({ catalogIds: [], dockId: 'alpha' }))).toEqual({ mode: 'hidden', shownId: null, toggle: null });
  });

  it('below md a session hides the column even with a split selected', () => {
    // Invariant (F10): the phone layout has no split.
    expect(dockLayout(input({ desktop: false, dockId: 'alpha' }))).toEqual({ mode: 'hidden', shownId: null, toggle: null });
  });

  it('below md a plugin route is the full view with no toggle', () => {
    // Invariant (F10): the phone's full view offers no Dock to side.
    expect(dockLayout(input({ desktop: false, view: 'plugin', routePluginId: 'alpha' }))).toEqual({ mode: 'full', shownId: 'alpha', toggle: null });
  });

  it('on desktop with nothing selected the column is hidden', () => {
    // Invariant (F3): Conductor shows no column.
    expect(dockLayout(input())).toEqual({ mode: 'hidden', shownId: null, toggle: null });
  });

  it('a listed split selection with room is split, offering Expand', () => {
    // Invariant (F1): split shows exactly the selected plugin, and its toggle expands it.
    expect(dockLayout(input({ dockId: 'beta' }))).toEqual({ mode: 'split', shownId: 'beta', toggle: 'expand' });
  });

  it('a split selection the catalog no longer lists is hidden', () => {
    // Invariant: a docked plugin that lost its frontend never shows.
    expect(dockLayout(input({ dockId: 'gone' })).mode).toBe('hidden');
  });

  it.each(['settings', 'costs', 'commits', 'review'] as const)('the %s view hides the column', (view) => {
    // Invariant: the dock lives beside the session only; other full-page views keep the whole row.
    expect(dockLayout(input({ view, dockId: 'alpha' })).mode).toBe('hidden');
  });

  it('a split selection with no room for any split is full, with no toggle', () => {
    // Invariant (F9): a split too narrow to fit fills the row and offers no toggle, whose target could not show.
    expect(dockLayout(input({ dockId: 'alpha', available: SPLIT_MIN_ROW - 1 }))).toEqual({ mode: 'full', shownId: 'alpha', toggle: null });
  });

  it('a listed plugin route with room is full, offering Dock to side', () => {
    // Invariant (F1): the full view's toggle docks it.
    expect(dockLayout(input({ view: 'plugin', routePluginId: 'beta' }))).toEqual({ mode: 'full', shownId: 'beta', toggle: 'dock' });
  });

  it('an unlisted plugin route is full, with no toggle', () => {
    // Invariant: a plugin the switcher does not list cannot be docked.
    expect(dockLayout(input({ view: 'plugin', routePluginId: 'gone' }))).toEqual({ mode: 'full', shownId: 'gone', toggle: null });
  });

  it('a listed plugin route with no room for any split offers no toggle', () => {
    // Invariant (F9): Dock to side is offered only when a split could show.
    expect(dockLayout(input({ view: 'plugin', routePluginId: 'alpha', available: SPLIT_MIN_ROW - 1 })).toggle).toBeNull();
  });
});

describe('dockLayout collapsed', () => {
  it('collapsed beside a session is the rail on the selected plugin with no toggle', () => {
    // Invariant: a collapsed split is the rail, offering no mode toggle (the bar is behind it).
    expect(dockLayout(input({ dockId: 'alpha', collapsed: true }))).toEqual({ mode: 'rail', shownId: 'alpha', toggle: null });
  });

  it('collapsed is the rail even where no split fits', () => {
    // Invariant: a rail always fits, so a too-narrow window keeps it beside the session instead of the forced-full cover.
    expect(dockLayout(input({ dockId: 'alpha', collapsed: true, available: SPLIT_MIN_ROW - 1 })).mode).toBe('rail');
  });

  it('collapsed changes nothing on a plugin route', () => {
    // Invariant: the full view always shows expanded.
    expect(dockLayout(input({ view: 'plugin', routePluginId: 'beta', collapsed: true }))).toEqual({ mode: 'full', shownId: 'beta', toggle: 'dock' });
  });

  it('collapsed below md hides the column beside a session', () => {
    // Invariant: the phone layout has no rail.
    expect(dockLayout(input({ desktop: false, dockId: 'alpha', collapsed: true })).mode).toBe('hidden');
  });
});

describe('canSplit and maxPanel', () => {
  it.each([
    ['exactly enough room', SPLIT_MIN_ROW, true],
    ['one px short', SPLIT_MIN_ROW - 1, false],
    ['no measurement yet', null, true],
  ] as const)('with %s a split fits: %s', (_what, available, can) => {
    // Invariant: a split fits exactly when DOCK_PANEL_MIN_WIDTH fits beside the transcript floor; before the first measurement it does.
    expect(canSplit(available)).toBe(can);
  });

  it('maxPanel leaves the transcript floor', () => {
    // Invariant: the panel's ceiling is the room the transcript does not need.
    expect(maxPanel(1100)).toBe(1100 - DOCK_TRANSCRIPT_MIN_WIDTH);
  });
});

describe('shownApp', () => {
  it.each([
    ['a plugin route', { view: 'plugin', routePluginId: 'beta', dockId: 'alpha' }, 'beta'],
    ['an unlisted plugin route', { view: 'plugin', routePluginId: 'gone' }, 'gone'],
    ['a split selection beside a session', { dockId: 'alpha' }, 'alpha'],
    ['an unlisted split selection', { dockId: 'gone' }, null],
    ['a split selection below md', { desktop: false, dockId: 'alpha' }, null],
    ['a split selection under Settings', { view: 'settings', dockId: 'alpha' }, null],
    ['nothing selected', {}, null],
  ] as const)('%s shows %s', (_what, over, id) => {
    // Invariant (F2): the switcher checks the full view's plugin, else the listed split selection beside a session on desktop, else Conductor.
    expect(shownApp(input(over as Partial<Input>))).toBe(id);
  });
});

describe('switcherSlot', () => {
  it.each([
    ['hidden', true, 'sidebar'],
    ['hidden', false, 'drawer'],
    ['rail', true, 'sidebar'],
    ['rail', false, 'drawer'],
    ['split', true, 'pane'],
    ['split', false, 'pane'],
    ['full', true, 'pane'],
    ['full', false, 'pane'],
  ] as const)('%s on desktop=%s shows it in the %s', (mode, desktop, slot) => {
    // Invariant: the switcher is in the pane exactly when the column's bar is reachable and shows a plugin (split or full); else the current breakpoint's sidebar copy.
    expect(switcherSlot(mode, desktop)).toBe(slot);
  });

  it('every dockLayout input places it in one slot whatever room the main row leaves, and never in the desktop sidebar below md', () => {
    // Invariant: the placement never depends on the measured width (so the published mode is enough), and a phone never places it in the CSS-hidden aside.
    const ids = [null, 'alpha', 'gone'] as const;
    const rooms = [null, SPLIT_MIN_ROW - 1, 1100] as const;
    const modes = new Set<DockMode>();
    for (const view of ['session', 'plugin', 'settings'] as const)
      for (const routePluginId of ids)
        for (const dockId of ids)
          for (const collapsed of [false, true])
            for (const desktop of [false, true]) {
              const slots = new Set(rooms.map((available) => {
                const { mode } = dockLayout(input({ view, routePluginId, dockId, collapsed, desktop, available }));
                modes.add(mode);
                return switcherSlot(mode, desktop);
              }));
              const where = JSON.stringify({ view, routePluginId, dockId, collapsed, desktop });
              expect(slots.size, `one slot for every room: ${where}`).toBe(1);
              if (!desktop) expect(slots.has('sidebar'), `below md never the desktop sidebar: ${where}`).toBe(false);
            }
    expect([...modes].sort(), 'fixture check: the sweep reaches every mode').toEqual(['full', 'hidden', 'rail', 'split']);
  });
});
