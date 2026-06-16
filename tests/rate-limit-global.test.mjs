// Integration tests for the global rate-limit tracker and its two-source
// merge semantics (P3 plan).  Tests cover pure logic only — no DOM.
//
// Two sources feed globalRLTracker:
//   1. rate_limit_event messages pushed from any session (sparse patch)
//   2. The normalised tightest bucket from the periodic /api/usage fetch
//      (richer base, applied as a synthetic event via the same apply() path)
//
// Merge rule: null-guard on both sides — incoming non-null fields win,
// absent/undefined fields are dropped, so neither source clobbers the
// other's unique fields (isUsingOverage is message-only and survives
// re-fetches because the synthetic fetch event never includes it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitTracker } from '../public/usage.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRLEvent(fields) {
  return {
    kind: 'system',
    subtype: 'rate_limit_event',
    data: { rate_limit_info: fields },
  };
}

// Mirrors the normalisation that refreshAccountUsage() does in app.js:
// take the tightest non-null bucket and build a synthetic event for apply().
function makeFetchEvent(accountUsage) {
  const BUCKET_PRIORITY = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];
  const key = BUCKET_PRIORITY.find(k => accountUsage[k]);
  if (!key) return null;
  const b = accountUsage[key];
  return {
    kind: 'system',
    subtype: 'rate_limit_event',
    data: { rate_limit_info: {
      rateLimitType: key,
      utilization: typeof b.utilization === 'number' ? b.utilization / 100 : undefined,
      resetsAt: b.resets_at ? new Date(b.resets_at).getTime() / 1000 : undefined,
      // isUsingOverage intentionally absent — fetch never knows this
    }},
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

test('rate_limit_event from instance A populates globalRLTracker', () => {
  const tracker = new RateLimitTracker();
  tracker.apply(makeRLEvent({ rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 1000 }));
  assert.ok(tracker.info, 'info should be set after first event');
  assert.equal(tracker.info.rateLimitType, 'five_hour');
  assert.equal(tracker.info.utilization, 0.45);
  assert.equal(tracker.info.resetsAt, 1000);
});

test('rate_limit_event from instance B also updates the same tracker', () => {
  const tracker = new RateLimitTracker();
  // Instance A sets initial state
  tracker.apply(makeRLEvent({ rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 1000 }));
  // Instance B patches utilization (simulates a different session's event)
  tracker.apply(makeRLEvent({ rateLimitType: 'five_hour', utilization: 0.60, resetsAt: 1100 }));
  assert.equal(tracker.info.utilization, 0.60, 'later event wins for utilization');
  assert.equal(tracker.info.resetsAt, 1100, 'later event wins for resetsAt');
});

test('fetch normalisation seeds rateLimitType/utilization/resetsAt', () => {
  const tracker = new RateLimitTracker();
  const accountUsage = {
    five_hour: { utilization: 45, resets_at: '2026-06-16T14:50:00.000Z' },
    seven_day: { utilization: 38, resets_at: '2026-06-21T01:00:00.000Z' },
  };
  const ev = makeFetchEvent(accountUsage);
  assert.ok(ev, 'should produce a synthetic event for the tightest bucket');
  tracker.apply(ev);
  assert.equal(tracker.info.rateLimitType, 'five_hour', 'picks tightest bucket');
  assert.ok(Math.abs(tracker.info.utilization - 0.45) < 0.001, 'normalises 0-100 → 0-1');
  assert.ok(Number.isFinite(tracker.info.resetsAt), 'resetsAt is a finite Unix timestamp');
});

test('isUsingOverage (message-only) is preserved across a re-fetch', () => {
  const tracker = new RateLimitTracker();
  // Message sets isUsingOverage
  tracker.apply(makeRLEvent({
    rateLimitType: 'five_hour', utilization: 0.95, resetsAt: 1000, isUsingOverage: true,
  }));
  assert.equal(tracker.info.isUsingOverage, true);

  // Fetch arrives — isUsingOverage is absent from synthetic event
  const accountUsage = {
    five_hour: { utilization: 96, resets_at: '2026-06-16T14:50:00.000Z' },
  };
  tracker.apply(makeFetchEvent(accountUsage));

  // isUsingOverage must survive; fetch updated utilization
  assert.equal(tracker.info.isUsingOverage, true, 'isUsingOverage preserved after re-fetch');
  assert.ok(Math.abs(tracker.info.utilization - 0.96) < 0.001, 'utilization updated by fetch');
});

test('sparse message does not clobber good existing fields', () => {
  const tracker = new RateLimitTracker();
  // Full event establishes baseline
  tracker.apply(makeRLEvent({
    rateLimitType: 'five_hour', utilization: 0.45, resetsAt: 9999, isUsingOverage: false,
  }));
  // Sparse message carries only isUsingOverage
  tracker.apply(makeRLEvent({ isUsingOverage: true }));

  assert.equal(tracker.info.rateLimitType, 'five_hour', 'rateLimitType preserved');
  assert.equal(tracker.info.utilization, 0.45, 'utilization preserved');
  assert.equal(tracker.info.resetsAt, 9999, 'resetsAt preserved');
  assert.equal(tracker.info.isUsingOverage, true, 'isUsingOverage updated');
});

test('null/undefined fields in a message are dropped (null-guard)', () => {
  const tracker = new RateLimitTracker();
  tracker.apply(makeRLEvent({ rateLimitType: 'seven_day', utilization: 0.3, resetsAt: 5000 }));
  // Message with null utilization — should NOT clobber the good value
  tracker.apply(makeRLEvent({ rateLimitType: 'seven_day', utilization: null, resetsAt: 6000 }));
  assert.equal(tracker.info.utilization, 0.3, 'null utilization must not overwrite');
  assert.equal(tracker.info.resetsAt, 6000, 'non-null resetsAt is applied');
});

test('snapshot replay adds to global state without reset', () => {
  const tracker = new RateLimitTracker();
  // Prior state from another session
  tracker.apply(makeRLEvent({ rateLimitType: 'five_hour', utilization: 0.5, isUsingOverage: true }));

  // Simulate snapshot replay for a different instance — must NOT reset
  const snapshotEvents = [
    { kind: 'system', subtype: 'init', data: { model: 'claude-sonnet-4-6' } },
    makeRLEvent({ rateLimitType: 'five_hour', utilization: 0.55, resetsAt: 7000 }),
  ];
  for (const ev of snapshotEvents) tracker.apply(ev);

  // Global state should reflect both: updated utilization + preserved isUsingOverage
  assert.equal(tracker.info.utilization, 0.55, 'snapshot event updates utilization');
  assert.equal(tracker.info.isUsingOverage, true, 'prior isUsingOverage not erased');
  assert.equal(tracker.info.resetsAt, 7000, 'resetsAt from snapshot applied');
});

test('non-rate-limit events are silently ignored', () => {
  const tracker = new RateLimitTracker();
  tracker.apply({ kind: 'turn_end', usage: {} });
  tracker.apply({ kind: 'message_start', usage: {} });
  tracker.apply({ kind: 'system', subtype: 'init', data: {} });
  assert.equal(tracker.info, null, 'info stays null for unrelated events');
});

test('fetch skips all-null buckets and falls back to next priority', () => {
  const accountUsage = {
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: { utilization: 20, resets_at: '2026-06-21T00:00:00.000Z' },
    seven_day_opus: null,
  };
  const ev = makeFetchEvent(accountUsage);
  assert.ok(ev, 'should produce a synthetic event for the next non-null bucket');
  assert.equal(ev.data.rate_limit_info.rateLimitType, 'seven_day_sonnet');
  assert.ok(Math.abs(ev.data.rate_limit_info.utilization - 0.20) < 0.001);
});

test('fetch returns null when all buckets are null', () => {
  const accountUsage = { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null };
  const ev = makeFetchEvent(accountUsage);
  assert.equal(ev, null, 'no synthetic event when no non-null bucket exists');
});
