// Messages queued while the account's usage window is spent show as ghost bubbles. When
// the window resets and they are delivered, each ghost stays where it was, marked
// delivered, above the window-reset line and the turn that delivered it; a message
// queued after that is a ghost of its own until the next reset.
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import type { UiEvent } from '@shared/uiEvent';
import { composeChipMessage } from '@shared/contextChip';
import { fireEvent } from '@testing-library/react';
import { ConversationModel } from './model';
import { flush, renderModel } from './renderModel';
import { text, turnEnd } from './testkit';

const queued = (body: string, attachmentCount = 0): UiEvent =>
  ({ kind: 'overage_message_queued', data: { text: body, attachmentCount, ts: Date.UTC(2026, 0, 5, 9, 30), queuedCount: 1 } });
const reset = (count: number): UiEvent => ({ kind: 'system', subtype: 'auto_resume', data: { count } });

const ghosts = (root: HTMLElement) => [...root.querySelectorAll('[data-item="queued"]')] as HTMLElement[];
const ghostTexts = (root: HTMLElement) => ghosts(root).map((g) => g.textContent ?? '');
const delivered = (root: HTMLElement) => ghosts(root).map((g) => g.hasAttribute('data-delivered'));
const resetLines = (root: HTMLElement) => root.querySelectorAll('[data-subtype="auto_resume"]');
/** The transcript's root items in order: an item by its kind, a system line by its subtype. */
const order = (root: HTMLElement) => ([...root.children] as HTMLElement[]).map((el) => el.dataset.item ?? el.dataset.subtype ?? '?');

async function live(m: ConversationModel, ev: UiEvent) {
  act(() => { m.apply(ev); });
  await flush();
}

describe('queued ghosts', () => {
  it('the window reset keeps both ghosts in place, each marked delivered, above the reset line and the delivered turn', async () => {
    const m = new ConversationModel();
    m.applyEvents([
      { kind: 'user_echo', text: 'before', userIndex: 0 },
      ...text('m0', 0, 'reply'),
      turnEnd({ subtype: 'success' }),
      queued('QUEUED-ONE'),
      queued('QUEUED-TWO', 1),
    ]);
    const { root } = renderModel(m);
    await flush();
    expect(ghostTexts(root), 'precondition: both queued messages show as ghosts').toEqual([expect.stringContaining('QUEUED-ONE'), expect.stringContaining('QUEUED-TWO')]);
    expect(delivered(root), 'precondition: neither is delivered yet').toEqual([false, false]);

    await live(m, reset(2));
    expect(resetLines(root), 'positive control: the window-reset line rendered').toHaveLength(1);
    expect(ghostTexts(root), 'both ghosts stay on screen with their text').toEqual([expect.stringContaining('QUEUED-ONE'), expect.stringContaining('QUEUED-TWO')]);
    expect(delivered(root)).toEqual([true, true]);

    await live(m, { kind: 'user_echo', text: 'QUEUED-ONE\n\nQUEUED-TWO', userIndex: 1 });
    expect(order(root)).toEqual(['user', 'assistant', 'turn-end', 'queued', 'queued', 'auto_resume', 'user']);
  });

  it('a message queued after the reset is a ghost that is not delivered while the earlier one stays delivered, until the next reset', async () => {
    const m = new ConversationModel();
    m.applyEvents([queued('QUEUED-ONE')]);
    const { root } = renderModel(m);
    await flush();
    expect(delivered(root), 'precondition: one ghost, not delivered').toEqual([false]);

    await live(m, reset(1));
    expect(resetLines(root), 'positive control: the window-reset line rendered').toHaveLength(1);
    expect(delivered(root), 'the delivered ghost stays, marked delivered').toEqual([true]);

    await live(m, queued('QUEUED-THREE'));
    expect(ghostTexts(root)).toEqual([expect.stringContaining('QUEUED-ONE'), expect.stringContaining('QUEUED-THREE')]);
    expect(delivered(root), 'the new ghost is not delivered; the first stays delivered').toEqual([true, false]);

    await live(m, reset(1));
    expect(delivered(root)).toEqual([true, true]);
  });

  it('a skipped auto-resume marks no ghost delivered; a later window reset does', async () => {
    const m = new ConversationModel();
    m.applyEvents([queued('QUEUED-ONE')]);
    const { root } = renderModel(m);
    await flush();
    expect(delivered(root), 'precondition: one ghost, not delivered').toEqual([false]);

    await live(m, { kind: 'system', subtype: 'auto_resume_skipped', data: { reason: 'session no longer running' } });
    expect(root.querySelectorAll('[data-subtype="auto_resume_skipped"]'), 'fixture check: the skip line rendered').toHaveLength(1);
    expect(delivered(root), 'a skipped auto-resume delivers nothing').toEqual([false]);
    expect(ghosts(root)[0].hasAttribute('data-delivered'), 'the ghost carries no delivered mark').toBe(false);

    await live(m, reset(1));
    expect(delivered(root), 'positive control: a later window reset delivers it').toEqual([true]);
  });
});

describe('a queued context-chip send', () => {
  // Invariant: a queued chip send renders like a sent one — the chip row (title, data on expand) plus
  // the typed text — never the raw marker block, even though the queue holds the composed text.
  it('shows the chip row and the typed text, not the raw envelope', async () => {
    const m = new ConversationModel();
    m.applyEvents([queued(composeChipMessage({ title: 'main.ts · 2 lines', data: 'DATA-LINE-1\nDATA-LINE-2' }, 'explain TYPED-WORDS'))]);
    const { root } = renderModel(m);
    await flush();
    const g = ghosts(root)[0];
    expect(g.querySelector('[data-user-context-chip]')!.textContent).toContain('main.ts · 2 lines');
    expect(g.textContent).toContain('explain TYPED-WORDS');
    expect(g.textContent).not.toContain('cc:context-chip');
    expect(g.querySelector('[data-context-chip-data]')).toBeNull();
    fireEvent.click(g.querySelector('[data-fold-trigger]')!);
    await flush();
    expect(g.querySelector('[data-context-chip-data]')!.textContent).toBe('DATA-LINE-1\nDATA-LINE-2');
  });

  it('a chip-only queued send shows the chip row and no empty text line', async () => {
    const m = new ConversationModel();
    m.applyEvents([queued(composeChipMessage({ title: 'only', data: 'd' }, ''))]);
    const { root } = renderModel(m);
    await flush();
    const g = ghosts(root)[0];
    expect(g.querySelector('[data-user-context-chip]')).not.toBeNull();
    expect(g.querySelectorAll('.whitespace-pre-wrap:not([data-context-chip-data])')).toHaveLength(0);
  });
});
