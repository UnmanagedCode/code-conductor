// Integration tests for src/accountUsage.js
// Tests the OAuth fetch, 60 s caching, and graceful error handling.
// Uses a temporary credentials file and a stubbed global fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Dynamic import so we can reload with a fresh module cache per test would
// require workers; instead we export _resetCache() and use it between tests.
import { getAccountUsage, _resetCache } from '../src/accountUsage.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpHome;
async function makeTmpHome(credentials) {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'cc-test-'));
  const claudeDir = path.join(tmpHome, '.claude');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(claudeDir, { recursive: true });
  if (credentials !== undefined) {
    await writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));
  }
  return tmpHome;
}

async function cleanTmpHome() {
  if (tmpHome) {
    await rm(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
}

const SAMPLE_USAGE = {
  five_hour: { utilization: 67, resets_at: '2026-06-11T21:09:59+00:00' },
  seven_day: { utilization: 43, resets_at: '2026-06-14T00:59:59+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 17, resets_at: '2026-06-14T00:59:59+00:00' },
  extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 101, currency: 'EUR' },
};

// `headers` is optional: defaults to {} (no Retry-After). Pass e.g.
// { 'retry-after': '30' } to simulate a 429 with Retry-After.
function stubFetch(responseBody, status = 200, headers = {}) {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      json: async () => responseBody,
    };
  };
  return {
    get calls() { return callCount; },
    restore() { globalThis.fetch = original; },
  };
}

// ── Existing tests (unchanged behavior) ──────────────────────────────────────

test('returns usage data on successful fetch', async () => {
  await makeTmpHome({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } });
  const stub = stubFetch(SAMPLE_USAGE);
  _resetCache();
  try {
    const result = await getAccountUsage({ home: tmpHome });
    assert.deepEqual(result, SAMPLE_USAGE);
    assert.equal(stub.calls, 1);
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('cache hit — second call within 60 s makes no additional API request', async () => {
  await makeTmpHome({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } });
  const stub = stubFetch(SAMPLE_USAGE);
  _resetCache();
  try {
    await getAccountUsage({ home: tmpHome });
    const second = await getAccountUsage({ home: tmpHome });
    assert.deepEqual(second, SAMPLE_USAGE);
    assert.equal(stub.calls, 1, 'should only hit the API once within the cache window');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('returns null when credentials file is missing', async () => {
  await makeTmpHome(); // no .credentials.json written
  _resetCache();
  try {
    const result = await getAccountUsage({ home: tmpHome });
    assert.equal(result, null);
  } finally {
    await cleanTmpHome();
  }
});

test('returns null when credentials file has no OAuth token', async () => {
  await makeTmpHome({ someOtherKey: 'value' });
  const stub = stubFetch(SAMPLE_USAGE);
  _resetCache();
  try {
    const result = await getAccountUsage({ home: tmpHome });
    assert.equal(result, null);
    assert.equal(stub.calls, 0, 'should not call API when no token');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('returns null on 401 response', async () => {
  await makeTmpHome({ claudeAiOauth: { accessToken: 'sk-ant-oat01-expired' } });
  const stub = stubFetch({ error: 'Unauthorized' }, 401);
  _resetCache();
  try {
    const result = await getAccountUsage({ home: tmpHome });
    assert.equal(result, null);
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('returns null on network error', async () => {
  await makeTmpHome({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } });
  _resetCache();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network error'); };
  try {
    const result = await getAccountUsage({ home: tmpHome });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
    await cleanTmpHome();
  }
});

test('resets_at ISO-8601 converts correctly to Unix seconds', () => {
  // Sanity-check the conversion used in the frontend chip and popup.
  const iso = '2026-06-11T21:09:59+00:00';
  const unixSecs = new Date(iso).getTime() / 1000;
  // Verify the value matches what Date.parse produces for the same string.
  assert.equal(unixSecs, Date.parse('2026-06-11T21:09:59+00:00') / 1000);
  assert.ok(Number.isFinite(unixSecs), 'should produce a finite number');
});

// ── Backoff / Retry-After tests ───────────────────────────────────────────────

// Shared fake token credential builder.
const CREDS = { claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } };

// _random: () => 0.5 → jitter factor (2*0.5-1) = 0 → pure exponential, no jitter.
const NO_JITTER = () => 0.5;
const BASE_RETRY_MS = 10_000;
const MAX_RETRY_MS  = 5 * 60_000;

test('no re-fetch during backoff window after 429', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'rate limited' }, 429);
  _resetCache();
  try {
    // First call — hits 429, sets nextAllowedAt = t0 + BASE_RETRY_MS
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    // Second call before the window expires — should not fetch
    const result = await getAccountUsage({ home: tmpHome, _now: () => t0 + BASE_RETRY_MS - 1, _random: NO_JITTER });
    assert.equal(result, null);
    assert.equal(stub.calls, 1, 'should not re-fetch during backoff window');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('re-fetches after backoff window elapses (429)', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'rate limited' }, 429);
  _resetCache();
  try {
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    // Exactly at the boundary — window has elapsed, should retry
    await getAccountUsage({ home: tmpHome, _now: () => t0 + BASE_RETRY_MS, _random: NO_JITTER });
    assert.equal(stub.calls, 2, 'should retry once the backoff window has elapsed');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('backoff doubles on repeated failures', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'rate limited' }, 429);
  _resetCache();
  try {
    // Failure 1 at t0 → delay = 10s → nextAllowedAt = t0 + 10_000
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    // Failure 2 at t0+10s → delay = 20s → nextAllowedAt = t0 + 30_000
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 10_000, _random: NO_JITTER });
    assert.equal(stub.calls, 2);

    // At t0 + 25s — still in second backoff window (need t0 + 30s)
    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 25_000, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 2, 'second backoff is 20s so t0+25s should still be blocked');

    // At t0 + 30s — window has elapsed, should retry
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 30_000, _random: NO_JITTER });
    assert.equal(stub.calls, 3, 'should retry once second backoff window elapses');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('Retry-After delta-seconds overrides exponential backoff on 429', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'rate limited' }, 429, { 'retry-after': '30' });
  _resetCache();
  try {
    // Failure: Retry-After: 30 → nextAllowedAt = t0 + 30_000
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    // 25s later — still blocked
    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 25_000, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 1, 'should respect Retry-After: 30 and not re-fetch at 25s');

    // 30s later — window elapsed
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 30_000, _random: NO_JITTER });
    assert.equal(stub.calls, 2, 'should retry at exactly 30s as instructed by Retry-After');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('Retry-After capped at MAX_RETRY_MS even when server sends a huge value', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  // 9999 seconds >> 5 minutes; should be capped to MAX_RETRY_MS
  const stub = stubFetch({ error: 'rate limited' }, 429, { 'retry-after': '9999' });
  _resetCache();
  try {
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    // 1 ms before the cap — still blocked
    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + MAX_RETRY_MS - 1, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 1, 'should not re-fetch before MAX_RETRY_MS cap');

    // Exactly at cap — should retry (not waiting 9999s)
    await getAccountUsage({ home: tmpHome, _now: () => t0 + MAX_RETRY_MS, _random: NO_JITTER });
    assert.equal(stub.calls, 2, 'should retry at MAX_RETRY_MS cap, not at 9999s');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('Retry-After HTTP-date format honored on 429', async () => {
  await makeTmpHome(CREDS);
  const t0 = 1_000_000_000;
  // Craft an HTTP-date that is exactly 30s after t0 in epoch ms
  const retryDate = new Date(t0 + 30_000).toUTCString();
  const stub = stubFetch({ error: 'rate limited' }, 429, { 'retry-after': retryDate });
  _resetCache();
  try {
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 25_000, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 1, 'should be blocked by HTTP-date Retry-After at 25s');

    await getAccountUsage({ home: tmpHome, _now: () => t0 + 30_000, _random: NO_JITTER });
    assert.equal(stub.calls, 2, 'should retry at the HTTP-date specified time');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('503 response also respects Retry-After', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'service unavailable' }, 503, { 'retry-after': '20' });
  _resetCache();
  try {
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    assert.equal(stub.calls, 1);

    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 15_000, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 1, '503 Retry-After: 20 should block re-fetch at 15s');

    await getAccountUsage({ home: tmpHome, _now: () => t0 + 20_000, _random: NO_JITTER });
    assert.equal(stub.calls, 2, 'should retry at 20s as instructed by 503 Retry-After');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});

test('successful fetch after failures resets backoff to base', async () => {
  await makeTmpHome(CREDS);
  const t0 = 1_000_000_000;
  _resetCache();

  // Phase 1: two failures → failureCount grows to 2, next delay would be 40s
  const failStub = stubFetch({ error: 'rate limited' }, 429);
  try {
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 10_000, _random: NO_JITTER });
    assert.equal(failStub.calls, 2);
  } finally {
    failStub.restore();
  }

  // Phase 2: success at t0+30s → resets failureCount to 0
  const successStub = stubFetch(SAMPLE_USAGE, 200);
  try {
    const result = await getAccountUsage({ home: tmpHome, _now: () => t0 + 30_000, _random: NO_JITTER });
    assert.deepEqual(result, SAMPLE_USAGE, 'should return data after recovery');
    assert.equal(successStub.calls, 1);
  } finally {
    successStub.restore();
  }

  // Phase 3: one more failure after success — delay should be base 10s, not 40s
  // (Expire the 60s success cache first by advancing time past it.)
  const failAgainStub = stubFetch({ error: 'rate limited' }, 429);
  try {
    // t0 + 30_000 + 60_000 = past the success cache
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 90_000, _random: NO_JITTER });
    assert.equal(failAgainStub.calls, 1);

    // Blocked at t0 + 90_000 + BASE_RETRY_MS - 1
    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 90_000 + BASE_RETRY_MS - 1, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(failAgainStub.calls, 1, 'delay after reset should be base 10s, not 40s');

    // Unblocked at t0 + 90_000 + BASE_RETRY_MS
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 90_000 + BASE_RETRY_MS, _random: NO_JITTER });
    assert.equal(failAgainStub.calls, 2, 'should retry after base 10s backoff');
  } finally {
    failAgainStub.restore();
    await cleanTmpHome();
  }
});

test('_resetCache() also resets retry state', async () => {
  await makeTmpHome(CREDS);
  const t0   = 1_000_000_000;
  const stub = stubFetch({ error: 'rate limited' }, 429);
  _resetCache();
  try {
    // Three failures → failureCount = 3, next backoff would be 80s
    await getAccountUsage({ home: tmpHome, _now: () => t0, _random: NO_JITTER });
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 10_000, _random: NO_JITTER });
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 30_000, _random: NO_JITTER });
    assert.equal(stub.calls, 3);

    // Reset wipes both cache and retry state
    _resetCache();

    // Next failure should use base 10s delay, not 80s
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 110_000, _random: NO_JITTER });
    assert.equal(stub.calls, 4);

    // Blocked at base - 1 ms
    const blocked = await getAccountUsage({ home: tmpHome, _now: () => t0 + 110_000 + BASE_RETRY_MS - 1, _random: NO_JITTER });
    assert.equal(blocked, null);
    assert.equal(stub.calls, 4, 'after _resetCache(), delay should be base 10s');

    // Unblocked at base
    await getAccountUsage({ home: tmpHome, _now: () => t0 + 110_000 + BASE_RETRY_MS, _random: NO_JITTER });
    assert.equal(stub.calls, 5, 'should retry at base 10s after reset');
  } finally {
    stub.restore();
    await cleanTmpHome();
  }
});
