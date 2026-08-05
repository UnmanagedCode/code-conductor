// Playbook definition schema + load-time validator (src/playbooks.ts).
//
// Every rule here is enforced AT LOAD TIME, not at spawn time: a typo in a
// definition must fail loudly when the definition is read, not silently do
// nothing on some later call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlaybook, loadPlaybooks, loadToolIndex, governableToolNames,
  SEED_PLAYBOOK_IDS, REQUIRE_FORBIDDEN_KEYS,
} from '../src/playbooks.ts';

const index = await loadToolIndex();

// A minimal VALID definition. Each test perturbs exactly one thing, so a
// failure localises to the rule under test rather than to the fixture.
function base(patch = {}) {
  return {
    id: 'fixture',
    name: 'Fixture',
    description: 'a fixture',
    entryStages: ['a'],
    stages: { a: { tools: { spawn_instance: 'allow' } } },
    transitions: [],
    ...patch,
  };
}

function expectOk(def, id = 'fixture') {
  const res = validatePlaybook(def, id, index);
  assert.ok(res.ok, `expected valid, got errors: ${JSON.stringify(res.errors ?? [])}`);
  return res.playbook;
}

// Assert the definition is rejected AND that some error matches `re`. Matching
// the message (not just the count) is what stops a rule from being "covered" by
// an unrelated error firing.
function expectErr(def, re, id = 'fixture') {
  const res = validatePlaybook(def, id, index);
  assert.equal(res.ok, false, 'expected the definition to be rejected');
  const hit = res.errors.some(e => re.test(e));
  assert.ok(hit, `no error matched ${re}; errors were:\n  ${res.errors.join('\n  ')}`);
  return res.errors;
}

test('the base fixture is valid (guards every expectErr below against a broken fixture)', () => {
  expectOk(base());
});

// ── the shipped built-ins ───────────────────────────────────────────────────

test('all four built-in playbooks load and validate clean', async () => {
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, [], `built-in playbooks must validate: ${JSON.stringify(errors)}`);
  for (const id of SEED_PLAYBOOK_IDS) {
    assert.ok(playbooks.has(id), `missing built-in playbook '${id}'`);
    // name/description come from the JSON body, not from a restated TS list.
    assert.ok(playbooks.get(id).name.length > 0, `${id} has no name`);
    assert.ok(playbooks.get(id).description.length > 0, `${id} has no description`);
  }
  assert.equal(playbooks.get('classic').entryStages.join(','), 'plan');
  // split's defining property: the planner has no way out of `plan`.
  assert.equal(playbooks.get('split').transitions.some(t => t.from === 'plan'), false);
});

// ── the governable surface is DERIVED, not a hardcoded list ─────────────────

test('governable tools are derived from buildTools(): sessionId-taking tools plus spawn_instance', () => {
  const names = governableToolNames(index);
  for (const t of ['send_prompt', 'set_mode', 'approve_plan', 'merge_worktree', 'sync_worktree',
                   'kill_instance', 'get_transcript', 'locate_session', 'spawn_instance']) {
    assert.ok(names.includes(t), `${t} should be governable`);
  }
  // Ungoverned BY CONSTRUCTION (targeted-only scope): these declare no sessionId.
  // renew_session acts on the caller; delete_worktree is keyed {project,worktree}.
  for (const t of ['renew_session', 'delete_worktree', 'project_read', 'project_bash',
                   'list_projects', 'list_instances', 'create_worktree']) {
    assert.ok(!names.includes(t), `${t} must NOT be governable`);
  }
});

// ── graph integrity ────────────────────────────────────────────────────────

test('a transition naming an unknown stage is rejected', () => {
  expectErr(base({ transitions: [{ from: 'a', to: 'nope' }] }), /transition to names unknown stage 'nope'/);
  expectErr(base({ transitions: [{ from: 'nope', to: 'a' }] }), /transition from names unknown stage 'nope'/);
});

test('needs naming an unknown stage is rejected', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: 'allow' } }, b: { needs: [{ stage: 'nope' }] } } }),
    /needs names unknown stage 'nope'/,
  );
});

test('an unreachable stage is rejected — no entry, not spawnable, no inbound edge', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: 'allow' } }, orphan: {} } }),
    /stage 'orphan' is unreachable/,
  );
  // Reachable via an inbound transition ⇒ fine.
  expectOk(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, orphan: {} },
    transitions: [{ from: 'a', to: 'orphan' }],
  }));
});

test('entryStages naming a stage that does not declare spawn_instance is rejected', () => {
  expectErr(
    base({ entryStages: ['a', 'b'], stages: { a: { tools: { spawn_instance: 'allow' } }, b: {} } }),
    /entryStages names 'b', which does not declare spawn_instance/,
  );
});

test('a spawnable stage must be an entry stage OR declare a non-empty needs', () => {
  // Spawnable, not an entry stage, no needs ⇒ a worker in no run component.
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: 'allow' } }, b: { tools: { spawn_instance: 'allow' } } } }),
    /stage 'b' declares spawn_instance but is neither listed in entryStages nor declares a non-empty `needs`/,
  );
  // Same stage, now with needs ⇒ it joins the run through that edge.
  expectOk(base({
    stages: {
      a: { tools: { spawn_instance: 'allow' } },
      b: { needs: [{ stage: 'a' }], tools: { spawn_instance: 'allow' } },
    },
  }));
});

// ── `require` key validation against the tool's REAL inputSchema ────────────

test('a require key that is not an argument of the tool is rejected', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: { require: { moed: 'plan' } } } } } }),
    /require names 'moed', which is not an argument of spawn_instance/,
  );
  // The real argument name passes, proving the check reads the actual schema.
  expectOk(base({ stages: { a: { tools: { spawn_instance: { require: { mode: 'plan' } } } } } }));
});

test('require on a policy-layer input is rejected for each of sessionId/stage/playbook/needs', () => {
  for (const key of REQUIRE_FORBIDDEN_KEYS) {
    expectErr(
      base({ stages: { a: { tools: { spawn_instance: { require: { [key]: 'x' } } } } } }),
      new RegExp(`require cannot constrain '${key}'`),
    );
  }
});

// This is the precedence the plan calls out explicitly. `spawn_instance` has NO
// `stage`/`playbook`/`needs` property today (step 4 adds them), so checking
// existence-in-inputSchema first would report these as typos now and silently
// start reporting them as policy-layer inputs later. Pin the order.
test('the require-forbidden-key check PRECEDES the exists-in-inputSchema check', () => {
  for (const key of ['stage', 'playbook', 'needs']) {
    const res = validatePlaybook(
      base({ stages: { a: { tools: { spawn_instance: { require: { [key]: 'x' } } } } } }), 'fixture', index);
    assert.equal(res.ok, false);
    const joined = res.errors.join('\n');
    assert.match(joined, new RegExp(`require cannot constrain '${key}'`),
      `${key} must be reported as a policy-layer input`);
    assert.doesNotMatch(joined, /is not an argument of/,
      `${key} must NOT be reported as a typo — the forbidden-key check has to run first`);
  }
  // Sanity: the tool genuinely lacks these properties today, so the precedence
  // is load-bearing rather than incidental.
  for (const key of ['stage', 'playbook', 'needs']) {
    assert.ok(!index.get('spawn_instance').has(key),
      `spawn_instance unexpectedly declares '${key}' — revisit this test's premise`);
  }
  // sessionId, by contrast, IS a real argument of set_mode and still refused.
  assert.ok(index.get('set_mode').has('sessionId'));
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', set_mode: { require: { sessionId: 'x' } } } } } }),
    /require cannot constrain 'sessionId'/);
});

test('require error text keeps `require` and `needs` distinct', () => {
  const errs = expectErr(
    base({ stages: { a: { tools: { spawn_instance: { require: { stage: 'x' } } } } } }),
    /require cannot constrain 'stage'/);
  const msg = errs.join('\n');
  assert.match(msg, /ARGUMENT VALUES/, 'must say require is about argument values');
  assert.match(msg, /`needs`/, 'must point at needs as the thing for worker provenance');
});

test('a require value must be a literal — no expression language', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: { require: { mode: { $eq: 'plan' } } } } } } }),
    /require\.mode must be a literal string, number, boolean or null/,
  );
  for (const v of ['plan', 3, true, false, null]) {
    expectOk(base({ stages: { a: { tools: { spawn_instance: 'allow', set_mode: { require: { mode: v } } } } } }));
  }
});

// ── the `tools` map ────────────────────────────────────────────────────────

test('a tool name outside the governable set is rejected', () => {
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', project_read: 'deny' } } } }),
    /'project_read' is not a governable tool/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', delete_worktree: 'deny' } } } }),
    /'delete_worktree' is not a governable tool/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', renew_session: 'deny' } } } }),
    /'renew_session' is not a governable tool/);
  // Prefix globs are not a thing — only the bare '*' fallback entry.
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', 'code-kanban__*': 'deny' } } } }),
    /is not a governable tool/);
});

test("the '*' fallback entry is accepted but cannot carry require", () => {
  expectOk(base({ stages: { a: { tools: { '*': 'deny', spawn_instance: 'allow' } } } }));
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', '*': { require: { mode: 'plan' } } } } } }),
    /the "\*" fallback entry cannot carry `require`/);
});

test('an invalid tools value is rejected', () => {
  for (const bad of ['allowed', true, 42, null, {}, { require: {} }, { require: { mode: 'plan' }, extra: 1 }]) {
    expectErr(base({ stages: { a: { tools: { spawn_instance: bad } } } }),
      /tools\.spawn_instance must be "allow", "deny", or \{ "require": \{\.\.\.\} \}|require must be a non-empty object/);
  }
});

// ── transitions ────────────────────────────────────────────────────────────

test('a duplicate from->to transition is rejected', () => {
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: {} },
    transitions: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
  }), /duplicate transition a->b/);
});

test('a transition `on` must be a governable tool, and neither send_prompt nor spawn_instance', () => {
  const stages = { a: { tools: { spawn_instance: 'allow' } }, b: {} };
  expectErr(base({ stages, transitions: [{ from: 'a', to: 'b', on: 'project_read' }] }),
    /on names 'project_read', which is not a governable tool/);
  expectErr(base({ stages, transitions: [{ from: 'a', to: 'b', on: 'spawn_instance' }] }),
    /on cannot be spawn_instance/);
  // send_prompt is THE default driver for an `on`-less edge, so declaring it is
  // an ambiguous no-op rather than a second way to say the same thing.
  expectErr(base({ stages, transitions: [{ from: 'a', to: 'b', on: 'send_prompt' }] }),
    /on cannot be send_prompt/);
  expectOk(base({ stages, transitions: [{ from: 'a', to: 'b', on: 'approve_plan' }] }));
});

// ── shape + defaults ───────────────────────────────────────────────────────

test('unknown top-level and unknown per-stage keys are rejected', () => {
  expectErr(base({ stagez: {} }), /unknown top-level key 'stagez'/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow' }, tolls: {} } } }),
    /stage 'a': unknown key 'tolls'/);
});

test('id must be a valid slug and must match the filename it came from', () => {
  expectErr(base({ id: 'Fixture' }), /invalid id 'Fixture'/, 'Fixture');
  expectErr(base({ id: 'other' }), /id 'other' does not match its filename id 'fixture'/);
});

test('name/description/stages shape is enforced', () => {
  expectErr(base({ name: '' }), /name is required/);
  expectErr(base({ description: '   ' }), /description is required/);
  expectErr(base({ stages: {} }), /stages must be a non-empty object/);
  expectErr(base({ entryStages: 'a' }), /entryStages must be an array/);
  expectErr(base({ transitions: {} }), /transitions must be an array/);
  assert.equal(validatePlaybook('nope', 'fixture', index).ok, false);
});

test('needs.at and workers reject unknown values', () => {
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: { needs: [{ stage: 'a', at: 'someday' }] } },
  }), /needs\.at must be one of current \| ever/);
  expectErr(base({ stages: { a: { workers: 'three', tools: { spawn_instance: 'allow' } } } }),
    /workers must be one of one \| many/);
});

test('defaults are applied for omitted tools/workers/needs/at', () => {
  const pb = expectOk(base({
    stages: {
      a: { tools: { spawn_instance: 'allow' } },
      b: { needs: [{ stage: 'a' }] },       // at omitted
    },
    transitions: [{ from: 'a', to: 'b' }],
  }));
  assert.deepEqual(pb.stages.b.needs, [{ stage: 'a', at: 'current' }], 'at defaults to "current"');
  assert.equal(pb.stages.b.workers, 'one', 'workers defaults to "one"');
  assert.deepEqual(pb.stages.b.tools, {}, 'tools defaults to {}');
  assert.deepEqual(pb.stages.a.needs, [], 'needs defaults to []');
});
