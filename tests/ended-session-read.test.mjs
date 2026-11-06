// An ended worker stays readable through the landing sequence: kill_instance,
// then delete_worktree. The transcript is outside the worktree and survives
// both; what these tests pin is that every read surface still FINDS it —
// through the session record's recorded place (findSessionLocation), the
// retired pager the open pane pages from, the disk lineage route a reopened
// view pages from, and Settings → Archived — and that a session whose place is
// gone never resumes somewhere else.
//
// The fake CLI writes no jsonl, so each fixture seeds the transcript the CLI
// would have written, at the worker's BACKING id under the worktree's place.
// One top-level test per row: the root afterEach shuts instances down around
// subtests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bootServer, api, waitFor, instForSession, seedSessionJsonl, driveTurn, registerLocalProject,
} from './helpers.mjs';
import { localPlace, orchStoreRoot } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function makeRealRepo(ctx, name) {
  const repoPath = path.join(ctx.projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await registerLocalProject(name, repoPath);
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test repo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
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
const textOf = (result) => result.content.map(c => c.text).join('\n');

const sessionsDoc = async () =>
  JSON.parse(await fs.readFile(path.join(orchStoreRoot(), 'sessions.json'), 'utf8')).sessions;

const ONE_TURN = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_done', role: 'assistant', content: [{ type: 'text', text: 'WORKTREE-WORK-DONE' }] } },
];

// A conducted (MCP-spawned, temp) worker in a fresh worktree of `demo`, driven
// through one turn, with its transcript seeded at the worktree's place. Not yet
// killed: each test decides what it reads before and after.
async function workerInWorktree(ctx, lines = ONE_TURN) {
  await makeRealRepo(ctx, 'demo');
  const wt = await createWorktree('demo', { name: 'job' });
  const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
    project: 'demo', worktree: wt.worktreeName, mode: 'bypassPermissions',
  }));
  assert.ok(spawn.sessionId, `spawn refused: ${JSON.stringify(spawn)}`);
  const sid = spawn.sessionId;
  await waitFor(() => instForSession(ctx.instances, sid)?.status === 'idle');
  await driveTurn(ctx.instances, sid, () => callTool(ctx.baseUrl, 'send_prompt', { sessionId: sid, text: 'go' }));
  const inst = instForSession(ctx.instances, sid);
  const backingId = inst.backingSessionId;
  await seedSessionJsonl(localPlace(wt.worktreePath), backingId, lines);
  // `sid` is the MCP handle (a prefix); REST takes the full public id.
  return { sid, publicId: inst.sessionId, wt, backingId, instanceId: inst.id };
}

async function kill(ctx, sid) {
  const killed = unwrap(await callTool(ctx.baseUrl, 'kill_instance', { sessionId: sid }));
  assert.notEqual(killed.ok, false, `kill_instance refused: ${JSON.stringify(killed)}`);
  await waitFor(() => ctx.instances.idsForSession(sid).length === 0);
}

async function deleteWorktree(ctx, wt) {
  const del = unwrap(await callTool(ctx.baseUrl, 'delete_worktree', { project: 'demo', worktree: wt.worktreeName }));
  assert.notEqual(del.ok, false, `delete_worktree refused: ${JSON.stringify(del)}`);
  await assert.rejects(fs.stat(wt.worktreePath), { code: 'ENOENT' }, 'precondition: the worktree directory is gone');
}

// 1 — INVARIANT: findSessionLocation's recorded-place fallback. A killed
// worker's transcript stays readable by the MCP read tools after its worktree's
// registration is gone, because the session record names its project + worktree.
test('get_transcript and describe_session read a killed worker after delete_worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { sid, wt } = await workerInWorktree(ctx);
    await kill(ctx, sid);
    // Positive control: the same reads while the worktree is still registered.
    const before = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 50 }));
    assert.equal(before.source, 'disk', `control: ${JSON.stringify(before)}`);
    assert.match(textOf(await callTool(ctx.baseUrl, 'describe_session', { sessionId: sid })), /job/);

    await deleteWorktree(ctx, wt);

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 50 }));
    assert.notEqual(page.ok, false, `expected a page, got a refusal: ${JSON.stringify(page)}`);
    assert.equal(page.source, 'disk');
    assert.match(JSON.stringify(page.events), /WORKTREE-WORK-DONE/, 'the seeded assistant text is served');
    const described = await callTool(ctx.baseUrl, 'describe_session', { sessionId: sid });
    const text = textOf(described);
    assert.doesNotMatch(text, /SESSION_UNLOCATABLE|SESSION_UNKNOWN/, text);
    assert.match(text, /demo/);
    assert.match(text, /job/, 'the recorded worktree name is reported');
  } finally { await ctx.close(); }
});

// 2 — INVARIANT: the retired pager keeps the open pane's cursor space. A killed
// instance's lineage-events keep answering by instance id, before and after its
// worktree is deleted, and a `before=` cursor handed out while it was live
// returns the same events it did then.
test('GET /api/instances/:id/lineage-events serves a killed instance, with the live cursor space, across delete_worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { sid, wt, instanceId } = await workerInWorktree(ctx);
    const url = (q) => `/api/instances/${instanceId}/lineage-events${q}`;
    const head = await api(ctx.baseUrl, 'GET', url('?limit=2'));
    assert.equal(head.status, 200, 'control: live instance pages');
    assert.equal(head.body.hasMore, true, `control: the live ring holds more than one page: ${JSON.stringify(head.body)}`);
    const cursor = `?limit=2&before=${head.body.nextBefore}${head.body.segment ? `&segment=${head.body.segment}` : ''}`;
    const live = await api(ctx.baseUrl, 'GET', url(cursor));
    assert.equal(live.status, 200);
    assert.ok(live.body.events.length > 0, 'control: the cursor page is not empty');

    await kill(ctx, sid);
    const killed = await api(ctx.baseUrl, 'GET', url(cursor));
    assert.equal(killed.status, 200, `after kill: ${JSON.stringify(killed.body)}`);
    assert.deepEqual(killed.body.events, live.body.events, 'same cursor, same events');

    await deleteWorktree(ctx, wt);
    const gone = await api(ctx.baseUrl, 'GET', url(cursor));
    assert.equal(gone.status, 200, `after delete_worktree: ${JSON.stringify(gone.body)}`);
    assert.deepEqual(gone.body.events, live.body.events);
    const events = await api(ctx.baseUrl, 'GET', `/api/instances/${instanceId}/events?limit=2`);
    assert.equal(events.status, 200, 'GET /events serves the retired instance too');
  } finally { await ctx.close(); }
});

// 3 — INVARIANT: the disk lineage route. With no instance anywhere, a session
// whose worktree is deleted pages from its transcript newest-first, down
// through a renew seam into its older segment, to hasMore:false.
test('GET /api/sessions/:sid/lineage-events walks a deleted worktree\'s two-segment lineage', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const OLD = [
      { type: 'user', uuid: 'o0', message: { role: 'user', content: 'old prompt' } },
      { type: 'assistant', uuid: 'o1', message: { id: 'm_old', role: 'assistant', content: [{ type: 'text', text: 'OLD-SEGMENT-REPLY' }] } },
    ];
    const NEW = [
      { type: 'user', uuid: 'n0', message: { role: 'user', content: 'new prompt one' } },
      { type: 'assistant', uuid: 'n1', message: { id: 'm_n1', role: 'assistant', content: [{ type: 'text', text: 'NEW-REPLY-ONE' }] } },
      { type: 'user', uuid: 'n2', message: { role: 'user', content: 'new prompt two' } },
      { type: 'assistant', uuid: 'n3', message: { id: 'm_n2', role: 'assistant', content: [{ type: 'text', text: 'NEW-REPLY-TWO' }] } },
    ];
    const { sid, publicId, wt } = await workerInWorktree(ctx, OLD);
    await kill(ctx, sid);
    const renewed = randomUUID();
    const { recordRotation } = await import('../src/sessionLineage.ts');
    await recordRotation(publicId, renewed, 'renew');
    await seedSessionJsonl(localPlace(wt.worktreePath), renewed, NEW);
    await deleteWorktree(ctx, wt);

    const pages = [];
    let q = '?limit=2';
    for (let i = 0; i < 20; i++) {
      const r = await api(ctx.baseUrl, 'GET', `/api/sessions/${publicId}/lineage-events${q}`);
      assert.equal(r.status, 200, `page ${i}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.sessionId, publicId);
      pages.push(r.body);
      if (!r.body.hasMore) break;
      q = `?limit=2${r.body.nextBefore == null ? '' : `&before=${r.body.nextBefore}`}${r.body.segment ? `&segment=${r.body.segment}` : ''}`;
    }
    assert.equal(pages.at(-1).hasMore, false, 'the walk ends');
    assert.ok(pages.length > 1, 'more than one page');
    assert.match(JSON.stringify(pages[0].events), /NEW-REPLY-TWO/, 'the first page is the newest');
    const all = JSON.stringify(pages.map(p => p.events));
    assert.match(all, /NEW-REPLY-ONE/);
    assert.match(all, /OLD-SEGMENT-REPLY/, 'the walk reached the older segment');
    assert.ok(pages.some(p => p.events.some(e => e.kind === 'segment_seam')), 'a renew seam divides them');
    const miss = await api(ctx.baseUrl, 'GET', `/api/sessions/${randomUUID()}/lineage-events`);
    assert.equal(miss.status, 404);
  } finally { await ctx.close(); }
});

// 4 — INVARIANT: Settings → Archived lists a session whose worktree is gone,
// under its project, with the recorded worktree name.
test('GET /api/archived lists a deleted worktree\'s session with its worktreeName', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { sid, publicId, wt } = await workerInWorktree(ctx);
    await kill(ctx, sid);
    await deleteWorktree(ctx, wt);
    const r = await api(ctx.baseUrl, 'GET', '/api/archived');
    assert.equal(r.status, 200);
    const group = r.body.groups.find(g => g.project === 'demo');
    assert.ok(group, `no demo group: ${JSON.stringify(r.body)}`);
    const row = group.sessions.find(s => s.sessionId === publicId);
    assert.ok(row, `the session is listed: ${JSON.stringify(group)}`);
    assert.equal(row.worktreeName, 'job');
  } finally { await ctx.close(); }
});

// 5 — INVARIANT: a session whose worktree is gone never resumes silently
// somewhere else (the project root): the recorded worktree is required, and
// refused by name.
test('spawn_instance({resume}) of a deleted worktree\'s session is refused WORKTREE_UNKNOWN and creates nothing', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { sid, wt } = await workerInWorktree(ctx);
    await kill(ctx, sid);
    await deleteWorktree(ctx, wt);
    const result = await callTool(ctx.baseUrl, 'spawn_instance', { resume: sid });
    assert.equal(result.isError, true, textOf(result));
    assert.equal(JSON.parse(result.content[1].text).code, 'WORKTREE_UNKNOWN', textOf(result));
    assert.equal(ctx.instances.idsForSession(sid).length, 0, 'no instance was created');
  } finally { await ctx.close(); }
});

// 6 — INVARIANT: the S1 writer. Every spawn records where it runs — a REST
// (non-conducted) worktree spawn its project and worktree, a project-root
// spawn its project and no worktree.
test('a REST spawn records project and worktree on its session record; a root spawn records project only', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx, 'demo');
    const wt = await createWorktree('demo', { name: 'rest-wt' });
    const inWt = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo', worktree: wt.worktreeName });
    assert.equal(inWt.status, 201, JSON.stringify(inWt.body));
    const atRoot = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo' });
    assert.equal(atRoot.status, 201, JSON.stringify(atRoot.body));
    await waitFor(async () => {
      const doc = await sessionsDoc().catch(() => ({}));
      return doc[inWt.body.sessionId]?.project && doc[atRoot.body.sessionId]?.project;
    });
    const doc = await sessionsDoc();
    const a = doc[inWt.body.sessionId];
    assert.equal(a.conducted, undefined, 'precondition: not conducted');
    assert.equal(a.project, 'demo');
    assert.equal(a.worktree, 'rest-wt');
    const b = doc[atRoot.body.sessionId];
    assert.equal(b.project, 'demo');
    assert.ok(!('worktree' in b), 'a project-root session records no worktree');
  } finally { await ctx.close(); }
});

// 7 — INVARIANT: the retired pager is bounded. Past RETIRED_PAGER_CAP captures
// the oldest is forgotten (its lineage-events route then 404s); the rest stay.
test('RetiredPagers forgets the oldest capture past RETIRED_PAGER_CAP', async () => {
  const { RetiredPagers, RETIRED_PAGER_CAP } = await import('../src/retiredPagers.ts');
  const fake = (i) => ({
    id: `inst-${i}`, sessionId: `s-${i}`, backingSessionId: `b-${i}`,
    transcriptPlace: localPlace('/nowhere'), _userEchoCount: 0,
    ring: { trimmedBefore: 0, nextSeq: 1, seams: [{ segmentId: `b-${i}`, startSeq: 0 }] },
    ringSnapshot: () => [{ kind: 'assistant_text', text: `t${i}`, _seq: 0 }],
  });
  const pagers = new RetiredPagers();
  for (let i = 0; i <= RETIRED_PAGER_CAP; i++) pagers.capture(fake(i));
  assert.equal(pagers.get('inst-0'), undefined, 'the oldest is evicted');
  assert.ok(pagers.get('inst-1'), 'the next oldest is kept');
  const last = pagers.get(`inst-${RETIRED_PAGER_CAP}`);
  assert.ok(last, 'the newest is kept');
  assert.equal(last.sessionId, `s-${RETIRED_PAGER_CAP}`);
  assert.deepEqual(last.ringSnapshot().map(e => e.text), [`t${RETIRED_PAGER_CAP}`]);
  // A recapture refreshes, so it is not the next one evicted.
  pagers.capture(fake(1));
  pagers.capture(fake(RETIRED_PAGER_CAP + 1));
  assert.ok(pagers.get('inst-1'), 'a recaptured entry moved to the newest end');
  assert.equal(pagers.get('inst-2'), undefined);
});
