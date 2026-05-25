import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plan.json');
const SCENARIO_BYPASS_INIT = path.join(__dirname, 'fixtures', 'scenario-plan-bypass-init.json');

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
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
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
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
  // emits its first ExitPlanMode — no client-side WS race.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'plan', temp: true, autoApprovePlan: true,
    });
    const id = r.body.id;
    assert.equal(r.body.autoApprovePlan, true, 'summary reflects the flag');
    const inst = ctx.instances.get(id);
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

test('flag does not fire auto-approve when instance is not in plan mode', async () => {
  // Dedicated scenario whose init reports permissionMode:bypassPermissions
  // so by the time plan_request would otherwise land, the mode-gating
  // check in _handleStdoutLine sees a non-plan mode and refuses to fire.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO_BYPASS_INIT });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
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
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
