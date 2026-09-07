// TWO COMMANDS OF ONE SESSION, AT THE SAME TIME. This file was
// tests/systems-agent-shells.test.mjs and was about A SHELL PER AGENT: a worker
// session used to run every command in ONE long-lived shell on the far side, so
// a subagent's `cd` re-based the main agent's next command and a subagent
// inherited the session's exports, and the fix was to key a shell per agent.
//
// Card 2026-0312 deleted the long-lived shell outright — one `exec` per command
// — which SUBSUMES that guarantee by construction and strictly strengthens it:
// no command's state reaches ANY later command, including its own agent's, so
// there is nothing left to keep apart. Fifteen of the eighteen tests retired
// with the mechanism they measured, and the file was renamed rather than left
// carrying a header about a shell that no longer exists.
//
// WHAT IS LEFT IS THE PART THE STRIP MADE MATTER MORE, because nothing
// serialises any more and concurrency therefore goes UP: two commands of one
// session genuinely overlap, each result holds exactly its own output in order,
// and an interrupt reaches one and only one of them.
//
// THE TRAP THIS FILE IS BUILT AROUND IS FAIL-OPEN, not "which machine" (the
// ONLY-ON-SYSTEM.txt / ONLY-ON-CC.txt fixtures elsewhere pin that). A framing or
// signal-routing mistake here leaves EVERY COMMAND STILL SUCCEEDING, so every
// assertion is the far side's own answer — a filesystem rendezvous, a
// per-command line count — never "it ran" or "it exited zero".

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem } from './remoteSystem.mjs';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';
import { SessionRedirect } from '../src/systems/toolRedirect.ts';
import { redirectTierOptions } from './tierFixture.mjs';

let home, remote, redirect, root;

async function build({ shellCommandTimeoutMs } = {}) {
  ({ home } = await freshProjectsRoot());
  remote = await bindRemoteSystem();
  // Disjoint from the system's tree, exactly as a real session root is: nothing
  // here can be satisfied by cc's own copy of a path.
  root = path.join(home, 'concurrent-commands-root');
  await fs.mkdir(root, { recursive: true });
  redirect = new SessionRedirect({
    system: await systemById(remote.id, null, 'test'),
    systemId: remote.id,
    systemPath: remote.root,
    ...redirectTierOptions({ systemPath: remote.root }),
    forwarderUrl: 'http://127.0.0.1:1/api/instances/x/bash-forward',
    emit: () => {},
    ...(shellCommandTimeoutMs === undefined ? {} : { shellCommandTimeoutMs }),
  });
}

beforeEach(async () => { await build(); });
afterEach(async () => {
  await redirect.close();
  disposeSystemHandles();
  await rmrf(home);
});

const run = (command, opts = {}) => redirect.runForwarded(command, opts);
const onSystem = (rel) => path.join(remote.root, rel);

// A far-side rendezvous that GIVES UP, and that is the whole point of it being a
// helper. Every test here proves concurrency by having two commands wait on each
// other, which under anything that serialises them is a DEADLOCK — and an
// unbounded `while [ ! -e X ]` turns that into a hang until cc's 605 s ceiling:
// a wedged suite nobody diagnoses rather than a failure someone reads. Bounded,
// the same regression reds in ~10 s with a message naming what never arrived.
//
// IT ENDS IN `&&`, and NOT in `exit`. A bare `exit` inside the framed command
// group exits the SHELL, so cc reports ESHELLGONE and the diagnostic line never
// reaches the result — measured. Short-circuiting instead leaves the frame
// intact, so the message arrives on stderr, the rest of the command is skipped,
// and the exit code is an ordinary non-zero.
// 10 s, NOT 3 s, and the margin is the whole reason. This is the only
// wall-clock dependence in these tests' PASS path — the shape it replaced had
// none — so a spurious trip is a flaky red, which is strictly worse than the
// fail-slow hang it exists to prevent. Measured standalone: 0.22 s quiet,
// 0.81-1.10 s at 32-way starvation, 0.92-1.30 s at 72-way. Against 3 s that is
// a 2.3x margin, where this suite's convention is ~75x and this branch already
// carries a card about a 3.3x margin inverting under exactly this load; the
// gate runs the whole suite twice with provider processes alongside, so real
// inflation beyond those standalone numbers is likely. 10 s gives ~7.7x at
// 72-way and is still ~60x better than the 605 s hang. It costs nothing real:
// the helper is used only where a deadlock IS the detected failure.
const RENDEZVOUS_TICKS = 500;   // × 20 ms = ~10 s
const waitFor_ = (marker) =>
  `i=0; while [ ! -e ${marker} ] && [ $i -lt ${RENDEZVOUS_TICKS} ]; do sleep 0.02; i=$((i+1)); done; `
  + `{ [ -e ${marker} ] || { echo "RENDEZVOUS-TIMEOUT: ${marker} never appeared" >&2; false; }; } && `;

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
  const survivor = run(`${waitFor_('DOOMED_GONE')}echo SURVIVED`);
  const doomed = run("printf 'RUNNING\\n'; sleep 5", {
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

// PINS THE PROPERTY THIS CARD MOST EXPOSES: two commands of one session
// GENUINELY OVERLAP, and each result holds exactly its own output, in order.
//
// STRUCTURAL, not wall-clock. Neither command can finish unless the other was
// already running — they rendezvous through two files on the system — so with
// anything serialising in the middle the second waits for the first and both
// fail on their bound. This test cannot pass with a queue.
//
// THE SECOND HALF IS THE ONE THE STRIP MADE MATTER MORE. 300 distinct lines from
// each, concurrently, each result holding exactly its own in order: this used to
// be satisfiable only because the two agents had separate shells and therefore
// separate parsers. Now every command has its own by construction, and a shared
// nonce, decoder or pending slot is what would break it.
//
// NOT CLAIMING: any ordering between the two, only simultaneous progress.
test('two commands of one session genuinely overlap, and neither sees the other\'s output', async () => {
  const both = await Promise.all([
    run(`touch M_RUNNING; ${waitFor_('S_SEEN')}echo M-DONE`),
    run(`${waitFor_('M_RUNNING')}touch S_SEEN; echo S-DONE`),
  ]);
  // A serialising layer deadlocks these two, and the bounded wait is what turns
  // that from a hang at cc's ceiling into a named failure in ~3 s.
  assert.equal(both[0].code, 0, both[0].stderr);
  assert.equal(both[1].code, 0, both[1].stderr);
  assert.equal(both[0].stdout.trim(), 'M-DONE');
  assert.equal(both[1].stdout.trim(), 'S-DONE');

  // And the two streams stay separate under load.
  const N = 300;
  const [m, s] = await Promise.all([
    run(`for i in $(seq 1 ${N}); do echo "M-$i"; done`),
    run(`for i in $(seq 1 ${N}); do echo "S-$i"; done`),
  ]);
  const expected = (tag) => Array.from({ length: N }, (_, i) => `${tag}-${i + 1}`);
  assert.deepEqual(m.stdout.trim().split('\n'), expected('M'), "the first command's own lines, in order");
  assert.deepEqual(s.stdout.trim().split('\n'), expected('S'), "the second's own, in order");
});

