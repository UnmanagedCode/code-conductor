// Tests that verify per-turn cost delta computation in the parser and that
// UsageTracker accumulates correctly using costDelta rather than the raw
// cumulative total_cost_usd value the CLI emits. Also covers durationApiMsDelta
// — the SDK's duration_api_ms is likewise a cumulative session total, converted
// to a per-turn delta so summed LLM time can no longer exceed turn walltime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser } from '../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const USAGE_URL = pathToFileURL(path.join(PUB, 'usage.js')).href;

// Build a minimal result event matching the CLI's stream-json shape.
function resultEvent(totalCostUsd, extra = {}) {
  return {
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    duration_ms: 1000,
    total_cost_usd: totalCostUsd,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 50 },
    ...extra,
  };
}

// ── Parser: costDelta computation ──────────────────────────────────────────

test('parser: first turn costDelta equals total_cost_usd (previous = 0)', () => {
  const p = new Parser();
  const [ev] = p.handleObject(resultEvent(0.0134));
  assert.equal(ev.kind, 'turn_end');
  assert.equal(ev.cost, 0.0134,      'raw cumulative cost preserved');
  assert.ok(Math.abs(ev.costDelta - 0.0134) < 1e-9, 'delta equals total on first turn');
});

test('parser: second turn costDelta is the incremental difference', () => {
  const p = new Parser();
  p.handleObject(resultEvent(0.0134)); // turn 1 — cumulative $0.0134
  const [ev2] = p.handleObject(resultEvent(0.0179)); // turn 2 — cumulative $0.0179
  assert.equal(ev2.cost, 0.0179, 'raw cumulative cost preserved');
  assert.ok(
    Math.abs(ev2.costDelta - (0.0179 - 0.0134)) < 1e-9,
    `expected delta ~0.0045, got ${ev2.costDelta}`,
  );
});

test('parser: costDelta across five turns matches conversation transcript', () => {
  // Mirrors the real conversation from the original bug report.
  const totals = [0.0134, 0.0179, 0.0222, 0.0264, 0.0305];
  const p = new Parser();
  const events = totals.map(t => p.handleObject(resultEvent(t))[0]);

  // Deltas: first turn = total; subsequent = difference from previous.
  const expectedDeltas = [0.0134, 0.0045, 0.0043, 0.0042, 0.0041];
  for (let i = 0; i < events.length; i++) {
    assert.ok(
      Math.abs(events[i].costDelta - expectedDeltas[i]) < 1e-9,
      `turn ${i + 1}: expected delta ${expectedDeltas[i]}, got ${events[i].costDelta}`,
    );
  }
});

test('parser: reset() clears _lastCost so a new session starts fresh', () => {
  const p = new Parser();
  p.handleObject(resultEvent(0.0305)); // simulate a full session
  p.reset();
  const [ev] = p.handleObject(resultEvent(0.0134)); // new session, first turn
  assert.ok(
    Math.abs(ev.costDelta - 0.0134) < 1e-9,
    'after reset, delta should equal total (not be negative)',
  );
});

test('parser: null total_cost_usd produces null costDelta (no cost field in result)', () => {
  const p = new Parser();
  const [ev] = p.handleObject({ type: 'result', subtype: 'success', stop_reason: 'end_turn',
    duration_ms: 100, is_error: false, usage: { input_tokens: 5, output_tokens: 3 } });
  assert.equal(ev.cost, null);
  assert.equal(ev.costDelta, null);
});

// ── Parser: durationApiMsDelta computation (mirrors costDelta) ─────────────

test('parser: first turn durationApiMsDelta equals duration_api_ms (previous = 0)', () => {
  const p = new Parser();
  const [ev] = p.handleObject(resultEvent(0.01, { duration_api_ms: 42196 }));
  assert.equal(ev.durationApiMs, 42196, 'raw cumulative API time preserved');
  assert.equal(ev.durationApiMsDelta, 42196, 'delta equals total on first turn');
});

test('parser: second turn durationApiMsDelta is the incremental difference', () => {
  const p = new Parser();
  p.handleObject(resultEvent(0.01, { duration_api_ms: 42196 }));         // turn 1
  const [ev2] = p.handleObject(resultEvent(0.02, { duration_api_ms: 54626 })); // turn 2
  assert.equal(ev2.durationApiMs, 54626, 'raw cumulative API time preserved');
  assert.equal(ev2.durationApiMsDelta, 54626 - 42196, 'delta is the incremental difference');
});

test('parser: durationApiMsDelta across the real transcript de-inflates the cumulative counter', () => {
  // Live session 5984a0c4: duration_api_ms is cumulative; duration_ms is per-turn.
  const turns = [
    { api: 42196,  wall: 41954 },
    { api: 54626,  wall: 13744 },
    { api: 69135,  wall: 15199 },
    { api: 85049,  wall: 15990 },
    { api: 118067, wall: 34570 },
  ];
  const expectedDeltas = [42196, 12430, 14509, 15914, 33018];
  const p = new Parser();
  const deltas = turns.map(({ api, wall }, i) => {
    const [ev] = p.handleObject(resultEvent(0.01 * (i + 1), { duration_api_ms: api, duration_ms: wall }));
    assert.equal(ev.durationApiMsDelta, expectedDeltas[i], `turn ${i + 1} delta`);
    // After turn 1, each per-turn LLM slice must fit inside its turn walltime —
    // the whole point of the fix (turn 1's raw datum can marginally overlap).
    if (i > 0) assert.ok(ev.durationApiMsDelta <= ev.durationMs,
      `turn ${i + 1}: LLM time ${ev.durationApiMsDelta} must not exceed walltime ${ev.durationMs}`);
    return ev.durationApiMsDelta;
  });
  // Summed deltas equal the final cumulative total (118067) — NOT the buggy
  // sum-of-cumulatives (369073) that made LLM time balloon past walltime.
  const summed = deltas.reduce((s, d) => s + d, 0);
  assert.equal(summed, 118067, 'per-turn deltas sum to the true session total');
  const totalWall = turns.reduce((s, t) => s + t.wall, 0);
  assert.ok(summed <= totalWall, `summed LLM time ${summed} must not exceed total walltime ${totalWall}`);
});

test('parser: reset() clears _lastApiMs so a new session starts fresh', () => {
  const p = new Parser();
  p.handleObject(resultEvent(0.03, { duration_api_ms: 118067 })); // simulate a full session
  p.reset();
  const [ev] = p.handleObject(resultEvent(0.01, { duration_api_ms: 42196 })); // new session, first turn
  assert.equal(ev.durationApiMsDelta, 42196, 'after reset, delta equals total (not negative)');
});

test('parser: absent duration_api_ms produces null durationApiMsDelta', () => {
  const p = new Parser();
  const [ev] = p.handleObject({ type: 'result', subtype: 'success', stop_reason: 'end_turn',
    duration_ms: 100, total_cost_usd: 0.01, is_error: false, usage: { input_tokens: 5, output_tokens: 3 } });
  assert.equal(ev.durationApiMs, null);
  assert.equal(ev.durationApiMsDelta, null);
});

// ── UsageTracker: accumulates costDelta, not cumulative cost ───────────────

test('UsageTracker: cum.cost equals final session total when costDelta is present', async () => {
  const { UsageTracker } = await import(USAGE_URL);
  const tracker = new UsageTracker();

  // Simulate 5-turn conversation where ev.cost is cumulative and
  // costDelta is the per-turn increment (as computed by the parser).
  const turns = [
    { cost: 0.0134, costDelta: 0.0134 },
    { cost: 0.0179, costDelta: 0.0045 },
    { cost: 0.0222, costDelta: 0.0043 },
    { cost: 0.0264, costDelta: 0.0042 },
    { cost: 0.0305, costDelta: 0.0041 },
  ];

  for (const { cost, costDelta } of turns) {
    tracker.apply({
      kind: 'turn_end', cost, costDelta, durationMs: 1000,
      usage: { input_tokens: 10, output_tokens: 50,
               cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }

  // cum.cost must equal the final session total ($0.0305), not the
  // erroneous sum of all cumulative values ($0.1104).
  assert.ok(
    Math.abs(tracker.cum.cost - 0.0305) < 1e-9,
    `expected cum.cost ~0.0305 (session total), got ${tracker.cum.cost}`,
  );
  assert.equal(tracker.cum.turns, 5);
});

test('UsageTracker: falls back to ev.cost when costDelta is absent (old snapshots)', async () => {
  // Events recorded before this fix have no costDelta field.
  // The tracker must still accumulate correctly using the raw cost field.
  const { UsageTracker } = await import(USAGE_URL);
  const tracker = new UsageTracker();

  tracker.apply({
    kind: 'turn_end', cost: 0.01, durationMs: 500,
    usage: { input_tokens: 10, output_tokens: 30,
             cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  tracker.apply({
    kind: 'turn_end', cost: 0.02, durationMs: 400,
    usage: { input_tokens: 10, output_tokens: 20,
             cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  // Falls back to ev.cost for each turn, behaving like the old code.
  assert.ok(
    Math.abs(tracker.cum.cost - 0.03) < 1e-9,
    `expected 0.03, got ${tracker.cum.cost}`,
  );
});
