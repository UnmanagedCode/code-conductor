import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { MID_TURN_NOTE, POST_STOP_STEER_NOTE } from '../src/instances.ts';
import { addCustomModel } from '../src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plan.json');
const SCENARIO_BYPASS_INIT = path.join(__dirname, 'fixtures', 'scenario-plan-bypass-init.json');

let ctx, baseUrl, wsUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, wsUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  // A controlled model carrying the opt-out, so this file's flagged fixtures do
  // not depend on a curated preset existing.
  await addCustomModel({
    label: 'Steer opt-out (test)', model: FLAGGED_MODEL, backend: 'ollama',
    contextWindow: 256_000, midTurnSteering: false,
  });
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.once('open', () => resolve({
      ws, messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(p, timeout = 4000) { return waitFor(() => messages.find(p), { timeout }); },
    }));
  });
}

async function seedPlanFile() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-aa-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'plan.md');
  await fs.writeFile(planFile, '# Plan\n- step 1\n');
  process.env.FAKE_PLAN_FILE = planFile;
  return tmpDir;
}

test('auto-approve fires server-side without any subscribed client', async () => {
  // The microtask in _handleStdoutLine watches for the parser-emitted
  // plan_request and fires setMode + the approval prompt directly from
  // the Instance — no client needed. Drives the same flow as a manual
  // Approve click, just without the human in the loop.
  const tmpDir = await seedPlanFile();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);
    assert.equal(inst.autoApprovePlan, true);

    await inst.prompt('plan something');

    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 6000 });
    await waitFor(() => inst.ring.toArray().some(
      ev => ev.kind === 'user_echo' && /I approve the plan/.test(ev.text ?? ''),
    ), { timeout: 6000 });

    const events = inst.ring.toArray();
    const plan = events.find(ev => ev.kind === 'plan_request');
    assert.ok(plan, 'plan_request must be in the ring');
    assert.equal(plan.autoApproved, true, 'plan_request is annotated with autoApproved');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('auto_approve_plan WS message round-trips and broadcasts via status', async () => {
  const tmpDir = await seedPlanFile();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot');
    assert.equal(snap.autoApprovePlan, false, 'snapshot defaults to false');

    c.send({ t: 'auto_approve_plan', id, enabled: true, reqId: 'a1' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a1' && m.ok === true);
    const on = await c.wait(m => m.t === 'status' && m.id === id && m.autoApprovePlan === true);
    assert.equal(on.autoApprovePlan, true);
    assert.equal(instances.get(id).autoApprovePlan, true);

    c.send({ t: 'auto_approve_plan', id, enabled: false, reqId: 'a2' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a2' && m.ok === true);
    const off = await c.wait(m => m.t === 'status' && m.id === id && m.autoApprovePlan === false);
    assert.equal(off.autoApprovePlan, false);

    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('snapshot carries autoApprovePlan when a fresh client subscribes', async () => {
  const tmpDir = await seedPlanFile();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);

    const c = await wsClient(wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot');
    assert.equal(snap.autoApprovePlan, true);
    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('POST /api/instances with autoApprovePlan:true arms the flag before spawn', async () => {
  // The quick-spawn "Plan & Approve" path POSTs autoApprovePlan in the
  // body so the server sets the flag synchronously before the subprocess
  // emits its first ExitPlanMode — no client-side WS race.
  const tmpDir = await seedPlanFile();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'plan', temp: true, autoApprovePlan: true,
    });
    const id = r.body.id;
    assert.equal(r.body.autoApprovePlan, true, 'summary reflects the flag');
    const inst = instances.get(id);
    assert.equal(inst.autoApprovePlan, true,
      'flag is set synchronously, not after a WS round-trip');

    await waitFor(() => inst.status === 'idle');
    await inst.prompt('plan something');

    // First plan_request → auto-approve microtask fires setMode +
    // approval prompt without any client involvement.
    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 6000 });
    await waitFor(() => inst.ring.toArray().some(
      ev => ev.kind === 'user_echo' && /I approve the plan/i.test(ev.text ?? ''),
    ));
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('POST /api/instances without autoApprovePlan leaves the flag false', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'p', mode: 'plan', temp: true,
  });
  assert.equal(r.body.autoApprovePlan, false);
  assert.equal(instances.get(r.body.id).autoApprovePlan, false);
});

test('flag does not fire auto-approve when instance is not in plan mode', async () => {
  // Dedicated scenario whose init reports permissionMode:bypassPermissions
  // so by the time plan_request would otherwise land, the mode-gating
  // check in _handleStdoutLine sees a non-plan mode and refuses to fire.
  const tmpDir = await seedPlanFile();
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_BYPASS_INIT;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);

    await inst.prompt('plan something');
    await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'turn_end'), { timeout: 6000 });
    await new Promise(r => setTimeout(r, 200));

    const events = inst.ring.toArray();
    const approvalEcho = events.find(
      ev => ev.kind === 'user_echo' && /I approve the plan/.test(ev.text ?? ''),
    );
    assert.equal(approvalEcho, undefined,
      'no approval prompt should be auto-sent when the instance is not in plan mode');
    assert.equal(inst.mode, 'bypassPermissions',
      'mode must remain bypassPermissions');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Card 2026-0183 Part F. _fireAutoApprovePlan's comment used to claim the
// ExitPlanMode deny ends the turn; it only does so when the CLI has nothing
// queued behind it, so the approval prompt CAN land mid-turn — and on a model
// declaring midTurnSteering:false it was then silently swallowed, with the
// failure visible only on stderr. SCENARIO_MID_TURN holds the turn open after
// the deny, which is the state these two pin.
// ---------------------------------------------------------------------------

const SCENARIO_MID_TURN = path.join(__dirname, 'fixtures', 'scenario-plan-mid-turn.json');
const FLAGGED_MODEL = 'cc-test-steer-optout:cloud';

async function userStdin(transcriptPath) {
  try {
    return (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(o => o.type === 'user' && o.message?.role === 'user');
  } catch { return []; }
}
async function allStdin(transcriptPath) {
  try {
    return (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
const textsOf = (line) => line.message.content.filter(b => b.type === 'text').map(b => b.text);

// Drive to the mid-turn post-deny state with auto-approve armed. Returns the
// instance and the stdin transcript path.
async function autoApproveMidTurn({ flagged }) {
  const transcriptPath = path.join(home, `aa-stdin-${flagged ? 'f' : 'u'}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_MID_TURN;
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  if (flagged) {
    inst.backend = 'ollama';
    inst.model = FLAGGED_MODEL;
    inst._refreshModelCapabilities();
    assert.equal(inst.acceptsMidTurnSteering, false, 'the controlled opt-out row resolved');
  }
  inst.setAutoApprovePlan(true);
  inst.prompt('plan something');
  await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'plan_request'), { timeout: 6000 });
  return { inst, transcriptPath };
}

test('F-T1 auto-approve on a flagged worker mid-turn defers to a post-stop turn', async () => {
  // Invariant: on a flagged worker whose ExitPlanMode deny did NOT end the turn,
  // the auto-approval prompt is not injected live — it is parked behind one
  // block-edge stop and delivered as a fresh turn carrying POST_STOP_STEER_NOTE.
  const tmpDir = await seedPlanFile();
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  try {
    const { inst, transcriptPath } = await autoApproveMidTurn({ flagged: true });
    const approveText = 'I approve the plan. Please proceed with the implementation.';

    // The fire path is setMode (a control round-trip) then the send, so wait for the
    // mode flip and then for the send to have taken EITHER route before driving a
    // block edge. Deliberately not `waitFor(steerPending)`: that would make the
    // revert-the-fix proof a timeout rather than a failed assertion.
    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 6000 });
    await waitFor(async () => inst.steerPending
      || (await userStdin(transcriptPath)).length === 2, { timeout: 6000 });
    assert.equal(inst.status, 'turn', 'the deny did not end the turn');

    // Block edge → the armed stop fires; the turn_end then flushes the steer. A no-op
    // if the approval was injected live instead.
    inst._handleStdoutLine(JSON.stringify(
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
    await waitFor(async () => (await userStdin(transcriptPath)).length === 2, { timeout: 6000 });

    const lines = await allStdin(transcriptPath);
    assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
    const users = await userStdin(transcriptPath);
    assert.deepEqual(textsOf(users[1]), [POST_STOP_STEER_NOTE, approveText],
      'the note rides as its OWN leading block, then the verbatim approval');
    await waitFor(() => inst.steerPending === false);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('F-T2 auto-approve on an unflagged worker mid-turn is byte-identical', async () => {
  // Invariant: an unflagged mid-turn auto-approval is still ONE live user line
  // whose blocks are exactly [MID_TURN_NOTE, approveText], with zero
  // control_request on stdin.
  const tmpDir = await seedPlanFile();
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  try {
    const { inst, transcriptPath } = await autoApproveMidTurn({ flagged: false });
    const approveText = 'I approve the plan. Please proceed with the implementation.';

    await waitFor(async () => (await userStdin(transcriptPath)).length === 2, { timeout: 6000 });
    const lines = await allStdin(transcriptPath);
    assert.equal(interruptsIn(lines).length, 0, 'a live injection arms NO stop');
    const users = await userStdin(transcriptPath);
    assert.deepEqual(textsOf(users[1]), [MID_TURN_NOTE, approveText],
      'the ordinary mid-turn annotation, unchanged');
    assert.equal(inst.steerPending, false, 'nothing was parked');
    assert.equal(inst.status, 'turn', 'the turn was not stopped');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_PLAN_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
