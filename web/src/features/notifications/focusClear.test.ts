import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setSwRegistrationForTests, initNotifications } from './notifications';

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
});
