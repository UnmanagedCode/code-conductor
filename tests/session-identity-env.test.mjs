// Session identity in the `claude` child env: every launch carries the session's
// PUBLIC id (CC_SESSION_ID), its kind (CC_SESSION_KIND, the tool-audience word)
// and cc's base URL (CONDUCTOR_URL), so a hook or MCP server running inside the
// session can resolve which cc session it belongs to. Contract:
// docs/protocol.md → Session identity env.
//
// Every test plants OUTER values first: the suite usually runs inside a cc
// worker that carries real ones, and an assertion that a spawn merely inherited
// process.env must be able to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, seedSessionJsonl } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_RENEW = path.join(__dirname, 'fixtures', 'scenario-renew.json');
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');
// Must match the session_id the `/clear` turn emits in scenario-renew.json.
const RENEW_NEW_SID = 'c0000000-0000-4000-8000-000000000001';

const PLANTED = {
  CC_SESSION_ID: 'outer-planted',
  CC_SESSION_KIND: 'planted',
  CONDUCTOR_URL: 'http://outer.invalid',
};
const VARS = Object.keys(PLANTED);

async function withPlanted(fn) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, PLANTED);
  try { return await fn(); }
  finally {
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function bootWith(scenarioPath, fn) {
  const ctx = await bootServer({ scenarioPath });
  try { return await withPlanted(() => fn(ctx)); }
  finally { await ctx.close(); }
}

async function spawnIdle(ctx, body) {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { mode: 'bypassPermissions', ...body });
  assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId && inst._spawnArgv);
  return inst;
}

let rpcId = 1;
async function callTool(baseUrl, name, args, { caller } = {}) {
  const url = `${baseUrl}/mcp${caller ? `/${encodeURIComponent(caller)}` : ''}?format=json`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name}: ${JSON.stringify(body)}`);
  assert.equal(body.result.isError ?? false, false, `tools/call ${name} errored: ${JSON.stringify(body.result)}`);
  return body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
}

// A `.conduct` conductor; `warn` keeps ungoverned spawns proceeding.
async function driver(ctx) {
  return spawnIdle(ctx, { project: CONDUCT_PROJECT_NAME, role: 'conductor', playbookEnforcement: 'warn' });
}
async function spawnFrom(ctx, callerSid, args) {
  const view = await callTool(ctx.baseUrl, 'spawn_instance', { mode: 'bypassPermissions', ...args }, { caller: callerSid });
  assert.ok(view.sessionId, JSON.stringify(view));
  await waitFor(() => instForSession(ctx.instances, view.sessionId)?.status === 'idle');
  return instForSession(ctx.instances, view.sessionId);
}

async function readEnvDump(file) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  return Object.fromEntries(lines.map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}
// Point the next launch's fake CLI at a fresh env-dump file.
async function armEnvDump() {
  const file = path.join(await mkdtemp('session-env-'), 'env.txt');
  const prev = process.env.FAKE_CLAUDE_ENV_DUMP;
  process.env.FAKE_CLAUDE_ENV_DUMP = file;
  return {
    file,
    read: async () => { await waitFor(async () => fs.stat(file).then(() => true, () => false)); return readEnvDump(file); },
    restore: () => { if (prev === undefined) delete process.env.FAKE_CLAUDE_ENV_DUMP; else process.env.FAKE_CLAUDE_ENV_DUMP = prev; },
  };
}

test('I1 fresh worker spawn: CC_SESSION_ID is the public id (not the backing id), kind worker, CONDUCTOR_URL is cc base URL; no outer value survives', async () => {
  await bootWith(SCENARIO, async (ctx) => {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const dump = await armEnvDump();
    try {
      const inst = await spawnIdle(ctx, { project: 'p' });
      assert.notEqual(inst.sessionId, inst.backingSessionId, 'premise: public and backing ids differ');
      for (const env of [inst._spawnEnv, await dump.read()]) {
        assert.equal(env.CC_SESSION_ID, inst.sessionId);
        assert.equal(env.CC_SESSION_KIND, 'worker');
        assert.equal(env.CONDUCTOR_URL, ctx.baseUrl);
      }
    } finally { dump.restore(); }
  });
});

test('I2 a .conduct session reads CC_SESSION_KIND=conductor', async () => {
  await bootWith(SCENARIO_WS, async (ctx) => {
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const inst = await spawnIdle(ctx, { project: CONDUCT_PROJECT_NAME });
    assert.equal(inst._spawnEnv.CC_SESSION_KIND, 'conductor');
    assert.equal(inst._spawnEnv.CC_SESSION_ID, inst.sessionId);
  });
});

test('I3 kind follows the tool audience: a section lead reads conductor; its worker and a conductor\'s direct worker read worker', async () => {
  await bootWith(SCENARIO_WS, async (ctx) => {
    const cond = await driver(ctx);
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const lead = await spawnFrom(ctx, cond.sessionId, { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
    const grandchild = await spawnFrom(ctx, lead.sessionId, { project: 'demo', playbook: 'freeform', stage: 'freeform' });
    const direct = await spawnFrom(ctx, cond.sessionId, { project: 'demo' });
    assert.equal(cond._spawnEnv.CC_SESSION_KIND, 'conductor');
    assert.equal(lead._spawnEnv.CC_SESSION_KIND, 'conductor');
    assert.equal(grandchild._spawnEnv.CC_SESSION_KIND, 'worker');
    assert.equal(direct._spawnEnv.CC_SESSION_KIND, 'worker');
    for (const i of [cond, lead, grandchild, direct]) assert.equal(i._spawnEnv.CC_SESSION_ID, i.sessionId);
  });
});

test('I4 stable across an in-process renew: same process, CC_SESSION_ID still the public id, not the new backing id', async () => {
  await bootWith(SCENARIO_RENEW, async (ctx) => {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const inst = await spawnIdle(ctx, { project: 'p' });
    const publicId = inst.sessionId;
    const proc = inst.proc;
    await callTool(ctx.baseUrl, 'renew_session', { summary: 'identity env check' }, { caller: publicId });
    await callTool(ctx.baseUrl, 'send_prompt', { sessionId: publicId, text: 'go1' });
    await waitFor(() => inst.backingSessionId === RENEW_NEW_SID && inst.status === 'idle');
    assert.equal(inst.proc, proc, 'premise: the rotation kept the process');
    assert.equal(inst._spawnEnv.CC_SESSION_ID, publicId);
    assert.notEqual(inst._spawnEnv.CC_SESSION_ID, inst.backingSessionId);
  });
});

test('I5 stable across a relaunching rotation (prune): the relaunched child gets the same CC_SESSION_ID and resumes the new backing id', async () => {
  await bootWith(SCENARIO_RESUME, async (ctx) => {
    const sid = 'bbbbbbb1-2222-3333-4444-555555555555';
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'mp' });
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, 'mp')));
    await fs.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'r2' }] } },
    ];
    await fs.writeFile(path.join(sessionDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const inst = await spawnIdle(ctx, { project: 'mp', resume: sid });
    const publicId = inst.sessionId;
    const firstProc = inst.proc;
    const dump = await armEnvDump();
    try {
      const res = await callTool(ctx.baseUrl, 'prune_session', { sessionId: publicId });
      assert.equal(res.ok, true, JSON.stringify(res));
      await waitFor(() => inst.status === 'idle' && inst.proc && inst.proc !== firstProc);
      const env = await dump.read();
      assert.equal(env.CC_SESSION_ID, publicId);
      assert.equal(env.CC_SESSION_KIND, 'worker');
      assert.notEqual(inst.backingSessionId, sid, 'premise: the prune rotated the backing id');
      assert.equal(inst._spawnArgv[inst._spawnArgv.indexOf('--resume') + 1], inst.backingSessionId);
    } finally { dump.restore(); }
  });
});

test('I6 stable across resume: a resumed session\'s child gets the same CC_SESSION_ID and kind', async () => {
  await bootWith(SCENARIO, async (ctx) => {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const first = await spawnIdle(ctx, { project: 'p', temp: false });
    const sid = first.sessionId;
    await seedSessionJsonl(first.transcriptPlace, first.backingSessionId);
    await first.kill({ graceMs: 50 });
    await waitFor(() => !first.proc && (first.status === 'exited' || first.status === 'crashed'));
    const dump = await armEnvDump();
    try {
      const resumed = await ctx.instances.create({ project: 'p', resume: sid, mode: 'bypassPermissions' });
      await waitFor(() => resumed.status === 'idle' && resumed._spawnArgv);
      assert.equal(resumed._spawnArgv.includes('--resume'), true);
      const env = await dump.read();
      assert.equal(env.CC_SESSION_ID, sid);
      assert.equal(env.CC_SESSION_KIND, 'worker');
    } finally { dump.restore(); }
  });
});

test('I7 the documented recipe resolves: POST $CONDUCTOR_URL/mcp/tools/describe_session {sessionId: $CC_SESSION_ID} names project, worktree and stage', async () => {
  await bootWith(SCENARIO_WS, async (ctx) => {
    const describe = async (env) => {
      const r = await fetch(`${env.CONDUCTOR_URL}/mcp/tools/describe_session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: env.CC_SESSION_ID }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const hand = await spawnIdle(ctx, { project: 'demo' });
    const d1 = await describe(hand._spawnEnv);
    assert.equal(d1.sessionId, hand.sessionId);
    assert.equal(d1.live.project, 'demo');
    assert.equal(d1.live.worktree, null);
    assert.ok('playbook' in d1.live && 'stage' in d1.live, JSON.stringify(d1.live));

    const cond = await driver(ctx);
    const worker = await spawnFrom(ctx, cond.sessionId, { project: 'demo', playbook: 'freeform', stage: 'freeform' });
    const d2 = await describe(worker._spawnEnv);
    assert.equal(d2.live.project, 'demo');
    assert.equal(d2.live.stage, 'freeform');
  });
});

test('I8 CONDUCTOR_URL is absent (an outer value deleted) when the manager has no server port; the session id is still set', async () => {
  await bootWith(SCENARIO, async (ctx) => {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    ctx.instances.serverPort = null;
    const inst = await spawnIdle(ctx, { project: 'p' });
    assert.equal('CONDUCTOR_URL' in inst._spawnEnv, false);
    assert.equal(inst._spawnEnv.CC_SESSION_ID, inst.sessionId);
  });
});
