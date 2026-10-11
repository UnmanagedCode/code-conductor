import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'code-conductor:sidebar-lens';
async function fresh() {
  vi.resetModules();
  return import('./ui');
}

beforeEach(() => localStorage.clear());

describe('the sidebar lens', () => {
  it('defaults to Conductors on a fresh profile', async () => {
    // Invariant: with nothing stored the lens is Conductors.
    expect((await fresh()).uiStore.get().lens).toBe('conductors');
  });

  it('persists a choice and reads it back after a reload', async () => {
    // Invariant: the chosen lens survives a reload, in both directions.
    const a = await fresh();
    a.setLens('projects');
    expect(localStorage.getItem(KEY)).toBe('projects');
    const b = await fresh();
    expect(b.uiStore.get().lens).toBe('projects');
    b.setLens('conductors');
    expect((await fresh()).uiStore.get().lens).toBe('conductors');
  });

  it('falls back to Conductors for a garbage stored value', async () => {
    // Invariant: an unrecognised stored lens is ignored rather than adopted.
    for (const garbage of ['Projects', 'nope', '']) {
      localStorage.setItem(KEY, garbage);
      expect((await fresh()).uiStore.get().lens, garbage).toBe('conductors');
    }
  });
});
