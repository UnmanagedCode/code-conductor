// The commit history's Sync, Merge and Lock against a routed network: which
// target each acts on, when the list reloads, the busy lock-out, the lock
// state's sources (the list payload and the lock answer), and every answer that
// lands after the view moved to another worktree.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as actions from '@/app/sessionActions';
import { held, routeFetch, type RouteAnswer, type RoutedCall } from '@/test/routeFetch';
import { CommitsView } from './CommitsView';
import { viewStore } from './api';
import type { CommitsPayload } from './commitsModel';

const sha = (c: string) => c.repeat(40);
/** A one-commit history whose head commit's subject is `subject`, with a working-tree row. */
const payload = (subject: string, over: Partial<CommitsPayload> = {}): CommitsPayload => ({
  branch: 'feature', truncated: false, limit: 100, hasUncommitted: true, aheadCount: 0, aheadOf: null,
  commits: [{ sha: sha('a'), shortSha: 'aaaaaaa', subject, parents: [] }], ...over,
});
const listUrl = (project: string, worktree: string | null) =>
  worktree ? `/api/projects/${project}/worktrees/${worktree}/commits` : `/api/projects/${project}/commits`;

/** What each list URL answers next; a test replaces an entry to change or hold it. */
let lists: Record<string, () => RouteAnswer | Promise<RouteAnswer>>;
let calls: RoutedCall[];
const listCalls = (url: string) => calls.filter((c) => c.method === 'GET' && c.url === url).length;
const answerList = (url: string, body: CommitsPayload) => { lists[url] = () => ({ json: body }); };
/** Holds `url`'s next list answer until the returned function releases it with `body`. */
function holdList(url: string): (body: CommitsPayload) => Promise<void> {
  const h = held<RouteAnswer>();
  lists[url] = () => h.answer;
  return async (body) => {
    answerList(url, body);
    await act(async () => { h.release({ json: body }); });
    await settle();
  };
}

/** An action answer the test holds: `release` settles it with `result`. */
function heldResult() {
  const h = held<unknown>();
  return { promise: h.answer, release: async (result: unknown) => { await act(async () => { h.release(result); }); await settle(); } };
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
async function show(project: string, worktree: string | null) {
  await act(async () => { viewStore.set({ commits: { project, worktree } }); });
  await settle();
}
async function mount(project: string, worktree: string | null) {
  act(() => { viewStore.set({ commits: { project, worktree } }); });
  render(<TooltipProvider><CommitsView /></TooltipProvider>);
  await settle();
}
const action = (name: 'Sync' | 'Merge') => screen.getByRole('button', { name }) as HTMLButtonElement;
const lockControl = () => screen.getByRole('button', { name: /^Lock(ed)?$/ }) as HTMLButtonElement;
async function click(el: HTMLElement) {
  await act(async () => { fireEvent.click(el); });
  await settle();
}
/** Which actions are enabled, and whether Lock shows pressed. */
function controls() {
  return { sync: !action('Sync').disabled, merge: !action('Merge').disabled, lock: !lockControl().disabled, pressed: lockControl().getAttribute('aria-pressed') };
}
const UNLOCKED = { sync: true, merge: true, lock: true, pressed: 'false' };
const LOCKED = { sync: true, merge: false, lock: true, pressed: 'true' };
const BUSY_UNLOCKED = { sync: false, merge: false, lock: false, pressed: 'false' };
const BUSY_LOCKED = { sync: false, merge: false, lock: false, pressed: 'true' };
const UNKNOWN = { sync: true, merge: true, lock: false, pressed: 'false' };

beforeEach(() => {
  lists = {};
  calls = routeFetch({ 'GET /api/projects/': (_body, url) => (lists[url] ?? (() => ({ json: payload('head', { locked: false }) })))() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  viewStore.set({ commits: null, review: null });
});

describe('Sync and Merge', () => {
  it('Sync, Merge and Lock carry their names on the button itself, not only in text a phone hides', async () => {
    const lock = vi.spyOn(actions, 'setWorktreeLock').mockResolvedValueOnce({ ok: true, worktree: 'wt', locked: true });
    await mount('p', 'wt');
    const labels = () => [action('Sync'), action('Merge'), lockControl()].map((b) => b.getAttribute('aria-label'));
    expect(controls(), 'positive control: the three actions, unlocked').toEqual(UNLOCKED);
    expect(labels(), 'unlocked').toEqual(['Sync', 'Merge', 'Lock']);
    await click(lockControl());
    expect(lock).toHaveBeenCalledTimes(1);
    expect(controls(), 'positive control: locked').toEqual(LOCKED);
    expect(labels(), 'locked').toEqual(['Sync', 'Merge', 'Locked']);
  });

  it('a worktree\'s history opens its working tree and each commit on the worktree\'s own diff URLs', async () => {
    await mount('p', 'wt');
    await click(document.querySelector('[data-commit-row="uncommitted"]') as HTMLElement);
    expect(viewStore.get().review?.url, 'the working tree').toBe('/api/projects/p/worktrees/wt/commits/uncommitted/diff');
    expect(location.hash).toBe('#review');
    await click(document.querySelector(`[data-commit-row="${sha('a')}"]`) as HTMLElement);
    expect(viewStore.get().review?.url, 'a commit').toBe(`/api/projects/p/worktrees/wt/commits/${sha('a')}/diff`);
  });

  it('Sync, Merge and Lock go away when the view reopens on the project\'s own tree, and come back for a worktree', async () => {
    await mount('p', 'wt1');
    expect(controls(), 'a worktree\'s history').toEqual(UNLOCKED);
    await show('p', null);
    expect(listCalls(listUrl('p', null)), 'precondition: the project\'s own list loaded').toBe(1);
    for (const name of ['Sync', 'Merge', 'Lock']) expect(screen.queryByRole('button', { name }), `${name} on the project's own tree`).toBeNull();
    await show('p', 'wt2');
    expect(listCalls(listUrl('p', 'wt2'))).toBe(1);
    expect(controls(), 'another worktree\'s history').toEqual(UNLOCKED);
  });

  it('Sync and Merge act on the worktree on screen at click time, following a reopen', async () => {
    const sync = vi.spyOn(actions, 'syncWorktree').mockResolvedValue({ ok: false, reason: 'no' });
    const merge = vi.spyOn(actions, 'mergeWorktree').mockResolvedValue({ ok: false, reason: 'no' });
    await mount('p', 'wt1');
    await click(action('Sync'));
    await click(action('Merge'));
    await show('q', 'wt2');
    await click(action('Sync'));
    await click(action('Merge'));
    expect(sync.mock.calls).toEqual([[{ project: 'p', worktree: 'wt1' }], [{ project: 'q', worktree: 'wt2' }]]);
    expect(merge.mock.calls).toEqual([[{ project: 'p', worktree: 'wt1' }], [{ project: 'q', worktree: 'wt2' }]]);
  });

  it('an ok Sync or Merge reloads the list and shows the new answer; a refusal or a cancel reloads nothing', async () => {
    const url = listUrl('p', 'wt');
    await mount('p', 'wt');
    for (const kind of ['Sync', 'Merge'] as const) {
      const spy = vi.spyOn(actions, kind === 'Sync' ? 'syncWorktree' : 'mergeWorktree');
      for (const [result, reloads] of [[{ ok: true }, true], [{ ok: false, reason: 'refused' }, false], [null, false]] as const) {
        const subject = `after ${kind} ${JSON.stringify(result)}`;
        answerList(url, payload(subject, { locked: false }));
        spy.mockResolvedValueOnce(result);
        const before = { list: listCalls(url), acted: spy.mock.calls.length };
        await click(action(kind));
        expect(spy.mock.calls.length - before.acted, `${subject}: the action ran`).toBe(1);
        expect(listCalls(url) - before.list, `${subject}: reloads`).toBe(reloads ? 1 : 0);
        expect(screen.queryByText(subject) !== null, `${subject}: the new answer shows`).toBe(reloads);
      }
    }
  });

  it('a Sync answer landing after the view moved to another worktree reloads nothing, while the next Sync there does', async () => {
    const late = heldResult();
    const sync = vi.spyOn(actions, 'syncWorktree').mockReturnValueOnce(late.promise);
    await mount('p', 'wt1');
    await click(action('Sync'));
    await show('p', 'wt2');
    const before = { wt1: listCalls(listUrl('p', 'wt1')), wt2: listCalls(listUrl('p', 'wt2')) };
    expect(before, 'precondition: each list loaded once').toEqual({ wt1: 1, wt2: 1 });
    await late.release({ ok: true });
    expect({ wt1: listCalls(listUrl('p', 'wt1')), wt2: listCalls(listUrl('p', 'wt2')) }, 'the late answer reloads neither').toEqual(before);
    sync.mockResolvedValueOnce({ ok: true });
    await click(action('Sync'));
    expect(sync.mock.calls.at(-1), 'control: the current worktree').toEqual([{ project: 'p', worktree: 'wt2' }]);
    expect(listCalls(listUrl('p', 'wt2')), 'control: the current worktree\'s answer reloads it').toBe(2);
  });

  it('every action button is disabled while an action is in flight, a second tap starts nothing, and all come back once it settles', async () => {
    await mount('p', 'wt');
    const cases = [
      ['Sync', vi.spyOn(actions, 'syncWorktree'), { ok: false, reason: 'refused' }],
      ['Merge', vi.spyOn(actions, 'mergeWorktree'), { ok: true }],
      ['Lock', vi.spyOn(actions, 'setWorktreeLock'), null],
    ] as const;
    for (const [name, spy, result] of cases) {
      const h = heldResult();
      spy.mockReturnValueOnce(h.promise);
      const control = () => (name === 'Lock' ? lockControl() : action(name));
      expect(controls(), `${name}: precondition, all enabled`).toEqual(UNLOCKED);
      await click(control());
      expect(controls(), `${name}: in flight`).toEqual(BUSY_UNLOCKED);
      await click(control());
      expect(spy, `${name}: a second tap starts nothing`).toHaveBeenCalledTimes(1);
      await h.release(result);
      expect(controls(), `${name}: settled`).toEqual(UNLOCKED);
    }
  });
});

describe('the lock', () => {
  it('Lock and Merge follow each worktree\'s payload: locked, then unlocked, then locked again', async () => {
    answerList(listUrl('p', 'wt1'), payload('one', { locked: true }));
    answerList(listUrl('p', 'wt2'), payload('two', { locked: false }));
    await mount('p', 'wt1');
    expect(controls(), 'wt1 locked').toEqual(LOCKED);
    expect(screen.getByRole('button', { name: 'Locked' }) === lockControl(), 'the pressed control reads Locked').toBe(true);
    await show('p', 'wt2');
    expect(controls(), 'wt2 unlocked').toEqual(UNLOCKED);
    expect(screen.getByRole('button', { name: 'Lock' }) === lockControl(), 'the unpressed control reads Lock').toBe(true);
    await show('p', 'wt1');
    expect(controls(), 'wt1 locked again').toEqual(LOCKED);
  });

  it('a click asks for the opposite of what Lock shows and shows the server\'s answer, whichever it is, without reloading', async () => {
    const lock = vi.spyOn(actions, 'setWorktreeLock');
    const url = listUrl('p', 'wt');
    answerList(url, payload('head', { locked: true }));
    await mount('p', 'wt');
    expect(controls(), 'precondition: locked').toEqual(LOCKED);
    const steps = [
      [false, { ok: true, worktree: 'wt', locked: false }, UNLOCKED],
      [true, { ok: true, worktree: 'wt', locked: false }, UNLOCKED],
      [true, { ok: true, worktree: 'wt', locked: true }, LOCKED],
      [false, { ok: true, worktree: 'wt', locked: true }, LOCKED],
    ] as const;
    for (const [asked, answer, shows] of steps) {
      lock.mockResolvedValueOnce(answer);
      await click(lockControl());
      expect(lock.mock.calls.at(-1), `asks locked: ${asked}`).toEqual([{ project: 'p', worktree: 'wt' }, asked]);
      expect(controls(), `asked ${asked}, answered ${answer.locked}`).toEqual(shows);
    }
    expect(listCalls(url), 'no lock click reloads the list').toBe(1);
  });

  it('a refused or cancelled lock changes nothing, unlocked or locked, while an ok answer does', async () => {
    const lock = vi.spyOn(actions, 'setWorktreeLock');
    await mount('p', 'wt');
    for (const [result, shows] of [
      [{ ok: false, reason: 'refused' }, UNLOCKED],
      [null, UNLOCKED],
      [{ ok: true, worktree: 'wt', locked: true }, LOCKED],
      [{ ok: false, reason: 'refused' }, LOCKED],
      [null, LOCKED],
    ] as const) {
      lock.mockResolvedValueOnce(result);
      await click(lockControl());
      expect(controls(), JSON.stringify(result)).toEqual(shows);
    }
    expect(lock).toHaveBeenCalledTimes(5);
  });

  it('a Sync on a locked worktree leaves Merge disabled, whether it reloaded or was refused, while an unlocked one\'s Merge comes back', async () => {
    const sync = vi.spyOn(actions, 'syncWorktree');
    answerList(listUrl('p', 'locked'), payload('head', { locked: true }));
    await mount('p', 'locked');
    for (const result of [{ ok: true }, { ok: false, reason: 'refused' }]) {
      const h = heldResult();
      sync.mockReturnValueOnce(h.promise);
      await click(action('Sync'));
      expect(controls(), `${JSON.stringify(result)}: in flight`).toEqual(BUSY_LOCKED);
      await h.release(result);
      expect(controls(), `${JSON.stringify(result)}: settled`).toEqual(LOCKED);
    }
    expect(listCalls(listUrl('p', 'locked')), 'precondition: the ok Sync reloaded').toBe(2);
    await show('p', 'open');
    const h = heldResult();
    sync.mockReturnValueOnce(h.promise);
    await click(action('Sync'));
    expect(controls(), 'control: in flight').toEqual(BUSY_UNLOCKED);
    await h.release({ ok: true });
    expect(controls(), 'control: an unlocked worktree\'s Merge comes back').toEqual(UNLOCKED);
  });

  it('reopening onto another worktree shows its lock as unknown until its own payload lands, then that payload\'s state', async () => {
    answerList(listUrl('p', 'wt1'), payload('one', { locked: true }));
    await mount('p', 'wt1');
    expect(controls(), 'precondition: wt1 locked').toEqual(LOCKED);
    const landWt2 = holdList(listUrl('p', 'wt2'));
    await show('p', 'wt2');
    expect(controls(), 'wt2 unknown: wt1\'s lock does not carry over').toEqual(UNKNOWN);
    await landWt2(payload('two', { locked: false }));
    expect(controls(), 'wt2\'s payload landed').toEqual(UNLOCKED);
    const landWt1 = holdList(listUrl('p', 'wt1'));
    await show('p', 'wt1');
    expect(controls(), 'wt1 unknown again').toEqual(UNKNOWN);
    await landWt1(payload('one', { locked: true }));
    expect(controls(), 'wt1\'s payload landed').toEqual(LOCKED);
  });

  it('a lock answer or a list payload landing after the view moved to another worktree leaves the new one alone, while its own does apply', async () => {
    const lock = vi.spyOn(actions, 'setWorktreeLock');
    const late = heldResult();
    lock.mockReturnValueOnce(late.promise);
    await mount('p', 'wt1');
    await click(lockControl());
    await show('p', 'wt2');
    await late.release({ ok: true, worktree: 'wt1', locked: true });
    expect(controls(), 'a late lock answer').toEqual(UNLOCKED);
    lock.mockResolvedValueOnce({ ok: true, worktree: 'wt2', locked: true });
    await click(lockControl());
    expect(controls(), 'control: wt2\'s own lock answer').toEqual(LOCKED);

    const landWt3 = holdList(listUrl('p', 'wt3'));
    await show('p', 'wt3');
    answerList(listUrl('p', 'wt4'), payload('four', { locked: false }));
    await show('p', 'wt4');
    expect(controls(), 'precondition: wt4\'s payload landed').toEqual(UNLOCKED);
    await landWt3(payload('three', { locked: true }));
    expect(controls(), 'a late list payload').toEqual(UNLOCKED);
    expect(screen.queryByText('three'), 'the late list is not shown').toBeNull();
    expect(screen.getByText('four'), 'control: wt4\'s own list is').toBeTruthy();
  });
});
