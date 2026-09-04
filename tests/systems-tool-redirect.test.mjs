// The redirection policy: which tool call crosses to the system, which is
// refused, and what the worker is told.
//
// THE INVARIANT UNDER TEST IS BOUNDARY CONSISTENCY. A tool that half-redirects
// — a path visible from one side and not the other — is what makes a model
// distrust its own tool results and report the environment as broken. So every
// tool that can observe or mutate the system's tree is either fully redirected
// or refused by name; nothing is left to fall through to a local path that
// happens to exist.
//
// The fixture is disjoint on purpose: ONLY-ON-SYSTEM.txt exists only in the
// system's tree and ONLY-ON-CC.txt only in cc's session root, so a command or a
// read that landed on the wrong machine fails these assertions instead of
// quietly passing.

import { test, beforeEach, afterEach } from 'node:test';
import { getEventListeners } from 'node:events';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { addSystem } from '../src/appSettings.ts';
import { noMirror } from '../src/systems/mirror.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recordingProvider.mjs');

let home, remote, redirect, root, events;

async function build({ flags = [], shellCommandTimeoutMs, maxOutputBytes } = {}) {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem({ flags });
  root = path.join(home, 'session-root');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'ONLY-ON-CC.txt'), 'cc side\n');
  await fs.writeFile(path.join(remote.root, 'ONLY-ON-SYSTEM.txt'), 'system side\n');
  events = [];
  redirect = new SessionRedirect({
    system: await systemById(remote.id, null, 'test'),
    systemId: remote.id,
    systemPath: remote.root,
    sessionRoot: root,
    mirror: noMirror(remote.root),
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [path.join(home, 'local-ok')],
    emit: (ev) => events.push(ev),
    ...(shellCommandTimeoutMs === undefined ? {} : { shellCommandTimeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

beforeEach(async () => { await build(); });
afterEach(async () => {
  await redirect.close();
  disposeSystemHandles();
  await rmrf(home);
});

const onSystem = (rel) => path.join(remote.root, rel);
const inSession = (rel) => path.join(root, rel);
const pre = (tool, input) => redirect.preToolUse(tool, input);
const post = (tool, input, response = {}) => redirect.postToolUse(tool, input, response);
const bash = (command) => redirect.runForwarded(command, {});

// PINS: `Bash` becomes an invocation of the local forwarder that carries the
// ORIGINAL command — the one rewrite the whole redirection rests on.
test('Bash is rewritten into the forwarder, carrying the original command', async () => {
  const d = await pre('Bash', { command: "echo 'it\\'s here' && ls", description: 'x' });
  assert.equal(d.decision, 'allow');
  assert.match(d.updatedInput.command, /bashForwarder\.ts/);
  assert.match(d.updatedInput.command, /--url 'http:/);
  // The other input fields survive: updatedInput REPLACES the input, so
  // dropping one would silently change the call.
  assert.equal(d.updatedInput.description, 'x');
});

// INVERTED on card 2026-0312 §2 D-b: this used to pin that a positive tool
// `timeout` rode out as `--timeout <ms>` on the forwarder's argv. NOTHING of the
// tool's own timeout travels any more, and cc needs it for nothing: its only
// consumer was the wait bound on a queue that no longer exists, and at the tool
// timeout the CLI DETACHES the forwarder rather than killing it (card 2026-0305
// §3), so the command keeps running under cc's own ceiling. A kill, when one
// comes, closes the socket — cc's cancellation channel, which needs no number.
//
// THE ARGV IS WHERE THIS IS OBSERVABLE AT ALL, which is this test's reason to
// exist: re-adding the flag would change no far-side behaviour cc can see, so
// only the argv can catch it coming back.
//
// EVERY SHAPE THAT USED TO PRODUCE A FLAG is asserted here, not just one: the
// guard that dropped the others (`Number.isFinite(timeout) && timeout > 0`) went
// with the flag, so a partial restoration would put `--timeout Infinity` on a
// real argv.
test('neither a tool timeout nor an agent id rides out on the argv', async () => {
  const argvFor = async (input) =>
    (await pre('Bash', { command: 'echo hi', ...input })).updatedInput.command;

  for (const input of [{ timeout: 45_000 }, { timeout: 1500.7 }, { timeout: '2000' },
                       {}, { timeout: 0 }, { timeout: -5 }, { timeout: 'soon' },
                       { timeout: null }, { timeout: 'Infinity' }]) {
    assert.doesNotMatch(await argvFor(input), /--timeout/,
      `${JSON.stringify(input)} must not put a timeout on the wire`);
    // THE `--agent` HALF, and it is not decoration: the forwarder's `parseArgs`
    // BREAKS AT THE FIRST UNRECOGNISED TOKEN and folds everything after it into
    // the command. Measured against the shipped script: an argv carrying
    // `--agent a1 -- echo hi` posts `{"command":"--agent a1 -- echo hi"}` — the
    // body still has exactly one key and exactly the right SHAPE, so
    // tests/systems-bash-forwarder.test.mjs's exact-body assertion passes while
    // the far side runs the wrong command. The argv is the only layer that can
    // catch it.
    assert.doesNotMatch(await argvFor(input), /--agent/,
      `${JSON.stringify(input)} must not put an agent id on the wire either`);
  }
  // The command itself still rides, so this is not passing by producing no argv.
  assert.match(await argvFor({ timeout: 45_000 }), /echo hi/);
});

// PINS: a forwarded command runs on the SYSTEM, not on cc. Both directions are
// asserted, so a forwarder that quietly ran locally cannot pass.
test('a forwarded command runs on the system and not on cc', async () => {
  const hit = await bash('cat ONLY-ON-SYSTEM.txt');
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout, 'system side\n');

  const miss = await bash('cat ONLY-ON-CC.txt');
  assert.notEqual(miss.code, 0);
});

// INVERTED on card 2026-0312 — THE PARITY THIS CARD EXISTS FOR, at the layer a
// worker actually meets it. This used to assert that `cd` AND `export` carried
// between an agent's commands. Neither does: every command runs in its own
// shell, which is what a local session already does (measured on CLI 2.1.258 —
// a local Bash call persists nothing and the harness announces the cwd reset).
test('nothing carries between two redirected commands — every one starts at the project root', async () => {
  await fs.mkdir(onSystem('sub'), { recursive: true });
  await bash('cd sub');
  assert.equal((await bash('pwd')).stdout.trim(), remote.root,
    'the second command starts at the project root, not where the first ended');

  await bash('export CC_PROBE=carried');
  assert.equal((await bash('echo "[$CC_PROBE]"')).stdout.trim(), '[]',
    'nothing an agent exports reaches its next command');
});

// A sink that records what arrived and WHEN, relative to the promise settling.
function recordingSink(state) {
  const seen = [];
  return {
    seen,
    sink: {
      notice: (t) => seen.push({ k: 'notice', t, settled: state.settled }),
      out: (t) => seen.push({ k: 'out', t, settled: state.settled }),
      err: (t) => seen.push({ k: 'err', t, settled: state.settled }),
    },
    textOf: (k) => seen.filter(x => x.k === k).map(x => x.t).join(''),
  };
}

// PINS: a forwarded command's output reaches the sink BEFORE the command
// finishes, and what the sink received is byte-identical to the aggregate. This
// is the whole of what "the worker sees output as it arrives" means one layer
// down. Asserted by ORDER against the promise settling, not by wall clock.
test('a forwarded command streams its output before it finishes', async () => {
  const state = { settled: false };
  const { seen, sink, textOf } = recordingSink(state);
  const p = redirect.runForwarded(
    'printf "part1\n"; printf "e1\n" >&2; sleep 0.4; printf "part2\n"',
    { sink },
  );
  const r = await p;
  state.settled = true;

  assert.ok(seen.some(x => !x.settled && x.t.includes('part1')),
    'the first half arrived while the command was still running');
  assert.equal(textOf('out'), r.stdout, 'and the stream is byte-identical to the aggregate');
  assert.equal(textOf('err'), r.stderr);
  assert.equal(r.stdout, 'part1\npart2\n');
  assert.equal(r.code, 0);
});

// T7 — INVERTED on card 2026-0312, and the ORDER inverts with the content. The
// R5 notice said a shell had been RESTARTED and went out FIRST, ahead of output
// that might be wrong because the exports were gone. There is no restart; what a
// worker now needs to be told is that its `cd` was discarded, and that cannot be
// known until the command has ended — so the notice arrives LAST.
//
// NOT CLAIMING that the CLI's own wording matches cc's. The CLI prints its own
// line when ITS shell's cwd moves; cc's string is its own and is pinned here.
test('the cwd notice reaches the sink AFTER the command output, and carries cc\'s own wording', async () => {
  await fs.mkdir(onSystem('sub'), { recursive: true });
  const state = { settled: false };
  const { seen, sink } = recordingSink(state);
  const r = await redirect.runForwarded('cd sub; echo after', { sink });
  state.settled = true;

  assert.equal(seen.at(-1).k, 'notice', 'the notice is the LAST thing the sink saw');
  assert.ok(seen.some(x => x.k === 'out' && x.t.includes('after')), 'the output came first');
  assert.equal(r.notice, seen.at(-1).t, 'and it is the same notice the aggregate carries');
  assert.ok(r.notice.startsWith('[cc] '), r.notice);
  assert.ok(r.notice.includes(`ended in ${path.join(remote.root, 'sub')}`), r.notice);
  assert.ok(r.notice.includes(`starts at ${remote.root}`), r.notice);
  assert.ok(r.notice.includes(`system '${remote.id}'`), r.notice);
});

// T7's SILENCE HALF, and it is not decoration: a notice on every command is
// noise, and noise is itself a divergence from a local session, where nothing is
// said unless the cwd actually moved.
test('a command that does not move the cwd is told nothing', async () => {
  assert.equal((await bash('echo plain')).notice, null);
  assert.equal((await bash('pwd')).notice, null);
  // A `cd` in a SUBSHELL never moves the command's own cwd, so there is nothing
  // to report — the notice reads the shell's answer, not the command's text.
  await fs.mkdir(onSystem('sub'), { recursive: true });
  assert.equal((await bash('(cd sub && pwd)')).notice, null);
  // THE POSITIVE CONTROL, in the same test: without it every assertion above is
  // satisfied by a notice channel that never fires at all.
  assert.notEqual((await bash('cd sub')).notice, null,
    'a command that really did move IS reported');
});

// PINS: cc's own failure text reaches the sink too. The route no longer writes
// the aggregate — it has already streamed — so a failure that only landed in
// the return value would reach the worker as an empty result.
test('a command that kills the shell reports its failure through the sink', async () => {
  const state = { settled: false };
  const { sink, textOf } = recordingSink(state);
  const r = await redirect.runForwarded('exit', { sink });
  state.settled = true;

  assert.notEqual(r.code, 0);
  assert.equal(textOf('err'), r.stderr, 'the sink carries the same diagnostic as the aggregate');
  assert.match(textOf('err'), /cc:/);
});

// PINS B3 AT THE REDIRECT LAYER: a runaway command reaches the WORKER as a
// named failure on stderr and a non-zero exit — the channel a worker reads —
// rather than as an orchestrator that ran out of heap and took every other
// session with it.
test('a runaway command is refused by name instead of exhausting the orchestrator', async () => {
  await build({ maxOutputBytes: 8192 });
  const r = await bash('head -c 200000 /dev/zero | base64');
  assert.notEqual(r.code, 0, 'a fence is a FAILURE, not a truncated success');
  assert.match(r.stderr, /output exceeded the 8192-byte limit/);
  // And the session is still usable.
  assert.equal((await bash('echo alive')).stdout, 'alive\n');
});

// PINS B1 AT THE REDIRECT LAYER: an interrupt cancels THAT call and nothing
// else. The unrelated concurrent command completes normally, and the cancelled
// one's write does not land on the system — its effects must not, when its
// caller has gone away.
//
// RE-FRAMED, NOT RETIRED, on card 2026-0312: the cancelled call used to be one
// waiting for its TURN on a shell, and there is no turn any more. WHAT IT PINS
// IS THE EFFECT, not a call stopped short: instrumented, this test's
// cancellation throws at the re-check AFTER `exec` returns, and the reference
// provider is measured to have SPAWNED the `touch` and killed it before it ran
// (card 2026-0328 §1, §5). The witness's absence below is that kill winning the
// race, which card 2026-0331 tracks.
test('a cancelled call\'s write does not land, and a concurrent one is untouched', async () => {
  const witness = onSystem('QUEUED_RAN');
  const inFlight = redirect.runForwarded('sleep 0.4; echo survivor', {});
  const ac = new AbortController();
  const queued = redirect.runForwarded(`touch ${JSON.stringify(witness)}`, { signal: ac.signal });
  ac.abort();

  const cancelled = await queued;
  assert.notEqual(cancelled.code, 0, 'the cancelled call reports a failure');
  const survived = await inFlight;
  assert.equal(survived.code, 0, 'the unrelated in-flight command was untouched');
  assert.equal(survived.stdout, 'survivor\n');
  await assert.rejects(fs.stat(witness), 'the cancelled command\'s write did not land on the system');
});

// PINS B2: interrupting the IN-FLIGHT command stops it on the system — in both
// capability modes, including the fallback where there is no live stream to
// close. A worker's interrupt that leaves the command running is not an
// interrupt.
//
// ITS BOUNDARY TWIN is `interrupting one call stops it inside the container and
// leaves a concurrent call alone` in tests/systems-docker-boundary.real.test.mjs
// — the same shape, witnessed from inside the container instead of on cc's own
// filesystem. Card 2026-0312 re-based THIS file and missed that one, which then
// sat red unnoticed because that suite is opt-in behind `RUN_DOCKER_SYSTEM=1` and
// is in neither gated command (card 2026-0327). Change one, change both.
//
// NOT the same claim as the RE-FRAMED test above, and the difference is what
// each test puts between ISSUING the call and CANCELLING it. That one puts
// nothing there — it aborts on the next statement, so it never establishes that
// the command started. This one interposes a delay, and its boundary twin goes
// further still and waits for the far-side process to appear. So the RE-FRAMED
// test has no boundary twin and needs none: a boundary copy of a cancel that
// nothing saw start would have its marker's absence satisfied by a command that
// never ran, which is the vacuity that file's own NON-VACUITY wait exists to
// remove.
test('interrupting the in-flight command stops it on the system', async () => {
  const witness = onSystem('STILL_RUNNING');
  const ac = new AbortController();
  const running = redirect.runForwarded(`sleep 0.4; touch ${JSON.stringify(witness)}`, { signal: ac.signal });
  await new Promise(r => setTimeout(r, 120));
  ac.abort();
  const r = await running;
  assert.notEqual(r.code, 0);
  await new Promise(r2 => setTimeout(r2, 500));
  await assert.rejects(fs.stat(witness), 'the interrupted command is not still running');
});

// PINS T5 — THE ACTUAL REAL-WORLD SHAPE, not just the guards. A long build is
// in flight and STREAMING; a second call is issued alongside it; that second
// call's caller is interrupted.
//
// LIVE, not merely started: the test waits for the long command's first bytes to
// reach cc before issuing the second, so the cancellation lands against a
// command that is genuinely mid-flight rather than one still being handed over.
//
// Every claim is witnessed on the SYSTEM's filesystem, because cc's own return
// value cannot tell "was not run" from "was run and its result discarded":
// `ProviderShell`'s pre-crossing check and its post-exec re-check throw the SAME
// `cancelled()`, so the caller sees one indistinguishable failure whether the
// call was stopped before it crossed or crossed and had its result thrown away
// (card 2026-0327).
test('cancelling one call leaves a live concurrent command untouched', async () => {
  const seen = [];
  const sink = { notice: (t) => seen.push(['notice', t]), out: () => {}, err: () => {} };

  const streamed = [];
  const inFlight = redirect.runForwarded(
    "printf 'A1\n'; sleep 1; printf 'A2\n'; touch A_DONE",
    { sink: { ...sink, out: (t) => streamed.push(t) } },
  );
  await waitFor(() => streamed.join('').includes('A1'), { timeout: 5000 });

  const ac = new AbortController();
  const cancelledCall = redirect.runForwarded('touch B_WITNESS', { signal: ac.signal, sink });
  ac.abort();

  const b = await cancelledCall;
  assert.equal(b.code, 1, 'the cancelled call reports a failure');
  assert.match(b.stderr, /interrupt|cancel/i, b.stderr);

  const a = await inFlight;
  assert.equal(a.code, 0, `the unrelated in-flight command completed normally: ${a.stderr}`);
  assert.equal(a.stdout, 'A1\nA2\n', 'with ALL of its output, not a truncated prefix');

  // The system's own account: A ran to completion, and B's write did not land.
  assert.ok(await fs.stat(onSystem('A_DONE')).catch(() => null), 'A finished on the system');
  await assert.rejects(fs.stat(onSystem('B_WITNESS')), 'B\'s write did not land on the system');

  // And nothing was reset — the cancelled command's `exec` was killed and no
  // state was shared for anyone to lose — so a notice here would tell a worker
  // it lost state it never had.
  assert.equal(a.notice, null);
  assert.equal(b.notice, null);
  assert.deepEqual(seen.filter(([k]) => k === 'notice'), []);
  const after = await bash('echo "[$CC_PROBE_UNSET]"');
  assert.equal(after.notice, null, 'and the next command is not told about a reset either');
});

// PINS: exit codes are the command's own, not the forwarder's.
test('a forwarded command reports the real exit code', async () => {
  assert.equal((await bash('true')).code, 0);
  assert.equal((await bash('false')).code, 1);
  assert.equal((await bash('ls /definitely-not-here')).code, 2);
  assert.equal((await bash("bash -c 'exit 7'")).code, 7);
});

// PINS: a Read under the session root pulls the system's bytes to the local
// path FIRST, so the CLI's own local read answers about the system's file.
test('Read under the session root pulls before the tool runs', async () => {
  await fs.writeFile(onSystem('greeting.py'), 'print("from the system")\n');
  const d = await pre('Read', { file_path: inSession('greeting.py') });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined, 'the path is NOT rewritten — the CLI reads locally');
  assert.equal(await fs.readFile(inSession('greeting.py'), 'utf8'), 'print("from the system")\n');
});

// PINS: pull-before-EDIT, which is what makes the mixed Bash-write / Edit case
// safe — a worker that `sed -i`s through Bash and then Edits the same file is
// the normal case.
test('Edit pulls the file again, so a Bash write earlier in the turn is not clobbered', async () => {
  await fs.writeFile(onSystem('mixed.txt'), 'original\n');
  await pre('Read', { file_path: inSession('mixed.txt') });
  await bash("printf 'changed by bash\\n' > mixed.txt");

  await pre('Edit', { file_path: inSession('mixed.txt'), old_string: 'a', new_string: 'b' });
  assert.equal(await fs.readFile(inSession('mixed.txt'), 'utf8'), 'changed by bash\n');
});

// PINS: PostToolUse pushes the local result back to the system, and says so.
test('PostToolUse pushes an edit back to the system and states where it landed', async () => {
  await fs.writeFile(onSystem('app.js'), 'const a = 1\n');
  await pre('Edit', { file_path: inSession('app.js'), old_string: '1', new_string: '2' });
  await fs.writeFile(inSession('app.js'), 'const a = 2\n');

  const note = await post('Edit', { file_path: inSession('app.js') }, { filePath: inSession('app.js') });
  assert.equal(await fs.readFile(onSystem('app.js'), 'utf8'), 'const a = 2\n');
  assert.match(note, new RegExp(onSystem('app.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(note, new RegExp(remote.id));
});

// PINS: a failed push is a HARD, LOUD failure — it names the divergence on the
// spot and REFUSES the next write to that path, so a worker can never come away
// believing an edit reached the system when it did not.
test('a failed push names the divergence and denies the next write to that path', async () => {
  await fs.mkdir(onSystem('d'), { recursive: true });
  await fs.writeFile(onSystem('d/f.txt'), 'system copy\n');
  await pre('Edit', { file_path: inSession('d/f.txt'), old_string: 'a', new_string: 'b' });
  await fs.writeFile(inSession('d/f.txt'), 'local edit\n');
  // Break the push: the parent directory becomes a file on the system.
  await fs.rm(onSystem('d'), { recursive: true });
  await fs.writeFile(onSystem('d'), 'not a directory\n');

  const note = await post('Edit', { file_path: inSession('d/f.txt') }, {});
  assert.match(note, /did not reach/);
  assert.ok(events.some(e => e.kind === 'system' && JSON.stringify(e).includes('did not reach')),
    'the failure is surfaced to the operator, not only to the model');

  const denied = await pre('Edit', { file_path: inSession('d/f.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /did not reach/);
});

// PINS: THE BOUNDARY. A local path with no counterpart on the system and no
// business being local is REFUSED, not quietly written to cc's disk where Bash
// can never see it.
test('a file tool aimed outside the session root is refused by name', async () => {
  for (const p of [path.join(os.tmpdir(), 'cc-redirect-scratch.txt'), '/etc/hosts', onSystem('greeting.py')]) {
    const d = await pre('Write', { file_path: p, content: 'x' });
    assert.equal(d.decision, 'deny', p);
    assert.match(d.reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// PINS: the prefix rule's other half — a path cc KNOWS is local (an attachment
// under the store, a plan under ~/.claude) passes through untouched. Refusing
// those would break attachments on a remote project.
test('a known-local path passes through untouched', async () => {
  const local = path.join(home, 'local-ok', 'note.txt');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'attachment\n');
  const d = await pre('Read', { file_path: local });
  assert.equal(d.decision, 'allow');
  assert.equal(d.updatedInput, undefined);
});

// PINS THE SECOND GUARD on the one non-negotiable invariant: if Glob or Grep
// ever reaches the hook — the injected `permissions.deny` having failed, or the
// CLI's tool profile having changed — it is REFUSED by name, not allowed to
// answer about cc's session root. A search answering about the wrong machine is
// exactly the leak that makes a worker distrust every other tool result.
test('Glob and Grep are refused by name if they ever reach the hook', async () => {
  for (const tool of ['Glob', 'Grep']) {
    const d = await pre(tool, { pattern: '**/*.js' });
    assert.equal(d.decision, 'deny', tool);
    assert.match(d.reason, /Bash/, 'and it names the tool that answers about the right machine');
    assert.match(d.reason, new RegExp(remote.id));
  }
});

// PINS S6: a file tool whose path is not absolute is REFUSED rather than let
// through. The CLI was measured resolving to absolute before the hook fires, so
// this is unreachable today — but letting it through meant PreToolUse skipped
// the pull while PostToolUse would still have pushed, and the invariant should
// not depend on an undocumented CLI behaviour staying put.
test('a relative file path is refused rather than passed through unpulled', async () => {
  for (const tool of ['Read', 'Write', 'Edit']) {
    const d = await pre(tool, { file_path: 'relative/path.txt' });
    assert.equal(d.decision, 'deny', `${tool} let a relative path through`);
    assert.match(d.reason, /absolute/);
  }
  const nb = await pre('NotebookEdit', { notebook_path: './nb.ipynb' });
  assert.equal(nb.decision, 'deny');
});

// PINS: and nothing is pushed for one either, so the two halves cannot
// disagree about which paths they handle.
test('a relative path is never pushed back', async () => {
  await fs.writeFile(path.join(root, 'rel.txt'), 'local only\n');
  assert.equal(await post('Edit', { file_path: 'rel.txt' }, {}), null);
  await assert.rejects(fs.stat(onSystem('rel.txt')), 'nothing was written to the system');
});

// PINS T2: the push half's ABSOLUTE check, against its own window rather than
// against a containment test that happens to fire first.
//
// The case above is stopped one guard later: `toSystem` resolves a relative path
// against the test process's cwd, which lies outside the session root, so
// containment answers null for a reason that has nothing to do with the guard.
// The two halves can genuinely disagree — a cwd INSIDE the session root gives a
// relative path a real system mapping — and that is the shape a push must still
// refuse, because PreToolUse refused the same path and so never pulled it.
//
// Driven by making the session root the process's OWN cwd, which is the only way
// to reach the disagreement without a global chdir. `package.json` is read, never
// written: with the guard gone it is the repo's file that would land on the
// system, which is exactly the harm.
test('a relative path that DOES map into the session root is still not pushed', async () => {
  const here = new SessionRedirect({
    system: await systemById(remote.id, null, 'test'),
    systemId: remote.id,
    systemPath: remote.root,
    sessionRoot: process.cwd(),
    mirror: noMirror(remote.root),
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [],
    emit: () => {},
  });
  try {
    // The premise: relative here really does map onto the system.
    assert.ok(here.map.toSystem(path.resolve('package.json')) !== null,
      'the fixture reaches the disagreement — an absolute spelling of this path maps');

    assert.equal(await here.postToolUse('Write', { file_path: 'package.json' }, {}), null,
      'a relative path is refused by the push half itself');
    await assert.rejects(fs.stat(onSystem('package.json')), 'the repo file never reached the system');
  } finally { await here.close(); }
});

// PINS: R2's annotation is TARGETED — it fires only when the output actually
// shows a system path, so the model is not fed a note on every command.
test('a Bash result is annotated only when it actually shows a system path', async () => {
  const shown = await post('Bash', {}, { stdout: `cwd is ${remote.root}\n`, stderr: '' });
  assert.ok(shown && shown.includes(remote.id));

  assert.equal(await post('Bash', {}, { stdout: 'all tests passed\n', stderr: '' }), null);
});

// T3 — A LIVE PRE-EXISTING DEFECT, FOUND WHILE PLANNING THIS CARD AND FIXED ON
// IT. `SessionRedirect.close()` did not reap an in-flight command in the
// one-shot mode — the mode card 2026-0312 makes the only mode. It closed
// SHELLS, and in one-shot mode there is no shell, so nothing reached the
// running `exec`.
//
// MEASURED IN BOTH MODES BEFORE THE STRIP, identical rig, with a witness file
// that only appears if the command completes: the persistent mode gave
// `code=1` and the command did NOT complete; the fallback gave `code=0` WITH
// THE COMMAND'S OUTPUT, having run to completion on the far side 1.2s after
// the session was torn down. Reachable in production TODAY on any provider that
// did not advertise `persistentShell` — this card does not introduce it, it
// PROMOTES a fallback-only defect to the only behaviour, so shipping the strip
// without the fix ships a regression in effect.
//
// THE WITNESS IS THE FAR SIDE'S OWN FILESYSTEM. cc's bookkeeping cannot tell
// teardown from forgetting: `close()` drops its handle either way, so any
// assertion about cc's own state reads clean while the command is still running
// on someone else's machine. Only a file the command writes AFTER a delay can.
//
// NOT CLAIMING: any ordering between the abort and the command's own exit, nor
// that the far-side process is gone by any particular instant — only that the
// command did not run to completion.
test('close() reaps a command that is still in flight', async () => {
  const witness = onSystem('LATE_WITNESS');
  const streamed = [];
  const inFlight = redirect.runForwarded(
    `printf 'RUNNING\\n'; sleep 1.2; touch ${JSON.stringify(witness)}; echo late`,
    { sink: { notice: () => {}, out: (t) => streamed.push(t), err: () => {} } },
  );
  // GENUINELY IN FLIGHT, not merely issued: the first bytes have crossed back to
  // cc, so the command is running on the system when close() lands.
  await waitFor(() => streamed.join('').includes('RUNNING'), { timeout: 5000 });

  await redirect.close();
  const r = await inFlight;
  assert.notEqual(r.code, 0, `the caller is told the command failed: ${JSON.stringify(r)}`);

  // Past when the command would have written it, had it survived teardown.
  await new Promise(res => setTimeout(res, 1500));
  await assert.rejects(fs.stat(witness),
    'the command must not have run to completion on the far side after close()');

  // And close() is idempotent, which instance exit + kill + discardAll all rely
  // on: they can each reach it for the same session.
  await redirect.close();
});

// S1 — PINS THAT `runForwarded` DETACHES WHAT IT ATTACHED. It relays two abort
// sources into a per-call controller, and the `removeEventListener` loop in its
// `finally` is what keeps the SESSION-lived controller from accumulating one
// listener per command the session has ever run. That leak was measured before
// the fix: `AbortSignal.any([caller, session])` grew heapUsed linearly with the
// command count, while this shape stayed flat — and the identical shape WITHOUT
// the removal grew just as `any` did, which is what isolates the removal as the
// thing that matters.
//
// THE CALLER'S SIGNAL IS THE OBSERVABLE, and it is enough: both sources are
// detached by the SAME loop, so deleting it leaves a listener on both. The
// session controller is private to `SessionRedirect` and cannot be reached from
// here; the caller's is handed in by this test.
//
// THE EVENT-NAME FORM IS REQUIRED. `getEventListeners(sig, 'abort')` reads 1 for
// one ordinary listener and 0 after its removal; the no-name form
// `getEventListeners(sig)` reads 0 either way, so an assertion written with it
// would pass whether or not the removal ran.
//
// BOTH OUTCOMES, because the removal is in a `finally` and a pin on the success
// path alone would not notice it moving into the `try`.
//
// NOT CLAIMING the absence of a leak — that is a heap measurement, and it is
// recorded in the comment at the call site rather than asserted here. What is
// asserted is the mechanism the measurement identified.
test('runForwarded leaves no abort listener on its caller signal, on either outcome', async () => {
  const ok = new AbortController();
  assert.equal(getEventListeners(ok.signal, 'abort').length, 0, 'the premise: a fresh signal has none');
  const good = await redirect.runForwarded('echo fine', { signal: ok.signal });
  assert.equal(good.code, 0, good.stderr);
  assert.equal(getEventListeners(ok.signal, 'abort').length, 0,
    'a command that SUCCEEDED detached its relay');

  // The failure path through the same `finally`: a command that destroys its own
  // framing throws inside the try and is caught, and must detach just the same.
  const bad = new AbortController();
  const failed = await redirect.runForwarded('exit', { signal: bad.signal });
  assert.notEqual(failed.code, 0, 'the premise: this command failed');
  assert.equal(getEventListeners(bad.signal, 'abort').length, 0,
    'and a command that FAILED detached its relay too');

  // And a signal that actually FIRES: `{once:true}` detaches a listener that
  // ran, so this half would pass even without the removal — it is here so the
  // three shapes are not confused for one another by a later reader.
  const aborted = new AbortController();
  const running = redirect.runForwarded('sleep 5', { signal: aborted.signal });
  await new Promise(r => setTimeout(r, 120));
  aborted.abort();
  await running;
  assert.equal(getEventListeners(aborted.signal, 'abort').length, 0);
});

// PINS THE HALF THAT MAKES THE FIX ABOVE SAFE, and it is not hypothetical: a
// REWIND/RESPAWN calls `close()` too (src/instances.ts) — the CLI's prefix is
// rewritten, so whatever was running belongs to a conversation the worker no
// longer has — and the SAME redirect then serves the next turn. A teardown lever
// that stayed pulled would make every command after any rewind fail ECANCELLED
// the instant it was issued, on every remote session.
//
// FOUND BY THIS SUITE'S SIBLING, not by reasoning: the first version of the fix
// aborted a single controller once, and six end-to-end tests in
// tests/systems-remote-worker.test.mjs went red with
// `cc: the command was cancelled by its caller`.
//
// NOT CLAIMING that anything survives the close — nothing does, deliberately.
test('a redirect keeps working after close(), because a rewind calls it too', async () => {
  assert.equal((await bash('echo before')).stdout.trim(), 'before');
  await redirect.close();
  const after = await bash('echo after');
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.stdout.trim(), 'after', 'the next command runs normally, not ECANCELLED');
});

// PINS: `@mention` pre-hydration pulls the named file into the session root
// BEFORE the prompt reaches the CLI — the CLI expands a mention with no hook,
// so a file that is not already local is simply absent from the turn.
test('@mention pre-hydration pulls the named files before the prompt is sent', async () => {
  await fs.mkdir(onSystem('docs'), { recursive: true });
  await fs.writeFile(onSystem('docs/spec.md'), '# the spec\n');
  await redirect.hydrateMentions('please read @docs/spec.md and @nope/missing.md then stop');
  assert.equal(await fs.readFile(inSession('docs/spec.md'), 'utf8'), '# the spec\n');
});

// ── A WIDE MIRROR: the two things it would silently break (card 2026-0259) ──
//
// Before P7 one field — the map's far end — was three things at once: the
// mapping anchor, the shell's cwd, and the needle the Bash annotation looks
// for. Widening it to a mirror root would have repurposed all three. These pin
// the two that are outright defects.

// A redirect whose mirror is the whole filesystem, with the project still where
// it was. The provider is recorded so an assertion can be made on the frame cc
// actually sent rather than on a command appearing to succeed.
async function wideRedirect() {
  const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
  await addSystem({ id: 'widebox', label: 'wide', launch: ['node', RECORDER, '--record', rec] });
  const image = path.join(home, 'wide-image');
  await fs.mkdir(image, { recursive: true });
  const wide = new SessionRedirect({
    system: await systemById('widebox', null, 'test'),
    systemId: 'widebox',
    systemPath: remote.root,
    sessionRoot: image,
    // `/` is the widest mirror there is, and the one every one of these
    // assertions is degenerate without.
    mirror: { mirrorRoot: '/', exclude: [], offset: remote.root.replace(/^\//, '') },
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [],
    emit: () => {},
  });
  return { wide, rec, image };
}

// PINS 8b: the Bash annotation's needle is the PROJECT's path, not the mirror
// root. Under `mirrorRoot: '/'` the mirror root is a substring of essentially
// every path any command prints, so a needle taken from the map would attach
// R2's deliberately targeted note to every single Bash call.
//
// NOT CLAIMING: that the annotation's wording is right — the existing test
// above owns that.
test('a wide mirror does not turn the targeted Bash annotation into an every-command one', async () => {
  const { wide } = await wideRedirect();
  try {
    // Output full of `/` and naming no project path: silent.
    assert.equal(await wide.postToolUse('Bash', {}, { stdout: '/usr/bin/env\n/etc/hosts\n', stderr: '' }), null);
    assert.equal(await wide.postToolUse('Bash', {}, { stdout: '/\n', stderr: '' }), null);
    // Output naming the project path: exactly one note, naming the project.
    const note = await wide.postToolUse('Bash', {}, { stdout: `cwd is ${remote.root}\n`, stderr: '' });
    assert.ok(note && note.includes(remote.root), note);
    assert.ok(!note.includes('Paths under / in'), 'and it names the project, not the mirror root');
  } finally { await wide.close(); }
});

// PINS 8c: EVERY COMMAND runs from the PROJECT root under a wide mirror, not
// from the mirror root. Asserted on the `exec` frame's `cwd` ON THE WIRE — a
// direct measurement of the binding, where `pwd` succeeding would only show that
// some directory existed on a machine where every directory does.
//
// TWO COMMANDS, not one, and the second follows a `cd`: under a wide mirror the
// binding and the carry would fail differently, and a single command cannot tell
// "seeded at the project root" from "carried from the project root".
//
// NOT CLAIMING: that the shell runs there; the framing suite owns that.
test('a wide mirror still runs every command at the project root', async () => {
  const { wide, rec } = await wideRedirect();
  try {
    await wide.runForwarded('cd /', {});
    await wide.runForwarded('true', {});
    const frames = (await fs.readFile(rec, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const cwds = frames.filter(f => f.type === 'exec').map(f => f.cwd);
    assert.ok(cwds.length >= 2, `two commands ran: ${JSON.stringify(cwds)}`);
    for (const cwd of cwds) {
      assert.equal(cwd, remote.root, 'every command ran at the project root, never at the mirror root');
    }
    assert.ok(!cwds.includes('/'), 'and never at `/`');
  } finally { await wide.close(); }
});

// PINS 8d: an `@mention` is resolved against the CLI's OWN cwd — the project's
// directory inside the image — not against the image root. Under a wide mirror
// those are different directories, and resolving against the wrong one pulls a
// file nobody named.
//
// NOT CLAIMING: that the CLI expands the mention the same way; that is measured
// CLI behaviour the hydration exists to serve.
test('a mention resolves against the CLI cwd, not the image root', async () => {
  const { wide, image } = await wideRedirect();
  try {
    await fs.writeFile(path.join(remote.root, 'NOTES.md'), 'project notes\n');
    await wide.hydrateMentions('please read @NOTES.md');
    assert.equal(await fs.readFile(path.join(image, remote.root.replace(/^\//, ''), 'NOTES.md'), 'utf8'),
      'project notes\n', 'it landed at the project\'s place inside the image');
    await assert.rejects(fs.readFile(path.join(image, 'NOTES.md')),
      'and not at the image root, which is a different directory entirely');
  } finally { await wide.close(); }
});
