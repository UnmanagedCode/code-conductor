// The server half of the unread indicator: every turn end raises the session
// record's turnEndSeq, POST /api/sessions/:sid/viewed raises viewedSeq, both
// reach every client through the instances summary, and nothing on the MCP
// surface can mark a session viewed (src/sessionViewed.ts, src/routes.ts).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl, driveTurn, settle } from './helpers.mjs';
import { localPlace } from '../src/projects.ts';
import { getTurnMarks } from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-turn-ends.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);

async function spawn(project = 'p') {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// One turn the session starts on its own (no UI involved), to its recorded end.
async function serverTurn(inst) {
  const before = inst.turnEndSeq;
  await driveTurn(instances, inst.sessionId, () => inst.prompt('go', [], { internal: true }));
  await waitFor(() => inst.turnEndSeq > before);
}

const summaryOf = async (inst) => (await api(baseUrl, 'GET', '/api/instances')).body.find(s => s.id === inst.id);
const view = (sid, seq) => api(baseUrl, 'POST', `/api/sessions/${sid}/viewed`, { seq });

// Invariant: a turn end raises turnEndSeq in /api/instances and on the record.
test('a turn end raises turnEndSeq in the summary and the store', async () => {
  const inst = await spawn();
  assert.equal((await summaryOf(inst)).turnEndSeq, 0, 'a new session starts read');
  await serverTurn(inst);
  const s = await summaryOf(inst);
  assert.deepEqual([s.turnEndSeq, s.viewedSeq], [1, 0]);
  assert.deepEqual(await getTurnMarks(inst.sessionId), { turnEndSeq: 1, viewedSeq: 0 });
});

// Invariant: a turn the session starts on its own after being viewed makes it
// unread again — the reset is driven by the turn end, not by the UI.
test('a later server-started turn makes a viewed session unread again', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  assert.equal((await view(inst.sessionId, 1)).status, 200);
  await serverTurn(inst);
  const s = await summaryOf(inst);
  assert.deepEqual([s.turnEndSeq, s.viewedSeq], [2, 1]);
});

// Invariant: POST /viewed sets viewedSeq, answers both counters, updates the
// live summary, and tells every WS client to re-fetch the instances list — and
// only that list: a turn-marks change sends no `projects` hint.
test('POST /viewed sets the marker and broadcasts instances, not projects, to every client', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  const ws = new WebSocket(ctx.wsUrl);
  const messages = [];
  ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  try {
    await settle();
    const mark = messages.length;
    const r = await view(inst.sessionId, 1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, sessionId: inst.sessionId, turnEndSeq: 1, viewedSeq: 1 });
    assert.equal((await summaryOf(inst)).viewedSeq, 1);
    await waitFor(() => messages.slice(mark).some(m => m.t === 'instances'), { timeout: 4000 });
    await settle();
    assert.deepEqual(messages.slice(mark).filter(m => m.t === 'projects'), [], 'no projects hint');
    assert.deepEqual(await getTurnMarks(inst.sessionId), { turnEndSeq: 1, viewedSeq: 1 });
  } finally {
    ws.terminate();
  }
});

// Invariant: a turn-marks change is its own event, never a `status` emit —
// `status` drives the playbook gate's retire record (a late emit on a killed
// worker would ledger a second retire) and every client's projects refetch.
test('setTurnMarks emits turn_marks and never status', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  await settle();
  const seen = [];
  const onStatus = () => seen.push('status');
  const onMarks = () => seen.push('turn_marks');
  inst.on('status', onStatus);
  inst.on('turn_marks', onMarks);
  try {
    inst.setTurnMarks({ turnEndSeq: inst.turnEndSeq + 1, viewedSeq: inst.viewedSeq });
    inst.setTurnMarks({ turnEndSeq: inst.turnEndSeq, viewedSeq: inst.viewedSeq });
    assert.deepEqual(seen, ['turn_marks'], 'one event for the change, none for the no-op, no status');
    assert.equal(inst.summary().turnEndSeq, 2);
  } finally {
    inst.off('status', onStatus);
    inst.off('turn_marks', onMarks);
  }
});

// Invariant: the route takes only a non-negative integer seq (400 otherwise)
// and only a known session (404 otherwise).
// Each row breaks alone; a plain loop, because the file's afterEach would run
// after every t.test subtest and tear the instance down.
test('POST /viewed refuses a bad seq with 400 and an unknown session with 404', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  for (const seq of [-1, '3', 1.5, undefined]) {
    const r = await view(inst.sessionId, seq);
    assert.equal(r.status, 400, `seq ${JSON.stringify(seq)}: ${JSON.stringify(r.body)}`);
    assert.match(JSON.stringify(r.body), /seq must be a non-negative integer/);
  }
  assert.equal((await summaryOf(inst)).viewedSeq, 0, 'no refused call moved the marker');
  const r = await view(randomUUID(), 0);
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.match(JSON.stringify(r.body), /session not found/);
});

// Invariant: the counters survive a kill + resume — the new process hydrates
// them from the store.
test('a resumed session carries its stored turn marks', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  await serverTurn(inst);
  await view(inst.sessionId, 1);
  const publicId = inst.sessionId;
  await seedSessionJsonl(localPlace(path.join(projectsRoot, 'p')), inst.backingSessionId);
  await instances.remove(inst.id);
  const resumed = await instances.create({ project: 'p', resume: publicId });
  await waitFor(() => resumed.status === 'idle');
  await waitFor(async () => (await summaryOf(resumed))?.turnEndSeq === 2);
  assert.equal((await summaryOf(resumed)).viewedSeq, 1);
});

// Invariant: a disk session row carries the record's counters, so the tree
// pill of an exited session reads the same fact.
test('a session-list row carries turnEndSeq and viewedSeq', async () => {
  const inst = await spawn();
  await serverTurn(inst);
  await serverTurn(inst);
  await view(inst.sessionId, 1);
  const publicId = inst.sessionId;
  await seedSessionJsonl(localPlace(path.join(projectsRoot, 'p')), inst.backingSessionId);
  await instances.remove(inst.id);
  const r = await api(baseUrl, 'GET', '/api/projects/p/sessions');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.find(s => s.sessionId === publicId);
  assert.ok(row, JSON.stringify(r.body));
  assert.deepEqual([row.turnEndSeq, row.viewedSeq], [2, 1]);
});

// Invariant: no MCP read or forward marks a session viewed — a conductor
// reading a worker's output leaves it unread for the human.
test('MCP reads and send_prompt forward never mark a session viewed', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'm' });
  const src = unwrap(await callTool('spawn_instance', { project: 'm', mode: 'bypassPermissions' })).sessionId;
  const dst = unwrap(await callTool('spawn_instance', { project: 'm', mode: 'bypassPermissions' })).sessionId;
  await waitFor(() => instances.idsForSession(src).length && instances.get(instances.idsForSession(src)[0]).status === 'idle');
  await waitFor(() => instances.idsForSession(dst).length && instances.get(instances.idsForSession(dst)[0]).status === 'idle');
  await driveTurn(instances, src, () => callTool('send_prompt', { sessionId: src, text: 'go' }));
  await waitFor(async () => (await getTurnMarks(src)).turnEndSeq === 1);

  await callTool('get_recent_messages', { sessionId: src });
  await callTool('get_transcript', { sessionId: src });
  await callTool('describe_session', { sessionId: src });
  await driveTurn(instances, dst, () => callTool('send_prompt', { sessionId: dst, forward: { sessionId: src }, text: 'go' }));
  await settle();

  assert.deepEqual(await getTurnMarks(src), { turnEndSeq: 1, viewedSeq: 0 }, 'the source is still unread');
  const live = instances.get(instances.idsForSession(src)[0]);
  assert.deepEqual([live.summary().turnEndSeq, live.summary().viewedSeq], [1, 0]);
});

async function tsFiles(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await tsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Invariant: the viewed writer is reachable from the browser route only —
// nothing under src/mcp/ imports sessionViewed.ts or names its writers, and
// routes.ts is applySessionViewed's one importer.
test('the viewed writer is imported by routes.ts alone', async () => {
  const files = await tsFiles(SRC);
  const rel = (f) => path.relative(SRC, f);
  const bodies = new Map(await Promise.all(files.map(async f => [rel(f), await fs.readFile(f, 'utf8')])));
  const mcpHits = [...bodies].filter(([f, b]) => f.startsWith('mcp' + path.sep)
    && /sessionViewed|markViewed|applySessionViewed/.test(b)).map(([f]) => f);
  assert.deepEqual(mcpHits, [], 'no MCP module reaches the viewed writer');
  const importers = [...bodies].filter(([, b]) => /import[^;]*\bapplySessionViewed\b[^;]*from/.test(b)).map(([f]) => f);
  assert.deepEqual(importers, ['routes.ts'], 'routes.ts is the one importer (positive control: the sweep finds it)');
  const markViewedUsers = [...bodies].filter(([f, b]) => f !== 'sessionStore.ts' && /\bmarkViewed\b/.test(b)).map(([f]) => f);
  assert.deepEqual(markViewedUsers, ['sessionViewed.ts']);
});
