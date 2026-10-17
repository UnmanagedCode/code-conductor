// Fixture for tests/web-console-guard.test.mjs, which runs it through Vitest
// with CC_CONSOLE_GUARD_PROOF=1 and reads the per-test results back. Skipped in
// a normal run, since most of its tests fail on purpose. The tests depend on
// their order: several leave a spy, a timer or fake timers installed.
import { setImmediate as realSetImmediate } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.CC_CONSOLE_GUARD_PROOF)('console guard proof', () => {
  it('logs an error', () => {
    console.error('in-test-error-marker %d', 7);
  });

  it('logs a warning', () => {
    console.warn('in-test-warn-marker');
  });

  it('is quiet', () => {});

  it('mutes with a spy it leaves installed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    console.warn('muted-marker');
    expect(warn).toHaveBeenCalledExactlyOnceWith('muted-marker');
  });

  it('logs after the previous test left its spy', () => {
    console.warn('after-leftover-spy-marker');
  });

  it('restores its own spy, then logs', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    error.mockRestore();
    console.error('after-restore-marker');
  });

  it('restores all mocks, then logs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.restoreAllMocks();
    console.error('after-restore-all-marker');
  });

  it('schedules a log on the next turn', () => {
    realSetImmediate(() => console.error('next-turn-marker'));
  });

  it('is quiet after a next-turn log', () => {});

  it('leaves a timer that logs later', () => {
    setTimeout(() => console.error('leaked-timer-marker'), 30);
  });

  it('is running when the leaked timer fires', async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  it('fakes timers and leaves them installed', () => {
    vi.useFakeTimers();
  });

  it('runs under the fake timers left installed', () => {});
});
