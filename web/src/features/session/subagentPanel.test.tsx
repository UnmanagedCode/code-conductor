import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const selectInstance = vi.fn();
vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));
vi.mock('@/app/controller', async (orig) => ({ ...(await orig<typeof import('@/app/controller')>()), selectInstance: (...a: unknown[]) => selectInstance(...a) }));

import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { SubagentPanel } from './SessionPanels';

const CONDUCTOR = 'cond-41';
const conductor = { id: CONDUCTOR, project: 'demo', status: 'idle', displayStatus: 'idle' } as Instance;
const worker = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id, project: 'demo', status: 'idle', displayStatus: 'idle', callerInstanceId: CONDUCTOR, title: `job ${id}`, ...extra,
} as Instance);

function mount(workers: Instance[]) {
  act(() => appStore.set({ instances: [conductor, ...workers] }));
  return render(<SubagentPanel inst={conductor} />);
}
const row = (name: string | RegExp) => screen.getByRole('button', { name });

afterEach(() => {
  selectInstance.mockReset();
  act(() => appStore.set({ instances: [] }));
});

describe('workers panel', () => {
  it('a worker bound to a playbook stage shows both names; an unbound one, or one with only a playbook, shows no label', () => {
    // Invariant: the playbook/stage label appears only when both are set, and carries those values.
    mount([
      worker('w-bound', { playbook: 'gatelab', stage: 'draft' }),
      worker('w-free'),
      worker('w-half', { playbook: 'solo-pb', stage: null }),
    ]);
    expect(row(/job w-bound/).textContent).toContain('gatelab');
    expect(row(/job w-bound/).textContent).toContain('draft');
    expect(row(/job w-free/).querySelector('[title^="playbook"]')).toBeNull();
    expect(row(/job w-half/).querySelector('[title^="playbook"]')).toBeNull();
    expect(row(/job w-half/).textContent).not.toContain('solo-pb');
  });

  it('a stage change updates the label in place with no duplicate', () => {
    // Invariant: the row shows the current stage only, one label per worker.
    const r = mount([worker('w1', { playbook: 'gatelab', stage: 'draft' })]);
    act(() => appStore.set({ instances: [conductor, worker('w1', { playbook: 'gatelab', stage: 'build' })] }));
    r.rerender(<SubagentPanel inst={conductor} />);
    const b = row(/job w1/);
    expect(b.querySelectorAll('[title^="playbook"]')).toHaveLength(1);
    expect(b.textContent).toContain('build');
    expect(b.textContent).not.toContain('draft');
  });

  it('tapping a worker row or its playbook label selects that worker with a pushed user gesture', () => {
    // Invariant: a tap navigates to that worker (and only it), as a user gesture that pushes history.
    mount([worker('w-a', { playbook: 'gatelab', stage: 'draft' }), worker('w-b')]);
    fireEvent.click(row(/job w-b/));
    expect(selectInstance).toHaveBeenLastCalledWith('w-b', { push: true, userGesture: true });
    fireEvent.click(row(/job w-a/).querySelector('[title^="playbook"]')!);
    expect(selectInstance).toHaveBeenLastCalledWith('w-a', { push: true, userGesture: true });
    expect(selectInstance).toHaveBeenCalledTimes(2);
  });

  it('only workers of this conductor are listed', () => {
    // Invariant: control: the strip lists the conductor's own workers.
    mount([worker('w-mine'), worker('w-other', { callerInstanceId: 'cond-other' })]);
    expect(screen.queryByRole('button', { name: /job w-mine/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /job w-other/ })).toBeNull();
    expect(within(document.body).getByText('1')).toBeTruthy();
  });

  it('an idle worker waiting on a worker or a job is marked, with different hints; plain idle and running rows are unmarked', () => {
    // Invariant: only an idle worker that is awaiting a wake or on a job is marked (hint on the row, distinct for worker vs job); a running worker with a job stays plain.
    mount([
      worker('w-wake', { displayStatus: 'idle', awaitingWake: true }),
      worker('w-jobwait', { displayStatus: 'idle', waitingOnJob: true }),
      worker('w-plain', { displayStatus: 'idle' }),
      worker('w-turn', { displayStatus: 'turn', awaitingWake: true }),
      worker('w-runjob', { displayStatus: 'running', waitingOnJob: true }),
    ]);
    const hint = (n: RegExp) => row(n).getAttribute('title');
    expect(hint(/job w-wake/)).toBeTruthy();
    expect(hint(/job w-jobwait/)).toBeTruthy();
    expect(hint(/job w-wake/)).not.toBe(hint(/job w-jobwait/));
    expect(hint(/job w-plain/)).toBeNull();
    expect(hint(/job w-turn/)).toBeNull();
    expect(hint(/job w-runjob/)).toBeNull();
  });
});
