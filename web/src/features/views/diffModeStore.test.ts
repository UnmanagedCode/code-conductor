import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'code-conductor:diff-mode';
async function fresh() {
  vi.resetModules();
  return import('./diffMode');
}

beforeEach(() => localStorage.clear());

describe('the stored diff mode', () => {
  it('a fresh profile and any garbage stored value read unified', async () => {
    // Invariant: only the exact string "split" selects split; absent or unrecognised storage means unified.
    expect((await fresh()).diffModeStore.get().mode).toBe('unified');
    localStorage.setItem(KEY, 'split');
    expect((await fresh()).diffModeStore.get().mode).toBe('split');
    for (const garbage of ['Split', 'side', '']) {
      localStorage.setItem(KEY, garbage);
      expect((await fresh()).diffModeStore.get().mode, garbage).toBe('unified');
    }
  });

  it('split and unified each persist and read back after a reload', async () => {
    // Invariant: the chosen mode is written under the storage key and survives a reload, in both directions.
    const a = await fresh();
    a.setDiffMode('split');
    expect(localStorage.getItem(KEY)).toBe('split');
    const b = await fresh();
    expect(b.diffModeStore.get().mode).toBe('split');
    b.setDiffMode('unified');
    expect(localStorage.getItem(KEY)).toBe('unified');
    expect((await fresh()).diffModeStore.get().mode).toBe('unified');
  });

  it('setting the mode already in force writes nothing', async () => {
    // Invariant: a no-change set neither persists nor notifies.
    const m = await fresh();
    const setItem = vi.spyOn(localStorage, 'setItem');
    m.setDiffMode('unified');
    expect(setItem).not.toHaveBeenCalled();
    m.setDiffMode('split');
    expect(setItem).toHaveBeenCalledTimes(1);
    m.setDiffMode('split');
    expect(setItem).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
  });
});
