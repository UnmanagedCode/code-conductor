// Messages queued while the account's usage window is spent show as ghost bubbles. When
// the window resets and they are delivered, each ghost stays where it was, marked
// delivered, above the window-reset line and the turn that delivered it; a message
// queued after that is a ghost of its own until the next reset.
import { describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import type { UiEvent } from '@/state/types';
import { ConversationModel } from './model';
import { flush, renderModel } from './renderModel';
import { text } from './testkit';

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
      { kind: 'turn_end', subtype: 'success' },
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
});
