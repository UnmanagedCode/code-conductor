import { describe, expect, it } from 'vitest';
import { formatUserQuestionAnswers, normalizeQuestions, type UserQuestionAnswer } from '@shared/userQuestionAnswers';
import { ConversationModel, type AssistantNode, type GroupNode, type ToolNode, type QuestionNode, type UserNode } from './model';
import type { UiEvent } from '@shared/uiEvent';
import { toolResult } from './testkit';

const text = (msgId: string, t: string, blockIdx = 0): UiEvent[] => [
  { kind: 'text_delta', msgId, blockIdx, text: t },
  { kind: 'text_end', msgId, blockIdx },
];
const tool = (msgId: string, toolUseId: string, name: string, input: Record<string, unknown>, blockIdx = 0): UiEvent[] => [
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
      toolResult({ toolUseId: 't1', content: 'ok' }),
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
    m.apply({ kind: 'assistant_message', msgId: 's1', blockIdx: 0, parentToolUseId: 'agent1', message: { content: [{ type: 'text', text: 'from the sub-agent' }] } });
    const agent = m.toolBlocks.get('agent1')!;
    expect(agent.sub?.items[0]).toMatchObject({ type: 'assistant' });
    m.apply({ kind: 'user_echo', text: 'child', parentToolUseId: 'unknown' });
    expect(m.items.some((i) => i.type === 'user')).toBe(false);
    expect(m.orphanChildEvents.get('unknown')).toHaveLength(1);
  });

  it('records the plan on the bubble it closes and opens a fresh bubble after it', () => {
    const m = new ConversationModel();
    m.applyEvents([...text('a', 'Here is my plan'), { kind: 'plan_request', toolUseId: 'p1', plan: '1. do it', planPath: null }, ...text('b', 'later')]);
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
      { kind: 'compaction', trigger: 'auto', preTokens: 1000, postTokens: 100, durationMs: null },
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

describe('normalizeQuestions', () => {
  const FRUIT = { header: 'Fruit', question: 'Pick a fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana', description: 'yellow' }] };
  const TOPPINGS = { question: 'Pick toppings', multiSelect: true, options: [{ label: 'Nuts' }, { label: 'Syrup' }] };

  // Invariant: a well-formed input comes back deep-equal.
  it('returns a well-formed input unchanged', () => {
    expect(normalizeQuestions([FRUIT, TOPPINGS])).toEqual([FRUIT, TOPPINGS]);
  });

  // Invariant: a non-object question becomes an empty question in the same position, and a non-array questions value is no questions.
  it('replaces a non-object question with an empty one in its position', () => {
    expect(normalizeQuestions([null, FRUIT, 'oops', 7, ['x']])).toEqual([{}, FRUIT, {}, {}, {}]);
    expect(normalizeQuestions({ 0: FRUIT })).toEqual([]);
  });

  // Invariant: a non-array options is no options; a non-object option is dropped and the rest keep their order.
  it('treats a non-array options as none and drops non-object options', () => {
    expect(normalizeQuestions([{ question: 'a', options: { label: 'x' } }, { question: 'b', options: 'x' }, { question: 'c', options: null }, { question: 'd' }]))
      .toEqual([{ question: 'a', options: [] }, { question: 'b', options: [] }, { question: 'c', options: [] }, { question: 'd', options: [] }]);
    expect(normalizeQuestions([{ question: 'e', options: [null, { label: 'Yes' }, 'No', 3, ['z'], { label: 'Maybe' }] }]))
      .toEqual([{ question: 'e', options: [{ label: 'Yes' }, { label: 'Maybe' }] }]);
  });

  // Invariant: on a mixed malformed card the formatter's text over the normalised questions equals its text over the raw ones, for every answer kind.
  it('leaves the answer text of a mixed malformed card unchanged', () => {
    const raw: any[] = [null, { question: 'Notes?', options: { a: 1 } }, { question: 'Proceed?', options: [null, { label: 'Yes' }] }, 'oops', TOPPINGS];
    const answers: UserQuestionAnswer[] = [
      { kind: 'custom', text: 'skip' }, { kind: 'none' }, { kind: 'option', label: 'Yes', note: 'now' }, { kind: 'custom', text: 'x' }, { kind: 'multi', labels: ['Nuts', 'Syrup'] },
    ];
    expect(formatUserQuestionAnswers(normalizeQuestions(raw), answers)).toBe(formatUserQuestionAnswers(raw, answers));
    expect(formatUserQuestionAnswers(normalizeQuestions([null]), [{ kind: 'custom', text: 'y' }])).toBe(formatUserQuestionAnswers([null as any], [{ kind: 'custom', text: 'y' }]));
  });
});
