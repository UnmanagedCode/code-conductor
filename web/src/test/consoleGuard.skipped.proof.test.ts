// Fixture for tests/web-console-guard.test.mjs (see consoleGuard.raise.proof.test.ts):
// a file afterEach that throws skips the guard's own afterEach, which runs last.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.CC_CONSOLE_GUARD_PROOF)('console guard skipped-afterEach proof', () => {
  let armed = false;
  afterEach(() => {
    if (armed) throw new Error('file-afterEach-threw');
  });

  it('mutes warn with a spy, logs an error, then its file afterEach throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    console.warn('muted-marker');
    expect(warn).toHaveBeenCalledOnce();
    console.error('skipped-test-marker');
    armed = true;
  });

  it('warns after the previous test skipped the guard afterEach', () => {
    armed = false;
    console.warn('after-skipped-marker');
  });

  it('is quiet', () => {});

  it('logs an error as the last test, then its file afterEach throws', () => {
    console.error('last-test-marker');
    armed = true;
  });
});
