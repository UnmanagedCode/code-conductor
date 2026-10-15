// Every helper icon on a transcript item (raw toggle, copy, rewind, fork) sits in a right-aligned action row, so
// each kind's icons share one side. Read-aloud is placed by speakSlot.ts and is not a helper-icon row. The
// geometry is web/e2e (happy-dom reads 0); these pin the row and classes it rests on.
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationModel } from './model';
import { flush, noActions, renderModel } from './renderModel';
import { CARD, FRUIT, show, stamped } from './questionTestkit';
import { text, turnEnd } from './testkit';
import { classesOf } from './userBubbleTestkit';

const HELPER = ['Show raw text', 'Show rendered markdown', 'Copy message', 'Copy text', 'Rewind to before this message', 'Fork a new session from here'];
const REWIND = 'Rewind to before this message';
const FORK = 'Fork a new session from here';

const PROMPT: UiEvent = { kind: 'user_echo', text: 'a prompt', userIndex: 0 };
const SKILL: UiEvent = { kind: 'user_echo', text: 'skill body', userIndex: 7, skillLoad: { skill: 'k' } } as UiEvent;
const ANSWER = [CARD([FRUIT]), stamped([FRUIT], [{ kind: 'option', label: 'Apple' }])];

/** Justify utilities, with any variant prefix. */
const justify = (el: Element) => classesOf(el).filter((c) => /^(?:[\w-]+:)*justify-/.test(c));

async function render(events: UiEvent[]) {
  const m = new ConversationModel();
  for (const ev of events) m.apply(ev);
  const r = renderModel(m, noActions);
  await flush();
  return r.root;
}

/** Expands every fold in `root`, so each folded body's controls render. */
async function openFolds(root: HTMLElement) {
  for (const trigger of root.querySelectorAll<HTMLElement>('[data-fold-trigger]')) fireEvent.click(trigger);
  await flush();
}

const labelsIn = (el: Element) => [...el.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')!).filter((l) => HELPER.includes(l)).sort();

function expectRightAligned(scope: Element) {
  for (const btn of scope.querySelectorAll('button[aria-label]')) {
    const label = btn.getAttribute('aria-label')!;
    if (!HELPER.includes(label)) continue;
    const row = btn.closest('[data-action-row]');
    expect(row, `${label}: sits in an action row`).not.toBeNull();
    expect(row === btn.parentElement, `${label}: is the action row's own child`).toBe(true);
    expect(justify(row!), `${label}'s row: ${row!.className}`).toEqual(['justify-end']);
  }
}

// One row per kind of transcript item that shows helper icons; `scope` finds the item, `labels` what it must expose there.
const KINDS: { name: string; root: () => Promise<HTMLElement>; scope: string; labels: string[] }[] = [
  { name: 'typed prompt', root: () => render([PROMPT]), scope: '[data-item="user"]', labels: ['Show raw text', 'Copy message', REWIND, FORK] },
  { name: 'question answer', root: async () => (await show(ANSWER)).root, scope: '[data-item="user"]', labels: [REWIND, FORK] },
  { name: 'assistant bubble mid-turn', root: () => render(text('m1', 0, 'hello')), scope: '[data-item="assistant"]', labels: ['Show raw text', 'Copy message'] },
  { name: 'turn-end row', root: () => render([...text('m1', 0, 'hello'), turnEnd()]), scope: '[data-item="turn-end"]', labels: ['Show raw text', 'Copy message'] },
  { name: 'skill fold body', root: async () => { const r = await render([SKILL]); await openFolds(r); return r; }, scope: '[data-fold="skill"]', labels: ['Show raw text', 'Copy text'] },
];

describe('helper-icon rows', () => {
  // Invariant: each kind's raw toggle, copy, rewind and fork buttons are direct children of a row whose only justify utility is justify-end.
  describe.each(KINDS)('$name', ({ root: build, scope, labels }) => {
    it('puts its helper icons in a right-aligned action row', async () => {
      const root = await build();
      const item = root.querySelector(scope);
      expect(item, `fixture check: ${scope}`).not.toBeNull();
      expect(labelsIn(item!), 'fixture check: the helper icons it exposes').toEqual([...labels].sort());
      expectRightAligned(item!);
    });
  });

  // Invariant: in a transcript holding every kind, every action row is right-aligned and no helper icon sits outside one.
  it('leaves no helper icon outside a right-aligned action row', async () => {
    const root = await render([PROMPT, SKILL, ...ANSWER, ...text('m1', 0, 'hello'), turnEnd(), ...text('m2', 0, 'still going')]);
    await openFolds(root);
    for (const kind of ['user', 'question', 'assistant', 'turn-end']) {
      expect(root.querySelector(`[data-item="${kind}"]`), `fixture check: a ${kind} item`).not.toBeNull();
    }
    expect(root.querySelector('[data-fold="skill"] [aria-label="Copy text"]'), 'fixture check: the opened skill body').not.toBeNull();
    const rows = [...root.querySelectorAll('[data-action-row]')];
    expect(rows.length, 'fixture check: the action rows').toBeGreaterThan(0);
    for (const row of rows) expect(justify(row), row.className).toEqual(['justify-end']);
    expectRightAligned(root);
  });
});
