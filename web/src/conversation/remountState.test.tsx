// What the reader opened, closed or flipped to raw in the transcript, as a full-page
// view (Settings, review, …) leaves it: the view unmounts and mounts again on the same
// transcript, and every toggle comes back as the reader left it. A transcript replaced in
// place (a reconnect's snapshot, another session, a rewind) starts every toggle at its
// default again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import { buildForwardFrame } from '@shared/forwardFrame';
import { buildWakeStub } from '@shared/wakeCallback';
import { ConversationView } from './ConversationView';
import { flush } from './renderModel';
import { text, thinking, tool, toolResult, turnEnd } from './testkit';

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });

/** A tool result past the truncation, so its card offers the full output. */
const LONG = 'y'.repeat(5000);

/**
 * One transcript with every reader toggle: an action group holding an Agent card (sub-agent,
 * Arguments, a truncated Result), a Read card and a thinking block; a plain prompt; a forwarded
 * output (an instruction and a fold on one bubble); a wake fold; a task notification; a compaction summary.
 */
const TRANSCRIPT: UiEvent[] = [
  { kind: 'user_echo', text: 'read **this**', userIndex: 0 },
  { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'A', name: 'Agent' },
  { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'A', name: 'Agent', input: { description: 'search', prompt: 'go' } },
  { kind: 'text_delta', msgId: 'c1', blockIdx: 0, text: 'child one', parentToolUseId: 'A' },
  toolResult({ toolUseId: 'A', content: LONG }),
  ...tool('m1', 1, 'B', 'Read', { input: { file_path: '/b' }, result: 'b contents' }),
  ...thinking('m1', 2, 'deep thought'),
  ...text('m1', 3, 'reply'),
  turnEnd({ subtype: 'success' }),
  { kind: 'user_echo', text: buildForwardFrame({ messages: ['forwarded body'], instruction: 'please **review**' }), userIndex: 1 },
  { kind: 'user_echo', text: buildWakeStub({ targetSessionId: 'w1', payloadText: '{"sessionId":"w1"}\nwake **body**' }), userIndex: 2 },
  { kind: 'system', subtype: 'task_notification', data: { notified: true, status: 'completed', name: 'bg', summary: 'task summary' } },
  { kind: 'compaction', trigger: 'manual', preTokens: 1000, postTokens: 100, durationMs: null },
  { kind: 'user_echo', text: 'compaction **summary**', compactSummary: true },
];

// ── Driving the view ─────────────────────────────────────────────────────
const mount = () => {
  const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  return { ...r, el: r.container.querySelector('[data-conversation]') as HTMLElement };
};
async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const snapshot = (id: string, events: UiEvent[]) => frame('snapshot', { id, events });

async function click(el: Element) {
  fireEvent.click(el);
  await flush();
}
/** The reader clicks a native fold's summary; the fold's toggle event lands on a later task. */
async function clickSummary(details: Element) {
  fireEvent.click(details.querySelector(':scope > summary') as HTMLElement);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

// ── Finding the surfaces ─────────────────────────────────────────────────
const q = (root: Element, sel: string) => root.querySelector(sel) as HTMLElement | null;
const groupTrigger = (root: Element) => q(root, '[data-group-trigger]');
const cardTrigger = (root: Element, name: string) =>
  ([...root.querySelectorAll('[data-tool-trigger]')] as HTMLElement[]).find((t) => t.querySelector(`[data-tool-name="${name}"]`)) ?? null;
/** The card's root: its trigger's parent holds the card content and the sub-agent section. */
const cardRoot = (root: Element, name: string) => cardTrigger(root, name)?.parentElement ?? null;
const bubble = (root: Element, variant: string) => q(root, `[data-item="user"][data-variant="${variant}"]`) as HTMLElement;
const fold = (root: Element, kind: string) => q(root, `[data-fold="${kind}"]`) as HTMLElement;
/** A view toggle in `scope`: a fold body's own, or the bubble's below its fold. */
const viewToggle = (scope: Element, inFold: boolean) =>
  ([...scope.querySelectorAll('button[aria-label="Show raw text"], button[aria-label="Show rendered markdown"]')] as HTMLElement[])
    .find((b) => !!b.closest('[data-fold]') === inFold) as HTMLElement;
const stateOf = (el: Element | null) => el?.getAttribute('data-state') ?? null;
const openOf = (el: Element | null) => (el ? (el as HTMLDetailsElement).open : null);

type Tools = {
  group: string | null; agent: string | null; sub: string | null; args: boolean | null; result: boolean | null;
  full: boolean | null; read: string | null; thinking: string | null;
};
/** The action group and what it holds; null for what is not rendered. */
function tools(root: Element): Tools {
  const agent = cardRoot(root, 'Agent');
  return {
    group: stateOf(groupTrigger(root)),
    agent: stateOf(cardTrigger(root, 'Agent')),
    sub: stateOf(agent && q(agent, '[data-sub-trigger]')),
    args: openOf(agent && q(agent, '[data-tool-args]')),
    result: openOf(agent && q(agent, '[data-tool-result]')),
    full: agent && q(agent, '[data-tool-result] pre') ? q(agent, '[data-tool-result] pre')!.textContent === LONG : null,
    read: stateOf(cardTrigger(root, 'Read')),
    thinking: stateOf(q(root, '[data-thinking="summary"]')),
  };
}

type Folds = {
  prompt: boolean; instruction: boolean; forward: string | null; forwardRaw: boolean;
  wake: string | null; wakeRaw: boolean; task: boolean | null; compaction: string | null; compactionRaw: boolean;
};
/** The folds and raw views outside the action group. */
function folds(root: Element): Folds {
  const raw = (scope: Element | null, sel: string) => !!scope && !!scope.querySelector(sel);
  return {
    prompt: raw(bubble(root, 'plain'), '[data-user-text] [data-view="raw"]'),
    instruction: raw(bubble(root, 'forward'), '[data-user-text] [data-view="raw"]'),
    forward: stateOf(q(fold(root, 'forward'), '[data-fold-trigger]')),
    forwardRaw: raw(fold(root, 'forward'), '[data-view="raw"]'),
    wake: stateOf(q(fold(root, 'wake'), '[data-fold-trigger]')),
    wakeRaw: raw(fold(root, 'wake'), '[data-view="raw"]'),
    task: openOf(q(root, '[data-subtype="task_notification"]')),
    compaction: stateOf(q(fold(root, 'compaction'), '[data-fold-trigger]')),
    compactionRaw: raw(fold(root, 'compaction'), '[data-view="raw"]'),
  };
}

const TOOLS_START: Tools = { group: 'open', agent: 'closed', sub: 'open', args: null, result: null, full: null, read: 'closed', thinking: 'closed' };
const FOLDS_START: Folds = {
  prompt: false, instruction: false, forward: 'closed', forwardRaw: false,
  wake: 'closed', wakeRaw: false, task: false, compaction: 'closed', compactionRaw: false,
};
const FOLDS_SET: Folds = {
  prompt: true, instruction: true, forward: 'open', forwardRaw: true,
  wake: 'open', wakeRaw: true, task: true, compaction: 'open', compactionRaw: true,
};

/** Opens the group, then the Agent card: collapses its sub-agent section and Result, opens Arguments and the full output; opens the thinking block. */
async function setTools(root: Element) {
  await click(groupTrigger(root)!);
  await click(cardTrigger(root, 'Agent')!);
  const agent = cardRoot(root, 'Agent')!;
  await click(q(agent, '[data-sub-trigger]')!);
  await clickSummary(q(agent, '[data-tool-args]')!);
  await click(within(agent).getByRole('button', { name: 'Show full output' }));
  await clickSummary(q(agent, '[data-tool-result]')!);
  await click(q(root, '[data-thinking="summary"]')!);
}
const TOOLS_SET: Tools = { group: 'open', agent: 'open', sub: 'closed', args: true, result: false, full: true, read: 'closed', thinking: 'open' };

/** Flips every fold and raw view away from where it starts. */
async function setFolds(root: Element) {
  await click(viewToggle(bubble(root, 'plain'), false));
  await click(viewToggle(bubble(root, 'forward'), false));
  await click(q(fold(root, 'forward'), '[data-fold-trigger]')!);
  await click(viewToggle(fold(root, 'forward'), true));
  await click(q(fold(root, 'wake'), '[data-fold-trigger]')!);
  await click(viewToggle(fold(root, 'wake'), true));
  await clickSummary(q(root, '[data-subtype="task_notification"]')!);
  await click(q(fold(root, 'compaction'), '[data-fold-trigger]')!);
  await click(viewToggle(fold(root, 'compaction'), true));
}

/** Every toggle at its default, read after the reader opens the group (it starts closed once its turn ended). */
async function expectDefaults(root: Element, what: string) {
  expect(stateOf(groupTrigger(root)), `${what}: the action group`).toBe('closed');
  expect(folds(root), `${what}: the folds and raw views`).toEqual(FOLDS_START);
  await click(groupTrigger(root)!);
  expect(tools(root), `${what}: what the group holds`).toEqual(TOOLS_START);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [], hasMore: false, segment: null, nextBefore: null }),
  })));
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

describe('a full-page view round trip', () => {
  it('keeps the tool cards and thinking blocks the reader set: the card, its sub-agent section, Arguments, Result and full output, and the thinking', async () => {
    const first = mount();
    await snapshot('i1', TRANSCRIPT);
    await setTools(first.el);
    expect(tools(first.el), 'fixture check: every surface moved away from where it starts').toEqual(TOOLS_SET);
    first.unmount();
    const back = mount();
    expect(stateOf(groupTrigger(back.el)), 'the action group, kept on its node').toBe('open');
    expect(tools(back.el)).toEqual(TOOLS_SET);
  });

  it('keeps the folds and raw views the reader set: a prompt, a forwarded output and its instruction, a wake, a task notification, a compaction summary', async () => {
    const first = mount();
    await snapshot('i1', TRANSCRIPT);
    await click(groupTrigger(first.el)!);
    await setFolds(first.el);
    expect(folds(first.el), 'fixture check: every surface moved away from where it starts').toEqual(FOLDS_SET);
    first.unmount();
    const back = mount();
    expect(stateOf(groupTrigger(back.el)), 'the action group, kept on its node').toBe('open');
    expect(folds(back.el)).toEqual(FOLDS_SET);
  });
});

describe('the folds and raw views', () => {
  it('each toggle changes only its own surface', async () => {
    const { el } = mount();
    await snapshot('i1', TRANSCRIPT);
    let want: Folds = { ...FOLDS_START };
    expect(folds(el), 'where they start').toEqual(want);
    const step = async (what: string, toggle: () => Promise<void>, change: Partial<Folds>) => {
      await toggle();
      want = { ...want, ...change };
      expect(folds(el), what).toEqual(want);
    };
    // The forwarded output's three toggles share one bubble: each is flipped while the
    // other two differ from its new value, so a toggle that also wrote a sibling shows.
    await step('the instruction raw', () => click(viewToggle(bubble(el, 'forward'), false)), { instruction: true });
    await step('the forward fold open', () => click(q(fold(el, 'forward'), '[data-fold-trigger]')!), { forward: 'open' });
    await step('the forward fold raw', () => click(viewToggle(fold(el, 'forward'), true)), { forwardRaw: true });
    await step('the forward fold rendered again', () => click(viewToggle(fold(el, 'forward'), true)), { forwardRaw: false });
    await step('the forward fold closed again', () => click(q(fold(el, 'forward'), '[data-fold-trigger]')!), { forward: 'closed' });
    await step('the prompt raw', () => click(viewToggle(bubble(el, 'plain'), false)), { prompt: true });
    await step('the wake fold open', () => click(q(fold(el, 'wake'), '[data-fold-trigger]')!), { wake: 'open' });
    await step('the wake fold raw', () => click(viewToggle(fold(el, 'wake'), true)), { wakeRaw: true });
    await step('the task notification open', () => clickSummary(q(el, '[data-subtype="task_notification"]')!), { task: true });
    await step('the compaction fold open', () => click(q(fold(el, 'compaction'), '[data-fold-trigger]')!), { compaction: 'open' });
    await step('the compaction fold raw', () => click(viewToggle(fold(el, 'compaction'), true)), { compactionRaw: true });
    await step('the compaction fold rendered again', () => click(viewToggle(fold(el, 'compaction'), true)), { compactionRaw: false });
  });
});

describe('a transcript replaced in place', () => {
  it("a reconnect's snapshot starts every toggle at its default", async () => {
    const { el } = mount();
    await snapshot('i1', TRANSCRIPT);
    await setTools(el);
    await setFolds(el);
    expect({ ...tools(el), ...folds(el) }, 'precondition: every toggle set').toEqual({ ...TOOLS_SET, ...FOLDS_SET });
    await snapshot('i1', TRANSCRIPT);
    await expectDefaults(el, 'after the snapshot');
  });

  it('another session selected starts every toggle at its default, and so does coming back', async () => {
    const { el } = mount();
    await snapshot('i1', TRANSCRIPT);
    await setTools(el);
    await setFolds(el);
    expect({ ...tools(el), ...folds(el) }, 'precondition: every toggle set').toEqual({ ...TOOLS_SET, ...FOLDS_SET });
    act(() => { selectInstance('i2'); });
    await snapshot('i2', TRANSCRIPT);
    await expectDefaults(el, 'the other session');
    act(() => { selectInstance('i1'); });
    await snapshot('i1', TRANSCRIPT);
    await expectDefaults(el, 'back on the first');
  });

  it('a rewind starts every toggle of the replayed transcript at its default', async () => {
    const { el } = mount();
    await snapshot('i1', TRANSCRIPT);
    await setTools(el);
    await setFolds(el);
    expect({ ...tools(el), ...folds(el) }, 'precondition: every toggle set').toEqual({ ...TOOLS_SET, ...FOLDS_SET });
    // The server wipes the ring and sends the empty reset, then the live
    // history_replayed; the client's re-subscribe gets the replay as a snapshot.
    await frame('reset_snapshot', { id: 'i1', events: [] });
    await frame('event', { id: 'i1', ev: { kind: 'system', subtype: 'history_replayed', data: { count: TRANSCRIPT.length } } });
    await snapshot('i1', TRANSCRIPT);
    await expectDefaults(el, 'after the rewind');
  });
});
