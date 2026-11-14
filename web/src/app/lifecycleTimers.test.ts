import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeFetch, type RoutedCall } from '@/test/routeFetch';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('./sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));

const AGO_TICK_MS = 15_000;
const USAGE_POLL_MS = 180_000;

let calls: RoutedCall[] = [];
const usage = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/usage').length;

// Every import happens after the fake clock is installed: a timer armed at import is then counted.
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls = routeFetch({ 'GET /api/usage': () => ({ json: { usage: null } }) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('timers and the controller lifetime', () => {
  it('importing the sidebar state arms no timer', async () => {
    // Invariant: the sidebar state module arms no timer at import.
    expect(vi.getTimerCount(), 'control: nothing armed yet').toBe(0);
    await import('@/features/sidebar/state');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('importing the app shell arms no timer', async () => {
    // Invariant: nothing in the App import graph arms a timer at import.
    expect(vi.getTimerCount(), 'control: nothing armed yet').toBe(0);
    await import('@/App');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('startController arms the ago tick and the usage poll; stopController clears both; a restart re-arms them', async () => {
    // Invariant: the controller's lifetime owns the ago tick and the usage poll — start arms them, stop clears them, a second stop is a no-op, a restart arms them again.
    const c = await import('./controller');
    const { agoTick } = await import('@/features/sidebar/state');
    expect(vi.getTimerCount(), 'nothing armed by import').toBe(0);

    c.startController();
    await vi.advanceTimersByTimeAsync(0);
    expect(usage(), 'the first usage read').toBe(1);
    const v = agoTick.version();
    await vi.advanceTimersByTimeAsync(AGO_TICK_MS);
    expect(agoTick.version(), 'the ago tick ticks').toBeGreaterThan(v);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(usage(), 'the usage poll repeats').toBe(2);

    c.stopController();
    expect(vi.getTimerCount(), 'stop clears every timer').toBe(0);
    const stopped = agoTick.version();
    await vi.advanceTimersByTimeAsync(2 * USAGE_POLL_MS);
    expect(agoTick.version(), 'no tick after stop').toBe(stopped);
    expect(usage(), 'no poll after stop').toBe(2);
    c.stopController();
    expect(vi.getTimerCount(), 'a second stop is a no-op').toBe(0);

    c.startController();
    expect(vi.getTimerCount(), 'a restart re-arms').toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(AGO_TICK_MS);
    expect(agoTick.version(), 'the restarted tick ticks').toBeGreaterThan(stopped);
    c.stopController();
    expect(vi.getTimerCount()).toBe(0);
  });
});
