import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setSwRegistrationForTests, closeAllOnFocus, fire, initNotifications } from './notifications';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}

describe('focusing the tab', () => {
  afterEach(() => {
    __setSwRegistrationForTests(null);
    setVisibility('visible');
    delete (globalThis as any).Notification;
  });

  it('closes the summary and every per-session ping, and leaves a foreign tag alone', async () => {
    // Invariant: a visibilitychange to visible dismisses cc-summary and session:* notifications only; becoming hidden dismisses none.
    const mk = (tag: string) => ({ tag, close: vi.fn() });
    const open = [mk('session:s-x'), mk('cc-summary'), mk('session:s-y'), mk('other:thing')];
    const getNotifications = vi.fn(async () => open);
    (globalThis as any).Notification = class { static permission = 'default'; };
    initNotifications();
    __setSwRegistrationForTests({ getNotifications } as unknown as ServiceWorkerRegistration);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(open.every((n) => n.close.mock.calls.length === 0)).toBe(true);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(open[0].close).toHaveBeenCalledTimes(1));
    expect(open[1].close).toHaveBeenCalledTimes(1);
    expect(open[2].close).toHaveBeenCalledTimes(1);
    expect(open[3].close).not.toHaveBeenCalled();
  });

  it('a ping whose show is still in flight is closed by the focus clear, not left behind it', async () => {
    // Invariant: every service-worker call runs in order, so a focus clear lands after the show queued before it.
    const tray: { tag: string; close(): void }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as any).Notification = class { static permission = 'granted'; };
    __setSwRegistrationForTests({
      showNotification: async (_t: string, opts: NotificationOptions) => {
        await gate;
        const n = { tag: opts.tag!, close: () => { tray.splice(tray.indexOf(n), 1); } };
        tray.push(n);
      },
      getNotifications: async () => [...tray],
    } as unknown as ServiceWorkerRegistration);
    fire({ title: 't', body: '', tag: 'session:s-z', data: { project: 'p', instanceId: 'i', sessionId: 's-z' } });
    const cleared = closeAllOnFocus();
    release();
    await cleared;
    expect(tray).toEqual([]);
  });
});
