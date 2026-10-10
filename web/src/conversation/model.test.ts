import { describe, expect, it } from 'vitest';
import { ConversationModel, type AssistantNode, type GroupNode, type ToolNode, type QuestionNode, type UserNode } from './model';

const text = (msgId: string, t: string, blockIdx = 0) => [
  { kind: 'text_delta', msgId, blockIdx, text: t },
  { kind: 'text_end', msgId, blockIdx },
];
const tool = (msgId: string, toolUseId: string, name: string, input: object, blockIdx = 0) => [
  { kind: 'tool_use_start', msgId, blockIdx, toolUseId, name },
  { kind: 'tool_use', msgId, blockIdx, toolUseId, name, input },
];

describe('ConversationModel', () => {
  it('ignores an event whose _seq it already applied (snapshot replay)', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'user_echo', text: 'hi', _seq: 1 });
    m.apply({ kind: 'user_echo', text: 'hi', _seq: 1 });
    expect(m.items.filter((i) => i.type === 'user')).toHaveLength(1);
  });

  it('streams a reply into one assistant envelope and settles it on text_end', () => {
    const m = new ConversationModel();
    m.applyEvents([
      { kind: 'text_delta', msgId: 'a', blockIdx: 0, text: 'Hel' },
      { kind: 'text_delta', msgId: 'a', blockIdx: 0, text: 'lo' },
    ]);
    const wrap = m.items[0] as AssistantNode;
    expect(wrap.type).toBe('assistant');
    expect(wrap.children[0]).toMatchObject({ type: 'text', buffer: 'Hello', finalized: false });
    m.apply({ kind: 'text_end', msgId: 'a', blockIdx: 0 });
    expect(wrap.children[0]).toMatchObject({ finalized: true });
  });

  it('folds a run of tools into one action group that closes when prose resumes', () => {
    const m = new ConversationModel();
    m.applyEvents([
      ...tool('m1', 't1', 'Read', { file_path: 'a.ts' }),
      { kind: 'tool_result', toolUseId: 't1', content: 'ok' },
      ...tool('m2', 't2', 'Bash', { command: 'ls' }),
      ...text('m3', 'Done.'),
    ]);
    expect(m.items).toHaveLength(1);
    const wrap = m.items[0] as AssistantNode;
    const group = wrap.children[0] as GroupNode;
    expect(group.type).toBe('group');
    expect(group.children.map((c) => (c as ToolNode).name)).toEqual(['Read', 'Bash']);
    expect(group.open).toBe(false);
    expect((group.children[0] as ToolNode).status).toBe('done');
    expect(wrap.children[1]).toMatchObject({ type: 'text', buffer: 'Done.' });
  });

  it('keeps a group the user opened open when the run ends', () => {
    const m = new ConversationModel();
    m.applyEvents(tool('m1', 't1', 'Read', {}));
    const group = (m.items[0] as AssistantNode).children[0] as GroupNode;
    m.setGroupOpen(group, true);
    m.applyEvents(text('m2', 'after'));
    expect(group.open).toBe(true);
  });

  it('starts a new assistant envelope after a user echo', () => {
    const m = new ConversationModel();
    m.applyEvents([...text('a', 'one'), { kind: 'user_echo', text: 'next', userIndex: 1 }, ...text('b', 'two')]);
    expect(m.items.map((i) => i.type)).toEqual(['assistant', 'user', 'assistant']);
    expect((m.items[1] as UserNode).userIndex).toBe(1);
  });

  it('routes sub-agent events into the Agent tool and parks those whose parent is not rendered', () => {
    const m = new ConversationModel();
    m.applyEvents(tool('m1', 'agent1', 'Agent', { description: 'x' }));
    m.apply({ kind: 'assistant_message', msgId: 's1', parentToolUseId: 'agent1', message: { content: [{ type: 'text', text: 'from the sub-agent' }] } });
    const agent = m.toolBlocks.get('agent1')!;
    expect(agent.sub?.items[0]).toMatchObject({ type: 'assistant' });
    m.apply({ kind: 'user_echo', text: 'child', parentToolUseId: 'unknown' });
    expect(m.items.some((i) => i.type === 'user')).toBe(false);
    expect(m.orphanChildEvents.get('unknown')).toHaveLength(1);
  });

  it('records the plan on the bubble it closes and opens a fresh bubble after it', () => {
    const m = new ConversationModel();
    m.applyEvents([...text('a', 'Here is my plan'), { kind: 'plan_request', toolUseId: 'p1', plan: '1. do it' }, ...text('b', 'later')]);
    expect(m.items.map((i) => i.type)).toEqual(['assistant', 'plan', 'assistant']);
    expect((m.items[0] as AssistantNode).planText).toBe('1. do it');
    expect(ConversationModel.assistantCopyText(m.items[0] as AssistantNode)).toBe('Here is my plan\n\n1. do it');
  });

  it('locks a question card when the server-stamped answer echo arrives', () => {
    const m = new ConversationModel();
    const questions = [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }];
    m.apply({ kind: 'user_question', toolUseId: 'q1', questions });
    const card = m.items[0] as QuestionNode;
    m.questionPick(card, 0, 'A');
    expect(ConversationModel.questionReady(card)).toBe(true);
    m.apply({ kind: 'user_echo', text: 'whatever', questionAnswer: { toolUseId: 'q1', questions } });
    expect(card.answered).toBe(true);
    expect(card.submitted).toBe(true);
  });

  it('re-opens a card whose answer never reached the CLI', () => {
    const m = new ConversationModel();
    m.apply({ kind: 'user_question', toolUseId: 'q1', questions: [{ question: 'Pick', options: [{ label: 'A' }] }] });
    const card = m.items[0] as QuestionNode;
    m.questionPick(card, 0, 'A');
    m.questionSubmitted(card);
    m.questionSendFailed('q1', 'not connected');
    expect(card).toMatchObject({ submitted: false, failedReason: 'not connected' });
  });

  it('turns a compacting status into one compaction bubble completed by its boundary', () => {
    const m = new ConversationModel();
    m.applyEvents([
      { kind: 'system', subtype: 'status', data: { status: 'compacting' } },
      { kind: 'system', subtype: 'init', data: { model: 'x' } },
      { kind: 'compaction', trigger: 'auto', preTokens: 1000, postTokens: 100 },
      { kind: 'user_echo', text: 'summary', compactSummary: true },
    ]);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ type: 'compaction', state: 'done', preTokens: 1000, summary: 'summary' });
  });

  it('merges a page that ends mid-turn into the live leading envelope, joining the split action group', () => {
    const live = new ConversationModel();
    live.applyEvents([...tool('m2', 't2', 'Bash', { command: 'ls' }), ...text('m3', 'done')]);
    const leading = live.leadingAssistantWrap;
    const page = live.renderPage([...text('m0', 'earlier'), ...tool('m1', 't1', 'Read', {})], null, null);
    const top = live.prependPage(page, leading);
    expect(live.items).toHaveLength(1);
    const wrap = live.items[0] as AssistantNode;
    expect(wrap).toBe(leading);
    expect(wrap.children.map((c) => c.type)).toEqual(['text', 'group', 'text']);
    expect((wrap.children[1] as GroupNode).children.map((c) => (c as ToolNode).name)).toEqual(['Read', 'Bash']);
    expect(top).toBe(leading);
  });

  it('shows one divider for an evicted-content seam marked from both sides', () => {
    const live = new ConversationModel();
    live.apply({ kind: 'history_gap' });
    live.applyEvents(text('m1', 'x'));
    const page = live.renderPage([{ kind: 'user_echo', text: 'old' }, { kind: 'history_gap' }], null, null);
    live.prependPage(page, live.leadingAssistantWrap);
    expect(live.items.filter((i) => i.type === 'divider')).toHaveLength(1);
  });
});
