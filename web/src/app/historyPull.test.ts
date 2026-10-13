// The client half of a resume/respawn/rewind: the server withholds the
// replayed history from the socket and sends only a live `history_replayed`,
// which is the active session's cue to re-subscribe and load the history
// through the snapshot + lazy scroll-back path a reload uses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiEvent } from '@shared/uiEvent';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  const sent: any[] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: any) => { sent.push([t, payload]); }) };
});
vi.mock('./sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));

const LAST_PAGE = { events: [], hasMore: false, segment: null, nextBefore: null };
const REPLAYED: UiEvent = { kind: 'system', subtype: 'history_replayed', data: { count: 3 } };

let b: Awaited<ReturnType<typeof boot>>;

async function boot() {
  vi.resetModules();
  const ws: any = await import('@shared/ws');
  ws.sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes('/lineage-events') ? LAST_PAGE : url.includes('conductors') ? {} : []),
  })));
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  appStore.set({ instances: [
    { id: 'i1', project: 'p', status: 'idle', sessionId: 's1', mode: 'default' },
    { id: 'i2', project: 'p', status: 'idle', sessionId: 's2', mode: 'default' },
  ] });
  c.startController();
  const emit = (t: string, detail: object) => ws.bus.dispatchEvent(new CustomEvent(t, { detail }));
  const subscribes = () => (ws.sent as [string, { id: string }][]).filter(([t]) => t === 'subscribe');
  return { c, ws, emit, subscribes };
}

beforeEach(async () => {
  history.replaceState(null, '', '/');
  b = await boot();
  b.c.selectInstance('i1');
});

afterEach(() => {
  b.c.stopController();
  vi.unstubAllGlobals();
});

/** Each root's text in order: a user bubble's prompt, an assistant's text blocks. */
function rootTexts(items: readonly any[]): string[] {
  return items.flatMap((i) => (i.type === 'user' ? [i.rawText]
    : i.type === 'assistant' ? i.children.filter((ch: any) => ch.type === 'text').map((ch: any) => ch.buffer) : []));
}

const turn = (n: number, base: number): UiEvent[] => [
  { kind: 'user_echo', text: `ask ${n}`, _seq: base },
  { kind: 'text_delta', msgId: `m${n}`, blockIdx: 0, text: `reply ${n}`, _seq: base + 1 },
  { kind: 'text_end', msgId: `m${n}`, blockIdx: 0, _seq: base + 2 },
];

describe('a live history_replayed', () => {
  it('for the active session re-sends subscribe', () => {
    b.emit('snapshot', { id: 'i1', events: [], tailStartSeq: 0 });
    b.ws.sent.length = 0;
    b.emit('event', { id: 'i1', ev: REPLAYED });
    expect(b.subscribes()).toEqual([['subscribe', { id: 'i1' }]]);
  });

  it('adds no divider to the conversation', () => {
    b.emit('snapshot', { id: 'i1', events: [], tailStartSeq: 0 });
    b.emit('event', { id: 'i1', ev: REPLAYED });
    expect(b.c.conversation.items.filter((i) => i.type === 'divider')).toEqual([]);
  });

  it('inside a snapshot does not re-subscribe', () => {
    b.ws.sent.length = 0;
    b.emit('snapshot', { id: 'i1', events: [...turn(0, 0), { ...REPLAYED, _seq: 3 }], tailStartSeq: 0 });
    expect(b.subscribes()).toEqual([]);
  });

  it('for another instance does not re-subscribe', () => {
    b.emit('snapshot', { id: 'i1', events: [], tailStartSeq: 0 });
    b.ws.sent.length = 0;
    b.emit('event', { id: 'i2', ev: REPLAYED });
    expect(b.subscribes()).toEqual([]);
  });

  it('leads to a pulled snapshot that replaces the pre-pull view, re-arms scroll-back, and live events after it append once', async () => {
    b.emit('snapshot', { id: 'i1', events: [], tailStartSeq: 0 });
    await b.c.lazyHistory.loadEarlier();
    expect(b.c.lazyHistory.state().hasMore, 'precondition: the empty pre-replay snapshot found nothing to page').toBe(false);
    b.emit('event', { id: 'i1', ev: REPLAYED });
    b.emit('snapshot', { id: 'i1', events: [...turn(0, 10), ...turn(1, 13), ...turn(2, 16)], tailStartSeq: 10 });
    expect(b.c.lazyHistory.state().hasMore, 'older history below the pulled tail is pageable').toBe(true);
    b.emit('event', { id: 'i1', ev: { kind: 'user_echo', text: 'ask 3', _seq: 19 } });
    b.emit('event', { id: 'i1', ev: { kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'reply 2', _seq: 17 } });
    expect(rootTexts(b.c.conversation.items)).toEqual(['ask 0', 'reply 0', 'ask 1', 'reply 1', 'ask 2', 'reply 2', 'ask 3']);
  });
});
