// The DOM the transcript layout rests on: an assistant bubble's only child is its body, which holds
// every block, and a root bubble is a group named for assistive tech. No JS reads the width; geometry
// is web/e2e/transcript-layout.shared.ts (happy-dom computes no layout).
import { describe, expect, it } from 'vitest';
import { act, within } from '@testing-library/react';
import { ConversationModel, type AssistantNode, type ToolNode } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { groupsOf, text, tool, turnEnd } from './testkit';
import type { UiEvent } from '@shared/uiEvent';

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

describe('assistant bubble layout', () => {
  // Pins: a root bubble has no avatar, its body is its only child and holds every block, and it is the one group named Code Conductor.
  it("a turn's assistant messages share one bubble whose only child is its body, named Code Conductor for assistive tech", async () => {
    const { root } = await show([
      { kind: 'user_echo', text: 'go', userIndex: 0 },
      ...text('m1', 0, 'A'), ...tool('m1', 1, 't1', 'Bash'), ...text('m2', 0, 'B'),
    ]);
    const check = (r: HTMLElement) => {
      for (const b of bubbles(r)) {
        expect(b.querySelectorAll('[data-assistant-avatar]')).toHaveLength(0);
        expect(b.querySelectorAll('[role="img"]')).toHaveLength(0);
        expect(b.children).toHaveLength(1);
        expect(b.firstElementChild!.matches('[data-assistant-body]')).toBe(true);
      }
      const named = within(r).getAllByRole('group', { name: 'Code Conductor' });
      expect(named).toHaveLength(bubbles(r).length);
      named.forEach((g, i) => expect(g === bubbles(r)[i]).toBe(true));
    };
    expect(bubbles(root)).toHaveLength(1);
    expect(bubbles(root)[0].querySelectorAll('[data-assistant-body] [data-text-block]')).toHaveLength(2);
    check(root);

    const next = await show([{ kind: 'user_echo', text: 'go', userIndex: 0 }, ...text('m1', 0, 'A'), { kind: 'user_echo', text: 'more', userIndex: 1 }, ...text('m3', 0, 'C')]);
    expect(bubbles(next.root)).toHaveLength(2);
    check(next.root);
  });

  // Pins: a sub-agent bubble keeps its body but is neither an avatar holder nor a named group.
  it("a sub-agent's bubbles carry no avatar and no group name but keep their body", async () => {
    const { m, root } = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      { kind: 'assistant_message', msgId: 'ms', blockIdx: 0, parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: 'S1' }] } },
    ]);
    const card = groupsOf(m.items[0] as AssistantNode)[0].children[0] as ToolNode;
    expect(card.sub!.items, 'fixture check: the sub-agent has a bubble').toHaveLength(1);
    const subs = subBubbles(root);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.querySelectorAll('[data-assistant-avatar]')).toHaveLength(0);
      expect(s.hasAttribute('role')).toBe(false);
      expect(s.hasAttribute('aria-label')).toBe(false);
      expect(s.children).toHaveLength(1);
      expect(s.firstElementChild!.matches('[data-assistant-body]')).toBe(true);
    }
  });

  // Pins: only a root bubble directly after another bubble (no user item or turn-end row between) is marked as a seam.
  it('a root bubble straight after another (an unprompted turn on replay) is marked as a seam; one after a user item or a turn-end row is not', async () => {
    const boundary: UiEvent = { kind: 'turn_boundary', toolUseId: null, status: null };
    const adjacent = await show([...text('m1', 0, 'A'), boundary, ...text('m2', 0, 'B')]);
    expect(adjacent.m.items.map((i) => i.type), 'fixture check').toEqual(['assistant', 'assistant']);
    const [a1, a2] = bubbles(adjacent.root);
    expect(a1.hasAttribute('data-after-assistant')).toBe(false);
    expect(a2.hasAttribute('data-after-assistant')).toBe(true);

    const prompted = await show([...text('m1', 0, 'A'), { kind: 'user_echo', text: 'more', userIndex: 0 }, ...text('m2', 0, 'B')]);
    expect(prompted.m.items.map((i) => i.type), 'fixture check').toEqual(['assistant', 'user', 'assistant']);
    for (const b of bubbles(prompted.root)) expect(b.hasAttribute('data-after-assistant')).toBe(false);

    const ended = await show([...text('m1', 0, 'A'), turnEnd(), boundary, ...text('m2', 0, 'B')]);
    expect(ended.m.items.map((i) => i.type), 'fixture check').toEqual(['assistant', 'turn_end', 'assistant']);
    for (const b of bubbles(ended.root)) expect(b.hasAttribute('data-after-assistant')).toBe(false);
  });

  // Pins: a seam is never marked inside a sub-agent's list, even where two sub bubbles are adjacent.
  it('a sub-agent bubble straight after another sub bubble is not marked as a seam', async () => {
    const sub = (msgId: string, t: string): UiEvent => ({ kind: 'assistant_message', msgId, blockIdx: 0, parentToolUseId: 'tuA', message: { content: [{ type: 'text', text: t }] } });
    const { m, root } = await show([
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
      { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
      sub('ms1', 'S1'),
      { kind: 'turn_boundary', toolUseId: null, status: null, parentToolUseId: 'tuA' },
      sub('ms2', 'S2'),
    ]);
    const card = groupsOf(m.items[0] as AssistantNode)[0].children[0] as ToolNode;
    expect(card.sub!.items.map((i) => i.type), 'fixture check: the sub-agent list is two bubbles').toEqual(['assistant', 'assistant']);
    expect(subBubbles(root), 'fixture check: both sub bubbles are on screen').toHaveLength(2);
    for (const b of subBubbles(root)) expect(b.hasAttribute('data-after-assistant')).toBe(false);
  });

  // Pins: a mounted bubble's seam marker follows a change in its previous item (a page prepended above it).
  it('a mounted root bubble gains the seam marker when a page puts an assistant bubble above it', async () => {
    const m = new ConversationModel();
    const { root } = await show(text('m2', 0, 'B'), m);
    const [mounted] = bubbles(root);
    expect(bubbles(root), 'fixture check: one bubble, unmarked').toHaveLength(1);
    expect(mounted.hasAttribute('data-after-assistant')).toBe(false);

    act(() => { m.prependPage(m.renderPage([...text('m1', 0, 'A'), { kind: 'turn_boundary', toolUseId: null, status: null }], null, null), m.leadingAssistantWrap); });
    await flush();
    expect(m.items.map((i) => i.type), 'fixture check: the page added a bubble above').toEqual(['assistant', 'assistant']);
    expect(bubbles(root)[1] === mounted, 'the mounted bubble element was reused, not remounted').toBe(true);
    expect(mounted.hasAttribute('data-after-assistant')).toBe(true);
  });
});
