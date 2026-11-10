// The tool-result nudge plumbing (src/toolResultNudges.ts): a nudge a handler
// queues under its call's toolUseId, taken once by that call's PostToolUse hook.
// The integration rows live beside each nudge's own gating
// (tests/mcp-spawn-self-title-nudge.test.mjs, tests/landing-renew-nudge.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PendingToolNudges, toolUseIdOf, TOOL_USE_ID_META_KEY, TOOL_RESULT_NUDGE_TOOLS, TOOL_RESULT_NUDGE_MATCHER,
  isToolResultNudgeTool,
} from '../src/toolResultNudges.ts';
import { HookBroker } from '../src/hookBroker.ts';

// INVARIANT: take returns every distinct text queued under that id, joined by a
// blank line, keeps a repeated text once, and deletes the entry (one-shot).
test('PendingToolNudges: take joins distinct texts once, then the entry is gone', () => {
  const p = new PendingToolNudges();
  p.queue('A', 'x');
  p.queue('A', 'x');
  p.queue('A', 'y');
  p.queue('B', 'z');
  assert.equal(p.take('A'), 'x\n\ny');
  assert.equal(p.take('A'), null, 'a second take of the same id finds nothing');
  assert.equal(p.take('nope'), null);
  assert.equal(p.take('B'), 'z', 'another id is untouched by A\'s take');
});

// INVARIANT: clear drops every pending entry.
test('PendingToolNudges: clear drops everything pending', () => {
  const p = new PendingToolNudges();
  p.queue('A', 'x');
  p.queue('B', 'y');
  p.clear();
  assert.equal(p.take('A'), null);
  assert.equal(p.take('B'), null);
});

// INVARIANT: toolUseIdOf reads params._meta["claudecode/toolUseId"] and returns a
// non-empty string or null — never a non-string, never an empty string.
test('toolUseIdOf: a non-empty string under the meta key, else null', () => {
  assert.equal(TOOL_USE_ID_META_KEY, 'claudecode/toolUseId');
  assert.equal(toolUseIdOf({ name: 't', _meta: { [TOOL_USE_ID_META_KEY]: 'toolu_1' } }), 'toolu_1');
  for (const params of [undefined, null, 42, {}, { _meta: null }, { _meta: {} },
    { _meta: { [TOOL_USE_ID_META_KEY]: '' } }, { _meta: { [TOOL_USE_ID_META_KEY]: 5 } },
    { _meta: { toolUseId: 'toolu_1' } }]) {
    assert.equal(toolUseIdOf(params), null, `toolUseIdOf(${JSON.stringify(params)})`);
  }
});

// INVARIANT: the settings matcher is anchored — it matches exactly the nudge
// tools (spawn_instance and delete_worktree on cc's server), and no tool whose
// name merely contains one, another server's same-named tool, or run_code — and
// isToolResultNudgeTool agrees with it on every probe.
test('the matcher is anchored and covers exactly the nudge tools', () => {
  const re = new RegExp(TOOL_RESULT_NUDGE_MATCHER);
  assert.deepEqual([...TOOL_RESULT_NUDGE_TOOLS].sort(),
    ['mcp__code-conductor__delete_worktree', 'mcp__code-conductor__spawn_instance']);
  for (const tool of TOOL_RESULT_NUDGE_TOOLS) {
    assert.equal(re.test(tool), true, tool);
    assert.equal(isToolResultNudgeTool(tool), true, tool);
  }
  const misses = [
    ...TOOL_RESULT_NUDGE_TOOLS.flatMap(t => [`${t}_x`, `x${t}`]),
    'mcp__other__spawn_instance', 'spawn_instance', 'mcp__code-conductor__run_code', 'Bash',
  ];
  for (const name of misses) {
    assert.equal(re.test(name), false, `matcher must not match ${name}`);
    assert.equal(isToolResultNudgeTool(name), false, `isToolResultNudgeTool(${name})`);
  }
});

function fakeRes() {
  let settle;
  const done = new Promise(r => { settle = r; });
  const res = {
    headersSent: false, code: 0, body: undefined, done,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; this.headersSent = true; settle(); return this; },
  };
  return res;
}

async function answer(broker, envelope) {
  const res = fakeRes();
  broker.handle(envelope, res);
  await res.done;
  assert.equal(res.code, 200);
  return res.body;
}

const SPAWN = 'mcp__code-conductor__spawn_instance';
const post = (tool, id, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, tool_input: {}, ...extra });

// INVARIANT: a PostToolUse on a nudge tool is answered from the pending nudges
// (additionalContext alone, or {} when none) and never reaches the session's
// redirect, while a PostToolUse on any other tool still does.
test('HookBroker: nudge tools answer from the pending nudges and skip the redirect', async () => {
  const redirectCalls = [];
  const redirect = {
    preToolUse: async () => ({ decision: 'allow' }),
    postToolUse: async (tool) => { redirectCalls.push(tool); return `note for ${tool}`; },
  };
  const toolNudges = new PendingToolNudges();
  const broker = new HookBroker({ getRedirect: () => redirect, toolNudges });
  toolNudges.queue('tu_1', 'NUDGE');

  assert.deepEqual(await answer(broker, post(SPAWN, 'tu_1')),
    { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'NUDGE' } });
  assert.deepEqual(await answer(broker, post(SPAWN, 'tu_2')), {}, 'nothing pending → {}');
  assert.deepEqual(redirectCalls, [], 'a nudge tool never reaches the redirect');

  assert.deepEqual(await answer(broker, post('Bash', 'tu_3')),
    { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note for Bash' } });
  assert.deepEqual(redirectCalls, ['Bash'], 'another tool still takes the redirect path');
});
