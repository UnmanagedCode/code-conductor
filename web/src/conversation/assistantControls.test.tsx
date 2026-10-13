// The assistant bubble's controls: what copy hands the clipboard (each text block's
// source in stream order and the plan that closes the bubble; never thinking, tools,
// questions or sub-agent output), the raw view every text block of the bubble follows,
// a read-aloud of its own on every finished text block, and the same controls mid-stream, on a retired segment, in a replay, on a
// lazy page and across a page seam. The controls sit on the turn-end row directly below the bubble, else on a row of the bubble's own. A copy announces its outcome while the button keeps
// its name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { voiceStore } from '@/features/voice/store';
import * as tts from '@/features/voice/tts';
import { startVoice } from '@/features/voice';
import { conversation } from '@/app/controller';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel, userActionsForStatus, type AssistantNode, type TextNode, type ToolNode } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { groupsOf, text, thinking, tool, turnEnd } from './testkit';

let copied: string[] = [];
let rejectCopy = false;
beforeEach(() => {
  copied = [];
  rejectCopy = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { copied.push(t); return rejectCopy ? Promise.reject(new Error('denied')) : Promise.resolve(); } },
  });
});
afterEach(() => {
  vi.useRealTimers();
  act(() => { voiceStore.set({ ttsAvailable: false }); tts.speakStore.set({ activeNodeId: null }); });
});

async function show(events: UiEvent[], m = new ConversationModel(), actions = noActions) {
  m.applyEvents(events);
  const { root } = renderModel(m, actions);
  await flush();
  return { m, root };
}
async function live(m: ConversationModel, events: UiEvent[]) {
  act(() => { for (const ev of events) m.apply(ev); });
  await flush();
}

/** The transcript's outer assistant bubbles, not the sub-agent bubbles nested in one. */
const bubbles = (root: HTMLElement) =>
  ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).filter((b) => !b.parentElement!.closest('[data-item="assistant"]'));
/** A sub-agent's bubbles, inside an outer one. */
const subBubbles = (root: HTMLElement) =>
  ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).filter((b) => !!b.parentElement!.closest('[data-item="assistant"]'));
/** The turn-end row right under the bubble in the DOM; null when something else (or nothing) follows it. */
const turnEndBelow = (b: HTMLElement) => {
  const next = b.nextElementSibling;
  return next?.matches('[data-item="turn-end"]') ? (next as HTMLElement) : null;
};
const ownCopy = (b: HTMLElement) =>
  ([...b.querySelectorAll('button[aria-label="Copy message"]')] as HTMLButtonElement[]).find((x) => x.closest('[data-item="assistant"]') === b) ?? null;
/** The bubble's copy button, in its own row or on the turn-end row below it; null while the bubble has no controls. */
const copyButton = (b: HTMLElement) =>
  ownCopy(b) ?? (turnEndBelow(b)?.querySelector('button[aria-label="Copy message"]') as HTMLButtonElement | null) ?? null;
/** Where the bubble's controls are. */
const placement = (b: HTMLElement): 'bubble' | 'turn-end' | 'none' =>
  ownCopy(b) ? 'bubble' : turnEndBelow(b)?.querySelector('button[aria-label="Copy message"]') ? 'turn-end' : 'none';
/** The bubble holds no row of controls: no copy or raw button, and every body child is one of its own blocks. */
function noOwnRow(b: HTMLElement, node: AssistantNode) {
  const ownRaw = ([...b.querySelectorAll('button')] as HTMLButtonElement[]).filter((x) => /^Show (raw text|rendered markdown)$/.test(x.getAttribute('aria-label') ?? '') && x.closest('[data-item="assistant"]') === b);
  expect(ownCopy(b) ?? ownRaw[0] ?? null, 'the bubble holds no copy or raw button').toBeNull();
  expect(b.querySelector('[data-assistant-body]')!.children.length, 'every body child is one of the bubble\'s blocks').toBe(node.children.length);
}
/** The bubble's controls: the row holding its copy button. */
const controls = (b: HTMLElement) => {
  const copy = copyButton(b);
  return copy ? ([...copy.parentElement!.querySelectorAll('button')] as HTMLButtonElement[]) : [];
};
const names = (b: HTMLElement) => controls(b).map((x) => x.getAttribute('aria-label'));
function control(b: HTMLElement, name: string) {
  const hit = controls(b).find((x) => x.getAttribute('aria-label') === name);
  if (!hit) throw new Error(`no "${name}" control; the bubble offers ${JSON.stringify(names(b))}`);
  return hit;
}
async function copyOf(b: HTMLElement) {
  fireEvent.click(control(b, 'Copy message'));
  await flush();
  return copied.at(-1);
}
/** Clicks the toggle that offers `to`; its name says which view a click switches to. */
async function view(b: HTMLElement, to: 'raw' | 'rendered') {
  fireEvent.click(control(b, to === 'raw' ? 'Show raw text' : 'Show rendered markdown'));
  await flush();
}
/** What the live region beside the bubble's copy button says; '' while it says nothing. */
const announced = (b: HTMLElement) => copyButton(b)?.parentElement?.querySelector('[aria-live]')?.textContent ?? '';
const OFFERS_RAW = ['Show raw text', 'Copy message'];
const OFFERS_RENDERED = ['Show rendered markdown', 'Copy message'];
/** The bubble's own read-aloud controls in document order, never a sub-agent bubble's inside it. */
const speakControls = (b: HTMLElement) =>
  ([...b.querySelectorAll('button')] as HTMLButtonElement[]).filter((x) => /^(Read aloud|Stop reading)$/.test(x.getAttribute('aria-label') ?? '') && x.closest('[data-item="assistant"]') === b);
const speakLabels = (b: HTMLElement) => speakControls(b).map((x) => x.getAttribute('aria-label'));
/** Clicks each of the bubble's read-aloud controls in order; what each handed the speech toggle, as [text, block id]. */
function spoken(b: HTMLElement): [string, string][] {
  const toggle = vi.spyOn(tts, 'toggleSpeak').mockImplementation(() => {});
  try {
    for (const x of speakControls(b)) fireEvent.click(x);
    return toggle.mock.calls.map(([t, id]) => [t, id]);
  } finally {
    toggle.mockRestore();
  }
}
/** The bubble's own text block wrappers in document order, never a sub-agent bubble's inside it. */
const blockWrappers = (b: HTMLElement) =>
  ([...b.querySelectorAll('[data-text-block]')] as HTMLElement[]).filter((w) => w.closest('[data-item="assistant"]') === b);
/** Per text block of the bubble, in order: the text its own read-aloud control speaks, or null where it has none. */
function blockSpeech(b: HTMLElement): (string | null)[] {
  const toggle = vi.spyOn(tts, 'toggleSpeak').mockImplementation(() => {});
  try {
    return blockWrappers(b).map((w) => {
      const own = speakControls(b).filter((x) => w.contains(x));
      if (own.length > 1) throw new Error(`a text block holds ${own.length} read-aloud controls`);
      if (!own.length) return null;
      fireEvent.click(own[0]);
      return toggle.mock.calls.at(-1)![0];
    });
  } finally {
    toggle.mockRestore();
  }
}
/** Per text block of the bubble that has a read-aloud control: the block's text before that control, and any after it. */
function aroundControl(b: HTMLElement): { before: string; after: string }[] {
  return blockWrappers(b).flatMap((w) => {
    const [x] = speakControls(b).filter((c) => w.contains(c));
    if (!x) return [];
    let before = '';
    let after = '';
    const walk = document.createTreeWalker(w, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (x.contains(n)) continue;
      if (x.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) before += n.textContent;
      else after += n.textContent;
    }
    return [{ before: before.trim(), after: after.trim() }];
  });
}
/**
 * Fakes only the audio device and the TTS endpoint: `bodies` is what each POST /api/tts asked to speak, each answered
 * with one sentence that plays until `end()` ends whatever is playing.
 */
function fakeSpeech() {
  const bodies: string[] = [];
  const playing: { onended: (() => void) | null }[] = [];
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    async resume() {}
    async decodeAudioData() { return { duration: 1 }; }
    createBufferSource() {
      const s = { buffer: null as unknown, onended: null as (() => void) | null, connect() {}, start() {}, stop() {} };
      playing.push(s);
      return s;
    }
  }
  const w = window as unknown as { AudioContext?: unknown };
  const prior = w.AudioContext;
  w.AudioContext = FakeAudioContext;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const frame = new Uint8Array(4 + 8);
    new DataView(frame.buffer).setUint32(0, 8, true);
    return new Response(frame, { status: 200 });
  }));
  return {
    bodies,
    isPlaying: () => playing.length > 0,
    end: () => { for (const s of playing.splice(0)) s.onended?.(); },
    restore: () => { w.AudioContext = prior; vi.unstubAllGlobals(); },
  };
}
/** Lets the speech queue's promise chain run, a bounded number of ticks, until `ok` holds. */
async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 50 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  if (!ok()) throw new Error(`never happened: ${what}`);
}
/** The first bubble's text blocks, from the model. */
const textBlocks = (m: ConversationModel) => (m.items[0] as AssistantNode).children.filter((c): c is TextNode => c.type === 'text');
/** Three finished text blocks, each with its own text, a tool call and a thinking block between them. */
const threeBlocks = (): UiEvent[] => [
  ...text('m1', 0, 'ALPHA first **block**'),
  ...tool('m1', 1, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }),
  ...text('m1', 2, 'BRAVO second block'),
  ...thinking('m1', 3, 'hmm'),
  ...text('m1', 4, 'CHARLIE third block'),
];

describe('copy', () => {
  it("hands the clipboard every text block's source in stream order, joined by a blank line, and no thinking, tool call or result", async () => {
    const { root } = await show([
      ...text('m1', 0, 'A with **bold**'),
      ...thinking('m1', 1, 'SECRET-THOUGHT'),
      ...tool('m1', 2, 'tu1', 'Bash', { input: { command: 'echo CMD-MARKER' }, result: 'OUTPUT-MARKER' }),
      ...text('m1', 3, 'B\n\n```js\nconst x = 1;\n```'),
      ...text('m2', 0, 'C'),
    ]);
    expect(bubbles(root), 'fixture check: one bubble').toHaveLength(1);
    expect(bubbles(root)[0].querySelector('[data-group-trigger]'), 'fixture check: the thinking and the call sit in its action group').not.toBeNull();
    expect(names(bubbles(root)[0])).toEqual(OFFERS_RAW);
    expect(await copyOf(bubbles(root)[0])).toBe('A with **bold**\n\nB\n\n```js\nconst x = 1;\n```\n\nC');
  });

  it('a plan card with no assistant bubble before it is in no copy', async () => {
    const { m, root } = await show([
      { kind: 'user_echo', text: 'go', userIndex: 0 },
      { kind: 'plan_request', toolUseId: 'p1', plan: 'ORPHAN-PLAN', planPath: null },
      ...text('m1', 0, 'X'),
    ]);
    expect(m.items.map((i) => i.type), 'fixture check: the card comes before the only bubble').toEqual(['user', 'plan', 'assistant']);
    expect(await copyOf(bubbles(root)[0])).toBe('X');
  });

  it("blank text blocks add nothing to copy, a sub-agent's reconciled empty block included", async () => {
    const { m, root } = await show([...text('m1', 0, 'A'), ...text('m1', 1, ''), ...text('m1', 2, ' \n\t '), ...text('m1', 3, 'B')]);
    expect((m.items[0] as AssistantNode).children.filter((c) => c.type === 'text'), 'fixture check: the blank blocks are in the bubble').toHaveLength(4);
    expect(await copyOf(bubbles(root)[0])).toBe('A\n\nB');

    const agent = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S1' }, { type: 'text', text: '' }, { type: 'text', text: 'S2' }] } },
    ]);
    const card = groupsOf(agent.m.items[0] as AssistantNode)[0].children[0] as ToolNode;
    expect((card.sub!.items[0] as AssistantNode).children.filter((c) => c.type === 'text'), "fixture check: the sub-agent's empty block is in its bubble").toHaveLength(3);
    expect(await copyOf(subBubbles(agent.root)[0])).toBe('S1\n\nS2');
  });

  it('a bubble of only tool blocks gains its controls, and copies the plan, once a plan card closes it', async () => {
    const { m, root } = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'plan1', name: 'ExitPlanMode' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'plan1', name: 'ExitPlanMode', input: { plan: '# Only a plan' } },
    ]);
    expect(bubbles(root), 'fixture check: the call opened a bubble').toHaveLength(1);
    expect(names(bubbles(root)[0]), 'precondition: a bubble of only a tool call has no controls').toEqual([]);
    await live(m, [{ kind: 'plan_request', toolUseId: 'plan1', plan: '# Only a plan', planPath: null }]);
    expect(names(bubbles(root)[0])).toEqual(OFFERS_RAW);
    expect(await copyOf(bubbles(root)[0])).toBe('# Only a plan');
  });

  it('question cards and sub-agent output stay out of the copy; a sub-agent bubble has controls of its own that copy only its text', async () => {
    const { root } = await show([
      ...text('m1', 0, 'A'),
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S' }] } },
      ...text('m1', 2, 'B'),
      { kind: 'user_question', toolUseId: 'q1', questions: [{ question: 'QUESTION-MARKER?', header: 'h', options: [{ label: 'x', description: 'y' }, { label: 'z', description: 'w' }] }] },
    ]);
    expect(root.querySelectorAll('[data-item="question"]'), 'fixture check: the question card rendered').toHaveLength(1);
    const outer = bubbles(root)[0];
    fireEvent.click(outer.querySelector('[data-group-trigger]') as HTMLElement);
    await flush();
    const [sub] = subBubbles(root);
    expect(sub, "fixture check: the sub-agent's bubble is on screen").toBeTruthy();
    expect(await copyOf(outer)).toBe('A\n\nB');
    expect(names(sub)).toEqual(OFFERS_RAW);
    expect(await copyOf(sub)).toBe('S');
  });
});

describe('the raw view', () => {
  it("raw flips every text block of its own bubble together, one that streams in later included, and leaves another bubble's view alone", async () => {
    const { m, root } = await show([
      ...text('m0', 0, 'other **b0**'),
      { kind: 'user_echo', text: 'next', userIndex: 1 },
      ...text('m1', 0, 'one **b1**'),
      ...tool('m1', 1, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }),
      ...text('m1', 2, 'two **b2**'),
    ]);
    const [other, mine] = bubbles(root);
    expect(mine.textContent, 'precondition: rendered').not.toContain('**');
    await view(mine, 'raw');
    expect(names(mine)).toEqual(OFFERS_RENDERED);
    expect(mine.textContent).toContain('one **b1**');
    expect(mine.textContent).toContain('two **b2**');
    expect(names(other), 'the other bubble keeps its own view').toEqual(OFFERS_RAW);
    expect(other.textContent).toContain('other b0');
    expect(other.textContent).not.toContain('**');

    await live(m, text('m1', 3, 'three **b3**'));
    expect(mine.textContent, 'a block arriving later follows the raw view').toContain('three **b3**');

    await view(mine, 'rendered');
    expect(names(mine)).toEqual(OFFERS_RAW);
    expect(mine.textContent).not.toContain('**');
    expect(mine.textContent).toContain('three b3');
  });

  it('raw leaves the thinking block, the tool card and their action group exactly as they were', async () => {
    const { root } = await show([
      ...text('m1', 0, 'lead **x**'),
      ...thinking('m1', 1, 'pondering'),
      ...tool('m1', 2, 'tu1', 'Bash', { input: { command: 'ls -la' }, result: 'total 0' }),
      ...text('m1', 3, 'tail'),
    ]);
    const b = bubbles(root)[0];
    const trigger = b.querySelector('[data-group-trigger]') as HTMLElement;
    fireEvent.click(trigger);
    await flush();
    const group = trigger.parentElement as HTMLElement;
    expect(group.querySelector('[data-thinking="summary"]'), 'fixture check: the open group holds the thinking block').not.toBeNull();
    expect(group.querySelector('[data-tool-name="Bash"]'), 'fixture check: and the tool card').not.toBeNull();
    const before = group.outerHTML;
    await view(b, 'raw');
    expect(b.textContent, 'positive control: the text went raw').toContain('lead **x**');
    expect(group.outerHTML).toBe(before);
    await view(b, 'rendered');
    expect(group.outerHTML).toBe(before);
  });

  it('controls are live mid-stream: copy takes the text streamed so far, and a block still streaming when the bubble turns raw finalizes raw', async () => {
    const streaming: UiEvent[] = [
      ...text('m1', 0, 'lead **one**'),
      ...tool('m1', 1, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }),
      { kind: 'text_delta', msgId: 'm1', blockIdx: 2, text: 'par' },
      { kind: 'text_delta', msgId: 'm1', blockIdx: 2, text: 'tial **x**' },
    ];
    const raw = await show(streaming);
    const b = bubbles(raw.root)[0];
    expect(names(b), 'the controls are there before the block ends').toEqual(OFFERS_RAW);
    expect(await copyOf(b)).toBe('lead **one**\n\npartial **x**');
    await live(raw.m, [{ kind: 'text_delta', msgId: 'm1', blockIdx: 2, text: ' more' }]);
    expect(await copyOf(b), 'a later copy takes what streamed since').toBe('lead **one**\n\npartial **x** more');
    await view(b, 'raw');
    await live(raw.m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 2 }]);
    expect(b.textContent).toContain('partial **x** more');

    const rendered = await show(streaming);
    await live(rendered.m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 2 }]);
    expect(bubbles(rendered.root)[0].textContent, 'control: in a rendered bubble the same block finalizes rendered').not.toContain('partial **x**');
  });

  it('read-aloud stays through switching the bubble to raw and back', async () => {
    const { root } = await show(text('m1', 0, 'speak **me**'));
    const b = bubbles(root)[0];
    expect(speakLabels(b), 'precondition: no read-aloud without a voice').toEqual([]);
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    await flush();
    expect(speakLabels(b)).toEqual(['Read aloud']);
    await view(b, 'raw');
    expect(b.textContent, 'fixture check: the bubble shows its source').toContain('speak **me**');
    expect(speakLabels(b)).toEqual(['Read aloud']);
    await view(b, 'rendered');
    expect(b.textContent, 'fixture check: the bubble renders its markdown again').not.toContain('**');
    expect(speakLabels(b)).toEqual(['Read aloud']);
  });
});

describe('read-aloud', () => {
  it('a sub-agent bubble never offers read-aloud, even with a voice available', async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show([
      ...text('m1', 0, 'A'),
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S' }] } },
      ...text('m1', 2, 'B'),
    ]);
    const card = groupsOf(m.items[0] as AssistantNode)[0].children[0] as ToolNode;
    expect((card.sub!.items[0] as AssistantNode).children.filter((c): c is TextNode => c.type === 'text').map((c) => c.finalized), "fixture check: the sub-agent's text block is finalized").toEqual([true]);
    const outer = bubbles(root)[0];
    fireEvent.click(outer.querySelector('[data-group-trigger]') as HTMLElement);
    await flush();
    const [sub] = subBubbles(root);
    expect(sub, "fixture check: the sub-agent's bubble is on screen").toBeTruthy();
    expect(speakLabels(outer).length, 'positive control: the outer bubble offers read-aloud').toBeGreaterThan(0);
    expect(speakLabels(sub), 'the sub-agent bubble never offers read-aloud').toEqual([]);
    expect(names(sub), 'it offers copy and raw').toEqual(OFFERS_RAW);
  });

  it('a still-streaming block offers no read-aloud; a finalized one does', async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show([{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'still **going**' }]);
    const b = bubbles(root)[0];
    expect(names(b), 'a still-streaming block offers copy and raw').toEqual(OFFERS_RAW);
    expect(speakLabels(b), 'but no read-aloud').toEqual([]);
    await live(m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 0 }]);
    expect(speakLabels(b), 'the finalized block offers read-aloud').toEqual(['Read aloud']);
  });

  it("every finished text block has a read-aloud of its own, placed with that block, that reads that block's text; a block still streaming has none until it finishes", async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show([...threeBlocks(), { kind: 'text_delta', msgId: 'm1', blockIdx: 5, text: 'DELTA still streaming' }]);
    const blocks = textBlocks(m);
    expect(blocks.map((t) => [t.buffer, t.finalized]), 'fixture check: three finished blocks, then one still streaming').toEqual([
      ['ALPHA first **block**', true], ['BRAVO second block', true], ['CHARLIE third block', true], ['DELTA still streaming', false],
    ]);
    const b = bubbles(root)[0];
    expect(speakControls(b).length, 'positive control: the bubble offers read-aloud').toBeGreaterThan(0);
    expect(spoken(b), "each finished block's control reads that block, in stream order").toEqual(blocks.slice(0, 3).map((t) => [t.buffer, t.id]));
    expect(names(b), "the bubble's row of controls holds no read-aloud besides").toEqual(OFFERS_RAW);
    expect(blockSpeech(b), 'each control sits with the block it reads; the streaming block has none').toEqual(['ALPHA first **block**', 'BRAVO second block', 'CHARLIE third block', null]);
    expect(aroundControl(b), "each control comes right after its block's text, none of which follows it").toEqual([
      { before: 'ALPHA first block', after: '' }, { before: 'BRAVO second block', after: '' }, { before: 'CHARLIE third block', after: '' },
    ]);
    await live(m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 5 }]);
    expect(blockSpeech(b), 'the block that finished gains its own').toEqual(['ALPHA first **block**', 'BRAVO second block', 'CHARLIE third block', 'DELTA still streaming']);
  });

  it('the block being read, wherever it sits in the bubble, is the one whose control offers to stop', async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show(threeBlocks());
    const blocks = textBlocks(m);
    expect(blocks.map((t) => t.finalized), 'fixture check: three finished blocks').toEqual([true, true, true]);
    const b = bubbles(root)[0];
    act(() => { tts.speakStore.set({ activeNodeId: blocks[2].id }); });
    await flush();
    expect(speakLabels(b), 'positive control: a control in the bubble follows playback').toContain('Stop reading');
    for (const [i, t] of blocks.entries()) {
      act(() => { tts.speakStore.set({ activeNodeId: t.id }); });
      await flush();
      expect(speakLabels(b), `while block ${i + 1} is read`).toEqual(blocks.map((_, j) => (j === i ? 'Stop reading' : 'Read aloud')));
      expect(speakControls(b).map((x) => x.getAttribute('aria-pressed')), `block ${i + 1}'s control is the pressed one`).toEqual(blocks.map((_, j) => String(j === i)));
    }
    act(() => { tts.speakStore.set({ activeNodeId: null }); });
    await flush();
    expect(speakLabels(b), 'with nothing playing, every block offers read-aloud').toEqual(['Read aloud', 'Read aloud', 'Read aloud']);
  });

  it('auto-speak reads each block of a bubble as it finishes, and the block it is reading is the one whose control offers to stop', async () => {
    // Through the app's own conversation model, the voice feature's auto-speak and the real speech queue.
    const speech = fakeSpeech();
    try {
      act(() => { voiceStore.set({ ttsAvailable: true, ttsEnabled: true }); });
      startVoice();
      fireEvent.pointerDown(document);
      const { root } = renderModel(conversation);
      await flush();
      await live(conversation, threeBlocks());
      const blocks = textBlocks(conversation);
      expect(blocks.map((t) => t.finalized), 'fixture check: three finished blocks').toEqual([true, true, true]);
      const b = bubbles(root)[0];
      for (const [i, word] of ['ALPHA', 'BRAVO', 'CHARLIE'].entries()) {
        await until(`block ${i + 1} is sent to be spoken`, () => speech.bodies.length === i + 1);
        expect(speech.bodies[i], `positive control: auto-speak reads block ${i + 1}`).toContain(word);
        expect(speakLabels(b), `while auto-speak reads block ${i + 1}`).toEqual(blocks.map((_, j) => (j === i ? 'Stop reading' : 'Read aloud')));
        await until(`block ${i + 1} plays`, speech.isPlaying);
        act(() => { speech.end(); });
      }
      await until('the last block ends', () => tts.speakStore.get().activeNodeId === null);
      await flush();
      expect(speakLabels(b), 'with the bubble read, every block offers read-aloud').toEqual(['Read aloud', 'Read aloud', 'Read aloud']);
    } finally {
      act(() => { voiceStore.set({ ttsEnabled: false }); conversation.clear(); });
      tts.__resetTtsForTests();
      speech.restore();
    }
  });
});

describe('where the controls hold', () => {
  it('a retired segment and a running turn leave copy and raw enabled and working while the prompt loses rewind', async () => {
    const turn = userActionsForStatus('turn');
    const m = new ConversationModel({ segmentId: 'A' });
    m.setCurrentSegment('A');
    const { root } = await show([{ kind: 'user_echo', text: 'hi', userIndex: 0 }, ...text('m1', 0, 'reply **r**')], m, { ...noActions, canRewind: turn.rewind, canFork: turn.fork });
    const rewind = () => root.querySelector('[data-item="user"] button[aria-label="Rewind to before this message"]') as HTMLButtonElement | null;
    expect(rewind()?.disabled, 'precondition: the running turn disables rewind on the current segment').toBe(true);
    act(() => { m.setCurrentSegment('B'); });
    await flush();
    expect(rewind(), 'fixture check: the segment retired').toBeNull();
    const b = bubbles(root)[0];
    expect(controls(b).map((x) => [x.getAttribute('aria-label'), x.disabled])).toEqual([['Show raw text', false], ['Copy message', false]]);
    expect(await copyOf(b)).toBe('reply **r**');
    await view(b, 'raw');
    expect(b.textContent).toContain('reply **r**');
  });
});

describe('the copy outcome', () => {
  it('copy announces copied, then failed when the clipboard rejects, in its own bubble only; the announcement clears after the flash and the button keeps its name', async () => {
    vi.useFakeTimers();
    const { root } = await show([...text('m1', 0, 'first'), { kind: 'user_echo', text: 'next', userIndex: 1 }, ...text('m2', 0, 'second')]);
    const [a, b] = bubbles(root);
    const button = copyButton(a)!;
    const click = async () => { fireEvent.click(button); await flush(); await flush(); };

    await click();
    expect(copied, 'positive control: the copy reached the clipboard').toEqual(['first']);
    expect(announced(a), 'a copy that reached the clipboard is announced as copied').toMatch(/copied/i);
    expect(button.getAttribute('aria-label'), 'the button keeps its name').toBe('Copy message');
    expect(announced(b), "the other bubble's copy says nothing").toBe('');
    act(() => { vi.runOnlyPendingTimers(); });
    expect(announced(a), 'the announcement clears after the flash').toBe('');

    await click();
    expect(announced(a), 'fixture check: copied again').toMatch(/copied/i);
    rejectCopy = true;
    await click();
    expect(copied, 'fixture check: the rejected write was attempted').toEqual(['first', 'first', 'first']);
    expect(announced(a), 'a rejected write never reads as copied').not.toMatch(/copied/i);
    expect(announced(a)).toMatch(/fail/i);
    expect(button.getAttribute('aria-label')).toBe('Copy message');
    act(() => { vi.runOnlyPendingTimers(); });
    expect(announced(a)).toBe('');
    expect(copyButton(a)!.parentElement!.querySelectorAll('[aria-live]'), 'one live region per copy button, kept between flashes').toHaveLength(1);
  });
});

describe('replay and lazy pages', () => {
  it('a snapshot replay and a lazy page give the same controls, copy and raw view as the live stream', async () => {
    const events = (): UiEvent[] => [
      ...text('m1', 0, 'first **a**'),
      ...thinking('m1', 1, 'hmm'),
      ...tool('m1', 2, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }),
      ...text('m1', 3, 'second **b**'),
      { kind: 'plan_request', toolUseId: 'pl1', plan: 'the plan', planPath: null },
    ];
    const streamed = new ConversationModel();
    for (const ev of events()) streamed.apply(ev);
    const replayed = new ConversationModel();
    replayed.applyEvents(events());
    const paged = new ConversationModel().renderPage(events(), null, null);
    for (const [path, m] of [['live', streamed], ['replay', replayed], ['lazy page', paged]] as const) {
      const r = renderModel(m);
      await flush();
      const b = bubbles(r.root)[0];
      expect(names(b), `${path}: controls`).toEqual(OFFERS_RAW);
      expect(await copyOf(b), `${path}: copy`).toBe('first **a**\n\nsecond **b**\n\nthe plan');
      await view(b, 'raw');
      expect(b.textContent, `${path}: raw`).toContain('first **a**');
      expect(b.textContent, `${path}: raw`).toContain('second **b**');
      r.unmount();
    }
  });

  it('a bubble split across two lazy pages copies and toggles as one, its moved blocks following the raw view the lower half had', async () => {
    const { m, root } = await show([...text('mL', 0, 'C'), ...tool('mL', 1, 'tuL', 'Bash', { input: { command: 'pwd' }, result: 'out' }), ...text('mL', 2, 'D **d**')]);
    await view(bubbles(root)[0], 'raw');
    act(() => {
      m.prependPage(m.renderPage([
        { kind: 'user_echo', text: 'prompt', userIndex: 0 },
        ...text('mU', 0, 'A **a**'),
        ...tool('mU', 1, 'tuU', 'Bash', { input: { command: 'ls' }, result: 'out' }),
        ...text('mU', 2, 'B'),
      ], null, null), m.leadingAssistantWrap);
    });
    await flush();
    expect(bubbles(root), 'one merged bubble').toHaveLength(1);
    const b = bubbles(root)[0];
    expect(names(b)).toEqual(OFFERS_RENDERED);
    expect(await copyOf(b)).toBe('A **a**\n\nB\n\nC\n\nD **d**');
    expect(b.textContent, "the upper half's block shows raw").toContain('A **a**');
    expect(b.textContent).toContain('D **d**');
    await view(b, 'rendered');
    expect(b.textContent).not.toContain('**');
  });

  it('a tool-only lower half gains controls when a page above merges text into it', async () => {
    const { m, root } = await show(tool('mL', 0, 'tuL', 'Bash', { input: { command: 'pwd' }, result: 'out' }));
    expect(names(bubbles(root)[0]), 'precondition: a tool-only bubble has no controls').toEqual([]);
    act(() => {
      m.prependPage(m.renderPage([
        { kind: 'user_echo', text: 'prompt', userIndex: 0 },
        ...text('mU', 0, 'A'),
        ...tool('mU', 1, 'tuU', 'Bash', { input: { command: 'ls' }, result: 'out' }),
        ...text('mU', 2, 'B'),
      ], null, null), m.leadingAssistantWrap);
    });
    await flush();
    expect(bubbles(root), 'one merged bubble').toHaveLength(1);
    expect(names(bubbles(root)[0])).toEqual(OFFERS_RAW);
    expect(await copyOf(bubbles(root)[0])).toBe('A\n\nB');
  });
});

describe('on the turn-end row', () => {
  const kinds = (m: ConversationModel) => m.items.map((i) => i.type);

  it("a turn-end row directly under a text bubble carries its raw toggle and copy, and the bubble keeps no row of its own", async () => {
    const { m, root } = await show([...text('m1', 0, 'one **a**'), ...text('m1', 1, 'two'), turnEnd()]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'turn_end']);
    const b = bubbles(root)[0];
    const row = turnEndBelow(b)!;
    expect(row, 'the row is the next sibling').not.toBeNull();
    expect(row.textContent, 'fixture check: the row still shows the turn end').toContain('Done');
    expect(placement(b)).toBe('turn-end');
    expect(names(b)).toEqual(OFFERS_RAW);
    noOwnRow(b, m.items[0] as AssistantNode);
    expect(await copyOf(b)).toBe(ConversationModel.assistantCopyText(m.items[0] as AssistantNode));
    expect(copied.at(-1)).toBe('one **a**\n\ntwo');
    await view(b, 'raw');
    expect(b.textContent, 'raw from the row flips the bubble').toContain('one **a**');
    expect(names(b), 'and the row offers the way back').toEqual(OFFERS_RENDERED);
    await view(b, 'rendered');
    expect(names(b)).toEqual(OFFERS_RAW);
  });

  it("mid-stream the bubble holds its controls, and the turn's end moves them onto the row with the view the reader set", async () => {
    const { m, root } = await show([{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'part **x**' }]);
    const b = bubbles(root)[0];
    expect(placement(b)).toBe('bubble');
    await view(b, 'raw');
    await live(m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 0 }, turnEnd()]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'turn_end']);
    expect(placement(b)).toBe('turn-end');
    expect(names(b), 'the view the reader set is kept').toEqual(OFFERS_RENDERED);
    expect(b.textContent).toContain('part **x**');
    expect(await copyOf(b)).toBe('part **x**');
  });

  it('read-aloud stays with each text block when the controls move; the turn-end row holds none', async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show([...text('m1', 0, 'ALPHA'), ...text('m1', 1, 'BRAVO'), turnEnd()]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'turn_end']);
    const b = bubbles(root)[0];
    expect(placement(b)).toBe('turn-end');
    expect(blockSpeech(b)).toEqual(['ALPHA', 'BRAVO']);
    expect(turnEndBelow(b)!.querySelector('button[aria-label="Read aloud"]')).toBeNull();
  });

  it('in a turn split by a question card and its answer, only the bubble directly above the row moves', async () => {
    const q = [{ question: 'Q?', header: 'h', options: [{ label: 'x', description: 'y' }, { label: 'z', description: 'w' }] }];
    const { m, root } = await show([
      ...text('m1', 0, 'A'),
      { kind: 'user_question', toolUseId: 'q1', questions: q },
      { kind: 'user_echo', text: 'x', userIndex: 0, questionAnswer: { toolUseId: 'q1', questions: q } },
      ...text('m2', 0, 'B'),
      turnEnd(),
    ]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'question', 'user', 'assistant', 'turn_end']);
    const [a, b] = bubbles(root);
    expect(placement(a)).toBe('bubble');
    expect(placement(b)).toBe('turn-end');
    expect(await copyOf(a)).toBe('A');
    expect(await copyOf(b)).toBe('B');
    await view(b, 'raw');
    expect(names(b)).toEqual(OFFERS_RENDERED);
    expect(names(a), 'A keeps its view').toEqual(OFFERS_RAW);
  });

  it('a turn whose last bubble is tool-only has a turn-end row with no controls, and the text bubble split off above keeps its own', async () => {
    const q = [{ question: 'Q?', header: 'h', options: [{ label: 'x', description: 'y' }, { label: 'z', description: 'w' }] }];
    const { m, root } = await show([
      ...text('m1', 0, 'A'),
      { kind: 'user_question', toolUseId: 'q1', questions: q },
      { kind: 'user_echo', text: 'x', userIndex: 0, questionAnswer: { toolUseId: 'q1', questions: q } },
      ...tool('m2', 0, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }),
      turnEnd(),
    ]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'question', 'user', 'assistant', 'turn_end']);
    const [a, b] = bubbles(root);
    expect(placement(a)).toBe('bubble');
    expect(placement(b)).toBe('none');
    expect(root.querySelector('[data-item="turn-end"] button[aria-label="Copy message"]')).toBeNull();
  });

  it('an interrupt note between the bubble and its turn end leaves the controls on the bubble', async () => {
    const { m, root } = await show([...text('m1', 0, 'A'), { kind: 'system', subtype: 'soft_interrupted', data: { text: 'user interrupt' } }, turnEnd({ subtype: 'error_during_execution' })]);
    expect(kinds(m), 'fixture check').toEqual(['assistant', 'system', 'turn_end']);
    expect(root.querySelector('[data-subtype="soft_interrupted"]'), 'fixture check: the note renders').not.toBeNull();
    const b = bubbles(root)[0];
    expect(placement(b)).toBe('bubble');
    expect(root.querySelector('[data-item="turn-end"] button[aria-label="Copy message"]')).toBeNull();
  });

  it('a repeated usage line the list drops sits behind a rendered one, so a bubble above them keeps its own row exactly as the DOM shows', async () => {
    const usage = (): UiEvent => ({ kind: 'system', subtype: 'rate_limit_event', data: { rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 } } });
    const { m, root } = await show([...text('m1', 0, 'A'), usage(), usage(), turnEnd()]);
    expect(kinds(m), 'fixture check: both usage lines are items').toEqual(['assistant', 'system', 'system', 'turn_end']);
    expect(root.querySelectorAll('[data-subtype="rate_limit_event"]'), 'fixture check: one of them is dropped at render').toHaveLength(1);
    const b = bubbles(root)[0];
    expect(b.nextElementSibling, 'the rendered usage line, not the turn end, follows the bubble').not.toBe(turnEndBelow(b));
    expect(placement(b)).toBe('bubble');
  });

  it('a turn the process exits before ending leaves the controls on the bubble', async () => {
    const { m, root } = await show([...text('m1', 0, 'A'), { kind: 'system', subtype: 'exit', data: { code: 1, signal: null } }]);
    expect(kinds(m), 'fixture check: no turn end').not.toContain('turn_end');
    const b = bubbles(root)[0];
    expect(placement(b)).toBe('bubble');
    expect(await copyOf(b)).toBe('A');
  });

  it('on a retired segment the row keeps copy and raw enabled and working', async () => {
    const m = new ConversationModel({ segmentId: 'A' });
    m.setCurrentSegment('A');
    const { root } = await show([{ kind: 'user_echo', text: 'hi', userIndex: 0 }, ...text('m1', 0, 'reply **r**'), turnEnd()], m);
    act(() => { m.setCurrentSegment('B'); });
    await flush();
    const b = bubbles(root)[0];
    expect(placement(b), 'fixture check').toBe('turn-end');
    expect(controls(b).map((x) => [x.getAttribute('aria-label'), x.disabled])).toEqual([['Show raw text', false], ['Copy message', false]]);
    expect(await copyOf(b)).toBe('reply **r**');
    await view(b, 'raw');
    expect(b.textContent).toContain('reply **r**');
  });

  it('a snapshot replay and a lazy page put the controls on the same turn-end row as the live stream', async () => {
    const events = (): UiEvent[] => [...text('m1', 0, 'first **a**'), ...tool('m1', 1, 'tu1', 'Bash', { input: { command: 'ls' }, result: 'out' }), ...text('m1', 2, 'second'), turnEnd()];
    const streamed = new ConversationModel();
    for (const ev of events()) streamed.apply(ev);
    const replayed = new ConversationModel();
    replayed.applyEvents(events());
    const paged = new ConversationModel().renderPage(events(), null, null);
    for (const [path, m] of [['live', streamed], ['replay', replayed], ['lazy page', paged]] as const) {
      const r = renderModel(m);
      await flush();
      const b = bubbles(r.root)[0];
      expect(placement(b), `${path}: placement`).toBe('turn-end');
      expect(await copyOf(b), `${path}: copy`).toBe('first **a**\n\nsecond');
      await view(b, 'raw');
      expect(b.textContent, `${path}: raw`).toContain('first **a**');
      r.unmount();
    }
  });

  it('a turn-end row at the head of the live tail carries the controls of the page bubble spliced right above it', async () => {
    const { m, root } = await show([turnEnd(), { kind: 'user_echo', text: 'next', userIndex: 1 }, ...text('mB', 0, 'A2')]);
    expect(m.leadingAssistantWrap, 'fixture check: the live tail has no leading wrap').toBeNull();
    act(() => { m.prependPage(m.renderPage([{ kind: 'user_echo', text: 'prompt', userIndex: 0 }, ...text('mA', 0, 'A')], null, null), m.leadingAssistantWrap); });
    await flush();
    expect(kinds(m), 'fixture check').toEqual(['user', 'assistant', 'turn_end', 'user', 'assistant']);
    const [a, a2] = bubbles(root);
    expect(placement(a)).toBe('turn-end');
    expect(await copyOf(a)).toBe('A');
    expect(placement(a2)).toBe('bubble');
  });

  it('a tool-only lower half under a turn-end row gains controls on that row when a page above merges text into it', async () => {
    const { m, root } = await show([...tool('mL', 0, 'tuL', 'Bash', { input: { command: 'pwd' }, result: 'out' }), turnEnd()]);
    expect(placement(bubbles(root)[0]), 'precondition').toBe('none');
    act(() => {
      m.prependPage(m.renderPage([{ kind: 'user_echo', text: 'prompt', userIndex: 0 }, ...text('mU', 0, 'A'), ...tool('mU', 1, 'tuU', 'Bash', { input: { command: 'ls' }, result: 'out' }), ...text('mU', 2, 'B')], null, null), m.leadingAssistantWrap);
    });
    await flush();
    expect(bubbles(root), 'one merged bubble').toHaveLength(1);
    expect(placement(bubbles(root)[0])).toBe('turn-end');
    expect(await copyOf(bubbles(root)[0])).toBe('A\n\nB');
  });

  it("a sub-agent bubble keeps its own controls inside an outer turn whose controls moved to the turn-end row", async () => {
    const { root } = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S' }] } },
      ...text('m1', 1, 'OUTER'),
      turnEnd(),
    ]);
    const outer = bubbles(root)[0];
    expect(placement(outer)).toBe('turn-end');
    fireEvent.click(outer.querySelector('[data-group-trigger]') as HTMLElement);
    await flush();
    const [sub] = subBubbles(root);
    expect(sub, 'fixture check: the sub bubble is on screen').toBeTruthy();
    expect(placement(sub)).toBe('bubble');
    expect(await copyOf(sub)).toBe('S');
    expect(names(sub)).toEqual(OFFERS_RAW);
  });
});
