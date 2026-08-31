// A SHELL PER AGENT. A worker session on a remote system used to run every
// command — the main agent's and every subagent's — in one shell on the far
// side, so a subagent's `cd` silently re-based the main agent's next command and
// a subagent inherited write access to the session's exports. Locally the CLI
// gives every Bash call a fresh shell, so that sharing existed only under
// redirection.
//
// THE TRAP THIS FILE IS BUILT AROUND IS FAIL-OPEN, not "which machine" (the
// ONLY-ON-SYSTEM.txt / ONLY-ON-CC.txt fixtures elsewhere pin that). If the agent
// id is dropped anywhere on its way to `runForwarded`, every subagent lands on
// the main agent's shell and EVERY COMMAND STILL SUCCEEDS. So the routing
// assertion is always the far side's own answer — the shell process's `$$`, a
// per-shell env marker, a filesystem rendezvous — never "it ran" or "it exited
// zero".
//
// STANDING WARMING RULE. Under a login shell the FIRST framed command's `export`
// is silently swallowed (a `cd` in the same position is not, and every export
// after the first persists). That is a pre-existing defect of the redirected
// shell, unrelated to per-agent keying and not fixed here — but a test that sets
// an export as an agent's first command would then assert an empty value for the
// wrong reason and pass whether or not agents have their own shells. So every
// test below that measures export persistence runs one command on that agent's
// shell first, and says so.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';

let home, remote, redirect, root;

async function build({ flags = [], idleTtlMs, maxAgentShells } = {}) {
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
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    localRoots: [],
    emit: () => {},
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    ...(maxAgentShells === undefined ? {} : { maxAgentShells }),
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
const notices = (bag) => ({ notice: (t) => bag.push(t), out: () => {}, err: () => {} });

// PINS: a distinct agent id means a distinct shell PROCESS on the system, and
// the same id reuses the one it already has. `echo $$` is the far side's own
// answer about which shell it is, so a dropped agent id cannot look like a pass.
//
// NOT CLAIMING: that the CLI populates `agent_id` (the gated CLI-contract
// suite), nor which machine the shell is on (the ONLY-ON-SYSTEM fixtures in
// tests/systems-tool-redirect.test.mjs), nor anything about the
// `persistentShell:false` fallback, where no shell outlives its command and
// every pid differs by construction.
test("a subagent's command runs on a different shell process", async () => {
  const mainPid = (await run(null, 'echo $$')).stdout.trim();
  const subPid = (await run('a1', 'echo $$')).stdout.trim();
  assert.match(mainPid, /^\d+$/);
  assert.match(subPid, /^\d+$/);
  assert.notEqual(subPid, mainPid, 'the subagent got its own shell process');

  assert.equal((await run(null, 'echo $$')).stdout.trim(), mainPid, 'the main agent keeps its shell');
  assert.equal((await run('a1', 'echo $$')).stdout.trim(), subPid, 'and the subagent keeps its own');

  // An agent whose id is literally the main agent's key still gets its own
  // shell: the keys live in different namespaces, so `agent:main` and the main
  // agent cannot collide.
  const named = (await run('main', 'echo $$')).stdout.trim();
  assert.match(named, /^\d+$/);
  assert.notEqual(named, mainPid);
  assert.notEqual(named, subPid);
});

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

// PINS: exported variables do not cross between agents, with A POSITIVE CONTROL
// PER SHAPE — each shell must see its OWN marker and not the other's. A mutant
// that collapses both agents onto one shell fails the "not the other's" half; a
// mutant that loses the export entirely fails the "its own" half.
//
// Both shells are warmed first, per the standing rule at the top of this file:
// the first framed command's export is swallowed by the login shell, so without
// the warm-up both markers would read empty and this would pass either way.
//
// NOT CLAIMING: anything about the `persistentShell:false` fallback, where
// exports persist for nobody, so there is nothing to keep apart.
test('exports do not cross between agents', async () => {
  await run(null, 'pwd');
  await run('a1', 'pwd');

  await run(null, 'export CC_MAIN=m');
  await run('a1', 'export CC_SUB=s');

  assert.equal((await run(null, 'echo "[$CC_MAIN][$CC_SUB]"')).stdout.trim(), '[m][]');
  assert.equal((await run('a1', 'echo "[$CC_MAIN][$CC_SUB]"')).stdout.trim(), '[][s]');
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

// PINS: a subagent that kills its own shell costs the main agent nothing — its
// export survives and it is told about no reset — while the subagent's own next
// command IS told. The reset lands on the agent that earned it.
//
// The main agent's shell is warmed before its export, per the standing rule.
//
// NOT CLAIMING: anything about an abort or a deadline (each has its own test
// below), nor that the subagent's state is recovered — it is gone, which is what
// the notice says.
test("a subagent that kills its own shell leaves the main agent's intact", async () => {
  await run(null, 'pwd');
  await run(null, 'export CC_MAIN=m');
  await run('a1', 'pwd');

  const died = await run('a1', 'exit');
  assert.notEqual(died.code, 0, 'the subagent lost its shell');

  const main = await run(null, 'echo "[$CC_MAIN]"');
  assert.equal(main.stdout.trim(), '[m]', "the main agent's export survived");
  assert.equal(main.notice, null, 'and it is told about no reset it did not have');

  const back = await run('a1', 'echo again');
  assert.match(back.notice ?? '', /restarted/, 'the subagent is told its own shell restarted');
});

// PINS: aborting a subagent's command disturbs nothing on the main agent's
// shell. Interrupting a RUNNING framed command is a reset of the shell it runs
// in — the command shares that shell's process group and has no id of its own to
// signal — so this is the case where a shared shell would take the main agent's
// state down with the subagent's.
//
// THE ABORT MUST LAND MID-COMMAND. `run()` checks the signal before acquiring
// and again after, so an abort fired synchronously after the call never reaches
// the shell at all and costs nobody anything — a version of this test that
// aborted immediately passed before per-agent shells existed. So it waits for
// the subagent's first bytes to cross, which is the shell being genuinely
// mid-command, and only then aborts. Deterministic: an observed byte, not a
// wall-clock guess.
//
// The main agent's shell is warmed before its export, per the standing rule.
//
// NOT CLAIMING: anything about the subagent's own recovery beyond it not costing
// the main agent — the interrupted shell's own reset is
// tests/systems-tool-redirect.test.mjs's subject.
test("aborting a subagent's command does not disturb the main agent's shell", async () => {
  await run(null, 'pwd');
  await run(null, 'export CC_MAIN=m');

  const streamed = [];
  const ac = new AbortController();
  const doomed = run('a1', "printf 'RUNNING\\n'; sleep 5", {
    signal: ac.signal,
    sink: { notice: () => {}, out: (t) => streamed.push(t), err: () => {} },
  });
  await waitFor(() => streamed.join('').includes('RUNNING'), { timeout: 5000 });
  ac.abort();
  assert.notEqual((await doomed).code, 0);

  const main = await run(null, 'echo "[$CC_MAIN]"');
  assert.equal(main.stdout.trim(), '[m]', "the main agent's export survived the subagent's interrupt");
  assert.equal(main.notice, null, 'and it is told about no reset it did not have');
});

// PINS: a subagent's command exceeding ITS deadline resets ITS shell and no
// other. 80ms against a 5s sleep, so neither side of the comparison can flake.
//
// The reason it holds — the deadline path's only shell-state effect is a
// teardown of the ProviderShell instance that timed out, the same method a
// close, an abort and an `exit` all use, and ProviderShell holds no state across
// instances — is recorded here as the REASON, not as the proof. The proof is the
// assertions.
//
// The main agent's shell is warmed before its export, per the standing rule.
//
// NOT CLAIMING: anything about the `persistentShell:false` fallback, which
// deliberately records no reset reason on a deadline — nothing was carried
// there, so there is nothing to have lost.
test("a subagent's command timing out does not disturb the main agent's shell", async () => {
  await run(null, 'pwd');
  await run(null, 'export CC_MAIN=m');

  const timedOut = await run('a1', 'sleep 5', { timeoutMs: 80 });
  assert.notEqual(timedOut.code, 0);
  assert.match(timedOut.stderr, /sentinel within 80ms/);

  const main = await run(null, 'echo "[$CC_MAIN]"');
  assert.equal(main.stdout.trim(), '[m]');
  assert.equal(main.notice, null);

  const back = await run('a1', 'echo again');
  assert.match(back.notice ?? '', /deadline/, "the subagent's own next command is told why");
});

// PINS: the idle sweep reaches every agent's shell, and each entry survives its
// own close so its own next command is told what it lost. A single shared timer
// fails the first half; a single shared notice fails the second.
//
// NOT CLAIMING: any ordering or phase relationship between the two timers, and
// nothing about exports (this measures the notice, which needs no warm-up).
test("no agent's shell is exempt from the idle sweep", async () => {
  await rebuild({ idleTtlMs: 40 });
  // Each shell is asserted LIVE in the continuation of its own command, where no
  // timer can have fired yet — so the sweep below is closing shells that were
  // genuinely open, not reporting a reset on a shell that never existed. (The two
  // are deliberately not asserted live at the same instant: with a 40ms TTL the
  // first can legitimately have been swept before the second command returns.)
  await run(null, 'true');
  assert.equal(redirect.shellOpen, true, "the main agent's shell was live");
  await run('a1', 'true');
  assert.equal(redirect.shellOpenFor('a1'), true, "the subagent's shell was live");

  await waitFor(() => redirect.liveShellCount === 0, { timeout: 4000 });

  const main = await run(null, 'echo main');
  const sub = await run('a1', 'echo sub');
  assert.match(main.notice ?? '', /restarted/, 'the main agent is told about its own idle close');
  assert.match(sub.notice ?? '', /restarted/, 'and so is the subagent');
});

// PINS: the subagent shell count is capped, the entry evicted is the
// least-recently-used one, and the MAIN agent is neither counted nor evictable.
// Asserting WHICH entry went is what distinguishes eviction from arbitrary
// dropping.
//
// NOT CLAIMING: the production cap value (a test override), nor that eviction
// preserves anything — an evicted agent that returns gets a fresh shell and no
// reset notice, deliberately.
test('the subagent shell count is capped and the LRU idle one is evicted', async () => {
  await rebuild({ maxAgentShells: 2 });
  await run(null, 'true');
  await run('a1', 'true');
  await run('a2', 'true');
  await run('a3', 'true');

  assert.equal(redirect.shellOpenFor('a1'), false, 'the least-recently-used subagent shell went');
  assert.equal(redirect.shellOpenFor('a2'), true, 'and a more recent one stayed');
  assert.equal(redirect.shellOpenFor('a3'), true);
  assert.equal(redirect.shellOpen, true, 'the main agent is neither counted nor evicted');
  assert.equal(redirect.liveShellCount, 3, 'main plus the two subagents the cap allows');

  // An evicted agent that comes back still works — on a fresh shell.
  const back = await run('a1', 'echo alive');
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.stdout.trim(), 'alive');
});

// PINS: an in-flight subagent shell is never the eviction victim, and a new
// agent that finds nothing evictable is REFUSED by name rather than queued
// behind someone else's command.
//
// NOT CLAIMING: any retry or queueing policy — there is none, deliberately.
test('an in-flight subagent shell is never evicted', async () => {
  await rebuild({ maxAgentShells: 1 });
  const busy = run('a1', 'sleep 0.5; echo done');
  const refused = await run('a2', 'echo never');

  assert.notEqual(refused.code, 0, 'the second agent is refused, not queued');
  assert.match(refused.stderr, /subagent shell/, 'and the refusal names the cap it hit');
  assert.match(refused.stderr, /\b1\b/);

  const done = await busy;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout.trim(), 'done', 'the busy shell finished its command untouched');
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
    run(null, 'touch M_RUNNING; while [ ! -e S_SEEN ]; do sleep 0.02; done; echo M-DONE',
      { timeoutMs: 8000 }),
    run('a1', 'while [ ! -e M_RUNNING ]; do sleep 0.02; done; touch S_SEEN; echo S-DONE',
      { timeoutMs: 8000 }),
  ]);
  assert.equal(both[0].code, 0, both[0].stderr);
  assert.equal(both[1].code, 0, both[1].stderr);
  assert.equal(both[0].stdout.trim(), 'M-DONE');
  assert.equal(both[1].stdout.trim(), 'S-DONE');

  // And the two streams stay separate under load: 300 distinct lines each,
  // concurrently, with each result holding exactly its own in order.
  const N = 300;
  const [m, s] = await Promise.all([
    run(null, `for i in $(seq 1 ${N}); do echo "M-$i"; done`, { timeoutMs: 8000 }),
    run('a1', `for i in $(seq 1 ${N}); do echo "S-$i"; done`, { timeoutMs: 8000 }),
  ]);
  const expected = (tag) => Array.from({ length: N }, (_, i) => `${tag}-${i + 1}`);
  assert.deepEqual(m.stdout.trim().split('\n'), expected('M'), "the main agent's own lines, in order");
  assert.deepEqual(s.stdout.trim().split('\n'), expected('S'), "the subagent's own lines, in order");
});

// PINS: the `persistentShell:false` fallback isolates agents too. cwd rides the
// per-agent ProviderShell rather than a live process, so isolation survives with
// nothing long-lived on the far side — the fallback is the deliverable, not a
// degraded mode.
//
// NOT CLAIMING: anything about exports, which persist for nobody in this mode,
// and nothing about shell pids, since no shell outlives its command here.
test('[persistentShell:false] the fallback isolates agents too', async () => {
  await rebuild({ flags: ['--no-persistent-shell'] });
  await run(null, 'cd sub');
  assert.equal((await run('a1', 'pwd')).stdout.trim(), remote.root,
    "the subagent is at the project root, not the main agent's cwd");
  assert.equal((await run(null, 'pwd')).stdout.trim(), onSystem('sub'),
    "and the main agent's cwd carried, as it does locally");
});

// PINS: session teardown reaps every agent's shell, not just the main agent's.
//
// NOT CLAIMING: anything about the idle TTL or the cap, which close entries for
// their own reasons.
test('close() closes every agent shell', async () => {
  await run(null, 'true');
  await run('a1', 'true');
  await run('a2', 'true');
  assert.equal(redirect.liveShellCount, 3);

  await redirect.close();
  assert.equal(redirect.liveShellCount, 0);
  assert.equal(redirect.shellOpen, false);
});
