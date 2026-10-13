// An Agent card's four collapse surfaces (the card, its sub-agent section, its
// Arguments and its Result) each toggle alone and keep what the reader set:
// through later sub-agent events, and through closing and reopening the card,
// whose content is not rendered while it is closed. A toggle inside a sub-agent
// that arrived on an older page takes effect at once. A result's starting state
// rounds it off.
import { describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { ConversationModel } from './model';
import { flush, renderModel } from './renderModel';
import { assistants, tool } from './testkit';
import type { UiEvent } from '@/state/types';

type Surfaces = { card: string | null; sub: string | null; args: boolean | null; result: boolean | null };

/** An Agent call with its input, a sub-agent reply streaming, and its result. */
function agentCard(): ConversationModel {
  const m = new ConversationModel();
  for (const ev of [
    { kind: 'tool_use_start', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent' },
    { kind: 'tool_use', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent', input: { description: 'search', prompt: 'go' } },
    { kind: 'text_delta', msgId: 'c1', blockIdx: 0, text: 'child one', parentToolUseId: 'A' },
    { kind: 'tool_result', toolUseId: 'A', content: 'done' },
  ] as UiEvent[]) m.apply(ev);
  return m;
}

/** Everything the sub-agent has said so far, read off the model (a collapsed section renders none of it). */
const subText = (m: ConversationModel) =>
  assistants(m.toolBlocks.get('A')!.sub!).flatMap((w) => w.children).map((c) => (c.type === 'text' ? c.buffer : '')).join(' ');

const hook = (root: HTMLElement, name: string) => root.querySelector(`[${name}]`) as HTMLElement;

/** Each surface's state; null for one not rendered (its card is closed). */
function surfaces(root: HTMLElement): Surfaces {
  const args = root.querySelector('[data-tool-args]') as HTMLDetailsElement | null;
  const result = root.querySelector('[data-tool-result]') as HTMLDetailsElement | null;
  return {
    card: hook(root, 'data-tool-trigger').getAttribute('data-state'),
    sub: hook(root, 'data-sub-trigger').getAttribute('data-state'),
    args: args ? args.open : null,
    result: result ? result.open : null,
  };
}

/** The reader clicks a native fold's summary; the fold's toggle event lands on a later task. */
async function clickSummary(root: HTMLElement, name: string) {
  fireEvent.click(root.querySelector(`[${name}] > summary`) as HTMLElement);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function click(el: HTMLElement) {
  fireEvent.click(el);
  await flush();
}

describe("an Agent card's four collapse surfaces", () => {
  it('each toggles alone: changing one leaves the other three as they were', async () => {
    const { root } = renderModel(agentCard());
    await flush();
    expect(surfaces(root), 'where they start: the card closed, the sub-agent section open').toEqual({ card: 'closed', sub: 'open', args: null, result: null });
    await click(hook(root, 'data-tool-trigger'));
    expect(surfaces(root), 'opening the card shows Arguments closed and its Result open').toEqual({ card: 'open', sub: 'open', args: false, result: true });

    await click(hook(root, 'data-sub-trigger'));
    expect(surfaces(root), 'the sub-agent section closed').toEqual({ card: 'open', sub: 'closed', args: false, result: true });
    await click(hook(root, 'data-sub-trigger'));
    expect(surfaces(root), 'the sub-agent section open again').toEqual({ card: 'open', sub: 'open', args: false, result: true });
    await clickSummary(root, 'data-tool-args');
    expect(surfaces(root), 'Arguments opened').toEqual({ card: 'open', sub: 'open', args: true, result: true });
    await clickSummary(root, 'data-tool-args');
    expect(surfaces(root), 'Arguments closed again').toEqual({ card: 'open', sub: 'open', args: false, result: true });
    await clickSummary(root, 'data-tool-args');
    expect(surfaces(root), 'Arguments opened again').toEqual({ card: 'open', sub: 'open', args: true, result: true });
    await clickSummary(root, 'data-tool-result');
    expect(surfaces(root), 'the Result collapsed').toEqual({ card: 'open', sub: 'open', args: true, result: false });
  });

  it('each keeps what the reader set through later sub-agent events, and closing and reopening the card keeps the three inside it', async () => {
    const m = agentCard();
    const { root } = renderModel(m);
    await flush();
    await click(hook(root, 'data-tool-trigger'));
    await click(hook(root, 'data-sub-trigger'));
    await clickSummary(root, 'data-tool-args');
    await clickSummary(root, 'data-tool-result');
    const set: Surfaces = { card: 'open', sub: 'closed', args: true, result: false };
    expect(surfaces(root), 'fixture check: every surface moved away from where it starts').toEqual(set);

    m.apply({ kind: 'text_delta', msgId: 'c2', blockIdx: 0, text: 'child two', parentToolUseId: 'A' });
    await flush();
    expect(subText(m), 'fixture check: the later event landed in the sub-agent').toContain('child two');
    expect(surfaces(root), 'through a later sub-agent event').toEqual(set);

    await click(hook(root, 'data-tool-trigger'));
    m.apply({ kind: 'text_delta', msgId: 'c3', blockIdx: 0, text: 'child three', parentToolUseId: 'A' });
    await flush();
    expect(subText(m), 'fixture check: the event while closed landed').toContain('child three');
    expect(surfaces(root), 'the closed card hides Arguments and Result and leaves the sub-agent section alone').toEqual({ card: 'closed', sub: 'closed', args: null, result: null });

    await click(hook(root, 'data-tool-trigger'));
    expect(surfaces(root)).toEqual(set);
  });
});

describe('a sub-agent that arrived on an older page', () => {
  it('takes a toggle inside it at once: its action group, then a tool card in that group', async () => {
    const live = new ConversationModel();
    live.apply({ kind: 'user_echo', text: 'live prompt', userIndex: 5 });
    const page = live.renderPage([
      { kind: 'user_echo', text: 'run task', userIndex: 0, _seq: 0, parentToolUseId: null },
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', _seq: 1, parentToolUseId: null },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', input: {}, _seq: 2, parentToolUseId: null },
      { kind: 'tool_use_start', msgId: 'msub', blockIdx: 0, toolUseId: 'inner', name: 'Bash', _seq: 3, parentToolUseId: 'tu1' },
      { kind: 'tool_use', msgId: 'msub', blockIdx: 0, toolUseId: 'inner', name: 'Bash', input: { command: 'ls' }, _seq: 4, parentToolUseId: 'tu1' },
      { kind: 'tool_result', toolUseId: 'inner', content: 'out', isError: false, _seq: 5, parentToolUseId: 'tu1' },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false, _seq: 6, parentToolUseId: null },
    ], null, null);
    live.prependPage(page, null);
    const { root } = renderModel(live);
    await flush();
    const groups = () => [...root.querySelectorAll('[data-group-trigger]')] as HTMLElement[];
    const cards = () => [...root.querySelectorAll('[data-tool-trigger]')] as HTMLElement[];
    await click(groups()[0]);
    await click(cards()[0]);
    expect(groups().map((g) => g.getAttribute('data-state')), "precondition: the page's own group opened, showing the sub-agent's group, folded as history arrives").toEqual(['open', 'closed']);
    expect(cards()[0].getAttribute('data-state'), "precondition: the page's Agent card opened").toBe('open');

    await click(groups()[1]);
    expect(groups()[1].getAttribute('data-state'), "the sub-agent's group").toBe('open');
    const inner = cards()[1];
    expect(inner.querySelector('[data-tool-name="Bash"]'), 'fixture check: the call inside the sub-agent').not.toBeNull();
    await click(inner);
    expect(inner.getAttribute('data-state'), 'the tool card inside it').toBe('open');
  });
});

describe('a result', () => {
  it('starts open in its card whatever it holds; outside a card it starts open only when short or showing an image, and neither failed nor handed to the user', async () => {
    const at = (n: number) => 'x'.repeat(n);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const m = new ConversationModel();
    for (const ev of [
      ...tool('m1', 0, 'carded', 'Read', { result: at(600), isError: true }),
      { kind: 'tool_result', toolUseId: 'loose-599', content: at(599) },
      { kind: 'tool_result', toolUseId: 'loose-600', content: at(600) },
      { kind: 'tool_result', toolUseId: 'loose-failed', content: 'boom', isError: true },
      { kind: 'tool_result', toolUseId: 'loose-yielded', content: 'over to you', yielded: true },
      { kind: 'tool_result', toolUseId: 'loose-image', content: [image, { type: 'text', text: at(600) }] },
    ] as UiEvent[]) m.apply(ev);
    const { root } = renderModel(m);
    await flush();
    await click(hook(root, 'data-tool-trigger'));
    const results = [...root.querySelectorAll('[data-tool-result]')] as HTMLDetailsElement[];
    expect(results.map((d) => d.open)).toEqual([true, true, false, false, false, true]);
  });
});
