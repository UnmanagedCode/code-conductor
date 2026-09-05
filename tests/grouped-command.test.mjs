// Pins runGroupedCommand — the one detached process-group runner behind the
// post-worktree hook, plugin-library hooks, self-update's npm install, and
// runGitLive.
//
// The invariant that actually matters is GROUP kill: a timed-out command must
// take its GRANDCHILDREN with it. Killing only the direct child leaves an
// orphaned `npm ci` running after the request that started it is gone, and that
// is invisible to any test that only checks the parent's exit. So the timeout
// case below spawns a shell that backgrounds a long-lived grandchild, and then
// asserts the grandchild is dead — that assertion fails if `detached: true` or
// the negative-pid signal is dropped.
//
// Timings are short and bounded; nothing here sleeps out a real timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGroupedCommand, GROUP_OUTPUT_CAP } from '../src/groupedCommand.ts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a normal command resolves with its exit code and merged output', async () => {
  const r = await runGroupedCommand({ shell: 'echo out; echo err 1>&2; exit 3' }, { cwd: os.tmpdir() });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, null);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
});

test('argv form runs the binary directly, without a shell', async () => {
  // `$HOME` stays literal because there is no shell to expand it.
  const r = await runGroupedCommand({ argv: ['echo', '$HOME'] }, { cwd: os.tmpdir() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '$HOME');
});

// The grandchild sleeps far longer than any plausible test window, so it cannot
// "pass" by simply finishing on its own — which is exactly how an earlier
// version of this test was vacuous: with a 60 s sleeper, a child-only kill left
// the grandchild holding the stdout pipe, `close` fired only when the sleeper
// finished naturally, and the assertions then found it dead and passed — 60 s
// late. Every wait below is therefore BOUNDED and the bound is asserted.
const GRANDCHILD_SLEEP_S = 600;
const RESOLVE_BUDGET_MS = 5_000;

test('a timeout yields code 124 AND kills the whole process group', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-group-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  let grandchildPid = null;
  t.after(async () => {
    // Don't leak the sleeper if an assertion below fails.
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* gone */ } }
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The shell backgrounds a grandchild that IGNORES SIGTERM, records its pid,
  // then blocks. Two properties ride on that `trap '' TERM`:
  //   - the grandchild inherits the stdout pipe, so if only the direct child is
  //     killed the pipe stays open and the runner never resolves; and
  //   - SIGTERM alone cannot reap it, so the unref'd SIGKILL backstop is
  //     genuinely exercised. A plain `sleep` dies on SIGTERM and would let a
  //     backstop-less implementation pass.
  const grandchild = `bash -c 'trap "" TERM; sleep ${GRANDCHILD_SLEEP_S}'`;
  const started = Date.now();
  const run = runGroupedCommand(
    { shell: `${grandchild} & echo $! > ${JSON.stringify(pidFile)}; sleep ${GRANDCHILD_SLEEP_S}` },
    { cwd: dir, timeoutMs: 300, killGraceMs: 50 },
  );

  const TIMED_OUT = Symbol('budget');
  const r = await Promise.race([run, sleep(RESOLVE_BUDGET_MS).then(() => TIMED_OUT)]);
  assert.notEqual(r, TIMED_OUT,
    `runGroupedCommand did not resolve within ${RESOLVE_BUDGET_MS}ms — the grandchild is still holding the output pipe, so the process group was not killed`);
  assert.ok(Date.now() - started < RESOLVE_BUDGET_MS);

  assert.equal(r.code, 124, 'timeout must use the 124 exit-code contract');
  assert.equal(r.timedOut, true);

  grandchildPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'grandchild pid was recorded');

  // Bounded wait for the unref'd SIGKILL backstop to land.
  for (let i = 0; i < 100 && alive(grandchildPid); i++) await sleep(20);
  assert.equal(alive(grandchildPid), false,
    `grandchild ${grandchildPid} survived the timeout — the group was not killed`);
  grandchildPid = null; // confirmed dead; nothing for the cleanup hook to do
});

test('output is tail-clipped at `cap` and reports truncated', async () => {
  const cap = 256;
  // Emit well past the cap.
  const r = await runGroupedCommand({ shell: `for i in $(seq 1 400); do echo "line-$i"; done` },
    { cwd: os.tmpdir(), cap });
  assert.equal(r.code, 0);
  assert.equal(r.truncated, true, 'cap was exceeded, so truncated must be set');
  assert.ok(r.output.length <= cap, `output ${r.output.length} exceeded cap ${cap}`);
  // The TAIL is what is kept — the last line must survive, the first must not.
  assert.match(r.output, /line-400/);
  assert.doesNotMatch(r.output, /line-1\n/);
});

test('no cap means no clipping', async () => {
  const r = await runGroupedCommand({ shell: `for i in $(seq 1 400); do echo "line-$i"; done` },
    { cwd: os.tmpdir() });
  assert.equal(r.truncated, false);
  assert.match(r.output, /line-1\n/);
  assert.match(r.output, /line-400/);
});

test('a spawn failure resolves rather than rejecting, and is distinguishable', async () => {
  const r = await runGroupedCommand({ argv: ['/nonexistent/definitely-not-a-binary'] }, { cwd: os.tmpdir() });
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);
  assert.ok(r.spawnError, 'spawnError distinguishes "never launched" from "ran and exited 1"');
  assert.match(r.output, /ENOENT/);
});

test('onChunk streams output as it arrives', async () => {
  const seen = [];
  const r = await runGroupedCommand({ shell: 'echo a; echo b' },
    { cwd: os.tmpdir(), onChunk: (s) => seen.push(s) });
  assert.equal(r.code, 0);
  assert.match(seen.join(''), /a[\s\S]*b/);
});

// PINS: a streaming consumer is told WHICH stream each chunk came from. The
// redirected Bash forwards each to the worker's own stdout/stderr and cannot
// recover the split from an interleaved callback; every other caller ignores it.
test('onChunk names the stream each chunk came from', async () => {
  const seen = [];
  await runGroupedCommand({ shell: 'printf O; printf E >&2; printf O2' },
    { cwd: os.tmpdir(), onChunk: (s, which) => seen.push([which, s]) });
  const of = (w) => seen.filter(x => x[0] === w).map(x => x[1]).join('');
  assert.equal(of('out'), 'OO2');
  assert.equal(of('err'), 'E');
});

// PINS THE CAP ORDERING: onChunk fires only for output that is actually
// RETAINED. A live consumer that saw bytes past a cap would show a tail the
// buffered result does not contain — the streaming path disagreeing with the
// buffered one about what the command printed.
test('onChunk never emits past headCapBytes', async () => {
  const seen = [];
  const r = await runGroupedCommand({ shell: 'for i in $(seq 1 200); do printf "0123456789"; done' },
    { cwd: os.tmpdir(), headCapBytes: 64, onChunk: (s) => seen.push(s) });
  assert.equal(r.truncated, true, 'the cap really was hit');
  assert.equal(seen.join(''), r.stdout, 'the stream carried exactly what was retained');
});

// PINS: past the maxBufferBytes FENCE nothing more is streamed either, and the
// result is a reported FAILURE rather than a clipped success — a caller that
// parses output whole must never read a truncated parse as the truth.
test('onChunk stops at the maxBufferBytes fence, and the fence is still a failure', async () => {
  const seen = [];
  const r = await runGroupedCommand({ shell: 'for i in $(seq 1 500); do printf "0123456789"; done; sleep 0.2' },
    { cwd: os.tmpdir(), maxBufferBytes: 64, onChunk: (s) => seen.push(s) });
  assert.equal(r.code, 1, 'an overflow is a failure, not a truncated success');
  assert.match(r.stderr, /exceeded the 64-byte limit/);
  assert.ok(seen.join('').length <= 64, 'and nothing past the fence was streamed');
  assert.ok(r.stdout.startsWith(seen.join('')), 'what was streamed is a prefix of what was kept');
});

test('GROUP_OUTPUT_CAP is the single owner of the 16K tail cap', () => {
  assert.equal(GROUP_OUTPUT_CAP, 16 * 1024);
});
