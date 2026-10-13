// The plugin column's mode rules, one per test, and the release snaps at their boundaries.
import { describe, expect, it } from 'vitest';
import {
  canSplit, DOCK_PANEL_MIN_WIDTH, DOCK_RAIL_WIDTH, DOCK_TRANSCRIPT_MIN_WIDTH, dockLayout, maxPanel, releaseDecision,
} from './dockLayout';

/** A main row whose maxPanel is `panel`. */
const rowFor = (panel: number) => panel + DOCK_RAIL_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH;

const W = 520;
const CATALOG = ['alpha', 'beta'];
type Input = Parameters<typeof dockLayout>[0];
const input = (over: Partial<Input> = {}): Input => ({
  desktop: true, view: 'session', routePluginId: null, catalogIds: CATALOG,
  dock: { id: null, open: false }, width: W, available: null, dragging: false, ...over,
});

describe('dockLayout', () => {
  it('with no catalog app the column is hidden beside a session', () => {
    // Invariant: no frontend plugin, no dock.
    expect(dockLayout(input({ catalogIds: [], dock: { id: 'alpha', open: true } })).mode).toBe('hidden');
  });

  it('below md a session hides the column even with the dock open', () => {
    // Invariant: the phone layout has no rail and no split.
    expect(dockLayout(input({ desktop: false, dock: { id: 'alpha', open: true } }))).toEqual({ mode: 'hidden', shownId: null, railShown: false });
  });

  it('below md a plugin route is the full view without a rail', () => {
    // Invariant: the phone's full view is unchanged.
    expect(dockLayout(input({ desktop: false, view: 'plugin', routePluginId: 'alpha' }))).toEqual({ mode: 'full', shownId: 'alpha', railShown: false });
  });

  it('on desktop a closed dock is the rail', () => {
    // Invariant: the rail is the dock's resting state beside a session.
    expect(dockLayout(input({ dock: { id: 'alpha', open: false } }))).toEqual({ mode: 'rail', shownId: null, railShown: true });
  });

  it('an open dock on a listed app is split on that app', () => {
    // Invariant: split shows exactly the docked plugin.
    expect(dockLayout(input({ dock: { id: 'beta', open: true } }))).toEqual({ mode: 'split', shownId: 'beta', railShown: true });
  });

  it('an open dock on an app the catalog no longer lists is the rail', () => {
    // Invariant: a docked plugin that lost its frontend never shows.
    expect(dockLayout(input({ dock: { id: 'gone', open: true } })).mode).toBe('rail');
  });

  it('a drag with nothing docked splits on the first catalog app', () => {
    // Invariant: a drag from the rail opens the dock's fallback target.
    expect(dockLayout(input({ dragging: true }))).toEqual({ mode: 'split', shownId: 'alpha', railShown: true });
  });

  it.each([
    ['exactly enough room', W + DOCK_RAIL_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH, 'split'],
    ['one px short', W + DOCK_RAIL_WIDTH + DOCK_TRANSCRIPT_MIN_WIDTH - 1, 'rail'],
    ['not measured yet', null, 'split'],
  ] as const)('an open dock with %s is %s', (_what, available, mode) => {
    // Invariant: split needs the panel, the rail and the transcript floor to fit; before the first measurement it counts as fitting.
    expect(dockLayout(input({ dock: { id: 'alpha', open: true }, available })).mode).toBe(mode);
  });

  it.each(['settings', 'costs', 'commits', 'review'] as const)('the %s view hides the column', (view) => {
    // Invariant: the dock lives beside the session only; other full-page views keep the whole row.
    expect(dockLayout(input({ view, dock: { id: 'alpha', open: true } })).mode).toBe('hidden');
  });

  it('a plugin route on desktop is the full view with the rail', () => {
    // Invariant: the full view keeps the rail, which carries Dock to side.
    expect(dockLayout(input({ view: 'plugin', routePluginId: 'beta', dock: { id: 'alpha', open: true } }))).toEqual({ mode: 'full', shownId: 'beta', railShown: true });
  });
});

describe('releaseDecision', () => {
  const available = 1100;
  it.each([
    [DOCK_PANEL_MIN_WIDTH - 1, 'rail'],
    [DOCK_PANEL_MIN_WIDTH, 'width'],
    [maxPanel(available), 'width'],
    [maxPanel(available) + 1, 'full'],
  ] as const)('a release at %i is %s', (raw, decision) => {
    // Invariant: below the panel minimum snaps to the rail, past the transcript limit snaps to full, between is a width.
    expect(releaseDecision(raw, available)).toBe(decision);
  });

  it('maxPanel leaves the rail and the transcript floor', () => {
    // Invariant: the panel's ceiling is the room the transcript does not need.
    expect(maxPanel(available)).toBe(available - DOCK_RAIL_WIDTH - DOCK_TRANSCRIPT_MIN_WIDTH);
  });

  it.each([
    [DOCK_PANEL_MIN_WIDTH - 1, 'rail'],
    [DOCK_PANEL_MIN_WIDTH, 'full'],
    [10_000, 'full'],
  ] as const)('with maxPanel one px under the minimum a release at %i is %s', (raw, decision) => {
    // Invariant: when no split width fits, a release below the minimum snaps to the rail and any other to the full view, never to a width.
    expect(releaseDecision(raw, rowFor(DOCK_PANEL_MIN_WIDTH - 1))).toBe(decision);
  });

  it('with maxPanel at the minimum a release at the minimum is a width', () => {
    // Invariant: the smallest split is possible exactly when maxPanel reaches DOCK_PANEL_MIN_WIDTH.
    expect(releaseDecision(DOCK_PANEL_MIN_WIDTH, rowFor(DOCK_PANEL_MIN_WIDTH))).toBe('width');
  });
});

describe('canSplit', () => {
  it.each([
    ['maxPanel one px under the minimum', rowFor(DOCK_PANEL_MIN_WIDTH - 1), false],
    ['maxPanel at the minimum', rowFor(DOCK_PANEL_MIN_WIDTH), true],
    ['no measurement yet', null, true],
  ] as const)('with %s is %s', (_what, available, can) => {
    // Invariant: a split is possible exactly when DOCK_PANEL_MIN_WIDTH fits; before the first measurement it counts as possible.
    expect(canSplit(available)).toBe(can);
  });

  it.each([
    [DOCK_PANEL_MIN_WIDTH - 1, 'rail'],
    [DOCK_PANEL_MIN_WIDTH, 'split'],
  ] as const)('an open dock at the minimum width with maxPanel %i is %s', (panel, mode) => {
    // Invariant: dockLayout shows split only when some split width fits.
    expect(dockLayout(input({ dock: { id: 'alpha', open: true }, width: DOCK_PANEL_MIN_WIDTH, available: rowFor(panel) })).mode).toBe(mode);
  });

  it('a drag never splits when no split width fits', () => {
    // Invariant: with no room for split a drag in progress shows the rail; its release decides between the rail and the full view.
    expect(dockLayout(input({ dragging: true, width: DOCK_PANEL_MIN_WIDTH, available: rowFor(DOCK_PANEL_MIN_WIDTH - 1) })).mode).toBe('rail');
  });
});
