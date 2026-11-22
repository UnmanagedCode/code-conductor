// The headless runner (src/headless/runner.ts), in process on bootServer with
// the fake CLI: the root it spawns, the prompt it sends, the asks it answers
// (the root's only), when it resolves (the whole owned tree quiescent), how it
// fails, the signal path, and the result's fields.
//
// Gated scenarios keep every timing decision in the test's hands: the root's
// first turn (tests/fixtures/scenario-headless-root-gated.json) never ends on
// its own and each later prompt ends the open turn; the worker's
// (scenario-headless-worker-gated.json) likewise. FAKE_CLAUDE_SCENARIO and
// FAKE_CLAUDE_TRANSCRIPT are read at each launch, so each session gets its own.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sleep } from './poll.mjs';

// Module-load-time constant, so it is set before the dynamic imports.
process.env.ORCH_IDLE_DRAIN_SETTLE_MS = '50';
const SETTLE_MS = 50;

const { bootServer, api, waitFor, waitForIdleOrExit, instForSession, freshProjectsRoot, rmrf, userStdinLines } = await import('./helpers.mjs');
const { runHeadless } = await import('../src/headless/runner.ts');
const { HEADLESS_FRAGMENT, HEADLESS_QUESTION_ANSWER } = await import('../src/headless/fragment.ts');
const { newConductorSpawnBody } = await import('../shared/newConductor.ts');
const { buildApprovePrompt } = await import('../shared/planApproval.ts');
const { CONDUCT_PROJECT_NAME } = await import('../src/conduct.ts');
const { createHeadlessStream } = await import('../src/headless/stream.ts');

const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const ROOT_GATED = fx('scenario-headless-root-gated.json');
// The same gated root, but a prompt written into its open turn is queued by the CLI
// (the open turn ends, then a new turn answers it) rather than ending the open turn.
const ROOT_GATED_QUEUED = fx('scenario-headless-root-gated-queued.json');
const WORKER_GATED = fx('scenario-headless-worker-gated.json');
const ROOT_PLAN = fx('scenario-headless-root-plan.json');
const ROOT_ERROR = fx('scenario-headless-root-error.json');
const QUESTION = fx('scenario-question.json');
const BASIC = fx('scenario-basic.json');


let server, home;
before(async () => { server = await bootServer({ scenarioPath: BASIC }); });
after(async () => { await server.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await server.instances.shutdown(); await rmrf(home); });

// Run `fn` with the fake CLI env set for the launches it makes.
async function withLaunchEnv(scenario, transcript, fn) {
  const prev = { s: process.env.FAKE_CLAUDE_SCENARIO, t: process.env.FAKE_CLAUDE_TRANSCRIPT };
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try { return await fn(); }
  finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev.s;
    if (prev.t === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT; else process.env.FAKE_CLAUDE_TRANSCRIPT = prev.t;
  }
}

const textOf = (line) => {
  const c = line.message.content;
  return typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('');
};
const stdinTexts = async (p) => (await userStdinLines(p)).map(textOf);

// Start a run; the root's launch reads `scenario` and records its stdin.
// `root()` waits for the conduct-project instance the runner spawned.
async function start({ scenario, mode = 'code', prompt = 'do the thing', signals = new EventEmitter(), clock, onRoot } = {}) {
  let handle;
  const rootLog = path.join(home, 'root-stdin.jsonl');
  const created = [];
  const realCreate = server.instances.create.bind(server.instances);
  server.instances.create = (input) => { created.push(input); return realCreate(input); };
  let run;
  let settled = false;
  await withLaunchEnv(scenario, rootLog, async () => {
    run = runHeadless({ instances: server.instances, prompt, mode, signals, expose: (h) => { handle = h; }, ...(clock ? { clock } : {}), ...(onRoot ? { onRoot } : {}) });
    await waitFor(() => [...server.instances.byId.values()].some((i) => i.project === CONDUCT_PROJECT_NAME && i.proc));
  });
  delete server.instances.create;
  run.then(() => { settled = true; });
  const root = [...server.instances.byId.values()].find((i) => i.project === CONDUCT_PROJECT_NAME);
  return { run, root, rootLog, created, signals, handle, settled: () => settled };
}

async function spawnWorker(root, scenario, log, { project = 'demo', playbook = 'freeform', stage = 'freeform' } = {}) {
  if (project !== CONDUCT_PROJECT_NAME) await api(server.baseUrl, 'POST', '/api/projects', { name: project });
  return withLaunchEnv(scenario, log, async () => {
    const res = await fetch(`${server.baseUrl}/mcp/${encodeURIComponent(root.sessionId)}?format=text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spawn_instance', arguments: { project, mode: 'bypassPermissions', playbook, stage } } }),
    });
    const body = await res.json();
    assert.ok(body.result && !body.result.isError, JSON.stringify(body));
    const { sessionId } = JSON.parse(body.result.content[0].text);
    if (!sessionId) throw new Error(body.result.content[0].text);
    const worker = instForSession(server.instances, sessionId);
    assert.ok(worker, `spawned worker ${sessionId} is live`);
    await waitForIdleOrExit(worker);
    return worker;
  });
}

test('the root is spawned with the New-conductor body, plus autoApprovePlan only in plan mode', async (t) => {
  for (const mode of ['code', 'plan']) {
    await t.test(mode, async () => {
      const r = await start({ scenario: BASIC, mode });
      const result = await r.run;
      assert.equal(result.reason, 'completed');
      assert.equal(r.created.length, 1);
      const { autoApprovePlan, ...rest } = r.created[0];
      const body = newConductorSpawnBody(mode);
      for (const [k, v] of Object.entries(body)) assert.equal(rest[k], v, k);
      assert.equal(autoApprovePlan, mode === 'plan' ? true : undefined);
      assert.equal(r.root.autoApprovePlan, mode === 'plan');
      await server.instances.shutdown();
    });
  }
});

test('the first prompt is the headless fragment, a blank line, then the user prompt', async () => {
  const r = await start({ scenario: BASIC, prompt: 'Summarise the repo.' });
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.deepEqual(await stdinTexts(r.rootLog), [`${HEADLESS_FRAGMENT}\n\nSummarise the repo.`]);
});

test('the result carries the root session, its last text, its rolled cost and the clock\'s duration', async () => {
  const times = [1_000];
  const clock = { now: () => times.shift() ?? 1_750 };
  const r = await start({ scenario: BASIC, clock });
  const result = await r.run;
  assert.deepEqual(
    { ...result, costUsd: typeof result.costUsd },
    { reason: 'completed', exitCode: 0, sessionId: r.root.sessionId, text: 'Hello, world!', costUsd: 'number', durationMs: 750, error: null },
  );
  assert.ok(result.costUsd > 0, `costUsd ${result.costUsd}`);
});

test('a worker spawn is not completion: the run resolves only after the worker\'s wake reached the root', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  const workerLog = path.join(home, 'worker-stdin.jsonl');
  const worker = await spawnWorker(r.root, WORKER_GATED, workerLog);
  await worker.promptOrQueueSteer('work');
  await waitFor(() => worker.status === 'turn');
  // The root ends its turn while its worker is still busy.
  await r.root.promptOrQueueSteer('continue', [], { author: 'human' });
  await waitFor(() => r.root.status === 'idle' && r.root.liveTurnEnds === 1);
  assert.equal(server.instances.isTreeQuiescent(r.root.id), false);
  await sleep(SETTLE_MS * 4);
  assert.equal(r.settled(), false, 'no result while the worker is mid-turn');
  await worker.promptOrQueueSteer('finish');
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.equal(result.text, 'Final report.', 'the root turn the wake opened is the one reported');
  const rootIn = await stdinTexts(r.rootLog);
  assert.equal(rootIn.length, 3);
  assert.ok(rootIn[2].includes(worker.sessionId), 'the third root prompt is the worker\'s wake');
});

test('a grandchild whose section lead was removed still holds the run until it is idle', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  // A section lead: a `.conduct` session — the only kind of spawned session offered spawn_instance.
  const lead = await spawnWorker(r.root, WORKER_GATED, path.join(home, 'lead-stdin.jsonl'), { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const grandchild = await spawnWorker(lead, WORKER_GATED, path.join(home, 'grandchild-stdin.jsonl'), { project: 'demo2' });
  assert.equal(grandchild.rootSessionId, r.root.sessionId, 'fixture check: durable root attribution at depth 2');
  await grandchild.promptOrQueueSteer('work');
  await waitFor(() => grandchild.status === 'turn');
  await server.instances.remove(lead.id);
  assert.equal(server.instances.get(lead.id), undefined, 'fixture check: the lead left byId');
  await r.root.promptOrQueueSteer('continue', [], { author: 'human' });
  await waitFor(() => r.root.status === 'idle' && r.root.liveTurnEnds === 1);
  assert.equal(server.instances.isTreeQuiescent(r.root.id), false);
  await sleep(SETTLE_MS * 4);
  assert.equal(r.settled(), false, 'no result while the grandchild is mid-turn');
  await grandchild.promptOrQueueSteer('finish');
  await waitFor(() => grandchild.status === 'idle');
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.equal(result.text, 'Waiting on the worker.');
});

test('a root AskUserQuestion gets the canned answer, once', async () => {
  const r = await start({ scenario: QUESTION });
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.equal(result.text, 'got it');
  const rootIn = await stdinTexts(r.rootLog);
  assert.equal(rootIn.length, 2);
  assert.ok(rootIn[1].endsWith(HEADLESS_QUESTION_ANSWER), rootIn[1]);
});

test('a worker\'s AskUserQuestion is not answered by the runner; it reaches the root as a wake', async (t) => {
  const r = await start({ scenario: ROOT_GATED_QUEUED });
  // The park backstop never fires here: the run must complete because the queued
  // turn's start released the hold, not because the backstop did.
  const hub = server.instances._idleHub;
  const { _setTimer, _clearTimer } = hub;
  t.after(() => { hub._setTimer = _setTimer; hub._clearTimer = _clearTimer; });
  hub._setTimer = () => ({});
  hub._clearTimer = () => {};
  await waitFor(() => r.root.status === 'turn');
  const workerLog = path.join(home, 'worker-stdin.jsonl');
  const worker = await spawnWorker(r.root, QUESTION, workerLog);
  await worker.promptOrQueueSteer('pick a fruit');
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.deepEqual(await stdinTexts(workerLog), ['pick a fruit'], 'nothing answered the worker');
  const rootIn = await stdinTexts(r.rootLog);
  assert.equal(rootIn.length, 2, 'the root\'s only other prompt is the wake');
  assert.ok(rootIn[1].includes(worker.sessionId));
  assert.ok(!rootIn.some((t) => t.includes(HEADLESS_QUESTION_ANSWER)));
});

test('a root plan the auto-approve rule did not take is approved, in code mode', async () => {
  const r = await start({ scenario: ROOT_PLAN, mode: 'code' });
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.equal(result.text, 'Implemented.');
  const rootIn = await stdinTexts(r.rootLog);
  assert.equal(rootIn.length, 2);
  assert.ok(rootIn[1].endsWith(buildApprovePrompt(undefined)), rootIn[1]);
});

test('--mode plan: only the root auto-approves plans; its worker does not', async () => {
  const r = await start({ scenario: ROOT_GATED, mode: 'plan' });
  await waitFor(() => r.root.status === 'turn');
  assert.equal(r.root.mode, 'plan');
  assert.equal(r.root.autoApprovePlan, true);
  const worker = await spawnWorker(r.root, WORKER_GATED, path.join(home, 'worker-stdin.jsonl'));
  assert.equal(worker.autoApprovePlan, false);
  await r.root.promptOrQueueSteer('continue', [], { author: 'human' });
  assert.equal((await r.run).reason, 'completed');
});

test('a root that exits before completion is a conductor_error', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  await r.root.kill();
  const result = await r.run;
  assert.equal(result.reason, 'conductor_error');
  assert.equal(result.exitCode, 3);
  assert.match(result.error, /root conductor (exited|crashed)/);
  assert.equal(result.sessionId, r.root.sessionId);
  assert.equal(result.text, 'Dispatching.');
});

test('a completion whose last root turn errored is a conductor_error that still reports the text', async () => {
  const r = await start({ scenario: ROOT_ERROR });
  const result = await r.run;
  assert.equal(result.reason, 'conductor_error');
  assert.equal(result.exitCode, 3);
  assert.equal(result.text, 'Partial output.');
  assert.match(result.error, /last turn ended in an error/);
});

test('a signal force-interrupts the root and ends the run with 128+n', async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    await t.test(signal, async () => {
      const r = await start({ scenario: ROOT_GATED });
      await waitFor(() => r.root.status === 'turn');
      const calls = [];
      const realInterrupt = r.root.interrupt.bind(r.root);
      r.root.interrupt = (opts) => { calls.push(opts); return realInterrupt(opts); };
      r.signals.emit(signal, signal);
      const result = await r.run;
      assert.deepEqual(calls, [{ force: true }]);
      assert.equal(result.reason, 'signal');
      assert.equal(result.exitCode, code);
      assert.match(result.error, new RegExp(signal));
      assert.equal(r.signals.listenerCount(signal), 0, 'the run stops listening');
      await server.instances.shutdown();
    });
  }
});

test('a second signal ends the run at once, without waiting on the interrupt', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  r.root.interrupt = () => new Promise(() => {});
  r.signals.emit('SIGTERM', 'SIGTERM');
  await sleep(SETTLE_MS);
  assert.equal(r.settled(), false, 'the first signal waits on the interrupt');
  r.signals.emit('SIGTERM', 'SIGTERM');
  await waitFor(() => r.settled(), { timeout: 2_000 });
  const result = await r.run;
  assert.equal(result.reason, 'signal');
  assert.equal(result.exitCode, 143);
});

test('a second signal reports the cost read at the first signal once that read has finished', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  r.root.interrupt = () => new Promise(() => {});
  r.signals.emit('SIGTERM', 'SIGTERM');
  const early = r.handle.signalCostRead();
  assert.ok(early, 'the first signal started its cost read');
  const cost = await early;
  r.signals.emit('SIGTERM', 'SIGTERM');
  const result = await r.run;
  assert.equal(result.reason, 'signal');
  assert.equal(typeof cost, 'number');
  assert.equal(result.costUsd, cost, 'the first signal\'s finished read');
});

test('a second signal in the same tick as the first reports costUsd null', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  r.root.interrupt = () => new Promise(() => {});
  r.signals.emit('SIGTERM', 'SIGTERM');
  r.signals.emit('SIGTERM', 'SIGTERM');
  const result = await r.run;
  assert.equal(result.reason, 'signal');
  assert.equal(result.costUsd, null);
});

// The runner against a fake manager whose state the test drives directly:
// status events at will, and a quiescence the test flips without an event.
function fakeRun() {
  const instances = new EventEmitter();
  const sent = [];
  let quiet = false;
  const root = {
    id: 'fake-root', sessionId: 'fake-root-s', status: 'idle', mode: 'bypassPermissions',
    ringSnapshot: () => [], summary: () => ({ id: 'fake-root', status: 'idle', lastTurnError: false }),
    promptOrQueueSteer: async (text) => { sent.push(text); },
    interrupt: async () => {},
  };
  Object.assign(instances, {
    create: async () => root,
    isTreeQuiescent: () => quiet,
    exitCauseFor: () => null,
  });
  let settled = false;
  const run = runHeadless({ instances, prompt: 'p', mode: 'code', signals: new EventEmitter() });
  run.then(() => { settled = true; });
  return {
    instances, root, sent, run, settled: () => settled,
    setQuiet: (v) => { quiet = v; },
    status: (over = {}) => instances.emit('status', { id: root.id, status: 'turn', ...over }),
  };
}
const canned = (sent) => sent.filter((t) => t === HEADLESS_QUESTION_ANSWER).length;

test('the canned answer goes out once per ask, however many status events carry it', async () => {
  const f = fakeRun();
  await waitFor(() => f.sent.length === 1, { timeout: 2_000 });
  const ask = (liveAsks) => f.status({ awaitingUser: 'question', awaitingUserSource: 'tool', liveAsks });
  for (let i = 0; i < 4; i++) ask(1);
  await sleep(SETTLE_MS);
  assert.equal(canned(f.sent), 1, 'one ask, one answer');
  for (let i = 0; i < 3; i++) ask(2);
  await sleep(SETTLE_MS);
  assert.equal(canned(f.sent), 2, 'a second ask, exactly one more');
  f.setQuiet(true);
  f.status({ status: 'idle' });
  await f.run;
});

test('the settle timer re-checks quiescence when it fires', async () => {
  const f = fakeRun();
  await waitFor(() => f.sent.length === 1, { timeout: 2_000 });
  f.setQuiet(true);
  f.instances.emit('subscription_changed', { targetId: 'x' });
  // The tree goes busy inside the window with no event the runner evaluates on.
  f.setQuiet(false);
  await sleep(SETTLE_MS * 4);
  assert.equal(f.settled(), false, 'the timer fired on a busy tree and did not complete the run');
  f.setQuiet(true);
  f.status({ status: 'idle' });
  const result = await f.run;
  assert.equal(result.reason, 'completed');
});

test('the run handle reports no facts before the spawn, the root\'s once it exists', async () => {
  let handle;
  const signals = new EventEmitter();
  const rootLog = path.join(home, 'root-stdin.jsonl');
  let run;
  await withLaunchEnv(ROOT_GATED, rootLog, async () => {
    run = runHeadless({ instances: server.instances, prompt: 'p', mode: 'code', signals, expose: (h) => { handle = h; } });
    assert.equal(handle.facts(), null, 'nothing spawned yet');
    assert.equal(handle.signalCostRead(), null, 'no signal yet');
    await waitFor(() => handle.facts() !== null);
  });
  const root = [...server.instances.byId.values()].find((i) => i.project === CONDUCT_PROJECT_NAME);
  await waitFor(() => handle.facts().text === 'Dispatching.');
  const facts = handle.facts();
  assert.equal(facts.sessionId, root.sessionId);
  assert.equal(typeof facts.durationMs, 'number');
  signals.emit('SIGINT', 'SIGINT');
  await run;
});

// Invariant: the stream learns the root before the run produces output — onRoot
// runs once, with the root, before its first prompt is sent. The discriminator
// is synchronous: the root is spawned pristine, and promptOrQueueSteer's first
// step (_endPristine) clears that flag, so a root still pristine inside onRoot
// has not been prompted yet.
test('onRoot is handed the root once, before its first prompt is sent', async () => {
  const calls = [];
  const r = await start({ scenario: BASIC, onRoot: (root) => { calls.push({ root, pristine: root.pristine }); } });
  const result = await r.run;
  assert.equal(result.reason, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, r.root);
  assert.equal(calls[0].pristine, true, 'not yet prompted when onRoot ran');
  assert.equal(r.root.pristine, false, 'premise: the prompt cleared the flag afterwards');
});

// Invariant: the cap, stream-failure and closed-stdout paths end the run, as a
// conductor_error naming the given error.
test('handle.fail ends the run as a conductor_error with that error', async () => {
  const r = await start({ scenario: ROOT_GATED });
  await waitFor(() => r.root.status === 'turn');
  r.handle.fail('x');
  const result = await r.run;
  assert.equal(result.reason, 'conductor_error');
  assert.equal(result.exitCode, 3);
  assert.equal(result.error, 'x');
  assert.equal(result.sessionId, r.root.sessionId);
});

// Invariant: --include-workers membership is the run tree isTreeQuiescent
// judges — a worker the root spawned mid-run, and a grandchild whose section
// lead has already left byId — each line labelled from the instance.
test('--include-workers streams the root\'s worker and a removed lead\'s grandchild, labelled', async (t) => {
  const out = [];
  const sink = { write: (c) => { out.push(c); }, buffered: () => 0 };
  const stream = createHeadlessStream({ instances: server.instances, includeWorkers: true, sink, onFail: (m) => { throw new Error(m); } });
  t.after(() => stream.close());
  const r = await start({ scenario: ROOT_GATED, onRoot: (root) => stream.setRoot(root) });
  await waitFor(() => r.root.status === 'turn');
  const lines = () => out.map((c) => JSON.parse(c));

  const worker = await spawnWorker(r.root, WORKER_GATED, path.join(home, 'worker-stdin.jsonl'));
  worker.proc.stdout.write('{"probe":"worker-json"}\nworker raw text\n');
  await waitFor(() => lines().some((l) => l.line === 'worker raw text'));
  const fromWorker = lines().filter((l) => l.cc_session_id === worker.sessionId);
  const json = fromWorker.find((l) => l.probe === 'worker-json');
  const raw = fromWorker.find((l) => l.type === 'cc_raw' && l.line === 'worker raw text');
  for (const l of [json, raw]) {
    assert.ok(l, JSON.stringify(fromWorker));
    assert.deepEqual(
      { role: l.cc_role, parent: l.cc_parent_session_id, root: l.cc_root_session_id, project: l.cc_project },
      { role: 'worker', parent: r.root.sessionId, root: r.root.sessionId, project: 'demo' },
    );
  }
  assert.ok(lines().some((l) => l.cc_session_id === r.root.sessionId && l.cc_role === 'conductor'), 'the root\'s own lines stream too');

  const lead = await spawnWorker(r.root, WORKER_GATED, path.join(home, 'lead-stdin.jsonl'), { project: CONDUCT_PROJECT_NAME, playbook: 'section-lead', stage: 'section-lead' });
  const grandchild = await spawnWorker(lead, WORKER_GATED, path.join(home, 'grandchild-stdin.jsonl'), { project: 'demo2' });
  const leadSessionId = lead.sessionId;
  await server.instances.remove(lead.id);
  assert.equal(server.instances.get(lead.id), undefined, 'fixture check: the lead left byId');
  // A second stream that has never seen the grandchild, so its admission is
  // decided after the lead left, not latched from earlier lines.
  const late = [];
  const fresh = createHeadlessStream({ instances: server.instances, includeWorkers: true, sink: { write: (c) => { late.push(JSON.parse(c)); }, buffered: () => 0 }, onFail: (m) => { throw new Error(m); } });
  t.after(() => fresh.close());
  fresh.setRoot(r.root);
  grandchild.proc.stdout.write('{"probe":"grandchild"}\n');
  await waitFor(() => lines().some((l) => l.probe === 'grandchild') && late.some((l) => l.probe === 'grandchild'));
  for (const l of [lines().find((x) => x.probe === 'grandchild'), late.find((x) => x.probe === 'grandchild')]) {
    assert.deepEqual(
      { session: l.cc_session_id, parent: l.cc_parent_session_id, root: l.cc_root_session_id, role: l.cc_role, project: l.cc_project },
      { session: grandchild.sessionId, parent: leadSessionId, root: r.root.sessionId, role: 'worker', project: 'demo2' },
    );
  }
  r.signals.emit('SIGINT', 'SIGINT');
  await r.run;
});
