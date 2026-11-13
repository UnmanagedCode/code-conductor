// runRestart (src/restart.ts): the order a restart prepares, drains, tears down
// and respawns in, the order a shutdown drains and exits in, and what a failed
// step leaves running. Every collaborator is a stub recording into one ordered
// log; spawnAndExit and exitForShutdown are stubs, so nothing here spawns or
// exits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshProjectsRoot } from './helpers.mjs';
import { runRestart, spawnReplacementAndExit, exitAfterShutdown } from '../src/restart.ts';
import { SUPERVISED_RESTART_EXIT, SUPERVISED_SHUTDOWN_EXIT } from '../src/restartSupervisor.ts';
import { ROOT_LOCK_HANDOVER_ENV } from '../src/rootLock.ts';
import { EventEmitter } from 'node:events';
import { resumeManifestPath, clearResumeManifest, readResumeManifest, runningRecordPath, writeRunningRecord } from '../src/resumeManifest.ts';
import { RESTART_ABORTED_LEAD } from '../shared/injectedTurns.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

await freshProjectsRoot();
const QUIET = { log() {}, warn() {}, error() {} };
// What the stub recorder reports as the live CLIs.
const RECORDED_CLIS = [{ sessionId: 'a-session', pid: 4321, start: 't0', group: false }];

function rig({ drift = null, installFails = false, stageFails = false, clis = RECORDED_CLIS } = {}) {
  const order = [];
  const chunks = [];
  const prep = {
    drift: () => { order.push('drift'); return drift; },
    installDeps: async (onChunk) => {
      order.push('installDeps');
      onChunk('added 1 package\n');
      if (installFails) throw Object.assign(new Error('npm install failed (exit 1)'), { tail: 'npm ERR!' });
    },
    stageWeb: async (onChunk) => {
      order.push('stageWeb');
      onChunk('vite output\n');
      if (stageFails) throw new Error('vite build failed (exit 1)');
    },
  };
  const server = { close() { order.push('server.close'); } };
  const wss = { clients: new Set([{ terminate() { order.push('ws.terminate'); } }]), close() { order.push('wss.close'); } };
  const recorder = { pause() { order.push('recorder.pause'); }, resume() { order.push('recorder.resume'); }, clis: () => clis };
  const exits = [];
  const run = (action, ctx, flags = { buildWeb: true, syncDeps: true }, extra = {}) => runRestart({
    action, flags, prep, recorder,
    ctx: { server, wss, log: QUIET, graceMs: 2000, ...ctx },
    onChunk: (phase, text) => chunks.push([phase, text]),
    onCommit: () => order.push('commit'),
    spawnAndExit: () => order.push('spawn'),
    exitForShutdown: (opts) => { order.push('exit'); exits.push(opts); },
    ...extra,
  });
  return { order, chunks, run, exits };
}

// A live instance the drain can wind down: interrupt() leaves the turn on the
// next tick, logging `idle:<id>` as the status event fires.
function liveInstance(order, { id, status, conducted = false, project = 'p' }) {
  const listeners = new Set();
  const inst = {
    id, sessionId: `${id}-session`, project, proc: {}, status, conducted, prompts: [],
    backgroundJobs: [], activeAgentTaskCount: 0,
    on(_ev, fn) { listeners.add(fn); },
    off(_ev, fn) { listeners.delete(fn); },
    async interrupt() {
      order.push(`interrupt:${id}`);
      setImmediate(() => { inst.status = 'idle'; order.push(`idle:${id}`); for (const fn of [...listeners]) fn({ status: 'idle' }); });
    },
    summary() { return { project, sessionId: inst.sessionId, cwd: '/w', mode: 'default', status: inst.status }; },
    async prompt(text) { inst.prompts.push(text); },
  };
  return inst;
}

function resumeInstances(order, specs, { idleCallers = [] } = {}) {
  const byId = new Map(specs.map((s) => [s.id, liveInstance(order, s)]));
  return {
    byId,
    conductedSubtreeOf: () => [],
    isIdleCaller: (id) => idleCallers.includes(id),
    suspendWakes() { order.push('suspendWakes'); },
    resumeWakes() { order.push('resumeWakes'); },
    shutdownForResumeSync() { order.push('shutdownForResumeSync'); },
  };
}

const NETWORK_DOWN = ['ws.terminate', 'wss.close', 'server.close'];

test('restart', async (t) => {
  t.beforeEach(() => clearResumeManifest());

  await t.test('in sync: stage, then the drain, then networking, the manifest and the spawn', async () => {
    const r = rig();
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }]);
    await r.run('restart', { instances });
    assert.deepEqual(r.order, ['drift', 'stageWeb', 'recorder.pause', 'suspendWakes', 'interrupt:a', 'idle:a', 'commit', ...NETWORK_DOWN, 'shutdownForResumeSync', 'spawn']);
    assert.ok(fs.existsSync(resumeManifestPath()), 'the resume manifest is written');
    assert.deepEqual(instances.byId.get('a').prompts, []);
  });

  await t.test('in sync, the stage fails: wakes are never suspended, no session is touched', async () => {
    const r = rig({ stageFails: true });
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }]);
    await assert.rejects(r.run('restart', { instances }), /vite build failed/);
    assert.deepEqual(r.order, ['drift', 'stageWeb']);
    assert.equal(fs.existsSync(resumeManifestPath()), false);
  });

  await t.test('drift: the install runs after every turn has ended and before networking goes down', async () => {
    const r = rig({ drift: { reason: 'x' } });
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }, { id: 'b', status: 'turn' }]);
    await r.run('restart', { instances });
    const at = (step) => r.order.indexOf(step);
    assert.ok(at('idle:a') < at('installDeps') && at('idle:b') < at('installDeps'), r.order.join(' '));
    assert.deepEqual(r.order.slice(at('installDeps')), ['installDeps', 'stageWeb', 'commit', ...NETWORK_DOWN, 'shutdownForResumeSync', 'spawn']);
    assert.ok(fs.existsSync(resumeManifestPath()));
  });

  for (const [label, failure] of [['the install', { installFails: true }], ['the stage after the install', { stageFails: true }]]) {
    await t.test(`drift, ${label} fails: wakes resume, busy non-workers are told, no manifest, networking up, no spawn`, async () => {
      const r = rig({ drift: { reason: 'x' }, ...failure });
      const instances = resumeInstances(r.order, [
        { id: 'busy', status: 'turn' },
        { id: 'parked', status: 'idle', project: CONDUCT_PROJECT_NAME },
        { id: 'idle', status: 'idle' },
        { id: 'worker', status: 'turn', conducted: true },
      ], { idleCallers: ['parked'] });
      await assert.rejects(r.run('restart', { instances }));
      // Invariant: an aborted restart hands the sessions back and the recorder resumes after it.
      assert.deepEqual(r.order.slice(-2), ['resumeWakes', 'recorder.resume']);
      for (const step of [...NETWORK_DOWN, 'commit', 'shutdownForResumeSync', 'spawn']) assert.ok(!r.order.includes(step), step);
      assert.equal(fs.existsSync(resumeManifestPath()), false);
      const prompted = (id) => instances.byId.get(id).prompts;
      assert.equal(prompted('busy').length, 1);
      assert.ok(prompted('busy')[0].startsWith(RESTART_ABORTED_LEAD));
      assert.equal(prompted('parked').length, 1);
      assert.ok(prompted('parked')[0].startsWith(RESTART_ABORTED_LEAD));
      assert.deepEqual(prompted('idle'), []);
      assert.deepEqual(prompted('worker'), []);
    });
  }

  await t.test('the drain is announced as its own phase', async () => {
    const r = rig();
    await r.run('restart', { instances: resumeInstances(r.order, []) });
    assert.deepEqual(r.chunks.map(([p]) => p), ['build', 'build', 'drain']);
  });

  // Invariant: the manifest carries the delivery the caller chose, and finishDrain
  // removes the running record whatever the entry count.
  for (const deliver of ['auto', 'gated']) {
    await t.test(`deliver:${deliver} reaches the manifest and the running record is removed`, async () => {
      writeRunningRecord({ instances: [], clis: [] });
      const r = rig();
      await r.run('restart', { instances: resumeInstances(r.order, [{ id: 'a', status: 'turn' }]) }, undefined, { deliver });
      assert.equal(readResumeManifest().deliver, deliver);
      // Invariant: the manifest carries the recorder's live CLIs, so a CLI outliving the stop is still reaped.
      assert.deepEqual(readResumeManifest().clis, RECORDED_CLIS);
      assert.equal(fs.existsSync(runningRecordPath()), false);
    });
  }
  // Invariant: the running record is removed only after the CLIs are stopped, so a
  // crash during the stop leaves it (beside the manifest) for the boot's orphan reap.
  await t.test('the record outlives the CLI stop: written manifest and record both exist while shutdownForResumeSync runs', async () => {
    writeRunningRecord({ instances: [], clis: [] });
    const r = rig();
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }]);
    const seen = [];
    instances.shutdownForResumeSync = () => { seen.push({ record: fs.existsSync(runningRecordPath()), manifest: fs.existsSync(resumeManifestPath()) }); };
    await r.run('restart', { instances });
    assert.deepEqual(seen, [{ record: true, manifest: true }]);
    assert.equal(fs.existsSync(runningRecordPath()), false, 'removed once the stop returned');
  });
  // Invariant: a manifest is written when the stop has an entry or a live CLI to carry, and only then.
  await t.test('with live CLIs but no entry (pristine only) the manifest still carries the CLIs', async () => {
    const r = rig();
    await r.run('restart', { instances: resumeInstances(r.order, []) });
    assert.deepEqual(readResumeManifest().instances, []);
    assert.deepEqual(readResumeManifest().clis, RECORDED_CLIS);
  });
  await t.test('with no live session the record is still removed and no manifest is written', async () => {
    writeRunningRecord({ instances: [], clis: [] });
    const r = rig({ clis: [] });
    await r.run('restart', { instances: resumeInstances(r.order, []) });
    assert.equal(fs.existsSync(runningRecordPath()), false);
    assert.equal(fs.existsSync(resumeManifestPath()), false);
  });
});

// Invariant: a shutdown prepares nothing and never relaunches; it pauses the
// recorder, drains, commits, takes networking down, finishes the drain gated, then
// exits through exitForShutdown with the lock and supervision it was handed.
test('shutdown', async (t) => {
  t.beforeEach(() => clearResumeManifest());

  await t.test('no preparation; pause, drain, commit, networking down, finish, exit — never a spawn', async () => {
    const r = rig({ drift: { reason: 'x' } });
    const rootLock = { marker: 'lock' };
    await r.run('shutdown', { instances: resumeInstances(r.order, [{ id: 'a', status: 'turn' }]) }, undefined, { rootLock, supervised: true, deliver: 'auto' });
    assert.deepEqual(r.order, ['recorder.pause', 'suspendWakes', 'interrupt:a', 'idle:a', 'commit', ...NETWORK_DOWN, 'shutdownForResumeSync', 'exit']);
    assert.deepEqual(r.chunks.map(([p]) => p), ['drain']);
    assert.equal(r.exits.length, 1);
    assert.equal(r.exits[0].rootLock, rootLock);
    assert.equal(r.exits[0].supervised, true);
    assert.equal(readResumeManifest().deliver, 'gated', 'a shutdown\'s notices are always gated');
    assert.deepEqual(readResumeManifest().clis, RECORDED_CLIS, 'a shutdown\'s manifest carries the live CLIs too');
  });

  await t.test('without instances it commits, takes networking down and exits', async () => {
    const r = rig();
    await r.run('shutdown', {});
    assert.deepEqual(r.order, ['commit', ...NETWORK_DOWN, 'exit']);
  });
});

test('flags turn steps off', async (t) => {
  await t.test('syncDeps:false never checks or installs dependencies', async () => {
    const r = rig({ drift: { reason: 'x' } });
    await r.run('restart', {}, { buildWeb: true, syncDeps: false });
    assert.deepEqual(r.order, ['stageWeb', 'commit', ...NETWORK_DOWN, 'spawn']);
  });
  await t.test('buildWeb:false never stages, with or without drift', async () => {
    const inSync = rig();
    await inSync.run('restart', {}, { buildWeb: false, syncDeps: true });
    assert.deepEqual(inSync.order, ['drift', 'commit', ...NETWORK_DOWN, 'spawn']);
    const drifted = rig({ drift: { reason: 'x' } });
    await drifted.run('restart', {}, { buildWeb: false, syncDeps: true });
    assert.deepEqual(drifted.order, ['drift', 'installDeps', 'commit', ...NETWORK_DOWN, 'spawn']);
  });
});

// ── The projects-root lock handover (src/rootLock.ts) ────────────────────────

test('runRestart hands its root lock to spawnAndExit', async () => {
  const rootLock = { marker: 'the lock' };
  let seen;
  await runRestart({
    action: 'restart', flags: { buildWeb: false, syncDeps: false },
    prep: { drift: () => null, installDeps: async () => {}, stageWeb: async () => {} },
    ctx: { log: QUIET },
    rootLock,
    spawnAndExit: (opts) => { seen = opts.rootLock; },
  });
  assert.equal(seen, rootLock);
});

// A RootLock stub recording every call into `order`; awaitAdoption resolves
// when the test calls `adopt()`.
function stubLock(order, { offer = () => true } = {}) {
  let adopt;
  const adopted = new Promise((r) => { adopt = r; });
  return {
    adopt: () => adopt(true),
    lock: {
      offerHandover(next) { order.push(['offer', next]); return offer(); },
      releaseSync() { order.push(['release']); },
      async awaitAdoption(opts) { order.push(['await', opts.timeoutMs]); return adopted; },
    },
  };
}

test('spawnReplacementAndExit: the offer precedes the spawn, the child carries the token, the exit waits for the adoption', async () => {
  const order = [];
  const { lock, adopt } = stubLock(order);
  let childEnv;
  const spawnChild = (_cmd, _args, opts) => {
    order.push(['spawn']);
    childEnv = opts.env;
    return Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
  };
  const exited = new Promise((resolve) => {
    void spawnReplacementAndExit({
      log: QUIET, rootLock: lock, spawnChild, handoverWaitMs: 1234,
      exit: (code) => { order.push(['exit', code]); resolve(); },
    });
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(order.map(([k]) => k), ['offer', 'spawn', 'await'], 'no exit before the adoption');
  const offered = order[0][1];
  assert.equal(childEnv[ROOT_LOCK_HANDOVER_ENV], offered);
  assert.equal(process.env[ROOT_LOCK_HANDOVER_ENV], undefined, 'the token goes to the child only');
  assert.deepEqual(order[2], ['await', 1234]);
  adopt();
  await exited;
  assert.deepEqual(order.at(-1), ['exit', 0]);
});

test('spawnReplacementAndExit: a spawn that throws releases the lock (dropping the offer) and does not exit', async () => {
  const order = [];
  const { lock } = stubLock(order);
  await spawnReplacementAndExit({
    log: QUIET, rootLock: lock,
    spawnChild: () => { order.push(['spawn']); throw new Error('EAGAIN'); },
    exit: (code) => order.push(['exit', code]),
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(order.map(([k]) => k), ['offer', 'spawn', 'release']);
});

for (const [label, offer] of [
  ['throws', () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); }],
  ['finds the record no longer ours', () => false],
]) {
  test(`spawnReplacementAndExit: an offer that ${label} releases the lock, relaunches without a handover and still exits`, async () => {
    const order = [];
    const { lock } = stubLock(order, { offer });
    let childEnv;
    const spawnChild = (_cmd, _args, opts) => {
      order.push(['spawn']);
      childEnv = opts.env;
      return Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
    };
    await new Promise((resolve) => {
      void spawnReplacementAndExit({
        log: QUIET, rootLock: lock, spawnChild,
        exit: (code) => { order.push(['exit', code]); resolve(); },
      });
    });
    assert.deepEqual(order.map(([k]) => k), ['offer', 'release', 'spawn', 'exit'], 'released before the spawn; no adoption wait');
    assert.equal(childEnv[ROOT_LOCK_HANDOVER_ENV], undefined, 'the child boots like any server');
    assert.deepEqual(order.at(-1), ['exit', 0]);
  });
}

// ── The supervised relaunch (src/restartSupervisor.ts) ───────────────────────

test('spawnReplacementAndExit supervised: releases the lock then exits SUPERVISED_RESTART_EXIT, with no offer, no await and no spawn', async () => {
  const order = [];
  const { lock } = stubLock(order);
  await spawnReplacementAndExit({
    log: QUIET, rootLock: lock, supervised: true,
    spawnChild: () => { throw new Error('a supervised restart must not spawn'); },
    exit: (code) => order.push(['exit', code]),
  });
  assert.deepEqual(order, [['release'], ['exit', SUPERVISED_RESTART_EXIT]]);
});

test('spawnReplacementAndExit supervised: without a root lock it still exits SUPERVISED_RESTART_EXIT and spawns nothing', async () => {
  const exits = [];
  await spawnReplacementAndExit({
    log: QUIET, supervised: true,
    spawnChild: () => { throw new Error('a supervised restart must not spawn'); },
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT]);
});

for (const [label, extra, want] of [['hands supervised:true on', { supervised: true }, true], ['defaults supervised to false', {}, false]]) {
  test(`runRestart ${label} to spawnAndExit`, async () => {
    let seen;
    await runRestart({
      action: 'restart', flags: { buildWeb: false, syncDeps: false },
      prep: { drift: () => null, installDeps: async () => {}, stageWeb: async () => {} },
      ctx: { log: QUIET },
      spawnAndExit: (opts) => { seen = opts.supervised; },
      ...extra,
    });
    assert.equal(seen, want);
  });
}

// Invariant: a shutdown releases the root lock before it exits, with 0 unsupervised
// and SUPERVISED_SHUTDOWN_EXIT under a supervisor — never the relaunch code.
for (const [supervised, want] of [[false, 0], [true, SUPERVISED_SHUTDOWN_EXIT]]) {
  test(`exitAfterShutdown (supervised:${supervised}) releases the lock, then exits ${want}`, async () => {
    const order = [];
    await exitAfterShutdown({
      log: QUIET, supervised,
      rootLock: { releaseSync() { order.push('release'); } },
      exit: (code) => order.push(['exit', code]),
    });
    assert.deepEqual(order, ['release', ['exit', want]]);
  });
}
