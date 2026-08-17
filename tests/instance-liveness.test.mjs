// InstanceManager.isSessionLive — THE liveness authority (src/instances.ts).
// Mostly unit-level, no server, no subprocess: bare `InstanceManager` and
// prototype-only `Instance` stand-ins (Object.create(Instance.prototype), with
// _emitUi stubbed out so beginRotation/endRotation run without the ring/WS
// plumbing a real constructor sets up).
//
// The completeness claim under test: bare `liveForSession` (proc-attached only)
// reads FALSE during windows where the worker is genuinely coming up — a
// resume in flight before its registry entry exists, a prune's
// kill-then-relaunch window, and (the `_relaunching` field, added after an
// independent review found the oracle incomplete here) the same window in
// rewindToUserMessage and InstanceManager.respawn. isSessionLive must read
// TRUE in all of them, or the liveness authority just moves the race instead
// of closing it.
//
// The final `describe` block below is the one exception: it boots a real
// server (fake-claude launcher, no real subprocess) to prove rewind/respawn
// actually SET `_relaunching` at the right moments, not just that the flag
// mechanism works in isolation — a mutant deleting `_relaunching = true` from
// one of those two methods specifically would still pass every unit test
// above.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceManager, Instance } from '../src/instances.ts';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

// A registry-entry stand-in: enough for answersTo() (sessionId/_segments) and
// for isSessionLive's own reads (proc, rotationPending). _emitUi is stubbed so
// the real beginRotation/endRotation methods run without a full instance.
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

test('a resume in flight reads live with NO registry entry at all — _resumingPublicIds alone', () => {
  const im = new InstanceManager();
  assert.equal(im.isSessionLive('sid-x'), false, 'premise: nothing claims this id yet');
  im._resumingPublicIds.add('sid-x');
  assert.equal(im.anyForSession('sid-x'), null,
    'premise: the registry has no byId entry for it — this is the pre-byId.set window');
  assert.equal(im.isSessionLive('sid-x'), true,
    'a resume in flight must read live even with no registry entry — bare liveForSession/anyForSession would read false here');
  im._resumingPublicIds.delete('sid-x');
  assert.equal(im.isSessionLive('sid-x'), false, 'and it must stop once the resume settles');
});

test('a prune\'s kill->relaunch window reads live via rotationPending, even though proc is null', () => {
  const im = new InstanceManager();
  const inst = stubInstance({ id: 'i1', sessionId: 'sid-y', proc: null });
  im.byId.set('i1', inst);
  assert.equal(im.isSessionLive('sid-y'), false, 'premise: registered, no proc, no rotation -> not live');
  inst.beginRotation('prune');
  assert.equal(im.isSessionLive('sid-y'), true,
    'the kill->relaunch window must read live even with proc null — this is the internal-relaunch race 2026-0151 names');
  inst.endRotation({ ok: true, comesUpIdle: true });
  assert.equal(im.isSessionLive('sid-y'), false, 'once the rotation window closes, a still-dead proc reads not-live again');
});

test('a rewind/respawn relaunch window reads live via `_relaunching`, even though proc is null', () => {
  // The sibling window to prune's rotationPending, above: rewindToUserMessage
  // and InstanceManager.respawn are structurally the same kill(or
  // already-dead)->launch cycle but deliberately do NOT go through
  // beginRotation/`_rotation` (see the `_relaunching` field comment,
  // src/instances.ts) — widening `_rotation`'s reason union would make
  // _assertNoRotationInFlight misreport a rewind/respawn collision as "a
  // context renewal is in progress", and would wire the rotation_complete
  // idle-wake path onto operations that never meant to arm it. `_relaunching`
  // is read ONLY by isSessionLive, so it carries none of that.
  const im = new InstanceManager();
  const inst = stubInstance({ id: 'i1', sessionId: 'sid-v', proc: null });
  im.byId.set('i1', inst);
  assert.equal(im.isSessionLive('sid-v'), false, 'premise: registered, no proc, no relaunch -> not live');
  inst._relaunching = true;
  assert.equal(im.isSessionLive('sid-v'), true,
    'the relaunch window must read live even with proc null');
  inst._relaunching = false;
  assert.equal(im.isSessionLive('sid-v'), false, 'once the window closes, a still-dead proc reads not-live again');
});

test('a registered instance with proc attached reads live', () => {
  const im = new InstanceManager();
  const inst = stubInstance({ id: 'i1', sessionId: 'sid-z', proc: {} });
  im.byId.set('i1', inst);
  assert.equal(im.isSessionLive('sid-z'), true);
});

test('a registered instance with no proc and no rotation reads NOT live — a genuinely dead worker is not reported live', () => {
  const im = new InstanceManager();
  const inst = stubInstance({ id: 'i1', sessionId: 'sid-w', proc: null });
  im.byId.set('i1', inst);
  assert.equal(im.isSessionLive('sid-w'), false,
    'widening the predicate to bare anyForSession (ignoring proc/rotationPending) would report this worker live');
});

test('an unknown sessionId reads not-live', () => {
  const im = new InstanceManager();
  assert.equal(im.isSessionLive('never-seen'), false);
});

// ── the actual wiring: rewindToUserMessage / InstanceManager.respawn ────────
//
// Real bootServer + fake-claude launcher (no real subprocess). Neither method
// has a genuine multi-tick async gap for a plain worker (no custom
// `_appendSystemPromptFileProvider`, so `launch()` -> `spawn()` runs
// synchronously once reached) — respawn's own body before `launch()` is
// entirely synchronous too, so a bare "call without awaiting, check
// immediately" trick would observe the whole relaunch already having run to
// completion (or, for rewind, would observe the OLD proc still attached,
// before `kill()`'s awaited exit has even fired) — either way, a check that
// passes for a reason unrelated to `_relaunching`, and empirically does not
// fail under the mutant that removes it (verified below). Instead, `launch`
// is monkey-patched per-instance to capture isSessionLive AT THE MOMENT it is
// invoked — the one point guaranteed to sit inside the window (`_relaunching`
// is set before it, and it is what attaches the NEW proc) regardless of how
// many ticks separate it from the call site.

describe('rewind/respawn relaunch windows read live end to end', () => {
  let ctx, baseUrl, instances, prevScenario;
  const RESUME_SCENARIO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-resume.json');

  before(async () => {
    ctx = await bootServer({});
    ({ baseUrl, instances } = ctx);
    // No scenario at boot (see overage-action.test.mjs's convention) — a
    // `resume:` spawn needs one, so set it once for both tests in this block.
    prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = RESUME_SCENARIO;
  });
  after(async () => {
    await ctx.close();
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  });

  test('a rewindToUserMessage relaunch window reads live via isSessionLive', async () => {
    const sid = 'aaaa1111-2222-3333-4444-555555555555';
    await api(baseUrl, 'POST', '/api/projects', { name: 'rewind-liveness' });
    const projectPath = path.join(ctx.projectsRoot, 'rewind-liveness');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second prompt' } },
        { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second reply' }] } },
      ].map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'rewind-liveness', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    const publicId = inst.sessionId;
    assert.equal(instances.isSessionLive(publicId), true, 'premise: proc-attached, ordinarily live');

    const realLaunch = inst.launch.bind(inst);
    let observedDuringLaunch;
    inst.launch = async (opts) => {
      // By now the kill has fully resolved (proc null) and rewind's own
      // truncate/wipe steps have run, but no NEW proc exists yet — launch()
      // is what attaches one.
      observedDuringLaunch = instances.isSessionLive(publicId);
      return realLaunch(opts);
    };
    await inst.rewindToUserMessage(1);
    assert.equal(observedDuringLaunch, true,
      'isSessionLive must read live at the instant launch() is invoked — proc is null there, only `_relaunching` says this worker is coming back');
    await waitFor(() => instances.get(id).status === 'idle');
    assert.equal(instances.isSessionLive(publicId), true, 'and live again once the relaunch has actually landed');
  });

  test('an InstanceManager.respawn relaunch window reads live via isSessionLive', async () => {
    const sid = 'bbbb1111-2222-3333-4444-555555555555';
    await api(baseUrl, 'POST', '/api/projects', { name: 'respawn-liveness' });
    const projectPath = path.join(ctx.projectsRoot, 'respawn-liveness');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sid}.jsonl`),
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
      ].map(l => JSON.stringify(l)).join('\n') + '\n',
    );

    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'respawn-liveness', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const publicId = instances.get(id).sessionId;

    const inst = instances.get(id);
    await inst.kill({ graceMs: 50 });
    await waitFor(() => ['exited', 'crashed'].includes(instances.get(id).status));
    assert.equal(instances.isSessionLive(publicId), false, 'premise: genuinely dead after the kill, before any respawn');

    const realLaunch = inst.launch.bind(inst);
    let observedDuringLaunch;
    inst.launch = async (opts) => {
      observedDuringLaunch = instances.isSessionLive(publicId);
      return realLaunch(opts);
    };
    await instances.respawn(id);
    assert.equal(observedDuringLaunch, true,
      'isSessionLive must read live at the instant launch() is invoked — proc is still null there (confirmed dead above), only `_relaunching` says this worker is coming back');
    await waitFor(() => instances.get(id).status === 'idle');
    assert.equal(instances.isSessionLive(publicId), true, 'and live again once the respawn has actually landed');
  });
});
