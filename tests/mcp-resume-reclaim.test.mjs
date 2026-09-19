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
// The mechanism under test, in the order it runs — one mechanism, five parts:
//   (1) isLiveOrComingUp(inst): the ONE per-instance "live, or a process is
//       coming back" predicate (proc attached, rotationPending, _relaunching),
//       shared so the oracle and the reclaim cannot drift apart.
//   (2) isSessionLive: `.some()` over EVERY instance answering to the session,
//       never anyForSession's first match, so a corpse cannot shadow a live one.
//   (3) _doCreate's resume guard reads isSessionLive — subsuming the old
//       liveForSession + _resumingPublicIds pair and adding the
//       prune/rewind/respawn relaunch windows — then takes the claim.
//   (4) THE RECLAIM ITSELF RUNS AT THE END OF _doCreateResolved, immediately
//       before byId.set and past EVERY validation and refusal — deliberately
//       NOT beside the guard in (3). Nothing above it is rolled back, so a
//       reclaim placed at the guard let a REFUSED resume destroy the session's
//       existing instance on its way out. That placement is what the F2 tests
//       exist to prove; do not "simplify" the two back together.
//   (5) InstanceManager.respawn refuses 409 while (3)'s claim is held, so a
//       revival cannot land inside the reclaim's await window. The reverse
//       order needs no guard: respawn sets _relaunching in its synchronous
//       prefix, which (2) reads. The F1 tests pin both orders.
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
import { localPlace } from '../src/projects.ts';

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

test('P4 the guard\'s 409 names WHICH window refused — all three branches, distinctly', async () => {
  // The guard builds its message from a three-way ternary: a live instance names
  // its id, a held `_resumingPublicIds` claim says a resume is in flight, and a
  // relaunch window says a relaunch is. The third branch exists so those last two
  // cannot be conflated — they send the reader to DIFFERENT remedies (wait for the
  // other resumer to settle, vs. wait out a prune/rewind/respawn on this instance).
  // Swapping them is invisible to every other test here, so each branch is pinned
  // on both polarities: the wording it must have AND the wordings it must not.
  //
  // The throw sits BEFORE _doCreate's `try`, so its `finally` never runs on this
  // path and a claim planted here survives the call — which is what lets the
  // claim-only case be built at all.
  const msgOf = async (im, sid) => {
    const e = await im._doCreate({ resume: sid, project: 'nope' }).then(
      () => assert.fail('expected the guard to refuse'), (err) => err);
    assert.equal(e.statusCode, 409, `expected a 409 from the guard, got: ${e.stack}`);
    return e.message;
  };

  // (a) CLAIM ONLY — no instance in byId at all, so isSessionLive is true purely
  //     from the claim and liveForSession is null.
  {
    const im = new InstanceManager();
    const sid = 'sid-claim-only';
    im._resumingPublicIds.add(sid);
    assert.equal(im.liveForSession(sid), null, 'premise: nothing proc-attached — not the live branch');
    assert.deepEqual(im.idsForSession(sid), [], 'premise: no instance at all — not the relaunch branch');
    const msg = await msgOf(im, sid);
    assert.match(msg, /a resume is already in flight/,
      'a claim-only refusal must say a RESUME holds the session — the remedy is to wait for that resume');
    assert.doesNotMatch(msg, /a relaunch is in flight/,
      'and must not report a relaunch: that sends the reader to the wrong instance entirely');
  }

  // (b) RELAUNCH WINDOW ONLY — registered, proc null, no claim held.
  {
    const im = new InstanceManager();
    const sid = 'sid-relaunch-only';
    const inst = stubInstance({ id: 'i-relaunch', sessionId: sid, proc: null });
    inst._relaunching = true;
    im.byId.set(inst.id, inst);
    assert.equal(im.liveForSession(sid), null, 'premise: proc null — not the live branch');
    assert.equal(im._resumingPublicIds.has(sid), false, 'premise: no claim — not the resume branch');
    const msg = await msgOf(im, sid);
    assert.match(msg, /a relaunch is in flight/,
      'a relaunch-window refusal must say RELAUNCH — the remedy is to wait out the prune/rewind/respawn');
    assert.doesNotMatch(msg, /a resume is already in flight/,
      'and must not report a resume: there is no other resumer to wait for');
  }

  // (c) LIVE — names the instance's own id, and neither in-flight wording. Pinned
  //     against an id that shares no substring with either message, so this cannot
  //     pass on a coincidence the way a stub named `live` matching /live/ would.
  {
    const im = new InstanceManager();
    const sid = 'sid-live-branch';
    im.byId.set('9f3c71aa-dead-beef', stubInstance({ id: '9f3c71aa-dead-beef', sessionId: sid, proc: {} }));
    const msg = await msgOf(im, sid);
    assert.match(msg, /\(9f3c71aa…\)/,
      'a live refusal must name the instance holding the session, truncated to 8 chars');
    assert.doesNotMatch(msg, /in flight/,
      'and must report neither in-flight wording: nothing is coming up, something already is up');
  }
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
  // A NON-TEMP instance that has exited but is still in byId — the only state
  // in which a resume can find a superseded husk to reclaim. Built over REST
  // because no MCP-spawned session can ever reach it: a conducted spawn is
  // always temp, and a temp worker is dropped from byId the moment its process
  // exits.
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
    await seedSessionJsonl(localPlace(path.join(projectsRoot, project)), inst.backingSessionId);
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
    await seedSessionJsonl(localPlace(path.join(projectsRoot, project)), inst.backingSessionId);

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
    // The two things delegating an MCP resume to instances.respawn() would
    // break. respawn(id) takes an id and nothing else and relaunches the SAME
    // Instance object, so it reuses the live `this.mode` and keeps whatever
    // callerInstanceId the object was constructed with.
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

  // ────────── F2: a REFUSED resume must reclaim nothing at all ──────────
  //
  // The reclaim sits at the very end of _doCreateResolved, immediately before
  // byId.set. Everything that can refuse runs above it and none of it is rolled
  // back, so a reclaim placed any earlier destroys the session's existing
  // instance on the way out of a refusal.

  for (const [label, bad] of [
    ['thinking', { thinking: 'garbage' }],
    ['backend', { backend: 'no-such-backend-row' }],
  ]) {
    test(`F2 a resume refused on ${label} — after the liveness guard — leaves the husk registered`, async () => {
      const { project, sessionId, oldId, inst } = await settledHusk();
      await assert.rejects(
        async () => instances.create({ project, resume: sessionId, ...bad }),
        (e) => {
          // Any refusal raised inside _doCreateResolved will do; what matters is
          // that it lands AFTER _doCreate's 409 guard (which this resume passes)
          // and therefore after the point an early reclaim would have fired.
          assert.ok(e.statusCode >= 400 && e.statusCode !== 409,
            `expected a post-guard refusal, got ${e.statusCode}: ${e.message}`);
          return true;
        },
      );
      assert.equal(instances.get(oldId), inst,
        'the husk must survive a refused resume — it did before the reclaim existed, and the jsonl surviving '
        + 'does not make losing the in-memory instance invisible: the sidebar row goes with it');
      assert.deepEqual(instances.idsForSession(sessionId), [oldId],
        'and it is still the session\'s one instance');
    });
  }

  test('F2 control: the husk a refused resume left behind is still resumable', async () => {
    // Non-vacuity for the two above: they assert the husk is PRESENT, this asserts
    // it was left in a usable state rather than half-torn-down.
    const { project, sessionId, oldId } = await settledHusk();
    await assert.rejects(
      async () => instances.create({ project, resume: sessionId, thinking: 'garbage' }),
      (e) => e.statusCode === 400,
    );
    const fresh = await instances.create({ project, resume: sessionId });
    await waitFor(() => fresh.status === 'idle');
    assert.deepEqual(instances.idsForSession(sessionId), [fresh.id],
      'the retry reclaims the husk it spared, so the post-condition still holds');
    assert.equal(instances.get(oldId), undefined);
  });

  // ────────── F1: respawn() and the reclaim cannot interleave ──────────

  test('F1 a respawn arriving INSIDE the reclaim window is refused 409', async () => {
    // The measured interleaving: `await this.remove(staleId)` is a real event-loop
    // window (a FUSE husk's kill() early-out still awaits _fuse.teardown()), and
    // InstanceManager.respawn — POST /api/instances/:id/respawn, the UI Respawn
    // button — used to guard only `if (inst.proc)`, which a settled husk passes.
    const { project, sessionId, oldId } = await settledHusk();
    const orig = instances.remove;
    let outcome = 'never attempted';
    instances.remove = async function (id) {
      if (id === oldId && outcome === 'never attempted') {
        // Exactly the window: the reclaim has committed to removing this husk and
        // has not finished tearing it down.
        outcome = await instances.respawn(id).then(() => 'succeeded', e => e);
      }
      return orig.call(this, id);
    };
    try {
      const fresh = await instances.create({ project, resume: sessionId });
      await waitFor(() => fresh.status === 'idle');
      assert.notEqual(outcome, 'never attempted', 'premise: the reclaim ran and we got into its window');
      assert.equal(outcome?.statusCode, 409,
        `the in-window respawn must be refused, got: ${outcome?.message ?? outcome}`);
      assert.match(outcome.message, /being resumed/);
      assert.deepEqual(instances.idsForSession(sessionId), [fresh.id],
        'and the reclaim still completed: no revived husk left beside the new worker');
    } finally { instances.remove = orig; }
  });

  test('F1 the reverse order: a resume inside respawn\'s relaunch WINDOW — proc still null — is refused 409', async () => {
    // respawn() sets `_relaunching = true` with NO await between it and the
    // `if (inst.proc)` check, so the widened isSessionLive guard sees the relaunch
    // and refuses before the reclaim can be reached at all. This is the half that
    // needs no new guard — it pins that the synchronous prefix stays synchronous.
    //
    // launch() IS GATED, and that is what makes the test measure its own name.
    // launch() is what attaches the new proc; ungated, the relaunch can win the
    // race and the 409 then arrives via isSessionLive's `proc != null` disjunct
    // instead — so mutants that drop the RELAUNCH disjunct (or revert the guard to
    // liveForSession) left the ungated form green, passing for a mechanism it was
    // not exercising. Holding launch() keeps proc null across the whole check, so
    // a 409 here can only come from `_relaunching`.
    const { project, sessionId, oldId } = await settledHusk();
    const inst = instances.get(oldId);
    const realLaunch = inst.launch.bind(inst);
    let release;
    const gate = new Promise((r) => { release = r; });
    inst.launch = async (opts) => { await gate; return realLaunch(opts); };

    const relaunch = instances.respawn(oldId);           // NOT awaited
    try {
      assert.equal(inst.relaunching, true,
        'premise: respawn marked the relaunch window before yielding');
      assert.equal(inst.proc, null,
        'premise: and with NO proc attached — the proc disjunct is unavailable, so a 409 below '
        + 'can only be the relaunch window');
      assert.equal(instances.liveForSession(sessionId), null,
        'premise, from the other side: nothing proc-attached answers to this session');
      await assert.rejects(
        async () => instances.create({ project, resume: sessionId }),
        (e) => {
          assert.equal(e.statusCode, 409, e.stack);
          assert.match(e.message, /a relaunch is in flight/,
            'and the refusal names the RELAUNCH window — the disjunct actually under test');
          return true;
        },
      );
    } finally {
      release();
      const revived = await relaunch;
      delete inst.launch;
      assert.equal(revived.id, oldId, 'the respawn itself still succeeded — it was never the loser');
    }
    assert.deepEqual(instances.idsForSession(sessionId), [oldId],
      'and nothing was reclaimed: the refused resume never reached the reclaim');
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
