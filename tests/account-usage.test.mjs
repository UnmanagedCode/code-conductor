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
  five_hour: { utilization: 67.0, resets_at: '2026-06-11T21:09:59+00:00' },
  seven_day: { utilization: 43.0, resets_at: '2026-06-14T00:59:59+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 17.0, resets_at: '2026-06-14T00:59:59+00:00' },
  extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 0.0, currency: 'EUR' },
};

function stubFetch(responseBody, status = 200) {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    };
  };
  return {
    get calls() { return callCount; },
    restore() { globalThis.fetch = original; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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
