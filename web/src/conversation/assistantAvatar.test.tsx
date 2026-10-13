// The DOM the phone transcript layout rests on: an assistant bubble's avatar is its first
// child and its body holds every block. Below the `md` breakpoint CSS stacks the two; no JS
// reads the width, so a width-crossing test would be vacuous. Geometry is
// web/e2e/transcript-layout.spec.ts (happy-dom computes no layout).
import { describe, expect, it } from 'vitest';
import { ConversationModel, type AssistantNode, type ToolNode } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { groupsOf, text, tool } from './testkit';
import type { UiEvent } from '@/state/types';

async function show(events: UiEvent[], m = new ConversationModel()) {
  m.applyEvents(events);
  const { root } = renderModel(m, noActions);
  await flush();
  return { m, root };
}
const bubbles = (root: HTMLElement) =>
  ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).filter((b) => !b.parentElement!.closest('[data-item="assistant"]'));
const subBubbles = (root: HTMLElement) =>
  ([...root.querySelectorAll('[data-item="assistant"]')] as HTMLElement[]).filter((b) => !!b.parentElement!.closest('[data-item="assistant"]'));

describe('assistant avatar', () => {
  it("a turn's assistant messages share one bubble whose first child is its one avatar, ahead of a body holding every block", async () => {
    const { root } = await show([
      { kind: 'user_echo', text: 'go', userIndex: 0 },
      ...text('m1', 0, 'A'), ...tool('m1', 1, 't1', 'Bash'), ...text('m2', 0, 'B'),
    ]);
    expect(bubbles(root)).toHaveLength(1);
    const b = bubbles(root)[0];
    expect(b.querySelectorAll('[data-assistant-avatar]')).toHaveLength(1);
    expect(b.firstElementChild!.hasAttribute('data-assistant-avatar')).toBe(true);
    const body = b.querySelector('[data-assistant-body]')!;
    expect(body.querySelectorAll('[data-text-block]')).toHaveLength(2);

    const next = await show([{ kind: 'user_echo', text: 'go', userIndex: 0 }, ...text('m1', 0, 'A'), { kind: 'user_echo', text: 'more', userIndex: 1 }, ...text('m3', 0, 'C')]);
    expect(bubbles(next.root)).toHaveLength(2);
    for (const nb of bubbles(next.root)) expect(nb.querySelectorAll('[data-assistant-avatar]')).toHaveLength(1);
  });

  it("a sub-agent's bubbles carry no avatar but keep their body", async () => {
    const { m, root } = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S1' }] } },
    ]);
    const card = groupsOf(m.items[0] as AssistantNode)[0].children[0] as ToolNode;
    expect(card.sub!.items, 'fixture check: the sub-agent has a bubble').toHaveLength(1);
    const subs = subBubbles(root);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.querySelectorAll('[data-assistant-avatar]')).toHaveLength(0);
      expect(s.querySelectorAll('[data-assistant-body]')).toHaveLength(1);
    }
    expect(bubbles(root)[0].querySelectorAll(':scope > [data-assistant-avatar]')).toHaveLength(1);
  });
});
