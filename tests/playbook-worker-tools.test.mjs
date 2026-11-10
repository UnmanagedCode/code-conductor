// The worker-tools resolver and its denial text (src/playbooks.ts →
// resolveWorkerTool / workerToolDeniedReason). Pure: no store, no gate.
//
// PINS the resolution order — exempt tool, then an exact key, then the longest
// matching wildcard pattern (a tie that disagrees resolves to deny), then the
// `"*"` entry, then allow — with patterns full-matching the RAW CLI tool name
// (anchored, `*` the only wildcard and spanning `__`, case-sensitive), and that
// the resolver names the deciding key so the reason can name it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkerTool, workerToolDeniedReason, WORKER_TOOL_DENIED_IN_STAGE, WORKER_TOOLS_EXEMPT,
} from '../src/playbooks.ts';

const stage = (workerTools) => ({ needs: [], workers: 'one', tools: {}, workerTools });
const decide = (map, tool) => resolveWorkerTool(stage(map), tool);

test('an unlisted tool is allowed, with no deciding key', () => {
  assert.deepEqual(decide({}, 'Edit'), { decision: 'allow', key: null });
  assert.deepEqual(decide({ Write: 'deny' }, 'Edit'), { decision: 'allow', key: null });
});

test('an exact key is anchored: Edit does not reach NotebookEdit, Bash does not reach BashOutput', () => {
  assert.deepEqual(decide({ Edit: 'deny' }, 'Edit'), { decision: 'deny', key: 'Edit' });
  assert.deepEqual(decide({ Edit: 'deny' }, 'NotebookEdit'), { decision: 'allow', key: null });
  assert.deepEqual(decide({ Bash: 'deny' }, 'BashOutput'), { decision: 'allow', key: null });
});

test('an exact key beats a longer matching pattern', () => {
  assert.deepEqual(decide({ Edit: 'allow', 'E*di*t*': 'deny' }, 'Edit'), { decision: 'allow', key: 'Edit' });
  assert.deepEqual(decide({ Edit: 'deny', 'E*di*t*': 'allow' }, 'Edit'), { decision: 'deny', key: 'Edit' });
});

test('a longer pattern beats a shorter one', () => {
  const map = { 'mcp__x__*': 'allow', 'mcp__x__move*': 'deny' };
  assert.deepEqual(decide(map, 'mcp__x__move_card'), { decision: 'deny', key: 'mcp__x__move*' });
  assert.deepEqual(decide(map, 'mcp__x__read_card'), { decision: 'allow', key: 'mcp__x__*' });
  // …and in the other direction, so the rule is length and not polarity.
  const flipped = { 'mcp__x__*': 'deny', 'mcp__x__read*': 'allow' };
  assert.deepEqual(decide(flipped, 'mcp__x__read_card'), { decision: 'allow', key: 'mcp__x__read*' });
  assert.deepEqual(decide(flipped, 'mcp__x__move_card'), { decision: 'deny', key: 'mcp__x__*' });
});

test('equal-length matching patterns that disagree resolve to deny', () => {
  const map = { 'ab*': 'allow', '*bc': 'deny' };
  assert.deepEqual(decide(map, 'abc'), { decision: 'deny', key: '*bc' });
  assert.deepEqual(decide({ 'ab*': 'deny', '*bc': 'allow' }, 'abc'), { decision: 'deny', key: 'ab*' });
  assert.deepEqual(decide({ 'ab*': 'allow', '*bc': 'allow' }, 'abc').decision, 'allow', 'agreeing ties allow');
});

test('"*" is the fallback: "*": "deny" with Read allowed blocks Edit and permits Read', () => {
  const map = { '*': 'deny', Read: 'allow' };
  assert.deepEqual(decide(map, 'Edit'), { decision: 'deny', key: '*' });
  assert.deepEqual(decide(map, 'Read'), { decision: 'allow', key: 'Read' });
  // A matching pattern beats the fallback even though `*` matches too.
  assert.deepEqual(decide({ '*': 'deny', 'mcp__*': 'allow' }, 'mcp__a__b'), { decision: 'allow', key: 'mcp__*' });
});

test('`*` in a pattern matches any run, `__` included, and the match is anchored at both ends', () => {
  const map = { 'mcp__code-conductor__*': 'deny' };
  assert.equal(decide(map, 'mcp__code-conductor__code-kanban__move_card').decision, 'deny');
  assert.equal(decide(map, 'mcp__other__tool').decision, 'allow');
  assert.equal(decide({ 'mcp__*__move_card': 'deny' }, 'mcp__code-conductor__code-kanban__move_card').decision, 'deny');
  assert.equal(decide({ 'mcp__*__move_card': 'deny' }, 'mcp__code-conductor__move_cards').decision, 'allow');
});

test('matching is case-sensitive and applies no MCP-prefix normalisation', () => {
  assert.equal(decide({ edit: 'deny' }, 'Edit').decision, 'allow');
  assert.equal(decide({ send_prompt: 'deny' }, 'mcp__code-conductor__send_prompt').decision, 'allow');
});

test('the exempt tools pass whatever the map says', () => {
  assert.deepEqual([...WORKER_TOOLS_EXEMPT].sort(), ['AskUserQuestion', 'ExitPlanMode']);
  for (const tool of WORKER_TOOLS_EXEMPT) {
    assert.deepEqual(decide({ '*': 'deny' }, tool), { decision: 'allow', key: null }, `${tool} under "*": "deny"`);
    assert.deepEqual(decide({ [`${tool.slice(0, 3)}*`]: 'deny' }, tool).decision, 'allow', `${tool} under a covering pattern`);
  }
});

test('the reason names the stage, the playbook, the tool and the deciding key, "*" included', () => {
  const reason = workerToolDeniedReason({ playbook: 'relay', stage: 'review', toolName: 'Edit', key: '*' });
  for (const part of ["'review'", "'relay'", 'Edit', "'*'"]) assert.ok(reason.includes(part), `${part} in: ${reason}`);
  assert.match(reason, /retry/i);
  const exact = workerToolDeniedReason({ playbook: 'relay', stage: 'review', toolName: 'Edit', key: 'Edit' });
  assert.ok(exact.includes("'Edit'"), exact);
  assert.equal(WORKER_TOOL_DENIED_IN_STAGE, 'WORKER_TOOL_DENIED_IN_STAGE', 'the event-log refusal code');
});
