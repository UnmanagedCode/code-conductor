// Every user-authored item starts one avatar gutter right of where assistant text starts and fills to the
// column's right edge, with a tint and a right-edge strip as its side cue. The geometry itself is
// web/e2e/user-bubble-inset.shared.ts (happy-dom reads 0); these pin the classes it rests on.
import { describe, expect, it } from 'vitest';
import { buildWakeStub } from '@shared/wakeCallback';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel } from './model';
import { USER_BUBBLE, USER_INSET, USER_INSET_SUB, USER_TONE_PROMPT } from './items';
import { flush, renderModel } from './renderModel';
import { FRUIT, show, stamped } from './questionTestkit';
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

describe('user item inset', () => {
  // Invariant: every user-authored item (prompt, wake stub, attachment prompt, queued ghost) carries exactly USER_INSET as its horizontal margin, and no item, direct child or bubble is width-capped or pushed right; the folds wrapper also lets its fold cards span it.
  it('every user-authored item carries the one inset, and none is capped or pushed right', async () => {
    const root = await render([PROMPT, WAKE, ATTACHED, QUEUED]);
    const items = [...root.querySelectorAll('[data-item="user"], [data-item="queued"]')];
    expect(items.map((el) => (el as HTMLElement).dataset.item), 'fixture check: three user items and a ghost').toEqual(['user', 'user', 'user', 'queued']);
    expect(root.querySelector('[data-item="user"][data-variant="wake"] [data-fold="wake"]'), 'fixture check: the wake stub folds').not.toBeNull();
    const folds = root.querySelector('[data-item="user"][data-variant="wake"] [data-user-folds]');
    expect(folds, "the wake stub's folds wrapper").not.toBeNull();
    expect(alignClasses(folds!), `folds wrapper: ${folds!.className}`).toEqual([]);
    for (const item of items) {
      expect(marginX(item).length, `${item.getAttribute('data-item')} item has a horizontal inset`).toBeGreaterThan(0);
      expect(marginX(item)).toEqual(tokens(USER_INSET));
      expect(alignClasses(item), `${item.getAttribute('data-item')}: ${item.className}`).toEqual([]);
      for (const el of item.children) expect(selfAlignClasses(el), `${item.getAttribute('data-item')} child: ${el.className}`).toEqual([]);
    }
    for (const el of root.querySelectorAll('[data-user-text], [data-item="queued"] > div')) expect(selfAlignClasses(el), el.className).toEqual([]);
  });

  // Invariant: the attachments row and the action row carry the bubble's own horizontal padding, so their contents start at its text.
  it('the attachments row and the action row start at the bubble\'s text', async () => {
    const root = await render([ATTACHED]);
    const text = root.querySelector('[data-user-text]')!;
    const attachments = root.querySelector('[data-user-attachments]');
    const actions = root.querySelector('[data-user-actions]');
    expect(attachments, 'the attachments row').not.toBeNull();
    expect(actions, 'the action row').not.toBeNull();
    expect(padX(text).length).toBeGreaterThan(0);
    expect(padX(attachments!)).toEqual(padX(text));
    expect(padX(actions!)).toEqual(padX(text));
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

  // Invariant: a user item inside a sub-agent panel, whose bubbles have no avatar, carries USER_INSET_SUB (one gutter from that panel's text), and a root item keeps USER_INSET.
  it("a sub-agent's user item takes the nested inset, a root item the root one", async () => {
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
    expect(marginX(nested[0]), "the nested item's inset differs from the root one").not.toEqual(marginX(top[0]));
    expect(marginX(nested[0])).toEqual(tokens(USER_INSET_SUB));
    expect(marginX(top[0])).toEqual(tokens(USER_INSET));
    expect(alignClasses(nested[0])).toEqual([]);
  });
});
