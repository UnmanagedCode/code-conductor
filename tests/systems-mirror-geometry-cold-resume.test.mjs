// A COLD RESUME FOLLOWING A MIRROR ADVERTISEMENT THAT MOVED WHILE CC WAS DOWN.
//
// Card 2026-0279 made a RELAUNCH IN PLACE follow a geometry that moved:
// `Instance._refreshSessionRoot` → `_followGeometry`, with an Instance already
// in hand whose `cwd` is the thing that is wrong. This file owns the other
// entry point — the CREATE path, where there is no instance at all:
// `InstanceManager._doCreateResolved` composes the session root, takes `cwd`
// from that compose, and the session's transcript is still at the geometry the
// session last ran at. Two callers reach it: `POST /api/instances {resume}`
// (T9), and `restoreFromResumeManifest` on boot after an orchestrator restart
// (everything else here). Un-followed, a provider that changes its mirror
// advertisement while cc is down leaves that session un-resumable
// (card 2026-0287).
//
// THE PRIOR CWD IS DERIVED PER SESSION, NEVER FROM THE MANIFEST — and T2 is
// the test that says so. The `.manifest.json` sidecar is shared by every
// session on one `(system, project, worktree)`, and the first create after a
// move rewrites it, so a manifest-derived prior cwd recovers ONE session per
// image root and strands every later one permanently. T2 therefore asserts
// `restored === 2` and never `>= 1`: `>= 1` is exactly what a manifest
// derivation passes.
//
// THE GEOMETRY CLASS IS NOT THE DISCRIMINATOR HERE, unlike on 0279's relaunch
// path, where `offset_old === ''` divides a surviving old cwd from a deleted
// one. The CLI's transcripts do not live in the cwd — they live under
// `claudeProjectsRoot()/<encodeCwd(cwd)>/`, which `resetRoot` never touches —
// so T1 (widening from an empty offset) and T4 (narrowing into one, old cwd
// deleted) take one code path and assert one outcome. T4 pins the old cwd
// really is gone, so the two classes are both covered rather than assumed
// equivalent.
//
// THREE HARNESS FACTS THESE TESTS DEPEND ON.
//  1. NO `realProcess`. The pre-flight, the recovery and its refusal all run
//     before `spawn()`, so the in-process launcher is enough — which also keeps
//     this file clear of card 2026-0286's post-spawn-failure kill hang.
//  2. The restart is modelled as the production sequence: `drainToManifest`
//     (writes the manifest, closes the subprocesses) → `instances.byId.clear()`
//     (the new process has no instances) → `readvertise` → `restoreFromResumeManifest`.
//     That loop swallows every per-entry failure into `log.warn`, so a capturing
//     log is passed and the assertions are on `{restored}` plus the captured
//     warnings — never on a thrown error.
//  3. `readvertise` asserts the connection generation really changed: cc
//     memoises `describeRemote` per generation, so an advertisement that changes
//     without a provider restart changes nothing.
//
// SAME-MACHINE TRAP, GUARDED TWO WAYS, as in tests/systems-mirror-geometry-follow.test.mjs.
// The reference provider IS this machine, so every location check resolves the
// cc-owned IMAGE ROOT through `sessionRootPath` independently of any instance,
// the project tree lives under an `mkdtemp` prefix OUTSIDE `PROJECTS_ROOT`, and
// every content check is for `SENTINEL-0287` — a byte string written only into
// the project tree's CLAUDE.md on the "system".

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, sessionFilePath, subAgentDirPath } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';
import { drainToManifest, restoreFromResumeManifest } from '../src/resumeRestart.ts';
import { recordRotation } from '../src/sessionLineage.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');
// A child that stays up and never takes a turn: nothing here drives one.
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');
const SENTINEL = 'SENTINEL-0287';

describe('a cold resume after a mirror advertisement moved', () => {
  let ctx, baseUrl, instances, home, claudeProjectsRoot;
  let n = 0;

  before(async () => {
    ctx = await bootServer({ scenarioPath: SCENARIO });
    ({ baseUrl, instances } = ctx);
  });
  after(async () => { if (ctx) await ctx.close(); });

  // A fresh store per test: the resume manifest, the settings registry and the
  // session roots all hang off PROJECTS_ROOT, and a drain reads EVERY live
  // instance — so one test's leftovers would land in another's manifest.
  beforeEach(async () => { ({ home, claudeProjectsRoot } = await freshProjectsRoot()); });
  afterEach(async () => {
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  const exists = (p) => fs.stat(p).then(() => true, () => false);

  // One fixture per test: its own system id, its own project, its own box
  // outside PROJECTS_ROOT, and one live session on it. `sub` is where the
  // project sits inside the box; `mirror` is the FIRST advertisement, where ''
  // means "advertise nothing" (the project-anchored geometry, offset '').
  async function fixture({ sub, mirror }) {
    const id = `movable${++n}`;
    const project = `app${n}`;
    const box = await mkdtemp('cc-0287-');
    const projPath = path.join(box, sub);
    await seedRepo(projPath);
    // THE SENTINEL, on the system side only.
    await fs.writeFile(path.join(projPath, 'CLAUDE.md'), `# ${SENTINEL}\n`);

    const mirrorFile = path.join(box, '.mirror');
    const pidFile = path.join(box, '.pid');
    await fs.writeFile(mirrorFile, mirror === '' ? '' : path.join(box, mirror));
    await addSystem({
      id, label: id,
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile, '--pid-file', pidFile],
    });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);

    const inst = await spawnOne({ project });
    // Resolved from the module, NOT from the instance: a cwd computed against
    // the project instead of the image root would give a different answer here
    // rather than agreeing by accident.
    const imageRoot = await fs.realpath(sessionRootPath(id, project, null));
    // Captured now because the instance is dropped by every restart below,
    // while the handle (and its connection generation) is what `readvertise`
    // has to move.
    const system = inst._redirectPlacement.system;
    return { id, project, box, projPath, mirrorFile, system, inst, imageRoot };
  }

  async function spawnOne({ project }) {
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    return inst;
  }

  // End the provider's connection generation and start a new one that answers
  // differently. Only a new generation can move the geometry.
  async function readvertise(f, mirror) {
    await fs.writeFile(f.mirrorFile, mirror === '' ? '' : path.join(f.box, mirror));
    const generation = f.system.handshake;
    const gone = Number(await fs.readFile(path.join(f.box, '.pid'), 'utf8'));
    // The fixture IS the provider — one process, no child to orphan.
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    await waitFor(() => f.system.handshake === null);
    await f.system.connect();
    assert.notEqual(f.system.handshake, generation, 'a new connection generation really began');
  }

  // Steps 1–2 of the restart: drain every live session to the resume manifest,
  // then drop the instances the way a fresh process has none.
  async function drain({ expect } = {}) {
    const entries = await drainToManifest({
      server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 200,
    });
    if (expect !== undefined) assert.equal(entries.length, expect, 'the drain did not capture every session');
    await waitFor(() => [...instances.byId.values()].every(i => i.proc === null));
    instances.byId.clear();
    return entries;
  }

  // Step 3: the boot restore, with its warnings captured rather than thrown —
  // `restoreFromResumeManifest` folds every per-entry failure into log.warn.
  async function restore() {
    const warns = [];
    const { restored } = await restoreFromResumeManifest({
      instances,
      log: { log() {}, warn: (...a) => warns.push(a.map(String).join(' ')) },
      staggerMs: 0,
    });
    return { restored, warns, live: [...instances.byId.values()] };
  }

  const forSession = (r, sessionId) => r.live.find(i => i.sessionId === sessionId);

  // Everything the moving arms assert in common: the session came back at the
  // new geometry, its config surface is really this project's, its transcript
  // came with it and nothing was left at the old one, and the restore was
  // silent.
  async function assertFollowed(r, { sessionId, backingId, oldCwd, newCwd }) {
    assert.equal(r.restored >= 1, true, `nothing was restored: ${JSON.stringify(r.warns)}`);
    const inst = forSession(r, sessionId);
    assert.ok(inst, `session ${sessionId} was not restored: ${JSON.stringify(r.warns)}`);
    assert.equal(inst.cwd, newCwd, 'the restored session is not at the new geometry');
    assert.match(await fs.readFile(path.join(newCwd, 'CLAUDE.md'), 'utf8'), new RegExp(SENTINEL),
      'the config surface at the new cwd is not this project’s');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript did not come with it');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), false, 'the transcript was copied, not moved');
    assert.deepEqual(r.warns, [], `the restore warned: ${JSON.stringify(r.warns)}`);
    return inst;
  }

  // PINS: a cold resume through the production boot restore FOLLOWS a mirror
  // advertisement that widened while cc was down — the session comes back at
  // the composed cwd with its transcript relocated there and nothing left at
  // the geometry it last ran at.
  //
  // NOT CLAIMING that the real `claude` binary resumes the conversation: the
  // fake engine stands in, and what is pinned is that every input the CLI reads
  // is at the cwd cc hands it. `hasResumableConversation` mirrors the CLI's own
  // "No conversation found" criterion, which is what makes the 404→201
  // transition the whole measurement. NOT CLAIMING anything about the far-side
  // shell (it runs at the project path, which did not move).
  test('a cold resume after an orchestrator restart follows a mirror advertisement that moved', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, f.imageRoot, 'the first compose is the project-anchored one (offset "")');
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    await drain({ expect: 1 });
    await readvertise(f, '.');
    const r = await restore();

    const newCwd = path.join(f.imageRoot, 'proj');
    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    await assertFollowed(r, { sessionId, backingId, oldCwd, newCwd });
  });

  // PINS THE DESIGN: TWO sessions on ONE image root BOTH follow the move. The
  // manifest sidecar is shared per `(system, project, worktree)` and the first
  // create after a move rewrites it, so a prior cwd derived from it recovers
  // session #1 and derives the NEW cwd for session #2 — which then moves
  // nothing and, since the manifest never mismatches again, stays un-resumable
  // for good. `restored === 2` is therefore the assertion, and `>= 1` would be
  // the bug passing.
  //
  // NOT CLAIMING that the two sessions are restored in any particular order, or
  // that they share anything but the image root.
  test('TWO sessions on ONE image root both follow the move', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const a = { sessionId: f.inst.sessionId, backingId: f.inst.backingSessionId };
    const second = await spawnOne({ project: f.project });
    assert.equal(second.cwd, oldCwd, 'both sessions started at the same cwd');
    const b = { sessionId: second.sessionId, backingId: second.backingSessionId };
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, a.backingId);
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, b.backingId);

    await drain({ expect: 2 });
    await readvertise(f, '.');
    const r = await restore();

    const newCwd = path.join(f.imageRoot, 'proj');
    assert.equal(r.restored, 2, `not both sessions were restored: ${JSON.stringify(r.warns)}`);
    await assertFollowed(r, { ...a, oldCwd, newCwd });
    await assertFollowed(r, { ...b, oldCwd, newCwd });
  });

  // PINS: the WHOLE LINEAGE moves, not just the id the resume resolves to. A
  // renewed session's history is spread across its segments, and relocating
  // only the current backing id leaves the older one at the geometry the
  // session no longer runs at.
  //
  // NOT CLAIMING that a lineage already split across two DIFFERENT prior
  // geometries is reassembled — every id here starts at one source cwd.
  test('the whole lineage moves, not just the current backing id', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const sessionId = f.inst.sessionId, older = f.inst.backingSessionId;
    // A real renew takes the lineage to two segments and advances `current`, so
    // the resume resolves to the NEWER id and the scan looks for that one.
    const newer = '9746ee72-0000-4000-8000-00000000cccc';
    await recordRotation(sessionId, newer, 'renew');
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, older);
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, newer);

    await drain({ expect: 1 });
    await readvertise(f, '.');
    const r = await restore();

    const newCwd = path.join(f.imageRoot, 'proj');
    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    const inst = await assertFollowed(r, { sessionId, backingId: newer, oldCwd, newCwd });
    assert.equal(inst.backingSessionId, newer, 'the resume did not resolve to the newest segment');
    assert.equal(await exists(sessionFilePath(newCwd, older)), true, 'the older segment was left behind');
    assert.equal(await exists(sessionFilePath(oldCwd, older)), false, 'the older segment was copied, not moved');
  });

  // PINS: the geometry class is not the discriminator on this path. This
  // narrows into an empty offset, so `resetRoot` deletes the old cwd outright —
  // and the transcript still moves, because it never lived in the cwd. It is
  // also the arm where the candidate the scan must NOT stop on comes first: the
  // enumeration emits offset '' first, which here is the DESTINATION.
  //
  // NOT CLAIMING that a narrowing differs from T1's widening in any other
  // respect: they take one code path, and the point of this arm is that they do.
  test('the geometry class is not the discriminator: a narrowing move follows too', async () => {
    const f = await fixture({ sub: 'proj', mirror: '.' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, path.join(f.imageRoot, 'proj'), 'the first compose put the project one level in');
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    await drain({ expect: 1 });
    await readvertise(f, '');
    const r = await restore();

    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    await assertFollowed(r, { sessionId, backingId, oldCwd, newCwd: f.imageRoot });
    assert.equal(await exists(oldCwd), false, 'the old cwd really was deleted by the compose');
  });

  // CONTROL. Two composes that do NOT move the geometry, and a cold resume
  // across either must move nothing: an advertisement that did not change at
  // all, and a `remoteId`-only change — which invalidates the root and forces a
  // full re-pull at the SAME geometry.
  //
  // NOT THE ARM THAT PINS THE GATE. Neither of these can observe whether the
  // recovery ran, because the session's transcript IS at the composed cwd — so
  // a scan would hit `cwd` itself and a same-path relocation writes nothing.
  // The arm below ('the recovery runs only where the pre-flight already
  // refuses') is what discriminates.
  //
  // NOT CLAIMING that the re-pull is byte-identical, only that the session
  // comes back at its own cwd with its transcript untouched there.
  test('an unchanged geometry, and a remoteId-only change, move nothing', async () => {
    for (const arm of ['unchanged', 'remoteId']) {
      const f = await fixture({ sub: 'proj', mirror: '.' });
      const cwd = f.inst.cwd;
      const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
      await seedSessionJsonl(claudeProjectsRoot, cwd, backingId);

      await drain({ expect: 1 });
      if (arm === 'remoteId') {
        // Tamper the sidecar's recorded target, which is the OTHER half of the
        // check `mirrorRoot` rides on: the next compose wipes and re-pulls the
        // root at an unchanged geometry.
        const manifest = `${sessionRootPath(f.id, f.project, null)}.manifest.json`;
        const prior = JSON.parse(await fs.readFile(manifest, 'utf8'));
        await fs.writeFile(manifest, JSON.stringify({ ...prior, remoteId: 'some-other-target' }));
      }
      const r = await restore();

      assert.equal(r.restored, 1, `${arm}: ${JSON.stringify(r.warns)}`);
      const inst = forSession(r, sessionId);
      assert.equal(inst.cwd, cwd, `${arm}: the session moved`);
      assert.equal(await exists(sessionFilePath(cwd, backingId)), true,
        `${arm}: the transcript was relocated for nothing`);
      assert.equal(await exists(sessionFilePath(f.imageRoot, backingId)), cwd === f.imageRoot,
        `${arm}: a transcript appeared at another candidate cwd`);

      await instances.shutdown();
      disposeSystemHandles();
    }
  });

  // CONTROL, and two END STATES rather than two paths — the distinction matters
  // for what this can and cannot pin.
  //
  // (a) PINS the end state of the HEALTHY path: a resume whose conversation is
  // already at the composed cwd succeeds, its transcript is still there
  // afterwards, and an unrelated session's transcript at another candidate is
  // still at that candidate. It does NOT pin that the scan was skipped — the
  // pre-flight passes, so nothing below it runs and this arm cannot observe the
  // difference; the gate arm below is what can. Nor does its decoy discriminate
  // a WRONG scan: for that, see 'the scan matches THIS session' below.
  //
  // (b) PINS that the refusal survives intact when no candidate holds the
  // session at all: `restored === 0`, and the 404's message byte-for-byte what
  // it was — the recovery degrades to exactly today's behaviour rather than
  // replacing it.
  //
  // NOT CLAIMING that a session with no transcript is unusual: every session is
  // in that state until its first turn persists one.
  test('a session that was never at the prior geometry is not moved', async () => {
    // (a) the transcript is already at the geometry the compose produces.
    {
      const f = await fixture({ sub: 'proj', mirror: '' });
      const oldCwd = f.inst.cwd;
      const newCwd = path.join(f.imageRoot, 'proj');
      const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
      await seedSessionJsonl(claudeProjectsRoot, newCwd, backingId);
      // An unrelated session's transcript at the other candidate. This arm
      // only pins that it is still there afterwards — it cannot fail under a
      // scan that probes the wrong id, since the scan never runs here.
      const decoy = '9746ee72-0000-4000-8000-00000000dddd';
      await seedSessionJsonl(claudeProjectsRoot, oldCwd, decoy);

      await drain({ expect: 1 });
      await readvertise(f, '.');
      const r = await restore();

      assert.equal(r.restored, 1, JSON.stringify(r.warns));
      assert.equal(forSession(r, sessionId).cwd, newCwd);
      assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript was moved off its own cwd');
      assert.equal(await exists(sessionFilePath(oldCwd, decoy)), true, 'a peer transcript at another candidate was dragged along');
      assert.equal(await exists(sessionFilePath(newCwd, decoy)), false, 'a peer transcript at another candidate was dragged along');

      await instances.shutdown();
      disposeSystemHandles();
    }
    // (b) no transcript at any candidate: the refusal, and its message, survive.
    {
      const f = await fixture({ sub: 'proj', mirror: '' });
      const backingId = f.inst.backingSessionId;
      // Deliberately NO seedSessionJsonl.
      await drain({ expect: 1 });
      await readvertise(f, '.');
      const r = await restore();

      const newCwd = path.join(f.imageRoot, 'proj');
      assert.equal(r.restored, 0, 'a session with no conversation anywhere was resumed');
      assert.equal(r.warns.length, 1, JSON.stringify(r.warns));
      assert.match(r.warns[0], new RegExp(`no resumable conversation for session ${backingId} in ${newCwd}`),
        `the 404's message changed: ${r.warns[0]}`);
    }
  });

  // PINS THAT THE SCAN MATCHES **THIS SESSION**, not merely any resumable
  // conversation at a candidate — the discriminating arm the two controls above
  // cannot be. Three candidates, and the one holding this session is NOT the
  // first probed: a peer's transcript sits at the `''` candidate (which the
  // enumeration emits first), this session's sits two levels deeper, and the
  // composed cwd is neither.
  //
  // The state is reachable, not contrived: a peer that spawned while the
  // advertisement was `''` and was never relaunched keeps its transcript at the
  // image root, and this session then spawned under a wider advertisement. Only
  // the peer's jsonl is synthesized here — the fake engine writes none for
  // either session, so both had to be seeded whatever produced them.
  //
  // A probe that matched by cwd alone would take the peer's candidate as this
  // session's prior geometry, move nothing (this session has no files there),
  // and hand back a session with no conversation.
  //
  // GREEN ON ARRIVAL BY CONSTRUCTION: the shipped code already probes per id.
  // This arm exists so that a mutation can be seen, not because the behaviour
  // was ever wrong.
  //
  // NOT CLAIMING anything about the peer beyond its transcript staying put: it
  // is not a live session here, and nothing resumes it.
  test('the scan matches THIS session, not any conversation at a candidate', async () => {
    const f = await fixture({ sub: path.join('x', 'proj'), mirror: '.' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, path.join(f.imageRoot, 'x', 'proj'),
      'the first compose should put the project two levels in');
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);
    // THE PEER, at the candidate the enumeration probes FIRST.
    const peer = '9746ee72-0000-4000-8000-00000000aaaa';
    await seedSessionJsonl(claudeProjectsRoot, f.imageRoot, peer);

    await drain({ expect: 1 });
    await readvertise(f, 'x');
    const r = await restore();

    const newCwd = path.join(f.imageRoot, 'proj');
    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    await assertFollowed(r, { sessionId, backingId, oldCwd, newCwd });
    // The peer's transcript was neither taken as this session's source nor
    // dragged to the new geometry.
    assert.equal(await exists(sessionFilePath(f.imageRoot, peer)), true,
      'the peer’s transcript left the candidate it was at');
    assert.equal(await exists(sessionFilePath(newCwd, peer)), false,
      'the peer’s transcript was dragged to the new geometry');
  });

  // PINS THE GATE: the recovery runs ONLY where the pre-flight already refuses,
  // which is the arm every other test in this file is blind to. Where the
  // transcript IS at the composed cwd, an ungated scan would hit `cwd` itself
  // and a same-path relocation writes nothing — so the difference is
  // unobservable unless some OTHER candidate also answers to the id. This arm
  // makes one: a healthy resume with its live conversation at the composed cwd,
  // and a stale jsonl under the SAME id at the `''` candidate, which the
  // enumeration probes first.
  //
  // Gated, the scan never runs and the live transcript is untouched. Ungated,
  // the stale copy is renamed OVER it and the session comes back on the wrong
  // history — which is the failure mode the gate exists to exclude.
  //
  // THIS ARM ASSERTS NOTHING ABOUT THAT STALE STATE OCCURRING, and it is not
  // evidence of a defect. Neither the card's measurement pass nor this round's
  // review could construct it through any production path: both movers
  // relocate every segment out of a SINGLE source cwd, so nothing cc does
  // leaves one id answering at two candidates. It is planted here because a
  // second answering candidate is the only way to make the gate OBSERVABLE.
  //
  // GREEN ON ARRIVAL BY CONSTRUCTION: the shipped recovery is already inside
  // the refusal branch.
  //
  // NOT CLAIMING which of the two files the CLI would prefer if both were at
  // one cwd — they never are; what is pinned is which one is at `cwd` after the
  // resume.
  test('the recovery runs only where the pre-flight already refuses', async () => {
    const f = await fixture({ sub: 'proj', mirror: '.' });
    const cwd = f.inst.cwd;
    assert.equal(cwd, path.join(f.imageRoot, 'proj'));
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    // The LIVE conversation, at the composed cwd — so the pre-flight passes.
    await seedSessionJsonl(claudeProjectsRoot, cwd, backingId, [
      { type: 'user', message: { role: 'user', content: 'LIVE-0287' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    ]);
    // A STALE copy under the SAME id at the candidate probed first.
    await seedSessionJsonl(claudeProjectsRoot, f.imageRoot, backingId, [
      { type: 'user', message: { role: 'user', content: 'STALE-0287' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    ]);

    await drain({ expect: 1 });
    const r = await restore();

    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    assert.deepEqual(r.warns, [], JSON.stringify(r.warns));
    assert.equal(forSession(r, sessionId).cwd, cwd, 'the session moved at an unchanged geometry');
    // The live conversation is still the one at `cwd`.
    const live = await fs.readFile(sessionFilePath(cwd, backingId), 'utf8');
    assert.match(live, /LIVE-0287/, 'the live transcript at the composed cwd was replaced');
    assert.doesNotMatch(live, /STALE-0287/, 'the stale copy was renamed over the live transcript');
    // …and the stale copy was not moved either.
    const stale = await fs.readFile(sessionFilePath(f.imageRoot, backingId), 'utf8');
    assert.match(stale, /STALE-0287/, 'the stale copy at another candidate was relocated');
  });

  // PINS: a relocation that cannot complete refuses 502 `SESSION_MOVE_FAILED`
  // with a completeness claim DERIVED from what the rollback achieved, that
  // entry loses its one restore attempt, and every OTHER entry in the boot loop
  // still restores. The blocked session's files are all back at the geometry
  // they came from and none is at the destination.
  //
  // NOT CLAIMING which errno a real-world failure carries: a non-empty
  // directory planted at a destination is one blocker that never clears on a
  // retry, and the invariant is that a failure refuses rather than half-moving.
  // NOT CLAIMING anything about the other two completeness sentences (a
  // rollback that could not put a file back, a source that vanished mid-move):
  // both need a rename back to a path cc vacated microseconds earlier to fail,
  // which is unreachable by construction here as it is on 0279's path.
  test('a relocation that cannot complete refuses SESSION_MOVE_FAILED, and the other entries still restore', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const a = { sessionId: f.inst.sessionId, backingId: f.inst.backingSessionId };
    const second = await spawnOne({ project: f.project });
    const b = { sessionId: second.sessionId, backingId: second.backingSessionId };
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, a.backingId);
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, b.backingId);
    // A's SUBAGENT directory too, so the relocation has two pairs to move and
    // the one that fails is the second — which is what makes the rollback undo
    // a rename that already succeeded rather than nothing at all.
    await fs.mkdir(subAgentDirPath(oldCwd, a.backingId), { recursive: true });
    await fs.writeFile(path.join(subAgentDirPath(oldCwd, a.backingId), 'sub.jsonl'), '{"type":"user"}\n');

    await drain({ expect: 2 });
    await readvertise(f, '.');
    const newCwd = path.join(f.imageRoot, 'proj');
    // The blocker: a NON-EMPTY directory where A's subagent dir has to land.
    await fs.mkdir(subAgentDirPath(newCwd, a.backingId), { recursive: true });
    await fs.writeFile(path.join(subAgentDirPath(newCwd, a.backingId), 'occupied'), 'x');

    const r = await restore();

    assert.equal(r.restored, 1, `expected exactly the unblocked session: ${JSON.stringify(r.warns)}`);
    // A: refused by name, with the derived claim, and nothing registered.
    const warn = r.warns.find(w => w.includes(a.sessionId) || w.includes(a.backingId));
    assert.ok(warn, `A's refusal was not logged: ${JSON.stringify(r.warns)}`);
    assert.match(warn, /now mirrors this project at/, warn);
    assert.match(warn, /Nothing was moved/, warn);
    assert.match(warn, /No worker was started/, warn);
    assert.equal(forSession(r, a.sessionId), undefined, 'an instance was registered for the refused session');
    // …and A's history is whole at the geometry it came from.
    assert.equal(await exists(sessionFilePath(oldCwd, a.backingId)), true, 'A’s transcript did not survive the refusal');
    assert.equal(await exists(subAgentDirPath(oldCwd, a.backingId)), true, 'A’s subagent dir did not survive the refusal');
    assert.equal(await exists(sessionFilePath(newCwd, a.backingId)), false, 'A’s transcript was left half-moved');
    // B, untouched by A's failure.
    await assertFollowedIgnoringWarns(r, { ...b, oldCwd, newCwd });
  });

  // The moving assertions minus the "no warning" one — for the arm where a
  // SIBLING entry legitimately warned.
  async function assertFollowedIgnoringWarns(r, { sessionId, backingId, oldCwd, newCwd }) {
    const inst = forSession(r, sessionId);
    assert.ok(inst, `session ${sessionId} was not restored: ${JSON.stringify(r.warns)}`);
    assert.equal(inst.cwd, newCwd, 'the restored session is not at the new geometry');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript did not come with it');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), false, 'the transcript was copied, not moved');
  }

  // CONTROL, and the arm that stops the two movers double-moving. A session
  // card 2026-0279 already moved IN PLACE is at the current geometry by the
  // time it is drained, so the cold restore's scan finds nothing to do.
  //
  // NOT CLAIMING anything about 0279's own path beyond it having run: its
  // invariants are tests/systems-mirror-geometry-follow.test.mjs's.
  test('a session 0279 already moved in place is not moved again', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    // 0279: relaunch in place after the advertisement moved.
    await readvertise(f, '.');
    await f.inst.kill({ graceMs: 200 });
    const res = await api(baseUrl, 'POST', `/api/instances/${f.inst.id}/respawn`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const newCwd = path.join(f.imageRoot, 'proj');
    await waitFor(() => f.inst.cwd === newCwd);
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, '0279 did not move the transcript');

    // …and now the cold path, with no further advertisement change.
    await drain({ expect: 1 });
    const r = await restore();

    assert.equal(r.restored, 1, JSON.stringify(r.warns));
    assert.deepEqual(r.warns, [], JSON.stringify(r.warns));
    assert.equal(forSession(r, sessionId).cwd, newCwd, 'the cold restore moved a session that was already there');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript left the geometry 0279 put it at');
    assert.equal(await exists(sessionFilePath(f.imageRoot, backingId)), false, 'the transcript went back to the old geometry');
  });

  // PINS the OTHER entry point — the direct `POST /api/instances {resume}`,
  // which no restart is involved in — and that the move is REVERSIBLE: revert
  // the advertisement, resume again, and the transcript comes back with the
  // session. Reversibility is why following the move is not a one-way loss of
  // the old geometry.
  //
  // NOT CLAIMING that the two resumes are the same instance: each is a fresh
  // one on the same session.
  test('the direct POST /api/instances {resume} follows the move too, and the move is reversible', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const sessionId = f.inst.sessionId, backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    // Drop the session without a drain: this is a resume of something that is
    // simply no longer running.
    await f.inst.kill({ graceMs: 200 });
    instances.byId.clear();
    await readvertise(f, '.');

    const newCwd = path.join(f.imageRoot, 'proj');
    const first = await api(baseUrl, 'POST', '/api/instances',
      { project: f.project, resume: sessionId, mode: 'bypassPermissions' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(instances.get(first.body.id).cwd, newCwd, 'the resume did not land at the new geometry');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript did not come with it');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), false, 'the transcript was copied, not moved');

    // …and back again.
    await instances.get(first.body.id).kill({ graceMs: 200 });
    instances.byId.clear();
    await readvertise(f, '');
    const back = await api(baseUrl, 'POST', '/api/instances',
      { project: f.project, resume: sessionId, mode: 'bypassPermissions' });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(instances.get(back.body.id).cwd, oldCwd, 'the reverted advertisement was not followed back');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), true, 'the transcript did not come back');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), false, 'the transcript is at two geometries');
  });

  // PINS CONVERGENCE: two cold moves with a lineage rotation in between end
  // with EVERY segment at the final geometry and nothing left at either earlier
  // one. This is what makes "a move could split a lineage across geometries" a
  // tested worry rather than an asserted one.
  //
  // NOT CLAIMING that a lineage which was ALREADY split before the first move
  // is reassembled.
  test('two cold moves with a rotation in between converge on one geometry', async () => {
    const f = await fixture({ sub: path.join('nest', 'proj'), mirror: '' });
    const first = f.inst.cwd;
    assert.equal(first, f.imageRoot);
    const sessionId = f.inst.sessionId, older = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, first, older);

    // Move 1: offset '' → 'proj'.
    await drain({ expect: 1 });
    await readvertise(f, 'nest');
    const second = path.join(f.imageRoot, 'proj');
    const r1 = await restore();
    assert.equal(r1.restored, 1, JSON.stringify(r1.warns));
    await assertFollowed(r1, { sessionId, backingId: older, oldCwd: first, newCwd: second });

    // A renew AT the new geometry, so the lineage now has two segments there.
    const newer = '9746ee72-0000-4000-8000-00000000eeee';
    await recordRotation(sessionId, newer, 'renew');
    await seedSessionJsonl(claudeProjectsRoot, second, newer);

    // Move 2: offset 'proj' → 'nest/proj'.
    await drain({ expect: 1 });
    await readvertise(f, '.');
    const third = path.join(f.imageRoot, 'nest', 'proj');
    const r2 = await restore();
    assert.equal(r2.restored, 1, JSON.stringify(r2.warns));
    await assertFollowed(r2, { sessionId, backingId: newer, oldCwd: second, newCwd: third });

    for (const [cwd, label] of [[first, 'the first geometry'], [second, 'the second geometry']]) {
      for (const id of [older, newer]) {
        assert.equal(await exists(sessionFilePath(cwd, id)), false, `a segment was left at ${label}`);
      }
    }
    for (const id of [older, newer]) {
      assert.equal(await exists(sessionFilePath(third, id)), true, 'a segment did not reach the final geometry');
    }
  });
});
