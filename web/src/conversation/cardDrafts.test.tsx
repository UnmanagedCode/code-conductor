// What a plan card and a question card hold before they are answered: the plan's feedback,
// and the question card's tab, picks and note. A full-page view (Settings, review, …)
// unmounts the transcript and mounts it again on the same model, and every card comes back
// as the reader left it; a sent plan keeps the feedback it sent, and one whose send failed
// re-opens with it. A transcript replaced in place (a reconnect's snapshot, another session,
// a rewind) starts every card empty. Typing in the middle of a card's text keeps the caret.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';

const sent: { t: string; payload: any }[] = [];
vi.mock('@/lib/core/ws.js', () => ({
  bus: new EventTarget(),
  connect: () => {},
  // An acked prompt whose text says it fails is refused, as a send on a dead socket is.
  send: (t: string, payload: any, opts: { ack?: boolean } = {}) => {
    sent.push({ t, payload });
    if (!opts.ack) return undefined;
    return String(payload?.text ?? '').includes('fails') ? Promise.reject(new Error('not connected')) : Promise.resolve({ ok: true });
  },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@/lib/core/ws.js';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance, UiEvent } from '@/state/types';
import { buildApprovePrompt, buildRejectPrompt } from '../../../public/planApproval.ts';
import { ConversationView } from './ConversationView';
import { ConversationModel } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { FRUIT, SIZE } from './questionTestkit';

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });

/** Two plan cards and two two-question cards, each still awaiting the reader. */
const TRANSCRIPT: UiEvent[] = [
  { kind: 'user_echo', text: 'plan it', userIndex: 0 },
  { kind: 'plan_request', toolUseId: 'p1', plan: '# One' },
  { kind: 'plan_request', toolUseId: 'p2', plan: '# Two' },
  { kind: 'user_question', toolUseId: 'q1', questions: [FRUIT, SIZE] },
  { kind: 'user_question', toolUseId: 'q2', questions: [FRUIT, SIZE] },
  { kind: 'turn_end', subtype: 'success' },
];

// ── Driving the view ─────────────────────────────────────────────────────
const mount = () => {
  const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  return { ...r, el: r.container.querySelector('[data-conversation]') as HTMLElement };
};
async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const snapshot = (id: string, events: UiEvent[]) => frame('snapshot', { id, events });

async function click(el: Element) {
  fireEvent.click(el);
  await flush();
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  fireEvent.change(el, { target: { value: text } });
  await flush();
}

// ── Reading the cards ────────────────────────────────────────────────────
const plans = (root: Element) => [...root.querySelectorAll('[data-item="plan"]')] as HTMLElement[];
const questions = (root: Element) => [...root.querySelectorAll('[data-item="question"]')] as HTMLElement[];
const textbox = (card: HTMLElement) => within(card).getByRole('textbox') as HTMLInputElement | HTMLTextAreaElement;
/** A multi-question card's question buttons: a named group, the showing question's button pressed. */
const tabStrip = (card: HTMLElement) => within(card).getByRole('group', { name: 'Questions' });
const tab = (card: HTMLElement, i: number) => within(tabStrip(card)).getAllByRole('button')[i];

type Cards = { plans: string[]; questions: { tab: string | null; picked: string[]; note: string }[] };
/**
 * Each plan card's feedback; each question card's showing question, the picks and the note its pane shows.
 * The question buttons are read inside their group and the picks among `[data-option]` buttons, so a
 * pressed question button never counts as a pick, nor a pressed option as the showing question.
 */
function cards(root: Element): Cards {
  return {
    plans: plans(root).map((p) => textbox(p).value),
    questions: questions(root).map((q) => ({
      tab: within(tabStrip(q)).getAllByRole('button').find((t) => t.getAttribute('aria-pressed') === 'true')?.getAttribute('data-tab') ?? null,
      picked: [...q.querySelectorAll('[data-option][aria-pressed="true"]')].map((b) => b.getAttribute('data-option') ?? ''),
      note: textbox(q).value,
    })),
  };
}

const START: Cards = {
  plans: ['', ''],
  questions: [{ tab: '0', picked: [], note: '' }, { tab: '0', picked: [], note: '' }],
};
const SET: Cards = {
  plans: ['plan one feedback', 'plan two feedback'],
  questions: [{ tab: '1', picked: ['L'], note: 'size note' }, { tab: '0', picked: ['Apple'], note: 'fruit note' }],
};

/** Types each plan's own feedback; moves the first question card to its second tab and answers there, and answers the second card on its first. */
async function setCards(root: Element) {
  const [p1, p2] = plans(root);
  await type(textbox(p1), 'plan one feedback');
  await type(textbox(p2), 'plan two feedback');
  const [q1, q2] = questions(root);
  await click(tab(q1, 1));
  await click(q1.querySelector('[data-option="L"]')!);
  await type(textbox(q1), 'size note');
  await click(q2.querySelector('[data-option="Apple"]')!);
  await type(textbox(q2), 'fruit note');
}

/** Sets every card, then proves a remount keeps them all: the control each reset below is measured against. */
async function setAndRemount(): Promise<HTMLElement> {
  const first = mount();
  await snapshot('i1', TRANSCRIPT);
  await setCards(first.el);
  expect(cards(first.el), 'fixture check: every card moved away from where it starts').toEqual(SET);
  first.unmount();
  const back = mount();
  expect(cards(back.el), 'positive control: a remount keeps every card as the reader left it').toEqual(SET);
  return back.el;
}

/** Types `ch` at the caret as a browser does: the field's value and caret change, then `input` fires. */
function typeAt(el: HTMLInputElement | HTMLTextAreaElement, ch: string) {
  const at = el.selectionStart ?? el.value.length;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  setValue.call(el, el.value.slice(0, at) + ch + el.value.slice(at));
  el.setSelectionRange(at + ch.length, at + ch.length);
  fireEvent.input(el);
}
/** Types `abc`, puts the caret after the `a` and types `XY`, each keystroke in its own task as a browser delivers them. */
async function typeMidText(el: HTMLInputElement | HTMLTextAreaElement): Promise<string> {
  el.focus();
  for (const ch of 'abc') { act(() => typeAt(el, ch)); await flush(); }
  expect(el.value, 'fixture check: the field holds what was typed').toBe('abc');
  el.setSelectionRange(1, 1);
  for (const ch of 'XY') { act(() => typeAt(el, ch)); await flush(); }
  return el.value;
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [], hasMore: false, segment: null, nextBefore: null }),
  })));
  act(() => { appStore.set({ instances: [inst('i1'), inst('i2')], activeId: 'i1' }); });
  startController();
});

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('a full-page view round trip', () => {
  it('keeps each plan card\'s feedback and each question card\'s tab, picks and note', async () => {
    const first = mount();
    await snapshot('i1', TRANSCRIPT);
    expect(cards(first.el), 'fixture check: where the cards start').toEqual(START);
    await setCards(first.el);
    expect(cards(first.el), 'fixture check: every card moved away from where it starts').toEqual(SET);
    first.unmount();
    const back = mount();
    expect(cards(back.el).questions[1], 'the second question card, on its first tab, kept on its node').toEqual(SET.questions[1]);
    expect(cards(back.el)).toEqual(SET);
  });

  it('a sent plan keeps the feedback it sent, locked, and a plan whose send failed re-opens with its feedback', async () => {
    const first = mount();
    await snapshot('i1', TRANSCRIPT);
    const [p1, p2] = plans(first.el);
    await type(textbox(p1), 'this one lands');
    await type(textbox(p2), 'this one fails');
    await click(within(p1).getByRole('button', { name: /Reject/ }));
    await click(within(p2).getByRole('button', { name: /Reject/ }));
    await flush();
    expect(sent.map((s) => [s.t, s.payload.text]), 'each decision sent its own feedback').toEqual([
      ['prompt', buildRejectPrompt('this one lands')],
      ['prompt', buildRejectPrompt('this one fails')],
    ]);
    const state = (root: Element) => plans(root).map((p) => ({ feedback: textbox(p).value, locked: textbox(p).disabled }));
    const want = [{ feedback: 'this one lands', locked: true }, { feedback: 'this one fails', locked: false }];
    expect(state(first.el), 'before the round trip: the sent plan locked, the failed one re-opened').toEqual(want);
    first.unmount();
    const back = mount();
    expect(state(back.el)).toEqual(want);
  });

  it('an approved plan keeps the feedback it sent, locked, and a plan whose approve failed re-opens with its feedback', async () => {
    const first = mount();
    await snapshot('i1', TRANSCRIPT);
    const [p1, p2] = plans(first.el);
    await type(textbox(p1), 'this one lands');
    await type(textbox(p2), 'this one fails');
    await click(within(p1).getByRole('button', { name: /Approve/ }));
    await click(within(p2).getByRole('button', { name: /Approve/ }));
    await flush();
    // Each Approve first switches the mode, then sends its prompt; the prompts carry the feedback.
    expect(sent.filter((s) => s.t === 'prompt').map((s) => s.payload.text), 'each decision sent its own feedback').toEqual([
      buildApprovePrompt('this one lands'),
      buildApprovePrompt('this one fails'),
    ]);
    const state = (root: Element) => plans(root).map((p) => ({ feedback: textbox(p).value, locked: textbox(p).disabled }));
    const want = [{ feedback: 'this one lands', locked: true }, { feedback: 'this one fails', locked: false }];
    expect(state(first.el), 'before the round trip: the approved plan locked, the failed one re-opened').toEqual(want);
    first.unmount();
    const back = mount();
    expect(state(back.el)).toEqual(want);
  });
});

describe('a transcript replaced in place', () => {
  it('a reconnect\'s snapshot starts every card empty', async () => {
    const el = await setAndRemount();
    await snapshot('i1', TRANSCRIPT);
    expect(cards(el)).toEqual(START);
  });

  it('another session selected starts every card empty, and so does coming back', async () => {
    const el = await setAndRemount();
    act(() => { selectInstance('i2'); });
    await snapshot('i2', TRANSCRIPT);
    expect(cards(el), 'the other session').toEqual(START);
    act(() => { selectInstance('i1'); });
    await snapshot('i1', TRANSCRIPT);
    expect(cards(el), 'back on the first').toEqual(START);
  });

  it('a rewind starts every card of the replayed transcript empty', async () => {
    const el = await setAndRemount();
    // The server wipes the ring, sends the empty reset, then streams the replay as live frames.
    await frame('reset_snapshot', { id: 'i1', events: [] });
    for (const ev of TRANSCRIPT) await frame('event', { id: 'i1', ev });
    expect(cards(el)).toEqual(START);
  });
});

describe('typing in the middle of a card\'s text', () => {
  it('a plan card\'s feedback keeps the caret where the reader typed', async () => {
    const m = new ConversationModel();
    m.apply({ kind: 'plan_request', toolUseId: 'p1', plan: '# One' });
    const { root } = renderModel(m, noActions);
    await flush();
    expect(await typeMidText(textbox(plans(root)[0]))).toBe('aXYbc');
  });

  it('a question card\'s note keeps the caret where the reader typed', async () => {
    const m = new ConversationModel();
    m.apply({ kind: 'user_question', toolUseId: 'q1', questions: [FRUIT] });
    const { root } = renderModel(m, noActions);
    await flush();
    expect(await typeMidText(textbox(questions(root)[0]))).toBe('aXYbc');
  });
});
