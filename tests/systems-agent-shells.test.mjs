// CONCURRENCY. A worker session on a remote system used to run every command in
// ONE long-lived shell on the far side, so a subagent's `cd` silently re-based
// the main agent's next command and a subagent inherited the session's exports.
// Card 2026-0312 removed that shell entirely — one `exec` per command — so
// isolation is now total and unconditional rather than achieved by keying: no
// command's state reaches ANY later command, including its own agent's. Fifteen
// of this file's eighteen tests retired with the mechanism they measured.
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

