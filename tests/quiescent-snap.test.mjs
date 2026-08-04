// Pure-function tests for the quiescent-point snapper (src/parser.ts):
// snapStartToQuiescent (page/tail window starts) and firstQuiescentAtOrAfter
// (EventLog._trim fallback). No server, no DOM — hand-built UI-event arrays.
//
// A cut index i is quiescent when no outer block is mid-stream and every
// outer tool_use has its tool_result; outer user_echo/turn_end force-reset;
// sub-agent (parentToolUseId) events are scan-opaque — their wholeness comes
// from the group-boundary resolver (a head at or before the child is pulled
// in; a child with no such head is pushed past), exercised here too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  snapStartToGroupBoundary,
  snapStartToQuiescent,
  firstQuiescentAtOrAfter,
} from '../src/parser.ts';

// --- terse event builders --------------------------------------------------
let msgN = 0;
const echo = (text = 'hi') => ({ kind: 'user_echo', text });
const turnEnd = () => ({ kind: 'turn_end', subtype: 'success' });
const thinkStart = (m = 'm', i = 0) => ({ kind: 'thinking_start', msgId: m, blockIdx: i });
const thinkDelta = (m = 'm', i = 0) => ({ kind: 'thinking_delta', msgId: m, blockIdx: i, text: 't' });
const thinkEnd = (m = 'm', i = 0) => ({ kind: 'thinking_end', msgId: m, blockIdx: i });
const tDelta = (m = 'm', i = 0) => ({ kind: 'text_delta', msgId: m, blockIdx: i, text: 'x' });
const tEnd = (m = 'm', i = 0) => ({ kind: 'text_end', msgId: m, blockIdx: i });
const tuStart = (id, m = 'm', i = 0) => ({ kind: 'tool_use_start', msgId: m, blockIdx: i, toolUseId: id, name: 'Bash' });
const tuDelta = (id, m = 'm', i = 0) => ({ kind: 'tool_use_input_delta', msgId: m, blockIdx: i, toolUseId: id, partialJson: '{' });
const tu = (id, m = 'm', i = 0, name = 'Bash') => ({ kind: 'tool_use', msgId: m, blockIdx: i, toolUseId: id, name, input: {} });
const tr = (id) => ({ kind: 'tool_result', toolUseId: id, content: 'ok', isError: false });
const asstMsg = (m) => ({ kind: 'assistant_message', msgId: m, message: { id: m, content: [{ type: 'text', text: 'sub' }] } });
const child = (ev, pid) => ({ ...ev, parentToolUseId: pid });

// Invariant checker: window [s, end) must contain only whole outer blocks,
// fully-resolved outer tool spans (unless force-reset by a later echo /
// turn_end inside the window), and no child event without its head. The head
// check is ORDER-AWARE on purpose — a child may not precede its own head in
// the window, since the renderer nests children under an already-built head.
function assertWindowIntegrity(arr, s, end, label) {
  const open = new Set(); const pending = new Set(); const heads = new Set();
  for (let i = s; i < end; i++) {
    const ev = arr[i];
    // Registered BEFORE the child check, and for child events too — a
    // sub-agent tool head is ITSELF a child of its outer group, so skipping
    // heads that carry a parentToolUseId would make a nested head unable to
    // satisfy its own children. This deliberately WEAKENS the check (more ids
    // in `heads` at each assertion): it tolerates "child of B where B's head
    // is itself a child of A". That shape is legitimate, and it is not a hole
    // — if A's head were missing, the assertion still fires on B's own line.
    // Do not "fix" this back to registering only outer heads.
    if (ev.toolUseId && (ev.kind === 'tool_use_start' || ev.kind === 'tool_use')) {
      heads.add(ev.toolUseId);
    }
    if (ev.parentToolUseId) {
      assert.ok(heads.has(ev.parentToolUseId),
        `${label}: child at ${i} (parent ${ev.parentToolUseId}) has no head in [${s},${end})`);
      continue;
    }
    switch (ev.kind) {
      case 'user_echo': case 'turn_end': open.clear(); pending.clear(); break;
      case 'text_delta': open.add(`${ev.msgId}:${ev.blockIdx}:text`); break;
      case 'text_end': {
        const k = `${ev.msgId}:${ev.blockIdx}:text`;
        assert.ok(open.has(k), `${label}: text_end at ${i} closes a block opened outside the window`);
        open.delete(k); break;
      }
      case 'thinking_start': case 'thinking_delta': open.add(`${ev.msgId}:${ev.blockIdx}:think`); break;
      case 'thinking_end': open.delete(`${ev.msgId}:${ev.blockIdx}:think`); break;
      case 'tool_use_start': case 'tool_use_input_delta': case 'tool_use':
        if (ev.toolUseId) pending.add(ev.toolUseId); break;
      case 'tool_result':
        if (ev.toolUseId) {
          assert.ok(pending.has(ev.toolUseId),
            `${label}: tool_result at ${i} resolves a tool_use outside the window`);
          pending.delete(ev.toolUseId);
        }
        break;
      default: break;
    }
    if (ev.kind === 'tool_result' && ev.toolUseId) pending.delete(ev.toolUseId);
  }
}

// --- fixtures ---------------------------------------------------------------

function productionOverlapFixture() {
  const arr = Array.from({ length: 1390 }, () => ({ kind: 'system', subtype: 'status' }));
  // Production ordering: nested tool heads are themselves children of outer
  // Agent groups. Some outer heads have fallen out of the available array,
  // while several inner heads remain and their child ranges overlap.
  arr[359] = child(tu('survive-a', 'sa', 0, 'Read'), 'missing-a');
  arr[567] = child(tu('survive-b', 'sb', 0, 'Bash'), 'missing-a');
  arr[767] = child(tu('survive-c', 'sc', 0, 'Grep'), 'missing-b');
  arr[973] = child(tu('survive-d', 'sd', 0, 'Agent'), 'missing-b');
  arr[770] = child(asstMsg('ca'), 'survive-a');
  arr[1249] = child(asstMsg('cc'), 'survive-c');
  arr[1358] = child(asstMsg('ma'), 'missing-a');
  arr[1376] = child(asstMsg('cd'), 'survive-d');
  arr[1380] = child(asstMsg('mb'), 'missing-b');
  arr[1385] = child(asstMsg('cb'), 'survive-b');
  arr[1386] = { kind: 'system', subtype: 'safe-tail' };
  return arr;
}

// Run one snapper against a fixture in a worker under a deadline. An
// oscillating implementation is a synchronous infinite loop, which would hang
// the whole test FILE; here it fails on the deadline instead. Use this for any
// fixture that combines a surviving head with a headless group — that is the
// shape the old fixpoint cycled on.
async function snapInWorker(arr, start, end, { fn = 'snapStartToQuiescent', timeoutMs = 2_000 } = {}) {
  const parserUrl = new URL('../src/parser.ts', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.parserUrl).then((mod) => {
      parentPort.postMessage(mod[workerData.fn](
        workerData.arr, workerData.start, workerData.end,
      ));
    }).catch((error) => { throw error; });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { parserUrl, arr, start, end, fn },
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `${fn} did not terminate within ${timeoutMs}ms`,
      )), timeoutMs);
      worker.once('message', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`boundary worker exited with code ${code}`));
        }
      });
    });
  } finally {
    await worker.terminate();
  }
}

// --- group-boundary regressions ----------------------------------------------

test('overlap cycle excludes the headless component but preserves a safe suffix', () => {
  const arr = [
    /*0*/ tu('B', 'mB'),
    /*1*/ child(asstMsg('ca'), 'A'), // A head unavailable
    /*2*/ child(asstMsg('cb'), 'B'),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  const s = snapStartToGroupBoundary(arr, 1, arr.length);
  assert.equal(s, 3);
  assertWindowIntegrity(arr, s, arr.length, 'minimal cycle');
});

test('overlapping surviving groups resolve to the merged left edge', () => {
  const arr = [
    /*0*/ tu('A', 'ma'),
    /*1*/ ({ kind: 'system', subtype: 'neutral' }),
    /*2*/ tu('B', 'mb'),
    /*3*/ ({ kind: 'system', subtype: 'neutral' }),
    /*4*/ child(asstMsg('ca'), 'A'),
    /*5*/ child(asstMsg('cb'), 'B'),
  ];
  const s = snapStartToGroupBoundary(arr, 3, arr.length);
  assert.equal(s, 0);
  assertWindowIntegrity(arr, s, arr.length, 'surviving overlap');
});

test('multiple headless groups are fully excluded together', () => {
  const arr = [
    /*0*/ child(asstMsg('a1'), 'A'),
    /*1*/ ({ kind: 'system', subtype: 'neutral' }),
    /*2*/ child(asstMsg('b1'), 'B'),
    /*3*/ child(asstMsg('a2'), 'A'),
    /*4*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  const s = snapStartToGroupBoundary(arr, 1, arr.length);
  assert.equal(s, 4);
  assertWindowIntegrity(arr, s, arr.length, 'multiple headless');
});

test('finalized tool_use is the latest stream head for its group', () => {
  const arr = [
    /*0*/ tuStart('T', 'm1'),
    /*1*/ tuDelta('T', 'm1'),
    /*2*/ tu('T', 'm1', 0, 'Read'),
    /*3*/ child(asstMsg('sub'), 'T'),
  ];
  // Live streaming emits tool_use_start before the finalized tool_use. The
  // finalized event is the nearest recognized head and avoids overextending
  // the slice back through its input stream.
  assert.equal(snapStartToGroupBoundary(arr, 3, arr.length), 2);
});

test('adjacent group intervals merge, so a nested head cannot strand its own parent', () => {
  const arr = [
    /*0*/ tu('A', 'm1'),                    // outer head A
    /*1*/ child(tu('B', 'm2'), 'A'),        // head B — and itself a child of A
    /*2*/ child(asstMsg('c'), 'B'),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  // A forbids [1,1] and B forbids [2,2]: adjacent, not overlapping. They must
  // merge into [1,2], so the cut lands at 0 and keeps BOTH heads. Left
  // unmerged, a cut at 2 would resolve to B's edge (1) and strand A's child.
  const s = snapStartToGroupBoundary(arr, 2, arr.length);
  assert.equal(s, 0);
  assertWindowIntegrity(arr, s, arr.length, 'adjacent merge');
});

test('a group whose children all sit below the candidate imposes no constraint', () => {
  const surviving = [
    /*0*/ tu('A', 'm1'),
    /*1*/ child(asstMsg('c'), 'A'),
    /*2*/ ({ kind: 'system', subtype: 'neutral' }),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  assert.equal(snapStartToGroupBoundary(surviving, 2, surviving.length), 2);
  assert.equal(snapStartToGroupBoundary(surviving, 3, surviving.length), 3);

  // Same for a headless group: past its last child, it constrains nothing.
  const headless = [
    /*0*/ child(asstMsg('c'), 'missing'),
    /*1*/ ({ kind: 'system', subtype: 'neutral' }),
    /*2*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  assert.equal(snapStartToGroupBoundary(headless, 1, headless.length), 1);
  assert.equal(snapStartToGroupBoundary(headless, 2, headless.length), 2);
});

test('surviving group with no quiescent cut to its left falls back rightward', () => {
  const arr = [
    /*0*/ tDelta('m', 0),                    // opens an outer text block
    /*1*/ child(asstMsg('sub'), 'missing'),  // headless — forbids [0,1]
    /*2*/ tu('A', 'm', 0),                   // head A (block still open)
    /*3*/ tr('A'),
    /*4*/ tEnd('m', 0),                      // block closes AFTER this applies
    /*5*/ ({ kind: 'system', subtype: 'neutral' }),
    /*6*/ child(asstMsg('c'), 'A'),          // A forbids [3,6]
    /*7*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  // 5 is quiescent but sits inside A's surviving interval. Every quiescent cut
  // below it (only index 0) lies inside the headless component, so the
  // backward search legitimately fails and the rightward fallback runs.
  const s = snapStartToQuiescent(arr, 5, arr.length);
  assert.equal(s, 7, 'excluded forward past the whole group, not to A head at 2');
  assertWindowIntegrity(arr, s, arr.length, 'rightward fallback');
});

test('group boundary normalizes edges and preserves ID truthiness semantics', () => {
  assert.equal(snapStartToGroupBoundary([], -4, 0), 0);

  const headless = [
    child(asstMsg('sub'), 'missing'),
    { kind: 'system', subtype: 'safe-tail' },
  ];
  assert.equal(snapStartToGroupBoundary(headless, -4, headless.length), 1);
  assert.equal(snapStartToGroupBoundary(headless, 0, headless.length), 1);
  assert.equal(snapStartToGroupBoundary(headless, 1, headless.length), 1);
  assert.equal(snapStartToGroupBoundary(headless, headless.length, headless.length), 2);

  const ignored = [
    child(asstMsg('empty-parent'), ''),
    { ...tu('', 'm1'), name: 'Agent' },
    child(asstMsg('truthy-parent'), 'T'),
    { kind: 'system', subtype: 'safe-tail' },
  ];
  assert.equal(snapStartToGroupBoundary(ignored, 0, ignored.length), 3,
    'empty parent is ignored and an empty head ID does not satisfy T');

  const arbitraryName = [tu('T', 'm2', 0, 'CustomTool'), child(asstMsg('c'), 'T')];
  assert.equal(snapStartToGroupBoundary(arbitraryName, 1, arbitraryName.length), 0,
    'recognized heads are not restricted by tool name');
});

test('a tool_use_start with no finalized tool_use still counts as a head', () => {
  // The live-streaming case where the turn is cut off (or the window ends)
  // before the finalized tool_use: tool_use_start is the group's ONLY head.
  // Every other fixture pairs tuStart with a later tu, so without this one,
  // dropping tool_use_start from head recognition would change no expectation.
  const arr = [
    /*0*/ tuStart('T', 'm1'),
    /*1*/ tuDelta('T', 'm1'),
    /*2*/ child(asstMsg('sub'), 'T'),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  assert.equal(snapStartToGroupBoundary(arr, 2, arr.length), 0,
    'pulled back to the tool_use_start, not pushed past the child as headless');
  assertWindowIntegrity(arr, 0, arr.length, 'tool_use_start-only head');

  // Extra coverage of the merge, NOT of head recognition: this one returns 3
  // either way (recognized, T forbids [1,1] and merges with GONE's [0,2];
  // unrecognized, T forbids [0,1] and still merges to [0,2]). The claim above
  // rests on the first fixture alone.
  const mixed = [
    /*0*/ tuStart('T', 'm1'),
    /*1*/ child(asstMsg('sub'), 'T'),
    /*2*/ child(asstMsg('orphan'), 'GONE'),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  assert.equal(snapStartToGroupBoundary(mixed, 1, mixed.length), 3);
  assertWindowIntegrity(mixed, 3, mixed.length, 'tool_use_start head vs headless');
});

test('snapStartToQuiescent returns end for an already-empty window', () => {
  const arr = [echo('hi'), tDelta('m', 0), tEnd('m', 0)];
  // start === end: the slice is empty, so it is trivially valid and must be
  // returned as-is rather than snapped anywhere.
  assert.equal(snapStartToQuiescent(arr, arr.length, arr.length), 3);
  assert.equal(snapStartToQuiescent(arr, 1, 1), 1);
  assert.equal(snapStartToQuiescent([], 0, 0), 0);
  // Out-of-range start clamps into [0, end] before the emptiness check.
  assert.equal(snapStartToQuiescent(arr, 99, arr.length), 3);
});

test('the former-oscillation paging fixture terminates under a deadline', async () => {
  // The exact array behind quiescent-paging.test.mjs's snapshotTail overlap:
  // a nested surviving head B (itself a child of a headless A) plus children
  // of both. The old fixpoint cycled 2 → 0 → 2 → 0 on this, so a
  // reintroduced loop would HANG that server-backed test rather than fail it.
  // Guard the same shape here, where the worker deadline can catch it.
  const arr = [
    /*0*/ child(tu('B', 'mB', 0, 'Read'), 'A'), // A head unavailable
    /*1*/ child(asstMsg('ca'), 'A'),
    /*2*/ child(asstMsg('cb'), 'B'),
    /*3*/ ({ kind: 'system', subtype: 'safe-tail' }),
  ];
  assert.equal(await snapInWorker(arr, 2, arr.length, { fn: 'snapStartToGroupBoundary' }), 3);
  assert.equal(await snapInWorker(arr, 2, arr.length), 3);
  assertWindowIntegrity(arr, 3, arr.length, 'paging overlap shape');
});

test('forward headless exclusion is re-snapped to a quiescent outer boundary', () => {
  const arr = [
    /*0*/ echo('A'),
    /*1*/ tDelta('outer'),
    /*2*/ child(asstMsg('sub'), 'missing'),
    /*3*/ tDelta('outer'),
    /*4*/ tEnd('outer'),
    /*5*/ turnEnd(),
  ];
  for (const candidate of [0, 1]) {
    const s = snapStartToQuiescent(arr, candidate, arr.length);
    assert.equal(s, 5, `candidate ${candidate}`);
    assertWindowIntegrity(arr, s, arr.length, `forward quiescence ${candidate}`);
  }
});

test('group ownership crosses resetIdx while quiescence treats it as a barrier', () => {
  const arr = [
    /*0*/ tu('T', 'm1'),
    /*1*/ tr('T'),
    // ---- archive/ring seam ----
    /*2*/ ({ kind: 'system', subtype: 'ring-head' }),
    /*3*/ child(asstMsg('sub'), 'T'),
    /*4*/ ({ kind: 'system', subtype: 'tail' }),
  ];
  const s = snapStartToQuiescent(arr, 3, arr.length, { resetIdx: 2 });
  assert.equal(s, 0);
  assertWindowIntegrity(arr, s, arr.length, 'cross-seam owner');
});

test('production-shaped overlap resolves to the exact nonempty safe suffix', () => {
  const arr = productionOverlapFixture();
  const s = snapStartToQuiescent(arr, 1000, arr.length);
  assert.equal(s, 1386);
  assert.ok(s < arr.length, 'safe retained tail is not discarded');
  assertWindowIntegrity(arr, s, arr.length, 'production overlap');
});

test('production-shaped overlap completes within a bounded worker deadline', async () => {
  const arr = productionOverlapFixture();
  assert.equal(await snapInWorker(arr, 1000, arr.length), 1386);
});

// --- quiescent fixtures -------------------------------------------------------

// One turn: thinking, text, a tool round-trip, closing text.
function roundTripTurn() {
  return [
    /* 0*/ echo('A'),
    /* 1*/ thinkStart('m1'), /* 2*/ thinkDelta('m1'), /* 3*/ thinkEnd('m1'),
    /* 4*/ tDelta('m1', 1), /* 5*/ tDelta('m1', 1), /* 6*/ tEnd('m1', 1),
    /* 7*/ tuStart('t1', 'm2'), /* 8*/ tuDelta('t1', 'm2'), /* 9*/ tu('t1', 'm2'),
    /*10*/ tr('t1'),
    /*11*/ tDelta('m3'), /*12*/ tEnd('m3'),
    /*13*/ turnEnd(),
    /*14*/ echo('B'), /*15*/ tDelta('m4'), /*16*/ tEnd('m4'), /*17*/ turnEnd(),
  ];
}

test('mid-block cut snaps forward to the next quiescent point', () => {
  const arr = roundTripTurn();
  // 2 is inside the thinking block → first quiescent above is 4 (after
  // thinking_end, before the text block opens).
  assert.equal(snapStartToQuiescent(arr, 2, arr.length), 4);
});

test('cut inside a tool span (tool_use → tool_result) is rejected', () => {
  const arr = roundTripTurn();
  // 8/9/10 are inside the t1 span; the first legal boundary above is 11
  // (right after the tool_result).
  assert.equal(snapStartToQuiescent(arr, 8, arr.length), 11);
  assert.equal(snapStartToQuiescent(arr, 10, arr.length), 11);
  // 11 itself is quiescent — kept as-is.
  assert.equal(snapStartToQuiescent(arr, 11, arr.length), 11);
});

test('parallel tool_uses quiesce only after the LAST result', () => {
  const arr = [
    /*0*/ echo('A'),
    /*1*/ tuStart('t1', 'm1', 0), /*2*/ tu('t1', 'm1', 0),
    /*3*/ tuStart('t2', 'm1', 1), /*4*/ tu('t2', 'm1', 1),
    /*5*/ tr('t1'), /*6*/ tr('t2'),
    /*7*/ turnEnd(), /*8*/ echo('B'), /*9*/ turnEnd(),
  ];
  // 6 still has t2 pending → snaps to 7 (after both results).
  assert.equal(snapStartToQuiescent(arr, 6, arr.length), 7);
});

test('interrupted turn (dangling tool) does not poison later boundaries', () => {
  const arr = [
    /*0*/ echo('A'),
    /*1*/ tuStart('t1', 'm1'), /*2*/ tu('t1', 'm1'), // result never arrives
    /*3*/ turnEnd(), // aborted
    /*4*/ echo('B'), /*5*/ tDelta('m2'), /*6*/ tEnd('m2'), /*7*/ turnEnd(),
  ];
  // The echo is a boundary by fiat despite t1 never resolving.
  assert.equal(snapStartToQuiescent(arr, 4, arr.length), 4);
  // Index right after the turn_end reset is quiescent too.
  assert.equal(snapStartToQuiescent(arr, 3, arr.length), 4);
});

test('turn_end force-resets even with a dangling tool before it', () => {
  const arr = [
    /*0*/ echo('A'),
    /*1*/ tuStart('t1', 'm1'), /*2*/ tu('t1', 'm1'),
    /*3*/ turnEnd(),
    /*4*/ ({ kind: 'system', subtype: 'status', data: {} }),
    /*5*/ echo('B'), /*6*/ turnEnd(),
  ];
  assert.equal(snapStartToQuiescent(arr, 4, arr.length), 4);
});

test('window fully inside a giant block run snaps back to the run start', () => {
  const arr = [echo('A')];
  for (let i = 0; i < 40; i++) arr.push(tDelta('big'));
  arr.push(tEnd('big'), turnEnd());
  // [20, 30) contains only deltas — no forward quiescent point in-window;
  // the nearest below is 1 (after the echo, before the first delta).
  assert.equal(snapStartToQuiescent(arr, 20, 30), 1);
});

test('foreground Task: no quiescent point anywhere inside the span', () => {
  const arr = [
    /*0*/ echo('A'),
    /*1*/ tuStart('T', 'm1', 0), /*2*/ tu('T', 'm1', 0, 'Task'),
    /*3*/ child(asstMsg('cm1'), 'T'),
    /*4*/ child(tu('ct1', 'cm1'), 'T'),
    /*5*/ child(tr('ct1'), 'T'),
    /*6*/ tr('T'),
    /*7*/ turnEnd(), /*8*/ echo('B'), /*9*/ turnEnd(),
  ];
  // Every candidate in (2..6] is inside the open T span → 7 is the first
  // boundary; the whole sub-agent run stays in the older chunk.
  for (const cand of [3, 4, 5, 6]) {
    assert.equal(snapStartToQuiescent(arr, cand, arr.length), 7, `candidate ${cand}`);
  }
  assertWindowIntegrity(arr, 7, arr.length, 'foreground');
});

test('backgrounded Task: a cut between later children pulls the whole group', () => {
  const arr = [
    /* 0*/ echo('A'),
    /* 1*/ tDelta('m1'), /* 2*/ tEnd('m1'),
    /* 3*/ tuStart('T', 'm2'), /* 4*/ tu('T', 'm2', 0, 'Task'),
    /* 5*/ tr('T'), // async_launched — returns early
    /* 6*/ turnEnd(),
    /* 7*/ echo('B'),
    /* 8*/ tDelta('m3'), /* 9*/ tEnd('m3'),
    /*10*/ child(asstMsg('cm1'), 'T'),
    /*11*/ child(tr('ct1'), 'T'),
    /*12*/ turnEnd(),
  ];
  // 10 is quiescent outer-wise, but the window would hold children of T
  // whose head is below — the group pull drags the start to a quiescent
  // point at/below the head so head + children share one chunk.
  const s = snapStartToQuiescent(arr, 10, arr.length);
  assert.equal(s, 3);
  assertWindowIntegrity(arr, s, arr.length, 'background');
  // The next-older page ends exactly at the returned start → child-free.
  for (let i = 0; i < s; i++) assert.ok(!arr[i].parentToolUseId);
});

test('async sub-agent block parts interleaved with outer parts stay whole', () => {
  // First-class case: a backgrounded sub-agent emits its block parts BETWEEN
  // the outer turn's own block parts. Both the outer block and the nested
  // block must land whole in one chunk.
  const arr = [
    /* 0*/ echo('A'),
    /* 1*/ tuStart('T', 'm1'), /* 2*/ tu('T', 'm1', 0, 'Task'),
    /* 3*/ tr('T'), // backgrounded
    /* 4*/ turnEnd(),
    /* 5*/ echo('B'),
    /* 6*/ tDelta('m2'),                    // outer part 1
    /* 7*/ child(asstMsg('cm1'), 'T'),      // nested part 1 (text block)
    /* 8*/ tDelta('m2'),                    // outer part 2
    /* 9*/ child(tu('ct1', 'cm1', 1), 'T'), // nested part 2 (tool block)
    /*10*/ tEnd('m2'),                      // outer block closes
    /*11*/ child(tr('ct1'), 'T'),           // nested tool resolves
    /*12*/ turnEnd(),
  ];
  const s = snapStartToQuiescent(arr, 9, arr.length);
  assertWindowIntegrity(arr, s, arr.length, 'interleaved');
  // The window must reach below the Task head — outer parts (6,8,10) and
  // nested parts (7,9,11) all inside one chunk.
  assert.ok(s <= 1, `expected start at/below the Task head's boundary, got ${s}`);
});

test('resetIdx marks the archive→ring seam as boundary and scan barrier', () => {
  const arr = [
    /*0*/ echo('A'), /*1*/ tDelta('a1'), /*2*/ tEnd('a1'),
    // ---- seam (evicted content) ----
    /*3*/ tDelta('r1'), /*4*/ tEnd('r1'), /*5*/ turnEnd(),
  ];
  // The seam itself is a legal page start.
  assert.equal(snapStartToQuiescent(arr, 3, arr.length, { resetIdx: 3 }), 3);
  // 4 is mid-block within the ring; the scan restarts at the seam and finds
  // 5 forward (state never computed across the gap).
  assert.equal(snapStartToQuiescent(arr, 4, arr.length, { resetIdx: 3 }), 5);
});

test('firstQuiescentAtOrAfter finds the trim fallback cut', () => {
  const arr = [echo('A')];
  for (let i = 0; i < 40; i++) arr.push(tDelta('big'));
  arr.push(tEnd('big'));         // index 41
  arr.push(tDelta('m2'), tEnd('m2'), turnEnd());
  // 41 still has the big block open (its end not yet applied); 42 is the
  // first whole-block cut at/after 20.
  assert.equal(firstQuiescentAtOrAfter(arr, 20, arr.length), 42);
  // Bounded search that never reaches a quiescent index → -1 (plain cut).
  assert.equal(firstQuiescentAtOrAfter(arr, 20, 41), -1);
});

test('start already quiescent is kept (no needless extension)', () => {
  const arr = roundTripTurn();
  assert.equal(snapStartToQuiescent(arr, 4, arr.length), 4);
  assert.equal(snapStartToQuiescent(arr, 14, arr.length), 14); // echo by fiat
  assert.equal(snapStartToQuiescent(arr, 0, arr.length), 0);
});
