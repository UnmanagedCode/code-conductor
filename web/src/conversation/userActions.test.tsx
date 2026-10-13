// The prompt bubbles' Rewind and Fork as ConversationView renders them from the
// active instance's status: the status map, applied to bubbles rendered before
// and after a change, re-enabled per action, absent on a retired segment,
// carried by a status frame, and on lazily paged bubbles.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance, UiEvent } from '@/state/types';
import { ConversationView } from './ConversationView';
import { userActionsForStatus } from './model';
import { flush } from './renderModel';

/** [Rewind disabled, Fork disabled] of one bubble; null where the button is absent. */
type Split = [boolean | null, boolean | null];
/** What each status renders on a current-segment bubble. */
const SPLIT: Record<string, Split> = {
  idle: [false, false],
  turn: [true, false],
  spawning: [true, true],
  exited: [true, true],
  crashed: [true, true],
};
const NONE: Split = [null, null];

const inst = (id: string, status: string): Instance => ({ id, project: 'p', status, sessionId: `s-${id}`, mode: 'default' });
const echo = (text: string, userIndex: number): UiEvent => ({ kind: 'user_echo', text, userIndex });

const mount = () => render(<TooltipProvider><ConversationView /></TooltipProvider>);
/** Each prompt bubble's split, in order. */
const splits = (root: HTMLElement): Split[] => [...root.querySelectorAll<HTMLElement>('[data-item="user"]')].map((b) => {
  const rewind = b.querySelector('button[aria-label="Rewind to before this message"]') as HTMLButtonElement | null;
  const fork = b.querySelector('button[aria-label="Fork a new session from here"]') as HTMLButtonElement | null;
  return [rewind ? rewind.disabled : null, fork ? fork.disabled : null];
});
/** Makes `i1` the active instance, in `status`. */
const setActive = (status: string) => act(() => { appStore.set({ instances: [inst('i1', status)], activeId: 'i1' }); });
async function apply(ev: UiEvent) {
  act(() => { conversation.apply(ev); });
  await flush();
}

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
});

describe('userActionsForStatus', () => {
  // Rewind is offered only while idle, fork while idle or mid-turn, neither otherwise.
  it('rewind needs idle; fork takes idle or turn; spawning, exited and crashed take neither', () => {
    expect(userActionsForStatus('idle')).toEqual({ rewind: true, fork: true });
    expect(userActionsForStatus('turn')).toEqual({ rewind: false, fork: true });
    expect(userActionsForStatus('spawning')).toEqual({ rewind: false, fork: false });
    expect(userActionsForStatus('exited')).toEqual({ rewind: false, fork: false });
    expect(userActionsForStatus('crashed')).toEqual({ rewind: false, fork: false });
  });

  // With no active instance both actions are off, even if an idle instance exists.
  it('no instance takes neither, and the view renders both disabled while no instance is active', async () => {
    expect(userActionsForStatus(undefined)).toEqual({ rewind: false, fork: false });
    expect(userActionsForStatus(null)).toEqual({ rewind: false, fork: false });
    act(() => { appStore.set({ instances: [inst('i1', 'idle')], activeId: null }); });
    const { container } = mount();
    await apply(echo('orphan', 0));
    expect(splits(container)).toEqual([[true, true]]);
    setActive('idle');
    expect(splits(container), 'fixture check: the same instance, once active, enables both').toEqual([[false, false]]);
  });
});

describe('bubble actions follow the active instance', () => {
  // One status split applies to every bubble, rendered before or after the change.
  it('each action is applied separately, to a bubble rendered before a status change and to one rendered after it, for every status', async () => {
    for (const status of Object.keys(SPLIT)) {
      const from = status === 'idle' ? 'crashed' : 'idle';
      setActive(from);
      const r = mount();
      await apply(echo(`before ${status}`, 0));
      expect(splits(r.container), `${status}: precondition under ${from}`).toEqual([SPLIT[from]]);
      setActive(status);
      await apply(echo(`after ${status}`, 1));
      expect(splits(r.container), status).toEqual([SPLIT[status], SPLIT[status]]);
      r.unmount();
      act(() => { conversation.clear(); });
    }
  });

  // Each status change re-enables or disables each action independently, on the same node.
  it('a status change re-enables what the previous one disabled, per action, on the same bubble', async () => {
    setActive('spawning');
    const { container } = mount();
    await apply(echo('one', 0));
    const bubble = container.querySelector('[data-item="user"]') as HTMLElement;
    expect(splits(container), 'spawning: both disabled').toEqual([[true, true]]);
    setActive('turn');
    expect(splits(container), 'turn: fork comes back, rewind stays off').toEqual([[true, false]]);
    setActive('idle');
    expect(splits(container), 'idle: rewind comes back too').toEqual([[false, false]]);
    setActive('turn');
    expect(splits(container), 'turn again: rewind goes, fork stays').toEqual([[true, false]]);
    setActive('exited');
    expect(splits(container), 'exited: fork goes too').toEqual([[true, true]]);
    expect(container.querySelector('[data-item="user"]') === bubble).toBe(true);
  });

  // A bubble from a retired segment renders no action buttons; the current segment's keeps the status split.
  it("a bubble from a segment that is no longer current has no actions mid-turn or idle, while the current segment's bubble keeps them", async () => {
    setActive('turn');
    const { container } = mount();
    act(() => { conversation.segmentId = 'A'; conversation.setCurrentSegment('A'); });
    await apply(echo('old segment', 0));
    expect(splits(container), 'precondition: current while A is').toEqual([SPLIT.turn]);
    act(() => { conversation.segmentId = 'B'; conversation.setCurrentSegment('B'); });
    await apply(echo('new segment', 1));
    expect(splits(container)).toEqual([NONE, SPLIT.turn]);
    setActive('idle');
    expect(splits(container)).toEqual([NONE, SPLIT.idle]);
  });

  // A WS status frame drives the bubbles only when it names the active instance.
  it('a status frame for the active instance reaches its bubbles; a frame for another instance does not', async () => {
    act(() => { appStore.set({ instances: [inst('i1', 'idle'), inst('i2', 'idle')], activeId: 'i1' }); });
    startController();
    const { container } = mount();
    await apply(echo('rendered', 0));
    expect(splits(container)).toEqual([SPLIT.idle]);
    const frame = (id: string, status: string) =>
      act(() => { bus.dispatchEvent(new CustomEvent('status', { detail: { id, status, mode: 'default', sessionId: `s-${id}` } })); });
    frame('i1', 'turn');
    expect(splits(container)).toEqual([SPLIT.turn]);
    frame('i2', 'spawning');
    expect(appStore.get().instances.find((i) => i.id === 'i2')?.status, 'fixture check: the other frame landed').toBe('spawning');
    expect(splits(container)).toEqual([SPLIT.turn]);
    frame('i1', 'spawning');
    expect(splits(container)).toEqual([SPLIT.spawning]);
    frame('i1', 'idle');
    expect(splits(container)).toEqual([SPLIT.idle]);
  });

  // Lazily paged bubbles take the live status split at the splice and follow later changes.
  it('a lazy-history page spliced in mid-turn gets fork enabled and rewind disabled, spliced in idle both, and follows a later status change', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(new URL(url, 'http://localhost').pathname);
      const page = { events: [echo('older', 0)], hasMore: false, segment: 'D', pageSegment: 'D', currentSegmentId: 'D', nextBefore: null };
      return { ok: true, status: 200, json: async () => page };
    }));
    /** Mounts the view under `status` and lets the pager's auto-fill splice one page in. */
    async function splice(status: string) {
      setActive(status);
      const r = mount();
      const scroll = r.container.querySelector('[data-conversation]') as HTMLElement;
      // happy-dom lays nothing out; auto-fill pages in only while the view is taller than its content.
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 800 });
      Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 0 });
      act(() => { lazyHistory.init({ tailStartSeq: 900 }); });
      await act(async () => {
        for (let i = 0; i < 50 && !scroll.querySelector('[data-item="user"]'); i++) await new Promise((res) => setTimeout(res, 5));
      });
      return r;
    }
    const turn = await splice('turn');
    expect(paths, 'fixture check: the bubble came on a lineage page').toContain('/api/instances/i1/lineage-events');
    expect(splits(turn.container)).toEqual([SPLIT.turn]);
    setActive('idle');
    expect(splits(turn.container), 'the paged bubble follows the later status').toEqual([SPLIT.idle]);
    turn.unmount();
    act(() => { conversation.clear(); lazyHistory.reset(); });
    paths.length = 0;
    const idle = await splice('idle');
    expect(paths, 'fixture check: the bubble came on a lineage page').toContain('/api/instances/i1/lineage-events');
    expect(splits(idle.container)).toEqual([SPLIT.idle]);
  });
});
