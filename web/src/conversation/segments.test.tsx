import { afterEach, describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';
import { ConversationModel, userActionsForStatus, type AssistantNode, type ToolNode, type UserNode } from './model';
import { createLazyHistory } from './lazyHistory';
import { flush, noActions, renderModel } from './renderModel';
import { groupsOf, text, thinking, tool, turnEnd } from './testkit';
import type { UiEvent, UiEventOf } from '@shared/uiEvent';

let seq = 1000;
const echo = (t: string, extra: Partial<UiEventOf<'user_echo'>> = {}): UiEventOf<'user_echo'> => ({ kind: 'user_echo', text: t, userIndex: seq % 97, _seq: seq--, ...extra });
const seam = (segmentId: string): UiEventOf<'segment_seam'> => ({ kind: 'segment_seam', segmentId });
const gap = (): UiEventOf<'history_gap'> => ({ kind: 'history_gap' });
const page = (events: any[], extra: object) => ({ events, hasMore: true, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: 'D', ...extra });

/** Readable root sequence: user texts, ‖seam dividers, ⋯ gaps, ↺ replay dividers, A assistants. */
const tokens = (m: ConversationModel) => m.items.map((i) => {
  if (i.type === 'user') return i.displayText;
  if (i.type === 'divider') return i.kind === 'seam' ? `‖${i.segmentId}` : i.kind === 'gap' ? '⋯' : '↺';
  if (i.type === 'assistant') return 'A';
  return i.type;
});

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5)); };

function stubFetch(pages: any[]) {
  const calls: Record<string, string>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url, 'http://localhost');
    expect(u.pathname).toBe('/api/instances/inst1/lineage-events');
    calls.push(Object.fromEntries(u.searchParams));
    const p = pages.shift() ?? { events: [], hasMore: false, segment: null, nextBefore: null };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(p)) };
  }));
  return calls;
}

function install(model = new ConversationModel(), active = { id: 'inst1' }, scrollHeight = 0) {
  const h = createLazyHistory({ model, getActiveId: () => active.id });
  h.setViewport({ clientHeight: () => 800, scrollHeight: () => scrollHeight, preserve: (fn) => fn() });
  return { h, model, active };
}

/** Which user bubbles offer rewind/fork, by text. */
async function actionable(m: ConversationModel) {
  const r = renderModel(m, noActions);
  await flush();
  const out: Record<string, boolean> = {};
  for (const b of r.root.querySelectorAll<HTMLElement>('[data-item="user"]')) {
    out[b.querySelector('[data-user-text]')?.textContent ?? ''] = !!within(b).queryByRole('button', { name: /Rewind/ });
  }
  r.unmount();
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('lineage paging', () => {
  it('C1 follows the cursor across segment changes, including one whose number is not lower', async () => {
    const calls = stubFetch([
      page([echo('d old')], { segment: 'C', nextBefore: null }),
      page([echo('c new')], { segment: 'C', nextBefore: 950 }),
      page([echo('c old')], { segment: 'C', nextBefore: 940, hasMore: false }),
    ]);
    const { h, model } = install();
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls).toEqual([{ limit: '200', before: '900' }, { limit: '200', segment: 'C' }, { limit: '200', before: '950', segment: 'C' }]);
    expect(tokens(model)).toEqual(['c old', 'c new', 'd old']);
  });

  it('C2 a revisited segment, or a stalled same-segment cursor, ends history', async () => {
    const calls = stubFetch([
      page([echo('d old')], { segment: 'C', nextBefore: null }),
      page([echo('c')], { segment: null, nextBefore: 800 }),
      page([echo('never')], { segment: null, nextBefore: 700 }),
    ]);
    const a = install();
    a.h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls).toHaveLength(2);
    expect(a.h.status.get().visible).toBe(false);

    const calls2 = stubFetch([
      page([echo('c1')], { segment: 'C', nextBefore: 500 }),
      page([echo('c2')], { segment: 'C', nextBefore: 500 }),
      page([echo('never')], { segment: 'C', nextBefore: 400 }),
    ]);
    const b = install();
    b.h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls2).toHaveLength(2);
    expect(b.h.status.get().visible).toBe(false);
  });

  it('C3 a segment seam is a "context renewed" divider and a merge barrier', () => {
    const m = new ConversationModel();
    for (const ev of [...text('m1', 0, 'before'), seam('C'), { kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'after' }] satisfies UiEvent[]) m.apply(ev);
    expect(tokens(m)).toEqual(['A', '‖C', 'A']);
  });

  it('C4 a renew/prune/renew walk renders the server\'s dividers in order and adds none', async () => {
    stubFetch([
      page([seam('D'), echo('d first')], { segment: 'C', nextBefore: null, pageSegment: 'D' }),
      page([seam('C'), echo('c first')], { segment: 'A', nextBefore: null, pageSegment: 'C' }),
      page([echo('a first')], { hasMore: false, segment: 'A', nextBefore: 0, pageSegment: 'A' }),
    ]);
    const { h, model } = install();
    model.apply(echo('d tail'));
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(tokens(model)).toEqual(['a first', '‖C', 'c first', '‖D', 'd first', 'd tail']);
  });

  it('C5 a gap page continues into the older segment', async () => {
    const calls = stubFetch([
      page([seam('C'), gap()], { segment: 'A', nextBefore: null }),
      page([echo('a first')], { hasMore: false, segment: 'A', nextBefore: 0, pageSegment: 'A' }),
    ]);
    const { h, model } = install();
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(calls).toHaveLength(2);
    expect(tokens(model)).toEqual(['a first', '‖C', '⋯']);
  });

  it('C7 a divider repeated across responses collapses, keeping the upper one', async () => {
    stubFetch([page([echo('b old'), seam('C'), echo('c older')], { hasMore: false, segment: null, nextBefore: 0 })]);
    const { h, model } = install();
    model.apply(seam('C'));
    model.apply(echo('c tail'));
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(tokens(model)).toEqual(['b old', '‖C', 'c older', 'c tail']);
  });

  it('C13 a probe in flight when the view switches splices nothing and leaves the new view\'s control live', async () => {
    let release!: () => void;
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      await new Promise<void>((r) => { release = r; });
      return { ok: true, json: async () => page([echo('stale probe')], { segment: 'C', nextBefore: null }) };
    }));
    const active = { id: 'inst1' };
    const { h, model } = install(new ConversationModel(), active, 5000);
    h.init({ tailStartSeq: 0 });
    await settle();
    expect(n).toBe(1);
    active.id = 'inst2';
    model.clear();
    h.init({ tailStartSeq: 900 });
    expect(h.status.get().visible).toBe(true);
    release();
    await settle();
    expect(tokens(model)).toEqual([]);
    expect(h.status.get().visible).toBe(true);
  });

  it('C14 page content renders verbatim: a server task_completion is kept; pages dedupe only within themselves', async () => {
    stubFetch([
      page([echo('p1 first', { _seq: 50 }), echo('p1 repeat', { _seq: 50 }), { kind: 'task_completion', tasks: [{ id: '1', subject: 'a batch' }] }], { segment: null, nextBefore: 40 }),
      page([echo('p2 same seq', { _seq: 50 })], { hasMore: false, segment: null, nextBefore: 0 }),
    ]);
    const { h, model } = install();
    model.apply(echo('tail same seq', { _seq: 50 }));
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(tokens(model)).toEqual(['p2 same seq', 'p1 first', 'task_completion', 'tail same seq']);
  });
});

describe('rewind / fork provenance', () => {
  it('C6 only the current segment\'s bubbles offer them; a new current strips every older one', async () => {
    const live = new ConversationModel();
    const older = live.renderPage([echo('a msg')], 'A', 'D');
    expect(await actionable(older)).toEqual({ 'a msg': false });
    const split = live.renderPage([echo('c msg'), seam('D'), echo('d msg 2')], 'C', 'D');
    expect(await actionable(split)).toEqual({ 'c msg': false, 'd msg 2': true });

    live.setCurrentSegment('D');
    live.segmentId = 'D';
    live.apply(echo('d live'));
    live.prependPage(live.renderPage([echo('d msg')], 'D', 'D'), live.leadingAssistantWrap);
    expect(await actionable(live)).toEqual({ 'd msg': true, 'd live': true });
    live.setCurrentSegment('E');
    expect(await actionable(live)).toEqual({ 'd msg': false, 'd live': false });
  });

  it('C9 on snapshot replay, bubbles above the tail\'s divider belong to an earlier segment', async () => {
    const m = new ConversationModel();
    m.setCurrentSegment('B');
    m.segmentId = 'A';
    for (const ev of [echo('a tail'), seam('B'), echo('b tail')]) m.apply(ev);
    expect(await actionable(m)).toEqual({ 'a tail': false, 'b tail': true });
  });

  it('C10 a segment frame with no divider moves current: existing bubbles lose them, the next echo has them', async () => {
    const m = new ConversationModel();
    m.setCurrentSegment('B');
    m.segmentId = 'B';
    m.apply(echo('b one'));
    expect(await actionable(m)).toEqual({ 'b one': true });
    m.segmentId = 'C';
    m.setCurrentSegment('C');
    m.apply(echo('c one'));
    expect(await actionable(m)).toEqual({ 'b one': false, 'c one': true });
  });

  it("C11 while the live view knows no current segment, paged bubbles key on the page's currentSegmentId", async () => {
    stubFetch([
      page([echo('d old')], { segment: 'A', nextBefore: null, pageSegment: 'D', currentSegmentId: 'D' }),
      page([echo('a old')], { hasMore: false, segment: 'A', nextBefore: 0, pageSegment: 'A', currentSegmentId: 'D' }),
    ]);
    const { h, model } = install();
    h.init({ tailStartSeq: 900 });
    await settle();
    expect(await actionable(model)).toEqual({ 'a old': false, 'd old': true });
  });

  it('C12 while no current segment is known at all, every bubble keeps them, across dividers too', async () => {
    const live = new ConversationModel();
    const batch = new ConversationModel({ segmentId: 'A', currentSegmentGetter: () => null });
    for (const ev of [echo('x batch'), seam('B'), echo('y batch')]) batch.apply(ev);
    expect(await actionable(batch)).toEqual({ 'x batch': true, 'y batch': true });
    live.segmentId = 'A';
    for (const ev of [echo('x live'), seam('B'), echo('y live')]) live.apply(ev);
    expect(await actionable(live)).toEqual({ 'x live': true, 'y live': true });
  });

  it('archive bubbles use the server-stamped userIndex; an echo without one offers no buttons', async () => {
    const calls: any[] = [];
    const m = new ConversationModel();
    m.apply({ kind: 'user_echo', text: 'old prompt', userIndex: 3 });
    m.apply({ kind: 'user_echo', text: 'unanchored' });
    const r = renderModel(m, { ...noActions, onRewind: (i, t) => calls.push(['rewind', i, t]), onFork: (i, t) => calls.push(['fork', i, t]) });
    await flush();
    const [stamped, bare] = r.root.querySelectorAll<HTMLElement>('[data-item="user"]');
    expect(stamped.getAttribute('data-user-index')).toBe('3');
    within(stamped).getByRole('button', { name: /Rewind/ }).click();
    within(stamped).getByRole('button', { name: /Fork/ }).click();
    expect(calls).toEqual([['rewind', 3, 'old prompt'], ['fork', 3, 'old prompt']]);
    expect(bare.getAttribute('data-user-index')).toBeNull();
    expect(within(bare).queryByRole('button', { name: /Rewind/ })).toBeNull();
  });

  it('mid-turn: rewind is disabled but fork works; a sub-conversation never offers either', async () => {
    expect(userActionsForStatus('idle')).toEqual({ rewind: true, fork: true });
    expect(userActionsForStatus('turn')).toEqual({ rewind: false, fork: true });
    expect(userActionsForStatus('crashed')).toEqual({ rewind: false, fork: false });
    const m = new ConversationModel();
    m.apply(echo('mid'));
    const { rewind, fork } = userActionsForStatus('turn');
    const r = renderModel(m, { ...noActions, canRewind: rewind, canFork: fork });
    await flush();
    expect((within(r.root).getByRole('button', { name: /Rewind/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(r.root).getByRole('button', { name: /Fork/ }) as HTMLButtonElement).disabled).toBe(false);

    const outer = new ConversationModel();
    for (const ev of tool('m1', 0, 'A', 'Agent', { result: null })) outer.apply(ev);
    outer.apply({ kind: 'user_echo', text: 'child prompt', userIndex: 2, parentToolUseId: 'A' });
    const sub = outer.toolBlocks.get('A')!.sub!;
    expect(sub.items[0].type).toBe('user');
    expect(await actionable(sub)).toEqual({ 'child prompt': false });
  });
});

describe('page merging', () => {
  it('a page that begins at a compaction exposes no leading envelope to merge upward', () => {
    const work = [...tool('m1', 0, 't1', 'Bash'), ...text('m1', 1, 'done')];
    expect(new ConversationModel().renderPage(work, null, null).leadingAssistantWrap).toBeTruthy();
    const withCompaction = new ConversationModel().renderPage([{ kind: 'compaction', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }, ...work], null, null);
    expect(withCompaction.leadingAssistantWrap).toBeNull();
  });

  it('a page never fires TTS auto-speak, and finalizes dangling content', () => {
    const spoken: string[] = [];
    const live = new ConversationModel({ onAssistantText: (n) => spoken.push(n.buffer) });
    const p = live.renderPage([
      ...thinking('m1', 0).slice(0, 2),
      { kind: 'text_delta', msgId: 'm1', blockIdx: 1, text: 'partial' },
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 2, toolUseId: 't', name: 'Bash' },
      ...text('m2', 0, 'whole'),
    ], null, null);
    expect(spoken).toEqual([]);
    const w = p.items[0] as AssistantNode;
    expect(w.children.find((c) => c.type === 'text')).toMatchObject({ finalized: true, buffer: 'partial' });
    const tl = groupsOf(w).flatMap((g) => g.children).find((c): c is ToolNode => c.type === 'tool')!;
    expect(tl.status).toBe('incomplete');
  });

  it('a turn straddling page seams merges into ONE envelope with its blocks in order; adjacent turns stay apart', () => {
    const live = new ConversationModel();
    for (const ev of [...tool('m3', 0, 't3', 'Bash'), ...text('m3', 1, 'part 3')]) live.apply(ev);
    let top = live.leadingAssistantWrap;
    top = live.prependPage(live.renderPage([...text('m2', 0, 'part 2'), ...tool('m2', 1, 't2', 'Read')], null, null), top);
    live.prependPage(live.renderPage([{ kind: 'user_echo', text: 'prompt 1', userIndex: 1 }, ...thinking('m1', 0, 'pondering hard'), ...text('m1', 1, 'part 1')], null, null), top);
    expect(tokens(live)).toEqual(['prompt 1', 'A']);
    const w = live.items[1] as AssistantNode;
    expect(w.children.map((c) => (c.type === 'text' ? c.buffer : c.type))).toEqual(['group', 'part 1', 'part 2', 'group', 'part 3']);
    expect(groupsOf(w)[1].children.map((c) => (c as ToolNode).name)).toEqual(['Read', 'Bash']);

    const sep = new ConversationModel();
    sep.apply({ kind: 'user_echo', text: 'turn B', userIndex: 1 });
    sep.apply({ kind: 'text_delta', msgId: 'mB', blockIdx: 0, text: 'reply B' });
    expect(sep.leadingAssistantWrap).toBeNull();
    sep.prependPage(sep.renderPage([{ kind: 'user_echo', text: 'turn A' }, ...text('mA', 0, 'reply A')], null, null), sep.leadingAssistantWrap);
    expect(tokens(sep)).toEqual(['turn A', 'A', 'turn B', 'A']);
  });

  it('prose at either edge of the seam keeps the two runs apart; a turn_end between the halves keeps their bubbles apart', () => {
    const live = new ConversationModel();
    for (const ev of [...text('m2', 0, 'lower prose'), ...tool('m2', 1, 't2', 'Bash')]) live.apply(ev);
    live.prependPage(live.renderPage(tool('m1', 0, 't1', 'Read'), null, null), live.leadingAssistantWrap);
    const w = live.items[0] as AssistantNode;
    expect(w.children.map((c) => c.type)).toEqual(['group', 'text', 'group']);

    const groupCount = (m: ConversationModel) => (m.items.filter((i) => i.type === 'assistant') as AssistantNode[]).flatMap(groupsOf).length;
    const ended = new ConversationModel();
    for (const ev of tool('mB', 0, 'tB', 'Read', { result: null })) ended.apply(ev);
    ended.prependPage(ended.renderPage([{ kind: 'user_echo', text: 'older' }, ...tool('mA', 0, 'tA', 'Bash'), turnEnd()], null, null), ended.leadingAssistantWrap);
    expect(groupCount(ended)).toBe(2);

    const below = new ConversationModel();
    below.apply(turnEnd());
    for (const ev of tool('mB', 0, 'tB', 'Read', { result: null })) below.apply(ev);
    below.prependPage(below.renderPage([{ kind: 'user_echo', text: 'older' }, ...tool('mA', 0, 'tA', 'Bash')], null, null), below.leadingAssistantWrap);
    expect(below.items.filter((i) => i.type === 'assistant')).toHaveLength(2);
    expect(groupCount(below)).toBe(2);
  });

  it('a historical page ending in a tool run arrives collapsed', () => {
    const p = new ConversationModel().renderPage(tool('m1', 0, 't1', 'Bash'), null, null);
    expect(groupsOf(p.items[0] as AssistantNode)[0].open).toBe(false);
  });

  it('gaps: a merge barrier; adjacent gaps are one divider; gaps separated by content both render; a replay divider beside a gap stays', () => {
    const m = new ConversationModel();
    m.apply(gap());
    m.apply(gap());
    m.apply({ kind: 'text_delta', msgId: 'mR', blockIdx: 5, text: 'surviving tail' });
    expect(tokens(m)).toEqual(['⋯', 'A']);
    expect(m.leadingAssistantWrap).toBeNull();
    m.prependPage(m.renderPage([{ kind: 'user_echo', text: 'turn head' }, { kind: 'text_delta', msgId: 'mH', blockIdx: 0, text: 'head' }], null, null), m.leadingAssistantWrap);
    expect(tokens(m)).toEqual(['turn head', 'A', '⋯', 'A']);

    const two = new ConversationModel();
    two.apply(gap());
    for (const ev of text('m1', 0, 'between')) two.apply(ev);
    two.apply(gap());
    expect(tokens(two).filter((t) => t === '⋯')).toHaveLength(2);

    const rep = new ConversationModel();
    rep.apply({ kind: 'system', subtype: 'history_replayed', data: { count: 3 } });
    rep.apply(gap());
    expect(tokens(rep)).toEqual(['↺', '⋯']);
  });

  it('live child events with an unknown parent are parked, then adopted in order when a page brings the head', () => {
    const live = new ConversationModel();
    live.apply({ kind: 'assistant_message', msgId: 's1', blockIdx: 0, parentToolUseId: 'A', message: { content: [{ type: 'text', text: 'sub part 1' }] } });
    live.apply({ kind: 'assistant_message', msgId: 's1', blockIdx: 1, parentToolUseId: 'A', message: { content: [{ type: 'tool_use', id: 'st', name: 'Read', input: {} }] } });
    expect(live.items).toHaveLength(0);
    live.prependPage(live.renderPage(tool('m1', 0, 'A', 'Agent', { result: null }), null, null), null);
    const sub = live.toolBlocks.get('A')!.sub!;
    const w = sub.items[0] as AssistantNode;
    expect(w.children.map((c) => c.type)).toEqual(['text', 'group']);
    live.apply({ kind: 'text_delta', msgId: 's2', blockIdx: 0, text: 'native', parentToolUseId: 'A' });
    expect(((sub.items.at(-1) as AssistantNode).children.at(-1) as any).buffer).toBe('native');

    const plain = new ConversationModel();
    plain.apply({ kind: 'user_echo', text: 'under bash', parentToolUseId: 'B' });
    plain.prependPage(plain.renderPage(tool('m1', 0, 'B', 'Bash', { result: null }), null, null), null);
    expect((plain.items.find((i) => i.type === 'user') as UserNode).displayText).toBe('under bash');
  });
});
