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
// SAME-MACHINE TRAP. The reference provider IS this machine, so a project tree
// always lives under an `mkdtemp` prefix OUTSIDE `PROJECTS_ROOT`: any code that
// composes a path from `projectsRoot()` lands where the tree is not, and an
// assertion fails instead of accidentally succeeding. On top of that, T1–T4
// resolve the expected location from `sessionRootPath` INDEPENDENTLY of the
// instance that produced it, so a cwd composed against the project rather than
// the image root gives a different answer instead of agreeing by accident. The
// rest (T5(b), T6, T7, T8, T9, T12) assert against the instance's own `cwd` or
// against the tree path directly — they are about which PLACE answers and what
// the answer is used for, not about how the geometry is composed.
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
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { bindRemoteSystem, referenceLaunch, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import {
  adoptProject, findSessionLocation, getProject, projectStoreDir,
} from '../src/projects.ts';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.ts';
import { getWorktree, createWorktree } from '../src/worktrees.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';
import { setSummary } from '../src/sessionSummaries.ts';
import { recordRotation } from '../src/sessionLineage.ts';

// A UUID nothing on this host answers to. The pre-fix refusal for a session on
// a system was byte-identical to this one's, which is why the fix is about
// distinguishability and not only about resume.
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SUMMARIZE = path.join(HERE, 'fake-claude-summarize.mjs');
// The passthrough that appends every CLIENT frame cc sends to a file — the only
// honest evidence for a claim about a frame cc must NOT emit (T13).
const RECORDER = path.join(HERE, 'fixtures', 'recordingProvider.mjs');

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

  // Every CLIENT frame the recording provider has seen since the file was last
  // truncated. Absent file reads as none — the recorder appends, never creates
  // eagerly.
  async function wireFrames(file) {
    let raw = '';
    try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  }

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
  // fixture with the names swapped so the LOCAL place sorts first, and it is
  // NOT a green-on-arrival control: its first assertion holds on the shipped
  // code (the local place already sorted first there) but its second is
  // behaviourally red — the remote session resolved to `null`. Both arms carry
  // the same invariant, that the answer does not depend on the ordering, and
  // neither is redundant: with the passes inverted, arm (c)'s first assertion
  // returns `zzz` instead of `aaa`.
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

    // (c) the other ordering: 'aaa' (local) sorts before 'zzz' (remote).
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
  // PINS: all THREE consuming READ sites read the transcript that exists rather
  // than an empty directory on the other machine — MCP get_transcript serves
  // events, GET /summary's staleness count is the real message count, and
  // POST /summary 200s where it used to 500 (`flattenTranscript` throws at the
  // remote tree path with no `statusCode`, so the route surfaced a 500; today
  // it 404s because nothing locates at all). POST is exercised through the real
  // route with `CLAUDE_BIN` pointed at tests/fake-claude-summarize.mjs, the
  // same device tests/session-summaries.test.mjs uses — an earlier draft of
  // this file omitted the arm claiming it "spawns `claude`", which was FALSE
  // and left one of the two sites §3.3 exists to fix undiscriminated.
  // NOT claiming the generated summary TEXT is good: the fake binary owns that,
  // and what is pinned here is the status and the message count the route read
  // off the transcript.
  test('T7: get_transcript and both summary routes read the right cwd', async () => {
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

    // POST: the site whose cwd used to come from getWorktree/getProject. It has
    // to reach the transcript to count anything, so `messageCount === 2` is the
    // discriminating assertion — the remote tree path yields a throw, not a 2.
    const origBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
    try {
      const post = await api(baseUrl, 'POST', `/api/sessions/${s.sessionId}/summary`, { length: 'long' });
      assert.equal(post.status, 200, JSON.stringify(post.body));
      assert.equal(post.body.data.long.messageCount, 2, JSON.stringify(post.body.data.long));
    } finally {
      if (origBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = origBin;
    }
  });

  // ── T8 ──────────────────────────────────────────────────────────────
  // PINS: a session on a system cc cannot run anything on still RESOLVES, so
  // (a) the bare resume refuses 501 NAMING THE BOX instead of the
  // indistinguishable `400 project required`, and (b) the transcript read
  // SUCCEEDS, because the bytes it wants are on cc's own disk.
  // THE STATE IS A USER-REACHABLE ONE: arm (a)/(b) clear a registered row's
  // launch command, which `updateSystem` supports explicitly ("an explicit null
  // clears it"). Arm (c) keeps the record-names-an-unregistered-system variant
  // as defence in depth, and it is deliberately second — a user cannot reach it,
  // because deleting a system row is refused while a project references it.
  // NOT claiming the probe avoids contacting the box: composing a place walks
  // each project's worktree store THROUGH its system and swallows the failure.
  // What is claimed is that no ANSWER here needs the box. NOT claiming a spawn
  // there could succeed.
  test('T8: a system cc cannot reach refuses the resume by name and still serves the read', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    const s = await retiredSession({ project: 'app' });

    // (a)+(b): the row keeps its project and its session root; it just has no
    // provider command any more, which is what a user does in Settings → Systems.
    assert.ok(await updateSystem(remote.id, { launch: null }));
    disposeSystemHandles();
    assert.deepEqual(await findSessionLocation(s.sessionId),
      { project: 'app', worktreeName: null, cwd: s.cwd });

    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(String(r.body.error), new RegExp(remote.id));

    const t = unwrap(await callTool('get_transcript', { sessionId: s.sessionId }));
    assert.equal(t.source, 'disk', JSON.stringify(t));
    assert.ok(t.events.length >= 1, `expected >= 1 event, got ${t.events.length}`);

    // (c) defence in depth: a record naming a system with NO registry row.
    const dir = projectStoreDir('beta');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ system: 'prod-box', systemPath: '/app' }));
    const imageRoot = sessionRootPath('prod-box', 'beta', null);
    await fs.mkdir(imageRoot, { recursive: true });
    const cwd = await fs.realpath(imageRoot);
    const sid = '11111111-2222-4333-8444-555555555555';
    await seedSessionJsonl(claudeProjectsRoot, cwd, sid);

    assert.deepEqual(await findSessionLocation(sid), { project: 'beta', worktreeName: null, cwd });
    const r2 = await api(baseUrl, 'POST', '/api/instances', { resume: sid });
    assert.equal(r2.status, 501, JSON.stringify(r2.body));
    assert.match(String(r2.body.error), /prod-box/);
    const t2 = unwrap(await callTool('get_transcript', { sessionId: sid }));
    assert.equal(t2.source, 'disk', JSON.stringify(t2));
    assert.ok(t2.events.length >= 1, `expected >= 1 event, got ${t2.events.length}`);
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

  // ── T13 ─────────────────────────────────────────────────────────────
  // PINS: a lookup does NO WORK for a place ordered after the one that answers
  // in pass 1 — measured ON THE WIRE, because that is the only honest evidence
  // for a frame cc must not send. Composing a project's worktree places calls
  // listWorktrees, which resolves the project and runs `git worktree list`
  // THROUGH its system, so an eagerly-built place list contacts every
  // registered remote system on every lookup — and `runGit` passes no
  // `timeoutMs`, so one wedged provider would stall every locate, transcript
  // read, summary and bare resume up to the provider operation timeout.
  // Arm (b) is not decoration: without it arm (a) would also pass if the
  // recorder never recorded anything at all.
  // NOT a claim about what the ANSWER needs from the box (nothing — a separate
  // property), and NOT a timing claim: this says nothing about how long an
  // unreachable or wedged system takes. It is only about WHICH places a lookup
  // composes, which is the thing that decides whether the box is reached at all.
  test('T13: a pass-1 hit composes no place ordered after it, measured on the wire', async () => {
    // 'early' answers; 'zzz' sorts after it and is the one that must stay
    // untouched. Its provider is the recorder, so any contact leaves bytes.
    const early = await bindRemoteSystem({ id: 'early' });
    const rec = path.join(await mkdtemp('cc-0292-rec-'), 'frames.jsonl');
    await addSystem({ id: 'later', label: 'later', launch: ['node', RECORDER, '--record', rec] });

    const earlyTree = await seedRepo(path.join(early.root, 'aaa'));
    assert.equal((await adoptProject('aaa', earlyTree, { system: early.id })).ok, true);
    const laterTree = await seedRepo(path.join(early.root, 'zzz'));
    assert.equal((await adoptProject('zzz', laterTree, { system: 'later' })).ok, true);

    // Seed the session directly at 'aaa's session root rather than through the
    // spawn route: a route call broadcasts, and plugin discovery resolves every
    // project off that broadcast, which would put frames on the wire this test
    // cannot attribute.
    const imageRoot = sessionRootPath(early.id, 'aaa', null);
    await fs.mkdir(imageRoot, { recursive: true });
    const cwd = await fs.realpath(imageRoot);
    const sid = 'eeeeeeee-1111-4111-8111-aaaaaaaaaaaa';
    await seedSessionJsonl(claudeProjectsRoot, cwd, sid);

    // Everything above has already talked to both boxes. Start the recording
    // from empty, so what follows is attributable to the lookup alone.
    await fs.writeFile(rec, '');

    // (a) the hit is at 'aaa's own root — the first place in probe order.
    assert.deepEqual(await findSessionLocation(sid), { project: 'aaa', worktreeName: null, cwd });
    assert.deepEqual(await wireFrames(rec), [],
      'a pass-1 hit must not compose a place ordered after it, and composing one talks to its system');

    // (b) a MISS enumerates everything, so the recorder does see frames — which
    // is what makes (a)'s empty transcript evidence rather than a dead fixture.
    assert.equal(await findSessionLocation(UNKNOWN_ID), null);
    assert.ok((await wireFrames(rec)).length >= 1,
      'a full miss composes every place, so the later system IS contacted');
  });
});
