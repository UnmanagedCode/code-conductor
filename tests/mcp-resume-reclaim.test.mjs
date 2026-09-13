// Resuming a session RECLAIMS the in-memory instances it supersedes, and the
// liveness oracle those two decisions rest on cannot be shadowed by a corpse.
//
// The defect, in one sentence: `create({resume})` guarded only against a LIVE
// instance (`liveForSession`), so resuming a settled-but-still-registered
// session left BOTH instances in `byId` answering to one public sessionId —
// and `anyForSession` is first-match over insertion order, so the corpse won.
// That is not a cosmetic duplicate row. `isSessionLive` read the corpse and
// answered FALSE while a process was running, which is the liveness authority
// the playbook gate reads and surfaces as `live:` in `playbook_state`.
//
// Three changes are under test here, and they are one mechanism:
//   (ii)  isSessionLive is a `.some()` over EVERY instance answering to the
//         session, via the shared per-instance predicate `isLiveOrComingUp`.
//   (iii) _doCreate's resume guard reads isSessionLive (subsuming the old
//         liveForSession + _resumingPublicIds pair, and adding the
//         prune/rewind/respawn relaunch windows) and then, past that guard,
//         retires every remaining instance for the session via remove().
//
// The `.some()` is LOAD-BEARING for the reclaim's safety, not cosmetic: the
// reclaim calls remove(), which calls kill(), so it is only sound because the
// guard it runs behind is false ONLY when every instance answering to the
// session is settled. With the old first-match oracle a corpse ordered ahead
// of a live instance would read false and the reclaim would walk into a live
// process. P1 and P2 pin exactly that, from the two sides.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceManager, Instance } from '../src/instances.ts';
import { spawnInstance } from '../src/mcp/handlers.ts';
import {
  bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl, instForSession,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_RESUME = path.join(__dirname, 'fixtures', 'scenario-resume.json');

// A registry-entry stand-in — the same idiom as tests/instance-liveness.test.mjs:
// enough for answersTo() (sessionId/_segments) and for isLiveOrComingUp's own
// reads (proc, rotationPending, relaunching).
function stubInstance({ id, sessionId, proc = null }) {
  const inst = Object.create(Instance.prototype);
  inst.id = id;
  inst.sessionId = sessionId;
  inst._segments = [];
  inst.proc = proc;
  inst._rotation = null;
  inst._relaunching = false;
  inst._emitUi = () => {};
  return inst;
}

// ─────────────────────────── P1 / P2: the oracle ───────────────────────────
//
// Both build the duplicate WHITE-BOX (construct the second Instance and
// byId.set it directly) on purpose: once the reclaim lands, create() refuses
// to build one. These two pin the behaviour when a duplicate exists ANYWAY —
// a long-running orchestrator that accumulated one before this shipped, or any
// future path that adds one.

test('P1 a corpse ordered first can NOT shadow a live instance in isSessionLive', () => {
  const im = new InstanceManager();
  const sid = 'sid-shadow';
  // Insertion order is the whole point: byId is a Map, idsForSession preserves
  // it, and anyForSession takes the FIRST match. The corpse goes in first.
  im.byId.set('corpse', stubInstance({ id: 'corpse', sessionId: sid, proc: null }));
  im.byId.set('live', stubInstance({ id: 'live', sessionId: sid, proc: {} }));
  assert.deepEqual(im.idsForSession(sid), ['corpse', 'live'],
    'premise: both answer to the session, and the corpse is first');
  assert.equal(im.anyForSession(sid).id, 'corpse',
    'premise: anyForSession is first-match, so it resolves the corpse — this is the shadow');
  assert.equal(im.isSessionLive(sid), true,
    'THE liveness authority must see the live instance THROUGH the corpse; a first-match '
    + 'oracle answers false here while a process is running, and the playbook gate believes it');
});

test('P2 _doCreate refuses a resume over that same duplicate and the reclaim kills nothing', async () => {
  // The contrapositive of the reclaim's safety invariant: the reclaim is only
  // reachable past `if (isSessionLive) throw 409`, so a live instance anywhere
  // in the session's set must stop it. Entered at _doCreate rather than
  // create(), deliberately — create()'s synchronous prefix 409s on its own
  // liveForSession scan, which would shield the widened guard from the test
  // and leave the `.some()` unpinned.
  const im = new InstanceManager();
  const sid = 'sid-guarded';
  const corpse = stubInstance({ id: 'corpse', sessionId: sid, proc: null });
  const live = stubInstance({ id: 'live', sessionId: sid, proc: { pid: 4242 } });
  im.byId.set('corpse', corpse);
  im.byId.set('live', live);

  await assert.rejects(
    async () => im._doCreate({ resume: sid, project: 'nope' }),
    (e) => {
      assert.equal(e.statusCode, 409, `expected a 409 refusal, got: ${e.stack}`);
      assert.match(e.message, /live/, 'the message must name the live instance it refused for');
      return true;
    },
  );
  // Untouched, field by field: a reclaim that ran would have called remove() →
  // kill() on this object and dropped it from byId.
  assert.equal(im.byId.get('live'), live, 'the live instance is still registered');
  assert.equal(live.proc.pid, 4242, 'its process is still attached');
  assert.equal(im.byId.get('corpse'), corpse,
    'and the corpse is still there too — a refused create reclaims nothing at all');
});

// ───────────────────── the reclaim, against a real server ──────────────────

describe('resuming a session retires the in-memory instances it supersedes', () => {
  let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;

  before(async () => {
    ctx = await bootServer({ scenarioPath: SCENARIO_RESUME });
    ({ baseUrl, instances } = ctx);
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
  afterEach(async () => { await instances.shutdown(); await rmrf(home); });

  let n = 0;
  // A NON-TEMP instance that has exited but is still in byId — the one state
  // the removed respawn_instance existed for, and the only state in which a
  // resume can find a superseded husk to reclaim. Built over REST because no
  // MCP-spawned session can ever reach it (spawn_instance always spawns temp,
  // and a temp worker is dropped from byId the moment its process exits).
  // The subprocess is killed on the Instance directly: DELETE /api/instances/:id
  // would remove it from byId and there would be nothing left to supersede.
  async function settledHusk({ mode = 'bypassPermissions' } = {}) {
    const project = `reclaim-${++n}`;
    await api(baseUrl, 'POST', '/api/projects', { name: project });
    const created = await api(baseUrl, 'POST', '/api/instances', { project, temp: false, mode });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const inst = instances.get(created.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sessionId = inst.sessionId;
    // The fake engine writes no transcript, and the resume pre-flight requires
    // one, so seed the jsonl the CLI would have written under this cwd.
    await seedSessionJsonl(claudeProjectsRoot, path.join(projectsRoot, project), inst.backingSessionId);
    await inst.kill({ graceMs: 50 });
    await waitFor(() => !inst.proc && (inst.status === 'exited' || inst.status === 'crashed'));
    assert.equal(instances.get(inst.id), inst, 'premise: a non-temp exit is RETAINED in byId');
    return { project, sessionId, inst, oldId: inst.id };
  }

  test('R1 a resume leaves exactly one in-memory instance for the session', async () => {
    const { project, sessionId, oldId } = await settledHusk();
    assert.equal(instances.idsForSession(sessionId).length, 1, 'premise: one husk before the resume');
    const fresh = await instances.create({ project, resume: sessionId });
    await waitFor(() => fresh.status === 'idle');
    assert.deepEqual(instances.idsForSession(sessionId), [fresh.id],
      'the husk is retired, not joined — two instances answering to one public sessionId is '
      + 'the state that makes anyForSession first-match ambiguous');
    assert.equal(instances.get(oldId), undefined, 'the superseded instance is out of byId');
  });

  test('R2 the reclaim takes the superseded auto-resume deadline with it', async () => {
    const { project, sessionId, inst, oldId } = await settledHusk();
    // Arm an overage auto-resume on the husk, with a far-future reset so no
    // sweep tick can fire it during the test.
    instances._armResumeNow(inst, Math.floor(Date.now() / 1000) + 86400);
    assert.equal(instances._autoResumeTimers.has(oldId), true, 'premise: a deadline is armed');
    assert.ok(instances._overageResume.timers.size > 0, 'premise: the controller holds it');

    const fresh = await instances.create({ project, resume: sessionId });
    await waitFor(() => fresh.status === 'idle');

    assert.equal(instances._autoResumeTimers.has(oldId), false,
      'the superseded deadline is cancelled — nothing else in the create path reclaims it');
    assert.equal(instances._overageResume.timers.size, 0,
      'and the controller is empty: a stranded deadline holds the GLOBAL overage lockout, '
      + 'because _maybeReleaseOverageLock short-circuits while any timer remains');
  });

  test('R3 anyForSession resolves the new live instance, not the husk', async () => {
    const { project, sessionId, oldId } = await settledHusk();
    const fresh = await instances.create({ project, resume: sessionId });
    await waitFor(() => fresh.status === 'idle');
    const got = instances.anyForSession(sessionId);
    assert.equal(got?.id, fresh.id,
      'stale-first resolution is what let a second `claude --resume` be started on one jsonl');
    assert.notEqual(got?.id, oldId);
    assert.ok(got.proc, 'and it is the LIVE one');
  });

  test('R4 a resume over a genuinely live instance is still refused 409', async () => {
    // Non-vacuity control for R1/R3: the widened guard must not have weakened
    // the two-subprocess-on-one-jsonl rule it replaced.
    const project = 'reclaim-live';
    await api(baseUrl, 'POST', '/api/projects', { name: project });
    const created = await api(baseUrl, 'POST', '/api/instances',
      { project, temp: false, mode: 'bypassPermissions' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const inst = instances.get(created.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    await seedSessionJsonl(claudeProjectsRoot, path.join(projectsRoot, project), inst.backingSessionId);

    await assert.rejects(
      // `async` so create()'s SYNCHRONOUS prefix throw reads as a rejection here.
      async () => instances.create({ project, resume: inst.sessionId }),
      (e) => { assert.equal(e.statusCode, 409, e.stack); return true; },
    );
    assert.equal(instances.get(inst.id), inst, 'and it was not reclaimed out from under itself');
    assert.ok(inst.proc, 'its process is untouched');
  });

  for (const window of ['relaunching', 'rotationPending']) {
    test(`R5 a resume during a ${window} relaunch window is refused 409, and the window survives`, async () => {
      // The second double-spawn hole, independent of the corpse: create()'s old
      // guards read `proc` only, while a prune's kill→relaunch and a
      // respawn/rewind's relaunch both sit at proc === null with a process
      // coming back. A resume issued inside one really did start two CLIs on
      // one transcript.
      const { project, sessionId, inst } = await settledHusk();
      if (window === 'relaunching') inst._relaunching = true;
      else inst.beginRotation('prune');
      try {
        assert.equal(instances.isSessionLive(sessionId), true, 'premise: the window reads live');
        await assert.rejects(
          async () => instances.create({ project, resume: sessionId }),
          (e) => { assert.equal(e.statusCode, 409, e.stack); return true; },
        );
        assert.equal(instances.get(inst.id), inst,
          'and the reclaim did not eat an in-flight prune/rewind: the instance is still registered');
      } finally {
        if (window === 'relaunching') inst._relaunching = false;
        else inst.endRotation({ ok: true, comesUpIdle: true });
      }
    });
  }

  test('R6 spawn_instance({resume}) over a husk honours the mode override and transfers ownership', async () => {
    // The two things a delegation branch (respawn_instance → instances.respawn)
    // would have broken. respawn(id) takes an id and nothing else and relaunches
    // the SAME Instance object, so it reuses the live `this.mode` and keeps
    // whatever callerInstanceId the object was constructed with.
    const { sessionId, oldId } = await settledHusk({ mode: 'bypassPermissions' });

    // A live conductor to be the caller.
    await api(baseUrl, 'POST', '/api/projects', { name: 'reclaim-conductor' });
    const c = await api(baseUrl, 'POST', '/api/instances',
      { project: 'reclaim-conductor', temp: false, mode: 'bypassPermissions' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const conductor = instances.get(c.body.id);
    await waitFor(() => conductor.status === 'idle' && conductor.sessionId);

    const view = await spawnInstance(
      { resume: sessionId, mode: 'plan' },
      { instances, callerId: conductor.sessionId },
    );
    assert.equal(view.ok, undefined, `a conductor view, not a soft refusal: ${JSON.stringify(view)}`);
    assert.equal(view.sessionId, sessionId);
    await waitFor(() => instForSession(instances, sessionId)?.status === 'idle');
    const worker = instForSession(instances, sessionId);

    assert.ok(worker.proc, 'the worker is live');
    assert.notEqual(worker.id, oldId, 'and it is a NEW Instance, not the relaunched husk');
    assert.equal(worker.mode, 'plan',
      'the explicit mode override is honoured — the husk ran bypassPermissions, and respawn(id) '
      + 'has no mode parameter at all, so it would have come back hot');
    assert.equal(worker.callerInstanceId, conductor.id,
      'ownership transfers to the CALLER: callerInstanceId is a constructor field, so a '
      + 'relaunched husk would keep its original owner and never wake this conductor');
  });

  // ───────────────────── R-RACE: a lost race is a success ─────────────────

  test('P3 the reclaim treats a concurrently-removed instance as success', async () => {
    // A deterministic model of the temp-exit status listener landing in the
    // await gap inside the reclaim loop: it also does byId.delete, and it fires
    // from the subprocess exit handler, i.e. on the event loop. The listener
    // winning must not turn a legitimate resume into an error.
    const { project, sessionId, oldId } = await settledHusk();
    const orig = instances.remove;
    let sawReclaim = 0;
    instances.remove = async function (id) {
      if (id === oldId) { sawReclaim++; this.byId.delete(id); }   // the listener wins
      return orig.call(this, id);
    };
    try {
      const fresh = await instances.create({ project, resume: sessionId });
      await waitFor(() => fresh.status === 'idle');
      assert.equal(sawReclaim, 1, 'premise: the reclaim really did try to remove the husk');
      assert.deepEqual(instances.idsForSession(sessionId), [fresh.id],
        'the post-condition the reclaim exists for is reached either way');
    } finally { instances.remove = orig; }
  });

  test('P3b a non-404 failure from the reclaim propagates', async () => {
    // The narrowness control for P3: `catch (404)` must be exactly that and not
    // a blanket swallow. A reclaim that cannot retire a husk has left the
    // duplicate in place, and the resume must not report success over it.
    const { project, sessionId, oldId } = await settledHusk();
    const orig = instances.remove;
    instances.remove = async function (id) {
      if (id === oldId) throw Object.assign(new Error('reclaim exploded'), { statusCode: 500 });
      return orig.call(this, id);
    };
    try {
      await assert.rejects(
        async () => instances.create({ project, resume: sessionId }),
        (e) => {
          assert.equal(e.statusCode, 500, `expected the 500 to surface, got: ${e.stack}`);
          assert.match(e.message, /reclaim exploded/);
          return true;
        },
      );
    } finally { instances.remove = orig; }
  });
});
