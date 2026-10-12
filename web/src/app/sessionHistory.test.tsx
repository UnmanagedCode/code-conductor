// Session selection and browser history: which selections leave an entry for
// Back, and where Back lands. happy-dom runs history.back() and its popstate
// synchronously, and drops the forward entries on a replaceState after a back
// (a browser keeps them), so Forward is asserted only in
// web/e2e/parity/android-shell.spec.ts.
import '@/test/browserHash';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Instance } from '@/state/types';

vi.mock('@/lib/core/ws.js', () => {
  const bus = new EventTarget();
  return { bus, sent: [], connect: vi.fn(), send: vi.fn() };
});
vi.mock('./sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));

const conductor: Instance = { id: 'C', sessionId: 'sc', project: '.conduct', status: 'idle', mode: 'default' };
const worker: Instance = { id: 'W', sessionId: 'sw', project: 'p', status: 'idle', mode: 'default', callerInstanceId: 'C', title: 'Fix the parser' };
const pinged: Instance = { id: 'B', sessionId: 'sb', project: 'p', status: 'idle', mode: 'default' };

let stopPrevious: (() => void) | null = null;

/** A fresh controller over a mocked socket, with the conductor selected and its workers panel rendered. */
async function boot() {
  stopPrevious?.();
  vi.resetModules();
  history.replaceState(null, '', '/');
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  const { SubagentPanel } = await import('@/features/session/SessionPanels');
  appStore.set({ instances: [conductor, worker, pinged] });
  c.startController();
  stopPrevious = c.stopController;
  c.selectInstance(conductor.id, { userGesture: true });
  render(<SubagentPanel inst={conductor} />);
  const at = () => ({ active: appStore.get().activeId, hash: location.hash });
  const openWorker = () => fireEvent.click(screen.getByRole('button', { name: 'Fix the parser' }));
  return { c, at, openWorker };
}

describe('session selection and the history', () => {
  it('Back from a worker opened from its conductor\'s workers panel selects the conductor again; a worker selected any other way leaves no entry to go back to', async () => {
    // Invariant: only the workers panel pushes the worker's anchor; popstate selects the live session the popped anchor names.
    const { c, at, openWorker } = await boot();
    expect(at()).toEqual({ active: 'C', hash: '#session=sc' });
    const entries = history.length;
    openWorker();
    expect(at()).toEqual({ active: 'W', hash: '#session=sw' });
    expect(history.length).toBe(entries + 1);
    history.back();
    expect(at()).toEqual({ active: 'C', hash: '#session=sc' });

    // Selected as the sidebar does, the worker replaces the conductor's entry, so Back has nothing to return to.
    const before = history.length;
    c.selectInstance(worker.id, { userGesture: true });
    expect(at()).toEqual({ active: 'W', hash: '#session=sw' });
    expect(history.length).toBe(before);
    history.back();
    expect(at()).toEqual({ active: 'W', hash: '#session=sw' });
  });

  it('a notification click selects its instance in place, pushing no entry: Back then skips the session it replaced', async () => {
    // Invariant: a notification-driven selection replaces the anchor; the workers panel's push in the same history is counted.
    const { c, at, openWorker } = await boot();
    const entries = history.length;
    openWorker();
    expect(history.length).toBe(entries + 1);
    await c.handleNotificationClick({ instanceId: 'B', sessionId: 'sb' });
    expect(at()).toEqual({ active: 'B', hash: '#session=sb' });
    expect(history.length).toBe(entries + 1);
    history.back();
    expect(at()).toEqual({ active: 'C', hash: '#session=sc' });
  });

  it('a notification click whose instanceId and sessionId name different live instances selects the one its instanceId names', async () => {
    // Invariant: the instanceId match wins over the sessionId match.
    const { c, at } = await boot();
    await c.handleNotificationClick({ instanceId: 'B', sessionId: 'sw' });
    expect(at()).toEqual({ active: 'B', hash: '#session=sb' });
  });
});
