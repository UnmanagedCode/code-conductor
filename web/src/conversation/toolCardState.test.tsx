// A tool card's body and the state it keeps: a system_bash call shows its command
// and its description, Arguments the reader opened stay open through the card's own
// re-renders, an untouched shell card shows its command once its input parses, a
// per-call usage line explains itself and is no action, and an Agent card's subagent
// total stays through the card's re-renders.
import { describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { ConversationModel, type ToolNode } from './model';
import { flush, renderModel } from './renderModel';
import { CALL_USAGE_TITLE } from './format';
import { assistants, feed, groupsOf, groupText, tool, toolResult } from './testkit';
import type { UiEvent } from '@shared/uiEvent';

const q = (root: Element, sel: string) => root.querySelector(sel) as HTMLElement | null;
/** The card's root: its trigger's parent holds the card content and the sub-agent section. */
const cardOf = (root: Element) => (q(root, '[data-tool-trigger]') as HTMLElement).parentElement as HTMLElement;
const copyCommand = (root: Element) => root.querySelector('button[aria-label="Copy command"]');

async function openCard(root: Element) {
  fireEvent.click(q(root, '[data-tool-trigger]') as HTMLElement);
  await flush();
}
async function apply(m: ConversationModel, evs: UiEvent[]) {
  act(() => { feed(m, evs); });
  await flush();
}

describe('tool card bodies', () => {
  it('a system_bash call shows its command in the body and its description in the summary, never a JSON dump', async () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'sb1', 'mcp__code-conductor__system_bash', { input: { system: 'refbox', command: 'git --version', description: 'Check the git version' }, result: null }));
    const { root } = renderModel(m);
    await flush();
    const trigger = q(root, '[data-tool-trigger]') as HTMLElement;
    expect(trigger.textContent).toContain('Check the git version');
    expect(trigger.textContent).not.toContain('git --version');
    await openCard(root);
    const card = cardOf(root);
    expect(copyCommand(card), 'the command box').not.toBeNull();
    expect(card.querySelector('pre')?.textContent).toBe('git --version');
    expect(card.querySelector('[data-tool-args]')).toBeNull();
  });

  it("Arguments the reader opened stay open, on the same element, through the card's own re-renders: its input completing, its final input and its result", async () => {
    const m = new ConversationModel();
    feed(m, [
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'f1', name: 'SomeFutureTool' },
      { kind: 'tool_use_input_delta', msgId: 'm1', blockIdx: 0, toolUseId: 'f1', partialJson: '{"foo":' },
    ]);
    const { root } = renderModel(m);
    await flush();
    await openCard(root);
    const args = q(root, '[data-tool-args]') as HTMLDetailsElement;
    expect(args.open, 'precondition: Arguments start closed').toBe(false);
    fireEvent.click(args.querySelector(':scope > summary') as HTMLElement);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(args.open, 'precondition: the reader opened them').toBe(true);

    const passes: [string, UiEvent[]][] = [
      ['input completing', [{ kind: 'tool_use_input_delta', msgId: 'm1', blockIdx: 0, toolUseId: 'f1', partialJson: '"bar"}' }]],
      ['final input', [{ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'f1', name: 'SomeFutureTool', input: { foo: 'bar' } }]],
      ['result', [toolResult({ toolUseId: 'f1', content: 'ok', isError: false })]],
    ];
    for (const [name, evs] of passes) {
      await apply(m, evs);
      expect(q(root, '[data-tool-args]'), `${name}: the same element`).toBe(args);
      expect(args.open, `${name}: still open`).toBe(true);
      expect(args.querySelector('pre')?.textContent, `${name}: the payload`).toContain('"foo"');
    }
    expect(q(root, '[data-tool-trigger] [title="done"]'), 'fixture check: the result re-rendered the card').not.toBeNull();
  });

  it('an untouched shell card keeps unparsed streaming input behind closed Arguments, then shows the command without a click once its input is final', async () => {
    const m = new ConversationModel();
    feed(m, [
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'b1', name: 'Bash' },
      { kind: 'tool_use_input_delta', msgId: 'm1', blockIdx: 0, toolUseId: 'b1', partialJson: '{"comm' },
    ]);
    const { root } = renderModel(m);
    await flush();
    await openCard(root);
    const card = cardOf(root);
    const args = card.querySelector('[data-tool-args]') as HTMLDetailsElement | null;
    expect(args, 'streaming: the partial input sits behind Arguments').not.toBeNull();
    expect(args!.open, 'streaming: closed').toBe(false);
    expect(copyCommand(card), 'streaming: no command box yet').toBeNull();

    await apply(m, [{ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'b1', name: 'Bash', input: { command: 'ls' } }]);
    expect(card.querySelector('[data-tool-args]')).toBeNull();
    expect(copyCommand(card)).not.toBeNull();
    expect(card.querySelector('pre')?.textContent).toBe('ls');
  });
});

describe('per-call usage and subagent totals', () => {
  it('a per-call usage line explains itself in its tooltip and is no action: no card, not tallied', async () => {
    const m = new ConversationModel();
    feed(m, [...tool('m1', 0, 'tu1', 'Read'), { kind: 'call_usage', msgId: 'm1', promptTokens: 40_000, growthTokens: 1_000, outputTokens: 200, thinkingTokens: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null }]);
    const { root } = renderModel(m);
    await flush();
    expect(q(root, '[data-group-trigger]')?.getAttribute('data-state'), 'fixture check: the run is open').toBe('open');
    const lines = root.querySelectorAll('[data-call-usage-line]');
    expect(lines).toHaveLength(1);
    const line = lines[0] as HTMLElement;
    expect(line.getAttribute('title')).toBe(CALL_USAGE_TITLE);
    expect(line.querySelector('button, [data-tool-trigger]')).toBeNull();
    expect(line.closest('[data-tool-trigger]')).toBeNull();
    expect(groupText(groupsOf(assistants(m)[0])[0])).toBe('1 action · Read');
  });

  it("an Agent card's subagent total stays through the card's re-renders: a later sub-agent event, closing and reopening it, and a remount", async () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'A', 'Agent', { result: null, input: { description: 'survey' } }),
      toolResult({ toolUseId: 'A', content: 'done', isError: false, agentTokens: 48_200, agentToolUses: 3 }),
    ]);
    const first = renderModel(m);
    await flush();
    const badge = () => q(first.root, '[data-agent-usage]');
    const at = badge()?.textContent;
    expect(at, 'precondition: the card shows the total').toBeTruthy();

    await apply(m, [{ kind: 'text_delta', msgId: 'late', blockIdx: 0, text: 'late sub-agent word', parentToolUseId: 'A' }]);
    expect(((m.toolBlocks.get('A') as ToolNode).sub?.items.length ?? 0), 'fixture check: the event reached the sub-agent').toBeGreaterThan(0);
    expect(badge()?.textContent, 'after a later sub-agent event').toBe(at);

    await openCard(first.root);
    await openCard(first.root);
    expect(q(first.root, '[data-tool-trigger]')?.getAttribute('data-state'), 'fixture check: closed again').toBe('closed');
    expect(badge()?.textContent, 'after closing and reopening').toBe(at);

    first.unmount();
    const again = renderModel(m);
    await flush();
    expect(q(again.root, '[data-agent-usage]')?.textContent, 'after a remount').toBe(at);
  });
});
