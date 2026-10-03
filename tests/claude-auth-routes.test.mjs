// The /api/claude-auth/* routes over a booted server, with CLAUDE_BIN pointed
// at tests/fake-claude-auth.mjs after boot (bootServer's close() restores it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { invalidateAccountUsage } from '../src/accountUsage.ts';

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
  const records = async () => (await fs.readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const statusRuns = async () => (await records()).filter(r => r.argv?.[1] === 'status').length;
  const loginPid = () => waitFor(async () =>
    (await fs.readFile(record, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(r => r.argv?.[1] === 'login')?.pid);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await ctx.close(); } };
  try {
    return await fn({ ...ctx, close, loginPid, statusRuns, dir });
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

// The re-login crux: usage is fetched with whichever token the CLI's credential
// store holds, and a login that rewrites it switches the very next /api/usage
// fetch to the new token. Run against both ways the store is located.
async function reloginSwitchesUsageToken({ setConfigDir }) {
  invalidateAccountUsage(); // the usage cache is process-wide: start from nothing
  const realFetch = globalThis.fetch;
  const bearers = [];
  globalThis.fetch = (url, opts) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, opts);
    const auth = new Headers(opts?.headers).get('authorization');
    bearers.push(auth);
    const who = auth.replace(/^Bearer /, '');
    return Promise.resolve(new Response(JSON.stringify({ who }), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-auth-cfg-'));
  const home = path.join(root, 'home');
  const cfg = setConfigDir ? path.join(root, 'cfg') : path.join(home, '.claude');
  await fs.mkdir(cfg, { recursive: true });
  await fs.writeFile(path.join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token-A' } }));
  try {
    await withServer({
      HOME: home, CLAUDE_CONFIG_DIR: setConfigDir ? cfg : undefined, FAKE_AUTH_WRITE_TOKEN: 'token-B',
    }, async ({ baseUrl }) => {
      assert.deepEqual((await api(baseUrl, 'GET', '/api/usage')).body.usage, { who: 'token-A' });
      await api(baseUrl, 'POST', '/api/claude-auth/login');
      await awaitLogin(baseUrl, 'awaiting_code');
      await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: 'GOOD#STATE' });
      await awaitLogin(baseUrl, 'succeeded');
      assert.equal(JSON.parse(await fs.readFile(path.join(cfg, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'token-B',
        'the login wrote the store usage reads');
      assert.deepEqual((await api(baseUrl, 'GET', '/api/usage')).body.usage, { who: 'token-B' });
      assert.deepEqual(bearers, ['Bearer token-A', 'Bearer token-B']);
    });
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('after a re-login, /api/usage fetches with the new token (CLAUDE_CONFIG_DIR set)', async () => {
  await reloginSwitchesUsageToken({ setConfigDir: true });
});

test('after a re-login, /api/usage fetches with the new token (CLAUDE_CONFIG_DIR unset: $HOME/.claude)', async () => {
  await reloginSwitchesUsageToken({ setConfigDir: false });
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

const SIGNED_OUT = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: '/cfg' };
const getStatus = async (baseUrl) => (await api(baseUrl, 'GET', '/api/claude-auth/status')).body;

test('concurrent status GETs share one `claude auth status` run, and a repeat inside the TTL runs none', async () => {
  await withServer({ FAKE_AUTH_STATUS: JSON.stringify(SIGNED_IN) }, async ({ baseUrl, statusRuns }) => {
    const all = await Promise.all(Array.from({ length: 8 }, () => api(baseUrl, 'GET', '/api/claude-auth/status')));
    assert.deepEqual(all.map(r => r.status), Array(8).fill(200));
    assert.equal(await statusRuns(), 1);
    await getStatus(baseUrl);
    assert.equal(await statusRuns(), 1);
  });
});

test('the status read after a login starts, and after it succeeds, is fresh', async () => {
  await withServer({ FAKE_AUTH_STATUS: JSON.stringify(SIGNED_OUT) }, async ({ baseUrl }) => {
    assert.equal((await getStatus(baseUrl)).loggedIn, false);
    process.env.FAKE_AUTH_STATUS = JSON.stringify({ ...SIGNED_IN, email: 'mid@example.com' });
    assert.equal((await getStatus(baseUrl)).loggedIn, false, 'cached before any login');

    await api(baseUrl, 'POST', '/api/claude-auth/login');
    assert.equal((await getStatus(baseUrl)).email, 'mid@example.com', 'fresh once a login starts');

    process.env.FAKE_AUTH_STATUS = JSON.stringify({ ...SIGNED_IN, email: 'new@example.com' });
    assert.equal((await getStatus(baseUrl)).email, 'mid@example.com', 'cached again during the flow');
    await awaitLogin(baseUrl, 'awaiting_code');
    await api(baseUrl, 'POST', '/api/claude-auth/login/code', { code: 'GOOD#STATE' });
    await awaitLogin(baseUrl, 'succeeded');
    assert.equal((await getStatus(baseUrl)).email, 'new@example.com', 'fresh after the login succeeds');
  });
});
