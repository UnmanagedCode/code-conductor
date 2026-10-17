// The e2e harness's live-mode credential handling (web/e2e/harness/credentials.ts):
// an access-token-only 0600 copy of a credentials file, and the one-field global
// config seed. Every path here is a fixture under this file's own temp dir — the
// functions take both paths explicitly, so nothing below can reach the live
// ~/.claude. The ~/.claude.json refusal is checked by path only; nothing writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLiveCredentials, seedLiveGlobalConfig, liveBudgetMs } from '../web/e2e/harness/credentials.ts';
import { redact } from '../web/e2e/harness/redact.ts';
import { mkdtempSync } from './tmpRegistry.mjs';

const ACCESS = 'ACCESS-SENTINEL-7f3a';
const REFRESH = 'REFRESH-SENTINEL-91bc';
const FUTURE = 'FUTURE-FIELD-SENTINEL-2d4e';
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function fixture(t, oauth = {}) {
  const root = mkdtempSync('cc-e2e-cred-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, 'live');
  fs.mkdirSync(live);
  const source = path.join(live, '.credentials.json');
  const body = {
    claudeAiOauth: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: NOW + 2 * HOUR,
      refreshTokenExpiresAt: NOW + 900 * HOUR,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_tier',
      futureCliField: FUTURE,
      ...oauth,
    },
    mcpOAuth: { someServer: { token: FUTURE } },
  };
  fs.writeFileSync(source, JSON.stringify(body));
  const scratch = path.join(root, 'scratch', 'claude-config');
  fs.mkdirSync(scratch, { recursive: true });
  return { root, live, source, dest: path.join(scratch, '.credentials.json') };
}

const noSentinel = (text) => {
  for (const s of [ACCESS, REFRESH, FUTURE]) assert.ok(!text.includes(s), 'a refusal message carries a credential sentinel');
};

test('the copy keeps exactly the access-token allowlist, mode 0600, and leaves the source untouched', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.source);
  const mtimeBefore = fs.statSync(f.source).mtimeMs;

  prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR });

  assert.equal(fs.statSync(f.dest).mode & 0o777, 0o600);
  const bytes = fs.readFileSync(f.dest, 'utf8');
  assert.ok(!bytes.includes(REFRESH), 'the refresh token reached the copy');
  assert.ok(!bytes.includes('refreshTokenExpiresAt'), 'refreshTokenExpiresAt reached the copy');
  assert.ok(!bytes.includes(FUTURE), 'an unknown field reached the copy');
  assert.ok(!bytes.includes('mcpOAuth'), 'an unknown top-level key reached the copy');
  assert.deepEqual(JSON.parse(bytes), {
    claudeAiOauth: {
      accessToken: ACCESS,
      expiresAt: NOW + 2 * HOUR,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_tier',
    },
  });

  assert.deepEqual(fs.readFileSync(f.source), before);
  assert.equal(fs.statSync(f.source).mtimeMs, mtimeBefore);
});

test('the access token is registered with redact()', (t) => {
  const f = fixture(t);
  prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR });
  assert.equal(redact(`log line Bearer ${ACCESS} end`), 'log line Bearer <redacted> end');
});

test('a token read before a refusal is registered with redact() all the same', async (t) => {
  // A caller that prints after a refusal still prints no token. Each case has
  // its own token: the registry is per process and other tests register theirs.
  await t.test('expiry inside the budget', (t) => {
    const token = 'ACCESS-EXPIRING-SENTINEL-5c1a';
    const f = fixture(t, { accessToken: token, expiresAt: NOW + 30 * 60_000 });
    assert.throws(() => prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR }), /budget/);
    assert.equal(redact(`tail: ${token}`), 'tail: <redacted>');
  });
  await t.test('a token with no numeric expiry', (t) => {
    const token = 'ACCESS-NO-EXPIRY-SENTINEL-8e2f';
    const f = fixture(t, { accessToken: token, expiresAt: 'soon' });
    assert.throws(() => prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR }), /no access token/);
    assert.equal(redact(`tail: ${token}`), 'tail: <redacted>');
  });
});

test('refusals name the path or the expiry, never a credential', async (t) => {
  await t.test('missing source file', (t) => {
    const f = fixture(t);
    const missing = path.join(f.live, 'absent.json');
    assert.throws(() => prepareLiveCredentials({ source: missing, dest: f.dest, now: NOW, budgetMs: HOUR }), (e) => {
      assert.equal(e.message, `live mode: no Claude credentials at ${missing}; log in first`);
      return true;
    });
    assert.ok(!fs.existsSync(f.dest));
  });

  await t.test('no access token', (t) => {
    const f = fixture(t, { accessToken: '' });
    assert.throws(() => prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR }), (e) => {
      assert.match(e.message, /credentials file has no access token/);
      noSentinel(e.message);
      return true;
    });
    assert.ok(!fs.existsSync(f.dest));
  });

  await t.test('expiresAt not a number', (t) => {
    const f = fixture(t, { expiresAt: 'soon' });
    assert.throws(() => prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR }),
      (e) => { assert.match(e.message, /credentials file has no access token/); noSentinel(e.message); return true; });
    assert.ok(!fs.existsSync(f.dest));
  });

  await t.test('expiry inside the budget', (t) => {
    const f = fixture(t, { expiresAt: NOW + 30 * 60_000 });
    assert.throws(() => prepareLiveCredentials({ source: f.source, dest: f.dest, now: NOW, budgetMs: HOUR }), (e) => {
      assert.match(e.message, new RegExp(new Date(NOW + 30 * 60_000).toISOString()));
      assert.match(e.message, /60 min/);
      noSentinel(e.message);
      return true;
    });
    assert.ok(!fs.existsSync(f.dest));
  });

  await t.test('dest inside the source dir', (t) => {
    const f = fixture(t);
    for (const dest of [path.join(f.live, 'copy.json'), path.join(f.live, 'sub', '..', 'x.json'), f.source]) {
      assert.throws(() => prepareLiveCredentials({ source: f.source, dest, now: NOW, budgetMs: HOUR }), /inside/);
    }
    assert.deepEqual(fs.readdirSync(f.live), ['.credentials.json']);
  });
});

test('seedLiveGlobalConfig writes exactly the onboarding flag and refuses live locations', async (t) => {
  await t.test('writes exactly {"hasCompletedOnboarding":true}', (t) => {
    const f = fixture(t);
    const dest = path.join(path.dirname(f.dest), '.claude.json');
    seedLiveGlobalConfig({ dest, liveConfigDir: f.live });
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"hasCompletedOnboarding":true}');
  });

  await t.test('refuses a dest inside the live config dir', (t) => {
    const f = fixture(t);
    assert.throws(() => seedLiveGlobalConfig({ dest: path.join(f.live, '.claude.json'), liveConfigDir: f.live }), /live/);
    assert.deepEqual(fs.readdirSync(f.live), ['.credentials.json']);
  });

  await t.test('refuses ~/.claude.json (path check only)', (t) => {
    const f = fixture(t);
    assert.throws(() => seedLiveGlobalConfig({ dest: path.join(os.homedir(), '.claude.json'), liveConfigDir: f.live }), /live/);
  });
});

test('liveBudgetMs reads CC_E2E_LIVE_BUDGET_MIN, default 60 minutes', () => {
  assert.equal(liveBudgetMs({}), 60 * 60_000);
  assert.equal(liveBudgetMs({ CC_E2E_LIVE_BUDGET_MIN: '15' }), 15 * 60_000);
  assert.throws(() => liveBudgetMs({ CC_E2E_LIVE_BUDGET_MIN: 'soon' }), /CC_E2E_LIVE_BUDGET_MIN/);
});
