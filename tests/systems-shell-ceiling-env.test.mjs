// ORCH_SHELL_COMMAND_TIMEOUT_MS — the shell's per-command ceiling, and the one
// knob an OPERATOR has over it.
//
// The ceiling is read once, at the constant, exactly as DEFAULT_OP_TIMEOUT_MS
// reads ORCH_OP_TIMEOUT_MS: nothing threads it through src/instances.ts, and
// `ProviderShell`'s `commandTimeoutMs` constructor option is a TEST seam, so
// this env var is the only way a deployment moves the number. It exists because
// the ceiling is one number doing three jobs — the longest a command may run,
// the longest a wedged shell stays wedged, and the longest a queued command
// waits for its turn — so there is no value that is simply correct, and a site
// with legitimately longer background work has to be able to raise it (card
// 2026-0305 §4 D2).
//
// ITS OWN FILE, so the assignment cannot leak into a sibling: `node --test`
// gives each file its own process, the same isolation
// tests/systems-op-timeout.test.mjs relies on. And EVERY module that could read
// it is imported DYNAMICALLY, because static imports hoist above statements and
// an assignment written above them runs too late (measured in that file).
process.env.ORCH_SHELL_COMMAND_TIMEOUT_MS = '250';
const CEILING_MS = 250;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { DEFAULT_COMMAND_TIMEOUT_MS, ProviderShell } = await import('../src/systems/providerShell.ts');

// A host that records the `timeoutMs` each command's `exec` was given and
// answers every one as timed out. The resolved deadline is VISIBLE on the wire
// as `ExecOptions.timeoutMs`, and the ETIMEDOUT message reports THIS shell's
// resolved deadline — so the number can be read back two independent ways from
// one call.
function recordingHost() {
  const seen = [];
  const host = {
    async execOneShot(_spec, opts) {
      seen.push(opts.timeoutMs);
      return {
        code: 124, stdout: '', stderr: '', output: '',
        timedOut: true, truncated: false, durationMs: 0, spawnError: null,
      };
    },
  };
  return { host, seen };
}

// PINS TWO CLAIMS, and neither is the default value (tests/systems-shell-framing.test.mjs
// pins that):
//   1. DEFAULT_COMMAND_TIMEOUT_MS reads ORCH_SHELL_COMMAND_TIMEOUT_MS. Delete
//      the env read and the export is 605_000 instead.
//   2. `?? DEFAULT_COMMAND_TIMEOUT_MS` is what a shell built with no
//      `commandTimeoutMs` actually falls back to — so the operator's number is
//      what reaches `exec`, and what the failure a worker reads names.
test('the shell ceiling reads ORCH_SHELL_COMMAND_TIMEOUT_MS, and an unconfigured shell uses it', async () => {
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, CEILING_MS);

  const { host, seen } = recordingHost();
  const sh = new ProviderShell(host, { cwd: '/w' });
  await assert.rejects(() => sh.run('anything'), (e) => {
    assert.equal(e.code, 'ETIMEDOUT', e.message);
    assert.match(e.message, new RegExp(`still running after ${CEILING_MS}ms`), e.message);
    return true;
  });
  assert.deepEqual(seen, [CEILING_MS], 'the operator\'s ceiling is what went on the wire');
});
