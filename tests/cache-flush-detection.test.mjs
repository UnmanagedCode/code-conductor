// Unit tests for decisive cache-flush detection in src/instances.js.
//
// The turn's FIRST message_start carries per-request usage. On a warm
// continuation the prior prefix is served from cache (cache_read large,
// cache_creation small); on a flush (prompt-cache TTL lapsed) the prefix is
// re-written (cache_creation large, cache_read ~0). So `cache_creation >
// cache_read` on the first request is a flush — EXCEPT a genuinely fresh
// session's first turn (unavoidable baseline system prompt + first message).
// A resume/rewind first turn IS detected (spawn() arms it via `!!resume`).
//
// Detection is driven deterministically by injecting synthetic stream-json
// lines via inst._handleStdoutLine() — no subprocess. A bare Instance is
// enough: the constructor sets all the tracking state and turn_end's
// _writeSessionMetadata() is fire-and-forget (catch-guarded).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Instance } from '../src/instances.js';

const MODEL = 'claude-opus-4-8';

function msgStartLine({ read, creation, id = 'msg' }) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id, role: 'assistant', model: MODEL,
        usage: {
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: creation,
        },
      },
    },
  });
}

function resultLine({ cost = 0.0001 } = {}) {
  return JSON.stringify({
    type: 'result', subtype: 'success', stop_reason: 'end_turn',
    duration_ms: 10, total_cost_usd: cost, is_error: false,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

async function makeInstance() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-flush-detect-'));
  const inst = new Instance({
    id: 'inst-1', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model: MODEL,
  });
  inst.sessionId = 'sess-1';
  const events = [];
  inst.on('event', (ev) => events.push(ev));
  return { inst, events, cwd };
}

function flushNotices(events) {
  return events.filter(e => e.kind === 'system' && e.subtype === 'cache_flush');
}
function turnEnds(events) {
  return events.filter(e => e.kind === 'turn_end');
}

test('first observed turn is exempt; later flush is detected; normal turn is not', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // Turn 1 — fresh session's first turn (case b): creation>read but a bare
    // Instance starts with _firstTurnObserved=false (as spawn({}) leaves it), so
    // it is exempt.
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 200000, id: 'm1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 0, 'fresh first turn not flagged');
    assert.equal(turnEnds(events).at(-1).cacheFlush, false);

    // Turn 2 — warm continuation: read>>creation, not a flush.
    inst._handleStdoutLine(msgStartLine({ read: 200000, creation: 2000, id: 'm2' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 0, 'warm turn not flagged');
    const te2 = turnEnds(events).at(-1);
    assert.equal(te2.cacheFlush, false);
    assert.equal(te2.firstReqCacheRead, 200000);
    assert.equal(te2.firstReqCacheCreation, 2000);

    // Turn 3 — flush: creation>read on the first request.
    inst._handleStdoutLine(msgStartLine({ read: 100, creation: 180000, id: 'm3' }));
    inst._handleStdoutLine(resultLine());
    const notices = flushNotices(events);
    assert.equal(notices.length, 1, 'exactly one flush notice fired');
    assert.equal(notices[0].data.cacheCreation, 180000);
    assert.equal(notices[0].data.cacheRead, 100);
    const te3 = turnEnds(events).at(-1);
    assert.equal(te3.cacheFlush, true);
    assert.equal(te3.firstReqCacheRead, 100);
    assert.equal(te3.firstReqCacheCreation, 180000);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('only the turn\'s FIRST request decides; the notice fires once per turn', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // Burn the exempt first turn (normal warm).
    inst._handleStdoutLine(msgStartLine({ read: 5000, creation: 100, id: 'a1' }));
    inst._handleStdoutLine(resultLine());
    events.length = 0;

    // A flush turn with THREE message_starts: the first is the flush signal;
    // the later cumulative ones show read>creation and must not re-decide or
    // re-fire the notice.
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 150000, id: 'b1' }));   // first request → flush
    inst._handleStdoutLine(msgStartLine({ read: 150000, creation: 500, id: 'b2' }));  // cumulative
    inst._handleStdoutLine(msgStartLine({ read: 160000, creation: 900, id: 'b3' }));  // cumulative
    inst._handleStdoutLine(resultLine());

    assert.equal(flushNotices(events).length, 1, 'notice fires exactly once');
    const te = turnEnds(events).at(-1);
    assert.equal(te.cacheFlush, true);
    assert.equal(te.firstReqCacheRead, 0, 'first request drove the verdict');
    assert.equal(te.firstReqCacheCreation, 150000);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a resumed session\'s first turn with creation>read IS flagged', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // spawn({resume}) arms detection by setting _firstTurnObserved=true from the
    // start (a resume re-writes a prefix cached before the process died — a real
    // paid miss). The bare harness has no launcher, so we can't call spawn();
    // set the latch exactly the way spawn({resume}) does.
    inst._firstTurnObserved = true;
    inst._handleStdoutLine(msgStartLine({ read: 100, creation: 180000, id: 'r1' }));
    inst._handleStdoutLine(resultLine());
    const notices = flushNotices(events);
    assert.equal(notices.length, 1, 'resumed first turn flagged (was exempt under old semantics)');
    assert.equal(notices[0].data.cacheCreation, 180000);
    assert.equal(notices[0].data.cacheRead, 100);
    assert.equal(turnEnds(events).at(-1).cacheFlush, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a rewind (_wipeForResume + resume-spawn) first turn IS flagged', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // Reach a live armed state: an exempt first turn, then a real flush.
    inst._handleStdoutLine(msgStartLine({ read: 10000, creation: 100, id: 'c1' }));
    inst._handleStdoutLine(resultLine());
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 90000, id: 'c2' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 1, 'flush detected once armed');

    // Rewind: _wipeForResume() clears in-memory state (and no longer touches the
    // flush latch); the spawn({resume}) that always follows arms detection. The
    // bare harness can't call spawn(), so set the latch the way spawn({resume}) does.
    events.length = 0;
    inst._wipeForResume();
    inst._firstTurnObserved = true;
    // First replayed turn re-writes the cached prefix (creation>read) → real
    // paid miss → MUST be flagged now (exempt under the old semantics).
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 200000, id: 'd1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 1, 'first rewound turn flagged');
    assert.equal(turnEnds(events).at(-1).cacheFlush, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
