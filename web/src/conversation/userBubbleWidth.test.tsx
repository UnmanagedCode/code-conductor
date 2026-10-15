// Every user-authored item spans the transcript column like the question and plan cards do, with a tint and
// a right-edge strip as its side cue. The geometry itself is web/e2e/user-bubble-width.shared.ts (happy-dom
// reads 0); these pin the classes it rests on.
import { describe, expect, it } from 'vitest';
import { buildWakeStub } from '@shared/wakeCallback';
import { buildRenewSeed } from '@shared/renewSeed';
import { buildForwardFrame } from '@shared/forwardFrame';
import { buildApprovePrompt, buildRejectPrompt } from '@shared/planApproval';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel } from './model';
import { USER_BUBBLE, USER_TONE_PROMPT } from './items';
import { flush, renderModel } from './renderModel';
import { CARD, FRUIT, show, stamped } from './questionTestkit';
import { tool } from './testkit';
import { alignClasses, classesOf, marginX, padX, selfAlignClasses, tokens } from './userBubbleTestkit';

async function render(events: UiEvent[]) {
  const m = new ConversationModel();
  m.applyEvents(events);
  const r = renderModel(m);
  await flush();
  return r.root;
}

const PROMPT: UiEvent = { kind: 'user_echo', text: 'a typed prompt', userIndex: 0 };
const WAKE: UiEvent = { kind: 'user_echo', text: buildWakeStub({ targetSessionId: 'abc12345', payloadText: 'the worker said hi' }), userIndex: 1 };
const ATTACHED = {
  kind: 'user_echo', text: 'look at this', userIndex: 2,
  attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'QUJD', name: 'shot.png' }, { kind: 'file', name: 'notes.txt', path: '/p/notes.txt' }],
} as UiEvent;
const QUEUED: UiEvent = { kind: 'overage_message_queued', data: { text: 'QUEUED-ONE', attachmentCount: 0, ts: Date.UTC(2026, 0, 5, 9, 30), queuedCount: 1 } };

const PLAN: UiEvent = { kind: 'plan_request', toolUseId: 'p1', plan: '# P', planPath: null };
const echo = (text: string, extra: object = {}): UiEvent => ({ kind: 'user_echo', text, userIndex: 7, ...extra }) as UiEvent;

// One row per user-side variant; `item` finds its root item in a rendered transcript, `fold` the fold it shows.
const VARIANTS: { name: string; events: UiEvent[]; item: string; fold?: string }[] = [
  { name: 'typed prompt', events: [PROMPT], item: '[data-item="user"]' },
  { name: 'prompt with attachments', events: [ATTACHED], item: '[data-item="user"]' },
  { name: 'wake stub', events: [WAKE], item: '[data-item="user"][data-variant="wake"]', fold: 'wake' },
  { name: 'skill load', events: [echo('skill body', { skillLoad: { skill: 'k' } })], item: '[data-item="user"]', fold: 'skill' },
  { name: 'renew seed', events: [echo(buildRenewSeed({ summary: 'prose' }))], item: '[data-item="user"][data-variant="renew"]', fold: 'renew' },
  { name: 'forwarded output', events: [echo(buildForwardFrame({ messages: ['only'], instruction: 'go' }))], item: '[data-item="user"][data-variant="forward"]', fold: 'forward' },
  { name: 'plan approve echo', events: [echo(buildApprovePrompt('go'))], item: '[data-item="user"]' },
  { name: 'plan reject echo', events: [echo(buildRejectPrompt('refine X'))], item: '[data-item="user"]' },
  { name: 'queued ghost', events: [QUEUED], item: '[data-item="queued"]' },
];

describe('user item width', () => {
  // Invariant: every root user-side item carries the same (empty) horizontal margin as the question and plan items, and nothing caps it, pushes it right or shrinks its folds wrapper.
  describe.each(VARIANTS)('$name spans the row as the question and plan cards do', ({ events, item: selector, fold }) => {
    it('has no horizontal margin and nothing capping or pushing it', async () => {
      const root = await render([CARD([FRUIT]), PLAN, ...events]);
      const question = root.querySelector('[data-item="question"]');
      const plan = root.querySelector('[data-item="plan"]');
      expect(question, 'positive control: the question card').not.toBeNull();
      expect(plan, 'positive control: the plan card').not.toBeNull();
      expect(marginX(question!), 'positive control: the question item has no margin').toEqual([]);
      expect(marginX(plan!), 'positive control: the plan item has no margin').toEqual([]);
      const item = root.querySelector(selector);
      expect(item, `fixture check: the item ${selector}`).not.toBeNull();
      if (fold) {
        expect(item!.querySelector(`[data-fold="${fold}"]`), `fixture check: the ${fold} fold`).not.toBeNull();
        const folds = item!.querySelector('[data-user-folds]');
        expect(folds, "fixture check: the item's folds wrapper").not.toBeNull();
        expect(alignClasses(folds!), `folds wrapper: ${folds!.className}`).toEqual([]);
      }
      expect(marginX(item!), `${selector}: ${item!.className}`).toEqual(marginX(question!));
      expect(alignClasses(item!), item!.className).toEqual([]);
      for (const el of item!.children) expect(selfAlignClasses(el), `child: ${el.className}`).toEqual([]);
      for (const el of item!.querySelectorAll('[data-user-text], :scope > div')) expect(selfAlignClasses(el), el.className).toEqual([]);
    });
  });

  // Invariant: the answer bubble's root item carries the same (empty) horizontal margin as the question and plan items, uncapped and not pushed right.
  it('a question answer spans the row as the question and plan cards do', async () => {
    const { root } = await show([CARD([FRUIT]), PLAN, stamped([FRUIT], [{ kind: 'option', label: 'Apple' }])]);
    const question = root.querySelector('[data-item="question"]');
    expect(question, 'positive control: the question card').not.toBeNull();
    expect(marginX(question!)).toEqual([]);
    const head = root.querySelector('[data-answer-head]');
    expect(head, 'fixture check: the answer bubble').not.toBeNull();
    const item = head!.closest('[data-item="user"]')!;
    expect(item, 'fixture check: the answer sits in a user item').not.toBeNull();
    expect(marginX(item)).toEqual(marginX(question!));
    expect(alignClasses(item)).toEqual([]);
    for (const el of item.children) expect(selfAlignClasses(el), `child: ${el.className}`).toEqual([]);
  });

  // Invariant: the attachments row carries the bubble's own horizontal padding, so its chips start at its text; the action row carries none, so its controls end at the bubble's right edge as the assistant controls end at the body's.
  it('the attachments row starts at the bubble\'s text; the action row ends at its right edge', async () => {
    const root = await render([ATTACHED]);
    const text = root.querySelector('[data-user-text]')!;
    const attachments = root.querySelector('[data-user-attachments]');
    const actions = root.querySelector('[data-user-actions]');
    expect(attachments, 'the attachments row').not.toBeNull();
    expect(actions, 'the action row').not.toBeNull();
    expect(padX(text).length).toBeGreaterThan(0);
    expect(padX(attachments!)).toEqual(padX(text));
    expect(padX(actions!)).toEqual([]);
    expect(actions!.hasAttribute('data-action-row')).toBe(true);
  });

  // Invariant: the prompt, answer and queued bubbles all carry USER_BUBBLE's shape (tint strip, no outline ring); a typed prompt carries USER_TONE_PROMPT.
  it("a bubble's side cue is the shared shape, in its tone", async () => {
    const root = await render([PROMPT, QUEUED]);
    const prompt = root.querySelector('[data-user-text]')!;
    const ghost = root.querySelector('[data-item="queued"] > div')!;
    const { root: answered } = await show([stamped([FRUIT], [{ kind: 'option', label: 'Apple' }])]);
    const answer = answered.querySelector('[data-answer-head]')?.parentElement;
    expect(answer, 'fixture check: the answer bubble').toBeTruthy();
    const bubbles = [['prompt', prompt], ['answer', answer!], ['queued', ghost]] as const;
    for (const [name, el] of bubbles) expect(classesOf(el).filter((c) => /^(?:[\w-]+:)*ring-/.test(c)), `${name} has no outline ring`).toEqual([]);
    expect(tokens(USER_BUBBLE).length, 'the shared shape has classes').toBeGreaterThan(0);
    expect(tokens(USER_TONE_PROMPT).length, 'the prompt tone has classes').toBeGreaterThan(0);
    for (const [name, el] of bubbles) expect(classesOf(el), `${name} has the shared shape`).toEqual(expect.arrayContaining(tokens(USER_BUBBLE)));
    expect(classesOf(prompt)).toEqual(expect.arrayContaining(tokens(USER_TONE_PROMPT)));
  });

  // Invariant: a user item inside a sub-agent panel, like a root one, carries no horizontal margin and no alignment that would shrink it.
  it("a sub-agent's user item, like a root one, takes no margin", async () => {
    const root = await render([
      PROMPT,
      ...tool('m1', 0, 'A', 'Agent', { result: null }),
      { kind: 'user_echo', text: 'child prompt', parentToolUseId: 'A' },
      { kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'A', message: { content: [{ type: 'text', text: 'S1' }] } } as UiEvent,
    ]);
    const users = [...root.querySelectorAll('[data-item="user"]')];
    const nested = users.filter((u) => u.parentElement!.closest('[data-item="assistant"]'));
    const top = users.filter((u) => !u.parentElement!.closest('[data-item="assistant"]'));
    expect(nested, 'fixture check: one user item inside the sub-agent panel').toHaveLength(1);
    expect(top, 'fixture check: one root user item').toHaveLength(1);
    expect(nested[0].closest('[data-item="assistant"]')!.querySelectorAll(':scope > [data-assistant-avatar]'), 'fixture check: the enclosing root bubble has its avatar').toHaveLength(1);
    expect(marginX(nested[0])).toEqual([]);
    expect(alignClasses(nested[0])).toEqual([]);
  });
});
