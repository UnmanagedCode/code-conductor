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
  const sent: [string, unknown][] = [];
  return { bus, sent, connect: vi.fn(), send: vi.fn((t: string, payload: unknown) => { sent.push([t, payload]); }) };
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
  const ws = await import('@/lib/core/ws.js') as unknown as { sent: [string, unknown][] };
  appStore.set({ instances: [conductor, worker, pinged] });
  c.startController();
  stopPrevious = c.stopController;
  c.selectInstance(conductor.id, { userGesture: true });
  render(<SubagentPanel inst={conductor} />);
  const at = () => ({ active: appStore.get().activeId, hash: location.hash });
  const openWorker = () => fireEvent.click(screen.getByRole('button', { name: 'Fix the parser' }));
  return { c, at, openWorker, sent: ws.sent };
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

    // Selected as the sidebar does, the worker replaces the conductor's entry and adds none.
    const before = history.length;
    c.selectInstance(worker.id, { userGesture: true });
    expect(at()).toEqual({ active: 'W', hash: '#session=sw' });
    expect(history.length).toBe(before);
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

  it('Back onto an entry naming the session already shown leaves that session alone: nothing is selected or subscribed again', async () => {
    // Invariant: popstate selects only when the popped anchor names a session other than the active one.
    const { at, openWorker, sent } = await boot();
    openWorker();
    const entries = history.length;
    const subscribes = sent.length;
    // The workers panel opens the same worker again: a second entry with the same anchor.
    openWorker();
    expect(history.length).toBe(entries + 1);
    expect(sent.slice(subscribes)).toEqual([['subscribe', { id: 'W' }]]);
    const after = sent.length;
    history.back();
    expect(at()).toEqual({ active: 'W', hash: '#session=sw' });
    expect(sent.slice(after)).toEqual([]);
  });

  it('a notification click without a service worker opens its session in place, adding no history entry', async () => {
    // Invariant: the page notification's click, dispatched on window, reaches the controller and selects its instance without a push.
    const { at } = await boot();
    const { __setSwRegistrationForTests, fire } = await import('@/features/notifications/notifications');
    __setSwRegistrationForTests(null);
    const g = globalThis as { Notification?: unknown };
    const original = g.Notification;
    const created: { onclick: (() => void) | null }[] = [];
    g.Notification = class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor() { created.push(this); }
      close() {}
    };
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    try {
      fire({ title: 't', body: 'b', tag: 'session:sb', data: { project: 'p', instanceId: 'B', sessionId: 'sb' } });
      expect(created).toHaveLength(1);
      const entries = history.length;
      created[0].onclick?.();
      await Promise.resolve();
      expect(at()).toEqual({ active: 'B', hash: '#session=sb' });
      expect(history.length).toBe(entries);
    } finally {
      if (original === undefined) delete g.Notification;
      else g.Notification = original;
      focus.mockRestore();
    }
  });
});
