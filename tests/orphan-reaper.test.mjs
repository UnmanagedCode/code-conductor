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
import { hasMarker, processesWithMarker } from './procTree.mjs';

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
    4008: `CC_TEST_RUN_ID=${MARK}`,            // marker present but UNTERMINATED
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
    [4008, MARK, false, 'an unterminated final entry is not an anchored match'],
    [900001, MARK, false, 'THE TRAP: a fakeSpawn pid is an array index, not our process'],
    [1, MARK, false, 'init, even carrying our marker'],
    [process.pid, MARK, false, 'ourselves, even carrying our marker'],
    [0, MARK, false, 'pid 0 is the process-group sentinel'],
    [-4001, MARK, false, 'a negative pid signals a GROUP — never licensable here'],
    [4001, '', false, 'no marker means "I cannot tell", not "everything matches"'],
    [4001, undefined, false, 'an unset CC_TEST_RUN_ID must not licence the box'],
    [4.5, MARK, false, 'a non-integer pid is not a pid'],
  ];
  for (const [pid, marker, expected, why] of rows) {
    assert.equal(hasMarker(pid, marker, env), expected, `hasMarker(${pid}, ${marker}): ${why}`);
  }
});

test('hasMarker is never more permissive than processesWithMarker', () => {
  // The two are the SAME identity at different granularity — one pid vs a /proc
  // walk — and the contract that matters is DIRECTIONAL: a caller must not be
  // able to get a more permissive answer by choosing the cheaper call. Pinning it
  // is what stops them drifting; without this, widening one leaves the other's
  // table green. The one deliberate divergence is pinned by the case below.
  const envs = {
    4001: envWith(MARK),
    4002: envWith(MARK + 'XY'),
    4003: envWith('cc-testrun-Other99'),
    4004: 'PATH=/usr/bin\0',
    4005: '',
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

test('hasMarker is STRICTLY tighter on a variable-name collision', () => {
  // The one input on which the two deliberately disagree, pinned so the
  // divergence is a decision rather than a discovery. processesWithMarker asks
  // `env.includes('CC_TEST_RUN_ID=<marker>\0')`, which a variable whose NAME ENDS
  // with ours satisfies; hasMarker anchors the entry's start and refuses. Tighter
  // is the only safe direction for a licence to kill, and this is why the
  // equivalence above is stated directionally.
  const env = `PATH=/usr/bin\0PREV_CC_TEST_RUN_ID=${MARK}\0`;
  assert.equal(hasMarker(4001, MARK, () => env), false);
  const snap = {
    available: true, byParent: new Map(),
    byPid: new Map([[4001, { pid: 4001, ident: '1', argv: [], env }]]),
  };
  assert.deepEqual(processesWithMarker(MARK, snap).map(h => h.pid), [4001],
    'if this ever refuses too, delete this case — the two have converged');
});
