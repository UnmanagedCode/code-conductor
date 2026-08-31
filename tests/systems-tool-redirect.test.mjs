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
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

let home, remote, redirect, root, events;

async function build({ flags = [], idleTtlMs, shellCommandTimeoutMs, maxOutputBytes } = {}) {
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
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [path.join(home, 'local-ok')],
    emit: (ev) => events.push(ev),
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
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
const pre = (tool, input, agentId) => redirect.preToolUse(tool, input, agentId);
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

// PINS: a forwarded command runs on the SYSTEM, not on cc. Both directions are
// asserted, so a forwarder that quietly ran locally cannot pass.
test('a forwarded command runs on the system and not on cc', async () => {
  const hit = await bash('cat ONLY-ON-SYSTEM.txt');
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout, 'system side\n');

  const miss = await bash('cat ONLY-ON-CC.txt');
  assert.notEqual(miss.code, 0);
});

// PINS: ONE AGENT's shell is long-lived — `cd` and `export` carry between that
// agent's commands, and cwd is read back from the shell rather than parsed out of
// the command. Every call here is the main agent's; the isolation BETWEEN agents
// is tests/systems-agent-shells.test.mjs's subject.
test('the redirected shell carries cwd and exports between commands', async () => {
  await fs.mkdir(onSystem('sub'), { recursive: true });
  await bash('cd sub');
  const pwd = await bash('pwd');
  assert.equal(pwd.stdout.trim(), path.join(remote.root, 'sub'));

  await bash('export CC_PROBE=carried');
  const echo = await bash('echo "$CC_PROBE"');
  assert.equal(echo.stdout.trim(), 'carried');
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

// PINS: the R5 reset notice reaches the sink FIRST, ahead of the command's own
// output. A shell that lost its exports has to say so before the output that
// might be wrong because of it.
test('the reset notice reaches the sink before any of the command output', async () => {
  await bash('export CC_PROBE=before');
  await bash('exit');

  const state = { settled: false };
  const { seen, sink } = recordingSink(state);
  const r = await redirect.runForwarded('echo after', { sink });
  state.settled = true;

  assert.equal(seen[0].k, 'notice', 'the notice is the FIRST thing the sink saw');
  assert.match(seen[0].t, /restarted/);
  assert.equal(r.notice, seen[0].t, 'and it is the same notice the aggregate carries');
  assert.match(seen.filter(x => x.k === 'out').map(x => x.t).join(''), /after/);
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
// else. The unrelated in-flight command completes normally, and the cancelled
// one never runs on the system — its effects must not land when its caller has
// gone away.
test('interrupting a queued command leaves the in-flight one alone and never runs it', async () => {
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
  await assert.rejects(fs.stat(witness), 'the cancelled command never ran on the system');
});

// PINS B2: interrupting the IN-FLIGHT command stops it on the system — in both
// capability modes, including the fallback where there is no live stream to
// close. A worker's interrupt that leaves the command running is not an
// interrupt.
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
// in flight on a LIVE, streaming shell; a second call is queued behind it; that
// second call's caller is interrupted.
//
// The neighbouring cancellation tests abort synchronously right after invoking,
// so they always race the shell OPEN and exercise the pre-open window. This one
// waits for the in-flight command's first bytes to arrive before queuing behind
// it, which is the only way the queued call is cancelled against a shell that is
// genuinely mid-command.
//
// Every claim is witnessed on the SYSTEM's filesystem, which is the only witness
// that can tell "was not run" from "was run and its result discarded".
test('interrupting a queued call leaves a live in-flight command untouched', async () => {
  const seen = [];
  const sink = { notice: (t) => seen.push(['notice', t]), out: () => {}, err: () => {} };

  const streamed = [];
  const inFlight = redirect.runForwarded(
    "printf 'A1\n'; sleep 1; printf 'A2\n'; touch A_DONE",
    { sink: { ...sink, out: (t) => streamed.push(t) } },
  );
  // LIVE, not merely started: the first bytes have crossed to cc, so the shell
  // is past its open and mid-command.
  await waitFor(() => streamed.join('').includes('A1'), { timeout: 5000 });

  const ac = new AbortController();
  const queued = redirect.runForwarded('touch B_WITNESS', { signal: ac.signal, sink });
  ac.abort();

  const b = await queued;
  assert.equal(b.code, 1, 'the cancelled call reports a failure');
  assert.match(b.stderr, /interrupt|cancel/i, b.stderr);

  const a = await inFlight;
  assert.equal(a.code, 0, `the unrelated in-flight command completed normally: ${a.stderr}`);
  assert.equal(a.stdout, 'A1\nA2\n', 'with ALL of its output, not a truncated prefix');

  // The system's own account: A ran to completion, B never ran at all.
  assert.ok(await fs.stat(onSystem('A_DONE')).catch(() => null), 'A finished on the system');
  await assert.rejects(fs.stat(onSystem('B_WITNESS')), 'B never ran on the system');

  // And no shell was reset, so nothing has a reset to report — a spurious notice
  // would tell a worker it lost state it still has.
  assert.equal(a.notice, null);
  assert.equal(b.notice, null);
  assert.deepEqual(seen.filter(([k]) => k === 'notice'), []);
  const after = await bash('echo "[$CC_PROBE_UNSET]"');
  assert.equal(after.notice, null, 'and the next command is not told about a reset either');
});

// PINS B2 IN THE FALLBACK MODE, at the redirect layer. R5's abort was
// implemented only as a shell close, and in `persistentShell:false` there is no
// live stream and no retained exec id — so the close reached nothing and the
// interrupted command ran to completion on the system, bounded only by the
// worker's own Bash timeout. D10 makes the fallback the deliverable, not a
// degraded mode, so an interrupt that does nothing there fails the phase.
test('[persistentShell:false] interrupting stops the command, and a queued one never runs', async () => {
  await build({ flags: ['--no-persistent-shell'] });
  const running = onSystem('FB_STILL_RUNNING');
  const queued = onSystem('FB_QUEUED_RAN');

  const inFlight = redirect.runForwarded(`sleep 0.5; touch ${JSON.stringify(running)}`, {});
  const ac = new AbortController();
  const q = redirect.runForwarded(`touch ${JSON.stringify(queued)}`, { signal: ac.signal });
  ac.abort();
  assert.notEqual((await q).code, 0);
  await inFlight;
  await assert.rejects(fs.stat(queued), 'the cancelled queued command never ran');

  // And the in-flight half: interrupt one that is actually running.
  const ac2 = new AbortController();
  const p = redirect.runForwarded(`sleep 0.5; touch ${JSON.stringify(running)}`, { signal: ac2.signal });
  await new Promise(r => setTimeout(r, 120));
  ac2.abort();
  assert.notEqual((await p).code, 0);
  await fs.rm(running, { force: true });
  await new Promise(r => setTimeout(r, 700));
  await assert.rejects(fs.stat(running), 'the interrupted command is not still running on the system');
});

// PINS S1: the reset notice goes to the command that RUNS on the fresh shell,
// not to whichever call was constructed next. Here the aborted command resets
// the shell and a call that was already queued behind it is the one that runs
// on the replacement — so it is the one that must be told its exports are gone.
test('the reset notice lands on the command that runs on the new shell', async () => {
  await bash('export CC_PROBE=before');
  const notices = [];
  const mkSink = (tag) => ({
    notice: (t) => notices.push({ tag, t }),
    out: () => {}, err: () => {},
  });

  const ac = new AbortController();
  const doomed = redirect.runForwarded('sleep 0.4; echo doomed', { signal: ac.signal, sink: mkSink('doomed') });
  const queued = redirect.runForwarded('echo "[$CC_PROBE]"', { sink: mkSink('queued') });
  await new Promise(r => setTimeout(r, 120));
  ac.abort();
  await doomed;
  const after = await queued;

  assert.equal(after.stdout, '[]\n', 'it really did run on a shell that had lost the export');
  assert.deepEqual(notices.map(n => n.tag), ['queued'],
    'exactly one notice, and it went to the command that ran on the new shell');
  assert.match(notices[0].t, /restarted/);
  assert.equal(after.notice, notices[0].t);
});

// PINS: a notice is delivered ONCE. A command that follows a reported reset
// must not be told about a reset it never experienced.
test('a reset is reported exactly once', async () => {
  await bash('exit');
  const first = await bash('echo one');
  assert.match(first.notice ?? '', /restarted/);
  const second = await bash('echo two');
  assert.equal(second.notice, null);
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

// PINS: a shell that had to be restarted TELLS the worker, rather than
// restoring cwd and looking continuous while its exports are silently gone.
test('a restarted shell tells the worker what it lost', async () => {
  await bash('export CC_PROBE=before');
  // `exit` inside the framed command group takes the shell with it, so no
  // sentinel can arrive — one of the two wedge modes, both of which reset.
  const died = await bash('exit');
  assert.notEqual(died.code, 0);

  const after = await bash('echo "[$CC_PROBE]"');
  assert.equal(after.code, 0);
  assert.match(after.notice, /restarted/);
  assert.match(after.notice, /export/i);
  assert.equal(after.stdout.trim(), '[]', 'the export really is gone — the notice is not decorative');
  // Told ONCE: the next command is ordinary again.
  assert.equal((await bash('true')).notice, null);
});

// PINS: an idle shell is closed rather than held open for the life of the
// session, and the next command transparently opens a fresh one.
test('an idle shell is closed on its TTL', async () => {
  await redirect.close();
  await build({ idleTtlMs: 40 });
  await bash('true');
  assert.equal(redirect.shellOpen, true);
  await waitFor(() => redirect.shellOpen === false, { timeout: 4000 });
  assert.equal((await bash('echo alive')).stdout.trim(), 'alive');
});

// PINS C6: an idle-TTL close TELLS the next command, exactly as a wedge or an
// interrupt does. The sweep is cc's own decision, made while the worker was
// away, so a shell that silently looks continuous while its exports are gone is
// the same R5 violation — and this path used to be the silent one.
test('an idle-TTL close tells the next command what it lost', async () => {
  await redirect.close();
  await build({ idleTtlMs: 40 });
  await bash('export CC_PROBE=before');
  await waitFor(() => redirect.shellOpen === false, { timeout: 4000 });

  const notices = [];
  const after = await redirect.runForwarded('echo "[$CC_PROBE]"', {
    sink: { notice: (t) => notices.push(t), out: () => {}, err: () => {} },
  });
  assert.equal(after.stdout, '[]\n', 'it really did run on a shell that had lost the export');
  assert.equal(notices.length, 1, 'the idle close is reported, not silent');
  assert.match(notices[0], /restarted/);
  assert.equal(after.notice, notices[0]);
  // And once only.
  assert.equal((await bash('echo again')).notice, null);
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

// PINS: with the persistent-shell capability absent, a redirected Bash still
// works and still carries cwd — the fallback is the deliverable, not the flag.
test('the persistentShell fallback still runs commands and carries cwd', async () => {
  await redirect.close();
  await build({ flags: ['--no-persistent-shell'] });
  await fs.mkdir(onSystem('sub'), { recursive: true });
  assert.equal((await bash('cat ONLY-ON-SYSTEM.txt')).stdout, 'system side\n');
  await bash('cd sub');
  assert.equal((await bash('pwd')).stdout.trim(), path.join(remote.root, 'sub'));
  // Exactly the local CLI's own behaviour: cwd carries, exports do not.
  await bash('export CC_PROBE=gone');
  assert.equal((await bash('echo "[$CC_PROBE]"')).stdout.trim(), '[]');
});

// PINS HOP 1 OF 4 of the agent id's journey (PreToolUse → argv → forwarder POST
// → runForwarded): the rewritten command carries the dispatching subagent's id,
// and carries no `--agent` at all for the main agent.
//
// A POSITIVE CONTROL PER INPUT SHAPE, because the failure here is FAIL-OPEN: if
// `--agent` is dropped the subagent's command still runs, just on the main
// agent's shell, and every assertion about "it worked" still passes. Both
// shapes drive the same rewrite, so a guard that fails open on the absent case
// cannot hide behind the present one.
//
// NOT CLAIMING: that the forwarder parses the flag (the end-to-end test in
// tests/systems-remote-worker.test.mjs), that the shell it selects is a
// different one (the per-agent shell tests), or that the CLI populates
// `agent_id` at all (the gated CLI-contract suite).
test('the rewrite carries the agent id, and carries none for the main agent', async () => {
  const sub = await pre('Bash', { command: 'ls' }, 'a8620fbbffcb7f234');
  assert.equal(sub.decision, 'allow');
  assert.match(sub.updatedInput.command, /--agent 'a8620fbbffcb7f234'/);

  const main = await pre('Bash', { command: 'ls' }, null);
  assert.equal(main.decision, 'allow');
  assert.ok(!main.updatedInput.command.includes('--agent'),
    `the main agent's rewrite carries no --agent: ${main.updatedInput.command}`);

  // The default is the main agent's shape, so a caller that never learned about
  // agents cannot accidentally name one.
  const legacy = await pre('Bash', { command: 'ls' });
  assert.ok(!legacy.updatedInput.command.includes('--agent'));
});

// PINS: an agent id is quoted like every other argv element, so an id
// containing a shell metacharacter cannot break out of the rewritten command.
// The CLI's ids are hex today; the rewrite runs through a shell either way.
//
// NOT CLAIMING: anything about what the CLI's ids actually look like, nor that
// cc validates them — it quotes them.
test('an agent id with shell metacharacters is quoted, not interpolated', async () => {
  const d = await pre('Bash', { command: 'echo hi' }, "a'; touch /tmp/pwned; '");
  assert.match(d.updatedInput.command, /--agent 'a'\\''; touch \/tmp\/pwned; '\\''/);
});
