// A CWD PER AGENT, AND CONCURRENCY. A worker session on a remote system used to
// run every command in ONE long-lived shell on the far side, so a subagent's
// `cd` silently re-based the main agent's next command. Card 2026-0312 removed
// that shell entirely — one `exec` per command — so isolation is now total and
// unconditional rather than achieved by keying, and fifteen of this file's
// eighteen tests retired with the mechanism they measured.
//
// WHAT IS LEFT IS THE PART THE STRIP MADE MATTER MORE: with nothing serialising,
// commands of one session genuinely overlap, and each result must hold exactly
// its own output and no other's.
//
// THE TRAP THIS FILE IS BUILT AROUND IS FAIL-OPEN, not "which machine" (the
// ONLY-ON-SYSTEM.txt / ONLY-ON-CC.txt fixtures elsewhere pin that). A routing
// or framing mistake here leaves EVERY COMMAND STILL SUCCEEDING, so every
// assertion is the far side's own answer — a filesystem rendezvous, a cwd read
// back from the shell — never "it ran" or "it exited zero".

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { noMirror } from '../src/systems/mirror.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

let home, remote, redirect, root;

async function build({ flags = [], idleTtlMs, maxAgentShells, shellCommandTimeoutMs } = {}) {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem({ flags });
  // Disjoint from the system's tree, exactly as a real session root is: nothing
  // here can be satisfied by cc's own copy of a path.
  root = path.join(home, 'agent-shells-root');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(remote.root, 'sub'), { recursive: true });
  redirect = new SessionRedirect({
    system: await systemById(remote.id, null, 'test'),
    systemId: remote.id,
    systemPath: remote.root,
    sessionRoot: root,
    mirror: noMirror(remote.root),
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [],
    emit: () => {},
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    ...(maxAgentShells === undefined ? {} : { maxAgentShells }),
    ...(shellCommandTimeoutMs === undefined ? {} : { shellCommandTimeoutMs }),
  });
}

async function rebuild(opts) {
  await redirect.close();
  await build(opts);
}

beforeEach(async () => { await build(); });
afterEach(async () => {
  await redirect.close();
  disposeSystemHandles();
  await rmrf(home);
});

// `agentId` first, because it is what every test here is about. `null` is the
// session's MAIN agent — the CLI omits `agent_id` on its payload.
const run = (agentId, command, opts = {}) => redirect.runForwarded(command, { agentId, ...opts });
const onSystem = (rel) => path.join(remote.root, rel);
// Signal 0: delivery is the liveness test, and it needs no permission to send —
// the reference provider's shells are children of a process cc spawned.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// PINS: a subagent's `cd` does not move the main agent's shell, in both
// directions — the subagent really does change its own cwd, and the main agent's
// is where it was.
//
// NOT CLAIMING: anything about exported variables (below), nor about teardown.
test("a subagent's cd does not move the main agent's shell", async () => {
  assert.equal((await run(null, 'pwd')).stdout.trim(), remote.root);

  await run('a1', 'cd sub');
  assert.equal((await run('a1', 'pwd')).stdout.trim(), onSystem('sub'),
    "the subagent's own cd took effect on its own shell");

  assert.equal((await run(null, 'pwd')).stdout.trim(), remote.root,
    "and the main agent's shell never moved");
});

// PINS: a new agent's shell starts at the project root on the system, not at
// wherever the main agent's shell happens to be standing. Exports live inside
// the parent's shell process and cannot be snapshotted without racing it, and
// copying the cwd alone would hand a subagent something that looks continuous
// while the rest of the state is silently absent — so nothing is inherited.
//
// NOT CLAIMING: that the parent is told anything about a subagent starting, and
// nothing about ordering between agents.
test("a new agent's shell starts at the project root", async () => {
  await run(null, 'cd sub');
  assert.equal((await run(null, 'pwd')).stdout.trim(), onSystem('sub'), 'the parent really did move');

  assert.equal((await run('a2', 'pwd')).stdout.trim(), remote.root,
    'a fresh agent starts at the project root, not at the parent\'s cwd');
});

// PINS THE BLAST RADIUS OF AN INTERRUPT: aborting one command stops that command
// and nothing else. Each command is its own `exec` with its own never-reused id,
// so a signal wired to the wrong id — the way this has actually been broken on
// this branch — takes the sibling down with it.
//
// THE WITNESS IS A CONCURRENT SIBLING, not a later command: a later one cannot
// tell "the interrupt was scoped" from "the interrupt happened after I finished".
// The two rendezvous through a file on the system, so the survivor is provably
// still running when the abort lands.
//
// THE ABORT MUST LAND MID-COMMAND. `run()` checks the signal before it hands the
// command over, so an abort fired synchronously after the call never reaches the
// far side and costs nobody anything. So it waits for the doomed command's first
// bytes to cross — an observed byte, not a wall-clock guess.
//
// THE DEADLINE HALF IS DELIBERATELY NOT A SECOND TEST HERE. A deadline is the
// provider killing one command through the `exec` id cc gave it, which is the
// same id-scoping this test exercises, and a sibling cannot outlive it: both
// commands of one session share `shellCommandTimeoutMs`, so a witness that was
// still running when the deadline fired would be within milliseconds of its own.
// The deadline's own behaviour is pinned in tests/systems-shell-framing.test.mjs.
//
// NOT CLAIMING anything about the interrupted command's own recovery — that is
// tests/systems-tool-redirect.test.mjs's subject.
test('interrupting one command leaves a concurrent one untouched', async () => {
  const streamed = [];
  const ac = new AbortController();
  const survivor = run('a2', 'while [ ! -e DOOMED_GONE ]; do sleep 0.02; done; echo SURVIVED');
  const doomed = run('a1', "printf 'RUNNING\\n'; sleep 5", {
    signal: ac.signal,
    sink: { notice: () => {}, out: (t) => streamed.push(t), err: () => {} },
  });
  await waitFor(() => streamed.join('').includes('RUNNING'), { timeout: 5000 });
  ac.abort();
  assert.notEqual((await doomed).code, 0, 'the interrupted command failed');

  // Only now is the survivor allowed to finish — so it was provably still
  // running while the abort landed.
  await fs.writeFile(onSystem('DOOMED_GONE'), '');
  const ok = await survivor;
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'SURVIVED');
});

// PINS THAT A RESET NOTICE NAMES THE RESTARTED AGENT'S OWN WORKING DIRECTORY.
// The notice tells a worker "Its working directory is still X" — the one thing in
// it a worker acts on directly — so a notice that reported some other agent's cwd
// would be a false statement about the reader's own state, which is exactly what
// R5 exists to forbid.
//
// BOTH DIRECTIONS, because the two cwds must be observed DISAGREEING: every other
// notice in these suites is taken with the agent standing at the project root,
// where a per-agent read and a session-wide one coincide and neither can be told
// from the other. Here the subagent has `cd`'d first, so the main agent's shell
// and the subagent's are in different directories when both are reset.
//
// NOT CLAIMING: anything about the rest of the notice's text (the reset-reason
// wording and its once-only delivery are pinned in
// tests/systems-tool-redirect.test.mjs), nor that cwd is RESTORED after a reset —
// it is; what is pinned is what the worker is told.
test("a reset notice names the restarted agent's own working directory", async () => {
  await run('a1', 'cd sub');
  assert.equal((await run('a1', 'pwd')).stdout.trim(), onSystem('sub'));
  assert.equal((await run(null, 'pwd')).stdout.trim(), remote.root,
    'the premise: the two agents are standing in different directories');

  assert.notEqual((await run('a1', 'exit')).code, 0, "the subagent's shell died");
  assert.notEqual((await run(null, 'exit')).code, 0, "and so did the main agent's");

  const sub = await run('a1', 'echo s');
  const main = await run(null, 'echo m');
  assert.match(sub.notice ?? '', /restarted/);
  assert.match(main.notice ?? '', /restarted/);

  // Anchored on the sentence's own wording and terminated by the comma, so
  // `<root>/sub` cannot satisfy the `<root>` assertion by being a prefix of it.
  assert.ok(sub.notice.includes(`still ${onSystem('sub')},`),
    `the subagent is told its OWN cwd: ${sub.notice}`);
  assert.ok(!sub.notice.includes(`still ${remote.root},`),
    `and not the main agent's: ${sub.notice}`);
  assert.ok(main.notice.includes(`still ${remote.root},`),
    `the main agent is told its own: ${main.notice}`);
  assert.ok(!main.notice.includes(`still ${onSystem('sub')},`),
    `and not the subagent's: ${main.notice}`);
});

// THE SAME INVARIANT WITH THE ROLES SWAPPED: the notice names the agent whose
// shell it was, when the displaced agent is the MAIN one. The test above leaves
// main standing at the project root, where a notice reporting main's own cwd and
// one reporting the project root are the same string — so a notice that lied
// about MAIN's whereabouts specifically, and only about main's, would be
// invisible. Here main has `cd`'d away and the subagent is the one at the root.
//
// NOT CLAIMING anything the test above already claims (nothing about the rest of
// the notice's text, and nothing about cwd being restored after the reset); this
// exists only to remove the main agent's exemption from that test's premise.
test("a displaced MAIN agent's reset notice names its own working directory", async () => {
  await run(null, 'cd sub');
  assert.equal((await run(null, 'pwd')).stdout.trim(), onSystem('sub'));
  assert.equal((await run('a1', 'pwd')).stdout.trim(), remote.root,
    'the premise, inverted: this time it is the main agent that has moved');

  assert.notEqual((await run(null, 'exit')).code, 0, "the main agent's shell died");
  assert.notEqual((await run('a1', 'exit')).code, 0, "and so did the subagent's");

  const main = await run(null, 'echo m');
  const sub = await run('a1', 'echo s');
  assert.match(main.notice ?? '', /restarted/);
  assert.match(sub.notice ?? '', /restarted/);

  assert.ok(main.notice.includes(`still ${onSystem('sub')},`),
    `the main agent is told its OWN cwd, not the project root: ${main.notice}`);
  assert.ok(!main.notice.includes(`still ${remote.root},`), main.notice);
  assert.ok(sub.notice.includes(`still ${remote.root},`),
    `and the subagent is told its own: ${sub.notice}`);
  assert.ok(!sub.notice.includes(`still ${onSystem('sub')},`), sub.notice);
});

// PINS THE NEW ASSUMPTION this whole change introduces: two agents' commands on
// one session GENUINELY OVERLAP, and each result holds only its own output.
//
// STRUCTURAL, not wall-clock. Neither command can finish unless the other was
// already running — they rendezvous through two files on the system — so under
// one shared shell the second waits for the first to release it and both fail on
// their bound. This test cannot pass before the change.
//
// NOT CLAIMING: any ordering between the two, only simultaneous progress.
test("two agents' commands genuinely overlap", async () => {
  const both = await Promise.all([
    run(null, 'touch M_RUNNING; while [ ! -e S_SEEN ]; do sleep 0.02; done; echo M-DONE'),
    run('a1', 'while [ ! -e M_RUNNING ]; do sleep 0.02; done; touch S_SEEN; echo S-DONE'),
  ]);
  assert.equal(both[0].code, 0, both[0].stderr);
  assert.equal(both[1].code, 0, both[1].stderr);
  assert.equal(both[0].stdout.trim(), 'M-DONE');
  assert.equal(both[1].stdout.trim(), 'S-DONE');

  // And the two streams stay separate under load: 300 distinct lines each,
  // concurrently, with each result holding exactly its own in order.
  const N = 300;
  const [m, s] = await Promise.all([
    run(null, `for i in $(seq 1 ${N}); do echo "M-$i"; done`),
    run('a1', `for i in $(seq 1 ${N}); do echo "S-$i"; done`),
  ]);
  const expected = (tag) => Array.from({ length: N }, (_, i) => `${tag}-${i + 1}`);
  assert.deepEqual(m.stdout.trim().split('\n'), expected('M'), "the main agent's own lines, in order");
  assert.deepEqual(s.stdout.trim().split('\n'), expected('S'), "the subagent's own lines, in order");
});

