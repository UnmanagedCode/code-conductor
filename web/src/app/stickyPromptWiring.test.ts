import { describe, expect, it, vi } from 'vitest';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));
vi.mock('@/conversation/stickyPrompt', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/conversation/stickyPrompt')>();
  return { ...real, createStickyPrompt: vi.fn(real.createStickyPrompt) };
});

import { createStickyPrompt } from '@/conversation/stickyPrompt';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { lazyHistory, stickyPrompt } from './controller';

// The controller builds its sticky prompt while it loads; each test starts with
// mock history cleared, so the record is taken here.
const created = { calls: [...vi.mocked(createStickyPrompt).mock.calls], results: [...vi.mocked(createStickyPrompt).mock.results] };

describe('sticky prompt wiring', () => {
  it('the sticky prompt pages through the lazy history and reads the active session, its role and history readiness live', () => {
    expect(created.calls).toHaveLength(1);
    expect(created.results[0].value === stickyPrompt).toBe(true);
    const opts = created.calls[0][0];
    expect(opts.history === lazyHistory).toBe(true);
    const instances = [
      { id: 'A', project: 'demo', status: 'idle', sessionId: 'sa', mode: 'x', conducted: true },
      { id: 'B', project: 'demo', status: 'idle', sessionId: 'sb', mode: 'x' },
    ] as Instance[];
    appStore.set({ instances, activeId: 'A' });
    expect(opts.getActiveId()).toBe('A');
    expect(opts.isConducted()).toBe(true);
    appStore.set({ activeId: 'B' });
    expect(opts.getActiveId()).toBe('B');
    expect(opts.isConducted()).toBe(false);
    expect(opts.isHistoryReady()).toBe(false);
    lazyHistory.init({ tailStartSeq: 5 });
    expect(opts.isHistoryReady()).toBe(true);
    appStore.set({ activeId: 'A' });
    expect(opts.isHistoryReady()).toBe(false);
  });
});
