// Folded user-bubble bodies (wake, skill, forward, compaction) across their
// lifecycle, and the plain user bubble's view controls.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';
import { buildWakeStub, WAKE_CALLBACK_MARKER } from '@shared/wakeCallback';
import { buildForwardFrame, FORWARD_FRAME_HEADER } from '@shared/forwardFrame';
import { buildRenewSeed } from '@shared/renewSeed';
import { ConversationModel, type CompactionNode } from './model';
import { BUBBLE_BODY_MAX_HEIGHT } from './BubbleBody';
import { flush, noActions, renderModel } from './renderModel';
import { readJsonl, replayLines, serverModules } from './testkit';

let S: Awaited<ReturnType<typeof serverModules>>;
beforeAll(async () => { S = await serverModules(); });

let copied: string[] = [];
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } });
});
afterEach(() => vi.restoreAllMocks());

async function echo(text: string, extra: object = {}, actions = noActions) {
  const m = new ConversationModel();
  m.apply({ kind: 'user_echo', text, userIndex: 0, ...extra });
  const r = renderModel(m, actions);
  await flush();
  return { m, root: r.root, bubble: r.root.querySelector('[data-item="user"]') as HTMLElement };
}

/** A bubble in the model's current segment 'A', so rewind/fork show. */
async function inSegment(text: string, extra: object = {}, actions = noActions) {
  const m = new ConversationModel();
  m.setCurrentSegment('A');
  m.segmentId = 'A';
  m.apply({ kind: 'user_echo', text, userIndex: 0, ...extra });
  const r = renderModel(m, actions);
  await flush();
  return { m, root: r.root, bubble: r.root.querySelector('[data-item="user"]') as HTMLElement };
}

/** Moves the model to a new segment, retiring every bubble rendered so far. */
async function retire(m: ConversationModel) {
  await act(async () => { m.setCurrentSegment('B'); });
  await flush();
}

const toggleFold = async (fold: Element) => {
  fireEvent.click(fold.querySelector('[data-fold-trigger]')!);
  await flush();
};

/** Counts clicks that reach `document`. */
function documentClicks() {
  const box = { n: 0 };
  const onClick = () => { box.n++; };
  document.addEventListener('click', onClick);
  return { box, off: () => document.removeEventListener('click', onClick) };
}

const contentOf = (fold: Element) => fold.querySelector('[data-slot="collapsible-content"]') as HTMLElement;
const labels = (nodes: Iterable<Element>) => [...nodes].map((b) => b.getAttribute('aria-label'));
const buttons = (scope: Element) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name }) as HTMLButtonElement;

const PAYLOAD = '{"sessionId":"abc12345","source":"live"}\n--- message 1/1 ---\n**bold** prose\n\n- item a';
const META_LINE = PAYLOAD.split('\n')[0];
const STUB = buildWakeStub({ targetSessionId: 'abc12345', payloadText: PAYLOAD });
const SKILL_TEXT = '# Keybindings\n\nUse **this** skill when…';
const SKILL = { skillLoad: { skill: 'keybindings-help' } };

describe('wake-callback bubble lifecycle', () => {
  // Invariant: only opening the fold builds its body; a toggle event or focus on a closed fold leaves its content box empty.
  it('a toggle event or a focus landing on a closed fold builds nothing; only opening it builds the body', async () => {
    const { bubble } = await echo(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    const content = contentOf(fold);
    expect(content).not.toBeNull();
    fold.dispatchEvent(new Event('toggle'));
    content.dispatchEvent(new Event('toggle'));
    fireEvent.focus(fold.querySelector('[data-fold-trigger]')!);
    await flush();
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(content.childElementCount).toBe(0);
    expect(fold.querySelector('[data-wake-meta]')).toBeNull();
    await toggleFold(fold);
    expect(fold.querySelector('[data-wake-meta]')!.textContent).toBe(META_LINE);
  });

  // Invariant: the body is built once and kept, with its raw view, across a collapse and reopen; a closed fold's box is hidden.
  it('the body is built on the first expand and reused afterwards: the same nodes and the raw view survive a collapse and reopen', async () => {
    const { bubble } = await echo(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(fold);
    const meta = fold.querySelector('[data-wake-meta]')!;
    const md = fold.querySelector('.md')!;
    await toggleFold(fold);
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(contentOf(fold).hidden).toBe(true);
    expect(fold.contains(meta)).toBe(true);
    await toggleFold(fold);
    expect(fold.querySelector('[data-wake-meta]') === meta).toBe(true);
    expect(fold.querySelector('.md') === md).toBe(true);
    expect(fold.querySelectorAll('[data-wake-meta]')).toHaveLength(1);
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    await toggleFold(fold);
    await toggleFold(fold);
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(PAYLOAD);
    expect(within(fold).queryByRole('button', { name: 'Show rendered markdown' })).not.toBeNull();
  });

  // Invariant: a body with no newline is all meta line, renders no markdown, and copies whole.
  it('a wake body with no newline renders its whole text as the meta line, with no markdown after it, and copy returns it exactly', async () => {
    const p0 = '{"sessionId":"abc12345","messages":[],"source":"live"}';
    const { bubble } = await echo(buildWakeStub({ targetSessionId: 'abc12345', payloadText: p0 }));
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(fold);
    expect(fold.querySelector('[data-wake-meta]')!.textContent).toBe(p0);
    expect(fold.querySelector('.md')!.childElementCount).toBe(0);
    fireEvent.click(button(fold, 'Copy text'));
    await flush();
    expect(copied).toEqual([p0]);
  });

  // Invariant: framing lines render as paragraphs, never rules or headings, while the markdown around them still renders.
  it('framing lines stay paragraphs and the plan heading stays a heading: the payload goes through the shared markdown renderer', async () => {
    const FRAMED = ['{"sessionId":"abc12345"}', '--- message 1/2 · msg_01 · 20 chars ---', '**bold** prose', '', '- item a', '- item b', '', '--- message 2/2 · msg_02 · 5 chars ---', 'text', '--- plan ---', '# Plan: x', '--- questions ---', '1. Q (multiSelect: false)', '   - opt'].join('\n');
    const { bubble } = await echo(buildWakeStub({ targetSessionId: 'abc12345', payloadText: FRAMED }));
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(fold);
    expect(fold.querySelector('hr')).toBeNull();
    expect(fold.querySelector('.md h1')!.textContent).toBe('Plan: x');
    const ps = [...fold.querySelectorAll('.md p')].map((p) => p.textContent ?? '');
    for (const line of ['message 1/2 · msg_01', '--- plan ---', '--- questions ---']) {
      expect(ps.some((p) => p.includes(line)), line).toBe(true);
    }
    expect(fold.querySelector('.md strong')!.textContent).toBe('bold');
  });

  // Invariant: raw is the literal payload with no meta treatment; rendered restores the meta line and the markdown.
  it('raw shows the whole body literally, meta line included; switching back restores the meta line and the markdown', async () => {
    const { bubble } = await echo(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(fold);
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    const raw = fold.querySelector('[data-view="raw"]')!;
    expect(raw.textContent).toBe(PAYLOAD);
    expect(raw.childElementCount).toBe(0);
    expect(fold.querySelector('[data-wake-meta]')).toBeNull();
    expect(fold.querySelector('.md strong')).toBeNull();
    fireEvent.click(button(fold, 'Show rendered markdown'));
    await flush();
    expect(fold.querySelector('[data-wake-meta]')!.textContent).toBe(META_LINE);
    expect(fold.querySelector('.md strong')!.textContent).toBe('bold');
    expect(fold.querySelector('[data-view="raw"]')).toBeNull();
  });

  // Invariant: the fold's copy is the exact payload in either view, never the summary or the markers.
  it('copy returns the exact payload in both views, never the summary or the markers', async () => {
    const { bubble } = await echo(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(fold);
    fireEvent.click(button(fold, 'Copy text'));
    fireEvent.click(button(fold, 'Show raw text'));
    fireEvent.click(button(fold, 'Copy text'));
    await flush();
    expect(copied).toEqual([PAYLOAD, PAYLOAD]);
    expect(copied.some((c) => c.includes('finished its turn') || c.includes(WAKE_CALLBACK_MARKER) || c.includes('[[cc:'))).toBe(false);
  });

  // Invariant: retirement drops rewind/fork but not the fold's view controls or their state; a running turn never disables them; their clicks never reach document nor collapse the fold.
  it('its fold controls survive segment retirement and a running turn, and their clicks stay inside the fold', async () => {
    const { m, bubble } = await inSegment(STUB);
    const fold = bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    expect(within(bubble).queryByRole('button', { name: 'Rewind to before this message' })).not.toBeNull();
    await toggleFold(fold);
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    await retire(m);
    expect(within(bubble).queryByRole('button', { name: 'Rewind to before this message' })).toBeNull();
    expect(fold.getAttribute('data-state')).toBe('open');
    expect(labels(buttons(contentOf(fold)))).toEqual(['Show rendered markdown', 'Copy text']);
    for (const b of buttons(contentOf(fold))) expect(b.disabled).toBe(false);
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(PAYLOAD);

    const c = documentClicks();
    try {
      fireEvent.click(button(fold, 'Show rendered markdown'));
      fireEvent.click(button(fold, 'Copy text'));
      await flush();
      expect(c.box.n).toBe(0);
      expect(fold.getAttribute('data-state')).toBe('open');
      fireEvent.click(fold.querySelector('[data-wake-meta]')!);
      expect(c.box.n).toBe(1);
    } finally {
      c.off();
    }

    const busy = await inSegment(STUB, {}, { ...noActions, canRewind: false, canFork: false });
    expect(button(busy.bubble, 'Rewind to before this message').disabled).toBe(true);
    expect(button(busy.bubble, 'Fork a new session from here').disabled).toBe(true);
    const busyFold = busy.bubble.querySelector('[data-fold="wake"]') as HTMLElement;
    await toggleFold(busyFold);
    expect(button(busyFold, 'Show raw text').disabled).toBe(false);
    expect(button(busyFold, 'Copy text').disabled).toBe(false);
  });
});

describe('skill-load bubble lifecycle', () => {
  // Invariant: the skill body is built once and the same node is kept across a collapse and reopen.
  it('the body is built on the first expand and reused afterwards: the same node across a collapse and reopen', async () => {
    const { bubble } = await echo(SKILL_TEXT, SKILL);
    const fold = bubble.querySelector('[data-fold="skill"]') as HTMLElement;
    await toggleFold(fold);
    const md = fold.querySelector('.md')!;
    expect(md.querySelector('h1')!.textContent).toBe('Keybindings');
    await toggleFold(fold);
    expect(contentOf(fold).hidden).toBe(true);
    expect(fold.contains(md)).toBe(true);
    await toggleFold(fold);
    expect(fold.querySelector('.md') === md).toBe(true);
    expect(fold.querySelectorAll('.md')).toHaveLength(1);
  });

  // Invariant: retirement drops rewind/fork but not the skill fold's view controls or their state; a running turn never disables them; their clicks never reach document nor collapse the fold.
  it('its fold controls survive segment retirement and a running turn; their clicks stay inside and never collapse the fold', async () => {
    const { m, bubble } = await inSegment(SKILL_TEXT, SKILL);
    const fold = bubble.querySelector('[data-fold="skill"]') as HTMLElement;
    expect(within(bubble).getByRole('button', { name: 'Rewind to before this message' })).not.toBeNull();
    await toggleFold(fold);
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    await retire(m);
    expect(within(bubble).queryByRole('button', { name: 'Rewind to before this message' })).toBeNull();
    expect(fold.getAttribute('data-state')).toBe('open');
    expect(labels(buttons(contentOf(fold)))).toEqual(['Show rendered markdown', 'Copy text']);
    for (const b of buttons(contentOf(fold))) expect(b.disabled).toBe(false);
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(SKILL_TEXT);

    const c = documentClicks();
    try {
      fireEvent.click(button(fold, 'Show rendered markdown'));
      fireEvent.click(button(fold, 'Copy text'));
      await flush();
      expect(c.box.n).toBe(0);
      expect(fold.getAttribute('data-state')).toBe('open');
      fireEvent.click(fold.querySelector('.md p')!);
      expect(c.box.n).toBe(1);
    } finally {
      c.off();
    }

    const busy = await inSegment(SKILL_TEXT, SKILL, { ...noActions, canRewind: false, canFork: false });
    expect(button(busy.bubble, 'Rewind to before this message').disabled).toBe(true);
    expect(button(busy.bubble, 'Fork a new session from here').disabled).toBe(true);
    const busyFold = busy.bubble.querySelector('[data-fold="skill"]') as HTMLElement;
    await toggleFold(busyFold);
    expect(button(busyFold, 'Show raw text').disabled).toBe(false);
    expect(button(busyFold, 'Copy text').disabled).toBe(false);
  });
});

describe('forward-frame bubble copies', () => {
  const MESSAGES = ['first message with **x**', '--- plan · saved to /tmp/plans/demo.md ---\n# Plan: demo\n\n- step one', '--- questions ---\n1. Q one'];
  const INSTRUCTION = 'Please review and respond.';
  const FRAME = buildForwardFrame({ messages: MESSAGES, instruction: INSTRUCTION });
  const PAYLOAD_F = MESSAGES.map((b, i) => `--- message ${i + 1}/3 ---\n${b}`).join('\n\n');

  // Invariant: the fold copies the exact payload bytes in either view; the bubble copies the instruction alone.
  it('each copy yields the exact bytes its view shows: the payload in the fold, the instruction on the bubble', async () => {
    const { bubble } = await echo(FRAME);
    const fold = bubble.querySelector('[data-fold="forward"]') as HTMLElement;
    await toggleFold(fold);
    fireEvent.click(button(fold, 'Copy text'));
    fireEvent.click(button(bubble, 'Copy message'));
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(PAYLOAD_F);
    fireEvent.click(button(fold, 'Copy text'));
    await flush();
    expect(copied).toEqual([PAYLOAD_F, INSTRUCTION, PAYLOAD_F]);
  });

  // Invariant: only a complete frame folds; a header line alone or a frame with no footer renders whole as a plain bubble.
  it('near-miss frames stay plain user bubbles: the header line alone, or a frame cut off before its footer', async () => {
    const firstLine = FORWARD_FRAME_HEADER.slice(0, FORWARD_FRAME_HEADER.indexOf('\n'));
    const nearMisses = [
      `${firstLine}\n--- message 1/1 ---\nout\n--- END FORWARDED WORKER OUTPUT ---\n\ngo`,
      `${FORWARD_FRAME_HEADER}\n\nworker output cut short`,
    ];
    for (const text of nearMisses) {
      const { bubble } = await echo(text);
      expect(bubble.getAttribute('data-variant')).toBe('plain');
      expect(bubble.querySelector('[data-fold]')).toBeNull();
      fireEvent.click(button(bubble, 'Show raw text'));
      await flush();
      expect(bubble.querySelector('[data-view="raw"]')!.textContent).toBe(text);
    }
    expect((await echo(FRAME)).bubble.getAttribute('data-variant')).toBe('forward');
  });
});

describe('compaction fold', () => {
  // Invariant: the summary sits collapsed and unbuilt until opened; its raw view and copy are the summary verbatim.
  it('the summary sits collapsed, expands lazily into the markdown body, and its raw view and copy are the exact summary', async () => {
    const m = new ConversationModel();
    replayLines(m, S.replayPersistedLine, readJsonl('compaction-manual.transcript.jsonl'));
    const summary = (m.items.find((i) => i.type === 'compaction') as CompactionNode).summary!;
    expect(summary.startsWith('This session is being continued')).toBe(true);
    const { root } = renderModel(m);
    await flush();
    const folds = root.querySelectorAll('[data-fold="compaction"]');
    expect(folds).toHaveLength(1);
    const fold = folds[0] as HTMLElement;
    expect(fold.getAttribute('data-state')).toBe('closed');
    expect(fold.querySelector('.md')).toBeNull();
    expect(within(fold).queryByRole('button', { name: 'Copy text' })).toBeNull();
    expect(fold.querySelector('[data-fold-title]')!.textContent).toContain('Context compacted');
    await toggleFold(fold);
    expect(fold.querySelector('.md')!.textContent).toContain('Primary Request and Intent');
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    expect(fold.querySelector('[data-view="raw"]')!.textContent).toBe(summary);
    fireEvent.click(button(fold, 'Copy text'));
    await flush();
    expect(copied).toEqual([summary]);
  });
});

describe('plain user bubble controls', () => {
  // Invariant: the bubble's toggle and copy stop their clicks at the button in both views.
  it('clicks on the toggle and copy buttons never leave the button, in either view', async () => {
    const { bubble } = await echo('**bold**');
    const c = documentClicks();
    try {
      fireEvent.click(button(bubble, 'Show raw text'));
      fireEvent.click(button(bubble, 'Copy message'));
      fireEvent.click(button(bubble, 'Show rendered markdown'));
      fireEvent.click(button(bubble, 'Copy message'));
      await flush();
      expect(c.box.n).toBe(0);
      expect(copied).toEqual(['**bold**', '**bold**']);
      fireEvent.click(bubble.querySelector('[data-user-text]')!);
      expect(c.box.n).toBe(1);
    } finally {
      c.off();
    }
  });

  // Invariant: retirement removes only rewind/fork; a running turn disables only rewind/fork.
  it('toggle and copy survive segment retirement and stay enabled during a running turn', async () => {
    const { m, bubble } = await inSegment('hello world');
    expect(labels(buttons(bubble))).toEqual(['Show raw text', 'Copy message', 'Rewind to before this message', 'Fork a new session from here']);
    await retire(m);
    expect(labels(buttons(bubble))).toEqual(['Show raw text', 'Copy message']);
    for (const b of buttons(bubble)) expect(b.disabled).toBe(false);

    const busy = await inSegment('hello world', {}, { ...noActions, canRewind: false, canFork: false });
    expect(labels(buttons(busy.bubble))).toEqual(['Show raw text', 'Copy message', 'Rewind to before this message', 'Fork a new session from here']);
    expect(buttons(busy.bubble).map((b) => b.disabled)).toEqual([false, false, true, true]);
  });
});

describe('fold markers', () => {
  // Invariant: wake, skill, renew and forward bubbles each carry exactly one [data-fold] of their own kind; a plain prompt carries none.
  it('every folded user-bubble kind, renew included, carries its own data-fold marker, and a plain prompt none', async () => {
    const cases: [string, object, string][] = [
      [STUB, {}, 'wake'],
      [SKILL_TEXT, SKILL, 'skill'],
      [buildRenewSeed({ summary: 'just some free-form prose with no headings at all.' }), {}, 'renew'],
      [buildForwardFrame({ messages: ['out'], instruction: 'go' }), {}, 'forward'],
    ];
    for (const [text, extra, kind] of cases) {
      const { bubble } = await echo(text, extra);
      expect([...bubble.querySelectorAll('[data-fold]')].map((f) => f.getAttribute('data-fold')), kind).toEqual([kind]);
    }
    expect((await echo('hello')).bubble.querySelectorAll('[data-fold]')).toHaveLength(0);
  });
});

describe('folded bodies scroll inside the fold', () => {
  const frame = buildForwardFrame({ messages: ['first message with **x**'], instruction: 'Please review.' });
  const compaction = async () => {
    const m = new ConversationModel();
    replayLines(m, S.replayPersistedLine, readJsonl('compaction-manual.transcript.jsonl'));
    const { root } = renderModel(m);
    await flush();
    return root;
  };
  const kinds: [string, () => Promise<HTMLElement | Element>][] = [
    ['skill', async () => (await echo(SKILL_TEXT, SKILL)).bubble],
    ['wake', async () => (await echo(STUB)).bubble],
    ['renew', async () => (await echo(buildRenewSeed({ summary: 'just some free-form prose with no headings at all.' }))).bubble],
    ['forward', async () => (await echo(frame)).bubble],
    ['compaction', compaction],
  ];

  // Invariant: each fold kind's body (rendered or raw) sits in one bounded scroll region; the trigger, the view toggle and Copy sit outside it.
  it.each(kinds)('%s: the body is one bounded region, and the trigger and toolbar sit outside it', async (kind, open) => {
    const host = await open();
    const fold = host.querySelector(`[data-fold="${kind}"]`) as HTMLElement;
    await toggleFold(fold);
    const regions = fold.querySelectorAll<HTMLElement>('[data-bubble-body]');
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region.style.maxHeight).toBe(BUBBLE_BODY_MAX_HEIGHT);
    expect(region.style.overflowY).toBe('auto');
    expect(region.textContent!.length).toBeGreaterThan(0);
    expect(region.contains(fold.querySelector('[data-fold-trigger]'))).toBe(false);
    expect(region.contains(button(fold, 'Show raw text'))).toBe(false);
    expect(region.contains(button(fold, 'Copy text'))).toBe(false);
    fireEvent.click(button(fold, 'Show raw text'));
    await flush();
    const raw = fold.querySelector('[data-view="raw"]')!;
    const rawRegions = fold.querySelectorAll<HTMLElement>('[data-bubble-body]');
    expect(rawRegions).toHaveLength(1);
    expect(rawRegions[0].contains(raw)).toBe(true);
    expect(rawRegions[0].style.maxHeight).toBe(BUBBLE_BODY_MAX_HEIGHT);
    expect(rawRegions[0].contains(button(fold, 'Show rendered markdown'))).toBe(false);
  });
});
