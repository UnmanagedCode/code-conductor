// LOCATING — AND READING — A SESSION THAT RAN ON A PROJECT ON A SYSTEM.
//
// `findSessionLocation` answers "which project and worktree owns this session"
// by probing `~/.claude/projects/<encodeCwd(cwd)>/<id>.jsonl` for each candidate
// cwd. It drew those cwds from the project TREE, which for a project on a system
// is a path on the OTHER MACHINE — a directory the local Claude CLI never had as
// a cwd. So every session on every remote project was unlocatable, and the bare
// `spawn_instance({resume})` form (the one an MCP conductor uses, and the one
// spawn_instance's own description advertises as recovering the project and
// worktree automatically) refused `400 project required` for all of them — the
// same refusal a typo'd UUID gets (card 2026-0292).
//
// THE SCOPE IS RESUME **AND** READ, deliberately wider than "resume". Two
// consuming sites turn a hit into a TRANSCRIPT CWD, and both re-derived it from
// the project tree: `getInstOrDisk` (MCP get_transcript / get_recent_messages /
// send_prompt's forward source) and the two `/sessions/:id/summary` routes.
// Widening the probe alone would have turned a NAMED refusal into a
// successfully EMPTY transcript page — the precise failure `excludedRefusal`
// exists to prevent — and `POST /summary` from a 404 into a 500. So the answer
// now carries the `cwd` the transcript was FOUND at, and those sites read it.
//
// THE PROBE IS TWO PASSES, WITH GLOBAL PRECEDENCE. Pass 1 = every local place's
// tree path plus every remote place's local session roots. Pass 2 = the remote
// places' RAW tree paths only, reached only after every pass-1 candidate
// everywhere has missed. Pass 2 is kept because the state it serves is
// reachable through supported operations (T6) and it is strictly last because a
// remote place's tree path can name a LOCAL project's real cwd (T5).
//
// SAME-MACHINE TRAP, GUARDED THE WAY EVERY REMOTE-PLACEMENT FILE HERE GUARDS IT.
// The reference provider IS this machine, so a project tree lives under an
// `mkdtemp` prefix OUTSIDE `PROJECTS_ROOT` and every expected location is
// resolved from `sessionRootPath` independently of the instance that produced
// it — a cwd composed against the project instead of the image root gives a
// different answer here rather than agreeing by accident.
//
// TEST-FIRST STATUS. T1–T9 and T12 had free BEHAVIOURAL red on the shipped
// code: it produced the wrong answer, the wrong refusal or no answer at all,
// with no source change. T10 and T11 are CONTROLS — their {project,
// worktreeName} halves and their literal `400 project required` arm hold on the
// shipped code unchanged; what makes them red there is only that the answer had
// no `cwd` field at all, so they pin that the new required field AGREES with the
// derivation it replaced rather than pinning new behaviour. It is the mutation
// prover, not this file's own run, that establishes a control's non-vacuity.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { bindRemoteSystem, referenceLaunch, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import {
  adoptProject, findSessionLocation, getProject, projectStoreDir,
} from '../src/projects.ts';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.ts';
import { getWorktree, createWorktree } from '../src/worktrees.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';
import { setSummary } from '../src/sessionSummaries.ts';
import { recordRotation } from '../src/sessionLineage.ts';

// A UUID nothing on this host answers to. The pre-fix refusal for a session on
// a system was byte-identical to this one's, which is why the fix is about
// distinguishability and not only about resume.
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('a session on a project on a system', () => {
  let ctx, baseUrl, instances, home, claudeProjectsRoot;
  let n = 0;
  let rpcId = 1;

  before(async () => {
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
  });
  after(async () => { if (ctx) await ctx.close(); });

  // A fresh store per test: the system registry, the session roots, the summary
  // store and the lineage all hang off PROJECTS_ROOT.
  beforeEach(async () => { ({ home, claudeProjectsRoot } = await freshProjectsRoot()); });
  afterEach(async () => {
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json());
  }
  const unwrap = (body) => JSON.parse(body.result.content[0].text);

  // Spawn one session, seed the transcript the CLI would have written at its
  // OWN cwd (the fake engine writes none), then kill it — so what remains is a
  // retired session with bytes on disk and no process, which is exactly the
  // state every locate has to answer for.
  async function retiredSession({ project, worktree } = {}) {
    const r = await api(baseUrl, 'POST', '/api/instances', worktree ? { project, worktree } : { project });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.sessionId && inst.backingSessionId);
    const { sessionId, backingSessionId, cwd } = inst;
    await seedSessionJsonl(claudeProjectsRoot, cwd, backingSessionId);
    assert.equal((await api(baseUrl, 'DELETE', `/api/instances/${r.body.id}`)).status, 200);
    return { sessionId, backingSessionId, cwd };
  }

  // A registered system whose provider advertises a mirror root WIDER than the
  // project, so the project's place inside its image is a non-empty offset and
  // `root + offset` is distinguishable from `root`.
  async function wideSystem(sub) {
    const id = `widebox${++n}`;
    const box = await mkdtemp('cc-0292-');
    await addSystem({ id, label: id, launch: referenceLaunch('--mirror', box) });
    const tree = await seedRepo(path.join(box, sub));
    return { id, box, tree };
  }

  // ── T1 ──────────────────────────────────────────────────────────────
  // PINS: a session on a remote project resolves, so a bare resume with NO
  // project lands at that session's own session root.
  // NOT claiming the REST and MCP arms have independent mechanisms — they share
  // `_doCreateResolved`. The MCP arm is here because it is the form the card is
  // about, and it shares this test's killer set rather than adding one.
  test('T1: a bare resume with no project recovers it, on both surfaces', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);

    const a = await retiredSession({ project: 'app' });
    // Resolved from the module, not read off the instance: a cwd composed
    // against the project instead of the image root would differ here.
    const imageRoot = await fs.realpath(sessionRootPath(remote.id, 'app', null));
    assert.equal(a.cwd, imageRoot, 'the session ran in the image root (offset "")');

    const rest = await api(baseUrl, 'POST', '/api/instances', { resume: a.sessionId });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(instances.get(rest.body.id).cwd, imageRoot);

    const b = await retiredSession({ project: 'app' });
    const mcp = await callTool('spawn_instance', { resume: b.sessionId });
    assert.ok(mcp.result && !mcp.error, `spawn_instance({resume}) refused: ${JSON.stringify(mcp)}`);
    assert.equal(unwrap(mcp).sessionId, b.sessionId);
    assert.equal(instances.liveForSession(b.sessionId).cwd, imageRoot);
  });

  // ── T2 ──────────────────────────────────────────────────────────────
  // PINS: the mirror OFFSET is part of the answer — under a mirror root wider
  // than the project the session ran at `root + offset`, and the bare resume
  // still recovers it.
  // NOT claiming any particular offset is chosen: only that the enumerated
  // candidate set contains the one the session actually ran at.
  test('T2: a wider mirror root puts the session at root + offset, and it still resolves', async () => {
    const w = await wideSystem(path.join('nest', 'app'));
    assert.equal((await adoptProject('app', w.tree, { system: w.id })).ok, true);

    const s = await retiredSession({ project: 'app' });
    const imageRoot = await fs.realpath(sessionRootPath(w.id, 'app', null));
    assert.equal(s.cwd, path.join(imageRoot, 'nest', 'app'), 'offset is non-empty');
    assert.notEqual(s.cwd, imageRoot);

    const hit = await findSessionLocation(s.sessionId);
    assert.deepEqual(hit, { project: 'app', worktreeName: null, cwd: s.cwd });
    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id).cwd, s.cwd);
  });

  // ── T3 ──────────────────────────────────────────────────────────────
  // PINS: a session on a remote project's WORKTREE resolves with worktreeName
  // recovered, at that worktree's own image root plus THAT WORKTREE'S offset —
  // which under a wide mirror is not the project's offset.
  // NOT claiming anything about creating a worktree while a target change is
  // pending; the fixture only needs the worktree to exist.
  test('T3: a remote worktree session recovers its worktree and its own offset', async () => {
    const w = await wideSystem(path.join('nest', 'app'));
    assert.equal((await adoptProject('app', w.tree, { system: w.id })).ok, true);
    const wt = await createWorktree('app', { name: 'wt1' });
    const wtName = wt.worktreeName;
    // The project's offset and the worktree's differ, so a candidate set built
    // from the PROJECT's path could not answer here.
    const projOffset = path.relative(w.box, w.tree);
    const wtOffset = path.relative(w.box, wt.worktreePath);
    assert.notEqual(projOffset, wtOffset);

    const s = await retiredSession({ project: 'app', worktree: wtName });
    const wtImageRoot = await fs.realpath(sessionRootPath(w.id, 'app', wtName));
    assert.equal(s.cwd, path.join(wtImageRoot, wtOffset));

    assert.deepEqual(await findSessionLocation(s.sessionId),
      { project: 'app', worktreeName: wtName, cwd: s.cwd });
    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id).cwd, s.cwd);
  });

  // ── T4 ──────────────────────────────────────────────────────────────
  // PINS: the image root is REALPATHed. `projectsRoot()` is `PROJECTS_ROOT`
  // verbatim while the CLI keys its transcript directory off getcwd(), so a
  // store reached through a symlink gives two spellings of one session dir and
  // a candidate built from the raw path misses every session in it.
  // NOT claiming any other store path is realpath-safe.
  test('T4: a PROJECTS_ROOT reached through a symlink still resolves', async () => {
    const real = process.env.PROJECTS_ROOT;
    await fs.mkdir(real, { recursive: true });
    const link = path.join(home, 'link-root');
    await fs.symlink(real, link);
    process.env.PROJECTS_ROOT = link;
    resetProjectsCache(0);

    const remote = await bindRemoteSystem({ id: 'symbox' });
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: 'symbox' })).ok, true);
    // The raw path goes through the link; the CLI's cwd is its realpath. The
    // fixture is only honest if those two really are different strings.
    const raw = sessionRootPath('symbox', 'app', null);
    assert.ok(raw.startsWith(link), raw);

    const s = await retiredSession({ project: 'app' });
    assert.equal(s.cwd, await fs.realpath(raw));
    assert.notEqual(s.cwd, raw);


    assert.deepEqual(await findSessionLocation(s.sessionId),
      { project: 'app', worktreeName: null, cwd: s.cwd });
    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  // ── T5 ──────────────────────────────────────────────────────────────
  // PINS: GLOBAL precedence — no raw remote-tree answer outranks any session-
  // root answer, whatever order the projects come in. Arms (a)/(b) run with the
  // REMOTE place sorting first, which is where the pre-fix code misattributed a
  // local project's own session to the remote project. Arm (c) is the SAME
  // fixture with the names swapped so the LOCAL place sorts first: it is GREEN
  // a CONTROL for the second ordering — it exists so the "the answer does not
  // depend on project ordering" claim is pinned by something rather than by a
  // paragraph. It is the mutation prover, not this run, that establishes its
  // non-vacuity.
  // NOT claiming project ordering is stable or specified, and NOT a general fix
  // for encodeCwd collisions (two local, or two remote, places that collide
  // still resolve by listProjects() order).
  test('T5: a session-root answer never loses to a raw remote-tree answer, either ordering', async () => {
    const remote = await bindRemoteSystem();

    // (a)+(b): 'app' (remote) sorts before 'twin' (local), and both name the
    // same path — the remote's systemPath IS twin's real tree.
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    assert.equal((await adoptProject('twin', tree, {})).ok, true);
    assert.equal((await getProject('twin')).path, tree, 'twin really is at the remote place\'s path');

    const localSid = '99999999-8888-4777-8666-555555555555';
    await seedSessionJsonl(claudeProjectsRoot, tree, localSid);
    assert.deepEqual(await findSessionLocation(localSid),
      { project: 'twin', worktreeName: null, cwd: tree }, 'a: the local owner wins');

    const s = await retiredSession({ project: 'app' });
    assert.deepEqual(await findSessionLocation(s.sessionId),
      { project: 'app', worktreeName: null, cwd: s.cwd }, 'b: the remote session still resolves');

    // (c) CONTROL, the other ordering: 'aaa' (local) sorts before 'zzz' (remote).
    const tree2 = await seedRepo(path.join(remote.root, 'other'));
    assert.equal((await adoptProject('zzz', tree2, { system: remote.id })).ok, true);
    assert.equal((await adoptProject('aaa', tree2, {})).ok, true);
    const localSid2 = '77777777-6666-4555-8444-333333333333';
    await seedSessionJsonl(claudeProjectsRoot, tree2, localSid2);
    assert.deepEqual(await findSessionLocation(localSid2),
      { project: 'aaa', worktreeName: null, cwd: tree2 }, 'c: same answer with the local place first');
    const s2 = await retiredSession({ project: 'zzz' });
    assert.deepEqual(await findSessionLocation(s2.sessionId),
      { project: 'zzz', worktreeName: null, cwd: s2.cwd }, 'c: and the remote session still resolves');
  });

  // ── T6 ──────────────────────────────────────────────────────────────
  // PINS: the RE-PLACEMENT state survives — a project adopted locally at P that
  // accrued sessions in that tree, was unregistered, and was re-adopted on a
  // system whose path is also P, still resolves those older sessions to itself.
  // Nothing but the raw remote-tree probe finds them, so this is the test that
  // forbids deleting pass 2.
  // NOT claiming the state is supported, or reachable by mutating a placement
  // in place (no route does that) — only that unregister-then-re-register
  // reaches it.
  test('T6: an old local session survives the project being re-placed onto a system', async () => {
    const remote = await bindRemoteSystem();
    // P is OUTSIDE the projects root and on the reference provider's own path
    // space (which is this machine), so one string names both placements.
    const tree = await seedRepo(path.join(remote.root, 'shared'));
    assert.equal((await adoptProject('shared', tree, {})).ok, true);
    const oldSid = 'bbbbbbbb-2222-4222-8222-222222222222';
    await seedSessionJsonl(claudeProjectsRoot, tree, oldSid);
    assert.deepEqual(await findSessionLocation(oldSid),
      { project: 'shared', worktreeName: null, cwd: tree });

    const del = await api(baseUrl, 'DELETE', '/api/projects/shared');
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await adoptProject('shared', tree, { system: remote.id })).ok, true);

    assert.deepEqual(await findSessionLocation(oldSid),
      { project: 'shared', worktreeName: null, cwd: tree },
      'the old local transcript is still this project\'s, found by the fallback pass');
  });

  // ── T7 ──────────────────────────────────────────────────────────────
  // PINS: the two consuming READ sites read the transcript that exists rather
  // than an empty directory on the other machine — MCP get_transcript serves
  // events, and GET /summary's staleness count is the real message count.
  // NOT claiming POST /summary generates a good summary (that spawns `claude`);
  // the fixture pins only that the transcript is reachable.
  test('T7: get_transcript and the summary staleness count read the right cwd', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    const s = await retiredSession({ project: 'app' });

    const body = await callTool('get_transcript', { sessionId: s.sessionId });
    assert.ok(body.result && !body.error, JSON.stringify(body));
    const t = unwrap(body);
    assert.equal(t.source, 'disk', JSON.stringify(t));
    assert.ok(t.events.length >= 1, `expected >= 1 event, got ${t.events.length}`);

    // The seeded transcript holds exactly 2 messages, so a stored tier at 1 is
    // stale and one at 2 is not. Asserting BOTH pins the count exactly, where
    // one arm alone would pass for any count above (or below) the pair.
    await setSummary(s.sessionId, 'short', { summary: 'x', generatedAt: Date.now(), messageCount: 1 });
    await setSummary(s.sessionId, 'medium', { summary: 'y', generatedAt: Date.now(), messageCount: 2 });
    const g = await api(baseUrl, 'GET', `/api/sessions/${s.sessionId}/summary`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.data.short.isStale, true);
    assert.equal(g.body.data.medium.isStale, false);
  });

  // ── T8 ──────────────────────────────────────────────────────────────
  // PINS: a session whose system is UNREACHABLE resolves from local geometry
  // alone. (a) the bare resume refuses 501 NAMING THE BOX instead of the
  // indistinguishable `400 project required`; (b) the transcript read succeeds,
  // because it needs only local bytes and nothing has to be resurrected.
  // NOT claiming the box is probed or that its state is known — the point is
  // that nothing contacts it — and NOT that a spawn there could succeed.
  test('T8: an unreachable system refuses by name on resume and still serves the read', async () => {
    // A project record naming a system with no registry row at all: the probe's
    // inputs (listProjects, the worktree store, sessionRootPath, mirrorOffsets)
    // are all local, so it can still answer.
    const dir = projectStoreDir('beta');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ system: 'prod-box', systemPath: '/app' }));

    const imageRoot = sessionRootPath('prod-box', 'beta', null);
    await fs.mkdir(imageRoot, { recursive: true });
    const cwd = await fs.realpath(imageRoot);
    const sid = '11111111-2222-4333-8444-555555555555';
    await seedSessionJsonl(claudeProjectsRoot, cwd, sid);

    assert.deepEqual(await findSessionLocation(sid), { project: 'beta', worktreeName: null, cwd });

    const r = await api(baseUrl, 'POST', '/api/instances', { resume: sid });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(String(r.body.error), /prod-box/);

    const body = await callTool('get_transcript', { sessionId: sid });
    assert.ok(body.result && !body.error, JSON.stringify(body));
    const t = unwrap(body);
    assert.equal(t.source, 'disk');
    assert.ok(t.events.length >= 1, `expected >= 1 event, got ${t.events.length}`);
  });

  // ── T9 ──────────────────────────────────────────────────────────────
  // PINS: the answer carries the cwd the transcript was ACTUALLY found at, not
  // a re-derivation — for a remote session that is the instance's own cwd,
  // never the project's tree path on the system.
  // NOT claiming `cwd` is exposed anywhere on the wire (T12 pins that it is not).
  test('T9: the hit carries the cwd the transcript was found at', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    const s = await retiredSession({ project: 'app' });

    const hit = await findSessionLocation(s.sessionId);
    assert.equal(hit.cwd, s.cwd);
    assert.notEqual(hit.cwd, (await getProject('app')).path);
  });

  // ── T10 ─────────────────────────────────────────────────────────────
  // CONTROL. PINS: a session on a LOCAL project and one on a
  // LOCAL worktree resolve to the same {project, worktreeName} as before, with
  // `cwd` equal to the tree path the two old derivations returned — so the new
  // required field and the derivation it replaced AGREE, rather than that being
  // a paragraph a future editor can contradict. Third arm: a genuinely unknown
  // id still gets the literal `400 {"error":"project required"}`.
  // Scoped to sessions on LOCAL projects.
  test('T10: CONTROL — local project and local worktree sessions are unchanged', async () => {
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'host' })).status, 201);
    const projPath = (await getProject('host')).path;
    const p = await retiredSession({ project: 'host' });
    assert.deepEqual(await findSessionLocation(p.sessionId),
      { project: 'host', worktreeName: null, cwd: projPath });

    // A worktree branches off HEAD, so the project needs a first commit.
    await seedRepo(projPath);
    const wt = await createWorktree('host', { name: 'wt1' });
    const w = await retiredSession({ project: 'host', worktree: wt.worktreeName });
    assert.deepEqual(await findSessionLocation(w.sessionId),
      { project: 'host', worktreeName: wt.worktreeName, cwd: (await getWorktree('host', wt.worktreeName)).worktreePath });

    const r = await api(baseUrl, 'POST', '/api/instances', { resume: UNKNOWN_ID });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'project required' });
  });

  // ── T11 ─────────────────────────────────────────────────────────────
  // CONTROL. PINS: a hit that came from the READ-TOLERANCE
  // lineage loop — current segment's jsonl gone, an older one surviving —
  // reports the older segment's directory, which for a local project is the
  // project's own tree path: byte-identical to what the deleted derivation
  // returned. NOT a claim about a remote lineage split across two geometries.
  test('T11: CONTROL — a lineage hit on an older segment reports the project tree', async () => {
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'host' })).status, 201);
    const projPath = (await getProject('host')).path;
    const older = 'aaaaaaaa-1111-4111-8111-111111111111';
    const newer = 'cccccccc-3333-4333-8333-333333333333';
    // A renew takes the lineage to two segments and advances `current`, so the
    // lookup resolves to `newer` and only the loop can reach `older`.
    await recordRotation(older, newer, 'renew');
    await seedSessionJsonl(claudeProjectsRoot, projPath, older);

    assert.deepEqual(await findSessionLocation(older),
      { project: 'host', worktreeName: null, cwd: projPath });
  });

  // ── T12 ─────────────────────────────────────────────────────────────
  // PINS: GET /locate 200s for a
  // remote session and its body is EXACTLY {project, worktreeName, archived} —
  // deepEqual, so the internal `cwd` leaking into it fails here. The local
  // surface is already forbidden the same leak by the existing deepEqual in
  // tests/projects.test.mjs.
  // NOT claiming field ordering is contractual.
  test('T12: GET /locate on a remote session 200s and leaks no cwd', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    const s = await retiredSession({ project: 'app' });

    const r = await api(baseUrl, 'GET', `/api/sessions/${s.sessionId}/locate`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { project: 'app', worktreeName: null, archived: false });
  });
});
