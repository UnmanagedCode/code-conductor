// Hook context in the rendered transcript: a fold, collapsed by default, under
// its prompt or inside its tool card (whose header then shows a marker), or on
// a row of its own while its card is not rendered.
import { describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { ConversationModel } from './model';
import type { UiEvent, UiEventOf } from '@shared/uiEvent';
import { feed, tool } from './testkit';
import { flush, renderModel } from './renderModel';

const RECALL = 'recalled **note** body';
const promptContext = (text: string): UiEventOf<'hook_context'> =>
  ({ kind: 'hook_context', hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text });
const toolContext = (toolUseId: string, text: string): UiEventOf<'hook_context'> =>
  ({ kind: 'hook_context', hookEvent: 'PreToolUse', toolUseId, toolName: 'Bash', text });

async function shown(events: UiEvent[]) {
  const m = new ConversationModel();
  feed(m, events);
  const r = renderModel(m);
  await flush();
  return { m, root: r.root };
}

const folds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-hook-context]')];
const foldTrigger = (fold: HTMLElement) => within(fold).getByRole('button', { name: /Hook context/ });

describe('hook context fold', () => {
  it('is collapsed by default; expanding shows the verbatim text', async () => {
    const { root } = await shown([{ kind: 'user_echo', text: 'hello' }, promptContext(RECALL)]);
    const [fold] = folds(root);
    expect(fold.getAttribute('data-hook-event')).toBe('UserPromptSubmit');
    const trigger = foldTrigger(fold);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).not.toContain('recalled');
    fireEvent.click(trigger);
    await flush();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(fold).getByRole('button', { name: 'Show raw text' }));
    await flush();
    expect(within(fold).getByText(RECALL)).toBeTruthy();
  });

  it('the user bubble renders its prompt\'s fold', async () => {
    const { root } = await shown([{ kind: 'user_echo', text: 'hello' }, promptContext(RECALL)]);
    const bubble = root.querySelector<HTMLElement>('[data-item="user"]')!;
    expect(folds(bubble)).toHaveLength(1);
    expect(folds(root)).toHaveLength(1);
  });

  it('the tool card shows the marker iff it holds contexts, and its body holds the fold', async () => {
    const { root } = await shown([
      ...tool('m1', 0, 'tuPlain', 'Bash', { result: null }),
      ...tool('m1', 1, 'tuHooked', 'Bash', { result: null }),
      toolContext('tuHooked', 'nudge text'),
    ]);
    const group = within(root).getByRole('button', { name: /actions?/ });
    if (group.getAttribute('data-state') === 'closed') fireEvent.click(group);
    await flush();
    const [plain, hooked] = [...root.querySelectorAll<HTMLElement>('[data-tool-trigger]')];
    expect(within(plain).queryByRole('img', { name: 'Hook added context' })).toBeNull();
    expect(within(hooked).getByRole('img', { name: 'Hook added context' })).toBeTruthy();
    expect(folds(root)).toHaveLength(0);
    fireEvent.click(hooked);
    await flush();
    const [fold] = folds(root);
    expect(fold.getAttribute('data-hook-event')).toBe('PreToolUse');
    expect(foldTrigger(fold).getAttribute('aria-expanded')).toBe('false');
  });

  // INVARIANT: the marker and the fold sit on the card the context names, here the earlier of two.
  it('a context naming the earlier card marks and fills that card only', async () => {
    const { root } = await shown([
      ...tool('m1', 0, 'tuEarly', 'Bash', { result: null }),
      ...tool('m1', 1, 'tuLate', 'Bash', { result: null }),
      toolContext('tuEarly', 'early nudge'),
    ]);
    const group = within(root).getByRole('button', { name: /actions?/ });
    if (group.getAttribute('data-state') === 'closed') fireEvent.click(group);
    await flush();
    const [early, late] = [...root.querySelectorAll<HTMLElement>('[data-tool-trigger]')];
    expect(within(early).getByRole('img', { name: 'Hook added context' })).toBeTruthy();
    expect(within(late).queryByRole('img', { name: 'Hook added context' })).toBeNull();
    fireEvent.click(early);
    fireEvent.click(late);
    await flush();
    const cardOf = (trigger: HTMLElement) => trigger.parentElement!;
    expect(folds(cardOf(early))).toHaveLength(1);
    expect(folds(cardOf(late))).toHaveLength(0);
    expect(folds(root)).toHaveLength(1);
  });

  it('a loose context renders its own row, naming its tool', async () => {
    const { root } = await shown([toolContext('tuMissing', 'early')]);
    const [fold] = folds(root);
    expect(foldTrigger(fold).textContent).toContain('Bash');
  });

  it('the fold\'s open state lives on its node and survives a remount', async () => {
    const m = new ConversationModel();
    feed(m, [{ kind: 'user_echo', text: 'hello' }, promptContext(RECALL)]);
    const first = renderModel(m);
    await flush();
    fireEvent.click(foldTrigger(folds(first.root)[0]));
    await flush();
    first.unmount();
    const second = renderModel(m);
    await flush();
    expect(foldTrigger(folds(second.root)[0]).getAttribute('aria-expanded')).toBe('true');
  });
});
