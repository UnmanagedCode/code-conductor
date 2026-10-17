import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationModel } from './model';
import { createLazyHistory } from './lazyHistory';

type Page = { events: any[]; nextBefore: number | null; hasMore: boolean; segment?: string | null; pageSegment?: string | null } | 'error';

const makePages = (n: number, { hasMore = true } = {}): Page[] => Array.from({ length: n }, (_, i) => ({
  events: [{ kind: 'user_echo', text: `old${i}`, userIndex: 100 - i, _seq: 900 - i }],
  nextBefore: 900 - i * 10,
  hasMore,
}));

const json = (page: Page) => (page === 'error'
  ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
  : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) });

function makeFetch(pages: Page[], calls: string[], onFetch: () => void = () => {}) {
  return vi.fn(async (url: string) => {
    calls.push(url);
    onFetch();
    return json(pages.shift() ?? { events: [], nextBefore: 0, hasMore: false });
  });
}

function gatedFetch(pages: Page[], calls: string[]) {
  const gates: (() => void)[] = [];
  const fetch = vi.fn((url: string) => {
    calls.push(url);
    const page = pages.shift() ?? { events: [], nextBefore: 0, hasMore: false };
    return new Promise((resolve) => gates.push(() => resolve(json(page))));
  });
  return { fetch, release: () => gates.shift()!() };
}

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };

function install({ scrollHeight = { value: 1000 }, clientHeight = 800, active = { id: 'inst1' as string | null } } = {}) {
  const model = new ConversationModel();
  const h = createLazyHistory({ model, getActiveId: () => active.id });
  h.setViewport({ clientHeight: () => clientHeight, scrollHeight: () => scrollHeight.value, preserve: (fn) => fn() });
  const has = (text: string) => model.items.some((i) => i.type === 'user' && i.displayText === text);
  return { h, model, active, has };
}

afterEach(() => vi.unstubAllGlobals());

describe('auto-fill', () => {
  it('a short tail pages in until the viewport scrolls, then stops; the earlier-messages control stays', async () => {
    const calls: string[] = [];
    const sh = { value: 100 };
    vi.stubGlobal('fetch', makeFetch(makePages(5), calls, () => { sh.value += 300; }));
    const { h } = install({ scrollHeight: sh });
    h.init({ tailStartSeq: 1000 });
    await settle();
    expect(calls).toHaveLength(3);
    expect(h.status.get().visible).toBe(true);
  });

  it('a short total history terminates and the control disappears', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(makePages(1, { hasMore: false }), calls));
    const { h } = install({ scrollHeight: { value: 100 } });
    h.init({ tailStartSeq: 1000 });
    await settle();
    expect(calls).toHaveLength(1);
    expect(h.status.get().visible).toBe(false);
  });

  it('a fetch error stops the loop and keeps the control', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(['error'], calls));
    const { h } = install({ scrollHeight: { value: 100 } });
    h.init({ tailStartSeq: 1000 });
    await settle();
    expect(calls).toHaveLength(1);
    expect(h.status.get().visible).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith('load earlier failed:', expect.objectContaining({ message: 'boom' }));
  });

  it('an already-scrollable tail fetches nothing but offers the control', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(makePages(5), calls));
    const { h } = install({ scrollHeight: { value: 1000 } });
    h.init({ tailStartSeq: 1000 });
    await settle();
    expect(calls).toHaveLength(0);
    expect(h.status.get().visible).toBe(true);
  });

  it('pages through an empty page while the cursor decreases and hasMore holds', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch([
      { events: [], nextBefore: 880, hasMore: true },
      { events: [{ kind: 'user_echo', text: 'old', _seq: 875 }], nextBefore: 870, hasMore: true },
      { events: [], nextBefore: 0, hasMore: false },
    ], calls));
    const { h } = install({ scrollHeight: { value: 100 } });
    h.init({ tailStartSeq: 900 });
    await settle(10);
    expect(calls).toHaveLength(3);
  });

  it('a stalled cursor ends history even though the server claims more', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return json({ events: [], nextBefore: 900, hasMore: true }); }));
    const { h } = install({ scrollHeight: { value: 100 } });
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls).toHaveLength(1);
    expect(h.status.get().visible).toBe(false);
  });

  it('caps consecutive empty pages; a served page resets the streak', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(Array.from({ length: 6 }, (_, i) => ({ events: [], nextBefore: 900 - (i + 1) * 10, hasMore: true })), calls));
    const a = install({ scrollHeight: { value: 100 } });
    a.h.init({ tailStartSeq: 900 });
    await settle(12);
    expect(calls).toHaveLength(3);
    expect(a.h.status.get().visible).toBe(false);

    const calls2: string[] = [];
    vi.stubGlobal('fetch', makeFetch([
      { events: [], nextBefore: 890, hasMore: true },
      { events: [], nextBefore: 880, hasMore: true },
      { events: [{ kind: 'user_echo', text: 'old', _seq: 875 }], nextBefore: 870, hasMore: true },
      { events: [], nextBefore: 860, hasMore: true },
      { events: [], nextBefore: 850, hasMore: true },
      { events: [], nextBefore: 840, hasMore: true },
    ], calls2));
    const b = install({ scrollHeight: { value: 100 } });
    b.h.init({ tailStartSeq: 900 });
    await settle(16);
    expect(calls2).toHaveLength(6);
  });

  it('follows the lineage cursor into an earlier segment and stops at a revisited one', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch([
      { events: [], nextBefore: 50, hasMore: true, segment: null },
      { events: [{ kind: 'user_echo', text: 'seg-s1', _seq: 40 }], nextBefore: 400, hasMore: true, segment: 's1', pageSegment: 's1' },
      { events: [], nextBefore: 500, hasMore: true, segment: 's1' },
    ], calls));
    const { h, has } = install({ scrollHeight: { value: 100 } });
    h.init({ tailStartSeq: 60 });
    await settle(10);
    expect(has('seg-s1')).toBe(true);
    expect(calls[1]).toMatch(/before=50/);
    expect(calls[2]).toMatch(/segment=s1/);
    expect(calls).toHaveLength(3);
    expect(h.status.get().visible).toBe(false);
  });

  it('a tail with no older ring content still asks the lineage route once, silently', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch([{ events: [{ kind: 'segment_seam', segmentId: 'D' }], nextBefore: null, hasMore: true, segment: 'C' }], calls));
    const { h, model } = install({ scrollHeight: { value: 5000 } });
    h.init({ tailStartSeq: 0 });
    expect(h.status.get().visible).toBe(false);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/lineage-events\?limit=200&before=0$/);
    expect(model.items.map((i) => i.type)).toEqual(['divider']);
    expect(h.status.get().visible).toBe(true);

    const calls2: string[] = [];
    vi.stubGlobal('fetch', makeFetch([{ events: [], hasMore: false, segment: null, nextBefore: 0 }], calls2));
    const b = install();
    b.h.init({ tailStartSeq: 0 });
    await settle();
    expect(calls2).toHaveLength(1);
    expect(b.model.items).toHaveLength(0);
    expect(b.h.status.get().visible).toBe(false);
  });
});

describe('loadUntil', () => {
  it('pages until found, then stops', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(makePages(5), calls));
    const { h, has } = install();
    h.init({ tailStartSeq: 1000 });
    expect(await h.loadUntil(() => has('old1'), () => true)).toBe('found');
    expect(calls).toHaveLength(2);
  });

  it('is exhausted at the start of the transcript', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch([...makePages(2), ...makePages(1, { hasMore: false })], calls));
    const { h } = install();
    h.init({ tailStartSeq: 1000 });
    expect(await h.loadUntil(() => false, () => true)).toBe('exhausted');
    expect(calls).toHaveLength(3);
  });

  it('stalls on a fetch error with one fetch, keeping hasMore for a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(['error'], calls));
    const { h } = install();
    h.init({ tailStartSeq: 1000 });
    expect(await h.loadUntil(() => false, () => true)).toBe('stalled');
    expect(calls).toHaveLength(1);
    expect(h.state().hasMore).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith('load earlier failed:', expect.objectContaining({ message: 'boom' }));
  });

  it('is cancelled once keepGoing goes false', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', makeFetch(makePages(5), calls));
    const { h } = install();
    h.init({ tailStartSeq: 1000 });
    expect(await h.loadUntil(() => false, () => calls.length < 1)).toBe('cancelled');
    expect(calls).toHaveLength(1);
  });

  it('a session switch mid-fetch cancels it and the stale page never lands', async () => {
    const calls: string[] = [];
    const gate = gatedFetch(makePages(5), calls);
    vi.stubGlobal('fetch', gate.fetch);
    const { h, active, has } = install();
    h.init({ tailStartSeq: 1000 });
    const run = h.loadUntil(() => false, () => true);
    await settle(1);
    active.id = 'inst2';
    h.reset();
    gate.release();
    expect(await run).toBe('cancelled');
    expect(has('old0')).toBe(false);
  });

  it('readiness: none before init or after a switch; a same-session reset keeps it; A→B→A waits for A\'s own init', async () => {
    vi.stubGlobal('fetch', makeFetch(makePages(5), []));
    const a = install();
    expect(a.h.state().ready).toBe(false);
    expect(await a.h.loadUntil(() => false, () => true)).toBe('not-ready');

    a.h.init({ tailStartSeq: 1000 });
    a.h.reset();
    expect(a.h.state()).toEqual({ ready: true, hasMore: false, loading: false });
    expect(await a.h.loadUntil(() => false, () => true)).toBe('exhausted');

    const b = install();
    b.active.id = 'A';
    b.h.init({ tailStartSeq: 1000 });
    b.active.id = 'B'; b.h.reset();
    b.active.id = 'A'; b.h.reset();
    expect(b.h.state()).toEqual({ ready: false, hasMore: false, loading: false });
    b.h.init({ tailStartSeq: 1000 });
    expect(b.h.state().ready).toBe(true);

    const c = install({ active: { id: null } });
    c.h.reset();
    expect(await c.h.loadUntil(() => false, () => true)).toBe('not-ready');

    const d = install();
    d.h.init({ tailStartSeq: 1000 });
    d.active.id = null;
    expect(d.h.state().ready).toBe(false);
  });

  it('joins a scroll-triggered fetch already in flight; a joined failure is not a stall', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const gate = gatedFetch(makePages(5), calls);
    vi.stubGlobal('fetch', gate.fetch);
    const { h, has } = install();
    h.init({ tailStartSeq: 1000 });
    void h.loadEarlier();
    expect(h.state().loading).toBe(true);
    const run = h.loadUntil(() => has('old0'), () => true);
    await settle(1);
    expect(calls).toHaveLength(1);
    gate.release();
    expect(await run).toBe('found');
    expect(calls).toHaveLength(1);

    const calls2: string[] = [];
    const gate2 = gatedFetch(['error', ...makePages(5)], calls2);
    vi.stubGlobal('fetch', gate2.fetch);
    const x = install();
    x.h.init({ tailStartSeq: 1000 });
    void x.h.loadEarlier();
    const run2 = x.h.loadUntil(() => x.has('old0'), () => true);
    await settle(1);
    gate2.release();
    for (let i = 0; i < 10 && calls2.length < 2; i++) await settle(1);
    expect(calls2).toHaveLength(2);
    gate2.release();
    expect(await run2).toBe('found');
    expect(warn).toHaveBeenCalledExactlyOnceWith('load earlier failed:', expect.objectContaining({ message: 'boom' }));
  });

  it('a reset between pages cancels instead of reading as exhausted', async () => {
    const calls: string[] = [];
    const gate = gatedFetch(makePages(5), calls);
    vi.stubGlobal('fetch', gate.fetch);
    const { h, has } = install();
    h.init({ tailStartSeq: 1000 });
    const run = h.loadUntil(() => false, () => true);
    await settle(1);
    gate.release();
    for (let i = 0; i < 10 && calls.length < 2; i++) await settle(1);
    expect(has('old0')).toBe(true);
    h.reset();
    gate.release();
    expect(await run).toBe('cancelled');
    expect(has('old1')).toBe(false);
  });
});
