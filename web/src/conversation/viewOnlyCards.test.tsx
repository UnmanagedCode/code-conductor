// The UI modes on the plan and question cards. `view`: the cards still SHOW
// their content (plan markdown, question text, option labels and descriptions)
// but carry no control that decides, answers or sends; `full`: every control is
// present. `interact`: the cards are actionable on the focused root's session
// only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: vi.fn(async () => ({ t: 'ack', ok: true })) }));

import { setUiMode } from '@shared/viewOnly';
import { setFocus } from '@shared/focus';
import { send } from '@shared/ws';
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
afterEach(() => { setUiMode('full'); setFocus(null); vi.mocked(send).mockClear(); });

describe('view-only cards', () => {
  it('view-only PlanCard: plan content visible, controls absent', async () => {
    // Invariant: the plan is readable, nothing on the card can approve, reject or send feedback.
    setUiMode('view');
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
    setUiMode('view');
    const { root } = await show([QCARD([Q1, Q2])]);
    const card = within(el(root, 'question'));
    expect(card.getByText('Pick a fruit')).toBeTruthy();
    for (const t of ['Apple', 'crunchy', 'Banana', 'soft']) expect(card.getByText(t), t).toBeTruthy();
    for (const label of ['Apple', 'Banana']) expect(card.queryByRole('button', { name: new RegExp(label) }), label).toBeNull();
    expect(card.queryByRole('textbox', { name: 'Answer' })).toBeNull();
    expect(card.queryByRole('button', { name: /Send (all )?answers?/ })).toBeNull();
    // A multi-question card keeps its (local) question tabs.
    expect(card.getByRole('group', { name: 'Questions' })).toBeTruthy();
    expect(el(root, 'question').querySelectorAll('[data-option]').length).toBe(0);
  });

  it('normal mode: both cards keep their controls', async () => {
    // Invariant (control): under `full` the same cards carry approve/reject, option buttons, Answer and Send.
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

describe('interact cards', () => {
  const seedSession = (sessionId: string) => appStore.set({ activeId: 'inst-1', instances: [{ id: 'inst-1', project: '.conduct', status: 'idle', sessionId, mode: 'plan' }] });

  it('the focused root\'s cards are actionable: Approve sends mode then prompt', async () => {
    // Invariant: under interact the focused root's plan card offers Approve,
    // which sends the `mode` frame (leaving plan mode) and then the approve
    // `prompt`; its question card offers its option buttons and Send.
    seedSession('root-sid');
    setFocus({ sessionId: 'root-sid' });
    setUiMode('interact');
    const plan = within(el((await show([PLAN])).root, 'plan'));
    await act(async () => { fireEvent.click(plan.getByRole('button', { name: /Approve/ })); await new Promise((r) => setTimeout(r, 0)); });
    expect(vi.mocked(send).mock.calls.map((c) => c[0])).toEqual(['mode', 'prompt']);
    expect(vi.mocked(send).mock.calls[0][1]).toMatchObject({ id: 'inst-1', mode: 'bypassPermissions' });
    const q = within(el((await show([QCARD([Q1, Q2])], new ConversationModel())).root, 'question'));
    expect(q.getByRole('button', { name: /Apple/ })).toBeTruthy();
    expect(q.getByRole('button', { name: /Send all answers/ })).toBeTruthy();
  });

  it('another session\'s cards stay read-only', async () => {
    // Invariant: under interact a card on a session that is not the focused one
    // (a worker) carries no Approve, no option button and no Send.
    seedSession('worker-sid');
    setFocus({ sessionId: 'root-sid' });
    setUiMode('interact');
    const plan = within(el((await show([PLAN])).root, 'plan'));
    expect(plan.queryByRole('button', { name: /Approve/ })).toBeNull();
    const q = within(el((await show([QCARD([Q1, Q2])], new ConversationModel())).root, 'question'));
    expect(q.queryByRole('button', { name: /Apple/ })).toBeNull();
    expect(q.queryByRole('button', { name: /Send (all )?answers?/ })).toBeNull();
  });
});
