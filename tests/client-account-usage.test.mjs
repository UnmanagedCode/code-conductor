// Characterization pin for public/accountUsage.js — the periodic /api/usage
// poll and its merge into the account-wide RateLimitTracker.
//
// Written BEFORE the extraction lands (expand-then-contract): at this commit
// public/accountUsage.js is an unreferenced verbatim copy of the block still
// live in public/app.js (lines 55-90), so these assertions describe the
// CURRENT shipped behaviour. The follow-up commit deletes app.js's copy and
// wires this module; the reviewer's check is that
// `git diff <pin> <wire> -- public/accountUsage.js` is empty.
//
// Invariants pinned here (each one is what a mutation would break):
//   - !r.ok        -> tracker untouched AND last-good get() preserved
//   - usage == null-> same (an explicit "keep last-good", not a blank)
//   - fetch reject -> swallowed, last-good preserved
//   - utilization is DIVIDED BY 100, and undefined when non-numeric
//   - resets_at    -> epoch SECONDS (getTime()/1000), undefined when absent
//   - the bucket is the FIRST PRESENT key in RL_BUCKET_KEYS order
//   - isStale() mirrors !!j.stale
//   - headerUpdate fires only when getActiveId() is truthy
//   - the request carries cache: 'no-store'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const { installAccountUsage } = await import(
  pathToFileURL(path.join(PUB, 'accountUsage.js')).href
);
const { RateLimitTracker, RL_BUCKET_KEYS } = await import(
  pathToFileURL(path.join(PUB, 'usage.js')).href
);

// fetch stub in the tests/account-overage.test.mjs idiom: records every call so
// the URL and its init options are assertable, and serves one scripted reply.
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return reply();
  };
  return calls;
}

const ok = (body) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
// A non-ok reply deliberately carries a WELL-FORMED body. An error page whose
// body still parses is exactly the case the `!r.ok` guard exists for: without
// it, the null-usage guard below would let this through and clobber last-good.
const NOT_OK_BODY = { usage: { five_hour: { utilization: 99 } }, stale: true };
const notOk = (status = 500) => () => Promise.resolve({ ok: false, status, json: () => Promise.resolve(NOT_OK_BODY) });
const rejects = (msg = 'network down') => () => Promise.reject(new Error(msg));

function setup({ activeId = 'inst-1' } = {}) {
  const tracker = new RateLimitTracker();
  let updates = 0;
  const handle = installAccountUsage({
    globalRLTracker: tracker,
    getActiveId: () => activeId,
    headerUpdate: () => { updates++; },
  });
  return { handle, tracker, updates: () => updates };
}

const GOOD = { usage: { five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00.000Z' } } };

test('a good payload populates get(), the tracker, and repaints the header', async () => {
  const calls = stubFetch(ok(GOOD));
  const { handle, tracker, updates } = setup();
  await handle.refresh();

  assert.deepEqual(handle.get(), GOOD.usage);
  assert.equal(handle.isStale(), false);
  assert.equal(tracker.info.rateLimitType, 'five_hour');
  assert.equal(updates(), 1);
  assert.equal(calls[0].url, '/api/usage');
});

test('the request is sent with cache: no-store', async () => {
  const calls = stubFetch(ok(GOOD));
  const { handle } = setup();
  await handle.refresh();
  assert.equal(calls[0].init?.cache, 'no-store',
    'a cached /api/usage would serve a stale window silently');
});

test('utilization is divided by 100', async () => {
  stubFetch(ok({ usage: { five_hour: { utilization: 42 } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info.utilization, 0.42,
    'the endpoint reports percent; the tracker stores a fraction');
});

test('a non-numeric utilization becomes undefined, not NaN or a passthrough', async () => {
  stubFetch(ok({ usage: { five_hour: { utilization: null, resets_at: '2026-01-01T00:00:00.000Z' } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info.rateLimitType, 'five_hour', 'the bucket still applies');
  assert.equal(tracker.info.utilization, undefined);
});

test('resets_at converts to epoch SECONDS', async () => {
  stubFetch(ok({ usage: { five_hour: { utilization: 10, resets_at: '2026-01-01T00:00:00.000Z' } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  const expected = new Date('2026-01-01T00:00:00.000Z').getTime() / 1000;
  assert.equal(tracker.info.resetsAt, expected);
  assert.ok(tracker.info.resetsAt < 2e10, 'seconds, not milliseconds');
});

test('an absent resets_at yields undefined', async () => {
  stubFetch(ok({ usage: { five_hour: { utilization: 10 } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info.resetsAt, undefined);
});

test('the bucket chosen is the FIRST PRESENT key in RL_BUCKET_KEYS order', async () => {
  // Two buckets present, deliberately declared in the reverse of the
  // authoritative order, so a naive Object.keys() pick would take the wrong one.
  const [first, , third] = RL_BUCKET_KEYS;
  stubFetch(ok({ usage: { [third]: { utilization: 90 }, [first]: { utilization: 10 } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info.rateLimitType, first,
    `${first} precedes ${third} in RL_BUCKET_KEYS, so it wins regardless of object order`);
  assert.equal(tracker.info.utilization, 0.1);
});

test('a later bucket is used when the earlier ones are absent', async () => {
  const third = RL_BUCKET_KEYS[2];
  stubFetch(ok({ usage: { [third]: { utilization: 90 } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info.rateLimitType, third);
});

test('a payload with no known bucket leaves the tracker untouched but still stores usage', async () => {
  stubFetch(ok({ usage: { something_else: { utilization: 5 } } }));
  const { handle, tracker } = setup();
  await handle.refresh();
  assert.equal(tracker.info, null, 'no synthetic event is applied');
  assert.deepEqual(handle.get(), { something_else: { utilization: 5 } });
});

test('isStale() mirrors j.stale', async () => {
  stubFetch(ok({ ...GOOD, stale: true }));
  const { handle } = setup();
  await handle.refresh();
  assert.equal(handle.isStale(), true);
});

test('!r.ok leaves the tracker untouched and preserves the last-good value', async () => {
  stubFetch(ok(GOOD));
  const { handle, tracker } = setup();
  await handle.refresh();
  const good = handle.get();

  stubFetch(notOk(500));
  await handle.refresh();
  assert.equal(handle.get(), good, 'a 500 must not overwrite the last-good usage');
  assert.equal(handle.isStale(), false, 'nor its stale flag');
  assert.equal(tracker.info.utilization, 0.42,
    'the non-ok body must never reach the tracker — 0.99 here would mean the !r.ok guard is gone');
});

test('a null usage field preserves the last-good value', async () => {
  stubFetch(ok(GOOD));
  const { handle } = setup();
  await handle.refresh();
  const good = handle.get();

  stubFetch(ok({ usage: null, stale: true }));
  await handle.refresh();
  assert.equal(handle.get(), good);
  assert.equal(handle.isStale(), false,
    'the null-usage return happens BEFORE the stale flag is written');
});

test('a fetch rejection is swallowed and preserves the last-good value', async () => {
  stubFetch(ok(GOOD));
  const { handle } = setup();
  await handle.refresh();
  const good = handle.get();

  stubFetch(rejects());
  await assert.doesNotReject(() => handle.refresh());
  assert.equal(handle.get(), good);
});

test('headerUpdate fires only when an instance is active', async () => {
  stubFetch(ok(GOOD));
  const idle = setup({ activeId: null });
  await idle.handle.refresh();
  assert.equal(idle.updates(), 0, 'nothing to repaint with no active session');
  assert.deepEqual(idle.handle.get(), GOOD.usage, 'but the value is still stored');

  stubFetch(ok(GOOD));
  const active = setup({ activeId: 'inst-1' });
  await active.handle.refresh();
  assert.equal(active.updates(), 1);
});

test('headerUpdate does not fire on the !ok or null-usage early returns', async () => {
  stubFetch(notOk(503));
  const a = setup();
  await a.handle.refresh();
  assert.equal(a.updates(), 0);

  stubFetch(ok({ usage: null }));
  const b = setup();
  await b.handle.refresh();
  assert.equal(b.updates(), 0);
});
