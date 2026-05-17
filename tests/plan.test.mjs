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

test('plan mode: ExitPlanMode emits a plan_request enriched with the plan file content + orchestrator auto-interrupts', async () => {
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

    // Auto-interrupt ended the turn cleanly so the plan card is the tail.
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.stopReason, 'interrupted');

    // Verify the orchestrator's stdin transcript actually contains the
    // interrupt control_request.
    await waitFor(async () => { try { await fsp.stat(transcriptPath); return true; } catch { return false; } });
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const interrupt = lines.find(l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
    assert.ok(interrupt, 'expected an interrupt control_request after ExitPlanMode');

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
