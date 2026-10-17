// Fixture for tests/web-console-guard.test.mjs (see consoleGuard.raise.proof.test.ts):
// the file afterEach always throws, so the guard's own never runs. A log the one
// test queued for the next turn fires after its body, and an import-time log sits
// outside every test; the file failure must name both kinds.
import { setImmediate as realSetImmediate } from 'node:timers';
import { afterEach, describe, it } from 'vitest';

if (process.env.CC_CONSOLE_GUARD_PROOF) console.error('late-outside-marker');

describe.skipIf(!process.env.CC_CONSOLE_GUARD_PROOF)('console guard late-log proof', () => {
  afterEach(() => {
    throw new Error('file-afterEach-threw');
  });

  it('queues a log for the next turn', () => {
    realSetImmediate(() => console.error('late-next-turn-marker'));
  });
});
