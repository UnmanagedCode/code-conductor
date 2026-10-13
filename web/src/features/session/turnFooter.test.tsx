import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));
vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => null }));
vi.mock('@/features/composer/Composer', () => ({ Composer: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { getTaskTracker } from '@/app/trackers';
import type { Instance } from '@/state/types';
import { SessionView } from './SessionView';

const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, project: `proj-${id}`, status: 'idle', displayStatus: 'idle', sessionId: `sess-${id}`, mode: 'bypassPermissions', ...extra,
});
function seed(instances: Instance[], activeId: string | null) {
  appStore.set({
    connection: 'open', everDropped: false, activeId, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances,
  });
}
const view = () => render(<TooltipProvider><SessionView /></TooltipProvider>);
const indicator = () => document.querySelector('[data-turn-indicator]') as HTMLElement | null;
const panel = () => document.querySelector('[data-task-panel]') as HTMLElement | null;

afterEach(() => vi.useRealTimers());

describe('turn footer', () => {
  it('is absent with no session and shows the working row only while a turn runs', () => {
    // Invariant: [data-turn-indicator=working] exists only for status turn; idle, spawning and crashed never show it.
    seed([], null);
    const r = view();
    expect(indicator()).toBeNull();
    r.unmount();
    for (const [status, working] of [['turn', true], ['idle', false], ['spawning', false], ['crashed', false]] as const) {
      seed([inst('T', { status, displayStatus: status })], 'T');
      const rr = view();
      expect(indicator()?.getAttribute('data-turn-indicator') === 'working', status).toBe(working);
      rr.unmount();
    }
  });
});

describe('last-response age', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-04T10:00:00Z')); });

  it('re-ticks every 15 seconds and grows with time', () => {
    // Invariant: the idle footer re-renders on a 15s interval, so the age text moves from seconds to minutes without any store change.
    const at = Date.now() - 50_000;
    seed([inst('A', { lastResponseAt: at })], 'A');
    view();
    const first = indicator()!.textContent;
    expect(indicator()!.getAttribute('data-turn-indicator')).toBe('idle');
    expect(first).toMatch(/50s/);
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(indicator()!.textContent).toBe(first); // no tick yet: rendered text unchanged
    act(() => { vi.advanceTimersByTime(1_000); }); // 15s tick; age is now 65s
    expect(indicator()!.textContent).toMatch(/1m/);
    expect(indicator()!.textContent).not.toBe(first);
  });

  it('control: no footer without a last response time', () => {
    // Invariant: the age line is content-driven by lastResponseAt.
    seed([inst('A')], 'A');
    view();
    expect(indicator()).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(indicator()).toBeNull();
  });
});

describe('task panel', () => {
  const create = (id: string, tu: string, subject: string, n: string) => {
    const t = getTaskTracker(id);
    t.apply({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, name: 'TaskCreate', toolUseId: tu, input: { subject } });
    t.apply({ kind: 'tool_result', toolUseId: tu, content: `Task #${n} created successfully: ${subject}`, isError: false, finishedAt: 0 });
  };
  const complete = (id: string, taskId: string) => getTaskTracker(id).apply({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, name: 'TaskUpdate', toolUseId: `u${taskId}`, input: { taskId, status: 'completed' } });

  it('batches rows, keeps done rows, hides when all are done and restarts after a finished batch', () => {
    // Invariant: the panel shows every task of an open batch (done ones kept), disappears once all are done, and a new TaskCreate starts a fresh batch holding only the new row.
    seed([inst('K')], 'K');
    view();
    expect(panel()).toBeNull();
    act(() => { create('K', 'c1', 'Alpha job', '1'); create('K', 'c2', 'Beta job', '2'); complete('K', '1'); });
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Alpha job');
    expect(panel()!.textContent).toContain('Beta job');
    expect(panel()!.textContent).toContain('1/2');
    act(() => { complete('K', '2'); });
    expect(panel()).toBeNull();
    act(() => { create('K', 'c3', 'Gamma job', '3'); });
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Gamma job');
    expect(panel()!.textContent).not.toContain('Alpha job');
    expect(panel()!.textContent).not.toContain('Beta job');
  });
});
