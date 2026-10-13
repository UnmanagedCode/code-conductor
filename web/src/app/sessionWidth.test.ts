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

describe('the session width preset', () => {
  it('defaults to Normal on a fresh profile', async () => {
    // Invariant: with nothing stored the preset is Normal.
    expect((await fresh()).sessionWidthStore.get().preset).toBe('normal');
  });

  it('cycles Normal → Wide → Full → Normal, and each step survives a reload', async () => {
    // Invariant: the cycle order is fixed and wraps; a reload reads back whatever the last cycle chose.
    let m = await fresh();
    for (const want of ['wide', 'full', 'normal']) {
      m.cycleSessionWidth();
      expect(m.sessionWidthStore.get().preset).toBe(want);
      m = await fresh();
      expect(m.sessionWidthStore.get().preset, `reload after ${want}`).toBe(want);
    }
  });

  it('an invalid stored value falls back to Normal, and the next cycle goes to Wide', async () => {
    // Invariant: garbage is never adopted, and the fallback is a real Normal rather than a stuck state.
    for (const garbage of ['', 'Wide', 'huge', '{"preset":"full"}']) {
      localStorage.setItem(KEY, garbage);
      const m = await fresh();
      expect(m.sessionWidthStore.get().preset, garbage).toBe('normal');
      m.cycleSessionWidth();
      expect(m.sessionWidthStore.get().preset, garbage).toBe('wide');
    }
  });

  it('unreadable storage falls back to Normal', async () => {
    // Invariant: a throwing localStorage never breaks startup; the preset is Normal.
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect((await fresh()).sessionWidthStore.get().preset).toBe('normal');
  });
});
