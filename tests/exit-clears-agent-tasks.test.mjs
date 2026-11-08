// A CLI that dies with an agent task still running sends no terminal task
// frames, so Instance._handleExit clears _activeAgentTasks itself: a dead
// worker never reports a running agent. The clear lands before the exit's
// status change, so the status edge that says `crashed`/`exited` already
// carries zero agent tasks.
//
// The task is injected as the CLI's own `system/task_started` stdout frame
// (an auto-backgrounded MCP call's `mcp_task`) once the instance is idle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

async function idleWithRunningMcpTask() {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const p = await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-haiku-4-5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.proc);
  inst._handleStdoutLine(JSON.stringify({
    type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', task_type: 'mcp_task',
    description: 'slow call', session_id: inst.sessionId,
  }));
  assert.equal(inst.activeAgentTaskCount, 1, 'premise: the mcp_task is counted');
  assert.equal(inst.summary().displayStatus, 'running', 'premise: an idle worker with a running task displays running');
  return { ctx, inst };
}

test('a SIGKILLed worker with a running mcp_task reports no running agents', async () => {
  const { ctx, inst } = await idleWithRunningMcpTask();
  try {
    inst.proc.kill('SIGKILL');
    await waitFor(() => inst.status === 'crashed');
    assert.equal(inst.activeAgentTaskCount, 0);
    assert.equal(inst.summary().activeAgentTasks, 0);
    assert.equal(inst.summary().displayStatus, 'crashed');
  } finally { await ctx.close(); }
});

test('the crash status edge already carries zero agent tasks', async () => {
  const { ctx, inst } = await idleWithRunningMcpTask();
  try {
    const edges = [];
    inst.on('status', (s) => { if (s.status === 'crashed') edges.push(s); });
    inst.proc.kill('SIGKILL');
    await waitFor(() => edges.length > 0);
    assert.equal(edges[0].activeAgentTasks, 0);
    assert.equal(edges[0].displayStatus, 'crashed');
  } finally { await ctx.close(); }
});

test('a commanded kill clears the count too', async () => {
  const { ctx, inst } = await idleWithRunningMcpTask();
  try {
    await inst.kill({ graceMs: 50 });
    await waitFor(() => !inst.proc && (inst.status === 'exited' || inst.status === 'crashed'));
    assert.equal(inst.status, 'exited');
    assert.equal(inst.activeAgentTaskCount, 0);
    assert.equal(inst.summary().activeAgentTasks, 0);
  } finally { await ctx.close(); }
});
