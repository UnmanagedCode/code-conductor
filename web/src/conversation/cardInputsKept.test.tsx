// A question card's tab, picks, "Other" text and notes, and a plan card's feedback, survive a transcript
// replaced in place: a reconnect's snapshot, a respawn's history reload, re-selecting the shown session,
// and another session selected and coming back. Each trigger rebuilds the transcript (the model's clear
// count grows and the session is subscribed again), and the rebuilt cards read back as the reader left them.
// Input that is spent is not brought back: an answered question, and a plan whose decision was sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';

const wire = vi.hoisted(() => ({
  sent: [] as { t: string; payload: any }[],
  transcripts: new Map<string, unknown[]>(),
}));
vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  return {
    bus,
    connect: () => {},
    // A subscribe is answered with that instance's transcript, as the server answers one.
    // An acked prompt whose text says it fails is refused, as a send on a dead socket is.
    send: (t: string, payload: any, opts: { ack?: boolean } = {}) => {
      wire.sent.push({ t, payload });
      if (t === 'subscribe') {
        queueMicrotask(() => bus.dispatchEvent(new CustomEvent('snapshot', { detail: { id: payload.id, events: wire.transcripts.get(payload.id) ?? [] } })));
      }
      if (!opts.ack) return undefined;
      return String(payload?.text ?? '').includes('fails') ? Promise.reject(new Error('not connected')) : Promise.resolve({ ok: true });
    },
  };
});

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import { routeFetch } from '@/test/routeFetch';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import type { UserQuestionAnswer } from '@shared/userQuestionAnswers';
import { formatUserQuestionAnswers } from '@shared/userQuestionAnswers';
import { buildRejectPrompt } from '@shared/planApproval';
import { ConversationView } from './ConversationView';
import { flush } from './renderModel';
import { FRUIT, SIZE, TOPPINGS, stamped } from './questionTestkit';
import { turnEnd } from './testkit';

const QUESTIONS = [FRUIT, TOPPINGS, SIZE];
const TRANSCRIPT: UiEvent[] = [
  { kind: 'user_echo', text: 'ask me', userIndex: 0 },
  { kind: 'user_question', toolUseId: 'q1', questions: QUESTIONS },
  { kind: 'user_question', toolUseId: 'q2', questions: QUESTIONS },
  { kind: 'plan_request', toolUseId: 'p1', plan: '# One', planPath: null },
  { kind: 'plan_request', toolUseId: 'p2', plan: '# Two', planPath: null },
  turnEnd({ subtype: 'success' }),
];

// ── Booting over a socket that answers subscribes ────────────────────────
let n = 0;
let ids: { a: string; b: string };
const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });

async function frame(type: string, detail?: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  for (let i = 0; i < 6; i++) await flush();
}

async function boot(transcript: UiEvent[] = TRANSCRIPT) {
  n += 1;
  ids = { a: `iA${n}`, b: `iB${n}` };
  wire.sent.length = 0;
  wire.transcripts.set(ids.a, transcript);
  wire.transcripts.set(ids.b, transcript);
  const instances = [inst(ids.a), inst(ids.b)];
  routeFetch({
    'GET /api/instances/': () => ({ json: { events: [], hasMore: false, nextBefore: null, segment: null } }),
    'GET /api/instances': () => ({ json: instances }),
    'GET /api/projects': () => ({ json: [] }),
    'GET /api/workspaces': () => ({ json: [] }),
  });
  act(() => { appStore.set({ instances, activeId: ids.a }); });
  startController();
  await frame('open');
  const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  await flush();
  return r.container.querySelector('[data-conversation]') as HTMLElement;
}

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});
beforeEach(() => { wire.transcripts.clear(); });

// ── Driving and reading the cards ────────────────────────────────────────
const plans = (root: Element) => [...root.querySelectorAll('[data-item="plan"]')] as HTMLElement[];
const questions = (root: Element) => [...root.querySelectorAll('[data-item="question"]')] as HTMLElement[];
const textbox = (card: HTMLElement) => within(card).getByRole('textbox') as HTMLInputElement | HTMLTextAreaElement;
const tabs = (card: HTMLElement) => within(within(card).getByRole('group', { name: 'Questions' })).getAllByRole('button');
const prompts = () => wire.sent.filter((s) => s.t === 'prompt').map((s) => s.payload.text);
const subscribes = () => wire.sent.filter((s) => s.t === 'subscribe').map((s) => s.payload.id);

async function click(el: Element) { fireEvent.click(el); await flush(); }
async function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) { fireEvent.change(el, { target: { value: text } }); await flush(); }
const opt = (card: HTMLElement, label: string) => card.querySelector(`[data-option="${label}"]`)!;

type Pane = { picked: string[]; note: string };
type Card = { tab: string | null; panes: Pane[] };
/** The showing tab, then each question's picks and text (clicking through the tabs), ending back on the showing tab. */
async function readCard(card: HTMLElement): Promise<Card> {
  const buttons = tabs(card);
  const showing = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
  const panes: Pane[] = [];
  for (let i = 0; i < buttons.length; i++) {
    await click(tabs(card)[i]);
    panes.push({
      picked: [...card.querySelectorAll('[data-option][aria-pressed="true"]')].map((b) => b.getAttribute('data-option') ?? ''),
      note: textbox(card).value,
    });
  }
  await click(tabs(card)[showing]);
  return { tab: String(showing), panes };
}

const START_CARD: Card = { tab: '0', panes: [{ picked: [], note: '' }, { picked: [], note: '' }, { picked: [], note: '' }] };
const SET_Q1: Card = {
  tab: '1',
  panes: [{ picked: ['Apple'], note: 'fruit note' }, { picked: ['Nuts', 'Syrup'], note: 'toppings note' }, { picked: [], note: 'XL please' }],
};
const SET_Q2: Card = { tab: '0', panes: [{ picked: ['Banana'], note: '' }, { picked: [], note: '' }, { picked: [], note: '' }] };
const FEEDBACK = ['plan one feedback', 'plan two feedback'];
const EXPECTED: UserQuestionAnswer[] = [
  { kind: 'option', label: 'Apple', note: 'fruit note' },
  { kind: 'multi', labels: ['Nuts', 'Syrup'], note: 'toppings note' },
  { kind: 'custom', text: 'XL please' },
];

/** Answers the first card on every question, the second on its first, types both plans' feedback, and leaves the first card on its second tab. */
async function setAll(root: HTMLElement) {
  const [q1, q2] = questions(root);
  await click(opt(q1, 'Apple'));
  await type(textbox(q1), 'fruit note');
  await click(tabs(q1)[1]);
  await click(opt(q1, 'Nuts'));
  await click(opt(q1, 'Syrup'));
  await type(textbox(q1), 'toppings note');
  await click(tabs(q1)[2]);
  await type(textbox(q1), 'XL please');
  await click(tabs(q1)[1]);
  await click(opt(q2, 'Banana'));
  const [p1, p2] = plans(root);
  await type(textbox(p1), FEEDBACK[0]);
  await type(textbox(p2), FEEDBACK[1]);
}
const feedbacks = (root: Element) => plans(root).map((p) => textbox(p).value);

describe('a transcript replaced in place keeps every card as the reader left it', () => {
  const triggers: [string, (root: HTMLElement) => Promise<void>][] = [
    ['a reconnect', async () => { await frame('close'); await frame('open'); }],
    ['a respawn\'s history reload', async () => { await frame('event', { id: ids.a, ev: { kind: 'system', subtype: 'history_replayed', data: { count: 1 } } }); }],
    ['re-selecting the shown session', async () => { act(() => { selectInstance(ids.a, { userGesture: true }); }); await flush(); await flush(); }],
    ['another session selected, and coming back', async (root) => {
      act(() => { selectInstance(ids.b, { userGesture: true }); });
      for (let i = 0; i < 4; i++) await flush();
      expect(await readCard(questions(root)[0]), 'premise: the other session\'s card starts empty').toEqual(START_CARD);
      expect(feedbacks(root), 'premise: the other session\'s plans start empty').toEqual(['', '']);
      act(() => { selectInstance(ids.a, { userGesture: true }); });
      for (let i = 0; i < 4; i++) await flush();
    }],
  ];

  for (const [name, trigger] of triggers) {
    it(name, async () => {
      const root = await boot();
      await setAll(root);
      expect(await readCard(questions(root)[0]), 'fixture check: the first question card holds what was set').toEqual(SET_Q1);
      expect(await readCard(questions(root)[1]), 'fixture check: the second question card holds what was set').toEqual(SET_Q2);
      expect(feedbacks(root), 'fixture check: the plans hold their feedback').toEqual(FEEDBACK);
      const clears = conversation.clears;
      const subs = subscribes().length;
      await trigger(root);
      expect(conversation.clears, 'premise: the transcript was rebuilt').toBeGreaterThan(clears);
      expect(subscribes().length, 'premise: the session was subscribed again').toBeGreaterThan(subs);
      expect(await readCard(questions(root)[0]), 'the first question card').toEqual(SET_Q1);
      expect(await readCard(questions(root)[1]), 'the second question card').toEqual(SET_Q2);
      expect(feedbacks(root), 'each plan\'s own feedback').toEqual(FEEDBACK);
      await click(within(questions(root)[0]).getByRole('button', { name: /Send all answers/ }));
      expect(prompts().at(-1), 'the answer sent is the restored one').toBe(formatUserQuestionAnswers(QUESTIONS, EXPECTED));
    });
  }
});

describe('a plan card\'s feedback after its decision', () => {
  const state = (card: HTMLElement) => ({ feedback: textbox(card).value, editable: !textbox(card).disabled, status: card.querySelector('[data-status]')?.textContent });

  it('a decided plan reopens without the feedback it sent; the undecided one keeps its own', async () => {
    const root = await boot();
    const [p1, p2] = plans(root);
    await type(textbox(p1), 'plan one lands');
    await type(textbox(p2), 'plan two waits');
    await click(within(p1).getByRole('button', { name: /Reject/ }));
    expect(prompts(), 'fixture check: the decision was sent').toEqual([buildRejectPrompt('plan one lands')]);
    await frame('close');
    await frame('open');
    expect(feedbacks(root)[1], 'the undecided plan keeps its feedback').toBe('plan two waits');
    // Green before the card store exists (nothing is stored to bring back); it pins that a decision drops the stored feedback.
    expect(state(plans(root)[0])).toEqual({ feedback: '', editable: true, status: 'Awaiting your decision' });
  });

  it('a decision whose send fails keeps its feedback through a reconnect', async () => {
    const root = await boot();
    const [p1] = plans(root);
    await type(textbox(p1), 'this one fails');
    await click(within(p1).getByRole('button', { name: /Reject/ }));
    expect(prompts(), 'fixture check: the decision was sent and refused').toEqual([buildRejectPrompt('this one fails')]);
    expect(state(p1), 'fixture check: the plan re-opened with its feedback').toMatchObject({ feedback: 'this one fails', editable: true });
    await frame('close');
    await frame('open');
    expect(feedbacks(root)[0]).toBe('this one fails');
  });
});

describe('a question card once answered', () => {
  it('locks on the answer it was sent, and a snapshot without that answer shows the card open at its start', async () => {
    const root = await boot();
    await setAll(root);
    expect(await readCard(questions(root)[0]), 'fixture check: the card holds what was set').toEqual(SET_Q1);
    const answers: UserQuestionAnswer[] = [{ kind: 'option', label: 'Banana' }, { kind: 'multi', labels: ['Cream'] }, { kind: 'option', label: 'S' }];
    await frame('event', { id: ids.a, ev: stamped(QUESTIONS, answers, 'q1') });
    const card = () => questions(root)[0];
    expect(card().querySelector('[data-status]')!.textContent, 'the card locked').toBe('Answered');
    expect((await readCard(card())).panes.map((p) => p.picked), 'it shows the echo\'s answers, not the local input').toEqual([['Banana'], ['Cream'], ['S']]);
    await click(tabs(card())[2]);
    expect(card().querySelector('[data-status]')!.textContent, 'a tab click leaves it answered').toBe('Answered');
    // A rewind to before the answer: the transcript carries no echo.
    await frame('snapshot', { id: ids.a, events: TRANSCRIPT });
    expect(await readCard(questions(root)[0])).toEqual(START_CARD);
  });
});

describe('picks alone, and a session whose instance id changes', () => {
  const picked = (card: HTMLElement) => [...card.querySelectorAll('[data-option][aria-pressed="true"]')].map((b) => b.getAttribute('data-option'));

  it('options picked on single-question cards, with no note typed and no tab touched, come back after a reconnect and are sent', async () => {
    const one: UiEvent[] = [
      { kind: 'user_echo', text: 'ask me', userIndex: 0 },
      { kind: 'user_question', toolUseId: 'qs', questions: [FRUIT] },
      { kind: 'user_question', toolUseId: 'qm', questions: [TOPPINGS] },
      turnEnd({ subtype: 'success' }),
    ];
    const root = await boot(one);
    const [single, multi] = questions(root);
    await click(opt(single, 'Apple'));
    await click(opt(multi, 'Nuts'));
    await click(opt(multi, 'Syrup'));
    expect([picked(single), picked(multi)], 'fixture check: the picks are on the cards').toEqual([['Apple'], ['Nuts', 'Syrup']]);
    const clears = conversation.clears;
    await frame('close');
    await frame('open');
    expect(conversation.clears, 'premise: the transcript was rebuilt').toBeGreaterThan(clears);
    const [single2, multi2] = questions(root);
    expect([picked(single2), picked(multi2)]).toEqual([['Apple'], ['Nuts', 'Syrup']]);
    await click(within(single2).getByRole('button', { name: /Send answer/ }));
    expect(prompts().at(-1), 'the pick is sent').toBe(formatUserQuestionAnswers([FRUIT], [{ kind: 'option', label: 'Apple' }]));
  });

  it('the same session under a new instance id (a resume) keeps the card input', async () => {
    const root = await boot();
    await setAll(root);
    expect(feedbacks(root), 'fixture check: the plans hold their feedback').toEqual(FEEDBACK);
    // The old instance is gone, the resumed one lists the same session under a new id, and the client selects it.
    const resumed = { ...inst(ids.a), id: `${ids.a}-resumed`, sessionId: `s-${ids.a}` };
    wire.transcripts.set(resumed.id, TRANSCRIPT);
    const clears = conversation.clears;
    act(() => { appStore.set({ instances: [resumed, inst(ids.b)] }); });
    act(() => { selectInstance(resumed.id, { userGesture: true }); });
    for (let i = 0; i < 4; i++) await flush();
    expect(conversation.clears, 'premise: the transcript was rebuilt').toBeGreaterThan(clears);
    expect(subscribes().at(-1), 'premise: the resumed instance was subscribed').toBe(resumed.id);
    expect(await readCard(questions(root)[0])).toEqual(SET_Q1);
    expect(feedbacks(root)).toEqual(FEEDBACK);
  });
});
