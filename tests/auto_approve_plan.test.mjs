import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';
import { HookBroker } from '../src/hookBroker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plan.json');

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

function buildExitPlanModeEnvelope(toolUseId = 'tu_exit') {
  return {
    session_id: 'sess-test',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/cwd',
    permission_mode: 'plan',
    hook_event_name: 'PreToolUse',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: '# Plan\n- step 1' },
    tool_use_id: toolUseId,
  };
}

test('auto-approve allows the ExitPlanMode hook with no client subscribed', async () => {
  // The CLI is what POSTs to /hook-callback in production; we POST it
  // directly here. With autoApprovePlan set the broker should return
  // allow synchronously, no held-open response, no held-up turn.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);

    const cb = await api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildExitPlanModeEnvelope('tu_aa1'),
    );
    assert.equal(cb.status, 200);
    assert.equal(cb.body.hookSpecificOutput.permissionDecision, 'allow',
      'auto-approve must answer the hook with allow');

    // plan_resolved with autoApproved:true should be in the ring so
    // any subscribed UI tabs can flip the card without a click.
    await waitFor(() =>
      inst.ring.toArray().some(ev =>
        ev.kind === 'plan_resolved' && ev.decision === 'approve' && ev.autoApproved === true,
      ),
    );

    // Mode flips to bypassPermissions so the post-plan tool calls
    // aren't re-gated. The flip is async (control_request to the CLI),
    // so wait for it.
    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 4000 });
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('without auto-approve, the ExitPlanMode hook is held open until a plan_decision arrives', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    // Fire the hook in the background — should NOT settle without a decision.
    const cbPromise = api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildExitPlanModeEnvelope('tu_hold'),
    );
    const settled = await Promise.race([
      cbPromise.then(() => 'settled'),
      new Promise(r => setTimeout(() => r('pending'), 150)),
    ]);
    assert.equal(settled, 'pending', 'broker must hold the ExitPlanMode hook open');
    assert.equal(inst._hooks.pendingCount, 1, 'broker tracks one pending plan hook');

    // Approve via the new WS message.
    c.send({ t: 'plan_decision', id, toolUseId: 'tu_hold', decision: 'approve', feedback: '', reqId: 'p1' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'p1' && m.ok === true);

    const cb = await cbPromise;
    assert.equal(cb.body.hookSpecificOutput.permissionDecision, 'allow',
      'approve resolves the held-open hook with allow — same-turn, no regenerate');

    const resolved = await c.wait(m => m.t === 'event' && m.ev.kind === 'plan_resolved');
    assert.equal(resolved.ev.decision, 'approve');
    assert.ok(!resolved.ev.autoApproved, 'manual approve does not get the autoApproved flag');

    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 4000 });
    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('plan_decision reject denies the hook and sends a refinement prompt', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    const cbPromise = api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildExitPlanModeEnvelope('tu_rej'),
    );
    await waitFor(() => inst._hooks.pendingCount === 1);

    c.send({ t: 'plan_decision', id, toolUseId: 'tu_rej', decision: 'reject',
      feedback: 'add a security review step' });

    const cb = await cbPromise;
    assert.equal(cb.body.hookSpecificOutput.permissionDecision, 'deny',
      'reject denies the held-open hook');

    // The Instance fires a refinement prompt afterwards (so the model
    // gets to see what the user wanted changed).
    await waitFor(() => inst.ring.toArray().some(ev =>
      ev.kind === 'user_echo' && /Refinement notes/i.test(ev.text ?? '') && /security review/i.test(ev.text ?? ''),
    ));
    assert.equal(inst.mode, 'plan', 'reject leaves the instance in plan mode');
    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('plan_decision with no pending hook falls back to the legacy setMode+prompt path', async () => {
  // Models the post-timeout case: broker auto-denied the hook at 540s,
  // the card stayed on screen, and the user now clicks Approve. The
  // broker has nothing for this toolUseId, so Instance.resolvePlan
  // synthesises the original flow: mode flip + approval prompt + a
  // plan_resolved event tagged viaFallback so the card flips.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst._hooks.pendingCount, 0, 'no pending hooks');

    const result = await inst.resolvePlan('tu_never_hooked', 'approve', '');
    assert.equal(result.via, 'legacy');
    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 4000 });

    const events = inst.ring.toArray();
    assert.ok(events.some(ev =>
      ev.kind === 'user_echo' && /I approve the plan/i.test(ev.text ?? ''),
    ), 'legacy fallback sends the approval prompt');
    assert.ok(events.some(ev =>
      ev.kind === 'plan_resolved' && ev.viaFallback === true,
    ), 'legacy fallback emits a synthetic plan_resolved tagged viaFallback');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('broker pending-timeout auto-denies the ExitPlanMode hook and emits plan_resolved(timeout)', async () => {
  // Unit test against the broker directly so we don't have to wait
  // 540s of real time. Asserts the broker's timeout edge: held-open
  // response → eventually deny + plan_resolved(timeout), and a later
  // resolvePlan returns false (so the Instance hits the legacy path).
  const emitted = [];
  const broker = new HookBroker({
    getMode: () => 'plan',
    emit: (ev) => emitted.push(ev),
    pendingTimeoutMs: 50,
  });
  let responseBody = null;
  const fakeRes = {
    headersSent: false,
    status() { return this; },
    json(body) { this.headersSent = true; responseBody = body; },
  };
  broker.handle(
    { tool_name: 'ExitPlanMode', tool_use_id: 'tu_to', tool_input: { plan: 'x' } },
    fakeRes,
  );
  assert.equal(broker.pendingCount, 1);

  // Wait past the timeout.
  await new Promise(r => setTimeout(r, 120));

  assert.ok(responseBody, 'hook response must have settled after timeout');
  assert.equal(responseBody.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(responseBody.hookSpecificOutput.permissionDecisionReason, /did not respond/i);
  assert.equal(broker.pendingCount, 0);

  const resolved = emitted.find(ev => ev.kind === 'plan_resolved' && ev.toolUseId === 'tu_to');
  assert.ok(resolved, 'plan_resolved must be emitted on timeout');
  assert.equal(resolved.decision, 'timeout');

  // A later resolvePlan for the same toolUseId returns false — caller
  // (Instance.resolvePlan) treats this as the legacy-fallback signal.
  const stillPending = broker.resolvePlan('tu_to', 'approve', '');
  assert.equal(stillPending, false);
});

test('auto_approve_plan WS message round-trips and broadcasts via status', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot');
    assert.equal(snap.autoApprovePlan, false, 'snapshot defaults to false');

    c.send({ t: 'auto_approve_plan', id, enabled: true, reqId: 'a1' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a1' && m.ok === true);
    const on = await c.wait(m => m.t === 'status' && m.id === id && m.autoApprovePlan === true);
    assert.equal(on.autoApprovePlan, true);
    assert.equal(ctx.instances.get(id).autoApprovePlan, true);

    c.send({ t: 'auto_approve_plan', id, enabled: false, reqId: 'a2' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a2' && m.ok === true);
    const off = await c.wait(m => m.t === 'status' && m.id === id && m.autoApprovePlan === false);
    assert.equal(off.autoApprovePlan, false);

    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('snapshot carries autoApprovePlan when a fresh client subscribes', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    const snap = await c.wait(m => m.t === 'snapshot');
    assert.equal(snap.autoApprovePlan, true);
    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('POST /api/instances with autoApprovePlan:true arms the flag before spawn', async () => {
  // The quick-spawn "Plan & Approve" path POSTs autoApprovePlan in the
  // body so the server sets the flag synchronously before the subprocess
  // can emit its first ExitPlanMode — no client-side WS race.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'plan', temp: true, autoApprovePlan: true,
    });
    const id = r.body.id;
    assert.equal(r.body.autoApprovePlan, true, 'summary reflects the flag');
    assert.equal(ctx.instances.get(id).autoApprovePlan, true,
      'flag is set synchronously, not after a WS round-trip');

    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const cb = await api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildExitPlanModeEnvelope('tu_qs_aa'),
    );
    assert.equal(cb.body.hookSpecificOutput.permissionDecision, 'allow',
      'first ExitPlanMode is auto-approved');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('POST /api/instances without autoApprovePlan leaves the flag false', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'plan', temp: true,
    });
    assert.equal(r.body.autoApprovePlan, false);
    assert.equal(ctx.instances.get(r.body.id).autoApprovePlan, false);
  } finally {
    await ctx.close();
  }
});

test('ExitPlanMode hook in bypassPermissions is a no-op allow', async () => {
  // The broker only runs the plan-mode flow when the orchestrator
  // thinks it's in plan. If a stray ExitPlanMode hook fires outside
  // plan mode (e.g. after auto-approve already flipped us), the
  // broker just allows it — no held-open, no plan_resolved emitted.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true); // even with the flag on

    const cb = await api(
      ctx.baseUrl, 'POST', `/api/instances/${id}/hook-callback`,
      buildExitPlanModeEnvelope('tu_bypass'),
    );
    assert.equal(cb.body.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(inst._hooks.pendingCount, 0, 'no held-open response in non-plan mode');
    assert.ok(!inst.ring.toArray().some(ev =>
      ev.kind === 'plan_resolved' && ev.autoApproved === true,
    ), 'no autoApproved plan_resolved emitted outside plan mode');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
