// Question-card fixtures and DOM readers shared by the card tests. Declares no tests.
import { expect } from 'vitest';
import { within } from '@testing-library/react';
import { formatUserQuestionAnswers } from '@shared/userQuestionAnswers';
import { ConversationModel } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { turnEnd } from './testkit';
import type { UiEventOf } from '@shared/uiEvent';

export const FRUIT = { header: 'Fruit', question: 'Pick a fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] };
export const TOPPINGS = { header: 'Toppings', question: 'Pick toppings', multiSelect: true, options: [{ label: 'Nuts' }, { label: 'Cream' }, { label: 'Syrup' }] };
export const SIZE = { question: 'Pick a size', options: [{ label: 'S' }, { label: 'L' }] };

export const CARD = (questions: any[] = [FRUIT], toolUseId = 'tu_q'): UiEventOf<'user_question'> => ({ kind: 'user_question', toolUseId, questions });
export const CARD_RESULT: UiEventOf<'tool_result'> = { kind: 'tool_result', toolUseId: 'tu_q', content: 'handed to user', isError: true, yielded: true, finishedAt: 0 };
export const TURN_END = turnEnd();
export const stamped = (questions: any[], answers: any[], toolUseId = 'tu_q'): UiEventOf<'user_echo'> => ({
  kind: 'user_echo', userIndex: 4, text: formatUserQuestionAnswers(questions, answers), questionAnswer: { toolUseId, questions },
});
export const banana = () => stamped([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }]);

export async function show(events: any[], model = new ConversationModel()) {
  for (const ev of events) model.apply(ev);
  const r = renderModel(model, noActions);
  await flush();
  const card = () => r.root.querySelector('[data-item="question"]') as HTMLElement;
  return { m: model, root: r.root, card };
}

export const opt = (card: HTMLElement, label: string) => card.querySelector(`[data-option="${label}"]`) as HTMLButtonElement;
export const input = (card: HTMLElement) => card.querySelector('input') as HTMLInputElement;
export const sendBtn = (card: HTMLElement) => within(card).getByRole('button', { name: /Send (all )?answers?/ }) as HTMLButtonElement;
export const statusOf = (card: HTMLElement) => card.querySelector('[data-status]')!.textContent;

export function expectLocked(card: HTMLElement, { picked = 'Banana', text = 'ripe ones only' } = {}) {
  expect(statusOf(card)).toBe('Answered');
  expect(sendBtn(card).disabled).toBe(true);
  for (const b of card.querySelectorAll<HTMLButtonElement>('[data-option]')) {
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe(String(b.dataset.option === picked));
  }
  expect(input(card).disabled).toBe(true);
  expect(input(card).value).toBe(text);
}
export function expectOpen(card: HTMLElement) {
  expect(statusOf(card)).not.toBe('Answered');
  for (const b of card.querySelectorAll<HTMLButtonElement>('[data-option]')) {
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-pressed')).toBe('false');
  }
  expect(input(card).disabled).toBe(false);
}
