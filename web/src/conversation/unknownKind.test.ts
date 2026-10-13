import { describe, expect, it } from 'vitest';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel, type AssistantNode, type RootItem, type TextNode, type ToolNode } from './model';
import { apply, assistants, feed, text, tool } from './testkit';

// A kind no UiEvent member declares, as a newer server could send it. The type
// refuses it, so it arrives through the cast a wire frame takes at runtime.
const fromNewerServer = (fields: Record<string, unknown> = {}) =>
  ({ kind: 'from_a_newer_server', payload: 1, ...fields }) as unknown as UiEvent;

const bufferOf = (w: AssistantNode) => w.children.filter((c): c is TextNode => c.type === 'text').map((c) => c.buffer);
// Each root item's type plus the text it carries.
const view = (items: RootItem[]) => items.map((i) =>
  i.type === 'assistant' ? ['assistant', ...bufferOf(i)] : i.type === 'user' ? ['user', i.rawText] : [i.type]);

describe('an event of a kind the client does not know', () => {
  it('an event of a kind the client does not know is ignored: no node, no throw, and the stream after it still renders', () => {
    // Invariant: a newer server's unknown kind leaves the transcript as it was, and later known events render normally.
    const m = new ConversationModel();
    const rev = m.rev;
    expect(() => apply(m, fromNewerServer())).not.toThrow();
    expect(m.items).toEqual([]);
    expect(m.rev).toBe(rev);
    feed(m, text('m1', 0, 'after'));
    expect(view(m.items)).toEqual([['assistant', 'after']]);
  });

  it('an unknown kind tagged with an Agent parent is ignored inside the sub-conversation', () => {
    // Invariant: routing a sub-agent child never reads a kind-specific field, so an unknown child is dropped in the sub-conversation like a top-level one.
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'agent1', 'Agent', { result: null }));
    const top = view(m.items);
    expect(() => apply(m, fromNewerServer({ parentToolUseId: 'agent1' }))).not.toThrow();
    expect(view(m.items)).toEqual(top);
    const agent = m.toolBlocks.get('agent1') as ToolNode;
    expect(agent.sub?.items ?? []).toEqual([]);
    expect(m.orphanChildEvents.size).toBe(0);
    feed(m, text('s1', 0, 'from the sub-agent').map((ev) => ({ ...ev, parentToolUseId: 'agent1' })));
    expect(assistants(agent.sub!).map(bufferOf)).toEqual([['from the sub-agent']]);
  });

  it('an unknown kind inside a lazily loaded page is skipped', () => {
    // Invariant: the REST paging path (renderPage) drops an unknown kind the same way the live path does.
    const echo: UiEvent = { kind: 'user_echo', text: 'older prompt', userIndex: 0 };
    const withUnknown = new ConversationModel().renderPage([echo, fromNewerServer({ _seq: 7 }), ...text('m1', 0, 'older reply')], null, null);
    const without = new ConversationModel().renderPage([echo, ...text('m1', 0, 'older reply')], null, null);
    expect(view(withUnknown.items)).toEqual([['user', 'older prompt'], ['assistant', 'older reply']]);
    expect(view(withUnknown.items)).toEqual(view(without.items));
  });

  it('UiEvent is a closed union with no index signature', () => {
    // Invariant (checked by `tsc -p web`, which Vitest does not run): the union refuses an undeclared kind and an undeclared field.
    // The typed sink keeps each directive aimed at the call's argument, not at an unused local.
    const accept = (ev: UiEvent) => ev;
    // @ts-expect-error — `kind` is a closed union: a kind no member declares is refused
    const unknownKind = accept({ kind: 'from_a_newer_server' });
    // @ts-expect-error — no index signature: a field no member declares is refused
    const unknownField = accept({ kind: 'history_gap', undeclared: true });
    expect(unknownKind).toEqual({ kind: 'from_a_newer_server' });
    expect(unknownField).toEqual({ kind: 'history_gap', undeclared: true });
  });
});
