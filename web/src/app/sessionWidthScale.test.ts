import { describe, expect, it } from 'vitest';
import {
  SESSION_WIDTH_DEFAULT, SESSION_WIDTH_GUTTER, SESSION_WIDTH_MIN, SESSION_WIDTH_SNAP_RADIUS, SESSION_WIDTH_SNAPS,
  dragSessionWidth, fitSessionWidth, sessionWidthCeiling, sessionWidthKey, sessionWidthLabel, snapSessionWidth,
} from './sessionWidthScale';

describe('snapSessionWidth', () => {
  it('moves only values within the radius, and to the nearest snap', () => {
    // Invariant: only values within the radius (inclusive) move, and to the nearest snap.
    expect(snapSessionWidth(768 - 32)).toBe(768);
    expect(snapSessionWidth(768 + 32)).toBe(768);
    expect(snapSessionWidth(768 + 48)).toBe(816);
    expect(snapSessionWidth(768 - 48)).toBe(720);
    expect(snapSessionWidth(1024 - 16)).toBe(1024);
    expect(snapSessionWidth(1024 + 32)).toBe(1024);
    expect(snapSessionWidth(SESSION_WIDTH_MIN)).toBe(SESSION_WIDTH_MIN);
  });
});

describe('dragSessionWidth', () => {
  const ROOM = 1400;
  it('mirrors at 2x: outward grows from either edge, inward shrinks', () => {
    // Invariant: right +dx and left -dx both give start + 2dx; right -dx and left +dx shrink by 2dx.
    expect(dragSessionWidth(768, 40, 'right', ROOM)).toBe(848);
    expect(dragSessionWidth(768, -40, 'left', ROOM)).toBe(848);
    expect(dragSessionWidth(768, -40, 'right', ROOM)).toBe(688);
    expect(dragSessionWidth(768, 40, 'left', ROOM)).toBe(688);
  });

  it('snaps inside the drag, then fits to the room', () => {
    // Invariant: the raw width snaps first; a snap point above the ceiling is clamped to the ceiling.
    expect(dragSessionWidth(768, 130, 'right', ROOM)).toBe(1024);
    expect(dragSessionWidth(768, 150, 'right', ROOM)).toBe(1068);
    const room = 1000;
    expect(sessionWidthCeiling(room)).toBeLessThan(1024);
    expect(dragSessionWidth(768, 120, 'right', room)).toBe(sessionWidthCeiling(room));
  });
});

describe('the room bounds', () => {
  it('the ceiling is the room less a gutter per side and never below the floor', () => {
    // Invariant: ceiling(room) = room - 2*gutter, floored at the minimum width.
    expect(sessionWidthCeiling(1400)).toBe(1400 - 2 * SESSION_WIDTH_GUTTER);
    expect(sessionWidthCeiling(100)).toBe(SESSION_WIDTH_MIN);
  });

  it('fitSessionWidth caps a wide width to the ceiling and floors a narrow one', () => {
    // Invariant: a shown width is within [floor, ceiling].
    expect(fitSessionWidth(4000, 1400)).toBe(sessionWidthCeiling(1400));
    expect(fitSessionWidth(10, 1400)).toBe(SESSION_WIDTH_MIN);
    expect(fitSessionWidth(900, 1400)).toBe(900);
  });
});

describe('sessionWidthLabel / sessionWidthKey', () => {
  it('name the setting: Resizable with px, or Full', () => {
    // Invariant: the toggle label and the e2e hook name the setting.
    const cases: [{ width: number; full: boolean }, string, string][] = [
      [{ width: 768, full: false }, 'Resizable, 768 px', '768'],
      [{ width: 896, full: false }, 'Resizable, 896 px', '896'],
      [{ width: 896, full: true }, 'Full', 'full'],
    ];
    for (const [s, label, key] of cases) {
      expect(sessionWidthLabel(s)).toBe(label);
      expect(sessionWidthKey(s)).toBe(key);
    }
  });
});

describe('the scale', () => {
  it('keeps every snap and the default above the floor, with disjoint catch zones', () => {
    // Invariant: snaps and the default are reachable, and adjacent snaps' catch zones never overlap.
    const snaps = SESSION_WIDTH_SNAPS.map((s) => s.px);
    for (const px of [...snaps, SESSION_WIDTH_DEFAULT]) expect(px).toBeGreaterThanOrEqual(SESSION_WIDTH_MIN);
    for (let i = 1; i < snaps.length; i++) expect(snaps[i] - snaps[i - 1]).toBeGreaterThan(2 * SESSION_WIDTH_SNAP_RADIUS);
  });
});
