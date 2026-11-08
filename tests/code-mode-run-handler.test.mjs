// run_code's handler against a stub context: resources it opens are released
// even when it fails part-way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCode } from '../src/codeMode/runCode.ts';
import { createRunRegistry } from '../src/codeMode/runs.ts';

test('a failure after the token is minted still revokes it and stops the pump', async () => {
  const real = createRunRegistry();
  const opened = [];
  const closed = [];
  const runs = {
    ...real,
    open: (id) => { const t = real.open(id); opened.push(t); return t; },
    close: (t) => { closed.push(t); return real.close(t); },
  };
  const ctx = {
    instances: { liveForSession: () => ({ mode: 'bypassPermissions', cwd: process.cwd(), transcriptPlace: { system: 'local' } }) },
    callerId: 'sid', tools: [], runs, selfUrl: 'http://127.0.0.1:1/mcp',
    // The pump's first emit ("started") runs inside the handler and throws.
    progress: () => { throw new Error('stream is gone'); },
  };
  await assert.rejects(runCode({ code: 'return 1' }, ctx), /stream is gone/);
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened, 'the token was revoked');
  assert.equal(real.get(opened[0]), undefined);
});

test('a failure after the pump started stops it: no further progress emits', async () => {
  const emits = [];
  const real = createRunRegistry();
  const ctx = {
    instances: { liveForSession: () => ({ mode: 'bypassPermissions', cwd: process.cwd(), transcriptPlace: { system: 'local' } }) },
    // A lone surrogate cannot be URI-encoded: building the exec call throws
    // after the token is minted and the pump is running.
    callerId: '\ud800', tools: [], runs: real, selfUrl: 'http://127.0.0.1:1/mcp',
    progress: (progress, message) => emits.push([progress, message]),
    codeModeTiming: { heartbeatMs: 15, minIntervalMs: 1 },
  };
  await assert.rejects(runCode({ code: 'return 1' }, ctx), URIError);
  assert.equal(emits.length, 1, 'only "started" was emitted');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(emits.length, 1, 'a live heartbeat would have emitted by now');
});
