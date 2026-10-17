// Fixture for tests/web-console-guard.test.mjs (see consoleGuard.raise.proof.test.ts):
// output outside any test, at import and in an afterAll, must fail the file.
import { afterAll, describe, it } from 'vitest';

if (process.env.CC_CONSOLE_GUARD_PROOF) console.error('import-time-marker');

describe.skipIf(!process.env.CC_CONSOLE_GUARD_PROOF)('console guard outside-test proof', () => {
  afterAll(() => {
    console.warn('after-all-marker');
  });

  it('is quiet', () => {});
});
