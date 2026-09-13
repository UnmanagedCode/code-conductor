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
// same refusal a typo'd UUID gets.
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
// T8's arm (c) and T13 resolve their expected location the same way, from
// `sessionRootPath` with no instance in play. T5(b), T6, T7, T8's arms (a)/(b)
// and T9 assert against the instance's own `cwd` or against the tree path
// directly, and T12 asserts no cwd at all — those are about which PLACE answers
// and what the answer is used for, not about how the geometry is composed.
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
import { bindRemoteSystem, flakyLaunch, referenceLaunch, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import {
  adoptProject, findSessionLocation, getProject, projectStoreDir,
} from '../src/projects.ts';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.ts';
import { getWorktree, createWorktree } from '../src/worktrees.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
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
  // `_doCreateResolved`. The MCP arm is here because it is the form under test,
  // and it shares this test's killer set rather than adding one.
  test('T1: a bare resume with no project recovers it, on both surfaces', async () => {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);

    const a = await retiredSession({ project: 'app' });
    // The project's own path ON THE SYSTEM — resolved from the fixture rather
    // than read off the instance, so a cwd composed anywhere else would differ
    // here instead of agreeing by construction.
    const imageRoot = tree;
    assert.equal(a.cwd, imageRoot, "the session ran at the project's path on its system");

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
  // PINS: a WIDER mirror root does not move the session. A cwd of the local
  // image root plus the project's offset inside it would let the advertisement
  // decide the answer; the cwd is the project's own path, which no
  // advertisement addresses, and the locator has one candidate.
  test('T2: a wider mirror root leaves the session at the project path, and it still resolves', async () => {
    const w = await wideSystem(path.join('nest', 'app'));
    assert.equal((await adoptProject('app', w.tree, { system: w.id })).ok, true);

    const s = await retiredSession({ project: 'app' });
    assert.equal(s.cwd, w.tree, 'a wide mirror root moved the cwd');

    const hit = await findSessionLocation(s.sessionId);
    assert.deepEqual(hit, { project: 'app', worktreeName: null, cwd: s.cwd });
    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id).cwd, s.cwd);
  });

  // ── T3 ──────────────────────────────────────────────────────────────
  // PINS: a session on a remote project's WORKTREE resolves with worktreeName
  // recovered, at THAT WORKTREE'S own path on the system — which is a sibling of
  // the project's, not a path under it, so an answer built from the project's
  // path alone could not produce it.
  test('T3: a remote worktree session recovers its worktree and its own path', async () => {
    const w = await wideSystem(path.join('nest', 'app'));
    assert.equal((await adoptProject('app', w.tree, { system: w.id })).ok, true);
    const wt = await createWorktree('app', { name: 'wt1' });
    const wtName = wt.worktreeName;
    assert.notEqual(wt.worktreePath, w.tree);

    const s = await retiredSession({ project: 'app', worktree: wtName });
    assert.equal(s.cwd, wt.worktreePath);

    assert.deepEqual(await findSessionLocation(s.sessionId),
      { project: 'app', worktreeName: wtName, cwd: s.cwd });
    const r = await api(baseUrl, 'POST', '/api/instances', { resume: s.sessionId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.get(r.body.id).cwd, s.cwd);
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
  // POST /summary 200s where the pre-fix route returned a clean 404 — and where
  // a PROBE-ONLY widening would have 500'd, `flattenTranscript` throwing at the
  // tree path with no `statusCode`. That 500 is the counterfactual the widening's
  // scope exists to avoid, never shipped behaviour. POST is exercised through the real
  // route with `CLAUDE_BIN` pointed at tests/fake-claude-summarize.mjs, the
  // same device tests/session-summaries.test.mjs uses — omitting the arm on the
  // grounds that it "spawns `claude`" would be FALSE
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

    // POST: the site whose cwd must not come from getWorktree/getProject. It
    // has to reach the transcript to count anything, so `messageCount === 2` is
    // the discriminating assertion — the remote tree path yields a throw, not a 2.
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
  // NOT claiming the probe avoids the box, and NOT claiming a box that is down
  // cannot change the answer — it can. What the lookup needs from the box is
  // one contract with one home, on `findSessionLocation` (src/projects.ts);
  // this header does not restate it. What IS claimed here is narrower: a box
  // that cannot run anything still leaves this session locatable and readable.
  // Arm (d) is the THIRD refusal shape — a provider that answers the handshake
  // and dies on its first operation, which gets past resolution and refuses
  // 502 inside the session-root compose instead.
  // NOT claiming a spawn there could succeed.
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
    // The record's OWN systemPath is the cwd now — no local image to compose,
    // and no registry row needed to derive it.
    const cwd = '/app';
    const sid = '11111111-2222-4333-8444-555555555555';
    await seedSessionJsonl(claudeProjectsRoot, cwd, sid);

    assert.deepEqual(await findSessionLocation(sid), { project: 'beta', worktreeName: null, cwd });
    const r2 = await api(baseUrl, 'POST', '/api/instances', { resume: sid });
    assert.equal(r2.status, 501, JSON.stringify(r2.body));
    assert.match(String(r2.body.error), /prod-box/);
    const t2 = unwrap(await callTool('get_transcript', { sessionId: sid }));
    assert.equal(t2.source, 'disk', JSON.stringify(t2));
    assert.ok(t2.events.length >= 1, `expected >= 1 event, got ${t2.events.length}`);

    // (d) A ROW WHOSE PROVIDER ANSWERS THE HANDSHAKE AND THEN DIES ON ITS FIRST
    // OPERATION. NOTHING TOUCHES THE BOX AT CREATE — there is no session root
    // to compose and the mirror advertisement is capability-gated — so the
    // create SUCCEEDS rather than refusing 502, and the box's death surfaces at
    // the first operation that needs it. The read still works either way, which is what this arm has
    // always really been about.
    const dead = await bindRemoteSystem({ id: 'deadbox' });
    const deadTree = await seedRepo(path.join(dead.root, 'gamma'));
    assert.equal((await adoptProject('gamma', deadTree, { system: 'deadbox' })).ok, true);
    const g = await retiredSession({ project: 'gamma' });
    // Swapped AFTER the adopt and the spawn, which both need a live box. The
    // budget is per provider PROCESS, so verifySystemLaunch's throwaway probe
    // does not spend the handle's.
    assert.ok(await updateSystem('deadbox', { launch: flakyLaunch({ budget: 0 }) }));
    disposeSystemHandles();

    const r3 = await api(baseUrl, 'POST', '/api/instances', { resume: g.sessionId });
    assert.equal(r3.status, 201, JSON.stringify(r3.body));
    // The resume resolved to the project's own path on the dead box — the
    // resolution never needed the box, which is why it still answers.
    assert.equal(instances.get(r3.body.id).cwd, deadTree);
    const t3 = unwrap(await callTool('get_transcript', { sessionId: g.sessionId }));
    assert.equal(t3.source, 'disk', JSON.stringify(t3));
    assert.ok(t3.events.length >= 1, `expected >= 1 event, got ${t3.events.length}`);
  });

  // ── T13 ─────────────────────────────────────────────────────────────
  // PINS: THE LOOKUP STOPS CONTACTING SYSTEMS ONCE IT HAS A HIT. That laziness
  // is live in `findSessionLocation` and is not a micro-optimisation — composing
  // a project's worktree places runs `git worktree list` THROUGH its system, so
  // an eager sweep would stall on a wedged provider and change its answer on a
  // down one, for a session it had already located.
  //
  // Restored after the geometry retirement: the pass-1/pass-2 precedence this
  // arm once shared a file with is genuinely gone, but this claim is not, and it
  // had lost its only guard.
  //
  // Measured ON THE WIRE, because "no contact" is not observable any other way.
  test('T13: a hit contacts no system ordered after it, measured on the wire', async () => {
    // 'aaa' answers at its own path and has a registered remote WORKTREE whose
    // place is ordered after that root; 'zzz' sorts after 'aaa' entirely. BOTH
    // systems are the recorder and BOTH write to ONE file, so "no contact for
    // anything ordered after the answer" is a single empty transcript.
    const box = await mkdtemp('cc-0292-box-');
    const rec = path.join(await mkdtemp('cc-0292-rec-'), 'frames.jsonl');
    await addSystem({ id: 'aaabox', label: 'aaabox', launch: ['node', RECORDER, '--record', rec] });
    await addSystem({ id: 'zzzbox', label: 'zzzbox', launch: ['node', RECORDER, '--record', rec] });

    const hitTree = await seedRepo(path.join(box, 'aaa'));
    assert.equal((await adoptProject('aaa', hitTree, { system: 'aaabox' })).ok, true);
    const wt = await createWorktree('aaa', { name: 'wt1' });
    const laterTree = await seedRepo(path.join(box, 'zzz'));
    assert.equal((await adoptProject('zzz', laterTree, { system: 'zzzbox' })).ok, true);
    // The worktree place ordered after 'aaa's root really EXISTS — otherwise
    // arm (a) would be vacuous in the "there was nothing after it" sense.
    assert.ok(await getWorktree('aaa', wt.worktreeName));

    // Seeded directly at 'aaa's cwd rather than through the spawn route: a route
    // call broadcasts, and plugin discovery resolves every project off that
    // broadcast, putting frames on the wire this test cannot attribute.
    const cwd = hitTree;
    const sid = 'eeeeeeee-1111-4111-8111-aaaaaaaaaaaa';
    await seedSessionJsonl(claudeProjectsRoot, cwd, sid);

    // Everything above has already talked to both boxes. Start the recording
    // from empty, so what follows is attributable to the lookup alone.
    await fs.writeFile(rec, '');

    // (a) the hit is at 'aaa's own path — the first place in probe order.
    assert.deepEqual(await findSessionLocation(sid), { project: 'aaa', worktreeName: null, cwd });
    assert.deepEqual(await wireFrames(rec), [],
      "a hit must contact no system ordered after it — not the hit project's own "
      + 'worktree walk, and not a later project at all');

    // (b) THE CONTROL. A miss enumerates everything, so BOTH the hit project's
    // worktree walk and the later project reach their boxes. Asserting each
    // shows up SEPARATELY is what makes each half of (a)'s zero evidence rather
    // than a dead fixture. `cwd` is the attributable field: `listWorktrees` runs
    // git in the PROJECT's directory.
    assert.equal(await findSessionLocation(UNKNOWN_ID), null);
    const cwds = new Set((await wireFrames(rec)).map(f => f.cwd));
    assert.ok(cwds.has(hitTree),
      `a full miss walks the HIT project's worktrees on its own box; cwds: ${[...cwds]}`);
    assert.ok(cwds.has(laterTree),
      `a full miss composes the LATER project too; cwds: ${[...cwds]}`);
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
    // And that cwd IS the project's registered path — the two differ only where
    // the session runs in a local image of the tree, so their agreeing is
    // criterion 8 read off the locator.
    assert.equal(hit.cwd, (await getProject('app')).path);
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
