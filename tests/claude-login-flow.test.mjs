// src/claudeLogin.ts — the `claude auth login` state machine, driven against
// tests/fake-claude-auth.mjs, which prints the real CLI's banner, prompt and
// error lines and, like the real CLI, ignores stdin EOF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeLoginFlow } from '../src/claudeLogin.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { waitFor } from './helpers.mjs';
import { FAKE_LOGIN_URL } from './fake-claude-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = `${process.execPath} ${path.join(__dirname, 'fake-claude-auth.mjs')}`;

const pidGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};

// One fake-CLI login per test: env set for the spawn, a fresh record file, and
// the flow disposed + env restored however the test ends.
async function withLogin({ mode = 'normal', bin = FAKE, ...opts } = {}, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-login-flow-'));
  const record = path.join(dir, 'rec.jsonl');
  const vars = { CLAUDE_BIN: bin, FAKE_AUTH_LOGIN_MODE: mode, FAKE_AUTH_RECORD: record };
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const flow = createClaudeLoginFlow({ platform: hostPlatform, killGraceMs: 100, ...opts });
  const readRecord = async () => (await fs.readFile(record, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const header = () => waitFor(async () => (await readRecord())[0]);
  const lines = async () => (await readRecord()).filter(r => 'line' in r).map(r => r.line);
  try {
    return await fn({ flow, header, lines });
  } finally {
    flow.dispose();
    // Backstop for a regression in the code under test: a child it failed to
    // kill must not outlive the test and hold the file open. Every assertion
    // has already run inside `fn`, so this masks none of them.
    const pids = (await readRecord().catch(() => [])).map(r => r.pid).filter(Boolean);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const awaitState = (flow, state) => waitFor(() => flow.snapshot().state === state);
const statusOf = (fn) => { try { fn(); } catch (e) { return e.statusCode; } return null; };

test('start → awaiting_code with the URL parsed from the banner; the child runs `auth login` with BROWSER=true', async () => {
  await withLogin({}, async ({ flow, header }) => {
    const s = flow.start();
    assert.equal(s.state, 'starting');
    assert.equal(s.url, null);
    assert.equal(typeof s.startedAt, 'number');
    await awaitState(flow, 'awaiting_code');
    assert.equal(flow.snapshot().url, FAKE_LOGIN_URL);
    const h = await header();
    assert.deepEqual(h.argv, ['auth', 'login']);
    assert.equal(h.env.BROWSER, 'true');
  });
});

test('submitCode writes exactly the trimmed code line; exit 0 → succeeded and onSuccess fires once', async () => {
  let successes = 0;
  await withLogin({ onSuccess: () => { successes++; } }, async ({ flow, lines }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const s = flow.submitCode('  GOOD#STATE \t');
    assert.equal(s.state, 'verifying');
    await awaitState(flow, 'succeeded');
    assert.deepEqual(await lines(), ['GOOD#STATE']);
    const done = flow.snapshot();
    assert.equal(done.error, null);
    assert.equal(typeof done.endedAt, 'number');
    assert.equal(successes, 1);
  });
});

test('an "Invalid code" complaint returns to awaiting_code with that error; a second submit then succeeds', async () => {
  await withLogin({}, async ({ flow, lines }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    flow.submitCode('nohash');
    await waitFor(() => flow.snapshot().error !== null);
    const s = flow.snapshot();
    assert.equal(s.state, 'awaiting_code');
    assert.equal(s.error, 'Invalid code. Please make sure the full code was copied.');
    assert.equal(flow.submitCode('GOOD#STATE').error, null, 'a new submit clears the previous complaint');
    await awaitState(flow, 'succeeded');
    assert.deepEqual(await lines(), ['nohash', 'GOOD#STATE']);
  });
});

test('a rejected code → failed with the CLI\'s stderr line, and onSuccess does not fire', async () => {
  let successes = 0;
  await withLogin({ onSuccess: () => { successes++; } }, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    flow.submitCode('BAD#STATE');
    await awaitState(flow, 'failed');
    assert.equal(flow.snapshot().error, 'Login failed: Request failed with status code 400');
    assert.equal(successes, 0);
  });
});

test('start while a flow is active throws 409; start after a terminal state works and resets url/error', async () => {
  await withLogin({}, async ({ flow }) => {
    flow.start();
    assert.equal(statusOf(() => flow.start()), 409, 'while starting');
    await awaitState(flow, 'awaiting_code');
    assert.equal(statusOf(() => flow.start()), 409, 'while awaiting a code');
    flow.submitCode('BAD#STATE');
    assert.equal(statusOf(() => flow.start()), 409, 'while verifying');
    await awaitState(flow, 'failed');
    const s = flow.start();
    assert.deepEqual({ state: s.state, url: s.url, error: s.error, endedAt: s.endedAt },
      { state: 'starting', url: null, error: null, endedAt: null });
    await awaitState(flow, 'awaiting_code');
  });
});

test('submitCode rejects a non-string, empty, multi-line or over-length code (400), and any code when not awaiting one (409)', async () => {
  await withLogin({ mode: 'hang' }, async ({ flow }) => {
    assert.equal(statusOf(() => flow.submitCode('GOOD#STATE')), 409, 'idle');
    flow.start();
    assert.equal(statusOf(() => flow.submitCode('GOOD#STATE')), 409, 'starting');
  });
  await withLogin({}, async ({ flow, lines }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    for (const bad of [undefined, 42, '', '   ', 'a\nb', 'a\rb', 'x'.repeat(4097)]) {
      assert.equal(statusOf(() => flow.submitCode(bad)), 400, JSON.stringify(bad)?.slice(0, 20));
    }
    assert.equal(flow.snapshot().state, 'awaiting_code', 'a refused code leaves the flow waiting');
    flow.submitCode(`${'x'.repeat(4094)}#S`); // exactly at the limit: accepted, then rejected by the CLI
    assert.equal(statusOf(() => flow.submitCode('GOOD#STATE')), 409, 'verifying');
    await awaitState(flow, 'failed');
    assert.equal((await lines()).length, 1, 'only the accepted code reached stdin');
  });
});

test('the snapshot never carries the submitted code', async () => {
  await withLogin({}, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const seen = [JSON.stringify(flow.submitCode('SECRETCODE#STATE'))];
    await awaitState(flow, 'failed');
    seen.push(JSON.stringify(flow.snapshot()));
    for (const s of seen) assert.ok(!s.includes('SECRETCODE'), s);
  });
});

test('cancel → cancelled and the child is killed; its later exit does not overwrite the state; cancel is idempotent', async () => {
  await withLogin({}, async ({ flow, header }) => {
    assert.equal(flow.cancel().state, 'idle', 'cancel with no flow is a no-op');
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    assert.equal(flow.cancel().state, 'cancelled');
    await waitFor(() => pidGone(pid));
    await new Promise(r => setTimeout(r, 50)); // let the child's close event land
    const s = flow.snapshot();
    assert.equal(s.state, 'cancelled');
    assert.equal(s.error, null);
    assert.equal(typeof s.endedAt, 'number');
    assert.equal(flow.cancel().state, 'cancelled');
  });
});

test('a child that ignores SIGTERM is SIGKILLed after the grace period', async () => {
  await withLogin({ mode: 'ignore-term', killGraceMs: 100 }, async ({ flow, header }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    flow.cancel();
    await waitFor(() => pidGone(pid), { timeout: 5000 });
  });
});

test('timeout → failed with the exact timeout message, and the child is killed', async () => {
  await withLogin({ mode: 'hang', timeoutMs: 1000 }, async ({ flow, header }) => {
    flow.start();
    const { pid } = await header();
    await awaitState(flow, 'failed');
    assert.equal(flow.snapshot().error, 'Login timed out after 1s');
    await waitFor(() => pidGone(pid));
    assert.equal(flow.snapshot().state, 'failed');
  });
});

test('dispose() kills a live child', async () => {
  await withLogin({}, async ({ flow, header }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    flow.dispose();
    await waitFor(() => pidGone(pid));
  });
});

test('a process "exit" hook is held only while the child lives, and it kills the child', async () => {
  await withLogin({}, async ({ flow, header }) => {
    const before = process.listeners('exit');
    flow.start();
    const added = process.listeners('exit').filter(l => !before.includes(l));
    assert.equal(added.length, 1);
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    added[0]();
    await waitFor(() => pidGone(pid));
    await awaitState(flow, 'failed');
    assert.ok(!process.listeners('exit').includes(added[0]), 'removed once the child exited');
  });
});

test('a binary that cannot start → failed naming the command', async () => {
  const missing = path.join(os.tmpdir(), `cc-no-such-claude-${process.pid}`);
  await withLogin({ bin: missing }, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'failed');
    const { error } = flow.snapshot();
    assert.ok(error.includes('could not be started') && error.includes(missing), error);
  });
});

test('a CLI that exits before printing a URL → failed with its stderr line', async () => {
  await withLogin({ mode: 'exit-before-url' }, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'failed');
    const s = flow.snapshot();
    assert.equal(s.error, 'Login failed: unable to reach the authorization server');
    assert.equal(s.url, null);
  });
});

test('cancel → immediate start, repeated: one process "exit" listener while a flow lives, none after', async () => {
  await withLogin({ killGraceMs: 60_000 }, async ({ flow }) => {
    const baseline = process.listenerCount('exit');
    for (let i = 0; i < 12; i++) {
      flow.start();
      assert.ok(process.listenerCount('exit') <= baseline + 1, `cycle ${i}: ${process.listenerCount('exit') - baseline} listeners`);
      flow.cancel();
    }
    flow.start();
    await awaitState(flow, 'awaiting_code');
    assert.equal(process.listenerCount('exit'), baseline + 1, 'while the flow is live');
    flow.cancel();
    await waitFor(() => process.listenerCount('exit') === baseline);
  });
});

test('a cancelled child that ignores SIGTERM is still SIGKILLed when a new flow starts at once', async () => {
  await withLogin({ mode: 'ignore-term', killGraceMs: 100 }, async ({ flow, header }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    flow.cancel();
    flow.start();
    await waitFor(() => pidGone(pid), { timeout: 5000 });
    assert.notEqual(flow.snapshot().state, 'cancelled', 'the old child dying does not end the new flow');
  });
});

test('a URL line split across stdout chunks is read whole', async () => {
  await withLogin({ mode: 'split-url' }, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    assert.equal(flow.snapshot().url, FAKE_LOGIN_URL);
  });
});

test('dispose() SIGKILLs a child that ignores SIGTERM', async () => {
  await withLogin({ mode: 'ignore-term', killGraceMs: 100 }, async ({ flow, header }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    const { pid } = await header();
    flow.dispose();
    await waitFor(() => pidGone(pid), { timeout: 5000 });
  });
});

test('an "Invalid code" complaint with no trailing newline still returns to awaiting_code', async () => {
  await withLogin({ mode: 'complaint-no-newline' }, async ({ flow }) => {
    flow.start();
    await awaitState(flow, 'awaiting_code');
    flow.submitCode('nohash');
    await waitFor(() => flow.snapshot().state === 'awaiting_code', { timeout: 3000 });
    assert.equal(flow.snapshot().error, 'Invalid code. Please make sure the full code was copied.');
    flow.submitCode('GOOD#STATE');
    await awaitState(flow, 'succeeded');
  });
});

test('onStart fires once per started flow', async () => {
  let starts = 0;
  await withLogin({ onStart: () => { starts++; } }, async ({ flow }) => {
    flow.start();
    assert.equal(starts, 1);
    flow.cancel();
    flow.start();
    assert.equal(starts, 2);
  });
});
