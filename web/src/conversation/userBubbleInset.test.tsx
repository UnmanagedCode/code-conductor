// Every user-authored item starts one avatar gutter right of where assistant text starts and fills to the
// column's right edge, with a tint and a right-edge strip as its side cue. The geometry itself is
// web/e2e/user-bubble-inset.shared.ts (happy-dom reads 0); these pin the classes it rests on.
import { describe, expect, it } from 'vitest';
import { buildWakeStub } from '@shared/wakeCallback';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel } from './model';
import { USER_BUBBLE, USER_INSET, USER_TONE_PROMPT } from './items';
import { flush, renderModel } from './renderModel';
import { FRUIT, show, stamped } from './questionTestkit';

const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);
// The constants' classes; `?? ''` lets a build without them fail at an assertion rather than a TypeError.
const tokens = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean).sort();
// Horizontal margin utilities, with any variant prefix: m-, mx-, ml-, mr-, ms-, me-.
const marginX = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*m[lrsex]?-/.test(c)).sort();
// Anything that caps a user item's width or pushes it to the right.
const alignClasses = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*(?:max-w-|ml-auto$|items-end$|justify-end$|self-end$)/.test(c));
const padX = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*p[xlrse]?-/.test(c)).sort();

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
  // Invariant: every user-authored item (prompt, wake stub, attachment prompt, queued ghost) carries exactly USER_INSET as its horizontal margin, and no item, direct child or bubble is width-capped or pushed right.
  it('every user-authored item carries the one inset, and none is capped or pushed right', async () => {
    const root = await render([PROMPT, WAKE, ATTACHED, QUEUED]);
    const items = [...root.querySelectorAll('[data-item="user"], [data-item="queued"]')];
    expect(items.map((el) => (el as HTMLElement).dataset.item), 'fixture check: three user items and a ghost').toEqual(['user', 'user', 'user', 'queued']);
    expect(root.querySelector('[data-item="user"][data-variant="wake"] [data-fold="wake"]'), 'fixture check: the wake stub folds').not.toBeNull();
    for (const item of items) {
      expect(marginX(item).length, `${item.getAttribute('data-item')} item has a horizontal inset`).toBeGreaterThan(0);
      expect(marginX(item)).toEqual(tokens(USER_INSET));
      for (const el of [item, ...item.children]) expect(alignClasses(el), `${item.getAttribute('data-item')}: ${el.className}`).toEqual([]);
    }
    for (const el of root.querySelectorAll('[data-user-text], [data-item="queued"] > div')) expect(alignClasses(el), el.className).toEqual([]);
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
});
