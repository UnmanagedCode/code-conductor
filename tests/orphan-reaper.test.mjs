// The LICENCE-TO-KILL predicates, table-driven (card 2026-0226).
//
// Everything in this file answers one question: may we signal this pid? Both are
// pure over injected input, so both directions are testable with synthesised
// environs and no real processes — which matters, because the failure mode of an
// over-firing predicate is SIGKILLing something that is not ours, and that is not
// a thing to discover empirically.
//
// The rows assert the RETURN VALUE, never a downstream effect. A guard further
// down (killPids refuses `pid <= 1` and `process.pid`) would mask a
// self-matching predicate, and then the predicate could be handed to a caller
// that has no such guard — which is exactly what hasMarker is for.

import test from 'node:test';
import assert from 'node:assert';
import { hasMarker, processesWithMarker, settleResidual, reapResidual } from './procTree.mjs';
import { staleRunTargets } from './reapOrphans.mjs';

const MARK = 'cc-testrun-Abc123';
const envWith = id => `PATH=/usr/bin\0CC_TEST_RUN_ID=${id}\0HOME=/root\0`;
// An injected reader standing in for readFileSync('/proc/<pid>/environ'). `null`
// means the read THROWS (vanished pid, EPERM), which is different from an empty
// read and must reach the same verdict.
const reader = table => (pid) => {
  if (!(pid in table)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const v = table[pid];
  if (v === null) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  return v;
};

test('hasMarker licences exactly this run\'s processes, and nothing else', () => {
  const env = reader({
    4001: envWith(MARK),                       // ours
    4002: envWith(MARK + 'XY'),                // PREFIX SHARER
    4003: envWith('cc-testrun-Other99'),       // a different concurrent run
    4004: 'PATH=/usr/bin\0HOME=/root\0',       // a stranger, no marker
    4005: '',                                  // environ read empty
    4006: null,                                // environ read THREW
    4007: `CC_TEST_RUN_IDX=${MARK}\0`,         // near-miss variable NAME (suffix)
    4010: `PREV_CC_TEST_RUN_ID=${MARK}\0`,     // near-miss variable NAME (PREFIX)
    // DUPLICATE entries, ours SECOND. markerIn reads the FIRST anchored entry, so
    // this answers with the other run's marker and the pid is refused. Not
    // reachable for a real process — execve builds one entry per name — and
    // recorded for its DIRECTION: a duplicate refuses a kill, it never grants
    // one. 4012 is the same blob with ours FIRST, so the row above is pinned as
    // "first-entry semantics", not as "any blob with two markers is refused".
    4011: `CC_TEST_RUN_ID=cc-testrun-Other99\0CC_TEST_RUN_ID=${MARK}\0`,
    4012: `CC_TEST_RUN_ID=${MARK}\0CC_TEST_RUN_ID=cc-testrun-Other99\0`,
    4008: `CC_TEST_RUN_ID=${MARK}`,            // marker present but UNTERMINATED
    // An anchored entry whose VALUE is empty. Real enough (`CC_TEST_RUN_ID= node
    // …` produces it) and it is the only input on which markerIn can return '',
    // which is what makes the falsy-marker rows below discriminate at all.
    4013: 'PATH=/usr/bin\0CC_TEST_RUN_ID=\0',
    900001: 'PATH=/usr/bin\0',                 // the fakeSpawn pid: no environ of ours
    1: envWith(MARK),                          // init, marked
    [process.pid]: envWith(MARK),              // ourselves, marked
  });

  const rows = [
    [4001, MARK, true, 'a plain marked process is ours'],
    [4002, MARK, false, 'a marker that STARTS WITH ours must not match — the trailing-NUL anchor'],
    [4003, MARK, false, 'another concurrent run of this suite is not ours to kill'],
    [4004, MARK, false, 'a stranger carries no marker'],
    [4005, MARK, false, 'an empty environ read is "cannot tell", never "yes"'],
    [4006, MARK, false, 'an unreadable environ must fail CLOSED'],
    [4009, MARK, false, 'a vanished pid must fail CLOSED'],
    [4007, MARK, false, 'CC_TEST_RUN_IDX is a different variable'],
    // The LEADING anchor. A variable whose NAME ENDS with ours satisfies a plain
    // `includes` on the needle, so without `(?:^|\0)` a licence to kill is
    // granted by a name collision.
    [4010, MARK, false, 'PREV_CC_TEST_RUN_ID is a different variable'],
    [4011, MARK, false, 'duplicate markers, ours second: first-entry semantics REFUSE the kill'],
    [4012, MARK, true, 'duplicate markers, ours first: still ours — the rule is position, not count'],
    [4008, MARK, false, 'an unterminated final entry is not an anchored match'],
    [900001, MARK, false, 'THE TRAP: a fakeSpawn pid is an array index, not our process'],
    [1, MARK, false, 'init, even carrying our marker'],
    [process.pid, MARK, false, 'ourselves, even carrying our marker'],
    [0, MARK, false, 'pid 0 is the process-group sentinel'],
    [-4001, MARK, false, 'a negative pid signals a GROUP — never licensable here'],
    // A FALSY MARKER IS "I CANNOT TELL", NEVER "EVERYTHING MATCHES". These
    // REPLACE two earlier rows that carried these same names and pinned nothing:
    // both asked about pid 4001, whose marker is MARK, so strict equality
    // co-guarded them and `if (!marker) return false;` could be deleted with the
    // whole suite green. A row only pins this guard if markerIn's answer for its
    // pid can EQUAL the falsy marker being passed.
    //
    // '' needs the empty-valued entry above. `null` needs a pid with NO entry —
    // markerIn returns null there, so `null === null` licences every unmarked
    // process on the box, which is the worse of the two directions.
    [4013, '', false, 'an empty marker must not match an empty-VALUED entry'],
    [4004, null, false, 'a null marker must not licence every unmarked process on the box'],
    // Not a discriminator, and labelled so rather than left to imply otherwise:
    // markerIn returns `null`, never `undefined`, so with the guard deleted this
    // still answers false. It is a TRIPWIRE on that — if markerIn is ever changed
    // to return undefined, this row starts carrying the same weight as the one
    // above. `undefined` is the realistic value, being an unset env var.
    [4004, undefined, false, 'an unset CC_TEST_RUN_ID must not licence the box'],
    [4.5, MARK, false, 'a non-integer pid is not a pid'],
  ];
  for (const [pid, marker, expected, why] of rows) {
    assert.equal(hasMarker(pid, marker, env), expected, `hasMarker(${pid}, ${marker}): ${why}`);
  }
});

test('hasMarker and processesWithMarker agree on every pid', () => {
  // The two are the SAME identity at different granularity — one pid vs a /proc
  // walk — and both read it through MARKER_RE, so they agree on every input. A
  // caller must not be able to get a looser verdict by choosing the cheaper call,
  // and the loose one would be the DANGEROUS one: processesWithMarker is what
  // feeds sweepOrphans -> killPids on all four sweep triggers. Pinning the
  // equivalence is what stops one of them being widened alone; without it,
  // widening either leaves the other's table green.
  const envs = {
    4001: envWith(MARK),
    4002: envWith(MARK + 'XY'),
    4003: envWith('cc-testrun-Other99'),
    4004: 'PATH=/usr/bin\0',
    4005: '',
    // THE ROW THAT USED TO DIVERGE. processesWithMarker matched this by plain
    // `includes` while hasMarker refused it, so the loose predicate held the kill
    // authority and the tight one guarded a single narrow caller. Both now read
    // MARKER_RE; this row is here so a regression to `includes` breaks the
    // equivalence instead of quietly restoring the asymmetry.
    4006: `PATH=/usr/bin\0PREV_CC_TEST_RUN_ID=${MARK}\0`,
    1: envWith(MARK),
    [process.pid]: envWith(MARK),
  };
  const snap = {
    available: true,
    byParent: new Map(),
    byPid: new Map(Object.entries(envs).map(([pid, env]) =>
      [Number(pid), { pid: Number(pid), ident: '1', argv: [], env }])),
  };
  const walked = new Set(processesWithMarker(MARK, snap).map(h => h.pid));
  for (const pid of Object.keys(envs).map(Number)) {
    assert.equal(hasMarker(pid, MARK, reader(envs)), walked.has(pid),
      `the two identities disagree about pid ${pid}`);
  }
  // Non-vacuity: the agreement above is worthless if both sides said "no" to
  // everything.
  assert.deepEqual([...walked].sort((a, b) => a - b), [4001]);
});

// --- staleRunTargets: the reaper's licence ------------------------------------
//
// Pure over its snapshot and its `rootExists` oracle, so the whole licence is a
// table. Asserted on the RETURN VALUE for the same reason as above: killPids
// downstream refuses `pid <= 1` and `process.pid`, so testing the effect instead
// would let a self-matching or init-matching predicate pass.

const DEAD = 'cc-testrun-Abc123';   // owning run finished: its root is gone
const LIVE = 'cc-testrun-Live99';   // owning run still going: its root exists
const rootExists = marker => marker === LIVE;

// REFUSE DUPLICATE PIDS. `new Map(entries)` keeps the LAST entry for a repeated
// key, so a table row that reuses a pid silently VOIDS the earlier one — the row
// is still there to read, still commented, and no longer reaches the code under
// test. That happened here (5010 was used twice; the empty-valued-marker row
// never reached byPid, and deleting it left the file green), and a fixture row
// that silently voids itself is exactly the class this card exists to close. A
// guard in the builder makes the next one a loud failure instead of a quiet one.
function assertDistinctPids(rows) {
  const seen = new Set();
  for (const r of rows) {
    assert.ok(!seen.has(r.pid), `duplicate pid ${r.pid} in a snapshot table — ` +
      'the later row silently voids the earlier one, which then tests nothing');
    seen.add(r.pid);
  }
  return rows;
}

const rowsToSnap = (rows, { available = true } = {}) => ({
  available,
  byParent: new Map(),
  byPid: new Map(assertDistinctPids(rows)
    .map(r => [r.pid, { ident: '1', argv: ['node', 'server.mjs'], env: '', ...r }])),
});

test('staleRunTargets licences only processes of a PROVABLY finished run', () => {
  const rows = [
    // MATCHES.
    { pid: 5001, env: envWith(DEAD) },                    // plain descendant of a dead run
    // A depth-2 detached grandchild. staleRunTargets never consults lineage, so
    // this is expressed as a row whose parent is not even in the snapshot — which
    // is precisely the reparented-to-init state every measured orphan was in, and
    // the state no /proc walk can reach.
    { pid: 5002, ppid: 999999, env: envWith(DEAD) },

    // REFUSALS, one per conjunct.
    { pid: 5003, env: envWith(LIVE) },                    // the owning run is STILL RUNNING
    { pid: 1, env: envWith(DEAD) },                       // init, marked
    { pid: process.pid, env: envWith(DEAD) },             // ourselves, marked
    { pid: 5004, env: 'PATH=/usr/bin\0HOME=/root\0' },    // a stranger, no marker
    { pid: 5005, env: '' },                               // environ unreadable
    // Marker present, WRONG SHAPE: an ad-hoc value some other tool exported under
    // the same variable name. Without RUN_ROOT_SHAPE this is a licence to kill
    // anything that sets CC_TEST_RUN_ID at all.
    { pid: 5006, env: envWith('repro-1234-orphan-probe') },
    // An anchored entry with an EMPTY value: captures '', which is not run-root
    // shaped. Refused by the same conjunct, and worth its line because '' is the
    // one value that slips past a truthiness check.
    { pid: 5011, env: 'PATH=/usr/bin\0CC_TEST_RUN_ID=\0' },
    // PREFIX SHARER: its marker STARTS WITH the dead run's. The capture is
    // anchored at both ends, so the captured value is the whole entry and cannot
    // be confused with the shorter one.
    { pid: 5007, env: envWith(DEAD + 'XY') },
    // Near-miss variable NAMES. 5008 is excluded by `CC_TEST_RUN_ID` simply not
    // being followed by `=`; 5010 is the one the LEADING `(?:^|\0)` anchor exists
    // for — a name ENDING with ours satisfies an unanchored search, so without it
    // an unrelated process is licensed by a name collision. (5011 above is the
    // empty-valued entry; these three pids are distinct on purpose.)
    { pid: 5008, env: `CC_TEST_RUN_IDX=${DEAD}\0` },
    { pid: 5010, env: `PREV_CC_TEST_RUN_ID=${DEAD}\0` },
    // Marker present but the entry is UNTERMINATED: fail closed.
    { pid: 5009, env: `PATH=/usr/bin\0CC_TEST_RUN_ID=${DEAD}` },
  ];
  const got = staleRunTargets(rowsToSnap(rows), rootExists);
  assert.deepEqual(got.map(t => t.pid), [5002, 5001],
    'exactly the two dead-run processes, and DESCENDING by pid');
  assert.deepEqual(got.map(t => t.marker), [DEAD, DEAD]);
  // The entry must carry the starttime ident through, or killPids' recycled-pid
  // re-check silently degrades to "no identity recorded" and kills best-effort.
  assert.deepEqual(got.map(t => t.ident), ['1', '1']);
});

test('staleRunTargets yields nothing when /proc could not be read', () => {
  // DELIBERATELY POPULATED with a row that WOULD match. With an empty byPid this
  // passes with the `!snap.available` guard deleted, since the loop returns []
  // either way — and a partially populated unavailable snapshot is exactly what a
  // /proc partial read yields, the one case where that guard is all that stands
  // between "I cannot see" and a kill list.
  const rows = [{ pid: 5001, env: envWith(DEAD) }];
  assert.deepEqual(staleRunTargets(rowsToSnap(rows, { available: false }), rootExists), []);
  // Non-vacuity: the same row DOES match once /proc is readable.
  assert.deepEqual(staleRunTargets(rowsToSnap(rows), rootExists).map(t => t.pid), [5001]);
});

test('staleRunTargets treats every OTHER run as live when scoped to one id', () => {
  // How --id works: `rootExists` becomes `marker !== onlyId`, so naming a run
  // whose root survived a SIGKILL narrows the list to that run instead of
  // widening it to every run whose root happens to be missing. A typo therefore
  // selects nothing.
  const rows = [
    { pid: 5001, env: envWith(DEAD) },
    { pid: 5002, env: envWith('cc-testrun-Other9') },
  ];
  const scoped = marker => marker !== DEAD;
  assert.deepEqual(staleRunTargets(rowsToSnap(rows), scoped).map(t => t.pid), [5001]);
  assert.deepEqual(staleRunTargets(rowsToSnap(rows), marker => marker !== 'cc-testrun-Typo00'), []);
});

// --- settleResidual: the bounded liveness re-check ---------------------------
//
// This loop is what turned a false RESIDUAL (observed at load 25, failing an
// otherwise healthy run) into a correct one, and it decides which pids get
// SIGKILLed at teardown. Before these cases its coverage was purely
// STATISTICAL — every nested-runner sweep exercises it, but nothing
// discriminated a regression, so inverting the filter or dropping the deadline
// left the whole suite green.
//
// The clock and sleep are injected, so every case below is deterministic and
// costs no real time. CONVENTIONS.md's "no long real sleeps" is satisfied by
// construction rather than by choosing small numbers.

// `sleep` ADVANCES the clock, so the bound is exercised without waiting, and it
// THROWS past `cap` iterations — a deleted deadline check then fails by name
// instead of hanging the file until the per-file watchdog SIGKILLs it.
function fakeClock({ cap = 60, t0 = 1000 } = {}) {
  let t = t0;
  const c = { nowCalls: 0, sleeps: [] };
  c.now = () => { c.nowCalls++; return t; };
  c.sleep = (ms) => {
    c.sleeps.push(ms);
    if (c.sleeps.length > cap) {
      throw new Error(`settleResidual looped ${c.sleeps.length}x — its deadline exit is gone`);
    }
    t += ms;
    return Promise.resolve();
  };
  return c;
}
const entry = (pid) => ({ pid, ident: `i${pid}`, argv: ['node', 'holder.mjs'] });

test('settleResidual returns a candidate that stays marked for the whole bound', () => {
  // The genuine survivor: something the sweep failed to kill. It must reach the
  // caller so it is reaped and the run goes red.
  const clock = fakeClock();
  return settleResidual([entry(5001), entry(5002)], MARK, {
    hasMarker: () => true, settleMs: 100, stepMs: 10, now: clock.now, sleep: clock.sleep,
  }).then((out) => {
    assert.deepEqual(out.map(h => h.pid), [5001, 5002]);
    // The ENTRIES survive intact, not just the pids: killPids re-verifies each
    // `ident` against the live process before signalling, and an entry stripped
    // to a bare pid silently downgrades that to a best-effort kill.
    assert.deepEqual(out.map(h => h.ident), ['i5001', 'i5002']);
    assert.equal(clock.sleeps.length, 10, '100ms bound / 10ms step');
  });
});

test('settleResidual drops a candidate the live re-verify says is gone', async () => {
  // THE FALSE-RESIDUAL CASE — the whole reason the loop exists. The input is
  // deliberately POPULATED with an entry the caller's snapshot claimed was alive;
  // with an empty list this case passes with the filter deleted.
  const clock = fakeClock();
  const asked = [];
  const out = await settleResidual([entry(5001)], MARK, {
    hasMarker: (pid, m) => { asked.push([pid, m]); return false; },
    settleMs: 250, now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(out, [], 'a stale snapshot entry must not survive the re-verify');
  assert.deepEqual(asked, [[5001, MARK]], 'the pid AND this run\'s marker must be re-asked');
  assert.deepEqual(clock.sleeps, [], 'nothing left to wait for — must not sleep out the bound');
});

test('settleResidual stops at the moment a candidate flips to gone', async () => {
  // The realistic shape: the process needed a couple of milliseconds to die.
  // Pins that the loop neither gives up early nor spins out the full bound.
  const clock = fakeClock();
  let calls = 0;
  const out = await settleResidual([entry(5001)], MARK, {
    hasMarker: () => ++calls < 3,      // marked on 1 and 2, gone on 3
    settleMs: 250, stepMs: 10, now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 3, 'it must keep re-asking while the answer is still "marked"');
  assert.deepEqual(clock.sleeps, [10, 10], 'stopped at the flip, did not ride out the bound');
});

test('settleResidual terminates on its deadline and reports the survivor', async () => {
  // The DEADLINE itself. Without it this loop never returns for a process that
  // outlives the bound, and the run hangs at teardown instead of reddening —
  // trading a leak for the hang this whole guard exists to prevent. The injected
  // sleep throws past its cap, so that regression fails by name.
  const clock = fakeClock({ cap: 40 });
  const out = await settleResidual([entry(5001)], MARK, {
    hasMarker: () => true, settleMs: 250, stepMs: 10, now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(out.map(h => h.pid), [5001],
    'still marked at the bound: must be REPORTED, never silently dropped');
  assert.equal(clock.sleeps.length, 25, '250ms bound / 10ms step, then it gives up');
});

test('settleResidual returns on an empty set without touching the clock', async () => {
  // What keeps the healthy path free. Every green run takes this branch, so it
  // must cost nothing — not a sleep, and not even a Date.now(). Asserting
  // nowCalls is what makes the early return killable: without it the loop still
  // returns [], correctly, having read the clock.
  const clock = fakeClock();
  const out = await settleResidual([], MARK, {
    hasMarker: () => { throw new Error('an empty set must not be re-verified'); },
    settleMs: 250, now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(out, []);
  assert.equal(clock.nowCalls, 0, 'the healthy path must not compute a deadline at all');
  assert.deepEqual(clock.sleeps, []);
});

test('reapResidual SIGKILLs the licensed set and reports both counts', async () => {
  // THE STEP THAT TURNS "DETECTED" INTO "HELD". Deleting it is invisible from
  // outside: the diagnostic still prints and the run still goes red, while
  // removeSafeRoot then pulls the run root out from under a live process. So the
  // action is asserted as a RETURN VALUE.
  const residual = [entry(5001), entry(5002)];
  const seen = [];
  const got = reapResidual(residual, { kill: (e) => { seen.push(...e); return e.map(x => x.pid); } });

  assert.deepEqual(seen, residual, 'the whole licensed set must be handed to the reaper, entries intact');
  assert.deepEqual(got.reaped, [5001, 5002], 'the reaped pids must reach the caller');
  assert.match(got.message, /^RESIDUAL 2 marked process\(es\) still alive at teardown \(pids 5001,5002\); SIGKILLed 2\.$/);

  // A reap that SIGNALS NOTHING must not read as a clean one. This is the
  // short-circuit shape — killPids legitimately returns fewer pids than it was
  // given when an identity re-check rejects one — and the message has to stay
  // honest about it rather than echoing the input count twice.
  const none = reapResidual(residual, { kill: () => [] });
  assert.deepEqual(none.reaped, []);
  assert.match(none.message, /RESIDUAL 2 .*; SIGKILLed 0\.$/);
});
