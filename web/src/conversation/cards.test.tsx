import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';

const sent: { t: string; payload: any; opts: any }[] = [];
let ackBehavior: (t: string) => Promise<unknown> = () => Promise.resolve({ ok: true });
vi.mock('@shared/ws', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => {
    sent.push({ t, payload, opts });
    return opts.ack ? ackBehavior(t) : undefined;
  },
}));

import { formatUserQuestionAnswers, type UserQuestionAnswer } from '@shared/userQuestionAnswers';
import { buildApprovePrompt, buildRejectPrompt } from '@shared/planApproval';
import { appStore } from '@/state/app';
import { ConversationModel, type QuestionNode } from './model';
import { flush, noActions, renderModel } from './renderModel';
import {
  CARD, CARD_RESULT, FRUIT, SIZE, TOPPINGS, TURN_END, banana, expectLocked, expectOpen, input, opt, sendBtn, show, stamped, statusOf,
} from './questionTestkit';

beforeEach(() => {
  sent.length = 0;
  ackBehavior = () => Promise.resolve({ ok: true });
  appStore.set({ activeId: 'inst-1' });
});

describe('question card', () => {
  it('renders options, a custom field and a disabled Send until answered', async () => {
    const { card } = await show([CARD()]);
    expect(card().textContent).toContain('Pick a fruit');
    expect(opt(card(), 'Apple')).toBeTruthy();
    expect(sendBtn(card()).disabled).toBe(true);
    fireEvent.click(opt(card(), 'Apple'));
    await flush();
    expect(sendBtn(card()).disabled).toBe(false);
  });

  it('typed spaces are preserved; a whitespace-only answer does not enable Send; typed text overrides a pick', async () => {
    const { m, card } = await show([CARD()]);
    fireEvent.change(input(card()), { target: { value: '   ' } });
    await flush();
    expect(input(card()).value).toBe('   ');
    expect(sendBtn(card()).disabled).toBe(true);
    fireEvent.change(input(card()), { target: { value: 'a mango please' } });
    await flush();
    expect(input(card()).value).toBe('a mango please');
    expect((m.items[0] as QuestionNode).answers[0]).toEqual({ kind: 'custom', text: 'a mango please' });
  });

  it('a pick turns the field into a note; the draft survives pick → un-pick and reverts to a custom answer', async () => {
    const { m, card } = await show([CARD()]);
    expect(input(card()).placeholder).toMatch(/own answer/);
    fireEvent.change(input(card()), { target: { value: 'ripe' } });
    fireEvent.click(opt(card(), 'Banana'));
    await flush();
    expect(input(card()).placeholder).toMatch(/note/);
    expect((m.items[0] as QuestionNode).answers[0]).toEqual({ kind: 'option', label: 'Banana', note: 'ripe' });
    fireEvent.click(opt(card(), 'Banana'));
    await flush();
    expect(input(card()).value).toBe('ripe');
    expect((m.items[0] as QuestionNode).answers[0]).toEqual({ kind: 'custom', text: 'ripe' });
  });

  it('multi-select shares one note across the picks; un-picking all with a draft reverts to custom', async () => {
    const { m, card } = await show([CARD([TOPPINGS])]);
    fireEvent.click(opt(card(), 'Nuts'));
    fireEvent.click(opt(card(), 'Syrup'));
    fireEvent.change(input(card()), { target: { value: 'extra' } });
    await flush();
    expect((m.items[0] as QuestionNode).answers[0]).toEqual({ kind: 'multi', labels: ['Nuts', 'Syrup'], note: 'extra' });
    fireEvent.click(opt(card(), 'Nuts'));
    fireEvent.click(opt(card(), 'Syrup'));
    await flush();
    expect((m.items[0] as QuestionNode).answers[0]).toEqual({ kind: 'custom', text: 'extra' });
  });

  it('several questions: tabs, Send needs every answer, and one consolidated prompt goes out with an ack', async () => {
    const { card } = await show([CARD([FRUIT, SIZE])]);
    expect(statusOf(card())).toBe('0/2 answered');
    fireEvent.click(opt(card(), 'Apple'));
    await flush();
    expect(sendBtn(card()).disabled).toBe(true);
    fireEvent.click(card().querySelector('[data-tab="1"]')!);
    await flush();
    fireEvent.click(opt(card(), 'L'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    expect(sent).toEqual([{ t: 'prompt', payload: { id: 'inst-1', text: formatUserQuestionAnswers([FRUIT, SIZE], [{ kind: 'option', label: 'Apple' }, { kind: 'option', label: 'L' }]) }, opts: { ack: true } }]);
    expect(statusOf(card())).toBe('Sending…');
  });

  // Invariant: a string question's tab reads its header, else its question's first 24 characters.
  it('a string question keeps its tab label: header first, else the first 24 characters', async () => {
    const long = { question: 'Pick a size for the whole order', options: [{ label: 'S' }] };
    const { card } = await show([CARD([FRUIT, long])]);
    const group = within(card()).getByRole('group', { name: 'Questions' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['1Fruit', '2Pick a size for the whol']);
  });

  // Invariant: a non-string question is treated as missing: its tab is named `Q<n>`, the card answers, and the answer echo renders.
  it.each([['false', false], ['42', 42], ['an object', {}]])('a non-string question (%s) gets a named tab, answers, and its echo renders', async (_name, bad) => {
    const qs: any[] = [{ question: bad, options: [{ label: 'Yes' }, { label: 'No' }] }, SIZE];
    const answers: UserQuestionAnswer[] = [{ kind: 'option', label: 'Yes' }, { kind: 'option', label: 'L' }];
    const { m, card, root } = await show([CARD(qs)]);
    const group = within(card()).getByRole('group', { name: 'Questions' });
    expect(within(group).getByRole('button', { name: /Q1$/ }).getAttribute('data-tab')).toBe('0');
    expect(within(group).getByRole('button', { name: /Pick a size$/ }).getAttribute('data-tab')).toBe('1');
    fireEvent.click(opt(card(), 'Yes'));
    await flush();
    fireEvent.click(card().querySelector('[data-tab="1"]')!);
    await flush();
    fireEvent.click(opt(card(), 'L'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    expect(sent).toEqual([{ t: 'prompt', payload: { id: 'inst-1', text: formatUserQuestionAnswers(qs, answers) }, opts: { ack: true } }]);
    m.apply(stamped(qs, answers));
    await flush();
    expect(statusOf(card())).toBe('Answered');
    const bubble = root.querySelector('[data-item="user"][data-variant="answer"]') as HTMLElement;
    expect([...bubble.querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['Yes', 'L']);
  });

  // Invariant: a non-string header, option label or description is treated as missing: the tab falls back to the question, the option to `Option <n>`, and no object text reaches the card.
  it('non-string header, option label and description fall back without crashing', async () => {
    const qs = [{ header: {}, question: 'Pick a colour', options: [{ label: {}, description: {} }, { label: 'Red' }] }, SIZE];
    const { card } = await show([CARD(qs)]);
    const group = within(card()).getByRole('group', { name: 'Questions' });
    expect(within(group).getByRole('button', { name: /Pick a colour$/ }).getAttribute('data-tab')).toBe('0');
    expect([...card().querySelectorAll('[data-option]')].map((b) => b.textContent)).toEqual(['Option 1', 'Red']);
    expect(card().textContent).not.toContain('[object Object]');
  });

  // Invariant: answering a card whose question has a non-string header renders the answer bubble with the question text and no object text.
  it('a non-string header leaves the answer bubble rendering its question text', async () => {
    const qs: any[] = [{ header: {}, question: 'Pick a colour', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const answers: UserQuestionAnswer[] = [{ kind: 'option', label: 'Red' }];
    const { m, card, root } = await show([CARD(qs)]);
    fireEvent.click(opt(card(), 'Red'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    m.apply(stamped(qs, answers));
    await flush();
    const bubble = root.querySelector('[data-item="user"][data-variant="answer"]') as HTMLElement;
    expect(bubble.textContent).toContain('Pick a colour');
    expect(bubble.textContent).not.toContain('[object Object]');
  });

  // Invariant: the pick identity is the raw `opt.label`: two distinct object labels stay distinct, and the answer carries the picked one's own value.
  it('two object option labels stay distinct picks and the answer carries the raw label', async () => {
    const second = { id: 'b' };
    const qs: any[] = [{ question: 'Pick one', options: [{ label: { id: 'a' } }, { label: second }] }];
    const { card } = await show([CARD(qs)]);
    fireEvent.click(card().querySelectorAll('[data-option]')[1]);
    await flush();
    expect([...card().querySelectorAll('[data-option]')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    fireEvent.click(sendBtn(card()));
    await flush();
    const text = formatUserQuestionAnswers(qs, [{ kind: 'option', label: second as any }]);
    expect(text).toContain('{"id":"b"}');
    expect(sent).toEqual([{ t: 'prompt', payload: { id: 'inst-1', text }, opts: { ack: true } }]);
  });

  // Answers tab 0 with `first`, picks `L` on the SIZE tab, sends, and applies the server's stamp built from the raw questions.
  async function answerWithSize(qs: any[], answers: UserQuestionAnswer[], first: (card: HTMLElement) => void) {
    const { m, card, root } = await show([CARD(qs)]);
    first(card());
    await flush();
    fireEvent.click(card().querySelector('[data-tab="1"]')!);
    await flush();
    fireEvent.click(opt(card(), 'L'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    expect(sent).toEqual([{ t: 'prompt', payload: { id: 'inst-1', text: formatUserQuestionAnswers(qs, answers) }, opts: { ack: true } }]);
    m.apply(stamped(qs, answers));
    await flush();
    expect(statusOf(card())).toBe('Answered');
    return root.querySelector('[data-item="user"][data-variant="answer"]') as HTMLElement;
  }

  // Invariant: a non-array `options` is no options: the question keeps its named tab, offers only the free-text field, answers, and its echo renders.
  it.each([['an object', { a: 'Yes' }], ['a string', 'Yes/No'], ['a number', 3]])('a non-array options (%s) leaves a free-text question that answers, and its echo renders', async (_name, bad) => {
    const qs: any[] = [{ question: 'Any notes?', options: bad }, SIZE];
    const answers: UserQuestionAnswer[] = [{ kind: 'custom', text: 'none' }, { kind: 'option', label: 'L' }];
    const bubble = await answerWithSize(qs, answers, (card) => {
      const group = within(card).getByRole('group', { name: 'Questions' });
      expect(within(group).getByRole('button', { name: /Any notes\?$/ }).getAttribute('data-tab')).toBe('0');
      expect(within(group).getByRole('button', { name: /Pick a size$/ }).getAttribute('data-tab')).toBe('1');
      expect(card.querySelectorAll('[data-option]')).toHaveLength(0);
      fireEvent.change(input(card), { target: { value: 'none' } });
    });
    expect(bubble.querySelector('[data-custom]')!.textContent).toBe('none');
    expect([...bubble.querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['L']);
  });

  // Invariant: a non-object question entry keeps its position as an empty question: tab `Q<n>`, free-text answer, and the sent text equals the formatter's over the raw questions, so the server's stamp pairs it.
  it.each([['null', null], ['a string', 'oops']])('a non-object question entry (%s) keeps its tab, answers, and its echo renders', async (_name, bad) => {
    const qs: any[] = [bad, SIZE];
    const answers: UserQuestionAnswer[] = [{ kind: 'custom', text: 'skip it' }, { kind: 'option', label: 'L' }];
    const bubble = await answerWithSize(qs, answers, (card) => {
      const group = within(card).getByRole('group', { name: 'Questions' });
      expect(within(group).getByRole('button', { name: /Q1$/ }).getAttribute('data-tab')).toBe('0');
      expect(within(group).getByRole('button', { name: /Pick a size$/ }).getAttribute('data-tab')).toBe('1');
      fireEvent.change(input(card), { target: { value: 'skip it' } });
    });
    expect(bubble.querySelector('[data-custom]')!.textContent).toBe('skip it');
    expect([...bubble.querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['L']);
  });

  // Invariant: a non-object option entry is not offered; the valid options still pick, send, and round-trip into the echo's chips.
  it('non-object option entries are skipped; the valid options answer and the echo round-trips', async () => {
    const qs: any[] = [{ question: 'Proceed?', options: [null, { label: 'Yes' }, 'No'] }, SIZE];
    const answers: UserQuestionAnswer[] = [{ kind: 'option', label: 'Yes' }, { kind: 'option', label: 'L' }];
    const bubble = await answerWithSize(qs, answers, (card) => {
      expect([...card.querySelectorAll('[data-option]')].map((b) => b.textContent)).toEqual(['Yes']);
      fireEvent.click(opt(card, 'Yes'));
    });
    expect([...bubble.querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['Yes', 'L']);
  });

  // Invariant: a well-formed card's questions reach the node unchanged.
  it('a well-formed card keeps its questions unchanged', async () => {
    const { m, card } = await show([CARD([FRUIT, SIZE])]);
    expect((m.items[0] as QuestionNode).questions).toEqual([FRUIT, SIZE]);
    expect([...card().querySelectorAll('[data-option]')].map((b) => b.textContent)).toEqual(['Apple', 'Banana']);
  });

  it("an answer that never reaches the CLI re-opens the card with the reason; the picks survive", async () => {
    ackBehavior = () => Promise.reject(new Error('not connected'));
    const { card } = await show([CARD()]);
    fireEvent.click(opt(card(), 'Banana'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    await flush();
    expect(statusOf(card())).toBe("Couldn't send: not connected");
    expect(sendBtn(card()).disabled).toBe(false);
    expect(opt(card(), 'Banana').getAttribute('aria-pressed')).toBe('true');
  });

  describe('locking by the server-stamped answer echo', () => {
    it('live: a stamped echo locks a card this tab never submitted, with the pick and note', async () => {
      const { card } = await show([CARD(), CARD_RESULT, TURN_END, banana()]);
      expectLocked(card());
    });

    it('after a snapshot: an echo arriving later locks the replayed card', async () => {
      const { m, card } = await show([CARD(), CARD_RESULT, TURN_END]);
      expectOpen(card());
      m.apply(banana());
      await flush();
      expectLocked(card());
    });

    it('an unstamped answer-shaped echo, or an idle-callback echo, does not lock the card', async () => {
      const text = formatUserQuestionAnswers([FRUIT], [{ kind: 'option', label: 'Banana' }]);
      const { card, root } = await show([CARD(), CARD_RESULT, TURN_END, { kind: 'user_echo', text, userIndex: 5 }, { kind: 'user_echo', text: 'Worker finished its turn', userIndex: 6 }]);
      expectOpen(card());
      expect(root.querySelectorAll('[data-item="user"][data-variant="plain"]')).toHaveLength(2);
    });

    it('a stamped custom answer shows whole in the field with nothing picked', async () => {
      const { card } = await show([CARD(), CARD_RESULT, stamped([FRUIT], [{ kind: 'custom', text: 'Mango — please' }])]);
      expect(input(card()).value).toBe('Mango — please');
      expect(card().querySelectorAll('[data-option][aria-pressed="true"]')).toHaveLength(0);
      expect(input(card()).getAttribute('data-custom-input')).toBe('active');
    });

    it('a two-question locked card shows each pane\'s pick, note and text across tab clicks and stays locked', async () => {
      const qs = [FRUIT, SIZE];
      const { card } = await show([CARD(qs), CARD_RESULT, stamped(qs, [{ kind: 'option', label: 'Banana', note: 'ripe' }, { kind: 'custom', text: 'medium-ish' }])]);
      expectLocked(card(), { text: 'ripe' });
      fireEvent.click(card().querySelector('[data-tab="1"]')!);
      await flush();
      expect(card().querySelectorAll('[data-option][aria-pressed="true"]')).toHaveLength(0);
      expect(input(card()).value).toBe('medium-ish');
      expect(statusOf(card())).toBe('Answered');
      fireEvent.click(card().querySelector('[data-tab="0"]')!);
      await flush();
      expectLocked(card(), { text: 'ripe' });
    });

    it('a card this tab submitted reads answered once its echo arrives', async () => {
      const { m, card } = await show([CARD()]);
      fireEvent.click(opt(card(), 'Banana'));
      fireEvent.change(input(card()), { target: { value: 'ripe ones only' } });
      await flush();
      fireEvent.click(sendBtn(card()));
      await flush();
      expect(statusOf(card())).toBe('Sending…');
      m.apply(banana());
      await flush();
      expectLocked(card());
    });

    it('a stamp locks only the card it names', async () => {
      const m = new ConversationModel();
      const { root } = await show([CARD([FRUIT], 'A'), CARD([FRUIT], 'B'), stamped([FRUIT], [{ kind: 'option', label: 'Apple' }], 'B'), stamped([FRUIT], [{ kind: 'option', label: 'Apple' }], 'missing')], m);
      const [a, b] = root.querySelectorAll<HTMLElement>('[data-item="question"]');
      expectOpen(a);
      expect(statusOf(b)).toBe('Answered');
    });

    it('reload: an answer on page N locks the card on older page N+1 through the shared map', () => {
      const live = new ConversationModel();
      const pageN = live.renderPage([banana()], null, null);
      live.prependPage(pageN, live.leadingAssistantWrap);
      const pageN1 = live.renderPage([CARD(), CARD_RESULT], null, null);
      live.prependPage(pageN1, live.leadingAssistantWrap);
      const card = live.items.find((i) => i.type === 'question') as QuestionNode;
      expect(card).toMatchObject({ answered: true, answers: [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }] });
    });

    it('a card spliced in from an older page locks when its stamped answer then arrives live', () => {
      const live = new ConversationModel();
      live.prependPage(live.renderPage([CARD(), CARD_RESULT], null, null), null);
      live.apply(banana());
      expect((live.items[0] as QuestionNode).answered).toBe(true);
    });

    it('an old-format answer renders raw in the answer bubble and locks the card with no pick; a non-string question does not throw', () => {
      const m = new ConversationModel();
      m.apply(CARD());
      m.apply({ kind: 'user_echo', text: 'Banana', userIndex: 2, questionAnswer: { toolUseId: 'tu_q', questions: [FRUIT] } });
      expect(m.items[0]).toMatchObject({ answered: true, answers: [{ kind: 'none' }] });
      const weird = new ConversationModel();
      weird.prependPage(weird.renderPage([{ kind: 'user_question', toolUseId: 'w', questions: [{ question: 42, options: [] }] }], null, null), null);
      expect(() => weird.apply({ kind: 'user_echo', text: 'x', questionAnswer: { toolUseId: 'w', questions: [{ question: 42 }] } })).not.toThrow();
    });
  });
});

describe('answer bubble', () => {
  it('a stamped echo is an answer bubble keeping its user index and rewind/fork', async () => {
    const calls: any[] = [];
    const ev = stamped([FRUIT], [{ kind: 'option', label: 'Apple' }]);
    const m = new ConversationModel();
    m.apply(ev);
    const r = renderModel(m, { ...noActions, onRewind: (i, t) => calls.push(['rewind', i, t]), onFork: (i, t) => calls.push(['fork', i, t]) });
    await flush();
    const bubble = r.root.querySelector('[data-item="user"]') as HTMLElement;
    expect(bubble.getAttribute('data-variant')).toBe('answer');
    expect(bubble.getAttribute('data-user-index')).toBe('4');
    fireEvent.click(within(bubble).getByRole('button', { name: /Rewind/ }));
    fireEvent.click(within(bubble).getByRole('button', { name: /Fork/ }));
    expect(calls).toEqual([['rewind', 4, ev.text], ['fork', 4, ev.text]]);
  });

  // Invariant: each answer kind renders its own row (chips, a skipped mark, a note, a custom text), only the noted row carries a note, and the head counts the questions only when there is more than one.
  it('renders each answer kind: chips, a custom text, a note, a skipped question; the head counts questions', async () => {
    const { root } = await show([stamped([TOPPINGS, SIZE, FRUIT], [
      { kind: 'multi', labels: ['Nuts', 'Syrup'] }, { kind: 'none' }, { kind: 'option', label: 'Banana', note: 'ripe ones only' },
    ])]);
    expect(root.querySelector('[data-answer-head]')!.textContent).toMatch(/3 questions/);
    const [multi, skipped, single] = root.querySelectorAll('[data-kind]');
    expect([...multi.querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['Nuts', 'Syrup']);
    expect(skipped.querySelector('[data-skipped]')).not.toBeNull();
    expect(single.querySelector('[data-note]')!.textContent).toContain('ripe ones only');
    expect(multi.querySelector('[data-note]')).toBeNull();
    const custom = await show([stamped([FRUIT], [{ kind: 'custom', text: 'Mango — please' }])]);
    expect(custom.root.querySelector('[data-custom]')!.textContent).toBe('Mango — please');
    expect(custom.root.querySelector('[data-answer-head]')!.textContent).toMatch(/Answered$/);
  });

  it('live and paged rendering of the same echo give the same answers', () => {
    const qs = [FRUIT, TOPPINGS];
    const ev = stamped(qs, [{ kind: 'option', label: 'Banana', note: 'ripe' }, { kind: 'multi', labels: ['Nuts', 'Cream'] }]);
    const live = new ConversationModel();
    live.apply(ev);
    const page = new ConversationModel().renderPage([ev], null, null);
    expect((page.items[0] as any).answer).toEqual((live.items[0] as any).answer);
  });
});

describe('plan card', () => {
  const PLAN = { kind: 'plan_request', toolUseId: 'p1', plan: '# Plan\n\n- step one', planPath: '/tmp/plan.md' };

  it('renders the plan, its path and a feedback box with Approve / Reject', async () => {
    const { root } = await show([PLAN]);
    const card = root.querySelector('[data-item="plan"]') as HTMLElement;
    expect(card.querySelector('.md h1')!.textContent).toBe('Plan');
    expect(card.textContent).toContain('Saved to /tmp/plan.md');
    expect(within(card).getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Reject/ })).toBeTruthy();
    expect(card.querySelector('[data-status]')!.textContent).toBe('Awaiting your decision');
  });

  it('an auto-approved plan renders display-only', async () => {
    const { root } = await show([{ ...PLAN, autoApproved: true }]);
    const card = root.querySelector('[data-item="plan"]') as HTMLElement;
    expect(within(card).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(card.querySelector('[data-status]')!.textContent).toBe('Auto-approved');
  });

  it('approve leaves plan mode first, then sends the approval with the feedback', async () => {
    const { root } = await show([PLAN]);
    const card = root.querySelector('[data-item="plan"]') as HTMLElement;
    fireEvent.change(card.querySelector('textarea')!, { target: { value: 'go small' } });
    fireEvent.click(within(card).getByRole('button', { name: /Approve/ }));
    await flush();
    await flush();
    expect(sent.map((s) => [s.t, s.payload])).toEqual([
      ['mode', { id: 'inst-1', mode: 'bypassPermissions' }],
      ['prompt', { id: 'inst-1', text: buildApprovePrompt('go small') }],
    ]);
    expect(card.querySelector('[data-status]')!.textContent).toBe('Approving…');
  });

  it('reject sends the refinement with its feedback and stays in plan mode', async () => {
    const { root } = await show([PLAN]);
    const card = root.querySelector('[data-item="plan"]') as HTMLElement;
    fireEvent.change(card.querySelector('textarea')!, { target: { value: 'smaller steps' } });
    fireEvent.click(within(card).getByRole('button', { name: /Reject/ }));
    await flush();
    expect(sent.map((s) => [s.t, s.payload])).toEqual([['prompt', { id: 'inst-1', text: buildRejectPrompt('smaller steps') }]]);
  });
});
