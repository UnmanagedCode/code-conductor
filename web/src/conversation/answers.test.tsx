import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireEvent, within } from '@testing-library/react';

const sent: { t: string; payload: any; opts: any }[] = [];
let ackBehavior: (t: string) => Promise<unknown> = () => Promise.resolve({ ok: true });
vi.mock('@/lib/core/ws.js', () => ({
  bus: new EventTarget(),
  connect: () => {},
  send: (t: string, payload: any, opts: any = {}) => {
    sent.push({ t, payload, opts });
    return opts.ack ? ackBehavior(t) : undefined;
  },
}));

import { formatUserQuestionAnswers, parseUserQuestionAnswers } from '../../../public/userQuestionAnswers.ts';
import { buildWakeStub } from '../../../public/wakeCallback.ts';
import { appStore } from '@/state/app';
import { ConversationModel, type UserNode } from './model';
import { createLazyHistory } from './lazyHistory';
import { flush, renderModel } from './renderModel';
import { serverMidTurnNote, serverModules } from './testkit';
import {
  CARD, CARD_RESULT, FRUIT, SIZE, TURN_END, banana, expectLocked, expectOpen, input, opt, sendBtn, show, stamped, statusOf,
} from './questionTestkit';

beforeEach(() => {
  sent.length = 0;
  ackBehavior = () => Promise.resolve({ ok: true });
  appStore.set({ activeId: 'inst-1' });
});
afterEach(() => vi.unstubAllGlobals());

const page = (live: ConversationModel, evs: any[]) => live.prependPage(live.renderPage(evs, null, null), live.leadingAssistantWrap);
const unstamped = () => ({ kind: 'user_echo', userIndex: 4, text: formatUserQuestionAnswers([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }]) });
const cardIn = (root: HTMLElement) => root.querySelector('[data-item="question"]') as HTMLElement;
const pressed = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>('[data-option][aria-pressed="true"]')].map((b) => b.dataset.option);

describe('answer bubble', () => {
  it('a single-question answer shows its header, the question, one chip and a head with no count, and no raw text', async () => {
    const { root } = await show([stamped([FRUIT], [{ kind: 'option', label: 'Apple' }])]);
    const bubble = root.querySelector('[data-item="user"]') as HTMLElement;
    expect(bubble.getAttribute('data-variant')).toBe('answer');
    const head = (bubble.querySelector('[data-answer-head]') as HTMLElement).textContent ?? '';
    expect(head).toMatch(/Answered$/);
    expect(head).not.toMatch(/questions/);
    const rows = bubble.querySelectorAll<HTMLElement>('[data-kind]');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('data-kind')).toBe('option');
    // Invariant: the answer row carries its question's header and question text beside its pick; the capitalised header reaches the row only through the header, since the question reads "Pick a fruit".
    const rowText = rows[0].textContent ?? '';
    expect(rowText).toContain('Fruit');
    expect(rowText).toContain('Pick a fruit');
    expect([...rows[0].querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['Apple']);
    expect(rows[0].querySelector('[data-note]')).toBeNull();
    expect(bubble.querySelector('.md')).toBeNull();
    expect(bubble.querySelector('[data-view="raw"]')).toBeNull();
    // Negative control: a header-less question's row carries its question text and no header.
    const bare = await show([stamped([SIZE], [{ kind: 'option', label: 'S' }])]);
    const bareText = bare.root.querySelector('[data-kind]')!.textContent ?? '';
    expect(bareText).toContain('Pick a size');
    expect(bareText).not.toContain('Fruit');
  });

  it('a structured canonical answer offers no raw-text or copy control', async () => {
    const { root } = await show([CARD(), CARD_RESULT, TURN_END, banana()]);
    const bubble = root.querySelector('[data-item="user"]') as HTMLElement;
    expect(bubble.getAttribute('data-variant'), 'fixture check: an answer bubble').toBe('answer');
    expect(bubble.querySelectorAll('[data-kind]').length, 'fixture check: structured rows').toBe(1);
    expect(within(bubble).queryByRole('button', { name: 'Show raw text' })).toBeNull();
    expect(within(bubble).queryByRole('button', { name: 'Copy message' })).toBeNull();
  });
});

describe('question card locking', () => {
  it('reload: a page holding the card and its stamped echo renders the card locked', async () => {
    const live = new ConversationModel();
    page(live, [CARD(), CARD_RESULT, TURN_END, banana()]);
    const r = renderModel(live);
    await flush();
    expectLocked(cardIn(r.root));
  });

  it('reload: a card on an older page locks from an answer the tail already applied', async () => {
    const live = new ConversationModel();
    live.apply(banana());
    page(live, [CARD(), CARD_RESULT, TURN_END]);
    const r = renderModel(live);
    await flush();
    expect(live.items[0].type, 'fixture check: the card is spliced in first').toBe('question');
    const last = live.items[live.items.length - 1];
    expect(last.type).toBe('user');
    expect((last as UserNode).variant).toBe('answer');
    expectLocked(cardIn(r.root));
  });

  it('an unstamped answer-shaped echo on a page leaves the card open and renders as a plain bubble', async () => {
    const live = new ConversationModel();
    page(live, [CARD(), CARD_RESULT, TURN_END, unstamped()]);
    const r = renderModel(live);
    await flush();
    expectOpen(cardIn(r.root));
    expect((r.root.querySelector('[data-item="user"]') as HTMLElement).getAttribute('data-variant')).toBe('plain');
  });

  it('a two-question card submitted in this tab keeps every option, the field and Send disabled through tab clicks, with its status untouched', async () => {
    const { card } = await show([CARD([FRUIT, SIZE])]);
    fireEvent.click(opt(card(), 'Banana'));
    await flush();
    fireEvent.click(card().querySelector('[data-tab="1"]') as HTMLElement);
    await flush();
    fireEvent.click(opt(card(), 'L'));
    await flush();
    fireEvent.click(sendBtn(card()));
    await flush();
    expect(sent.length).toBe(1);
    expect(statusOf(card())).toBe('Sending…');
    const expectPaneLocked = (label: string) => {
      for (const b of card().querySelectorAll<HTMLButtonElement>('[data-option]')) {
        expect(b.disabled, `${b.dataset.option} disabled`).toBe(true);
        expect(b.getAttribute('aria-pressed'), `${b.dataset.option} pressed`).toBe(String(b.dataset.option === label));
      }
      expect(input(card()).disabled).toBe(true);
      expect(sendBtn(card()).disabled).toBe(true);
    };
    expectPaneLocked('L');
    fireEvent.click(card().querySelector('[data-tab="0"]') as HTMLElement);
    await flush();
    expectPaneLocked('Banana');
    expect(statusOf(card())).toBe('Sending…');
    fireEvent.click(card().querySelector('[data-tab="1"]') as HTMLElement);
    await flush();
    expectPaneLocked('L');
  });

  it('a stamp naming the earlier card locks it and leaves the later, still-open card open', async () => {
    const { root } = await show([
      CARD([FRUIT], 'A'), { ...CARD_RESULT, toolUseId: 'A' },
      CARD([FRUIT], 'B'), { ...CARD_RESULT, toolUseId: 'B' },
      stamped([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }], 'A'),
    ]);
    const [a, b] = root.querySelectorAll<HTMLElement>('[data-item="question"]');
    expectLocked(a);
    expectOpen(b);
  });

  it('a stamp for a card never rendered locks nothing, and clearing the conversation forgets it', async () => {
    const m = new ConversationModel();
    m.apply(stamped([FRUIT], [{ kind: 'option', label: 'Banana' }], 'tu_gone'));
    expect(m.answeredQuestions.has('tu_gone'), 'premise: the stamp is recorded').toBe(true);
    m.clear();
    expect(m.answeredQuestions.size).toBe(0);
    m.apply(CARD([FRUIT], 'tu_gone'));
    const r = renderModel(m);
    await flush();
    expectOpen(cardIn(r.root));
  });

  it('clearing the conversation forgets rendered cards, so the same card replayed after a clear renders again', async () => {
    const m = new ConversationModel();
    m.apply(CARD());
    const r = renderModel(m);
    await flush();
    expect(r.root.querySelectorAll('[data-item="question"]').length, 'fixture check: the card renders').toBe(1);
    m.clear();
    await flush();
    expect(r.root.querySelectorAll('[data-item="question"]').length, 'fixture check: clear empties the view').toBe(0);
    m.apply(CARD());
    await flush();
    expect(m.items.filter((i) => i.type === 'question').length).toBe(1);
    expect(r.root.querySelectorAll('[data-item="question"]').length).toBe(1);
    expectOpen(cardIn(r.root));
  });

  const opts = (...labels: string[]) => labels.map((label) => ({ label }));
  const DASH = { question: 'Is "x" ok?', options: opts('Fast — risky', 'Slow — safe') };
  const PREFIXED = { question: 'Sure?', options: opts('Yes', 'Yes — sure') };
  const COMMA = { question: 'Pick types', multiSelect: true, options: opts('Lists, tuples', 'Dicts') };
  const SAME = { question: 'Same?', options: opts('Yes', 'No') };
  const QUOTE = { question: 'Greet', options: opts('say "hi"', 'wave') };
  const HARD_CASES: Record<string, [any[], any[]]> = {
    'case 1: a label holding " — ", with a note': [[DASH], [{ kind: 'option', label: 'Slow — safe', note: 'thanks' }]],
    'case 2: a label that begins with another label': [[PREFIXED], [{ kind: 'option', label: 'Yes — sure' }]],
    'case 3: an Other answer that begins with "<label> — "': [[PREFIXED], [{ kind: 'custom', text: 'Yes — maybe' }]],
    'case 4: a multiSelect label holding ", "': [[COMMA], [{ kind: 'multi', labels: ['Lists, tuples', 'Dicts'] }]],
    'case 5: two questions with identical text': [[SAME, SAME],
      [{ kind: 'option', label: 'No', note: 'second' }, { kind: 'option', label: 'Yes' }]],
    'case 6: a multi-line note and multi-line custom text in a two-question card': [[FRUIT, SAME],
      [{ kind: 'option', label: 'Apple', note: 'line one\nline two' }, { kind: 'custom', text: 'extra\nlarge' }]],
    'a label holding a quote': [[QUOTE], [{ kind: 'option', label: 'say "hi"' }]],
  };

  // Invariant: each hard-case answer renders one row per question with its kind, picks, custom text and note, and locks the card on those picks; a note-less row has no note.
  it('replay: every hard-case answer renders its exact rows and locks the card with its picks', async () => {
    for (const [name, [questions, answers]] of Object.entries(HARD_CASES)) {
      const live = new ConversationModel();
      page(live, [{ kind: 'user_question', toolUseId: 'tu_q', questions }, CARD_RESULT, TURN_END, stamped(questions, answers)]);
      const r = renderModel(live);
      await flush();
      const bubble = r.root.querySelector('[data-variant="answer"]') as HTMLElement;
      const rows = bubble.querySelectorAll<HTMLElement>('[data-kind]');
      expect(rows.length, `${name}: one row per question`).toBe(questions.length);
      answers.forEach((a: any, i: number) => {
        const row = rows[i];
        expect(row.getAttribute('data-kind'), `${name}: row ${i} kind`).toBe(a.kind);
        const labels = a.kind === 'option' ? [a.label] : a.kind === 'multi' ? a.labels : [];
        expect([...row.querySelectorAll('[data-choice]')].map((n) => n.textContent), `${name}: row ${i} chips`).toEqual(labels);
        if (a.kind === 'custom') expect(row.querySelector('[data-custom]')?.textContent, `${name}: row ${i} custom text`).toBe(a.text);
        else expect(row.querySelector('[data-custom]'), `${name}: row ${i} no custom text`).toBeNull();
        if (a.note) expect(row.querySelector('[data-note]')?.textContent, `${name}: row ${i} note`).toContain(a.note);
        else expect(row.querySelector('[data-note]'), `${name}: row ${i} no note`).toBeNull();
      });
      expect(bubble.querySelector('.md'), `${name}: no raw text fallback`).toBeNull();
      const card = cardIn(r.root);
      expect(statusOf(card), `${name}: the card is locked`).toBe('Answered');
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        if (questions.length > 1) {
          fireEvent.click(card.querySelector(`[data-tab="${i}"]`) as HTMLElement);
          await flush();
        }
        const want: string[] = a.kind === 'option' ? [a.label] : a.kind === 'multi' ? a.labels : [];
        expect(pressed(cardIn(r.root)), `${name}: pane ${i} picks`)
          .toEqual(questions[i].options.map((o: any) => o.label).filter((l: string) => want.includes(l)));
        const field = input(cardIn(r.root));
        expect(field.disabled, `${name}: pane ${i} field disabled`).toBe(true);
        const draft: string = a.kind === 'custom' ? a.text : (a.note ?? '');
        expect(field.value.replace(/[\r\n]/g, ''), `${name}: pane ${i} field text`).toBe(draft.replace(/[\r\n]/g, ''));
      }
      r.unmount();
    }
  });

  const OLD_FORMAT: Record<string, [any[], string, string]> = {
    'old single-question form': [[FRUIT], 'Answer to "Pick a fruit": Banana — ripe ones only', 'Banana'],
    'old multi-question form': [[FRUIT, SIZE], 'My answers:\n- Pick a fruit: Apple\n- Pick a size: L', 'Apple'],
  };

  it('an old-format answer renders raw in the answer bubble with its raw and copy controls, and locks the card with no pick', async () => {
    for (const [name, [questions, text, rawShows]] of Object.entries(OLD_FORMAT)) {
      const { root, card } = await show([
        { kind: 'user_question', toolUseId: 'tu_q', questions }, CARD_RESULT, TURN_END,
        { kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions } },
      ]);
      const bubble = root.querySelector('[data-item="user"]') as HTMLElement;
      expect(bubble.getAttribute('data-variant'), `${name}: still an answer bubble`).toBe('answer');
      expect((bubble.querySelector('[data-answer-head]') as HTMLElement).textContent, `${name}: head`).toMatch(/Answered/);
      expect(bubble.querySelectorAll('[data-kind]').length, `${name}: no structured rows`).toBe(0);
      const md = bubble.querySelector('.md') as HTMLElement | null;
      expect(md, `${name}: the raw text is kept visible`).not.toBeNull();
      expect((md as HTMLElement).textContent, `${name}: the raw text is shown`).toContain(rawShows);
      expect(within(bubble).getByRole('button', { name: 'Show raw text' }), `${name}: raw toggle`).toBeTruthy();
      expect(within(bubble).getByRole('button', { name: 'Copy message' }), `${name}: copy`).toBeTruthy();
      expect(statusOf(card()), `${name}: the card is locked`).toBe('Answered');
      expect(card().querySelectorAll('[data-option][aria-pressed="true"]').length, `${name}: no option is picked`).toBe(0);
      for (const i of card().querySelectorAll('input')) {
        expect(i.disabled, `${name}: field disabled`).toBe(true);
        expect(i.value, `${name}: no field text`).toBe('');
      }
    }
  });

  describe('a non-canonical answer the strict parse accepts renders raw and locks the card with no pick', () => {
    const NON_CANONICAL: Record<string, string> = {
      'untrimmed custom text': 'Answer to "Pick a fruit": (own answer) " Mango "',
      'a JSON-escape spelling of a label': 'Answer to "Pick a fruit": "\\u0041pple"',
      'an untrimmed note': 'Answer to "Pick a fruit": "Banana" (note: " ripe ")',
    };
    const echoOf = (text: string) => ({ kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions: [FRUIT] } });
    function rawNoPick(root: HTMLElement, card: HTMLElement, name: string) {
      const bubble = root.querySelector('[data-item="user"][data-variant="answer"]') as HTMLElement | null;
      expect(bubble, `${name}: an answer bubble`).not.toBeNull();
      expect((bubble as HTMLElement).querySelectorAll('[data-kind]').length, `${name}: no structured rows`).toBe(0);
      expect((bubble as HTMLElement).querySelector('.md'), `${name}: the raw text is shown`).not.toBeNull();
      expect(statusOf(card), `${name}: the card is locked`).toBe('Answered');
      expect(card.querySelectorAll('[data-option][aria-pressed="true"]').length, `${name}: no option is picked`).toBe(0);
      for (const i of card.querySelectorAll('input')) {
        expect(i.disabled, `${name}: field disabled`).toBe(true);
        expect(i.value, `${name}: no field text`).toBe('');
      }
    }

    it('premise: the strict parse accepts each spelling', () => {
      for (const [name, text] of Object.entries(NON_CANONICAL)) {
        expect(parseUserQuestionAnswers([FRUIT], text), name).not.toEqual([{ kind: 'none' }]);
      }
    });

    it('live: the echo after the card renders raw and locks with no pick', async () => {
      for (const [name, text] of Object.entries(NON_CANONICAL)) {
        const { root, card } = await show([CARD(), CARD_RESULT, TURN_END, echoOf(text)]);
        rawNoPick(root, card(), name);
      }
    });

    it('the card born on an older page after its answer was seen locks with no pick', async () => {
      for (const [name, text] of Object.entries(NON_CANONICAL)) {
        const live = new ConversationModel();
        live.apply(echoOf(text));
        page(live, [CARD(), CARD_RESULT]);
        const r = renderModel(live);
        await flush();
        rawNoPick(r.root, cardIn(r.root), name);
        r.unmount();
      }
    });

    it('a stamp the canonical parse rejects discards an unsubmitted local pick', async () => {
      for (const [name, text] of Object.entries(NON_CANONICAL)) {
        const { m, card } = await show([CARD(), CARD_RESULT, TURN_END]);
        fireEvent.click(opt(card(), 'Apple'));
        await flush();
        expect(opt(card(), 'Apple').getAttribute('aria-pressed'), `${name}: fixture check: Apple is picked locally`).toBe('true');
        expect(sent.length, `${name}: fixture check: nothing was submitted`).toBe(0);
        m.apply(echoOf(text));
        await flush();
        expect(statusOf(card()), `${name}: the card is locked`).toBe('Answered');
        expect(card().querySelectorAll('[data-option][aria-pressed="true"]').length, `${name}: the local pick is discarded`).toBe(0);
        expect(input(card()).value, `${name}: no field text`).toBe('');
      }
    });
  });

  describe('a card whose question text is not a string', () => {
    const questions: any[] = [{ question: false, options: [{ label: 'Apple' }, { label: 'Banana' }] }];
    const card = { kind: 'user_question', toolUseId: 'tu_q', questions };
    const echo = (text: string) => ({ kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions } });

    it('a foreign answer text locks the older-page card with no pick, without throwing', async () => {
      const live = new ConversationModel();
      live.apply(echo('Answer to "": Banana'));
      expect(() => page(live, [card, CARD_RESULT])).not.toThrow();
      const r = renderModel(live);
      await flush();
      const el = cardIn(r.root);
      expect(statusOf(el)).toBe('Answered');
      expect(el.querySelectorAll('[data-option][aria-pressed="true"]').length).toBe(0);
      expect(input(el).value).toBe('');
      const bubble = r.root.querySelector('[data-item="user"][data-variant="answer"]') as HTMLElement | null;
      expect(bubble, 'an answer bubble').not.toBeNull();
      expect((bubble as HTMLElement).querySelectorAll('[data-kind]').length, 'no structured rows').toBe(0);
      expect((bubble as HTMLElement).querySelector('.md'), 'the raw text is shown').not.toBeNull();
    });

    // Invariant: the formatter's own text locks the card on its pick and note, and the bubble's row shows that pick and note; the same text with no note shows none.
    it('the formatter\'s own text locks it with its pick, matching the bubble\'s rows', async () => {
      const answers: any[] = [{ kind: 'option', label: 'Banana', note: 'ripe' }];
      const live = new ConversationModel();
      live.apply(echo(formatUserQuestionAnswers(questions, answers)));
      page(live, [card, CARD_RESULT]);
      const r = renderModel(live);
      await flush();
      const rows = r.root.querySelectorAll<HTMLElement>('[data-variant="answer"] [data-kind]');
      expect(rows.length).toBe(1);
      expect(rows[0].getAttribute('data-kind')).toBe('option');
      expect([...rows[0].querySelectorAll('[data-choice]')].map((n) => n.textContent)).toEqual(['Banana']);
      expect(rows[0].querySelector('[data-note]')?.textContent).toContain('ripe');
      const el = cardIn(r.root);
      expect(opt(el, 'Banana').getAttribute('aria-pressed')).toBe('true');
      expect(opt(el, 'Apple').getAttribute('aria-pressed')).toBe('false');
      expect(input(el).value).toBe('ripe');
      // Negative control: the same formatter text without a note renders no note.
      const bare = new ConversationModel();
      bare.apply(echo(formatUserQuestionAnswers(questions, [{ kind: 'option', label: 'Banana' }])));
      page(bare, [card, CARD_RESULT]);
      const br = renderModel(bare);
      await flush();
      expect(br.root.querySelectorAll('[data-variant="answer"] [data-kind]').length).toBe(1);
      expect(br.root.querySelector('[data-variant="answer"] [data-note]')).toBeNull();
    });
  });
});

describe('interleaved echoes', () => {
  const Q = [{ question: 'Pick a fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] }];
  const stub = buildWakeStub({ targetSessionId: 'abc12345', payloadText: '{"sessionId":"abc12345","messages":[]}\nsome recent output' });

  it('an unstamped wake stub between the tool_result and the answer leaves the card open; the stamped echo after it locks Apple', async () => {
    const { m, root, card } = await show([
      { kind: 'user_question', toolUseId: 'tu_q1', questions: Q },
      { kind: 'tool_result', toolUseId: 'tu_q1', content: 'handed to user', isError: true, yielded: true },
      { kind: 'user_echo', text: stub },
    ]);
    expectOpen(card());
    expect(root.querySelectorAll('[data-variant="wake"]').length, 'fixture check: the stub is a wake bubble').toBe(1);
    m.apply({ kind: 'user_echo', userIndex: 2, text: formatUserQuestionAnswers(Q, [{ kind: 'option', label: 'Apple' }]), questionAnswer: { toolUseId: 'tu_q1', questions: Q } });
    await flush();
    expectLocked(card(), { picked: 'Apple', text: '' });
  });

  it('a mid-turn answer replayed from disk past a wake stub is stamped by the server and locks the card on its option', async () => {
    const S = await serverModules();
    const NOTE = await serverMidTurnNote();
    const CWD = '/tmp/qa-midturn-project';
    const SID = 'sess-qa-midturn';
    const ANSWER = formatUserQuestionAnswers(Q, [{ kind: 'option', label: 'Apple' }]);
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-qa-midturn-'));
    const prev = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = rootDir;
    try {
      const lines = [
        { type: 'user', uuid: 'u0', message: { role: 'user', content: 'ask me' } },
        { type: 'assistant', uuid: 'a0', message: { id: 'm_q', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_q1', name: 'AskUserQuestion', input: { questions: Q } }] } },
        { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_q1', content: 'awaiting', is_error: true }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: stub } },
        { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: NOTE }, { type: 'text', text: ANSWER }] } },
      ];
      const file = path.join(rootDir, S.encodeCwd(CWD), `${SID}.jsonl`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const result = await S.loadPersistedTranscript({ place: S.localPlace(CWD), sessionId: SID });
      const events = result.lines.flatMap((l: any) => l.events);
      const echoes = events.filter((e: any) => e.kind === 'user_echo');
      const last = echoes[echoes.length - 1];
      expect(last.text, 'fixture check: the note is dropped').toBe(ANSWER);
      expect(last.questionAnswer?.toolUseId, 'fixture check: the server stamped the answer').toBe('tu_q1');
      const stubEcho = echoes.find((e: any) => e.text === stub);
      expect(stubEcho, 'fixture check: the stub echo is replayed').toBeDefined();
      expect(stubEcho.questionAnswer, 'fixture check: the stub is unstamped').toBeUndefined();
      const m = new ConversationModel();
      m.applyEvents(events);
      const r = renderModel(m);
      await flush();
      expectLocked(cardIn(r.root), { picked: 'Apple', text: '' });
      expect(r.root.textContent).not.toContain('mid-turn');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('lazy history', () => {
  it('C15 the pager\'s page locks a card whose stamped answer the live tail applied first', async () => {
    const paths: string[] = [];
    const pages: any[] = [{ events: [CARD(), CARD_RESULT], hasMore: false, segment: null, nextBefore: 0, pageSegment: null, currentSegmentId: null }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(new URL(url, 'http://localhost').pathname);
      const p = pages.shift() ?? { events: [], hasMore: false, segment: null, nextBefore: null };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(p)) };
    }));
    const model = new ConversationModel();
    model.apply(banana());
    const h = createLazyHistory({ model, getActiveId: () => 'inst1' });
    h.setViewport({ clientHeight: () => 800, scrollHeight: () => 0, preserve: (fn) => fn() });
    h.init({ tailStartSeq: 900 });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
    expect(paths, 'fixture check: the pager fetched the lineage page').toContain('/api/instances/inst1/lineage-events');
    expect(model.items[0].type, 'fixture check: the card is spliced in first').toBe('question');
    const r = renderModel(model);
    await flush();
    expectLocked(cardIn(r.root));
  });
});
