import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeFetch, type RoutedCall } from '@/test/routeFetch';

const RETRY_MS = 5000;
let calls: RoutedCall[] = [];
let warn: ReturnType<typeof vi.spyOn>;
const health = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/health').length;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls = routeFetch({ 'GET /api/health': () => ({ status: 500, json: { error: 'down' } }) });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Starts a probe; returns its stop. */
async function probe() {
  const { probeVoice } = await import('./store');
  return probeVoice();
}
function expectWarned() {
  expect(warn).toHaveBeenCalled();
  expect(String(warn.mock.calls[0][0])).toMatch(/^capabilities: could not read \/api\/health/);
}

describe('probeVoice', () => {
  it('a failing capabilities probe retries until its stop runs', async () => {
    // Invariant: the retry chain has a stop handle; stop clears the pending retry; stop is idempotent.
    const stop = await probe();
    await vi.advanceTimersByTimeAsync(0);
    expect(health()).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(health(), 'control: the retry fires').toBe(2);
    expectWarned();
    expect(typeof stop, 'probeVoice hands back a stop').toBe('function');
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(health(), 'no retry after stop').toBe(2);
    expect(() => stop()).not.toThrow();
  });

  it('a stop while the probe is in flight arms no retry', async () => {
    // Invariant: the stopped flag suppresses the re-arm of a load that was already in flight.
    const stop = await probe();
    expect(typeof stop, 'probeVoice hands back a stop').toBe('function');
    stop();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(health()).toBe(1);
    expectWarned();
  });

  it('probing again after a stop starts a fresh retry chain', async () => {
    // Invariant: a stop ends only its own chain; a later probe retries again.
    const stop = await probe();
    expect(typeof stop, 'the first probe hands back a stop').toBe('function');
    stop();
    await vi.advanceTimersByTimeAsync(0);
    const { probeVoice } = await import('./store');
    const again = probeVoice();
    expect(typeof again, 'the second probe hands back a stop').toBe('function');
    await vi.advanceTimersByTimeAsync(0);
    expect(health()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(health(), 'the fresh chain retries').toBe(3);
    expectWarned();
    again();
    expect(vi.getTimerCount()).toBe(0);
  });
});
