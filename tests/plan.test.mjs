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
const SUBAGENT_WRITE_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-subagent-plan-write.json');

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

test('plan mode: ExitPlanMode emits a plan_request enriched with the plan file content; turn ends cleanly without auto-interrupt', async () => {
  // Seed the plan file at the path the scenario references via $PLANFILE.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'test-plan.md');
  const planText = '# Plan\n- Make X\n- Then Y\n';
  await fs.writeFile(planFile, planText);
  process.env.FAKE_PLAN_FILE = planFile;

  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const fsp = fs;
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'plan something' });

    // plan_request arrives with the enriched plan content from the file.
    const planEv = await c.wait(m => m.t === 'event' && m.ev.kind === 'plan_request');
    assert.equal(planEv.ev.toolUseId, 'tu_exit');
    assert.equal(planEv.ev.planPath, planFile);
    assert.match(planEv.ev.plan, /# Plan/);
    assert.match(planEv.ev.plan, /Make X/);

    // The CLI's PreToolUse hook denied ExitPlanMode and the model ended
    // the turn cleanly — no auto-interrupt needed.
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.isError, false);
    assert.equal(turn.ev.stopReason, 'end_turn');

    // No interrupt control_request should have been issued.
    await waitFor(async () => { try { await fsp.stat(transcriptPath); return true; } catch { return false; } });
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const interrupt = lines.find(l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
    assert.equal(interrupt, undefined, `no interrupt should have been sent; transcript: ${JSON.stringify(lines)}`);

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// A2 regression: a sub-agent's Write to a plan file (forwarded envelope,
// parentToolUseId set) must not latch PlanFileTracker for the OUTER agent.
// Without the src/instances.ts:2061 guard, the outer ExitPlanMode's
// plan_request (no planFilePath, no inline plan) would fall into branch 3
// and present the sub-agent's scratch file's contents as the plan being
// approved.
test('plan mode: a sub-agent Write to a plan file does not enrich the outer ExitPlanMode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-sub-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'sub-plan.md');
  process.env.FAKE_PLAN_FILE = planFile;

  const ctx = await bootServer({ scenarioPath: SUBAGENT_WRITE_SCENARIO });
  let c;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'do something' });

    const planEv = await c.wait(m => m.t === 'event' && m.ev.kind === 'plan_request');
    assert.equal(planEv.ev.toolUseId, 'tu_exit');
    assert.equal(planEv.ev.planPath, null, 'the sub-agent write must not bind a path to the outer plan_request');
    assert.equal(planEv.ev.plan, null, 'the outer plan_request must not present the sub-agent scratch file as the plan');
  } finally {
    // Close the WS connection before the server, regardless of whether the
    // assertions above threw — server.close() waits for open connections to
    // end, so a live socket here would hang ctx.close() forever on failure.
    if (c) await c.close().catch(() => {});
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('plan-approve flow: WS mode switch from plan → bypassPermissions is accepted by setMode', async () => {
  // The actual real-claude flow: after the plan_request auto-interrupt
  // the user clicks Approve, the UI sends {t:"mode", mode:"bypassPermissions"}
  // over WS, then the prompt. Verify that path works end-to-end (the
  // existing test only covered the parser→event side, not the response).
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-plan.json') });
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
    process.env.FAKE_PLAN_FILE = '/tmp/never-read.md'; // not used by this test path

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'pa' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'pa', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(ctx.instances.get(id).mode, 'plan', 'starts in plan mode');

    const inst = ctx.instances.get(id);
    await inst.setMode('bypassPermissions');
    assert.equal(inst.mode, 'bypassPermissions', 'setMode flipped the orchestrator-tracked mode');

    const fsp = (await import('node:fs')).promises;
    await waitFor(async () => { try { await fsp.stat(transcriptPath); return true; } catch { return false; } });
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const modeReq = lines.find(l => l.type === 'control_request' && l.request?.subtype === 'set_permission_mode');
    assert.ok(modeReq, 'set_permission_mode control_request must have been sent');
    assert.equal(modeReq.request.mode, 'bypassPermissions');
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
  }
});
