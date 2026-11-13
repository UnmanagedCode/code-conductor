// POST /api/admin/shutdown (src/routes.ts → runRestart action 'shutdown'): it
// drains like a restart, finishes into a gated manifest, removes the running
// record and exits through exitForShutdown — never through the relaunch — and
// it shares the restart's refusals. The exit itself is a stub, so nothing here
// exits; networking does go down, so each case boots its own server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, waitFor, api } from './helpers.mjs';
import { exitAfterShutdown } from '../src/restart.ts';
import { SUPERVISED_SHUTDOWN_EXIT } from '../src/restartSupervisor.ts';
import { readResumeManifest, runningRecordPath, readRunningRecord } from '../src/resumeManifest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The first prompt leaves the session in 'turn'; the drain's interrupt ends it.
const DRAIN = path.join(__dirname, 'fixtures', 'scenario-drain.json');
const QUIET = { log() {}, warn() {}, error() {} };

const lines = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const post = (base, p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const inSync = (over = {}) => ({ drift: () => null, installDeps: async () => {}, stageWeb: async () => {}, ...over });

// A server whose relaunch steps are recorded: `spawned` for the restart's
// relaunch, `exits` for the codes the shutdown's real exit logic chose.
async function boot({ supervised = false, headless = false, prep = inSync() } = {}) {
  const spawned = [];
  const exits = [];
  const ctx = await bootServer({
    scenarioPath: DRAIN,
    relaunch: {
      flags: { buildWeb: true, syncDeps: true }, prep, supervised, headless,
      spawnAndExit: () => { spawned.push('spawn'); },
      exitForShutdown: (opts) => exitAfterShutdown({ ...opts, log: QUIET, exit: (code) => exits.push(code) }),
    },
  });
  return { ctx, spawned, exits };
}

// Invariant: shutdown drains like a restart (the busy session is a wasBusy entry
// of a gated manifest), removes the running record and keeps it removed while the
// CLIs close (the recorder is paused), and exits 0 — or 76 under a supervisor —
// without ever relaunching.
for (const [supervised, code] of [[false, 0], [true, SUPERVISED_SHUTDOWN_EXIT]]) {
  test(`shutdown (supervised:${supervised}) drains into a gated manifest, removes the record and exits ${code} without relaunching`, async (t) => {
    const { ctx, spawned, exits } = await boot({ supervised });
    t.after(() => ctx.close());
    const { instances } = ctx;
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'off' });
    const inst = await instances.create({ project: 'off' });
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    void inst.prompt('stay busy');
    await waitFor(() => inst.status === 'turn');
    ctx.runningRecorder.start();
    assert.ok(readRunningRecord({ log: QUIET }), 'premise: the record exists while cc runs');

    const body = await lines(await post(ctx.baseUrl, '/api/admin/shutdown'));
    assert.deepEqual(body.filter((l) => l.type === 'chunk').map((l) => l.phase), ['drain']);
    assert.deepEqual(body.at(-1), { type: 'result', ok: true });
    await waitFor(() => exits.length === 1);
    assert.deepEqual(exits, [code]);
    assert.deepEqual(spawned, []);
    const manifest = readResumeManifest({ log: QUIET });
    assert.equal(manifest.deliver, 'gated');
    assert.deepEqual(manifest.instances.map((e) => [e.sessionId, e.wasBusy]), [[inst.sessionId, true]]);
    await waitFor(() => inst.proc === null, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 400)); // past the recorder's debounce
    assert.equal(fs.existsSync(runningRecordPath()), false, 'the closing CLIs do not write the record back');
  });
}

// Invariant: shutdown shares the restart's refusals — a headless run refuses it
// before any step, and a restart in progress refuses it as MAINTENANCE_IN_PROGRESS.
test('headless refuses 409 SHUTDOWN_DISABLED_HEADLESS; a restart in progress refuses 409 MAINTENANCE_IN_PROGRESS', async (t) => {
  {
    const { ctx, exits } = await boot({ headless: true });
    t.after(() => ctx.close());
    const res = await post(ctx.baseUrl, '/api/admin/shutdown');
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'shutdown is disabled in headless mode', code: 'SHUTDOWN_DISABLED_HEADLESS' });
    assert.deepEqual(exits, []);
  }
  {
    let entered;
    let release;
    const inStage = new Promise((r) => { entered = r; });
    const { ctx, exits, spawned } = await boot({ prep: inSync({ stageWeb: () => { entered(); return new Promise((r) => { release = r; }); } }) });
    t.after(() => ctx.close());
    const restart = post(ctx.baseUrl, '/api/admin/restart');
    await inStage;
    const res = await post(ctx.baseUrl, '/api/admin/shutdown');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'MAINTENANCE_IN_PROGRESS');
    release();
    assert.deepEqual((await lines(await restart)).at(-1), { type: 'result', ok: true });
    assert.deepEqual(exits, [], 'the refused shutdown never exits');
    assert.deepEqual(spawned, ['spawn']);
  }
});

// Invariant: with no live session a shutdown still exits, writing no manifest.
test('a shutdown with no live session exits and writes no manifest', async (t) => {
  const { ctx, exits } = await boot();
  t.after(() => ctx.close());
  assert.deepEqual((await lines(await post(ctx.baseUrl, '/api/admin/shutdown'))).at(-1), { type: 'result', ok: true });
  await waitFor(() => exits.length === 1);
  assert.equal(readResumeManifest({ log: QUIET }).present, false);
});
