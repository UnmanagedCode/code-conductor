// POST /api/admin/restart's wire contract (src/routes.ts): NDJSON chunks per
// phase, one terminal result, a refusal that never relaunches, and the 409 for a
// restart already in progress. The real runRestart runs with stub preparation
// steps and a stub respawn, so nothing here installs, builds, spawns or exits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { buildRoutes } from '../src/routes.ts';
import { httpError } from '../src/httpError.ts';

async function serve(routeOpts) {
  const app = express();
  app.use('/api', buildRoutes(routeOpts));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const restart = (base, body = {}) => fetch(`${base}/api/admin/restart`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const lines = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Route options with a recording respawn and the given prep; the server
// handles are null, so tearing networking down touches nothing real.
function wired(prep, { instances = null } = {}) {
  const spawned = [];
  return {
    spawned,
    opts: {
      instances,
      serverCtx: { server: null, wss: null },
      relaunch: { flags: { buildWeb: true, syncDeps: true }, prep, spawnAndExit: () => spawned.push('spawn') },
    },
  };
}
const inSync = (over = {}) => ({ drift: () => null, installDeps: async () => {}, stageWeb: async () => {}, ...over });

test('a committed restart streams its chunks, ends with ok:true, then relaunches', async (t) => {
  const w = wired(inSync({ stageWeb: async (onChunk) => { onChunk('built\n'); } }));
  const s = await serve(w.opts);
  t.after(s.close);
  const res = await restart(s.base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const body = await lines(res);
  assert.deepEqual(body.at(-1), { type: 'result', ok: true });
  assert.deepEqual(body.filter((l) => l.type === 'chunk').at(-1), { type: 'chunk', phase: 'build', text: 'built\n' });
  assert.deepEqual(w.spawned, ['spawn']);
});

test('a refused restart streams ok:false with the error and tail, and never relaunches', async (t) => {
  const w = wired(inSync({
    stageWeb: async (onChunk) => {
      onChunk('transforming…\n');
      throw Object.assign(new Error('vite build failed (exit 1)'), { tail: 'error: Unexpected token' });
    },
  }));
  const s = await serve(w.opts);
  t.after(s.close);
  const body = await lines(await restart(s.base));
  assert.ok(body.some((l) => l.type === 'chunk' && l.phase === 'build' && l.text === 'transforming…\n'));
  assert.deepEqual(body.at(-1), { type: 'result', ok: false, error: 'vite build failed (exit 1)', tail: 'error: Unexpected token' });
  assert.deepEqual(w.spawned, []);
});

test('a refusal\'s code reaches the result line (DEPS_LINKED)', async (t) => {
  const w = wired(inSync({
    drift: () => ({ reason: 'node_modules/vite missing' }),
    installDeps: async () => { throw httpError(409, 'node_modules is a link', { code: 'DEPS_LINKED' }); },
  }));
  const s = await serve(w.opts);
  t.after(s.close);
  const body = await lines(await restart(s.base));
  assert.ok(body.some((l) => l.type === 'chunk' && l.phase === 'deps' && l.text.includes('node_modules/vite missing')));
  assert.deepEqual(body.at(-1), { type: 'result', ok: false, error: 'node_modules is a link', code: 'DEPS_LINKED' });
  assert.deepEqual(w.spawned, []);
});

test('a second restart while one is in progress is refused 409 MAINTENANCE_IN_PROGRESS as plain JSON', async (t) => {
  let release;
  let entered;
  const inStage = new Promise((r) => { entered = r; });
  const w = wired(inSync({ stageWeb: () => { entered(); return new Promise((r) => { release = r; }); } }));
  const s = await serve(w.opts);
  t.after(s.close);
  const first = restart(s.base);
  await inStage;
  const second = await restart(s.base);
  assert.equal(second.status, 409);
  assert.match(second.headers.get('content-type') ?? '', /application\/json/);
  const refusal = await second.json();
  assert.equal(refusal.code, 'MAINTENANCE_IN_PROGRESS');
  assert.match(refusal.error, /already in progress/);
  release();
  assert.deepEqual((await lines(await first)).at(-1), { type: 'result', ok: true });
  assert.deepEqual(w.spawned, ['spawn'], 'only the first relaunches');
});

test('the body\'s resume flag picks the drain; its absence the plain teardown', async (t) => {
  for (const [label, body, want] of [['resume:true', { resume: true }, 'suspendWakes'], ['no flag', {}, 'stopLiveSync']]) {
    await t.test(label, async (t) => {
      const calls = [];
      const instances = {
        byId: new Map(), conductedSubtreeOf: () => [], isIdleCaller: () => false,
        suspendWakes() { calls.push('suspendWakes'); }, resumeWakes() {}, shutdownForResumeSync() { calls.push('shutdownForResumeSync'); },
        stopLiveSync() { calls.push('stopLiveSync'); }, shutdown() {},
      };
      const w = wired(inSync(), { instances });
      const s = await serve(w.opts);
      t.after(s.close);
      assert.deepEqual((await lines(await restart(s.base, body))).at(-1), { type: 'result', ok: true });
      assert.equal(calls[0], want);
    });
  }
});

test('with no server context wired the route answers 202 and prepares nothing', async (t) => {
  let touched = false;
  const prep = { drift: () => { touched = true; return null; }, installDeps: async () => {}, stageWeb: async () => { touched = true; } };
  const s = await serve({ relaunch: { flags: { buildWeb: true, syncDeps: true }, prep, spawnAndExit: () => { touched = true; } } });
  t.after(s.close);
  const res = await restart(s.base);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(touched, false);
});
