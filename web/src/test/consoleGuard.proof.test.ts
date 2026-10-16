// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// Fixture for tests/web-console-guard.test.mjs, which runs it through Vitest
// with CC_CONSOLE_GUARD_PROOF=1 and reads the process output. Skipped in a
// normal run, since its first test prints on purpose.
import rawConsole from 'node:console';
import { describe, it } from 'vitest';

describe.skipIf(!process.env.CC_CONSOLE_GUARD_PROOF)('console filter proof', () => {
  it('prints an unrelated raw-console error', () => {
    rawConsole.error('guard-proof-marker');
  });

  it('mounts an iframe whose page loading is disabled', () => {
    const frame = document.createElement('iframe');
    frame.src = 'http://localhost/plugins/x/';
    document.body.appendChild(frame);
    frame.remove();
  });
});
