// src/claudeAuthStatus.ts — parsing `claude auth status --json` and running it
// the way a worker spawn would. The payloads are the real CLI's captured shapes
// (identity values replaced by placeholders); the CLI itself is
// tests/fake-claude-auth.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthStatus, getClaudeAuthStatus, createClaudeAuthStatusReader } from '../src/claudeAuthStatus.ts';
import { hostPlatform } from '../src/platform/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = `${process.execPath} ${path.join(__dirname, 'fake-claude-auth.mjs')}`;

const SIGNED_IN = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', analyticsDisabled: false,
  projectsDirectory: '/cfg/projects', configDirectory: '/cfg',
  email: 'user@example.com', orgId: '00000000-0000-4000-8000-000000000000', orgName: 'Example Org (Team plan)', subscriptionType: 'team',
};
const SIGNED_OUT = {
  loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false,
  projectsDirectory: '/cfg/projects', configDirectory: '/cfg',
};
const NULL_IDENTITY = { ...SIGNED_IN, email: null, orgId: null, orgName: null, subscriptionType: 'pro' };
const API_KEY = {
  loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', analyticsDisabled: false,
  projectsDirectory: '/cfg/projects', configDirectory: '/cfg', apiKeySource: 'ANTHROPIC_API_KEY',
};

// Runs fn with env overrides, restoring every touched key afterwards.
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('parses the captured signed-in, signed-out, api_key and null-identity payloads', () => {
  assert.deepEqual(parseAuthStatus(JSON.stringify(SIGNED_IN)), {
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: 'user@example.com', orgId: '00000000-0000-4000-8000-000000000000', orgName: 'Example Org (Team plan)',
    subscriptionType: 'team', apiKeySource: null, configDirectory: '/cfg',
  });
  assert.deepEqual(parseAuthStatus(JSON.stringify(SIGNED_OUT)), {
    loggedIn: false, authMethod: 'none', apiProvider: 'firstParty',
    email: null, orgId: null, orgName: null, subscriptionType: null, apiKeySource: null, configDirectory: '/cfg',
  });
  assert.deepEqual(parseAuthStatus(JSON.stringify(API_KEY)), {
    loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty',
    email: null, orgId: null, orgName: null, subscriptionType: null, apiKeySource: 'ANTHROPIC_API_KEY', configDirectory: '/cfg',
  });
  const n = parseAuthStatus(JSON.stringify(NULL_IDENTITY));
  assert.equal(n.email, null);
  assert.equal(n.orgId, null);
  assert.equal(n.orgName, null);
  assert.equal(n.subscriptionType, 'pro');
});

test('a missing authMethod reads as "none"', () => {
  assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: false })).authMethod, 'none');
});

test('rejects non-JSON and a missing loggedIn with a message naming the problem', () => {
  assert.throws(() => parseAuthStatus('Not logged in. Run claude auth login to authenticate.'), /non-JSON/);
  assert.throws(() => parseAuthStatus(JSON.stringify({ authMethod: 'none' })), /loggedIn/);
  assert.throws(() => parseAuthStatus(JSON.stringify({ loggedIn: 'false' })), /loggedIn/);
  assert.throws(() => parseAuthStatus('null'), /loggedIn/);
});

test('getClaudeAuthStatus returns the signed-in state from exit 0', async () => {
  const s = await withEnv({ CLAUDE_BIN: FAKE, FAKE_AUTH_STATUS: JSON.stringify(SIGNED_IN), FAKE_AUTH_STATUS_EXIT: '0' },
    () => getClaudeAuthStatus({ platform: hostPlatform }));
  assert.equal(s.loggedIn, true);
  assert.equal(s.email, 'user@example.com');
});

test('getClaudeAuthStatus returns loggedIn:false when the CLI exits 1 with JSON', async () => {
  const s = await withEnv({ CLAUDE_BIN: FAKE, FAKE_AUTH_STATUS: JSON.stringify(SIGNED_OUT), FAKE_AUTH_STATUS_EXIT: '1' },
    () => getClaudeAuthStatus({ platform: hostPlatform }));
  assert.equal(s.loggedIn, false);
  assert.equal(s.authMethod, 'none');
});

test('getClaudeAuthStatus rejects unparseable output with the exit code and stderr', async () => {
  await withEnv({ CLAUDE_BIN: FAKE, FAKE_AUTH_STATUS: 'garbage', FAKE_AUTH_STATUS_EXIT: '3' }, () =>
    assert.rejects(getClaudeAuthStatus({ platform: hostPlatform }), /non-JSON.*exit 3/));
});

test('getClaudeAuthStatus rejects naming the command when CLAUDE_BIN does not exist', async () => {
  const missing = path.join(os.tmpdir(), `cc-no-such-claude-${process.pid}`);
  await withEnv({ CLAUDE_BIN: missing }, () =>
    assert.rejects(getClaudeAuthStatus({ platform: hostPlatform }),
      (e) => e.message.includes('could not be started') && e.message.includes(missing)));
});

test('getClaudeAuthStatus rejects on timeout', async () => {
  // A CLI that never answers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-status-'));
  try {
    const wrapper = path.join(dir, 'hang.mjs');
    await fs.writeFile(wrapper, `setInterval(() => {}, 1 << 30);\n`);
    await withEnv({ CLAUDE_BIN: `${process.execPath} ${wrapper}` }, () =>
      assert.rejects(getClaudeAuthStatus({ platform: hostPlatform, timeoutMs: 200 }), /timed out after 200 ms/));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('spawns with CLAUDE_CONFIG_DIR exactly as cc\'s env has it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-status-'));
  try {
    const record = path.join(dir, 'rec.jsonl');
    const base = { CLAUDE_BIN: FAKE, FAKE_AUTH_STATUS: JSON.stringify(SIGNED_OUT), FAKE_AUTH_STATUS_EXIT: '1', FAKE_AUTH_RECORD: record };
    await withEnv({ ...base, CLAUDE_CONFIG_DIR: '/some/config/dir' }, () => getClaudeAuthStatus({ platform: hostPlatform }));
    await withEnv({ ...base, CLAUDE_CONFIG_DIR: undefined }, () => getClaudeAuthStatus({ platform: hostPlatform }));
    const recs = (await fs.readFile(record, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(recs.map(r => r.argv), [['auth', 'status', '--json'], ['auth', 'status', '--json']]);
    assert.deepEqual(recs.map(r => r.env.CLAUDE_CONFIG_DIR), ['/some/config/dir', null]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// A reader over a scripted `read`: each call is recorded and resolved by hand.
function scriptedReader({ ttlMs = 5000 } = {}) {
  let t = 0;
  const pending = [];
  const read = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const reader = createClaudeAuthStatusReader({ platform: hostPlatform, ttlMs, now: () => t, read });
  return { reader, pending, advance: (ms) => { t += ms; } };
}
const status = (email) => ({ ...parseAuthStatus(JSON.stringify(SIGNED_IN)), email });

test('reader: concurrent readers share one CLI run', async () => {
  const { reader, pending } = scriptedReader();
  const all = Promise.all([reader.get(), reader.get(), reader.get()]);
  assert.equal(pending.length, 1);
  pending[0].resolve(status('a@example.com'));
  assert.deepEqual((await all).map(s => s.email), ['a@example.com', 'a@example.com', 'a@example.com']);
});

test('reader: an answer serves until the TTL lapses, then the CLI runs again', async () => {
  const { reader, pending, advance } = scriptedReader({ ttlMs: 5000 });
  const first = reader.get();
  pending[0].resolve(status('a@example.com'));
  await first;
  advance(4999);
  assert.equal((await reader.get()).email, 'a@example.com');
  assert.equal(pending.length, 1, 'served from the cache inside the TTL');
  advance(1);
  const next = reader.get();
  assert.equal(pending.length, 2, 'a run at the TTL boundary');
  pending[1].resolve(status('b@example.com'));
  assert.equal((await next).email, 'b@example.com');
});

test('reader: a failure reaches the waiting readers but is not cached', async () => {
  const { reader, pending } = scriptedReader();
  const a = reader.get();
  const b = reader.get();
  pending[0].reject(new Error('claude CLI could not be started (claude): ENOENT'));
  await assert.rejects(a, /ENOENT/);
  await assert.rejects(b, /ENOENT/);
  const c = reader.get();
  assert.equal(pending.length, 2, 'the next reader runs the CLI again');
  pending[1].resolve(status('a@example.com'));
  assert.equal((await c).email, 'a@example.com');
});

test('reader: invalidate() drops the cached answer', async () => {
  const { reader, pending } = scriptedReader();
  const a = reader.get();
  pending[0].resolve(status('old@example.com'));
  await a;
  reader.invalidate();
  const b = reader.get();
  assert.equal(pending.length, 2);
  pending[1].resolve(status('new@example.com'));
  assert.equal((await b).email, 'new@example.com');
});

test('reader: a run in flight at invalidate() is neither cached nor shared with later readers', async () => {
  const { reader, pending } = scriptedReader();
  const before = reader.get();
  reader.invalidate();
  const after = reader.get();
  assert.equal(pending.length, 2, 'a reader after invalidate starts its own run');
  pending[0].resolve(status('old@example.com'));
  assert.equal((await before).email, 'old@example.com', 'the earlier reader still gets its answer');
  pending[1].resolve(status('new@example.com'));
  assert.equal((await after).email, 'new@example.com');
  assert.equal((await reader.get()).email, 'new@example.com');
  assert.equal(pending.length, 2, 'the fresh answer is the cached one');
});

test('reader: a run detached by invalidate() never writes the cache, even when it settles last', async () => {
  const { reader, pending } = scriptedReader({ ttlMs: 5000 });
  const detached = reader.get();
  reader.invalidate();
  const fresh = reader.get();
  assert.equal(pending.length, 2);
  pending[1].resolve(status('new@example.com'));
  assert.equal((await fresh).email, 'new@example.com');
  pending[0].resolve(status('old@example.com'));
  assert.equal((await detached).email, 'old@example.com', 'its own reader still gets its answer');
  for (let i = 0; i < 3; i++) assert.equal((await reader.get()).email, 'new@example.com');
  assert.equal(pending.length, 2, 'served from the cache inside the TTL');
});
