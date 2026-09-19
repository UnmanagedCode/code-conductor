// The recon split, end to end: `list_projects` counts a project's live workers,
// `list_sessions` names them and then lists the stopped sessions in scope.
//
// The load-bearing test is the agreement invariant — `live N` and the size of
// the live-row count must be the same number. They are computed by different
// code (InstanceManager.liveCountForProject vs the isDeadStatus filter in
// listSessions) over different collections, so nothing but the shared predicate
// keeps them equal. The case that actually exercises the predicate is a
// NON-TEMP exited instance: byId retains those indefinitely (respawn resumes
// them), so it is the only state where "in byId" and "live" differ. A temp
// worker leaves byId on exit and so proves nothing about the filter.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { conductProjectPath, ensureConductProject } from '../src/conduct.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, claudeProjectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function call(name, args = {}) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result.content[0].text;
}
// The refusal path returns JSON instead of the usual text rendering.
const callJson = async (name, args) => JSON.parse(await call(name, args));

// `live N` for one project, read out of the list_projects rendering.
function liveCountOf(text, project) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.startsWith(`▸ ${project}  `));
  assert.ok(at >= 0, `project '${project}' not in the rendering:\n${text}`);
  const end = lines.slice(at + 1).findIndex(l => l.startsWith('▸ '));
  const block = lines.slice(at + 1, end >= 0 ? at + 1 + end : undefined);
  const live = block.find(l => l.startsWith('  live '));
  assert.ok(live, `no live line in the block for '${project}':\n${block.join('\n')}`);
  return Number(live.slice('  live '.length));
}

// Split a list_sessions rendering into its live and inactive sessionId lists.
// Live rows are `[n] LIVE <sid>`; an inactive row starts with the bare sid.
//
// The id token is matched by SHAPE rather than at a fixed 36-char width: a row
// reports its session's PUBLIC id, which is 8 hex chars for anything minted since
// card 2026-0126 and a full UUID for a session that has no lineage row (the base
// case — including every hand-written fixture in this file).
function sections(text) {
  const lines = text.split('\n');
  const live = lines.filter(l => /^\s*\[\d+\] LIVE /.test(l))
    .map(l => l.slice(l.indexOf('LIVE ') + 'LIVE '.length).trim());
  const inactive = lines
    .map(l => /^\s+([0-9a-f][0-9a-f-]{7,35})(\s|$)/.exec(l))
    .filter(Boolean)
    .map(m => m[1]);
  return { live, inactive };
}

// The per-group summary counts, as one flat list of `[live, inactive, archived]`.
function groupCounts(text) {
  return [...text.matchAll(/^ {2}(?:main checkout|worktree \S+).*live (\d+) · inactive (\d+) · archived (\d+)$/gm)]
    .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

async function materializeJsonl(inst) {
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${inst.backingSessionId}.jsonl`);
  await fs.writeFile(file, '{"type":"user","uuid":"u1"}\n');
  return file;
}

async function spawn(project, { temp = true } = {}) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, temp, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}
const killAndWait = async (inst) => {
  await inst.kill({ graceMs: 50 });
  await waitFor(() => inst.status === 'exited' || inst.status === 'crashed');
};

test('a non-temp instance retained in byId after exit is not counted live', async () => {
  // THE dead-status test. A non-temp instance survives its own exit in byId
  // (tests/instances.test.mjs pins that, because Resume/respawn needs it), so
  // `live N` can only be right if it filters on status. Drop the
  // `!isDeadStatus(i.status)` clause in liveCountForProject and this reads 1.
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const inst = await spawn('demo', { temp: false });
  const sid = inst.sessionId;          // an inactive row reports the session's PUBLIC id
  const backing = inst.backingSessionId; // …while its transcript is named by the backing id
  await materializeJsonl(inst);
  assert.equal(liveCountOf(await call('list_projects'), 'demo'), 1, 'live while running');

  await killAndWait(inst);
  assert.ok(instances.get(inst.id), 'precondition: a non-temp instance stays in byId after exit');

  assert.equal(liveCountOf(await call('list_projects'), 'demo'), 0,
    'an exited instance still sitting in byId is not a live worker');
  const { live, inactive } = sections(await call('list_sessions', { project: 'demo' }));
  assert.deepEqual(live, [], 'and it is not in the live section either');
  assert.deepEqual(inactive, [sid],
    'it reappears as an inactive row off its own transcript — the two sections stay disjoint');
});

test('live N and the live-row count stay equal across a worker exiting', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const a = await spawn('demo');
  const b = await spawn('demo');

  const before = sections(await call('list_sessions', { project: 'demo' }));
  assert.deepEqual(before.live.slice().sort(), [a.sessionId, b.sessionId].sort());
  assert.equal(liveCountOf(await call('list_projects'), 'demo'), before.live.length,
    'live N must equal the live-row count');

  await killAndWait(a);
  const after = sections(await call('list_sessions', { project: 'demo' }));
  assert.deepEqual(after.live, [b.sessionId], 'only the survivor is live');
  assert.equal(liveCountOf(await call('list_projects'), 'demo'), after.live.length,
    'live N must follow the exit in lockstep with the live rows');
});

test('a live worker appears once — its own transcript does not double it into the inactive rows', async () => {
  // The sections are disjoint only because the live sessionIds are passed to
  // listSessionsForCwd as excludeSessionIds. A running worker HAS a transcript
  // on disk, so without that argument it would be listed twice — once as a
  // worker and once as a stopped session, which is worse than either bug this
  // card set out to fix. (Materialising the jsonl is what makes the exclusion
  // observable at all: fake-claude does not write one.)
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const inst = await spawn('demo');
  await materializeJsonl(inst);

  const { live, inactive } = sections(await call('list_sessions', { project: 'demo' }));
  assert.deepEqual(live, [inst.sessionId], 'listed as a live worker');
  assert.deepEqual(inactive, [], 'and NOT also as a stopped session');
});

test('an archived session is never listed, and a killed temp session is archived', async () => {
  // Killing a temp instance archives it (tests/archive-sessions.test.mjs), and
  // archiving is the deliberate act of taking a session off the list — so the
  // worker must disappear from BOTH sections, not migrate into the inactive rows.
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const inst = await spawn('demo', { temp: true });
  const sid = inst.sessionId;          // an inactive row reports the session's PUBLIC id
  const backing = inst.backingSessionId; // …while its transcript is named by the backing id
  await materializeJsonl(inst);
  await killAndWait(inst);
  await waitFor(async () => {
    const s = await api(baseUrl, 'GET', '/api/projects/demo/sessions?includeArchived=1');
    return s.body.find(r => r.sessionId === sid)?.archived === true;
  });

  const text = await call('list_sessions', { project: 'demo' });
  assert.ok(!text.includes(sid), `an archived session must not be listed anywhere:\n${text}`);
  assert.ok(!text.includes(backing), `nor under its backing id:\n${text}`);
  assert.deepEqual(sections(text), { live: [], inactive: [] });
  // ...but it is still COUNTED, so an archived session is never silently invisible.
  assert.deepEqual(groupCounts(text), [[0, 0, 1]]);
  assert.match(text, /^ {4}\+1 archived \(includeArchived:true to list\)$/m);

  // includeArchived brings it back, flagged.
  const expanded = await call('list_sessions', { project: 'demo', includeArchived: true });
  assert.deepEqual(sections(expanded).inactive, [sid]);
  assert.match(expanded, /archived/);
});

test('a stopped session with no instance at all is listed, newest first', async () => {
  // The GUI-sidebar rows: persisted, non-archived, no process — including ones
  // this process never ran. Two rows, so the ordering is actually observable.
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const proj = await api(baseUrl, 'GET', '/api/projects');
  const cwd = proj.body.find(p => p.name === 'demo').path;
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  for (const sid of [older, newer]) {
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');
  }
  // These stub transcripts carry no timestamped record, so lastActivity falls
  // back to mtime (sessionActivity.ts) — set it explicitly rather than relying
  // on write order, which need not correlate with readdir order.
  await fs.utimes(path.join(dir, `${older}.jsonl`), new Date(1_000_000), new Date(1_000_000));
  await fs.utimes(path.join(dir, `${newer}.jsonl`), new Date(2_000_000), new Date(2_000_000));

  const { live, inactive } = sections(await call('list_sessions', { project: 'demo' }));
  assert.deepEqual(live, []);
  assert.deepEqual(inactive, [newer, older], 'newest transcript first');
});

test('the project filter is validated, and .conduct stays legal', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'other' });
  const mine = await spawn('demo');

  const filtered = await call('list_sessions', { project: 'demo' });
  assert.deepEqual(sections(filtered).live, [mine.sessionId]);
  assert.match(filtered, /^SESSIONS \(live 1 · inactive 0 · archived 0\) {2}project demo$/m,
    'the heading echoes the filter');

  // A typo must refuse, not render as an idle fleet.
  const bad = await callJson('list_sessions', { project: 'no-such-project' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PROJECT_UNKNOWN');
  // '' would pass a bare truthiness check and silently render the whole fleet
  // under an un-echoed heading — it must refuse like any other non-project.
  assert.equal((await callJson('list_sessions', { project: '' })).code, 'PROJECT_UNKNOWN');

  // A real project with nothing in it renders normally — emptiness is not an error.
  assert.match(await call('list_sessions', { project: 'other' }),
    /^SESSIONS \(live 0 · inactive 0 · archived 0\) {2}project other$/m);
});

test('a conductor session is listed with and WITHOUT the filter', async () => {
  // listProjects skips `.conduct` unless a caller opts in, so it reaches the
  // unfiltered scan only because listSessions does. Without that, a conductor whose own prior
  // session ended (restart, /clear, crash) calls list_sessions() to find
  // something to resume and sees every project's stopped sessions except its
  // own. Asserting on a REAL sessionId, not a count: the previous version of
  // this test matched a bare count regex, which any behaviour satisfies.
  const sid = '33333333-3333-4333-8333-333333333333';
  await ensureConductProject();
  const dir = path.join(claudeProjectsRoot, encodeCwd(conductProjectPath()));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  const filtered = await call('list_sessions', { project: '.conduct' });
  assert.match(filtered, /^SESSIONS \(live 0 · inactive 1 · archived 0\) {2}project \.conduct$/m,
    '.conduct is an accepted filter');
  assert.deepEqual(sections(filtered).inactive, [sid], 'filtered: the conductor session is there');

  const unfiltered = await call('list_sessions');
  assert.ok(sections(unfiltered).inactive.includes(sid),
    `unfiltered list_sessions must not hide conductor sessions:\n${unfiltered}`);
});

test('rows are grouped by project rather than by spawn order', async () => {
  // Interleave the spawns so byId insertion order and the intended order differ:
  // a pass-through of Map order would return a,b,a — the grouping makes it a,a,b.
  await api(baseUrl, 'POST', '/api/projects', { name: 'aaa' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'bbb' });
  const a1 = await spawn('aaa');
  const b1 = await spawn('bbb');
  const a2 = await spawn('aaa');

  const { live } = sections(await call('list_sessions'));
  assert.deepEqual(live, [a1.sessionId, a2.sessionId, b1.sessionId],
    'both aaa workers must be adjacent, in spawn order, ahead of bbb');
});
