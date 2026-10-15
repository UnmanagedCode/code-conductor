import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_WIDTH_MIN } from './sessionWidthScale';

const KEY = 'code-conductor:session-column';
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

  it('old or unknown stored values fall back to the default and never crash startup', async () => {
    // Invariant: only the current key is read, and any unparseable, wrong-shaped or unreadable value under the current key reads as Resizable at Normal.
    for (const old of ['wide', 'full', '{"width":1200,"full":true}']) {
      localStorage.clear();
      localStorage.setItem('code-conductor:session-width', old); // a key the store never reads;
      expect((await fresh()).sessionWidthStore.get(), `other key ${old}`).toEqual({ width: 768, full: false });
    }
    for (const garbage of ['', 'huge', '{"width":"wide","full":false}', '{"width":900}', '{"preset":"full"}']) {
      localStorage.clear();
      localStorage.setItem(KEY, garbage);
      expect((await fresh()).sessionWidthStore.get(), `new key ${garbage}`).toEqual({ width: 768, full: false });
    }
    localStorage.clear();
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect((await fresh()).sessionWidthStore.get()).toEqual({ width: 768, full: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('a width wider than any fixed cap persists as set', async () => {
    // Invariant: there is no fixed maximum; a wide width survives a reload unchanged.
    let m = await fresh();
    m.setSessionWidth(2400);
    m = await fresh();
    expect(m.sessionWidthStore.get().width).toBe(2400);
  });

  it('the floor holds', async () => {
    // Invariant: neither the setter nor a stored value can go below the minimum width.
    let m = await fresh();
    m.setSessionWidth(10);
    expect(m.sessionWidthStore.get().width).toBe(SESSION_WIDTH_MIN);
    localStorage.setItem(KEY, '{"width":100,"full":true}');
    m = await fresh();
    expect(m.sessionWidthStore.get()).toEqual({ width: SESSION_WIDTH_MIN, full: true });
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
