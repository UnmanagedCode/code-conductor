// runRestart (src/restart.ts): the order a relaunch prepares, tears down and
// respawns in, and what a failed step leaves running. Every collaborator is a
// stub recording into one ordered log; spawnAndExit is a stub, so nothing here
// spawns or exits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshProjectsRoot } from './helpers.mjs';
import { runRestart } from '../src/restart.ts';
import { resumeManifestPath, clearResumeManifest } from '../src/resumeManifest.ts';
import { RESTART_ABORTED_LEAD } from '../shared/injectedTurns.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

await freshProjectsRoot();
const QUIET = { log() {}, warn() {}, error() {} };

function rig({ drift = null, installFails = false, stageFails = false } = {}) {
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
  const run = (mode, ctx, flags = { buildWeb: true, syncDeps: true }) => runRestart({
    mode, flags, prep,
    ctx: { server, wss, log: QUIET, graceMs: 2000, ...ctx },
    onChunk: (phase, text) => chunks.push([phase, text]),
    onCommit: () => order.push('commit'),
    spawnAndExit: () => order.push('spawn'),
  });
  return { order, chunks, run };
}

// The plain path's instance surface: stopLiveSync marks teardownInstances.
const plainInstances = (order) => ({ stopLiveSync() { order.push('teardownInstances'); }, shutdown() {} });

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

test('plain restart', async (t) => {
  await t.test('in sync: the web build is staged before anything is torn down, then networking, then the spawn', async () => {
    const r = rig();
    await r.run('plain', { instances: plainInstances(r.order) });
    assert.deepEqual(r.order, ['drift', 'stageWeb', 'teardownInstances', 'commit', ...NETWORK_DOWN, 'spawn']);
    assert.deepEqual(r.chunks.map(([p]) => p), ['build', 'build']);
    assert.deepEqual(r.chunks[1], ['build', 'vite output\n']);
  });

  await t.test('in sync, the stage fails: nothing is torn down, nothing spawned, the error propagates', async () => {
    const r = rig({ stageFails: true });
    await assert.rejects(r.run('plain', { instances: plainInstances(r.order) }), /vite build failed/);
    assert.deepEqual(r.order, ['drift', 'stageWeb']);
  });

  await t.test('drift: the instances go first, then install, stage, networking, spawn', async () => {
    const r = rig({ drift: { reason: 'node_modules/vite missing' } });
    await r.run('plain', { instances: plainInstances(r.order) });
    assert.deepEqual(r.order, ['drift', 'teardownInstances', 'installDeps', 'stageWeb', 'commit', ...NETWORK_DOWN, 'spawn']);
    assert.match(r.chunks[0][1], /node_modules\/vite missing/);
    assert.deepEqual(r.chunks.slice(0, 2), [['deps', r.chunks[0][1]], ['npm', 'added 1 package\n']]);
  });

  await t.test('drift, the install fails: instances are down, networking stays up, nothing spawns', async () => {
    const r = rig({ drift: { reason: 'x' }, installFails: true });
    await assert.rejects(r.run('plain', { instances: plainInstances(r.order) }), (e) => e.tail === 'npm ERR!');
    assert.deepEqual(r.order, ['drift', 'teardownInstances', 'installDeps']);
  });

  await t.test('drift, the stage after the install fails: networking stays up, nothing spawns', async () => {
    const r = rig({ drift: { reason: 'x' }, stageFails: true });
    await assert.rejects(r.run('plain', { instances: plainInstances(r.order) }), /vite build failed/);
    assert.deepEqual(r.order, ['drift', 'teardownInstances', 'installDeps', 'stageWeb']);
  });
});

test('resume restart', async (t) => {
  t.beforeEach(() => clearResumeManifest());

  await t.test('in sync: stage, then the drain, then networking, the manifest and the spawn', async () => {
    const r = rig();
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }]);
    await r.run('resume', { instances });
    assert.deepEqual(r.order, ['drift', 'stageWeb', 'suspendWakes', 'interrupt:a', 'idle:a', 'commit', ...NETWORK_DOWN, 'shutdownForResumeSync', 'spawn']);
    assert.ok(fs.existsSync(resumeManifestPath()), 'the resume manifest is written');
    assert.deepEqual(instances.byId.get('a').prompts, []);
  });

  await t.test('in sync, the stage fails: wakes are never suspended, no session is touched', async () => {
    const r = rig({ stageFails: true });
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }]);
    await assert.rejects(r.run('resume', { instances }), /vite build failed/);
    assert.deepEqual(r.order, ['drift', 'stageWeb']);
    assert.equal(fs.existsSync(resumeManifestPath()), false);
  });

  await t.test('drift: the install runs after every turn has ended and before networking goes down', async () => {
    const r = rig({ drift: { reason: 'x' } });
    const instances = resumeInstances(r.order, [{ id: 'a', status: 'turn' }, { id: 'b', status: 'turn' }]);
    await r.run('resume', { instances });
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
      await assert.rejects(r.run('resume', { instances }));
      assert.equal(r.order.at(-1), 'resumeWakes');
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
    await r.run('resume', { instances: resumeInstances(r.order, []) });
    assert.deepEqual(r.chunks.map(([p]) => p), ['build', 'build', 'drain']);
  });
});

test('flags turn steps off', async (t) => {
  await t.test('syncDeps:false never checks or installs dependencies', async () => {
    const r = rig({ drift: { reason: 'x' } });
    await r.run('plain', { instances: plainInstances(r.order) }, { buildWeb: true, syncDeps: false });
    assert.deepEqual(r.order, ['stageWeb', 'teardownInstances', 'commit', ...NETWORK_DOWN, 'spawn']);
  });
  await t.test('buildWeb:false never stages, with or without drift', async () => {
    const inSync = rig();
    await inSync.run('plain', { instances: plainInstances(inSync.order) }, { buildWeb: false, syncDeps: true });
    assert.deepEqual(inSync.order, ['drift', 'teardownInstances', 'commit', ...NETWORK_DOWN, 'spawn']);
    const drifted = rig({ drift: { reason: 'x' } });
    await drifted.run('plain', { instances: plainInstances(drifted.order) }, { buildWeb: false, syncDeps: true });
    assert.deepEqual(drifted.order, ['drift', 'teardownInstances', 'installDeps', 'commit', ...NETWORK_DOWN, 'spawn']);
  });
});
