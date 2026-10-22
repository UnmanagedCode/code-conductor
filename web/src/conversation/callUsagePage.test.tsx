// The per-call usage line on lazily loaded history: a page renders the lines it carries; a
// call_usage that arrives before its message's page (a tail or a page starting between a
// message's last block and its call_usage) waits and shows once that page loads, once only;
// whatever is still waiting is dropped when the transcript is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => undefined }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationView } from './ConversationView';
import { ConversationModel, type AssistantNode } from './model';
import { text, tool, turnEnd } from './testkit';
import { flush, renderModel } from './renderModel';
import { CALL_USAGE_TITLE } from './format';

async function pageRendered(events: any[]) {
  const live = new ConversationModel();
  const page = live.renderPage(events, 'seg1', 'seg1');
  live.prependPage(page, null);
  const r = renderModel(live);
  await flush();
  return r.root;
}

const usageLines = (root: HTMLElement) => root.querySelectorAll(`[title="${CALL_USAGE_TITLE.replace(/"/g, '\\"')}"]`);

describe('call usage on a lazily loaded page', () => {
  it('a page without call_usage events renders no usage line; one with them renders one per call', async () => {
    // Invariant: the usage line is content-driven: absent when the page carries no call_usage, present (and one per call) when it does.
    const base = [{ kind: 'user_echo', text: 'go', userIndex: 0 }, ...tool('m1', 0, 'tu1', 'Read'), ...text('m1', 1, 'done'), ...text('m2', 0, 'again')];
    const bare = await pageRendered(base);
    expect(bare.textContent).toContain('done');
    expect(usageLines(bare)).toHaveLength(0);
    const withUsage = await pageRendered([
      ...base,
      { kind: 'call_usage', msgId: 'm1', promptTokens: 61_000, growthTokens: 2_000, outputTokens: 310, thinkingTokens: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
      { kind: 'call_usage', msgId: 'm2', promptTokens: 63_000, growthTokens: 1_500, outputTokens: 120, thinkingTokens: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    ]);
    expect(usageLines(withUsage)).toHaveLength(2);
  });
});

// ── A call_usage ahead of its message ────────────────────────────────────

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });
const usage = (msgId: string, seq: number): UiEvent => ({ kind: 'call_usage', msgId, promptTokens: 40_000, growthTokens: 1_000, outputTokens: 200, thinkingTokens: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, _seq: seq });
const seqd = (evs: UiEvent[], from: number): UiEvent[] => evs.map((e, i) => ({ ...e, _seq: from + i }));

/** m1's turn up to its reply's text_end: seqs 1–3. */
const M1_PAGE: UiEvent[] = seqd([{ kind: 'user_echo', text: 'first', userIndex: 0 }, ...text('m1', 0, 'm1 reply')], 1);
/** A tail starting on m1's call_usage, between its text_end and the turn's end. */
const TAIL_ON_USAGE: UiEvent[] = [usage('m1', 4), turnEnd({ subtype: 'success', _seq: 5 })];
/** A later turn, for a tail that carries no call_usage. */
const LATER_TAIL: UiEvent[] = seqd([{ kind: 'user_echo', text: 'later', userIndex: 1 }, ...text('m2', 0, 'm2 reply'), turnEnd({ subtype: 'success' })], 10);

const mount = () => {
  const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  return r.container.querySelector('[data-conversation]') as HTMLElement;
};
async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const snapshot = (id: string, events: UiEvent[], tailStartSeq: number) => frame('snapshot', { id, events, tailStartSeq });

/** Answers each lineage request from `pages`, keyed by its `before=` cursor. */
function servePages(pages: Record<number, { events: UiEvent[]; nextBefore: number | null }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const before = Number(new URL(url, 'http://x').searchParams.get('before'));
    const page = pages[before];
    if (!page) throw new Error(`fixture check: no page before ${before}`);
    return { ok: true, status: 200, json: async () => ({ events: page.events, hasMore: page.nextBefore != null, segment: null, nextBefore: page.nextBefore }) };
  }));
}
async function loadEarlier() {
  await act(async () => { await lazyHistory.loadEarlier(); });
  await flush();
}
const bubbleOf = (root: HTMLElement, reply: string) =>
  [...root.querySelectorAll('[data-item="assistant"]')].find((b) => b.textContent?.includes(reply)) as HTMLElement;
/** The bubble's reply text and usage lines, in document order. */
const bubbleReading = (bubble: HTMLElement) =>
  [...bubble.querySelectorAll('[data-call-usage-line], p')].map((el) => (el.hasAttribute('data-call-usage-line') ? 'usage' : el.textContent));

beforeEach(() => {
  act(() => { appStore.set({ instances: [inst('i1'), inst('i2')], activeId: 'i1' }); });
  startController();
});

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('a call_usage that arrives before its message', () => {
  it('a tail starting on a call_usage shows its usage line in the message\'s bubble once the page holding the message loads', async () => {
    // Invariant: a tail-first call_usage is held until its message's page is prepended, then renders once, after the message's text.
    const el = mount();
    servePages({ 4: { events: M1_PAGE, nextBefore: null } });
    await snapshot('i1', TAIL_ON_USAGE, 4);
    expect(usageLines(el), 'fixture check: no bubble for the tail\'s call_usage yet').toHaveLength(0);
    await loadEarlier();
    expect(bubbleReading(bubbleOf(el, 'm1 reply'))).toEqual(['m1 reply', 'usage']);
    expect(usageLines(el)).toHaveLength(1);
  });

  it('a page starting on a call_usage hands it on to the older page holding its message', async () => {
    // Invariant: a call_usage at a page's head waits for the next older page and renders there once.
    const el = mount();
    servePages({ 10: { events: TAIL_ON_USAGE, nextBefore: 4 }, 4: { events: M1_PAGE, nextBefore: null } });
    await snapshot('i1', LATER_TAIL, 10);
    await loadEarlier();
    expect(bubbleOf(el, 'm1 reply'), 'fixture check: the first page holds no m1 bubble').toBeUndefined();
    await loadEarlier();
    expect(bubbleReading(bubbleOf(el, 'm1 reply'))).toEqual(['m1 reply', 'usage']);
    expect(usageLines(el)).toHaveLength(1);
  });

  it('when the page also carries the tail\'s call_usage the line renders once', async () => {
    // Invariant: the held call_usage and the page's copy of the same event render one line.
    const el = mount();
    servePages({ 4: { events: [...M1_PAGE, usage('m1', 4)], nextBefore: null } });
    await snapshot('i1', TAIL_ON_USAGE, 4);
    expect(conversation.orphanCallUsage.has('m1'), 'fixture check: the tail\'s call_usage is held').toBe(true);
    await loadEarlier();
    expect(bubbleReading(bubbleOf(el, 'm1 reply'))).toEqual(['m1 reply', 'usage']);
    expect(usageLines(el)).toHaveLength(1);
  });

  /** Holds m1's call_usage from a tail, runs `reset`, then pages m1's turn in under a tail without one. */
  async function heldThenReset(reset: () => Promise<void>) {
    const el = mount();
    servePages({ 4: { events: M1_PAGE, nextBefore: null }, 10: { events: M1_PAGE, nextBefore: null }, 0: { events: [], nextBefore: null } });
    await snapshot('i1', TAIL_ON_USAGE, 4);
    expect(conversation.orphanCallUsage.has('m1'), 'fixture check: the tail\'s call_usage is held').toBe(true);
    await reset();
    const held = conversation.orphanCallUsage.size;
    await loadEarlier();
    expect(bubbleOf(el, 'm1 reply'), 'fixture check: m1\'s page loaded').toBeDefined();
    return { held, lines: usageLines(el).length };
  }

  it('a fresh snapshot drops a held call_usage, so a later page shows none', async () => {
    // Invariant: a reconnect's snapshot replaces the transcript and nothing held from the old tail applies to a later page.
    expect(await heldThenReset(() => snapshot('i1', LATER_TAIL, 10))).toEqual({ held: 0, lines: 0 });
  });

  it('a rewind drops a held call_usage, so a later page shows none', async () => {
    // Invariant: a reset_snapshot (rewind) replaces the transcript and nothing held from the old tail applies to a later page.
    expect(await heldThenReset(async () => {
      await frame('reset_snapshot', { id: 'i1', events: LATER_TAIL });
      act(() => { lazyHistory.init({ tailStartSeq: 10 }); });
    })).toEqual({ held: 0, lines: 0 });
  });

  it('another session selected and coming back drops a held call_usage, so a later page shows none', async () => {
    // Invariant: a session switch replaces the transcript and nothing held from the old tail applies to a later page.
    expect(await heldThenReset(async () => {
      act(() => { selectInstance('i2'); });
      await snapshot('i2', [], 0);
      act(() => { selectInstance('i1'); });
      await snapshot('i1', LATER_TAIL, 10);
    })).toEqual({ held: 0, lines: 0 });
  });

  it('a held call_usage whose message never arrives renders nothing and is gone after a session switch', async () => {
    // Invariant: a held call_usage with no page holding its message stays inert and does not outlive its session.
    const el = mount();
    const m9Page = seqd([{ kind: 'user_echo', text: 'other', userIndex: 0 }, ...text('m9', 0, 'm9 reply')], 1);
    servePages({ 4: { events: M1_PAGE, nextBefore: null }, 20: { events: m9Page, nextBefore: null } });
    await snapshot('i1', [usage('m9', 4), turnEnd({ subtype: 'success', _seq: 5 })], 4);
    await loadEarlier();
    expect(bubbleReading(bubbleOf(el, 'm1 reply')), 'the page renders without a stray line').toEqual(['m1 reply']);
    expect(usageLines(el)).toHaveLength(0);
    expect(conversation.orphanCallUsage.has('m9'), 'still held, harmlessly').toBe(true);
    act(() => { selectInstance('i2'); });
    await snapshot('i2', seqd([{ kind: 'user_echo', text: 'later', userIndex: 1 }, turnEnd({ subtype: 'success' })], 20), 20);
    expect(conversation.orphanCallUsage.size, 'the switch dropped it').toBe(0);
    await loadEarlier();
    expect(bubbleReading(bubbleOf(el, 'm9 reply')), 'another session\'s page with the same message id gets no line').toEqual(['m9 reply']);
  });

  it('a held call_usage lands inside the open action group its message ends on, where the page\'s own copy lands', () => {
    // Invariant: a parked call_usage takes the same node position as the page's own copy would: inside the message's still-open action group.
    const page = seqd([{ kind: 'user_echo', text: 'first', userIndex: 0 }, ...tool('m1', 0, 'tu1', 'Read')], 1);
    /** The bubble's children, a group as its children's types. */
    const shape = (m: ConversationModel) => (m.items.find((i) => i.type === 'assistant') as AssistantNode).children
      .map((c) => (c.type === 'group' ? c.children.map((g) => g.type) : c.type));
    const native = new ConversationModel();
    native.prependPage(native.renderPage([...page, usage('m1', 5)], null, null), null);
    expect(shape(native), 'fixture check: the page\'s own copy lands inside the group').toEqual([['tool', 'call_usage']]);
    const held = new ConversationModel();
    held.apply(usage('m1', 5));
    expect(held.orphanCallUsage.has('m1'), 'fixture check: held before its page').toBe(true);
    held.prependPage(held.renderPage(page, null, null), null);
    expect(shape(held)).toEqual(shape(native));
  });

  it('a call_usage after its message, in one tail, renders in place', async () => {
    // Invariant (live control): a call_usage whose message is already rendered shows its line at once, after the message's text.
    const el = mount();
    await snapshot('i1', [...M1_PAGE, ...TAIL_ON_USAGE], 1);
    expect(bubbleReading(bubbleOf(el, 'm1 reply'))).toEqual(['m1 reply', 'usage']);
    expect(usageLines(el)).toHaveLength(1);
  });
});
