import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const selectInstance = vi.fn();
const openEndedSession = vi.fn();
vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));
vi.mock('@/app/controller', async (orig) => ({
  ...(await orig<typeof import('@/app/controller')>()),
  selectInstance: (...a: unknown[]) => selectInstance(...a),
  openEndedSession: (...a: unknown[]) => openEndedSession(...a),
}));

import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { routeFetch, type RouteAnswer } from '@/test/routeFetch';
import { settle } from '@/test/settle';
import { SubagentPanel } from './SessionPanels';
import { setShowEndedWorkers } from './endedWorkers';

const conductor = { id: 'cond', sessionId: 'sid-cond', project: 'demo', status: 'idle', displayStatus: 'idle' } as Instance;
const live = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, sessionId: `sid-${id}`, project: 'demo', status: 'idle', displayStatus: 'idle', callerInstanceId: 'cond', title: `job ${id}`, ...extra,
} as Instance);
const spawned = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: `sid-${id}`, project: 'demo', worktreeName: null, title: `job ${id}`, firstPrompt: null, conducted: true, persistent: false,
  archived: false, turnEndSeq: 0, viewedSeq: 0, lastActivity: 1, size: 1, resumeMode: 'cold', awaitingUser: null, awaitingUserSource: null,
  ...extra,
});
const ROUTE = 'GET /api/sessions/sid-cond/workers';
const answer = (rows: unknown[]) => ({ [ROUTE]: () => ({ json: { workers: rows } }) });
const mount = (workers: Instance[], inst: Instance = conductor) => {
  act(() => appStore.set({ instances: [conductor, ...workers] }));
  return render(<SubagentPanel inst={inst} />);
};
const toggle = () => screen.findByRole('switch', { name: 'Show ended workers' });
const names = () => screen.getAllByRole('button').filter((b) => b.closest('li')).map((b) => b.textContent ?? '');

beforeEach(() => { localStorage.clear(); setShowEndedWorkers(false); });
afterEach(() => {
  selectInstance.mockReset();
  openEndedSession.mockReset();
  vi.restoreAllMocks();
  act(() => appStore.set({ instances: [] }));
});

describe('workers panel: ended workers', () => {
  it('no workers, live or ended, shows no panel', async () => {
    // Invariant: the panel is hidden when the session has no workers at all.
    const calls = routeFetch(answer([]));
    mount([]);
    await settle();
    expect(calls.filter((c) => c.url.endsWith('/workers'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Workers/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('only ended workers: the panel shows, the toggle is off, "No live workers" reads, and no ended row shows', async () => {
    // Invariant: the panel is visible with only ended workers; the toggle defaults off and hides them.
    routeFetch(answer([spawned('e1', { archived: true }), spawned('e2')]));
    mount([]);
    expect((await toggle()).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('No live workers')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /job e1/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /job e2/ })).toBeNull();
  });

  it('the toggle lists ended workers after the live ones, each marked with its status, and off hides them again', async () => {
    // Invariant: toggle on shows ended rows marked distinctly, in server order after live ones; a worker is never listed live and
    // ended; a session a live instance holds elsewhere is not ended; toggling off hides them.
    routeFetch(answer([
      spawned('w1'), spawned('e1', { archived: true }), spawned('e2'), spawned('e3'), spawned('e4'),
    ]));
    mount([
      live('w1'),
      { id: 'inst-e3', sessionId: 'sid-e3', project: 'demo', status: 'crashed', displayStatus: 'crashed' } as Instance,
      { id: 'inst-e4', sessionId: 'sid-e4', project: 'demo', status: 'idle', displayStatus: 'idle', callerInstanceId: 'other' } as Instance,
    ]);
    fireEvent.click(await toggle());
    await screen.findByRole('button', { name: /job e1/ });
    const rows = names();
    expect(rows.map((n) => n.replace(/(archived|offline|crashed)$/, '')))
      .toEqual(['job w1', 'job e1', 'job e2', 'job e3']);
    expect(rows[0]).not.toMatch(/archived|offline|crashed/);
    expect(rows[1]).toMatch(/archived$/);
    expect(rows[2]).toMatch(/offline$/);
    expect(rows[3]).toMatch(/crashed$/);
    expect(screen.queryByRole('button', { name: /job e4/ })).toBeNull();
    fireEvent.click(await toggle());
    await settle();
    expect(screen.queryByRole('button', { name: /job e1/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /job e3/ })).toBeNull();
  });

  it('the toggle choice survives a remount', async () => {
    // Invariant: the preference persists across mounts of the panel.
    routeFetch(answer([spawned('e1')]));
    const first = mount([]);
    fireEvent.click(await toggle());
    await screen.findByRole('button', { name: /job e1/ });
    first.unmount();
    mount([]);
    expect((await toggle()).getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByRole('button', { name: /job e1/ })).toBeTruthy();
  });

  it('tapping an ended worker opens it read-only with a history push; a retained dead worker is selected', async () => {
    // Invariant: an ended row with no instance opens via openEndedSession({ push: true }); one a dead instance holds selects that instance.
    routeFetch(answer([spawned('e1', { worktreeName: 'wt-a' }), spawned('e3')]));
    mount([{ id: 'inst-e3', sessionId: 'sid-e3', project: 'demo', status: 'exited', displayStatus: 'exited' } as Instance]);
    fireEvent.click(await toggle());
    fireEvent.click(await screen.findByRole('button', { name: /job e1/ }));
    expect(openEndedSession).toHaveBeenCalledTimes(1);
    expect(openEndedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid-e1', project: 'demo', worktreeName: 'wt-a', push: true }));
    expect(selectInstance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /job e3/ }));
    expect(selectInstance).toHaveBeenCalledTimes(1);
    expect(selectInstance).toHaveBeenCalledWith('inst-e3', { push: true, userGesture: true });
  });

  it('live workers with no ended ones: no toggle, the live list unchanged', async () => {
    // Invariant: a session whose workers are all live shows its live rows and count, and no toggle.
    const calls = routeFetch(answer([spawned('w1')]));
    mount([live('w1')]);
    await settle();
    expect(calls.filter((c) => c.url.endsWith('/workers'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: /job w1/ })).toBeTruthy();
    const header = screen.getByRole('button', { name: /^Workers/ });
    expect(within(header).getByText('1')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a worker leaving the live list re-reads the ended list', async () => {
    // Invariant: the ended list is re-read when the set of live workers changes.
    let rows: unknown[] = [spawned('w1')];
    const calls = routeFetch({ [ROUTE]: () => ({ json: { workers: rows } }) });
    const r = mount([live('w1')]);
    await settle();
    expect(calls.filter((c) => c.url.endsWith('/workers'))).toHaveLength(1);
    expect(screen.queryByRole('switch')).toBeNull();
    rows = [spawned('w1', { archived: true })];
    act(() => appStore.set({ instances: [conductor] }));
    r.rerender(<SubagentPanel inst={conductor} />);
    await toggle();
    expect(calls.filter((c) => c.url.endsWith('/workers'))).toHaveLength(2);
    expect(screen.getByText('1 ended')).toBeTruthy();
  });

  it('a failed read warns once and shows no panel', async () => {
    // Invariant: a failed read is logged, not swallowed, and shows nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    routeFetch({ [ROUTE]: (): RouteAnswer => new Error('down') });
    mount([]);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('workers panel: ended-workers read failed:');
    expect(screen.queryByRole('button', { name: /^Workers/ })).toBeNull();
  });

  it("an ended conductor's pane lists its ended workers", async () => {
    // Invariant: the panel serves the Ended pane too, keyed by the session the pane shows.
    routeFetch({ 'GET /api/sessions/sid-x/workers': () => ({ json: { workers: [spawned('e1')] } }) });
    const ended = { id: 'ended:sid-x', sessionId: 'sid-x', project: 'demo', status: 'exited', displayStatus: 'exited', ended: { source: 'session', worktreeName: null } } as Instance;
    mount([], ended);
    expect(await toggle()).toBeTruthy();
  });
});
