// The set of tools whose governed calls that run are recorded as event-log
// `call` rows: derived from the tool registry, never listed by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as playbooks from '../src/playbooks.ts';

async function interactionTools() {
  assert.equal(typeof playbooks.loadInteractionTools, 'function', 'loadInteractionTools is exported');
  return playbooks.loadInteractionTools();
}

test('the interaction set contains the tools that act on a worker', async () => {
  const set = await interactionTools();
  for (const name of ['send_prompt', 'approve_plan', 'reject_plan', 'answer_question', 'interrupt_turn', 'kill_instance']) {
    assert.ok(set.has(name), `${name} acts on a worker, so its calls are recorded`);
  }
});

test('every interaction tool declares sessionId and none is readOnlyHint', async () => {
  const set = await interactionTools();
  const { buildTools } = await import('../src/mcp/tools.ts');
  const byName = new Map(buildTools().map(t => [t.name, t]));
  assert.ok(set.size > 0);
  for (const name of set) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is a registered tool`);
    assert.ok(tool.inputSchema?.properties?.sessionId, `${name} declares sessionId`);
    assert.notEqual(tool.annotations?.readOnlyHint, true, `${name} is not read-only`);
  }
});

test('read-only observers and spawn_instance are not interaction tools', async () => {
  const set = await interactionTools();
  for (const name of ['describe_session', 'get_transcript', 'get_recent_messages', 'playbook_state', 'spawn_instance']) {
    assert.equal(set.has(name), false, `${name} is excluded`);
  }
});
