// The /api/claude-auth/* routes over a booted server, with CLAUDE_BIN pointed
// at tests/fake-claude-auth.mjs after boot (bootServer's close() restores it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = `${process.execPath} ${path.join(__dirname, 'fake-claude-auth.mjs')}`;

const SIGNED_IN = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', analyticsDisabled: false,
  projectsDirectory: '/cfg/projects', configDirectory: '/cfg',
  email: 'user@example.com', orgId: '00000000-0000-4000-8000-000000000000', orgName: 'Example Org', subscriptionType: 'max',
};

const pidGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};

// A booted server whose CLI is the fake, with its env and a record file.
async function withServer(env, fn) {
  const ctx = await bootServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-routes-'));
  const record = path.join(dir, 'rec.jsonl');
  const vars = { FAKE_AUTH_LOGIN_MODE: 'normal', FAKE_AUTH_STATUS: undefined, FAKE_AUTH_STATUS_EXIT: undefined, ...env, FAKE_AUTH_RECORD: record };
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  process.env.CLAUDE_BIN = FAKE;
  const loginPid = () => waitFor(async () =>
    (await fs.readFile(record, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(r => r.argv?.[1] === 'login')?.pid);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await ctx.close(); } };
  try {
    return await fn({ ...ctx, close, loginPid, dir });
  } finally {
    await close();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const getLogin = (baseUrl) => api(baseUrl, 'GET', '/api/claude-auth/login');
const awaitLogin = (baseUrl, state) => waitFor(async () => (await getLogin(baseUrl)).body.state === state);

test('GET /api/claude-auth/status returns the parsed CLI state', async () => {
  await withServer({ FAKE_AUTH_STATUS: JSON.stringify(SIGNED_IN) }, async ({ baseUrl }) => {
    const r = await api(baseUrl, 'GET', '/api/claude-auth/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'user@example.com', orgId: '00000000-0000-4000-8000-000000000000', orgName: 'Example Org',
      subscriptionType: 'max', apiKeySource: null, configDirectory: '/cfg',
    });
  });
});

test('GET /api/claude-auth/status is 502 {error} when the CLI answers garbage', async () => {
  await withServer({ FAKE_AUTH_STATUS: 'garbage' }, async ({ baseUrl }) => {
    const r = await api(baseUrl, 'GET', '/api/claude-auth/status');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /non-JSON/);
  });
});

test('POST login starts one flow; a second start is 409 {error}; code and cancel drive it', async () => {
  await withServer({}, async ({ baseUrl }) => {
    assert.equal((await getLogin(baseUrl)).body.state, 'idle');
    const first = await api(baseUrl, 'POST', '/api/claude-auth/login');
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'starting');
    const second = await api(baseUrl, 'POST', '/api/claude-auth/login');
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already in progress/);
    await awaitLogin(baseUrl, 'awaiting_code');
    assert.match((await getLogin(baseUrl)).body.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);

    const empty = await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: '  ' });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.error);

    const cancelled = await api(baseUrl, 'POST', '/api/claude-auth/login/cancel');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'cancelled');

    const late = await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: 'GOOD#STATE' });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /waiting for a code/);
  });
});

test('a pasted code is delivered and a successful login reads succeeded', async () => {
  await withServer({}, async ({ baseUrl }) => {
    await api(baseUrl, 'POST', '/api/claude-auth/login');
    await awaitLogin(baseUrl, 'awaiting_code');
    const r = await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: 'GOOD#STATE' });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'verifying');
    await awaitLogin(baseUrl, 'succeeded');
  });
});

test('a successful login invalidates the cached account usage', async () => {
  const realFetch = globalThis.fetch;
  let usageN = 1;
  globalThis.fetch = (url, opts) => String(url).startsWith('https://api.anthropic.com/')
    ? Promise.resolve(new Response(JSON.stringify({ n: usageN }), { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, opts);
  const cfg = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-cfg-'));
  await fs.writeFile(path.join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token' } }));
  try {
    await withServer({ CLAUDE_CONFIG_DIR: cfg }, async ({ baseUrl }) => {
      assert.deepEqual((await api(baseUrl, 'GET', '/api/usage')).body.usage, { n: 1 });
      usageN = 2;
      assert.deepEqual((await api(baseUrl, 'GET', '/api/usage')).body.usage, { n: 1 }, 'cached before the login');
      await api(baseUrl, 'POST', '/api/claude-auth/login');
      await awaitLogin(baseUrl, 'awaiting_code');
      await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: 'GOOD#STATE' });
      await awaitLogin(baseUrl, 'succeeded');
      assert.deepEqual((await api(baseUrl, 'GET', '/api/usage')).body.usage, { n: 2 });
    });
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(cfg, { recursive: true, force: true });
  }
});

test('closing the server during an active flow kills the login child', async () => {
  await withServer({}, async ({ baseUrl, close, loginPid }) => {
    await api(baseUrl, 'POST', '/api/claude-auth/login');
    await awaitLogin(baseUrl, 'awaiting_code');
    const pid = await loginPid();
    assert.ok(!pidGone(pid));
    await close();
    await waitFor(() => pidGone(pid));
  });
});
