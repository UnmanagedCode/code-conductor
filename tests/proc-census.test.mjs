// The fake-claude guardrail's census, table-driven (card 2026-0344).
//
// One question, and it is not the licence-to-kill one tests/orphan-reaper.test.mjs
// answers: of the processes on this box whose command line names fake-claude,
// which ones are THIS run's? The guardrail budget is a claim about the suite's own
// behaviour, so a sibling suite run on the same box must not be able to red it —
// nor to hide behind it.
//
// Pure over a synthesised snapshot and an injected marker predicate, so both
// directions are testable with no real processes. The predicate injected below is
// the production `hasMarker` wrapped in a counting environ reader: the census's
// answer and its /proc read COUNT are both properties under test, and the second
// one is why this file exists as much as the first.

import test from 'node:test';
import assert from 'node:assert';
import { censusMatching, hasMarker } from './procTree.mjs';

const MARK = 'cc-testrun-Abc123';
const envWith = id => `PATH=/usr/bin\0CC_TEST_RUN_ID=${id}\0HOME=/root\0`;
// A real per-file child's cmdline: argv[0] is `node`, and the script path — the
// only place the needle appears — is a LATER NUL-separated element.
const fake = pid => `node\0/repo/tests/fake-claude.mjs\0--scenario=s${pid}\0`;
const other = 'node\0/repo/tests/run.mjs\0';

// snapshot()'s shape, as much of it as censusMatching reads.
function snapOf(rows) {
  const byPid = new Map();
  for (const [pid, raw] of Object.entries(rows)) {
    byPid.set(Number(pid), { pid: Number(pid), ppid: 1, ident: '1', raw, env: '', argv: raw.split('\0').filter(Boolean) });
  }
  return { available: true, byPid, byParent: new Map() };
}

// An injected stand-in for readFileSync('/proc/<pid>/environ'). Absent means the
// read THROWS (vanished pid), `null` means EACCES — both distinct from an empty
// read and all three must reach the same verdict. Every call is recorded, so a
// test can assert on which pids were read at all.
function probe(envTable) {
  const reads = [];
  const read = (pid) => {
    reads.push(pid);
    if (!(pid in envTable)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const v = envTable[pid];
    if (v === null) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return v;
  };
  return { reads, hasMarker: (pid, marker) => hasMarker(pid, marker, read) };
}

test('owned counts only the matches carrying THIS run\'s marker', () => {
  // The correctness change. A box-wide count answers 5 here.
  const snap = snapOf({
    4001: fake(4001),   // ours
    4002: fake(4002),   // a DIFFERENT concurrent run of this suite
    4003: fake(4003),   // no CC_TEST_RUN_ID at all
    4004: fake(4004),   // environ read THREW (EACCES)
    4005: fake(4005),   // pid vanished between the walk and the read
    4006: other,        // not a fake-claude
  });
  const p = probe({
    4001: envWith(MARK),
    4002: envWith('cc-testrun-Other99'),
    4003: 'PATH=/usr/bin\0HOME=/root\0',
    4004: null,
  });
  const census = censusMatching('fake-claude.mjs', MARK, snap, p);
  assert.equal(census.owned, 1, 'only pid 4001 carries this run\'s marker');
  assert.equal(census.available, true);
});

test('seen counts every cmdline match whatever its marker, and is never below owned', () => {
  // The blindness diagnostic. If a future test ever spawns fake-claude with a
  // curated env that drops CC_TEST_RUN_ID, `owned` silently falls to 0 while
  // `seen` stays high — a guard that can stop guarding without saying so is worse
  // than the box-wide one it replaced, and this is the only signal that shows it.
  const snap = snapOf({ 4001: fake(4001), 4002: fake(4002), 4003: fake(4003), 4009: other });
  const p = probe({ 4001: envWith(MARK), 4002: envWith('cc-testrun-Other99'), 4003: envWith(MARK) });
  const census = censusMatching('fake-claude.mjs', MARK, snap, p);
  assert.equal(census.seen, 3, 'all three fake-claude cmdlines are seen');
  assert.equal(census.owned, 2);
  assert.ok(census.seen >= census.owned, 'seen is a superset count of owned');

  // And the blind case itself: every match is a stranger's.
  const blind = censusMatching('fake-claude.mjs', MARK, snapOf({ 4002: fake(4002) }),
    probe({ 4002: envWith('cc-testrun-Other99') }));
  assert.deepEqual({ ...blind }, { available: true, owned: 0, seen: 1 });
});

test('an unavailable snapshot is "cannot tell", not "nothing running"', () => {
  // tests/run.mjs gates `sampledProcs` on this: without /proc the guardrail never
  // looked, and a verdict of 0 would claim the property it could not observe.
  const census = censusMatching('fake-claude.mjs', MARK,
    { available: false, byPid: new Map(), byParent: new Map() }, probe({}));
  assert.equal(census.available, false);
  assert.notDeepEqual(
    { ...census },
    { ...censusMatching('fake-claude.mjs', MARK, snapOf({ 4009: other }), probe({})) },
    'unavailable must not read the same as an available walk that found nothing',
  );
});

test('the needle is matched against the whole NUL-separated cmdline, not argv[0]', () => {
  // Carried over from countMatching. Every real match here has argv[0] === 'node'
  // and the needle in a later element, so a predicate narrowed to the executable
  // would count zero.
  const snap = snapOf({ 4001: fake(4001), 4002: 'node\0/repo/tests/fake-claude.mjs\0' });
  const census = censusMatching('fake-claude.mjs', MARK, snap, probe({ 4001: envWith(MARK), 4002: envWith(MARK) }));
  assert.equal(census.seen, 2);
  assert.equal(census.owned, 2);
});

test('no environ read is issued for a pid whose cmdline does not match', () => {
  // THE PERFORMANCE PROPERTY, and the reason this is not simply
  // processesWithMarker over snapshot({environ:true}). This runs at 10 Hz over
  // every visible pid — ~2700 on this box — so an environ read per pid would
  // regress the sampler that card 2026-0344 exists to speed up. Filtering on the
  // already-loaded cmdline first bounds the reads to the handful of matches.
  const rows = { 4001: fake(4001), 4002: fake(4002) };
  for (let pid = 5000; pid < 5200; pid++) rows[pid] = `node\0/repo/tests/unrelated-${pid}.mjs\0`;
  const p = probe({ 4001: envWith(MARK), 4002: envWith(MARK) });
  const census = censusMatching('fake-claude.mjs', MARK, snapOf(rows), p);
  assert.equal(census.owned, 2);
  assert.deepEqual(p.reads, [4001, 4002],
    'exactly the cmdline matches were read, in walk order, and nothing else');
});
