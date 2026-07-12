// Unit tests for uniform cache-miss detection in src/instances.js.
//
// The turn's FIRST message_start carries per-request usage. On a warm
// continuation the prior prefix is served from cache (cache_read large,
// cache_creation small); on a miss the prefix is (re-)written (cache_creation
// large, cache_read ~0). One uniform rule, applied to EVERY turn's first
// request with no exemption: `cache_creation > cache_read` ⇒ cache miss. This
// flags fresh cold-start system-prompt misses (read=0/creation big), expiry,
// resume, and rewind alike; it does NOT flag warm continuations or a fresh
// session that got a content-addressed system-prompt hit (read≥creation).
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

test('a fresh session\'s first turn with creation>read IS flagged; warm turn is not', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // Turn 1 — fresh cold-start miss: read=0, creation≈system prompt. Under the
    // uniform rule (no first-turn exemption) this is a real miss and IS flagged.
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 200000, id: 'm1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 1, 'fresh first turn flagged');
    assert.equal(turnEnds(events).at(-1).cacheFlush, true);

    // Turn 2 — warm continuation: read>>creation, not a miss.
    inst._handleStdoutLine(msgStartLine({ read: 200000, creation: 2000, id: 'm2' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 1, 'warm turn not flagged');
    const te2 = turnEnds(events).at(-1);
    assert.equal(te2.cacheFlush, false);
    assert.equal(te2.firstReqCacheRead, 200000);
    assert.equal(te2.firstReqCacheCreation, 2000);

    // Turn 3 — another miss: creation>read on the first request.
    inst._handleStdoutLine(msgStartLine({ read: 100, creation: 180000, id: 'm3' }));
    inst._handleStdoutLine(resultLine());
    const notices = flushNotices(events);
    assert.equal(notices.length, 2, 'second miss notice fired');
    assert.equal(notices[1].data.cacheCreation, 180000);
    assert.equal(notices[1].data.cacheRead, 100);
    const te3 = turnEnds(events).at(-1);
    assert.equal(te3.cacheFlush, true);
    assert.equal(te3.firstReqCacheRead, 100);
    assert.equal(te3.firstReqCacheCreation, 180000);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a fresh session with a content-addressed system-prompt hit is NOT flagged', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // First turn, but the system prompt was already cached elsewhere: read big,
    // creation small ⇒ a real hit, correctly not flagged.
    inst._handleStdoutLine(msgStartLine({ read: 190000, creation: 500, id: 'h1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 0, 'content-addressed hit not flagged');
    assert.equal(turnEnds(events).at(-1).cacheFlush, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('only the turn\'s FIRST request decides; the notice fires once per turn', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // A miss turn with THREE message_starts: the first is the miss signal; the
    // later cumulative ones show read>creation and must not re-decide or re-fire
    // the notice.
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 150000, id: 'b1' }));   // first request → miss
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
    // A resume re-writes a prefix that was cached before the process died — a
    // real paid miss. Under the uniform rule a first turn with creation>read is
    // flagged automatically; no arming latch to set (spawn() no longer sets one).
    inst._handleStdoutLine(msgStartLine({ read: 100, creation: 180000, id: 'r1' }));
    inst._handleStdoutLine(resultLine());
    const notices = flushNotices(events);
    assert.equal(notices.length, 1, 'resumed first turn flagged');
    assert.equal(notices[0].data.cacheCreation, 180000);
    assert.equal(notices[0].data.cacheRead, 100);
    assert.equal(turnEnds(events).at(-1).cacheFlush, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a rewind (_wipeForResume) first turn with creation>read IS flagged', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    // Run a normal turn, then rewind.
    inst._handleStdoutLine(msgStartLine({ read: 10000, creation: 100, id: 'c1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 0, 'warm pre-rewind turn not flagged');

    // Rewind: _wipeForResume() clears in-memory state; the spawn({resume}) that
    // always follows re-clears the per-turn capture. The first replayed turn
    // re-writes the cached prefix (creation>read) — a real paid miss — and is
    // flagged by the uniform rule with no latch to set.
    events.length = 0;
    inst._wipeForResume();
    inst._handleStdoutLine(msgStartLine({ read: 0, creation: 200000, id: 'd1' }));
    inst._handleStdoutLine(resultLine());
    assert.equal(flushNotices(events).length, 1, 'first rewound turn flagged');
    assert.equal(turnEnds(events).at(-1).cacheFlush, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
