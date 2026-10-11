// The assistant bubble's controls: what copy hands the clipboard (each text block's
// source in stream order and the plan that closes the bubble; never thinking, tools,
// questions or sub-agent output), the raw view every text block of the bubble follows,
// read-aloud, and the same controls mid-stream, on a retired segment, in a replay, on a
// lazy page and across a page seam. A copy announces its outcome while the button keeps
// its name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { voiceStore } from '@/features/voice/store';
import type { UiEvent } from '@/state/types';
import { ConversationModel, userActionsForStatus, type AssistantNode, type TextNode, type ToolNode } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { groupsOf, text, thinking, tool } from './testkit';

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
  act(() => { voiceStore.set({ ttsAvailable: false }); });
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
/** The bubble's own copy button; null while the bubble has no controls. */
const copyButton = (b: HTMLElement) =>
  ([...b.querySelectorAll('button[aria-label="Copy message"]')] as HTMLButtonElement[]).find((x) => x.closest('[data-item="assistant"]') === b) ?? null;
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
      { kind: 'plan_request', toolUseId: 'p1', plan: 'ORPHAN-PLAN' },
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
    await live(m, [{ kind: 'plan_request', toolUseId: 'plan1', plan: '# Only a plan' }]);
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
    expect(names(b), 'precondition: no read-aloud without a voice').toEqual(OFFERS_RAW);
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    await flush();
    expect(names(b)).toEqual([...OFFERS_RAW, 'Read aloud']);
    await view(b, 'raw');
    expect(names(b)).toEqual([...OFFERS_RENDERED, 'Read aloud']);
    await view(b, 'rendered');
    expect(names(b)).toEqual([...OFFERS_RAW, 'Read aloud']);
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
    expect(names(outer), 'positive control: the outer bubble offers read-aloud').toEqual([...OFFERS_RAW, 'Read aloud']);
    expect(names(sub), 'the sub-agent bubble offers copy and raw, never read-aloud').toEqual(OFFERS_RAW);
  });

  it('a still-streaming block offers no read-aloud; a finalized one does', async () => {
    act(() => { voiceStore.set({ ttsAvailable: true }); });
    const { m, root } = await show([{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'still **going**' }]);
    const b = bubbles(root)[0];
    expect(names(b), 'a still-streaming block offers copy and raw but no read-aloud').toEqual(OFFERS_RAW);
    await live(m, [{ kind: 'text_end', msgId: 'm1', blockIdx: 0 }]);
    expect(names(b), 'the finalized block offers read-aloud').toEqual([...OFFERS_RAW, 'Read aloud']);
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
      { kind: 'plan_request', toolUseId: 'pl1', plan: 'the plan' },
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
