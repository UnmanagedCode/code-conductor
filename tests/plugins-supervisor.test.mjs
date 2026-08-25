import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createSupervisor } from '../src/plugins/supervisor.ts';
import { allocatePort, pidAlive, waitForPort } from '../src/plugins/ports.ts';
import { FAKE_PLUGIN_DIR, waitFor } from './plugin-helpers.mjs';
import { hasMarker } from './procTree.mjs';

const manifest = (backend) => ({ id: 'fake-plugin', name: 'Fake', version: '1', pluginApi: 1, backend });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The window over which a readiness-probe RATE is measured. Shared by the
// cancellation test and its live-child control so the two can never drift into
// a gap where both pass: one asserts `<= base + 1`, the other `> base + 1`, and
// 1200ms is 6x the supervisor's 200ms poll interval, so a live poll clears the
// second bound with room to spare even on a starved box.
const PROBE_WINDOW = 1200;

// Fail, don't hang. A promise that becomes unresolvable must surface as a named
// assertion failure, never as a file that finishes its tests and then sits on
// the event loop — that shape reports as `NO REPORT` / a lost file, which reads
// like a killed process rather than a failed test, and misreading it is what
// made card 2026-0219 expensive to diagnose in the first place.
//
// NOT a tight timeout — a budget near the operation's real duration would just
// be a new load-sensitive test, i.e. this card's own defect. The only caller
// wraps `waitForPort(…, {timeoutMs: 5000})`, whose deadline is WALL-CLOCK
// (`Date.now() >= deadline`), not a tick count, so it does not stretch under
// contention: in every non-broken world that promise settles — resolve or
// reject — within 5000ms plus one 20ms interval. 3x that, and still well under
// node:test's 60s per-test timeout, so the verdict stays ours to name.
// `finally` clears the timer on BOTH paths; leaving it armed on the success
// path would itself hold the loop open and trip the leak guard.
const SETTLE_DEADLINE = 15000;

function withDeadline(promise, ms, onTimeout) {
  let timer;
  const expiry = new Promise((res) => { timer = setTimeout(() => res(onTimeout), ms); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// Teardown is registered AT SPAWN TIME, before anything that can throw. The
// readiness `waitFor` below runs before `rec` reaches the caller, so a timeout
// there used to leak a child the caller's own `finally` never learned about —
// and the two cases that assert on a live tree (`stop kills the whole process
// group`, `post-ready exit fires onExit`) had no `finally` at all, so any failed
// assertion ahead of their `sup.stop()` leaked the child AND its grandchild.
// That asymmetry is what produced the measured 9:3 forker:slow-ready split in
// the orphan inventory: the forker test leaks on a strictly larger set of
// failures.
//
// Double-stop is safe, so call sites may keep an explicit stop as well:
// killProcessGroup swallows ESRCH (src/groupedCommand.ts) and
// waitFor(() => !pidAlive(pid)) resolves at once on a dead pid.
async function startAndSettle(t, sup, opts) {
  const rec = await sup.start(opts);
  t.after(() => stopAndWait(sup, opts.id, rec));
  const rt = await waitFor(() => {
    const r = sup.runtime(opts.id);
    return r && r.status !== 'starting' ? r : false;
  });
  return { rec, rt };
}

// LICENCE TO KILL — read this before touching the guard.
//
// `sup.stop` signals a process GROUP: `process.kill(-pgid, …)`. Two tests in
// this file inject `_spawn: fakeSpawn`, whose stand-in children carry
// `pid = 900001 + n` — a number picked by an array index, not by the kernel.
// Now that teardown is registered unconditionally at spawn time, an unguarded
// stop would SIGTERM-then-SIGKILL process group 900001 on those tests. That is
// not theoretical here: pid_max on this box is 4194304, live pids reach ~3.99M,
// and an unrelated live process sits at 1089935 — pids have wrapped well past
// 900001, so the group belongs to a stranger.
//
// The guard is the SAME exact identity used everywhere else in this suite, asked
// about one pid: does /proc/<pid>/environ carry this run's CC_TEST_RUN_ID? A real
// child inherits it at exec (measured); a fake object never had an environ at
// all. Deliberately NOT a caller-supplied "this one is fake" flag — a flag
// relocates kill authority to the caller instead of closing the class, and the
// next fake spawner would have to remember to set it.
//
// The pgid conjunct is not redundant. The licence is established for `rec.pid`,
// but what gets signalled is the group `rec.pgid`; they coincide only because
// the supervisor spawns detached (pgid === pid, src/plugins/supervisor.ts). If
// that ever changes, the licence stops covering what we signal, so it is checked
// rather than assumed. Skipping `sup.stop` also skips its `children.delete(id)`
// bookkeeping, which is inert in teardown — every test builds its own supervisor
// and none inspects it afterwards.
function stopAndWait(sup, id, rec) {
  if (rec.pgid !== rec.pid || !hasMarker(rec.pid, process.env.CC_TEST_RUN_ID)) {
    return Promise.resolve();
  }
  sup.stop({ id, pgid: rec.pgid });
  return waitFor(() => !pidAlive(rec.pid));
}

// A held listener on a real port. It ACCEPTS and immediately destroys, so a
// readiness probe aimed at it completes a connect (countable) yet answers
// nothing (the supervisor's poll keeps ticking) — that pair is what makes
// "probing stopped" observable at all. Teardown destroys accepted sockets:
// `server.close()` alone cannot release an ESTABLISHED connection, which is
// half of why the deleted settle-window test leaked a Socket on its fail path.
async function squat() {
  const state = { accepts: 0 };
  const live = new Set();
  const srv = net.createServer((sock) => {
    state.accepts++;
    live.add(sock);
    sock.once('close', () => live.delete(sock));
    sock.destroy();
  });
  const port = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
  return {
    port,
    accepts: () => state.accepts,
    close: () => new Promise((res) => { for (const s of live) s.destroy(); srv.close(res); }),
  };
}

// A plain listener on a CHOSEN port that accepts and holds. Unlike squat() it
// does not destroy on accept, because its callers need `tcpOpen` to observe a
// clean successful connect; the socket set is the fail-path release valve.
function holdPort(port) {
  const live = new Set();
  const srv = net.createServer((sock) => { live.add(sock); sock.once('close', () => live.delete(sock)); });
  return {
    listen: () => new Promise((res) => srv.listen(port, '127.0.0.1', res)),
    close: () => new Promise((res) => { for (const s of live) s.destroy(); srv.close(res); }),
  };
}

// A `spawn()` stand-in for the settle-window branch. Everything a fake child
// emits lands on `process.nextTick` — i.e. before ANY timer can run — so
// `raceSettle`'s first 20ms tick is guaranteed to observe an already-finished
// child. That makes "the crash was seen INSIDE the settle window" true by
// ORDERING, on an arbitrarily starved box. Racing a real `bash -lc node` boot
// against the 400ms wall clock instead is what made the old version of this
// test fail ~78% of the time at load1 ~75 (card 2026-0219).
// `scripts` is one entry per attempt; the last entry repeats.
function fakeSpawn(scripts) {
  const spawned = [];
  const fn = () => {
    const script = scripts[Math.min(spawned.length, scripts.length - 1)];
    const proc = new EventEmitter();
    proc.pid = 900001 + spawned.length; // never signalled — these tests never stop()
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    spawned.push(proc);
    process.nextTick(() => {
      if (script.stderr) proc.stderr.emit('data', Buffer.from(script.stderr));
      if (script.stdout) proc.stdout.emit('data', Buffer.from(script.stdout));
      if (script.exitCode !== undefined) proc.emit('exit', script.exitCode, null);
    });
    return proc;
  };
  fn.spawned = spawned;
  return fn;
}

// Node's own text, so the fake stays faithful to what T2 proves the real child prints.
const EADDRINUSE_STDERR = (port) =>
  `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`;

test('readiness via healthPath; child gets $PORT and reaches ready', async (t) => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
    env: { CONDUCTOR_URL: 'http://127.0.0.1:9999' },
  });
  assert.equal(rt.status, 'ready');
  const env = await (await fetch(`http://127.0.0.1:${rec.port}/env`)).json();
  assert.equal(env.port, rec.port);
  assert.equal(env.pluginId, 'fake-plugin');
  assert.equal(env.conductorUrl, 'http://127.0.0.1:9999');
  assert.equal(rec.pgid, rec.pid);
  assert.ok(rec.startedAt);
});

test('readiness via readyWhen stdout regex', async (t) => {
  const sup = createSupervisor();
  const { rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', readyWhen: 'listening on \\d+' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
});

test('readiness via bare TCP probe, with a slow-binding child', async (t) => {
  const sup = createSupervisor();
  const { rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'SLOW_READY_MS=1000 node slow-ready.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
});

test('bare-TCP readiness does not fire before the port is actually bound', async () => {
  // With no readyWhen and no healthPath, `tcpOpen` IS the readiness oracle, and
  // its FAILURE POLARITY is the whole contract: a refused connect must read as
  // not-ready. Invert it and every bare-TCP plugin is declared ready on its
  // first poll tick — before it has bound anything, and permanently if it stays
  // alive without ever binding. The registry persists that `ready`, the proxy
  // routes to a dead port, and the UI shows it healthy. "Reaches ready
  // eventually" (the slow-binding test below) cannot see any of that.
  const port = await allocatePort(); // allocated, then released: refuses connects
  const sup = createSupervisor({ _settleMs: 0, _allocatePort: () => Promise.resolve(port) });
  const rec = await sup.start({
    id: 'fake-plugin',
    manifest: manifest({ start: 'sleep 30' }), // alive throughout, binds nothing
    cwd: FAKE_PLUGIN_DIR,
  });
  const listener = holdPort(port);
  try {
    // PROBE_WINDOW is 6x the poll interval, so this is not the "hasn't ticked
    // yet" case: several connects have been refused and reported by now.
    await sleep(PROBE_WINDOW);
    assert.equal(sup.runtime('fake-plugin').status, 'starting',
      'declared ready while the child was alive but had bound nothing');
    // Non-vacuity: the SAME poll on the SAME port must still fire once the port
    // really is listening. So the negative above is about the polarity, not
    // about a poll that was never running.
    await listener.listen();
    await waitFor(() => sup.runtime('fake-plugin').status === 'ready');
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
    await listener.close();
  }
});

test('crash before ready → crashed with output tail', async (t) => {
  const sup = createSupervisor();
  const { rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node crash.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed');
  assert.match(rt.error, /exited \(code=1/);
  assert.match(rt.error, /boom/);
});

test('never-ready child → crashed after the readiness bound', async (t) => {
  // 400ms, not 1500: readyWhen cannot match, so this test WAITS OUT the whole
  // bound (measured 2067ms of the file's 6.0s). 400ms still leaves >=2 of the
  // supervisor's 200ms poll intervals, and the assertions below are the timeout
  // branch — they do not depend on the child having started, so a short bound
  // cannot flip the outcome.
  const sup = createSupervisor({ _readyTimeoutMs: 400 });
  const { rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    // Matches nothing the fixture prints — readiness must time out.
    manifest: manifest({ start: 'node server.mjs', readyWhen: 'WILL_NEVER_MATCH' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed');
  assert.match(rt.error, /readiness not confirmed/);
});

// ── the settle window (card 2026-0219) ──────────────────────────────────────
// The 400ms window is a bound on how fast a crash must be OBSERVED, not a
// promise that a child boots that fast; it is a property of the host. So the
// two branches are tested separately and each is made unreachable-by-the-other
// rather than raced: T1/T1b decide "inside the window" by nextTick ordering,
// T2 decides "outside the window" by setting the window to zero.

test('EADDRINUSE inside the settle window retries on a fresh port', async (t) => {
  const PORT_A = 45111, PORT_B = 45222; // never bound — the fake children do no I/O
  const spawnFake = fakeSpawn([
    { stderr: EADDRINUSE_STDERR(PORT_A), exitCode: 1 },
    { stdout: 'fake-plugin listening on 45222\n' }, // no exit: stays 'starting', then goes ready
  ]);
  let calls = 0;
  const sup = createSupervisor({
    _spawn: spawnFake,
    _allocatePort: () => { calls++; return Promise.resolve(calls === 1 ? PORT_A : PORT_B); },
  });
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'irrelevant — _spawn is faked', readyWhen: 'listening on \\d+' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  assert.equal(spawnFake.spawned.length, 2, 'the lost-port child was respawned');
  assert.equal(calls, 2, 'the retry re-allocated instead of reusing the lost port');
  // The persisted record must describe the RETRY child, not the dead first one —
  // registry.ts writes it straight to the store.
  assert.equal(rec.port, PORT_B);
  assert.equal(rec.pid, spawnFake.spawned[1].pid);
  assert.equal(rec.pgid, spawnFake.spawned[1].pid);
});

test('EADDRINUSE retries are bounded, then it gives up', async (t) => {
  const spawnFake = fakeSpawn([{ stderr: EADDRINUSE_STDERR(45111), exitCode: 1 }]); // repeats
  let calls = 0;
  const sup = createSupervisor({
    _spawn: spawnFake,
    _allocatePort: () => { calls++; return Promise.resolve(45100 + calls); },
  });
  const { rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'irrelevant — _spawn is faked', readyWhen: 'listening on \\d+' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed');
  assert.match(rt.error, /EADDRINUSE/);
  // 1 initial attempt + EADDRINUSE_RETRIES (3, src/plugins/supervisor.ts). The
  // literal is deliberate: importing the constant would let a mutant that
  // widens the bound carry this expectation along with it.
  assert.equal(spawnFake.spawned.length, 4);
  assert.equal(calls, 4);
});

test('a real child that loses the port race after the window reports EADDRINUSE', async (t) => {
  const sq = await squat();
  let calls = 0;
  const sup = createSupervisor({
    // The window has already expired when raceSettle's first tick runs, so
    // "the crash was seen AFTER the window" is the only reachable branch — no
    // competing clock, whatever the box is doing.
    _settleMs: 0,
    _allocatePort: () => { calls++; return Promise.resolve(sq.port); },
  });
  try {
    const { rec, rt } = await startAndSettle(t, sup, {
      id: 'fake-plugin',
      // Readiness can never match, so the child's own exit is what settles the
      // record and rt.error carries node's real bind-failure text.
      manifest: manifest({ start: 'node server.mjs', readyWhen: 'WILL_NEVER_MATCH' }),
      cwd: FAKE_PLUGIN_DIR,
    });
    assert.equal(rt.status, 'crashed');
    // Node's ACTUAL text is what the supervisor's /EADDRINUSE/ predicate reads.
    assert.match(rt.error, /EADDRINUSE/);
    // …and it is byte-identical to what T1/T1b's fake children claim the race
    // with. This is the only guard against those fakes drifting out of sync
    // with reality and pinning a race the product no longer detects.
    assert.ok(rt.error.includes(EADDRINUSE_STDERR(sq.port).trim()),
      `fixture drift — real child said: ${rt.error}`);
    // A crash observed after the window is COMMITTED to, not retried — the
    // documented bound, asserted directly instead of raced across.
    assert.equal(rec.port, sq.port);
    assert.equal(calls, 1);
  } finally {
    await sq.close();
  }
});

test('a child that dies before readiness stops the readiness probing', async () => {
  const sq = await squat();
  const sup = createSupervisor({ _settleMs: 0, _allocatePort: () => Promise.resolve(sq.port) });
  await sup.start({
    id: 'fake-plugin',
    // healthPath aimed at the squatter: the child dies after the window (0ms)
    // without ever binding, so every probe from here on is aimed at a port this
    // child never owned — exactly what allocatePort() may already have reissued.
    manifest: manifest({ start: 'node crash.mjs', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  try {
    // Two barriers, both causally downstream of the decision under test: the
    // death has been OBSERVED, and probing was demonstrably LIVE (without the
    // second, a zero-probe run would pass this vacuously).
    await waitFor(() => sup.runtime('fake-plugin')?.status === 'crashed');
    await waitFor(() => sq.accepts() >= 1);
    const base = sq.accepts();
    await sleep(PROBE_WINDOW);
    // +1 tolerates the single probe that can already be in flight when the
    // barrier trips, and no more: a poll that ignored the death would land ~6
    // in this window (see the control below, which requires >1).
    assert.ok(sq.accepts() <= base + 1,
      `probing continued after the child died: ${base} → ${sq.accepts()} accepts`);
  } finally {
    await sq.close();
  }
});

test('readiness probing continues while the child is still alive', async () => {
  // The non-vacuous control for the test above: same squatter, same branch,
  // same PROBE_WINDOW — only the child differs (never binds, never exits).
  // Without it an `abort` stuck at true would make that test green for free.
  const sq = await squat();
  const sup = createSupervisor({ _settleMs: 0, _allocatePort: () => Promise.resolve(sq.port) });
  const rec = await sup.start({
    id: 'fake-plugin',
    manifest: manifest({ start: 'sleep 30', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  try {
    await waitFor(() => sq.accepts() >= 1);
    const base = sq.accepts();
    await sleep(PROBE_WINDOW);
    assert.ok(sq.accepts() > base + 1,
      `probing stalled while the child was alive: ${base} → ${sq.accepts()} accepts`);
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
    await sq.close();
  }
});

// ── waitForPort's retry loop ─────────────────────────────────────────────────
// Card 2026-0219 re-pointed supervisor readiness off `waitForPort` onto
// `poll(tcpOpen)`, which left its MULTI-ATTEMPT contract with no test driving
// it — the old slow-binding readiness test used to, via SLOW_READY_MS. The
// remaining production caller is `probeAnswers` in src/plugins/registry.ts
// (adopted-child liveness for manifests with no healthPath), where giving up on
// the first refused connect reports a still-booting adopted plugin as
// not-answering instantly instead of within its 1 s probe window. Both halves
// live here rather than in a new file: this is where the coverage was lost.

test('waitForPort keeps probing until its deadline before rejecting', async () => {
  const port = await allocatePort(); // refuses connects
  const t0 = Date.now();
  await assert.rejects(
    () => waitForPort(port, { timeoutMs: 300, intervalMs: 20 }),
    new RegExp(`port ${port} not listening within 300ms`));
  const elapsed = Date.now() - t0;
  // Bailing on the first refusal returns in ~1 ms. Load-sensitive only in the
  // SAFE direction — contention can push this up, never down.
  assert.ok(elapsed >= 300, `gave up after ${elapsed}ms instead of probing for 300ms`);
});

test('waitForPort resolves on a port bound after earlier probes were refused', async () => {
  const port = await allocatePort();
  const settled = waitForPort(port, { timeoutMs: 5000, intervalMs: 20 })
    .then(() => 'resolved', (e) => `rejected: ${e.message}`);
  // Barrier: still unsettled after a window in which ~15 connects were refused,
  // so whatever happens next cannot be the FIRST probe latching an answer.
  assert.equal(await Promise.race([settled, sleep(300).then(() => 'pending')]), 'pending');
  const listener = holdPort(port);
  try {
    await listener.listen();
    // Re-probed rather than latching its earlier refusals.
    assert.equal(await withDeadline(settled, SETTLE_DEADLINE, 'never settled'), 'resolved');
  } finally {
    await listener.close();
  }
});

test('stop kills the whole process group (grandchild included)', async (t) => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node forker.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  const { grandchildPid } = await (await fetch(`http://127.0.0.1:${rec.port}/`)).json();
  assert.ok(pidAlive(grandchildPid));
  sup.stop({ id: 'fake-plugin', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pid) && !pidAlive(grandchildPid));
});

test('post-ready exit fires onExit with status exited', async (t) => {
  const exits = [];
  const sup = createSupervisor({ onExit: (id, info) => exits.push({ id, info }) });
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  process.kill(rec.pid, 'SIGTERM');
  await waitFor(() => exits.length > 0);
  assert.equal(exits[0].id, 'fake-plugin');
  assert.equal(exits[0].info.status, 'exited');
});

test('git HEAD is recorded when cwd is a repo, null otherwise', async (t) => {
  const sup = createSupervisor();
  // The fixture lives inside the code-conductor repo → HEAD resolves.
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node crash.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed'); // crash child: no cleanup needed
  assert.match(rec.gitHead, /^[0-9a-f]{40}$/);
});

// ── startAndSettle's teardown contract (card 2026-0226) ─────────────────────
// These pin the CONTRACT, not a pre/post behavioural difference: the old
// signature does not exist to compare against. The behavioural proof that the
// leak class is closed is the run-end sweep case in
// tests/hang-guard-sweep.test.mjs. What is worth pinning here is the pair of
// properties that make the teardown both effective and safe.

// Filled by the case below, read by the one after it. Top-level tests in a file
// run in order, and a test's own `after` hook cannot be observed from inside its
// own body — so the assertion has to be the NEXT case. That ordering is the
// whole mechanism; do not reorder or wrap these two.
const treeReap = {};

test('a failure before the explicit stop() still leaves the teardown to reap the tree', async (t) => {
  // The exact leaking shape from the orphan inventory: `node forker.mjs` holds a
  // live grandchild, and the case that exercised it (`stop kills the whole
  // process group`) had NO try/finally, so any failed assertion ahead of its
  // `sup.stop()` leaked both processes — 9 of the 12 measured orphan tree roots
  // were forkers for exactly that reason. This case deliberately never calls
  // stop(): the teardown registered at spawn time is the only thing that can
  // reap it, which is the property under test.
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(t, sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node forker.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  const { grandchildPid } = await (await fetch(`http://127.0.0.1:${rec.port}/`)).json();
  assert.ok(pidAlive(grandchildPid), 'the fixture did not actually fork a live grandchild');
  Object.assign(treeReap, { pid: rec.pid, grandchildPid });
});

test('…and by now that teardown has reaped the child AND its grandchild', async () => {
  assert.ok(treeReap.pid, 'the case above did not run — these two are a pair');
  // A grandchild is the half a bare `child.kill()` misses; the teardown goes
  // through the process GROUP, which is why it reaches both.
  await waitFor(() => !pidAlive(treeReap.pid) && !pidAlive(treeReap.grandchildPid));
});

test('stopAndWait refuses to signal anything that is not provably this run\'s', async () => {
  // THE SAFETY DIRECTION, and the reason the guard exists at all. `sup.stop`
  // signals a process GROUP; the two fakeSpawn cases above carry
  // `pid = 900001 + n`, an array index masquerading as a pid. Asserted on the
  // DECISION (was `stop` called?) rather than on an outcome, because "nothing
  // visibly broke" is exactly what killing a stranger's process group looks like
  // from in here.
  //
  // The stub reaps through the ChildProcess HANDLE rather than re-deriving a pid,
  // so this case never itself performs the pid arithmetic it exists to forbid.
  // It also has to reap: stopAndWait waits for the pid to go away after calling
  // stop, so a stub that only records would hang on its own no-op.
  const calls = [];
  let live = null;
  const stubSup = { stop: (arg) => { calls.push(arg); live?.kill('SIGKILL'); } };

  await stopAndWait(stubSup, 'fake-plugin', { pid: 900001, pgid: 900001 });
  assert.deepEqual(calls, [],
    'signalled process group -900001 — a number picked by an array index, and a ' +
    'live pid band on this box (pid_max 4194304, live pids ~3.99M)');

  const real = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await waitFor(() => pidAlive(real.pid));

    // THE PGID CONJUNCT, checked while the child is alive and marked so the ONLY
    // possible reason to refuse is the divergence. The licence is established for
    // rec.pid, but what gets signalled is the group rec.pgid; they coincide only
    // because the supervisor spawns detached (pgid === pid).
    await stopAndWait(stubSup, 'fake-plugin', { pid: real.pid, pgid: real.pid + 1 });
    assert.deepEqual(calls, [],
      'signalled a group the licence was never established for');

    // NON-VACUITY: the same call path must still fire for a real, marked child,
    // or the guard could be a blanket refusal and every teardown registered above
    // would be inert while these cases stayed green.
    live = real;
    await stopAndWait(stubSup, 'fake-plugin', { pid: real.pid, pgid: real.pid });
    assert.deepEqual(calls, [{ id: 'fake-plugin', pgid: real.pid }],
      'a real child of this run inherits CC_TEST_RUN_ID at exec and MUST be stoppable');
  } finally {
    real.kill('SIGKILL'); // idempotent; covers the fail paths above
    await waitFor(() => !pidAlive(real.pid));
  }
});
