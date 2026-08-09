// Shared fixtures for the playbook test files. Not a *.test.mjs file, so the
// runner never treats it as a suite.

import assert from 'node:assert/strict';
import { validatePlaybook, loadToolIndex, loadPlaybooks } from '../src/playbooks.ts';
import { foldProjection } from '../src/playbookLedger.ts';

export const index = await loadToolIndex();

// Validate a definition and return it, asserting it is well-formed — a policy
// test must never be green because its fixture was quietly rejected.
export function pb(def) {
  const res = validatePlaybook(def, def.id, index);
  assert.ok(res.ok, `fixture playbook '${def.id}' is invalid: ${JSON.stringify(res.errors ?? [])}`);
  return res.playbook;
}

export function pbs(...list) {
  return new Map(list.map(p => [p.id, p]));
}

// Fold a fixture event list into a projection, assigning seq/ts so the tests
// only have to state what actually matters to the case.
export function proj(events) {
  return foldProjection(events.map((e, i) => ({ seq: i + 1, ts: `2026-08-05T00:00:0${i % 10}Z`, ...e })));
}

export async function builtins() {
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, [], 'built-in playbooks must validate');
  return playbooks;
}

// A solo run part-way through: the planner has been approved into
// `implement`, and a reviewer has been spawned against it.
export const SOLO_RUN = [
  { kind: 'spawn', sessionId: 'w-planner-1', playbook: 'solo', stage: 'plan', project: 'demo' },
  { kind: 'transition', sessionId: 'w-planner-1', from: 'plan', to: 'implement', via: 'approve_plan' },
  { kind: 'spawn', sessionId: 'w-review-01', playbook: 'solo', stage: 'review',
    provenance: { implement: 'w-planner-1' }, project: 'demo' },
];
