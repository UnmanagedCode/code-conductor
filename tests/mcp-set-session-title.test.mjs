// Integration tests for the set_session_title MCP tool — a session names ITSELF
// (the target is always the ?caller= identity) through the same title write the
// ⋮ → Rename route uses (applySessionTitle, src/sessionTitles.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { getTitle, loadAll, MAX_TITLE_LEN } from '../src/sessionTitles.ts';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');
// scenario-renew's `/clear` turn emits a system/init with this fixed backing id.
const SCENARIO_RENEW = path.join(__dirname, 'fixtures', 'scenario-renew.json');
const RENEWED_BACKING = 'c0000000-0000-4000-8000-000000000001';

let nextRpcId = 1;
// `?caller=` carries the stable INSTANCE id (what Instance.spawn bakes), so a
// caller sessionId is translated to its instanceId here.
let mgr = null;
async function callToolRaw(baseUrl, name, args, { caller } = {}) {
  const handle = caller ? (instForSession(mgr, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
async function callTool(baseUrl, name, args, opts) {
  const result = await callToolRaw(baseUrl, name, args, opts);
  assert.ok(!result.isError, `tools/call ${name} errored: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function spawnIdle(srv, project) {
  const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  assert.equal(spawn.status, 201);
  const sid = spawn.body.sessionId;
  await waitFor(() => instForSession(srv.instances, sid)?.status === 'idle');
  return instForSession(srv.instances, sid);
}

test('set_session_title titles the caller: sidecar under backing id, live summary, sidebar row', async () => {
  // Pins: the tool writes at the key every reader uses (the BACKING id), sets the
  // live instance's title immediately, and the sidebar row (listed under the
  // public id) carries it.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-caller' });
    const inst = await spawnIdle(srv, 'st-caller');
    const publicId = inst.sessionId;
    const backing = inst.backingSessionId;
    assert.notEqual(publicId, backing, 'precondition: the two ids have diverged');

    const res = await callTool(srv.baseUrl, 'set_session_title', { title: '  Auth refactor  ' }, { caller: publicId });
    assert.deepEqual(res, { sessionId: publicId, title: 'Auth refactor' }, 'bare data, trimmed, no ok');
    assert.equal(await getTitle(backing), 'Auth refactor', 'stored under the backing id');
    assert.equal(await getTitle(publicId), null, 'nothing stored under the public id');
    assert.equal(inst.title, 'Auth refactor', 'live instance title set immediately');

    const dir = path.join(srv.claudeProjectsRoot, encodeCwd(inst.cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${backing}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    const rows = await api(srv.baseUrl, 'GET', '/api/projects/st-caller/sessions');
    const row = rows.body.find(x => x.sessionId === publicId);
    assert.ok(row, `the session must be listed under its public id: ${JSON.stringify(rows.body)}`);
    assert.equal(row.title, 'Auth refactor', 'the sidebar row carries the self-set title');
  } finally {
    await srv.close();
  }
});

test('set_session_title shows up in list_sessions and describe_session', async () => {
  // Pins: the MCP read surfaces render the self-set title in place of firstPrompt.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-reads' });
    const inst = await spawnIdle(srv, 'st-reads');
    const sid = inst.sessionId;
    await callTool(srv.baseUrl, 'set_session_title', { title: 'Distinctive-Name-Q7' }, { caller: sid });

    const list = await callToolRaw(srv.baseUrl, 'list_sessions', {});
    const listText = list.content.map(c => c.text).join('\n');
    assert.match(listText, new RegExp(`LIVE ${sid}[\\s\\S]*?title Distinctive-Name-Q7`),
      `list_sessions shows the title on the caller's row:\n${listText}`);

    const desc = await callToolRaw(srv.baseUrl, 'describe_session', { sessionId: sid });
    const descText = desc.content.map(c => c.text).join('\n');
    assert.match(descText, /title Distinctive-Name-Q7/, `describe_session shows the title:\n${descText}`);
  } finally {
    await srv.close();
  }
});

test('set_session_title refuses a sessionId argument', async () => {
  // Pins: a caller cannot title ANY other session — a sessionId argument is an
  // unexpected-argument refusal, and the other session's title is untouched.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-other' });
    const caller = await spawnIdle(srv, 'st-other');
    const other = await spawnIdle(srv, 'st-other');

    const r = await callToolRaw(srv.baseUrl, 'set_session_title',
      { sessionId: other.sessionId, title: 'hijack' }, { caller: caller.sessionId });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /unexpected argument 'sessionId'/);
    assert.equal(other.title, null, 'the other session\'s live title is unchanged');
    assert.equal(caller.title, null, 'the caller was not titled either');
    assert.equal((await loadAll()).size, 0, 'no sidecar entry written');
  } finally {
    await srv.close();
  }
});

test('set_session_title without ?caller= errors', async () => {
  // Pins: with no caller identity there is no target — the tool throws the
  // missing-caller error and stores nothing.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-nocaller' });
    const inst = await spawnIdle(srv, 'st-nocaller');
    const r = await callToolRaw(srv.baseUrl, 'set_session_title', { title: 'orphan' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /caller identity missing/);
    assert.equal(inst.title, null);
    assert.equal((await loadAll()).size, 0, 'no sidecar entry written');
  } finally {
    await srv.close();
  }
});

test('set_session_title rejects empty/whitespace and over-long titles', async (t) => {
  // Pins: the schema refuses (never truncates or clears) — an empty, a
  // whitespace-only and a MAX_TITLE_LEN+1 title each error and leave the
  // caller's existing title in place.
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-bad' });
    const inst = await spawnIdle(srv, 'st-bad');
    const sid = inst.sessionId;
    await callTool(srv.baseUrl, 'set_session_title', { title: 'keep' }, { caller: sid });

    await t.test('empty', async () => {
      const r = await callToolRaw(srv.baseUrl, 'set_session_title', { title: '' }, { caller: sid });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /argument 'title' must match/);
    });
    await t.test('whitespace-only', async () => {
      const r = await callToolRaw(srv.baseUrl, 'set_session_title', { title: ' \t ' }, { caller: sid });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /argument 'title' must match/);
    });
    await t.test('over-long', async () => {
      const r = await callToolRaw(srv.baseUrl, 'set_session_title', { title: 'x'.repeat(MAX_TITLE_LEN + 1) }, { caller: sid });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /argument 'title' must be at most/);
    });
    assert.equal(inst.title, 'keep', 'live title unchanged');
    assert.equal(await getTitle(inst.backingSessionId), 'keep', 'stored title unchanged');
  } finally {
    await srv.close();
  }
});

test('a self-set title survives resume', async () => {
  // Pins: a fresh Instance resumed on the public id re-acquires the self-set
  // title from the sidecar (_hydrateTitle).
  const srv = await bootServer({ scenarioPath: SCENARIO });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'st-resume' });
    const inst = await spawnIdle(srv, 'st-resume');
    const publicId = inst.sessionId;
    await callTool(srv.baseUrl, 'set_session_title', { title: 'Survives resume' }, { caller: publicId });

    // --resume needs a transcript on disk to find.
    const dir = path.join(srv.claudeProjectsRoot, encodeCwd(inst.cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${inst.backingSessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    await srv.instances.remove(inst.id);
    const resumed = await srv.instances.create({ project: 'st-resume', resume: publicId });
    await waitFor(() => resumed.status === 'idle');
    await waitFor(() => resumed.title === 'Survives resume');
    assert.equal(resumed.sessionId, publicId);
  } finally {
    await srv.close();
  }
});

test('a self-set title survives renew_session', async () => {
  // Pins: the renewal carries the self-set title onto the rotated backing id,
  // both in the sidecar and in memory — i.e. the tool set inst.title, which
  // carryMarkersAcrossRenewal reads.
  const srv = await bootServer({ scenarioPath: SCENARIO_RENEW });
  mgr = srv.instances;
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const inst = await spawnIdle(srv, 'p');
    const sid = inst.sessionId;
    const TITLE = 'Renewal survivor';
    await callTool(srv.baseUrl, 'set_session_title', { title: TITLE }, { caller: sid });

    const armed = await callTool(srv.baseUrl, 'renew_session', { summary: 'keep the title' }, { caller: sid });
    assert.equal(armed.ok, true);
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, RENEWED_BACKING)?.backingSessionId === RENEWED_BACKING);

    await waitFor(async () => (await getTitle(RENEWED_BACKING)) === TITLE);
    assert.equal(instForSession(srv.instances, sid).title, TITLE, 'in-memory title survived the rotation');
  } finally {
    await srv.close();
  }
});
