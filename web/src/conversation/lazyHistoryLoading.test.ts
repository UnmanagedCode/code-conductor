// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationModel } from './model';
import { createLazyHistory } from './lazyHistory';

const json = (page: any) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) });

/** A fetch whose answers are held until `release` is called, one per request in order. */
function gatedFetch(pages: any[], calls: string[]) {
  const gates: (() => void)[] = [];
  const fetch = vi.fn((url: string) => {
    calls.push(url);
    const page = pages.shift()!;
    return new Promise((resolve) => gates.push(() => resolve(json(page))));
  });
  return { fetch, release: () => gates.shift()!() };
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };

afterEach(() => vi.unstubAllGlobals());

describe('earlier-messages sentinel', () => {
  it('reads loading while an older page is in flight and settles to not-loading once it lands', async () => {
    // Invariant: the sentinel's status is loading exactly for the duration of the older-page fetch (tall viewport, so only an explicit load starts it).
    const calls: string[] = [];
    const gate = gatedFetch([
      { events: [{ kind: 'user_echo', text: 'older', userIndex: 3, _seq: 880 }], nextBefore: 870, hasMore: true },
    ], calls);
    vi.stubGlobal('fetch', gate.fetch);
    const model = new ConversationModel();
    const h = createLazyHistory({ model, getActiveId: () => 'inst-lazy' });
    h.setViewport({ clientHeight: () => 400, scrollHeight: () => 5000, preserve: (fn) => fn() });
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls).toHaveLength(0);
    expect(h.status.get()).toEqual({ visible: true, loading: false });

    const pending = h.loadEarlier();
    await settle();
    expect(calls).toHaveLength(1);
    expect(h.status.get()).toEqual({ visible: true, loading: true });
    expect(model.items).toHaveLength(0);

    gate.release();
    await pending;
    await settle();
    expect(h.status.get()).toEqual({ visible: true, loading: false });
    expect(model.items.some((i) => i.type === 'user' && i.displayText === 'older')).toBe(true);
  });
});
