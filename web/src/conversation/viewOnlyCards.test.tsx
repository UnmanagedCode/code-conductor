// View-only: the plan and question cards still SHOW their content (plan markdown,
// question text, option labels and descriptions) but carry no control that decides,
// answers or sends. Flag off: every control is present.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn() }));

import { setViewOnly } from '@shared/viewOnly';
import { appStore } from '@/state/app';
import { ConversationModel } from './model';
import { show } from './questionTestkit';

const PLAN = { kind: 'plan_request', toolUseId: 'p1', plan: '# The plan\n\n- step one', planPath: '/tmp/plan.md' };
const Q = (header: string, question: string, options: { label: string; description?: string }[]) => ({ header, question, multiSelect: false, options });
const Q1 = Q('Fruit', 'Pick a fruit', [{ label: 'Apple', description: 'crunchy' }, { label: 'Banana', description: 'soft' }]);
const Q2 = Q('Size', 'Pick a size', [{ label: 'Small' }, { label: 'Large' }]);
const QCARD = (questions: any[]) => ({ kind: 'user_question', toolUseId: 'tu_q', questions });
const el = (root: HTMLElement, kind: string) => root.querySelector(`[data-item="${kind}"]`) as HTMLElement;

beforeEach(() => appStore.set({ activeId: 'inst-1' }));
afterEach(() => setViewOnly(false));

describe('view-only cards', () => {
  it('view-only PlanCard: plan content visible, controls absent', async () => {
    // Invariant: the plan is readable, nothing on the card can approve, reject or send feedback.
    setViewOnly(true);
    const { root } = await show([PLAN]);
    const card = within(el(root, 'plan'));
    expect(card.getByText('The plan')).toBeTruthy();
    expect(card.getByText('step one')).toBeTruthy();
    expect(card.getByText('Plan')).toBeTruthy();
    expect(card.getByText(/Saved to \/tmp\/plan\.md/)).toBeTruthy();
    expect(card.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(card.queryByRole('button', { name: /Reject/ })).toBeNull();
    expect(card.queryByRole('textbox', { name: 'Plan feedback' })).toBeNull();
  });

  it('view-only QuestionCard: question and options visible, controls absent', async () => {
    // Invariant: the question and every option (label + description) read as text; no option is a button, no answer box, no send.
    setViewOnly(true);
    const { root } = await show([QCARD([Q1, Q2])]);
    const card = within(el(root, 'question'));
    expect(card.getByText('Pick a fruit')).toBeTruthy();
    for (const t of ['Apple', 'crunchy', 'Banana', 'soft']) expect(card.getByText(t), t).toBeTruthy();
    for (const label of ['Apple', 'Banana']) expect(card.queryByRole('button', { name: new RegExp(label) }), label).toBeNull();
    expect(card.queryByRole('textbox', { name: 'Answer' })).toBeNull();
    expect(card.queryByRole('button', { name: /Send (all )?answers?/ })).toBeNull();
    // A multi-question card keeps its (local) question tabs.
    expect(card.getByRole('group', { name: 'Questions' })).toBeTruthy();
    expect(card.getAllByRole('button').length).toBe(2);
  });

  it('normal mode: both cards keep their controls', async () => {
    // Invariant (control): with the flag off the same cards carry approve/reject, option buttons, Answer and Send.
    const plan = within(el((await show([PLAN])).root, 'plan'));
    expect(plan.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(plan.getByRole('button', { name: /Reject/ })).toBeTruthy();
    expect(plan.getByRole('textbox', { name: 'Plan feedback' })).toBeTruthy();
    const q = within(el((await show([QCARD([Q1, Q2])], new ConversationModel())).root, 'question'));
    expect(q.getByRole('button', { name: /Apple/ })).toBeTruthy();
    expect(q.getByRole('textbox', { name: 'Answer' })).toBeTruthy();
    expect(q.getByRole('button', { name: /Send all answers/ })).toBeTruthy();
  });
});
