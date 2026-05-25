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
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    // No WS subscriber at all. Flip the server-side flag directly,
    // mirroring what a `auto_approve_plan` WS message would do.
    inst.setAutoApprovePlan(true);
    assert.equal(inst.autoApprovePlan, true);

    // Drive the turn via the Instance API (no WS prompt frame either).
    await inst.prompt('plan something');

    // Server should auto-fire: mode flip + approval prompt. Wait until
    // the mode has switched and a user_echo for the approval lands.
    await waitFor(() => inst.mode === 'bypassPermissions', { timeout: 6000 });
    await waitFor(() => inst.ring.toArray().some(
      ev => ev.kind === 'user_echo' && /I approve the plan/.test(ev.text ?? '')
    ), { timeout: 6000 });

    const events = inst.ring.toArray();
    const plan = events.find(ev => ev.kind === 'plan_request');
    assert.ok(plan, 'plan_request must be in the ring');
    assert.equal(plan.autoApproved, true, 'plan_request must be annotated with autoApproved');
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

    // Toggle on. Server must echo the new value via a status broadcast.
    c.send({ t: 'auto_approve_plan', id, enabled: true, reqId: 'a1' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a1' && m.ok === true);
    const on = await c.wait(m => m.t === 'status' && m.id === id && m.autoApprovePlan === true);
    assert.equal(on.autoApprovePlan, true);
    assert.equal(ctx.instances.get(id).autoApprovePlan, true);

    // Toggle off.
    c.send({ t: 'auto_approve_plan', id, enabled: false, reqId: 'a2' });
    await c.wait(m => m.t === 'ack' && m.reqId === 'a2' && m.ok === true);
    const off = await c.wait(m =>
      m.t === 'status' && m.id === id && m.autoApprovePlan === false,
    );
    assert.equal(off.autoApprovePlan, false);
    assert.equal(ctx.instances.get(id).autoApprovePlan, false);

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
    assert.equal(snap.autoApprovePlan, true,
      'a freshly-subscribing client must see the current flag value in its snapshot');

    await c.close();
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('flag does not fire auto-approve when instance is not in plan mode', async () => {
  // Dedicated scenario whose init reports permissionMode:bypassPermissions
  // (the parser reflects that into Instance.mode), so the gating check
  // actually sees a non-plan mode by the time the plan_request lands.
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-plan-bypass-init.json') });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // Spawn directly in bypassPermissions — the flag is set on but the
    // gating check (`mode === 'plan'`) should refuse to act.
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    inst.setAutoApprovePlan(true);

    await inst.prompt('plan something');

    // Let the scenario finish — it emits a turn_end. After that, no
    // user_echo for the approval prompt should appear.
    await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'turn_end'), { timeout: 6000 });
    // Give any racing microtask a chance to fire (it shouldn't).
    await new Promise(r => setTimeout(r, 200));

    const events = inst.ring.toArray();
    const approvalEcho = events.find(
      ev => ev.kind === 'user_echo' && /I approve the plan/.test(ev.text ?? ''),
    );
    assert.equal(approvalEcho, undefined,
      'no approval prompt should be auto-sent when the instance is not in plan mode');
    assert.equal(inst.mode, 'bypassPermissions',
      'mode must remain bypassPermissions — the flag must not have fired anything');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
