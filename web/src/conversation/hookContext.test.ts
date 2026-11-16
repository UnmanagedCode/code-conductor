// Hook context in the conversation model: where each `hook_context` event
// lands — under its prompt, in its tool card (a sub-agent's too), or as a
// loose root row that moves into its card once the card is rendered.
import { describe, expect, it } from 'vitest';
import { ConversationModel, type ToolNode } from './model';
import type { UiEvent, UiEventOf } from '@shared/uiEvent';
import { assistants, feed, groupsOf, shape, text, tool, toolResult, users } from './testkit';

const promptContext = (text: string): UiEventOf<'hook_context'> =>
  ({ kind: 'hook_context', hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text });
const toolContext = (toolUseId: string, text: string, hookEvent: 'PreToolUse' | 'PostToolUse' = 'PreToolUse'): UiEventOf<'hook_context'> =>
  ({ kind: 'hook_context', hookEvent, toolUseId, toolName: 'Bash', text });
const echo = (text: string): UiEvent => ({ kind: 'user_echo', text });

const contextTexts = (node: { hookContexts: { ev: UiEventOf<'hook_context'> }[] }) => node.hookContexts.map((c) => c.ev.text);
const looseTexts = (m: ConversationModel) =>
  m.items.filter((i) => i.type === 'hook_context').map((i) => (i as Extract<typeof i, { type: 'hook_context' }>).ev.text);

describe('hook context placement', () => {
  it('a UserPromptSubmit context lands in its prompt and adds no root item', () => {
    const m = new ConversationModel();
    feed(m, [echo('hello'), promptContext('RECALL')]);
    expect(shape(m)).toEqual(['user']);
    expect(contextTexts(users(m)[0])).toEqual(['RECALL']);
  });

  it('it goes to the latest prompt, after that prompt\'s answer has started', () => {
    const m = new ConversationModel();
    feed(m, [echo('one'), ...text('m1', 0, 'reply'), echo('two'), ...text('m2', 0, 'reply'), promptContext('RECALL')]);
    expect(contextTexts(users(m)[0])).toEqual([]);
    expect(contextTexts(users(m)[1])).toEqual(['RECALL']);
  });

  it('with no prompt rendered, it is one loose root row', () => {
    const m = new ConversationModel();
    feed(m, [promptContext('RECALL')]);
    expect(shape(m)).toEqual(['hook_context']);
    expect(looseTexts(m)).toEqual(['RECALL']);
  });

  it('a tool context lands in its card by toolUseId, in arrival order', () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'tu1', 'Bash', { result: null }),
      ...tool('m1', 1, 'tu2', 'Bash', { result: null }),
      toolContext('tu2', 'pre'),
      toolContext('tu2', 'post', 'PostToolUse'),
    ]);
    expect(contextTexts(m.toolBlocks.get('tu1')!)).toEqual([]);
    expect(contextTexts(m.toolBlocks.get('tu2')!)).toEqual(['pre', 'post']);
    expect(looseTexts(m)).toEqual([]);
  });

  // INVARIANT: a root context goes to the card its toolUseId names, not to the newest card.
  it('a context naming the earlier of two root cards lands in that card, not the later one', () => {
    const m = new ConversationModel();
    feed(m, [
      ...tool('m1', 0, 'tuEarly', 'Bash', { result: null }),
      ...tool('m1', 1, 'tuLate', 'Bash', { result: null }),
      toolContext('tuEarly', 'for the early card'),
    ]);
    expect(contextTexts(m.toolBlocks.get('tuEarly')!)).toEqual(['for the early card']);
    expect(contextTexts(m.toolBlocks.get('tuLate')!)).toEqual([]);
    expect(looseTexts(m)).toEqual([]);
  });

  it('a context for a sub-agent\'s card, arriving untagged at root, lands in that card', () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'tuAgent', 'Agent', { result: null, input: { description: 'x' } }));
    m.apply({
      kind: 'assistant_message', msgId: 'sm1', blockIdx: 0, parentToolUseId: 'tuAgent',
      message: { content: [{ type: 'tool_use', id: 'tuSub', name: 'Bash', input: {} }] },
    } as UiEvent);
    m.apply(toolContext('tuSub', 'SUB CONTEXT'));
    const sub = m.toolBlocks.get('tuAgent')!.sub!;
    expect(contextTexts(sub.toolBlocks.get('tuSub')!)).toEqual(['SUB CONTEXT']);
    expect(looseTexts(m)).toEqual([]);
  });

  it('a context arriving before its card is a loose row, then moves into the card — one copy', () => {
    const m = new ConversationModel();
    feed(m, [...text('m1', 0, 'before'), toolContext('tuLate', 'EARLY')]);
    expect(looseTexts(m)).toEqual(['EARLY']);
    feed(m, tool('m1', 1, 'tuLate', 'Bash', { result: null }));
    expect(looseTexts(m)).toEqual([]);
    expect(contextTexts(m.toolBlocks.get('tuLate')!)).toEqual(['EARLY']);
  });

  it('a loose context moves into the card a sub-agent renders later', () => {
    const m = new ConversationModel();
    feed(m, tool('m1', 0, 'tuAgent', 'Agent', { result: null, input: { description: 'x' } }));
    m.apply(toolContext('tuSub', 'EARLY SUB'));
    expect(looseTexts(m)).toEqual(['EARLY SUB']);
    m.apply({
      kind: 'assistant_message', msgId: 'sm1', blockIdx: 0, parentToolUseId: 'tuAgent',
      message: { content: [{ type: 'tool_use', id: 'tuSub', name: 'Bash', input: {} }] },
    } as UiEvent);
    expect(looseTexts(m)).toEqual([]);
    expect(contextTexts(m.toolBlocks.get('tuAgent')!.sub!.toolBlocks.get('tuSub')!)).toEqual(['EARLY SUB']);
  });

  it('prependPage re-homes a live loose context into the card the older page brings', () => {
    const m = new ConversationModel();
    feed(m, [toolContext('tuOld', 'SPLIT'), toolResult({ toolUseId: 'tuOld', content: 'ok' })]);
    expect(looseTexts(m)).toEqual(['SPLIT']);
    const page = m.renderPage([echo('go'), ...tool('m0', 0, 'tuOld', 'Bash', { result: null })], null, null);
    m.prependPage(page, m.leadingAssistantWrap);
    expect(looseTexts(m)).toEqual([]);
    expect(contextTexts(page.toolBlocks.get('tuOld')!)).toEqual(['SPLIT']);
  });

  it('a page\'s own loose context waits for the still older page holding its card', () => {
    const m = new ConversationModel();
    feed(m, text('m2', 0, 'live'));
    const newer = m.renderPage([toolContext('tuOlder', 'PAGE HEAD'), ...text('m1', 0, 'after')], null, null);
    m.prependPage(newer, m.leadingAssistantWrap);
    expect(looseTexts(m)).toEqual(['PAGE HEAD']);
    const older = m.renderPage([echo('go'), ...tool('m0', 0, 'tuOlder', 'Bash', { result: null })], null, null);
    m.prependPage(older, m.leadingAssistantWrap);
    expect(looseTexts(m)).toEqual([]);
    expect(contextTexts(older.toolBlocks.get('tuOlder')!)).toEqual(['PAGE HEAD']);
  });

  it('clear() forgets a loose context: a card rendered afterwards does not claim it', () => {
    const m = new ConversationModel();
    feed(m, [toolContext('tuX', 'GONE')]);
    m.clear();
    feed(m, tool('m1', 0, 'tuX', 'Bash', { result: null }));
    expect(contextTexts(m.toolBlocks.get('tuX')!)).toEqual([]);
    expect(looseTexts(m)).toEqual([]);
  });

  it('a context does not close the open action group', () => {
    const m = new ConversationModel();
    feed(m, [...tool('m1', 0, 'tu1', 'Bash', { result: null }), toolContext('tu1', 'mid-run'), promptContext('stray')]);
    const [group] = groupsOf(assistants(m)[0]);
    expect(group.open).toBe(true);
    feed(m, tool('m1', 1, 'tu2', 'Bash', { result: null }));
    expect(groupsOf(assistants(m)[0])).toHaveLength(1);
    expect(group.children.filter((c): c is ToolNode => c.type === 'tool').map((t) => t.toolUseId)).toEqual(['tu1', 'tu2']);
  });

  it('hook_started, hook_response and an out-of-scope system event render nothing', () => {
    const m = new ConversationModel();
    feed(m, [
      { kind: 'system', subtype: 'hook_started', data: {} },
      { kind: 'system', subtype: 'hook_response', data: {} },
      { kind: 'system', subtype: 'read_nudge', data: { text: 'retired' } },
    ]);
    expect(m.items).toEqual([]);
  });
});
