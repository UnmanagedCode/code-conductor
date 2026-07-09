// Pure-function tests for the quiescent-point snapper (src/parser.js):
// snapStartToQuiescent (page/tail window starts) and firstQuiescentAtOrAfter
// (EventLog._trim fallback). No server, no DOM — hand-built UI-event arrays.
//
// A cut index i is quiescent when no outer block is mid-stream and every
// outer tool_use has its tool_result; outer user_echo/turn_end force-reset;
// sub-agent (parentToolUseId) events are scan-opaque — their wholeness comes
// from the group-integrity pull, exercised here too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { snapStartToQuiescent, firstQuiescentAtOrAfter } from '../src/parser.js';

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
// turn_end inside the window), and no child event without its head.
function assertWindowIntegrity(arr, s, end, label) {
  const open = new Set(); const pending = new Set(); const heads = new Set();
  for (let i = s; i < end; i++) {
    const ev = arr[i];
    if (ev.parentToolUseId) {
      assert.ok(heads.has(ev.parentToolUseId),
        `${label}: child at ${i} (parent ${ev.parentToolUseId}) has no head in [${s},${end})`);
      continue;
    }
    if ((ev.kind === 'tool_use_start' || ev.kind === 'tool_use') && ev.toolUseId) heads.add(ev.toolUseId);
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
