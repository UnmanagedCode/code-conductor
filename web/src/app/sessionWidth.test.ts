import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'code-conductor:session-width';
async function fresh() {
  vi.resetModules();
  return import('./sessionWidth');
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the session width setting', () => {
  it('defaults to Normal width, not Full, on a fresh profile', async () => {
    // Invariant: the default is Normal's px, not Full.
    expect((await fresh()).sessionWidthStore.get()).toEqual({ width: 768, full: false });
  });

  it.each([
    ['normal', { width: 768, full: false }],
    ['wide', { width: 1024, full: false }],
    ['full', { width: 768, full: true }],
  ])('a legacy %s value maps to today\'s px/Full, is rewritten in place once, and re-running is a no-op', async (legacy, want) => {
    // Invariant: legacy values map to today's px/Full, are rewritten in place once, and re-running is a no-op.
    localStorage.setItem(KEY, legacy);
    expect((await fresh()).sessionWidthStore.get()).toEqual(want);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(want);
    const setItem = vi.spyOn(localStorage, 'setItem');
    expect((await fresh()).sessionWidthStore.get()).toEqual(want);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('garbage stored values are never adopted', async () => {
    // Invariant: no garbage is adopted; the setting falls back to the default.
    for (const garbage of ['', 'Wide', 'huge', '{"preset":"full"}', '{"width":"wide","full":false}', '{"width":900}', '{"width":900,"full":"yes"}']) {
      localStorage.setItem(KEY, garbage);
      expect((await fresh()).sessionWidthStore.get(), garbage).toEqual({ width: 768, full: false });
    }
  });

  it('a stored width is clamped to the slider range', async () => {
    // Invariant: a stored width outside the slider range reads back clamped.
    localStorage.setItem(KEY, '{"width":4000,"full":false}');
    expect((await fresh()).sessionWidthStore.get().width).toBe(1600);
    localStorage.setItem(KEY, '{"width":100,"full":true}');
    expect((await fresh()).sessionWidthStore.get()).toEqual({ width: 480, full: true });
  });

  it('unreadable storage falls back to the default', async () => {
    // Invariant: a throwing localStorage never breaks startup.
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect((await fresh()).sessionWidthStore.get()).toEqual({ width: 768, full: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('Full never overwrites the width, across reloads', async () => {
    // Invariant: the custom width persists, and toggling Full leaves it untouched.
    let m = await fresh();
    m.setSessionWidth(896);
    m = await fresh();
    expect(m.sessionWidthStore.get()).toEqual({ width: 896, full: false });
    m.setSessionFull(true);
    m = await fresh();
    expect(m.sessionWidthStore.get()).toEqual({ width: 896, full: true });
    m.setSessionFull(false);
    m = await fresh();
    expect(m.sessionWidthStore.get()).toEqual({ width: 896, full: false });
  });

  it('the setters clamp to the slider range', async () => {
    // Invariant: setters clamp, so no out-of-range width is stored.
    const m = await fresh();
    m.setSessionWidth(5000);
    expect(m.sessionWidthStore.get().width).toBe(1600);
    m.setSessionWidth(10);
    expect(m.sessionWidthStore.get().width).toBe(480);
  });

  it('resetSessionWidth returns to the default width and keeps Full', async () => {
    // Invariant: reset sets Normal's px and does not touch Full.
    const m = await fresh();
    m.setSessionWidth(896);
    m.setSessionFull(true);
    m.resetSessionWidth();
    expect(m.sessionWidthStore.get()).toEqual({ width: 768, full: true });
  });

  it('a localStorage write that throws still updates the store', async () => {
    // Invariant: an unwritable storage never stops the control; the store still changes.
    const m = await fresh();
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      m.setSessionWidth(896);
      m.setSessionFull(true);
      expect(m.sessionWidthStore.get()).toEqual({ width: 896, full: true });
    } finally {
      spy.mockRestore();
    }
  });
});
