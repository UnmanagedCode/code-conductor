// Playbook definition schema + load-time validator (src/playbooks.ts).
//
// Every rule here is enforced AT LOAD TIME, not at spawn time: a typo in a
// definition must fail loudly when the definition is read, not silently do
// nothing on some later call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlaybook, loadPlaybooks, loadToolIndex, governableToolNames,
  SEED_PLAYBOOK_IDS, PIN_FORBIDDEN_KEYS,
} from '../src/playbooks.ts';
import { buildTools } from '../src/mcp/tools.ts';
import { resolveSpawnModel } from '../src/mcp/handlers.ts';
import { builtins } from './playbook-fixtures.mjs';

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

test('the built-in playbooks are exactly solo/relay/freeform, and all load clean', async () => {
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, [], `built-in playbooks must validate: ${JSON.stringify(errors)}`);
  assert.deepEqual([...playbooks.keys()].sort(), ['freeform', 'relay', 'solo'],
    'a leftover definition file or a missing one both land here');
  for (const id of SEED_PLAYBOOK_IDS) {
    assert.ok(playbooks.has(id), `missing built-in playbook '${id}'`);
    // name/description come from the JSON body, not from a restated TS list.
    assert.ok(playbooks.get(id).name.length > 0, `${id} has no name`);
    assert.ok(playbooks.get(id).description.length > 0, `${id} has no description`);
    // WHICH stages are entry stages is the author's business; that there is at
    // least one is not. A playbook with none can only ever be entered through a
    // stage declaring `needs`, so no run of it can ever start. (That every entry
    // stage is spawnable is a load-time rule, already covered by the empty
    // `errors` above.)
    assert.ok(playbooks.get(id).entryStages.length > 0,
      `${id} declares no entry stage — no run of it could ever start`);
  }
});

// ── `needs.position` vs the graph ───────────────────────────────────────────
//
// This replaces a frozen table of every built-in stage's resolved `needs`. The
// table restated values from playbooks/*.json as literal expectations, so an
// ordinary hand edit reddened it; what it was actually guarding is stated here
// as the invariant instead, generic over whatever ships.
//
// The regression it exists for (618d62a): the `review` gate was narrowed to its
// anchor alone while `implement -> refine` existed, so a second-lens reviewer
// became unspawnable the moment the implementer advanced — legally — into
// `refine`, and nothing else caught it.
//
// Direction: this guards NARROWING only. A `["*"]` list covers every closure by
// construction, so the widening direction is invisible here; it is pinned at the
// render layer instead, by describe_playbook's `needs` line in
// tests/playbook-read-tools.test.mjs.
//
// `liveness` is deliberately NOT pinned here. relay.implement's `any` (a planner
// that dies must not brick the run) and solo.review's `live` (refine sends the
// same reviewers back) are editorial calls with no mechanical rule to derive
// them from, and freezing them is the change-detector this test replaces.
test('every built-in `needs.position` covers every stage its anchor can reach', async () => {
  const playbooks = await builtins();
  let checked = 0;
  for (const pb of playbooks.values()) {
    // Transitive closure of the edges out of `from`, `from` included.
    const reachable = from => {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const at = queue.pop();
        for (const t of pb.transitions) {
          if (t.from === at && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
        }
      }
      return seen;
    };
    for (const [stageName, stage] of Object.entries(pb.stages)) {
      for (const need of stage.needs) {
        checked++;
        // `["*"]` accepts any stage, so it covers the closure by construction.
        if (need.position.includes('*')) continue;
        const unreachable = [...reachable(need.stage)].filter(s => !need.position.includes(s));
        assert.deepEqual(unreachable, [],
          `${pb.id}.${stageName}.needs.${need.stage}.position is ${JSON.stringify(need.position)}, but a ` +
          `worker in '${need.stage}' can legally reach ${JSON.stringify(unreachable)} — advancing there ` +
          'would make this stage unenterable.');
      }
    }
  }
  // Guards the loop: a graph edit that left no `needs` entry to check, or a
  // refactor that stopped finding them, would otherwise pass vacuously.
  assert.ok(checked >= 4, `expected to check several needs entries, checked ${checked}`);
});

// The built-ins are the templates user authors copy, and (per the dynamic
// preferred-playbook convention) their stage descriptions land in the conductor's
// system prompt. This pins the two MECHANICAL halves of that: every stage is
// described, and the transition surface stays unpopulated — deliberately empty
// on the built-ins so it is not a surface anyone has to keep trim. It cannot
// pin WORDING: filler text passes. That gate is editorial, i.e. review.
test('every built-in stage carries a description and no built-in transition does', async () => {
  const { playbooks } = await loadPlaybooks();
  for (const id of SEED_PLAYBOOK_IDS) {
    const pb = playbooks.get(id);
    for (const [name, stage] of Object.entries(pb.stages)) {
      assert.equal(typeof stage.description, 'string', `${id}.${name} has no description`);
      assert.ok(stage.description.trim().length > 0, `${id}.${name} has an empty description`);
    }
    for (const t of pb.transitions) {
      assert.equal('description' in t, false,
        `${id}: transition ${t.from}->${t.to} carries a description; built-ins leave that field empty`);
    }
  }
});

// A built-in's `require` values must be resolvable BY THE REAL PRODUCT, not
// merely well-typed. The validator checks that a `require` key is a genuine
// argument NAME of its tool; it cannot check that the VALUE means anything —
// which is how `"model": "planner"` shipped, naming a role that exists nowhere
// in the registry, making solo and relay throw BAD_MODEL on every spawn.
//
// So each value is checked against whatever actually owns its domain:
//   • the tool's own inputSchema, for `enum`/`type` constraints (covers `mode`,
//     `createWorktree`, and any future constrained argument, generically); and
//   • resolveSpawnModel — the exact ladder spawn_instance itself runs — for
//     `model`, whose valid values live in the model registry, not the schema.
test('every built-in `pin` value resolves against the real product', async () => {
  const playbooks = await builtins();
  const schemas = new Map(buildTools().map(t => [t.name, t.inputSchema]));
  let checked = 0;
  for (const pb of playbooks.values()) {
    for (const [stageName, stage] of Object.entries(pb.stages)) {
      for (const [toolName, policy] of Object.entries(stage.tools)) {
        if (typeof policy === 'string') continue;
        const props = schemas.get(toolName)?.properties ?? {};
        for (const [arg, value] of Object.entries(policy.pin)) {
          const where = `${pb.id}.${stageName}.tools.${toolName}.pin.${arg}`;
          const prop = props[arg] ?? {};
          if (Array.isArray(prop.enum)) {
            assert.ok(prop.enum.includes(value),
              `${where} = ${JSON.stringify(value)} is not one of ${JSON.stringify(prop.enum)}`);
          }
          if (prop.type === 'boolean') assert.equal(typeof value, 'boolean', `${where} must be a boolean`);
          if (prop.type === 'string') assert.equal(typeof value, 'string', `${where} must be a string`);
          if (arg === 'model') {
            assert.doesNotThrow(() => resolveSpawnModel(value),
              `${where} = ${JSON.stringify(value)} is not a resolvable tier, role, family alias or model id`);
          }
          checked++;
        }
      }
    }
  }
  // Guards the loop itself: a refactor that stopped finding `require` entries
  // would otherwise make this test vacuously green.
  assert.ok(checked >= 4, `expected to check several pin values, checked ${checked}`);
});

// ── the governable surface is DERIVED, not a hardcoded list ─────────────────

test('governable tools are derived from buildTools(): sessionId-taking tools plus spawn_instance', () => {
  const names = governableToolNames(index);
  // `renew_session` is here because it now declares an OPTIONAL `sessionId` (the
  // conductor-requested renewal). Membership follows the schema, with no
  // carve-out for a tool that is only sometimes targeted.
  for (const t of ['send_prompt', 'set_mode', 'approve_plan', 'sync_worktree',
                   'kill_instance', 'get_transcript', 'locate_session', 'spawn_instance',
                   'renew_session']) {
    assert.ok(names.includes(t), `${t} should be governable`);
  }
  // Ungoverned BY CONSTRUCTION (targeted-only scope): these declare no sessionId,
  // so nothing names a worker for policy to be read from. A sample of the class —
  // the authoritative membership is whatever governableToolNames() computes.
  for (const t of ['delete_worktree', 'merge_worktree', 'project_read',
                   'project_bash', 'list_projects', 'list_sessions', 'create_worktree']) {
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

// `require` was the old spelling of `pin`. It is a RENAME, not an alias: a
// definition still using it must fail at load rather than quietly lose its
// constraint, which for solo.plan would mean spawning the planner in
// bypassPermissions instead of plan mode.
test('the retired `require` key is rejected, not silently accepted as a pin', () => {
  expectErr(base({ stages: { a: { tools: { spawn_instance: { require: { mode: 'plan' } } } } } }),
    /must be "allow", "deny", or \{ "pin": \{\.\.\.\} \}/);
});

test('a pin key that is not an argument of the tool is rejected', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: { pin: { moed: 'plan' } } } } } }),
    /pin names 'moed', which is not an argument of spawn_instance/,
  );
  // The real argument name passes, proving the check reads the actual schema.
  expectOk(base({ stages: { a: { tools: { spawn_instance: { pin: { mode: 'plan' } } } } } }));
});

test('pin on a policy-layer input is rejected for each of sessionId/stage/playbook/provenance', () => {
  for (const key of PIN_FORBIDDEN_KEYS) {
    expectErr(
      base({ stages: { a: { tools: { spawn_instance: { pin: { [key]: 'x' } } } } } }),
      new RegExp(`pin cannot constrain '${key}'`),
    );
  }
});

// The forbidden-key check runs first so a `pin` on a policy-layer input always
// reports as one rather than as a typo. WHICH of PIN_FORBIDDEN_KEYS a tool
// declares varies — spawn_instance declares `playbook`/`stage`/`provenance` but no
// `sessionId`; set_mode is the reverse, declaring `sessionId` alone — so
// exists-first would report the same mistake differently per tool, and would keep
// changing as schemas gain or lose those properties. Both directions are asserted
// below, and both are asserted against the live index rather than trusted.
test('the pin-forbidden-key check PRECEDES the exists-in-inputSchema check', () => {
  for (const key of ['stage', 'playbook', 'provenance']) {
    const res = validatePlaybook(
      base({ stages: { a: { tools: { spawn_instance: { pin: { [key]: 'x' } } } } } }), 'fixture', index);
    assert.equal(res.ok, false);
    const joined = res.errors.join('\n');
    assert.match(joined, new RegExp(`pin cannot constrain '${key}'`),
      `${key} must be reported as a policy-layer input`);
    assert.doesNotMatch(joined, /is not an argument of/,
      `${key} must NOT be reported as a typo — the forbidden-key check has to run first`);
  }
  // spawn_instance now genuinely DECLARES all three (the enforcement wiring added
  // them), which is precisely the change the ordering was written to survive: an
  // exists-first check would have reported them as typos before, and would start
  // silently accepting them into the exists-branch now.
  for (const key of ['stage', 'playbook', 'provenance']) {
    assert.ok(index.get('spawn_instance').has(key),
      `spawn_instance must declare '${key}' as an argument — the policy layer passes it`);
  }
  // So the precedence is now observable on a tool that does NOT declare them:
  // reported as a policy-layer input, never as a misspelled argument.
  for (const key of ['stage', 'playbook', 'provenance']) {
    assert.ok(!index.get('set_mode').has(key), `set_mode must not declare '${key}'`);
    const res = validatePlaybook(
      base({ stages: { a: { tools: { spawn_instance: 'allow', set_mode: { pin: { [key]: 'x' } } } } } }),
      'fixture', index);
    assert.equal(res.ok, false);
    const joined = res.errors.join('\n');
    assert.match(joined, new RegExp(`pin cannot constrain '${key}'`));
    assert.doesNotMatch(joined, /is not an argument of/,
      `${key} on set_mode must NOT be reported as a typo — the forbidden-key check has to run first`);
  }
  // sessionId, by contrast, IS a real argument of set_mode and still refused.
  assert.ok(index.get('set_mode').has('sessionId'));
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', set_mode: { pin: { sessionId: 'x' } } } } } }),
    /pin cannot constrain 'sessionId'/);
});

test('a pin value must be a literal — no expression language', () => {
  expectErr(
    base({ stages: { a: { tools: { spawn_instance: { pin: { mode: { $eq: 'plan' } } } } } } }),
    /pin\.mode must be a literal string, number, boolean or null/,
  );
  for (const v of ['plan', 3, true, false, null]) {
    expectOk(base({ stages: { a: { tools: { spawn_instance: 'allow', set_mode: { pin: { mode: v } } } } } }));
  }
});

// ── the `tools` map ────────────────────────────────────────────────────────

test('a tool name outside the governable set is rejected', () => {
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', project_read: 'deny' } } } }),
    /'project_read' is not a governable tool/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', delete_worktree: 'deny' } } } }),
    /'delete_worktree' is not a governable tool/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', list_sessions: 'deny' } } } }),
    /'list_sessions' is not a governable tool/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', merge_worktree: 'deny' } } } }),
    /'merge_worktree' is not a governable tool/);
  // Prefix globs are not a thing — only the bare '*' fallback entry.
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', 'code-kanban__*': 'deny' } } } }),
    /is not a governable tool/);
  // …and the other direction of the same rule: a stage MAY deny the newly
  // governable renew_session, so a lockdown stage can refuse a conductor's
  // renewal REQUEST on a worker in it (the worker's own self-call is never
  // governed — policy applies to conductor callers only).
  expectOk(base({ stages: { a: { tools: { spawn_instance: 'allow', renew_session: 'deny' } } } }));
});

// Fail-closed beats the general lookup rule: spawnability requires an EXPLICIT
// spawn_instance entry, because the whole point of the "deny" default is that
// forgetting one line must not open a stage — and a wildcard silently rescuing
// that omission is exactly the failure it exists to prevent.
test('a "*" wildcard never confers spawnability, and the load-time rules key off that', () => {
  // entryStages: wildcard-allow is not enough, so this fails LOUDLY at load time
  expectErr(base({ entryStages: ['a'], stages: { a: { tools: { '*': 'allow' } } } }),
    /entryStages names 'a', which does not declare spawn_instance/);
  // ...and the message says the wildcard does not count
  expectErr(base({ entryStages: ['a'], stages: { a: { tools: { '*': 'allow' } } } }),
    /a "\*" entry does NOT confer spawnability/);
  // reachability stays consistent with the same definition: a wildcard-allow
  // stage with no inbound edge is now genuinely unreachable, not "spawnable"
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow' } }, b: { tools: { '*': 'allow' } } } }),
    /stage 'b' is unreachable/);
  // an explicit deny is not rescued by a wildcard allow either
  expectErr(base({ entryStages: ['a'], stages: { a: { tools: { '*': 'allow', spawn_instance: 'deny' } } } }),
    /entryStages names 'a', which does not declare spawn_instance/);
});

test('an explicit spawn_instance still beats a "*": "deny"', () => {
  expectOk(base({ stages: { a: { tools: { '*': 'deny', spawn_instance: 'allow' } } } }));
  expectOk(base({ stages: { a: { tools: { '*': 'deny', spawn_instance: { pin: { mode: 'plan' } } } } } }));
});

test("the '*' fallback entry is accepted but cannot carry pin", () => {
  expectOk(base({ stages: { a: { tools: { '*': 'deny', spawn_instance: 'allow' } } } }));
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow', '*': { pin: { mode: 'plan' } } } } } }),
    /the "\*" fallback entry cannot carry `pin`/);
});

test('an invalid tools value is rejected', () => {
  for (const bad of ['allowed', true, 42, null, {}, { pin: {} }, { pin: { mode: 'plan' }, extra: 1 }]) {
    expectErr(base({ stages: { a: { tools: { spawn_instance: bad } } } }),
      /tools\.spawn_instance must be "allow", "deny", or \{ "pin": \{\.\.\.\} \}|pin must be a non-empty object/);
  }
});

// ── transitions ────────────────────────────────────────────────────────────

test('a duplicate from->to transition is rejected', () => {
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: {} },
    transitions: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
  }), /duplicate transition a->b/);
});

// resolveMove resolves a driver by (from, on) and takes the first match, so two
// edges out of one stage sharing a driver would leave the second silently dead
// and make the destination depend on file order.
test('two transitions out of the same stage cannot share the same `on` driver', () => {
  const stages = {
    plan: { tools: { spawn_instance: 'allow' } },
    implement: {},
    review: {},
  };
  const errs = expectErr(base({
    entryStages: ['plan'], stages,
    transitions: [
      { from: 'plan', to: 'implement', on: 'approve_plan' },
      { from: 'plan', to: 'review', on: 'approve_plan' },
    ],
  }), /'approve_plan' already drives another transition out of 'plan'/);
  assert.match(errs.join('\n'), /would depend on file order/);

  // Different drivers out of the same stage are fine...
  expectOk(base({
    entryStages: ['plan'], stages,
    transitions: [
      { from: 'plan', to: 'implement', on: 'approve_plan' },
      { from: 'plan', to: 'review', on: 'reject_plan' },
    ],
  }));
  // ...and so is the SAME driver out of two different stages.
  expectOk(base({
    entryStages: ['plan'], stages,
    transitions: [
      { from: 'plan', to: 'implement', on: 'approve_plan' },
      { from: 'implement', to: 'review', on: 'approve_plan' },
    ],
  }));
  // Two `on`-less edges out of one stage stay legal: send_prompt resolves them
  // by destination stage, so there is nothing ambiguous about them.
  expectOk(base({
    entryStages: ['plan'], stages,
    transitions: [{ from: 'plan', to: 'implement' }, { from: 'plan', to: 'review' }],
  }));
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

test('a self-loop may be declared, but never with an `on`', () => {
  const stages = { a: { tools: { spawn_instance: 'allow' } }, b: {} };
  // The declaration itself is legal — it is the whole mechanism by which a
  // repeated round becomes countable.
  expectOk(base({ stages, transitions: [{ from: 'a', to: 'b' }, { from: 'b', to: 'b' }] }));
  // With an `on` it is not: resolveMove answers a self-edge BEFORE it looks at
  // drivers, so the driver branch would give one edge a second, gated path.
  // Without this rule the definition loads and the contradiction is silent.
  expectErr(base({ stages, transitions: [{ from: 'a', to: 'b' }, { from: 'b', to: 'b', on: 'approve_plan' }] }),
    /a self-loop cannot declare `on`/);
});

test('a self-loop does not make an otherwise-unreachable stage reachable', () => {
  // A self-loop cannot carry a worker INTO a stage, so it must not satisfy the
  // inbound-edge clause. A mutant that counts it turns this into a silent pass
  // and lets an orphan stage ship.
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, orphan: {} },
    transitions: [{ from: 'orphan', to: 'orphan' }],
  }), /stage 'orphan' is unreachable/);
});

// ── shape + defaults ───────────────────────────────────────────────────────

test('unknown top-level and unknown per-stage keys are rejected', () => {
  expectErr(base({ stagez: {} }), /unknown top-level key 'stagez'/);
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow' }, tolls: {} } } }),
    /stage 'a': unknown key 'tolls'/);
  // A near-miss of the OPTIONAL `description` key still fails as a typo — the key
  // is allow-listed by name, not by a blanket "any string key" escape hatch.
  expectErr(base({ stages: { a: { tools: { spawn_instance: 'allow' }, descriptoin: 'x' } } }),
    /stage 'a': unknown key 'descriptoin'/);
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: {} },
    transitions: [{ from: 'a', to: 'b', descriptoin: 'x' }],
  }), /transition has unknown key 'descriptoin'/);
});

// ── the optional `description` (conductor-facing intent) ───────────────────
//
// The field exists so playbook-specific orchestration lives ON the playbook
// rather than in shared prose. It is OPTIONAL, and "present iff authored" is a
// load-bearing property, not a formatting detail: absent-or-a-non-empty-string
// is what lets a consumer test the key instead of comparing to a sentinel.
//
// The rejected values are enumerated rather than sampled. `null` especially:
// it is the non-string most likely to slip through a check written as a
// truthiness or `typeof`-with-an-early-out, and JSON authors reach for it to
// mean "no description" — which is what OMITTING the key already means.
const NOT_A_DESCRIPTION = [42, null, false, true, [], {}, '', '   '];

test('a stage description is optional, must be a non-empty string, and survives validation', () => {
  for (const bad of NOT_A_DESCRIPTION) {
    expectErr(base({ stages: { a: { description: bad, tools: { spawn_instance: 'allow' } } } }),
      /stage 'a': description must be a non-empty string/);
  }

  // Omitted ⇒ ABSENT, not defaulted to ''. §3 renders these into the conductor
  // prompt, where a defaulted empty string would become a dead line.
  const bare = expectOk(base());
  assert.equal('description' in bare.stages.a, false, 'an unauthored description must not be defaulted');

  const text = 'Spawn a plan worker in a fresh worktree; end the turn.';
  const described = expectOk(base({ stages: { a: { description: text, tools: { spawn_instance: 'allow' } } } }));
  assert.equal(described.stages.a.description, text, 'an authored description must survive to the Stage');
});

test('a transition description is optional, must be a non-empty string, and survives validation', () => {
  const stages = { a: { tools: { spawn_instance: 'allow' } }, b: {}, c: {} };
  const withEdges = (edges) => base({ stages, transitions: edges });

  // Same enumeration as the stage side — the two sites share one check, and a
  // test that covered only one of them would not notice them diverging. The
  // message names the EDGE, so a stage-flavoured message copy-pasted onto this
  // site cannot pass either.
  for (const bad of NOT_A_DESCRIPTION) {
    expectErr(withEdges([{ from: 'a', to: 'b', description: bad }]),
      /transition a->b: description must be a non-empty string/);
  }

  const text = 'This edge needs a fresh spawn, not an in-place send.';
  const pb = expectOk(withEdges([{ from: 'a', to: 'b', description: text }, { from: 'a', to: 'c' }]));
  assert.equal(pb.transitions[0].description, text);
  assert.equal('description' in pb.transitions[1], false,
    'an unauthored transition description must not be defaulted');
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

test('needs.liveness and workers reject unknown values', () => {
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: { needs: [{ stage: 'a', liveness: 'someday' }] } },
  }), /needs\.liveness must be one of live \| retired \| any/);
  expectErr(base({ stages: { a: { workers: 'three', tools: { spawn_instance: 'allow' } } } }),
    /workers must be one of one \| many/);
  // The retired vocabulary is gone, not aliased: a definition still saying `at`
  // must fail loudly at load rather than silently losing its gate.
  expectErr(base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: { needs: [{ stage: 'a', at: 'ever' }] } },
  }), /needs entry has unknown key 'at'/);
});

// One case per rule the array shape adds. Deliberately NOT one combined assert:
// a single expectErr would pass while four of the five rules were missing.
test('needs.position rejects a non-array, an empty list, an unknown stage, a mixed "*", and a duplicate', () => {
  const withPosition = position => base({
    stages: { a: { tools: { spawn_instance: 'allow' } }, b: { needs: [{ stage: 'a', position }] } },
    transitions: [{ from: 'a', to: 'b' }],
  });
  expectErr(withPosition('a'), /needs\.position must be an array of stage names/);
  expectErr(withPosition([]), /needs\.position must name at least one stage/);
  expectErr(withPosition(['nope']), /needs\.position names unknown stage 'nope'/);
  expectErr(withPosition(['*', 'a']), /needs\.position cannot mix "\*" with named stages/);
  expectErr(withPosition(['a', 'a']), /needs\.position lists 'a' twice/);
  // …and the shapes that must still LOAD, so the rules above cannot be
  // satisfied by a validator that simply rejects every position.
  expectOk(withPosition(['a']));
  expectOk(withPosition(['a', 'b']));
  expectOk(withPosition(['*']));
});

test('defaults are applied for omitted tools/workers/needs/position/liveness', () => {
  const pb = expectOk(base({
    stages: {
      a: { tools: { spawn_instance: 'allow' } },
      b: { needs: [{ stage: 'a' }] },       // position + liveness omitted
    },
    transitions: [{ from: 'a', to: 'b' }],
  }));
  // STRICT BY DEFAULT, both axes. A mutant defaulting position to ["*"] or
  // liveness to "any" — the loose ends — fails here, which is the point: the
  // obvious minimal entry must be the strongest gate, never the weakest.
  assert.deepEqual(pb.stages.b.needs, [{ stage: 'a', position: ['a'], liveness: 'live' }],
    'position defaults to [stage] and liveness to "live"');
  assert.equal(pb.stages.b.workers, 'one', 'workers defaults to "one"');
  assert.deepEqual(pb.stages.b.tools, {}, 'tools defaults to {}');
  assert.deepEqual(pb.stages.a.needs, [], 'needs defaults to []');
});
