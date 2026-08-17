// InstanceManager.isSessionLive — THE liveness authority (src/instances.ts).
// Unit-level, no server, no subprocess: bare `InstanceManager` and
// prototype-only `Instance` stand-ins (Object.create(Instance.prototype), with
// _emitUi stubbed out so beginRotation/endRotation run without the ring/WS
// plumbing a real constructor sets up).
//
// The completeness claim under test: bare `liveForSession` (proc-attached only)
// reads FALSE during two windows where the worker is genuinely coming up — a
// resume in flight before its registry entry exists, and a prune's
// kill-then-relaunch window. isSessionLive must read TRUE in both, or the
// liveness authority just moves the race instead of closing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager, Instance } from '../src/instances.ts';

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
