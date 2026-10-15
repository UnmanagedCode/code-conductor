import { describe, expect, it } from 'vitest';
import {
  SESSION_WIDTH_DEFAULT, SESSION_WIDTH_MAX, SESSION_WIDTH_MIN, SESSION_WIDTH_SNAPS, SESSION_WIDTH_STEP,
  sessionWidthKey, sessionWidthLabel, snapSessionWidth,
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
    expect(snapSessionWidth(SESSION_WIDTH_MAX)).toBe(SESSION_WIDTH_MAX);
  });
});

describe('sessionWidthLabel / sessionWidthKey', () => {
  it('name the setting: a snap label or px, or Full', () => {
    // Invariant: the trigger label and the e2e hook name the setting.
    const cases: [{ width: number; full: boolean }, string, string][] = [
      [{ width: 768, full: false }, 'Normal', '768'],
      [{ width: 1024, full: false }, 'Wide', '1024'],
      [{ width: 896, full: false }, '896 px', '896'],
      [{ width: 896, full: true }, 'Full', 'full'],
    ];
    for (const [s, label, key] of cases) {
      expect(sessionWidthLabel(s)).toBe(label);
      expect(sessionWidthKey(s)).toBe(key);
    }
  });
});

describe('the scale', () => {
  it('keeps every snap point and the default on a keyboard step inside the range', () => {
    // Invariant: keyboard steps from MIN can land on every snap point and the default.
    for (const px of [...SESSION_WIDTH_SNAPS.map((s) => s.px), SESSION_WIDTH_DEFAULT]) {
      expect(px).toBeGreaterThanOrEqual(SESSION_WIDTH_MIN);
      expect(px).toBeLessThanOrEqual(SESSION_WIDTH_MAX);
      expect((px - SESSION_WIDTH_MIN) % SESSION_WIDTH_STEP).toBe(0);
    }
    expect((SESSION_WIDTH_MAX - SESSION_WIDTH_MIN) % SESSION_WIDTH_STEP).toBe(0);
  });
});
