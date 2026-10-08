// "Change model" by restart: every pair but Claude→Claude — within a
// substitution backend, or across backends either way — kills the CLI and
// resumes the same session on the target pair (Instance.switchModel →
// _runRestartSwitch), confirmed by the relaunch outliving a grace window. Covers
// the WS frame's dispatch and refusals, the relaunch argv/env/record, the
// failure path (re-resumed on the old pair), prompt refusal across the whole
// switch, temp/conducted survival, the no-turn `--session-id` relaunch, the
// graceful-restart drain, and the session record a cold resume reads.
//
// The fake CLI writes no transcript, so a "session with a turn" is seeded with a
// jsonl the real CLI would have written (uuid'd user/assistant lines).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { SwitchLauncher } from './switchLauncher.mjs';
import { addCustomModel, setTierBackend, setTierEffort, addBackend, setConductorCompactWindow } from '../src/appSettings.ts';
import { getSessionBackend, getModelSwitchesForSegment, isTemp, isArchived, isConducted, settleSessionWrites, sessionsFile } from '../src/sessionStore.ts';
import { withLock } from '../src/storeLock.ts';
import { loadPersistedTranscript, readLastSessionModel } from '../src/transcript.ts';
import { costsPath } from '../src/costTracking.ts';
import { sendPrompt, describeSession } from '../src/mcp/handlers.ts';
import { drainToManifest } from '../src/resumeRestart.ts';
import { OLLAMA_CLOUD_MODELS } from '../src/ollamaCloudModels.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Turn 1 completes; turn 2 streams and never ends on its own (a running turn).
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const A = 'alpha:cloud';
const B = 'beta:cloud';
const QUIET = { warn() {}, info() {}, log() {}, error() {} };

let ctx, baseUrl, wsUrl, instances, launcher, home;

before(async () => {
  launcher = new SwitchLauncher();
  ctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
  ({ baseUrl, wsUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  launcher.plan = [];
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  await addCustomModel({ label: 'Alpha', model: A, backend: 'ollama', contextWindow: 100_000 });
  await addCustomModel({ label: 'Beta', model: B, backend: 'ollama', contextWindow: 300_000 });
  await setTierBackend('fast', { backend: 'ollama', model: A });
  await setTierBackend('balanced', { backend: 'ollama', model: B });
  await setTierEffort('fast', 'medium');
  await setTierEffort('balanced', 'low');
});
afterEach(async () => { await instances.shutdown(); await settleSessionWrites(); await rmrf(home); });

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.once('open', () => resolve({
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 8000) { return waitFor(() => messages.find(predicate), { timeout }); },
    }));
    ws.once('error', reject);
  });
}

// A substitution session on A, idle, with a short confirmation window.
async function spawnSub(extra = {}) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: A, backend: 'ollama', effort: 'high', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst._relaunchGraceMs = 30;
  return inst;
}

// An identity Claude session on Haiku, idle, with a short confirmation window.
const HAIKU = 'claude-haiku-4-5';
async function spawnClaude(extra = {}) {
  return spawnSub({ model: HAIKU, backend: 'claude', ...extra });
}

// The Claude tier a cross switch lands on: Sonnet 4.6, whose catalog launch tag
// (`[1m]`) shows the target is canonicalized against the TARGET backend.
const SONNET = 'claude-sonnet-4-6';
const SONNET_1M = 'claude-sonnet-4-6[1m]';
async function bindFrontierToSonnet() {
  await setTierBackend('frontier', { backend: 'claude', model: SONNET });
  await setTierEffort('frontier', 'xhigh');
}

// A second substitution backend with one registered model.
const MINE = 'mine:v2';
const PROXY_TEMPLATE = ['proxyctl', 'exec', 'claude', '--model'];
async function addProxy() {
  await addBackend({ id: 'my-proxy', label: 'My Proxy', template: 'proxyctl exec claude --model {model} --' });
  await addCustomModel({ label: 'Mine', model: MINE, backend: 'my-proxy', contextWindow: 200_000 });
}

// A cold resume through the REST surface: no instance left in memory, so every
// fact comes from the session record and the jsonl.
async function coldResume(sessionId) {
  await settleSessionWrites();
  await instances.shutdown();
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', resume: sessionId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// What the CLI would have persisted after one turn: anchor `a1` is the last line.
const TURN = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: A, content: [{ type: 'text', text: 'hi' }] } },
];
async function seedTurn(inst) { await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId, TURN); }
// The same turn with the usage the CLI persists: a 190k prompt on the old model.
const OLD_USAGE = { input_tokens: 10_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0, output_tokens: 50 };
async function seedTurnWithUsage(inst) {
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId,
    [TURN[0], { ...TURN[1], message: { ...TURN[1].message, usage: OLD_USAGE } }]);
}
// Inside the grace window: the relaunch on B is up and idle, the switch not yet confirmed.
const inGrace = (inst) => waitFor(() => inst.proc && inst.status === 'idle' && inst.modelSwitch && inst.model === B);

async function frame(c, inst, tier, reqId) {
  c.send({ t: 'model', id: inst.id, tier, reqId });
  return c.wait(m => m.t === 'ack' && m.reqId === reqId);
}

// The `{model, backend}` form: a model by id, on the backend it is registered on.
async function modelFrame(c, inst, model, backend, reqId) {
  c.send({ t: 'model', id: inst.id, model, backend, reqId });
  return c.wait(m => m.t === 'ack' && m.reqId === reqId);
}

async function settled(inst) {
  await waitFor(() => inst._modelSwitchRun !== null);
  await inst._modelSwitchRun;
}

const ringOf = (inst) => inst.ringSnapshot();
const restartDividers = (evs) => evs.filter(e => e.kind === 'system' && e.subtype === 'model_changed' && e.data?.restart);
const failDividers = (evs) => evs.filter(e => e.kind === 'system' && e.subtype === 'model_switch_failed');
const argOf = (argv, flag) => argv[argv.lastIndexOf(flag) + 1];

test('a same-backend switch resumes the same session on the new model', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  const { id, sessionId, backingSessionId } = inst;
  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    const ack = await frame(c, inst, 'balanced', 'm1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
    assert.equal(instances.get(id), inst, 'the same instance object, under the same instance id');
    assert.equal(inst.sessionId, sessionId);
    assert.equal(inst.backingSessionId, backingSessionId);
    assert.equal(inst.status, 'idle');
    assert.ok(inst.proc, 'running again');
    const argv = inst._spawnArgv;
    assert.equal(argOf(argv, '--resume'), backingSessionId, 'resumed, not a fresh session');
    assert.ok(!argv.includes('--session-id'));
    const modelArgs = argv.flatMap((a, i) => (a === '--model' ? [argv[i + 1]] : []));
    assert.deepEqual(modelArgs, [B, B], 'both the template slot and the forwarded --model name the new model');
    assert.equal(inst.model, B);
    assert.equal(inst.contextWindowTokens, 300_000);
    assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
    assert.equal(inst._spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
    assert.deepEqual(await getSessionBackend(sessionId), { backend: 'ollama', model: B, contextWindowTokens: 300_000 });
    assert.equal(inst.summary().modelSwitch, null);
    assert.equal(inst.summary().modelSwitchFailure, null);
    // The settling status frame: the switch has cleared and it names the new model.
    const status = await c.wait(m => m.t === 'status' && m.id === id && m.modelSwitch === null && m.model === B);
    assert.equal(status.modelSwitchFailure, null);
  } finally { await c.close(); }
});

test('the switch applies the picked tier\'s effort', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  assert.equal(inst.effort, 'high');
  const c = await wsClient(wsUrl);
  try {
    assert.equal((await frame(c, inst, 'balanced', 'e1')).ok, true);
    await settled(inst);
    assert.equal(inst.effort, 'low');
    assert.equal(argOf(inst._spawnArgv, '--effort'), 'low');
  } finally { await c.close(); }
});

test('a switch frame during a running turn is refused and kills nothing', async () => {
  const inst = await spawnSub();
  await inst.prompt('one');
  await waitFor(() => inst.status === 'idle' && ringOf(inst).some(e => e.kind === 'turn_end'));
  await inst.prompt('two'); // never ends on its own
  await waitFor(() => inst.status === 'turn');
  const launches = launcher.count;
  const proc = inst.proc;
  const c = await wsClient(wsUrl);
  try {
    const ack = await frame(c, inst, 'balanced', 'b1');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /running turn/);
    assert.equal(launcher.count, launches, 'no relaunch');
    assert.equal(inst.proc, proc, 'the running process was not killed');
    assert.equal(inst.model, A);
    assert.equal(inst.effort, 'high');
    assert.equal(inst._mutating, null, 'nothing was claimed');
  } finally { await c.close(); }
});

test('a switch is refused while background agent tasks or bash jobs run', async () => {
  const inst = await spawnSub();
  const launches = launcher.count;
  inst._activeAgentTasks.set('task-1', null);
  await assert.rejects(inst.switchModel({ model: B, backend: 'ollama', effort: 'low' }),
    e => e.statusCode === 409 && e.code === 'SESSION_BUSY' && /background work/.test(e.message));
  inst._activeAgentTasks.clear();
  inst._backgroundJobs.set('job-1', { id: 'job-1' });
  await assert.rejects(inst.switchModel({ model: B, backend: 'ollama', effort: 'low' }),
    e => e.statusCode === 409 && e.code === 'SESSION_BUSY');
  inst._backgroundJobs.clear();
  assert.equal(launcher.count, launches);
  assert.equal(inst.model, A);
  assert.equal(inst.effort, 'high');
});

test('a {model, backend} frame restarts onto a registered model no tier binds, keeping the session\'s effort', async () => {
  const G = 'gamma:cloud';
  await addCustomModel({ label: 'Gamma', model: G, backend: 'ollama', contextWindow: 200_000 });
  const inst = await spawnSub();
  await seedTurn(inst);
  const { id, sessionId, backingSessionId } = inst;
  const c = await wsClient(wsUrl);
  try {
    const ack = await modelFrame(c, inst, G, 'ollama', 'g1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
    assert.equal(instances.get(id), inst);
    assert.equal(inst.sessionId, sessionId);
    assert.equal(argOf(inst._spawnArgv, '--resume'), backingSessionId, 'the same session, resumed');
    const modelArgs = inst._spawnArgv.flatMap((a, i) => (a === '--model' ? [inst._spawnArgv[i + 1]] : []));
    assert.deepEqual(modelArgs, [G, G]);
    assert.equal(inst.model, G);
    assert.deepEqual(await getSessionBackend(sessionId), { backend: 'ollama', model: G, contextWindowTokens: 200_000 });
    assert.equal(inst.effort, 'high', 'no tier was picked, so no tier\'s effort applies');
    assert.equal(argOf(inst._spawnArgv, '--effort'), 'high');
  } finally { await c.close(); }
});

test('a {model, backend} frame naming a curated ollama preset with no custom row is accepted', async () => {
  const preset = OLLAMA_CLOUD_MODELS.at(-1).model;
  const inst = await spawnSub();
  await seedTurn(inst);
  const c = await wsClient(wsUrl);
  try {
    const ack = await modelFrame(c, inst, preset, 'ollama', 'k1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
    assert.equal(inst.model, preset);
  } finally { await c.close(); }
});

test('a model frame is refused, with nothing restarted, unless it names exactly one valid target', async (t) => {
  await addProxy();
  const cases = [
    ['a model registered only on another backend', { model: 'mine:v2', backend: 'ollama' }, /'mine:v2' is not registered on backend 'ollama'/],
    ['an unknown model id', { model: 'ghost:v9', backend: 'ollama' }, /'ghost:v9' is not registered on backend 'ollama'/],
    ['a Claude id outside the catalog', { model: 'claude-nope', backend: 'claude' }, /'claude-nope' is not registered on backend 'claude'/],
    ['a model with no backend', { model: B }, /a model pick names its backend/],
    ['a tier with a backend', { tier: 'balanced', backend: 'ollama' }, /a tier pick names no backend/],
    ['a removed backend', { model: B, backend: 'ghost' }, /backend 'ghost' no longer exists/],
    ['both a tier and a model', { tier: 'balanced', model: B, backend: 'ollama' }, /exactly one/],
    ['neither a tier nor a model', {}, /exactly one/],
  ];
  for (const [name, target, error] of cases) {
    await t.test(name, async () => {
      const inst = await spawnSub();
      const launches = launcher.count;
      const c = await wsClient(wsUrl);
      try {
        c.send({ t: 'model', id: inst.id, ...target, reqId: 'r1' });
        const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'r1');
        assert.equal(ack.ok, false);
        assert.match(ack.error, error);
        assert.equal(launcher.count, launches, 'no relaunch');
        assert.equal(inst.model, A);
        assert.equal(inst._mutating, null);
      } finally { await c.close(); await inst.kill(); }
    });
  }
});

test('a live switch frame on a Claude session during a running turn is refused, and nothing reaches the CLI', async () => {
  await setTierBackend('frontier', { backend: 'claude', model: 'claude-opus-4-8' });
  // The fake engine appends every stdin line it receives here; set before launch.
  const stdinLog = path.join(home, 'stdin.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = stdinLog;
  let inst;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-haiku-4-5' });
    inst = instances.get(r.body.id);
  } finally { delete process.env.FAKE_CLAUDE_TRANSCRIPT; }
  const controlRequests = async () => {
    let raw = '';
    try { raw = await fs.readFile(stdinLog, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(o => o.type === 'control_request').map(o => o.request?.subtype);
  };
  await waitFor(() => inst.status === 'idle');
  await inst.prompt('one');
  await waitFor(() => inst.status === 'idle' && ringOf(inst).some(e => e.kind === 'turn_end'));
  await inst.prompt('two'); // never ends on its own
  await waitFor(() => inst.status === 'turn');
  const model = inst.model;
  const proc = inst.proc;
  const c = await wsClient(wsUrl);
  try {
    const ack = await frame(c, inst, 'frontier', 'lt1');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /running turn/);
    assert.equal(inst.model, model);
    assert.equal(inst.proc, proc);
    await assert.rejects(inst.setModel('claude-opus-4-8'), e => e.statusCode === 409 && e.code === 'SESSION_BUSY');
    assert.equal(inst.model, model);
    // Anchor the "nothing written" read on a control_request that DID go out
    // after both refusals: stdin is one ordered stream, so a set_model written
    // by either refusal would already be in the log ahead of it.
    await inst.interrupt({ force: true });
    await waitFor(async () => (await controlRequests()).includes('interrupt'));
    assert.deepEqual((await controlRequests()).filter(st => st === 'set_model'), [],
      'no set_model control_request reached the CLI');
  } finally { await c.close(); }
});

test('a second frame while a switch is in flight is refused — one restart only', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 300;
  const launches = launcher.count;
  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'model', id: inst.id, tier: 'balanced', reqId: 's1' });
    c.send({ t: 'model', id: inst.id, tier: 'balanced', reqId: 's2' });
    const [a1, a2] = [await c.wait(m => m.t === 'ack' && m.reqId === 's1'), await c.wait(m => m.t === 'ack' && m.reqId === 's2')];
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, false);
    assert.match(a2.error, /in progress/);
    await settled(inst);
    assert.equal(launcher.count, launches + 1, 'exactly one relaunch');
    assert.equal((await getModelSwitchesForSegment(inst.backingSessionId)).length, 1);
  } finally { await c.close(); }
});

test('re-selecting the running model is a no-op: no restart, no ledger entry, no divider', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  const launches = launcher.count;
  const proc = inst.proc;
  const c = await wsClient(wsUrl);
  try {
    const ack = await frame(c, inst, 'fast', 'n1');
    assert.equal(ack.ok, true);
    assert.equal(launcher.count, launches);
    assert.equal(inst.proc, proc);
    assert.equal(inst.effort, 'high', 'effort is untouched on a no-op');
    assert.equal(inst._modelSwitchRun, null);
    assert.deepEqual(await getModelSwitchesForSegment(inst.backingSessionId), []);
    assert.equal(ringOf(inst).filter(e => e.subtype === 'model_changed').length, 0);
  } finally { await c.close(); }
});

test('the ack arrives once the switch is accepted, before it settles', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 400;
  const c = await wsClient(wsUrl);
  try {
    c.send({ t: 'subscribe', id: inst.id });
    await c.wait(m => m.t === 'snapshot');
    const ack = await frame(c, inst, 'balanced', 'k1');
    assert.equal(ack.ok, true);
    const sw = { from: A, to: B, fromBackend: 'ollama', toBackend: 'ollama' };
    assert.deepEqual(inst.summary().modelSwitch, sw, 'still switching when the ack lands');
    const statusMid = await c.wait(m => m.t === 'status' && m.id === inst.id && m.modelSwitch);
    assert.deepEqual(statusMid.modelSwitch, sw);
    await settled(inst);
  } finally { await c.close(); }
});

test('a crash inside the grace window re-resumes on the old model with its effort and record', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  launcher.plan.push({ crash: `Error: model '${B}' not found` });
  const c = await wsClient(wsUrl);
  try {
    assert.equal((await frame(c, inst, 'balanced', 'f1')).ok, true);
    await settled(inst);
    assert.equal(inst.model, A);
    assert.equal(inst.effort, 'high');
    assert.equal(inst.contextWindowTokens, 100_000);
    assert.equal(inst.status, 'idle');
    assert.ok(inst.proc, 'running on the old model again');
    assert.equal(argOf(inst._spawnArgv, '--resume'), inst.backingSessionId);
    assert.equal(argOf(inst._spawnArgv, '--model'), A);
    assert.equal(argOf(inst._spawnArgv, '--effort'), 'high');
    assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'ollama', model: A, contextWindowTokens: 100_000 });
    const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].ok, false);
    assert.equal(ledger[0].error, `Error: model '${B}' not found`);
    assert.equal(ledger[0].afterUuid, 'a1');
    const ring = ringOf(inst);
    assert.equal(failDividers(ring).length, 1, 'the failure divider exactly once');
    assert.equal(failDividers(ring)[0].data.error, `Error: model '${B}' not found`);
    assert.equal(restartDividers(ring).length, 0, 'no success divider');
    assert.deepEqual(inst.summary().modelSwitchFailure,
      { from: A, to: B, fromBackend: 'ollama', toBackend: 'ollama', error: `Error: model '${B}' not found` });
    assert.equal(instances.exitCauseFor(inst.sessionId), null, 'the attempt\'s crash is not an exit cause');
    // Cleared at the next turn start.
    await inst.prompt('again');
    assert.equal(inst.summary().modelSwitchFailure, null);
  } finally { await c.close(); }
});

test('a relaunch that never starts reports its spawn error', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  launcher.plan.push({ failSpawn: 'spawn ollama ENOENT' });
  assert.deepEqual(await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' }), { restart: true });
  await settled(inst);
  assert.equal(inst.model, A);
  assert.equal(inst.summary().modelSwitchFailure.error, 'spawn ollama ENOENT');
  assert.ok(inst.proc);
});

test('when the re-resume also fails the session is left crashed and recorded on the old model', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  launcher.plan.push({ crash: 'boom on beta' }, { crash: 'boom on alpha' });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.status, 'crashed');
  assert.equal(inst.proc, null);
  assert.equal(inst.model, A);
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'ollama', model: A, contextWindowTokens: 100_000 });
  const failure = inst.summary().modelSwitchFailure;
  assert.match(failure.error, /boom on beta/);
  assert.match(failure.error, /resuming on alpha:cloud also failed: boom on alpha/);
  assert.equal(inst.summary().modelSwitch, null);
  assert.equal(instances.get(inst.id), inst, 'still listed, so a manual Resume is one click away');
});

test('a Terminate during the grace window is a stop: cancelled, not failed, and not re-resumed', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 5000;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inGrace(inst);
  const launches = launcher.count;
  await inst.kill();
  await settled(inst);
  assert.equal(launcher.count, launches, 'not relaunched');
  assert.equal(inst.proc, null);
  assert.equal(inst.model, A);
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'ollama', model: A, contextWindowTokens: 100_000 });
  assert.equal(inst.summary().modelSwitchFailure, null, 'a stop is not a failure — no failure chip');
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].ok, false);
  assert.equal(ledger[0].cancelled, true);
  assert.equal(ledger[0].error, undefined);
  const cancelled = failDividers(ringOf(inst));
  assert.equal(cancelled.length, 1, 'the cancellation reaches the live conversation once');
  assert.equal(cancelled[0].data.cancelled, true);
  // A later replay (here: what a manual Resume reads) carries it once, cancelled.
  const replay = (await loadPersistedTranscript({ place: inst.transcriptPlace, sessionId: inst.backingSessionId })).lines.flatMap(l => l.events);
  assert.deepEqual(failDividers(replay).map(e => e.data.cancelled), [true]);
});

test('a prompt during the switch is refused on every surface and never delivered', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 600;
  const gap = [];
  // The process-less gap: the old process's exit, before the relaunch spawns.
  const onStatus = (s) => {
    if (inst.modelSwitch && !inst.proc && (s.status === 'exited' || s.status === 'crashed') && gap.length === 0) {
      gap.push(sendPrompt({ sessionId: inst.sessionId, text: 'gap' }, { instances }));
      gap.push(inst.prompt('gap').then(() => null, e => e));
    }
  };
  inst.on('status', onStatus);
  const c = await wsClient(wsUrl);
  try {
    assert.equal((await frame(c, inst, 'balanced', 'p1')).ok, true);
    await waitFor(() => gap.length === 2);
    const [mcpGap, promptGap] = await Promise.all(gap);
    assert.equal(mcpGap.ok, false);
    assert.equal(mcpGap.code, 'SESSION_SWITCHING_MODEL', 'not SESSION_NOT_LIVE with resume advice');
    assert.equal(mcpGap.from, A);
    assert.equal(mcpGap.to, B);
    assert.equal(promptGap?.statusCode, 409);

    // The grace window: alive and idle on the unconfirmed model.
    await waitFor(() => inst.proc && inst.status === 'idle' && inst.modelSwitch);
    c.send({ t: 'prompt', id: inst.id, text: 'grace', reqId: 'p2' });
    const ack = await c.wait(m => m.t === 'ack' && m.reqId === 'p2');
    assert.equal(ack.ok, false);
    assert.match(ack.error, /switching model/);
    await assert.rejects(inst.prompt('grace'), e => e.statusCode === 409 && /switching model/.test(e.message));
    const mcpGrace = await sendPrompt({ sessionId: inst.sessionId, text: 'grace' }, { instances });
    assert.equal(mcpGrace.code, 'SESSION_SWITCHING_MODEL');
    assert.ok(inst.modelSwitch, 'still inside the switch — the refusals above were not after it');
    await settled(inst);
    assert.deepEqual(ringOf(inst).filter(e => e.kind === 'user_echo').map(e => e.text), ['hello'],
      'only the seeded turn\'s replayed prompt — none of the refused ones reached the CLI');
  } finally { inst.off('status', onStatus); await c.close(); }
});

test('a temp conducted worker survives a switch as itself', async () => {
  const conductor = await spawnSub();
  const worker = await instances.create({ project: 'p', mode: 'bypassPermissions', model: A, backend: 'ollama',
    temp: true, conducted: true, callerInstanceId: conductor.id });
  await waitFor(() => worker.status === 'idle');
  worker._relaunchGraceMs = 30;
  await seedTurn(worker);
  const exits = [];
  const hub = instances._idleHub;
  const realOnTargetExit = hub.onTargetExit.bind(hub);
  hub.onTargetExit = (id, info) => { exits.push(id); return realOnTargetExit(id, info); };
  try {
    await worker.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await settled(worker);
    assert.equal(worker.model, B);
    assert.equal(instances.get(worker.id), worker, 'not dropped from the live list');
    assert.equal(worker.temp, true);
    assert.equal(await isTemp(worker.backingSessionId), true);
    assert.equal(await isArchived(worker.backingSessionId), false, 'not archived by the kill');
    assert.equal(worker.conducted, true);
    assert.equal(await isConducted(worker.sessionId), true);
    assert.deepEqual(exits, [], 'the owner is not woken by the restart');
    assert.equal(instances.exitCauseFor(worker.sessionId), null, 'no exit cause recorded');
  } finally { hub.onTargetExit = realOnTargetExit; }
});

test('a session with no turns relaunches under --session-id and its divider leads the replay', async () => {
  const inst = await spawnSub();
  const { backingSessionId } = inst;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.model, B);
  assert.ok(!inst._spawnArgv.includes('--resume'));
  assert.equal(argOf(inst._spawnArgv, '--session-id'), backingSessionId);
  const ledger = await getModelSwitchesForSegment(backingSessionId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].afterUuid, null);
  assert.equal(restartDividers(ringOf(inst)).length, 1, 'emitted live');
  // The first turn is persisted afterwards; a replay puts the divider first.
  await seedTurn(inst);
  const replay = await loadPersistedTranscript({ place: inst.transcriptPlace, sessionId: backingSessionId });
  const flat = replay.lines.flatMap(l => l.events);
  assert.equal(flat[0].subtype, 'model_changed');
  assert.equal(flat[0].data.restart, true);
  assert.equal(restartDividers(flat).length, 1);
});

test('the graceful-restart drain waits for an in-flight switch and manifests the settled model', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 300;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  assert.ok(inst.modelSwitch);
  const entries = await drainToManifest({ server: null, wss: null, instances, log: QUIET, graceMs: 5000 });
  const entry = entries.find(e => e.sessionId === inst.sessionId);
  assert.ok(entry, 'the switching session is in the manifest');
  assert.equal(entry.model, B);
  assert.equal(entry.effort, 'low');
});

test('an identity Claude session still switches live through set_model — no restart', async () => {
  await setTierBackend('frontier', { backend: 'claude', model: 'claude-opus-4-8' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-haiku-4-5' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const launches = launcher.count;
  const proc = inst.proc;
  assert.deepEqual(await inst.switchModel({ model: 'claude-opus-4-8', backend: 'claude', effort: 'low' }), { restart: false });
  assert.equal(inst.model, 'claude-opus-4-8');
  assert.equal(launcher.count, launches);
  assert.equal(inst.proc, proc);
  assert.notEqual(inst.effort, 'low', 'the live path leaves effort alone');
  assert.equal(inst._modelSwitchRun, null);
});

test('a failure to RECORD a confirmed switch is not a failed switch: the session stays on the new model, divider and all', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 300;
  const warnings = [];
  const realWarn = console.warn;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inGrace(inst);
  // The store becomes unwritable for the confirmation's ledger write: a
  // directory where sessions.json was makes the strict in-lock read fail.
  const file = sessionsFile();
  await fs.rename(file, `${file}.aside`);
  await fs.mkdir(file);
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    await settled(inst);
  } finally {
    console.warn = realWarn;
    await fs.rmdir(file);
    await fs.rename(`${file}.aside`, file);
  }
  assert.equal(inst.model, B);
  assert.equal(inst.effort, 'low');
  assert.ok(inst.proc);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.summary().modelSwitchFailure, null, 'no failure chip');
  assert.equal(inst.summary().modelSwitch, null);
  assert.equal(restartDividers(ringOf(inst)).length, 1, 'the live divider is still emitted');
  assert.ok(warnings.some(w => /model switch/.test(w) && /recording/.test(w)), `the error is logged: ${JSON.stringify(warnings)}`);
  assert.deepEqual(await getModelSwitchesForSegment(inst.backingSessionId), [], 'fixture check: the write really failed');
});

test('during confirmation no context reading measured on the old model is reported', async () => {
  const inst = await spawnSub();
  await seedTurnWithUsage(inst);
  inst._relaunchGraceMs = 400;
  const c = await wsClient(wsUrl);
  try {
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await inGrace(inst);
    assert.equal(inst.contextWindowTokens, 300_000, 'premise: the window is already the new model\'s');
    assert.equal(inst.summary().contextTokens, null);
    assert.equal(inst.lastContextUsage, null);
    c.send({ t: 'subscribe', id: inst.id });
    const snap = await c.wait(m => m.t === 'snapshot' && m.id === inst.id);
    assert.equal(snap.lastContextUsage, null, 'a late joiner is not seeded with it either');
    await settled(inst);
    assert.equal(inst.summary().contextTokens, null);
  } finally { await c.close(); }
});

test('a failed switch re-resumes on the old model WITH its own context reading', async () => {
  const inst = await spawnSub();
  await seedTurnWithUsage(inst);
  launcher.plan.push({ crash: 'no such model' });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.model, A, 'fixture check: the switch failed');
  await waitFor(() => inst.summary().contextTokens === 190_000);
});

test('a crash after confirmation, before the switch settles, is an ordinary crash: exit cause and launch_failed', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 30;
  launcher.plan.push({ hold: true });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inGrace(inst);
  // Holding the store lock parks the confirmation's ledger write, so the window
  // between "confirmed" and "settled" stays open until the crash has landed.
  await withLock(sessionsFile(), async () => {
    await waitFor(() => inst._suppressTempDelete === false);
    assert.ok(inst.modelSwitch, 'fixture check: confirmed but not yet settled');
    launcher.ctl.last.crash('late boom');
    await waitFor(() => inst.status === 'crashed');
  });
  await settled(inst);
  const cause = instances.exitCauseFor(inst.sessionId);
  assert.ok(cause, 'the exit cause is recorded');
  await waitFor(() => cause.stderrTail !== null && /late boom/.test(cause.stderrTail));
  const failed = ringOf(inst).filter(e => e.kind === 'system' && e.subtype === 'launch_failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].data.stderr, /late boom/);
  assert.equal(inst.summary().modelSwitchFailure, null, 'the switch itself was confirmed');
  assert.equal(restartDividers(ringOf(inst)).length, 1);
});

test('a relaunch that never comes up idle is a failed switch at the deadline', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchIdleDeadlineMs = 150;
  launcher.plan.push({ deaf: true });
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.model, A);
  assert.equal(inst.status, 'idle');
  assert.ok(inst.proc, 'resumed on the old model');
  assert.equal(inst._mutating, null, 'the claim is released');
  assert.match(inst.summary().modelSwitchFailure.error, /did not come up idle/);
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual(ledger.map(e => e.ok), [false]);
});

test('a REST respawn during the switch\'s process-less gap is refused 409', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 300;
  const attempts = [];
  const onStatus = (s) => {
    if (inst.modelSwitch && !inst.proc && (s.status === 'exited' || s.status === 'crashed') && attempts.length === 0) {
      attempts.push(instances.respawn(inst.id).then(() => null, e => e));
    }
  };
  inst.on('status', onStatus);
  try {
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await waitFor(() => attempts.length === 1);
    const err = await attempts[0];
    assert.equal(err?.statusCode, 409);
    assert.match(err.message, /relaunch/);
    await settled(inst);
    assert.equal(inst.model, B, 'the switch went on unharmed');
  } finally { inst.off('status', onStatus); }
});

test('a conductor reading the session mid-switch sees the confirmed model, not the unconfirmed target', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 400;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inGrace(inst);
  assert.equal(inst.summary().model, B, 'premise: the summary already names the target');
  const during = (await describeSession({ sessionId: inst.sessionId }, { instances })).text;
  assert.match(during, /model ollama\/alpha:cloud/);
  await settled(inst);
  const after = (await describeSession({ sessionId: inst.sessionId }, { instances })).text;
  assert.match(after, /model ollama\/beta:cloud/);
});

test('Change effort during the grace window is refused and leaves the effort alone', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  inst._relaunchGraceMs = 400;
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await inGrace(inst);
  assert.throws(() => inst.setEffort('max'), e => e.statusCode === 409 && /switching model/.test(e.message));
  assert.equal(inst.effort, 'low');
  assert.equal(inst.status, 'idle', 'no /effort turn was started');
  await settled(inst);
  assert.equal(inst.effort, 'low');
});

// ── review round 2 ──────────────────────────────────────────────────────────

test('a crash after confirmation but before the switch settles does not wake the owner, and the session stays live', async () => {
  const conductor = await spawnSub();
  const worker = await instances.create({ project: 'p', mode: 'bypassPermissions', model: A, backend: 'ollama',
    conducted: true, callerInstanceId: conductor.id });
  await waitFor(() => worker.status === 'idle');
  worker._relaunchGraceMs = 30;
  await seedTurn(worker);
  launcher.plan.push({ hold: true });
  const exits = [];
  const hub = instances._idleHub;
  const realOnTargetExit = hub.onTargetExit.bind(hub);
  hub.onTargetExit = (id, info) => { exits.push(id); return realOnTargetExit(id, info); };
  try {
    await worker.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await inGrace(worker);
    await withLock(sessionsFile(), async () => {
      await waitFor(() => worker._suppressTempDelete === false);
      launcher.ctl.last.crash('late boom');
      await waitFor(() => worker.status === 'crashed');
      assert.ok(worker.modelSwitch, 'fixture check: still inside the switch');
      assert.deepEqual(exits, [], 'no owner wake while the switch holds the session');
      assert.equal(instances.isSessionLive(worker.sessionId), true, 'still live to a resume\'s guard: nothing may reclaim it');
    });
    await settled(worker);
    assert.ok(instances.exitCauseFor(worker.sessionId), 'the exit cause is still recorded');
  } finally { hub.onTargetExit = realOnTargetExit; }
});

test('a relaunch that cannot resume records no anchor, even when the segment file has a uuid\'d line', async () => {
  const inst = await spawnSub();
  // A file the CLI would refuse to --resume: uuid'd, but no user/assistant line.
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId,
    [{ type: 'attachment', uuid: 'stale-1', attachment: { type: 'hook_additional_context', content: [] } }]);
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.model, B);
  assert.ok(!inst._spawnArgv.includes('--resume'), 'fixture check: the --session-id relaunch');
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual(ledger.map(e => e.afterUuid), [null]);
  await seedTurn(inst);
  const replay = (await loadPersistedTranscript({ place: inst.transcriptPlace, sessionId: inst.backingSessionId })).lines.flatMap(l => l.events);
  assert.equal(replay[0].subtype, 'model_changed', 'the divider leads the replay, not trails it');
});

test('a listener throwing on the confirmed switch\'s divider does not turn it into a failed switch', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  const warnings = [];
  const realWarn = console.warn;
  const boom = (ev) => { if (ev?.subtype === 'model_changed' && ev.data?.restart) throw new Error('listener boom'); };
  inst.on('event', boom);
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await settled(inst);
  } finally { console.warn = realWarn; inst.off('event', boom); }
  assert.equal(inst.model, B);
  assert.equal(inst.summary().modelSwitchFailure, null, 'no failure chip');
  assert.ok(inst.proc);
  assert.equal(restartDividers(ringOf(inst)).length, 1, 'the divider reached the ring before the listener threw');
  assert.equal((await getModelSwitchesForSegment(inst.backingSessionId)).map(e => e.ok).join(), 'true');
  assert.ok(warnings.some(w => /listener boom/.test(w)), `logged: ${JSON.stringify(warnings)}`);
});

test('loadHistory consumes the one-shot usage-skip even when the transcript is missing', async () => {
  const inst = await spawnSub();
  await seedTurnWithUsage(inst);
  inst._skipUsageSeed = true;
  await inst.loadHistory(randomUUID()); // ENOENT: nothing to replay
  assert.equal(inst._skipUsageSeed, false);
  // So the next resume seeds its reading as usual.
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.summary().contextTokens, 190_000);
});

test('a relaunch that throws before reaching its replay does not leak the usage-skip into the old model\'s re-resume', async () => {
  const inst = await spawnSub();
  await seedTurnWithUsage(inst);
  // The FIRST wipe (the relaunch onto B) throws in a snapshot_reset listener,
  // before launch() — so no replay ever consumed the flag the relaunch set.
  let thrown = false;
  const once = () => { if (!thrown) { thrown = true; throw new Error('wipe boom'); } };
  inst.on('snapshot_reset', once);
  try {
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await settled(inst);
  } finally { inst.off('snapshot_reset', once); }
  assert.equal(inst.model, A);
  assert.match(inst.summary().modelSwitchFailure.error, /wipe boom/);
  assert.ok(inst.proc, 'resumed on the old model');
  await waitFor(() => inst.summary().contextTokens === 190_000);
});

for (const [name, plan, act] of [
  ['a Terminate (cancelled)', [], async (inst) => { await inGrace(inst); await inst.kill(); }],
  ['a double failure', [{ crash: 'boom on beta' }, { crash: 'boom on alpha' }], async () => {}],
]) {
  test(`a temp session whose switch ends with no process — ${name} — is archived and dropped`, async () => {
    const inst = await spawnSub({ temp: true });
    await seedTurn(inst);
    inst._relaunchGraceMs = name.startsWith('a Terminate') ? 5000 : 30;
    launcher.plan.push(...plan);
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await act(inst);
    await settled(inst);
    assert.equal(inst.proc, null, 'fixture check: no process left');
    await waitFor(async () => await isArchived(inst.backingSessionId));
    assert.equal(instances.get(inst.id), undefined, 'dropped from the live list, as any temp exit');
  });
}

test('REST respawn is refused 409 while a prune\'s rotation window is open', async () => {
  const inst = await spawnSub();
  await inst.kill();
  inst.beginRotation('prune');
  try {
    await assert.rejects(instances.respawn(inst.id), e => e.statusCode === 409 && /relaunch/.test(e.message));
  } finally { inst._rotation = null; }
  await instances.respawn(inst.id); // control: the window was the reason
  await waitFor(() => inst.status === 'idle');
});

test('a status listener throwing during the relaunch\'s replay tail is logged, not an unhandled rejection', async () => {
  const inst = await spawnSub();
  await seedTurn(inst);
  const rejections = [];
  const onRejection = (r) => { rejections.push(r); };
  process.on('unhandledRejection', onRejection);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  let thrown = false;
  let spawning = false;
  // Throws on the replay tail's own transition to idle (spawning → idle) while switching.
  const boom = (s) => {
    if (s.status === 'spawning') spawning = true;
    if (!thrown && spawning && inst.modelSwitch && s.status === 'idle') { thrown = true; throw new Error('status boom'); }
  };
  inst.on('status', boom);
  try {
    await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
    await settled(inst);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
  } finally {
    inst.off('status', boom);
    console.warn = realWarn;
    process.off('unhandledRejection', onRejection);
  }
  assert.ok(thrown, 'fixture check: the listener did throw inside the replay tail');
  assert.deepEqual(rejections, [], 'no unhandled rejection');
  assert.ok(warnings.some(w => /status boom/.test(w)), `logged: ${JSON.stringify(warnings)}`);
  assert.equal(inst.model, B, 'the switch itself still confirmed');
});

// ── cross-backend switches ──────────────────────────────────────────────────

const domainsOf = (inst) => [...instances.usageWindowDomainsOf(inst)];

test('Claude→ollama by tier restarts the same session on ollama\'s template, env, record and usage domain, with the tier\'s effort', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  const { id, sessionId, backingSessionId } = inst;
  assert.deepEqual(await getSessionBackend(sessionId), { backend: 'claude', model: HAIKU, contextWindowTokens: 200_000 },
    'premise: a Claude spawn is recorded too');
  const c = await wsClient(wsUrl);
  try {
    const ack = await frame(c, inst, 'fast', 'x1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
  } finally { await c.close(); }
  assert.equal(instances.get(id), inst, 'the same instance object');
  assert.equal(inst.sessionId, sessionId);
  const argv = inst._spawnArgv;
  assert.equal(argOf(argv, '--resume'), backingSessionId, 'resumed under the same backing id');
  assert.deepEqual(argv.slice(0, 6), ['ollama', 'launch', 'claude', '--model', A, '--yes'], 'ollama\'s launch template');
  assert.equal(inst.backend, 'ollama');
  assert.equal(inst.summary().backend, 'ollama');
  assert.equal(inst.model, A);
  assert.equal(inst.effort, 'medium', 'the tier\'s effort');
  assert.equal(argOf(argv, '--effort'), 'medium');
  assert.equal(inst.contextWindowTokens, 100_000);
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '100000');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000');
  assert.deepEqual(await getSessionBackend(sessionId), { backend: 'ollama', model: A, contextWindowTokens: 100_000 });
  assert.deepEqual(domainsOf(inst), ['backend:ollama']);
});

test('ollama→Claude by tier lands on the tagged catalog model with no ollama launch, and a cold resume before any Claude turn comes back on it', async () => {
  await bindFrontierToSonnet();
  const inst = await spawnSub();
  await seedTurn(inst);
  const { sessionId, backingSessionId } = inst;
  const c = await wsClient(wsUrl);
  try {
    const ack = await frame(c, inst, 'frontier', 'y1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
  } finally { await c.close(); }
  const argv = inst._spawnArgv;
  assert.equal(argOf(argv, '--resume'), backingSessionId);
  assert.equal(inst.backend, 'claude');
  assert.equal(inst.model, SONNET_1M, 'canonicalized against the target backend');
  assert.equal(argOf(argv, '--model'), SONNET_1M);
  assert.equal(inst.effort, 'xhigh');
  assert.equal(inst.contextWindowTokens, 1_000_000);
  assert.notEqual(argv[0], 'ollama');
  assert.ok(!argv.includes('launch') && !argv.includes(A), `no ollama template or model in ${JSON.stringify(argv)}`);
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, 'no managed context env on claude');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.deepEqual(await getSessionBackend(sessionId), { backend: 'claude', model: SONNET_1M, contextWindowTokens: 1_000_000 });
  assert.deepEqual(domainsOf(inst), ['anthropic']);

  // The gap: no turn has run on Claude, so the jsonl's newest assistant line
  // still names the ollama model.
  assert.equal(await readLastSessionModel({ place: inst.transcriptPlace, sessionId: backingSessionId }), A,
    'fixture check: the jsonl names the old model');
  const resumed = await coldResume(sessionId);
  assert.notEqual(resumed, inst, 'a new instance, built from the store');
  assert.equal(resumed.backend, 'claude');
  assert.equal(resumed.model, SONNET_1M, 'the record, not the jsonl\'s ollama id');
  assert.equal(argOf(resumed._spawnArgv, '--model'), SONNET_1M);
  assert.equal(resumed.contextWindowTokens, 1_000_000);
  assert.ok(!resumed._spawnArgv.includes('launch'));
  assert.equal(resumed._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('a live Claude→Claude switch rewrites the record, so a cold resume before the next turn comes back on the new model', async () => {
  const inst = await spawnClaude();
  // The jsonl a turn on Haiku left behind.
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId,
    [TURN[0], { ...TURN[1], message: { ...TURN[1].message, model: HAIKU } }]);
  const launches = launcher.count;
  assert.deepEqual(await inst.switchModel({ model: 'claude-opus-4-8', backend: 'claude', effort: 'low' }), { restart: false });
  assert.equal(launcher.count, launches, 'premise: a live switch, no relaunch');
  await waitFor(async () => (await getSessionBackend(inst.sessionId))?.model === 'claude-opus-4-8');
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'claude', model: 'claude-opus-4-8', contextWindowTokens: inst.contextWindowTokens });
  const resumed = await coldResume(inst.sessionId);
  assert.equal(resumed.model, 'claude-opus-4-8', 'the record, not the jsonl\'s Haiku');
  assert.equal(argOf(resumed._spawnArgv, '--model'), 'claude-opus-4-8');
});

test('ollama→my-proxy by a {model, backend} frame restarts on the proxy\'s template and keeps the session\'s effort', async () => {
  await addProxy();
  const inst = await spawnSub();
  await seedTurn(inst);
  const c = await wsClient(wsUrl);
  try {
    const ack = await modelFrame(c, inst, MINE, 'my-proxy', 'q1');
    assert.equal(ack.ok, true, ack.error);
    await settled(inst);
  } finally { await c.close(); }
  const argv = inst._spawnArgv;
  assert.deepEqual(argv.slice(0, 5), [...PROXY_TEMPLATE, MINE]);
  assert.equal(argOf(argv, '--resume'), inst.backingSessionId);
  assert.equal(inst.backend, 'my-proxy');
  assert.equal(inst.model, MINE);
  assert.equal(inst.effort, 'high', 'no tier was picked');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'my-proxy', model: MINE, contextWindowTokens: 200_000 });
  assert.deepEqual(domainsOf(inst), ['backend:my-proxy']);
});

test('the same model id on a different backend is a switch, not a re-select', async () => {
  await addProxy();
  await addCustomModel({ label: 'Alpha proxied', model: A, backend: 'my-proxy', contextWindow: 150_000 });
  const inst = await spawnSub();
  await seedTurn(inst);
  assert.deepEqual(await inst.switchModel({ model: A, backend: 'my-proxy', effort: 'high' }), { restart: true });
  await settled(inst);
  assert.equal(inst.backend, 'my-proxy');
  assert.equal(inst.model, A);
  assert.equal(inst.contextWindowTokens, 150_000);
  assert.deepEqual(inst._spawnArgv.slice(0, 5), [...PROXY_TEMPLATE, A]);
});

test('_trackModel after a cross switch: ignored on the substitution backend, adopted and recorded back on Claude', async () => {
  await bindFrontierToSonnet();
  const inst = await spawnClaude();
  await seedTurn(inst);
  const liveSwitches = () => ringOf(inst).filter(e => e.subtype === 'model_changed' && !e.data?.restart);
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  inst._trackModel('claude-opus-4-8');
  assert.equal(inst.model, A, 'a substitution backend keeps its configured id');
  assert.equal(liveSwitches().length, 0);

  await inst.switchModel({ model: SONNET, backend: 'claude', effort: 'low' });
  await settled(inst);
  assert.equal(inst.model, SONNET_1M);
  inst._trackModel('claude-opus-4-8');
  assert.equal(inst.model, 'claude-opus-4-8', 'a Claude session adopts the CLI\'s report');
  assert.deepEqual(liveSwitches().map(e => [e.data.from, e.data.to]), [[SONNET_1M, 'claude-opus-4-8']]);
  await waitFor(async () => (await getSessionBackend(inst.sessionId))?.model === 'claude-opus-4-8');
  assert.equal((await getSessionBackend(inst.sessionId)).backend, 'claude');
});

test('a failed Claude→ollama switch is back on Claude: pair, effort, window, steering, launch and record', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  const claudeCmd = inst._spawnArgv[0];
  const before = { model: inst.model, effort: inst.effort, cw: inst.contextWindowTokens, steer: inst.acceptsMidTurnSteering };
  launcher.plan.push({ crash: 'no ollama here' });
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.backend, 'claude');
  assert.deepEqual({ model: inst.model, effort: inst.effort, cw: inst.contextWindowTokens, steer: inst.acceptsMidTurnSteering }, before);
  assert.equal(inst.status, 'idle');
  assert.ok(inst.proc, 'running on Claude again');
  assert.equal(inst._spawnArgv[0], claudeCmd, 'the claude binary, not ollama');
  assert.ok(!inst._spawnArgv.includes('launch'));
  assert.equal(argOf(inst._spawnArgv, '--model'), HAIKU);
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'claude', model: HAIKU, contextWindowTokens: 200_000 });
  assert.deepEqual(inst.summary().modelSwitchFailure,
    { from: HAIKU, to: A, fromBackend: 'claude', toBackend: 'ollama', error: 'no ollama here' });
});

test('a failed ollama→Claude switch is back on ollama: template, model, env and record', async () => {
  await bindFrontierToSonnet();
  const inst = await spawnSub();
  await seedTurn(inst);
  launcher.plan.push({ crash: 'no claude here' });
  await inst.switchModel({ model: SONNET, backend: 'claude', effort: 'low' });
  await settled(inst);
  assert.equal(inst.backend, 'ollama');
  assert.equal(inst.model, A);
  assert.equal(inst.effort, 'high');
  assert.ok(inst.proc);
  assert.deepEqual(inst._spawnArgv.slice(0, 6), ['ollama', 'launch', 'claude', '--model', A, '--yes']);
  assert.equal(argOf(inst._spawnArgv, '--model'), A);
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '100000');
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'ollama', model: A, contextWindowTokens: 100_000 });
});

test('a cross switch whose re-resume also fails is left crashed and recorded on the previous pair', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  launcher.plan.push({ crash: 'boom on ollama' }, { crash: 'boom on claude' });
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.status, 'crashed');
  assert.equal(inst.proc, null);
  assert.equal(inst.backend, 'claude');
  assert.equal(inst.model, HAIKU);
  assert.deepEqual(await getSessionBackend(inst.sessionId), { backend: 'claude', model: HAIKU, contextWindowTokens: 200_000 });
  const failure = inst.summary().modelSwitchFailure;
  assert.equal(failure.fromBackend, 'claude');
  assert.equal(failure.toBackend, 'ollama');
  assert.match(failure.error, /^boom on ollama; resuming on claude-haiku-4-5 on claude also failed: boom on claude$/);
});

test('a cross switch\'s ledger entry and divider name both backends, live and replayed; a same-backend one names neither', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  const live = restartDividers(ringOf(inst));
  assert.equal(live.length, 1);
  assert.equal(live[0].replayed, undefined, 'fixture check: the live emit');
  assert.deepEqual([live[0].data.from, live[0].data.to, live[0].data.fromBackend, live[0].data.toBackend], [HAIKU, A, 'claude', 'ollama']);
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual(ledger.map(e => [e.from, e.to, e.fromBackend, e.toBackend]), [[HAIKU, A, 'claude', 'ollama'], [A, B, undefined, undefined]]);
  assert.ok(!('fromBackend' in ledger[1]) && !('toBackend' in ledger[1]), 'a same-backend entry carries neither key');
  const replay = (await loadPersistedTranscript({ place: inst.transcriptPlace, sessionId: inst.backingSessionId })).lines.flatMap(l => l.events);
  assert.deepEqual(restartDividers(replay).map(e => [e.data.fromBackend, e.data.toBackend]), [['claude', 'ollama'], [undefined, undefined]]);
});

test('a failed cross switch\'s divider and ledger entry name both backends', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  launcher.plan.push({ crash: 'nope' });
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  const [entry] = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual([entry.ok, entry.fromBackend, entry.toBackend], [false, 'claude', 'ollama']);
  const failed = failDividers(ringOf(inst));
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].data.fromBackend, failed[0].data.toBackend, failed[0].data.error], ['claude', 'ollama', 'nope']);
});

test('mid cross switch the summary names both backends, and a conductor sees the pair the session is still on', async () => {
  const inst = await spawnClaude();
  await seedTurn(inst);
  inst._modelSwitchGraceMs = 400;
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await waitFor(() => inst.proc && inst.status === 'idle' && inst.modelSwitch && inst.model === A);
  assert.deepEqual(inst.summary().modelSwitch, { from: HAIKU, to: A, fromBackend: 'claude', toBackend: 'ollama' });
  assert.equal(inst.summary().backend, 'ollama', 'premise: the summary already names the target backend');
  const during = (await describeSession({ sessionId: inst.sessionId }, { instances })).text;
  assert.match(during, /model claude\/claude-haiku-4-5\b/);
  const refused = await sendPrompt({ sessionId: inst.sessionId, text: 'x' }, { instances });
  assert.equal(refused.code, 'SESSION_SWITCHING_MODEL');
  assert.deepEqual([refused.fromBackend, refused.toBackend], ['claude', 'ollama']);
  assert.match(refused.reason, /switch model claude-haiku-4-5 on claude → alpha:cloud on ollama;/);
  await settled(inst);
  const after = (await describeSession({ sessionId: inst.sessionId }, { instances })).text;
  assert.match(after, /model ollama\/alpha:cloud/);
});

test('a cross switch is refused with nothing claimed or relaunched', async (t) => {
  const cases = [
    ['during a running turn', async (inst) => {
      await inst.prompt('one');
      await waitFor(() => inst.status === 'idle' && ringOf(inst).some(e => e.kind === 'turn_end'));
      await inst.prompt('two'); // never ends on its own
      await waitFor(() => inst.status === 'turn');
    }, { model: A, backend: 'ollama' }, e => e.statusCode === 409 && e.code === 'SESSION_BUSY'],
    ['while background work runs', async (inst) => { inst._backgroundJobs.set('job-1', { id: 'job-1' }); },
      { model: A, backend: 'ollama' }, e => e.statusCode === 409 && e.code === 'SESSION_BUSY'],
    ['onto a removed backend', async () => {}, { model: B, backend: 'ghost' },
      e => e.statusCode === 422 && e.code === 'BACKEND_GONE' && /backend 'ghost' no longer exists/.test(e.message)],
  ];
  for (const [name, arrange, target, refusal] of cases) {
    await t.test(name, async () => {
      const inst = await spawnClaude();
      await arrange(inst);
      const launches = launcher.count;
      const proc = inst.proc;
      await assert.rejects(inst.switchModel({ ...target, effort: 'low' }), refusal);
      assert.equal(launcher.count, launches, 'no relaunch');
      assert.equal(inst.proc, proc);
      assert.equal(inst.backend, 'claude');
      assert.equal(inst._mutating, null);
      assert.equal(inst.modelSwitch, null);
      inst._backgroundJobs.clear();
      await inst.kill();
    });
  }
});

test('after a cross switch a fork and the restart manifest carry the new backend', async () => {
  const inst = await spawnClaude();
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId, [
    ...TURN,
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'again' } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', model: HAIKU, content: [{ type: 'text', text: 'ok' }] } },
  ]);
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  const forked = await inst.forkAtUserMessage(1, 'again');
  assert.deepEqual([forked.createArgs.backend, forked.createArgs.model, forked.createArgs.contextWindowTokens], ['ollama', A, 100_000]);
  const entries = await drainToManifest({ server: null, wss: null, instances, log: QUIET, graceMs: 5000 });
  const entry = entries.find(e => e.sessionId === inst.sessionId);
  assert.deepEqual([entry.backend, entry.model], ['ollama', A]);
});

test('a conductor switched Claude→ollama relaunches with the native window and keeps its compact-window override', async () => {
  const { value } = await setConductorCompactWindow({ enabled: true, value: 100 });
  const override = String(value * 1000);
  assert.notEqual(override, '300000', 'fixture check: the override differs from the target\'s native window');
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const inst = await spawnClaude({ project: '.conduct' });
  assert.equal(inst._spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, override, 'premise: the override applies on Claude');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  await inst.switchModel({ model: B, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.backend, 'ollama');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
  assert.equal(inst._spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, override);
});

test('after Claude→ollama a turn\'s cost row carries no cost_usd', async () => {
  const inst = await spawnClaude();
  const rows = async () => (await fs.readFile(costsPath(), 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(r => r.sessionId === inst.sessionId);
  await inst.prompt('one');
  await waitFor(async () => (await rows()).length === 1);
  assert.equal(Object.hasOwn((await rows())[0], 'cost_usd'), true, 'control: the Claude turn is priced');
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.backend, 'ollama');
  await inst.prompt('two');
  await waitFor(async () => (await rows()).length === 2);
  assert.equal(Object.hasOwn((await rows())[1], 'cost_usd'), false);
});

test('on a remote-system session a switch whose target launch command does not resolve is refused FUSE_BACKEND_UNRESOLVED, nothing claimed', async () => {
  const BAD = 'cc-no-such-launcher-msr';
  await addBackend({ id: 'unresolvable', label: 'Unresolvable', template: `${BAD} launch claude --model {model} --` });
  await addCustomModel({ label: 'U', model: 'u:v1', backend: 'unresolvable', contextWindow: 128_000 });
  const inst = await spawnClaude();
  await seedTurn(inst);
  const launches = launcher.count;
  // The two facts the guard reads: a remote placement, and a launcher that
  // execs the CLI (in a chroot) rather than running it in-process.
  const realLauncher = inst._launcher;
  inst._redirectPlacement = { project: 'p', systemId: 'remote-1', systemPath: inst.cwd, worktree: null, system: null };
  inst._launcher = { inProcess: false, launch() { throw new Error('must not launch'); } };
  try {
    await assert.rejects(inst.switchModel({ model: 'u:v1', backend: 'unresolvable', effort: 'low' }),
      e => e.statusCode === 501 && e.code === 'FUSE_BACKEND_UNRESOLVED'
        && e.message.includes(`launches '${BAD}'`) && e.message.includes("system 'remote-1'"));
    assert.equal(inst._mutating, null);
    assert.equal(inst.modelSwitch, null);
    assert.equal(inst.backend, 'claude');
  } finally {
    inst._launcher = realLauncher;
    inst._redirectPlacement = null;
  }
  assert.equal(launcher.count, launches, 'no relaunch');
  // Control: the same target on a local session is accepted.
  assert.deepEqual(await inst.switchModel({ model: 'u:v1', backend: 'unresolvable', effort: 'low' }), { restart: true });
  await settled(inst);
  assert.equal(inst.backend, 'unresolvable');
});

test('_trackModel\'s silent adopt of a first-known model records it too', async () => {
  const inst = await spawnClaude();
  assert.equal((await getSessionBackend(inst.sessionId)).model, HAIKU, 'premise');
  inst.model = null; // what a resume whose model could not be recovered starts with
  inst._trackModel('claude-opus-4-8');
  assert.equal(inst.model, 'claude-opus-4-8');
  assert.equal(ringOf(inst).filter(e => e.subtype === 'model_changed').length, 0, 'discovery, not a switch');
  await waitFor(async () => (await getSessionBackend(inst.sessionId))?.model === 'claude-opus-4-8');
});

// A Claude session whose model was never known (a resume with no record and no
// model in its jsonl, before its first system/init) runs the account default.
// Its switch names that side `(account default)` wherever the switch is
// persisted or shown; only the rollback goes back to the real null.
const ACCOUNT_DEFAULT = '(account default)';

async function spawnModelLess() {
  const inst = await spawnClaude();
  await seedTurn(inst);
  inst.model = null; // the state such a resume starts in
  return inst;
}

test('a model-less session\'s cross switch labels its from side, persisted and shown, and its divider survives replay', async () => {
  const inst = await spawnModelLess();
  inst._modelSwitchGraceMs = 300;
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  assert.deepEqual(inst.summary().modelSwitch, { from: ACCOUNT_DEFAULT, to: A, fromBackend: 'claude', toBackend: 'ollama' });
  const refused = await sendPrompt({ sessionId: inst.sessionId, text: 'x' }, { instances });
  assert.equal(refused.from, ACCOUNT_DEFAULT);
  await settled(inst);
  assert.deepEqual([inst.backend, inst.model], ['ollama', A], 'the restart itself is unaffected');
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual(ledger.map(e => [e.from, e.to, e.ok]), [[ACCOUNT_DEFAULT, A, true]], 'the entry survives the store\'s parse');
  assert.deepEqual(restartDividers(ringOf(inst)).map(e => e.data.from), [ACCOUNT_DEFAULT]);
  const replay = (await loadPersistedTranscript({ place: inst.transcriptPlace, sessionId: inst.backingSessionId })).lines.flatMap(l => l.events);
  assert.deepEqual(restartDividers(replay).map(e => e.data.from), [ACCOUNT_DEFAULT], 'the divider survives replay');
});

test('a model-less session\'s failed cross switch rolls back to a null model, with the label only in what is shown', async () => {
  const inst = await spawnModelLess();
  launcher.plan.push({ crash: 'boom on ollama' }, { crash: 'boom on claude' });
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.equal(inst.backend, 'claude');
  assert.equal(inst.model, null, 'restored to the real null, not the label');
  assert.equal((await getSessionBackend(inst.sessionId)).model, null, 'recorded as unknown, not as the label');
  const failure = inst.summary().modelSwitchFailure;
  assert.equal(failure.from, ACCOUNT_DEFAULT);
  assert.match(failure.error, /^boom on ollama; resuming on \(account default\) on claude also failed: boom on claude$/);
  const ledger = await getModelSwitchesForSegment(inst.backingSessionId);
  assert.deepEqual(ledger.map(e => [e.from, e.ok]), [[ACCOUNT_DEFAULT, false]]);
});

test('a model-less session\'s re-resume after a failed switch launches with no --model, as before it', async () => {
  const inst = await spawnModelLess();
  launcher.plan.push({ crash: 'boom on ollama' });
  await inst.switchModel({ model: A, backend: 'ollama', effort: 'low' });
  await settled(inst);
  assert.ok(inst.proc, 'resumed');
  assert.equal(inst.model, null);
  assert.ok(!inst._spawnArgv.includes('--model'), `no --model: ${JSON.stringify(inst._spawnArgv)}`);
  assert.ok(!inst._spawnArgv.includes(ACCOUNT_DEFAULT));
});
