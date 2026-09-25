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

// decide()'s isLive oracle now comes from InstanceManager, not the ledger — so
// a pure policy test that wants "liveness follows this event list" (spawn/resume
// -> live, retire -> not live) builds its own tiny oracle from the same fixture
// events, rather than reading a fold that no longer carries the bit. This is
// ONLY a test fixture: production wires isLive to InstanceManager.isSessionLive.
export function isLiveFromEvents(events) {
  const live = new Set();
  for (const ev of events) {
    if (ev.kind === 'spawn' || ev.kind === 'resume') live.add(ev.sessionId);
    else if (ev.kind === 'retire') live.delete(ev.sessionId);
  }
  return sid => live.has(sid);
}

export async function builtins() {
  const { playbooks, errors } = await loadPlaybooks();
  assert.deepEqual(errors, [], 'built-in playbooks must validate');
  return playbooks;
}

// ── GATELAB: the shared enforcement-mechanics graph ─────────────────────────
//
// A mechanics lab, not a plausible workflow: one shape per mechanism the policy
// layer has to get right, so each assertion has something to bite on that no
// hand edit to a shipped playbook can move. Lives here rather than in one test
// file because playbook-enforce (the wiring) and playbook-policy/-selfedge/
// -transition-driver (the pure decision) all drive the same mechanisms.
//
// `draft` and `sealed` pin `mode` DIFFERENTLY on purpose, because the two jobs
// pull opposite ways and one stage cannot do both:
//   - pin fill-in needs a NON-default value ('bypassPermissions'), or "the pin filled the
//     argument in" is true whether or not the pin was ever applied — MCP
//     spawn_instance already defaults to 'plan'.
//   - the approve_plan side-effect needs the flip to be REACHABLE, and
//     approve_plan's handler flips the mode only for a worker already IN plan
//     mode (src/mcp/handlers.ts). Pin anything else and "the mode did not move"
//     is true no matter what the deny does.
// So `draft` pins 'bypassPermissions' and `sealed` pins no mode at all, spawning at the
// default.
//
// Every value below is load-bearing: each one has been mutated in place and the
// assertion that reads it observed to fail. Nothing is here for decoration. The
// one exception is `audit.needs.position`: a NARROWED list reddens the test, but
// a list widened to ["*"] cannot, because no stage a build-veteran can reach is
// outside the list. Widening is pinned at the policy layer instead
// (tests/playbook-policy.test.mjs).
//
//   draft   entry; `pin` FILLS IN mode+createWorktree; no declared draft->draft,
//           so an ordinary follow-up prompt is an UNDECLARED self-edge (legal,
//           never ledgered). The one stage that both DENIES a tool and has an
//           outgoing edge, so a refusal from it carries a non-empty legalMoves
//   build   omits spawn_instance ⇒ STAGE_NOT_SPAWNABLE; denies nothing that
//           `audit` denies, which is the permitted half of the deny tests
//   audit   `needs` on SPAWN-entry, workers:"many", and the stage-scoped denies
//           (`set_idle_timeout` is a governable no-op on an idle worker —
//           denying it exercises policy without touching the subprocess)
//   amend   `needs` on TRANSITION-entry at the default liveness:"live"; the
//           DECLARED amend->amend self-loop, so its rounds are ledgered
//   sealed  a dead end with both write doors shut — no outgoing edge, set_mode
//           and approve_plan denied. Pins no `mode`, so its worker spawns in
//           plan mode and approve_plan's flip is reachable — which is what makes
//           "the refused call changed nothing" an assertion rather than a
//           restatement of the pin
//   handoff `needs` sealed at liveness:"any", at the default workers:"one"
//   loose   ungated, its own run root
export const GATELAB = {
  id: 'gatelab',
  name: 'Gatelab — enforcement-mechanics fixture',
  description: 'Test-only graph: pins, drivers, needs, liveness, capacity, stage-scoped tool policy.',
  entryStages: ['draft', 'sealed', 'loose'],
  stages: {
    draft: {
      description: 'Entry: pins are filled in here.',
      tools: { spawn_instance: { pin: { mode: 'bypassPermissions', createWorktree: true } }, set_mode: 'deny' },
    },
    build: {
      description: 'Reached only by the approve_plan edge.',
    },
    audit: {
      description: 'Read-only lens; many at once.',
      needs: [{ stage: 'build', position: ['build', 'amend'] }],
      workers: 'many',
      tools: {
        spawn_instance: { pin: { mode: 'bypassPermissions', model: 'reviewer' } },
        set_idle_timeout: 'deny',
        approve_plan: 'deny',
      },
    },
    amend: {
      description: 'Entered by transition; needs a live auditor.',
      needs: [{ stage: 'audit' }],
    },
    sealed: {
      description: 'No outgoing edge; cannot self-promote.',
      tools: {
        spawn_instance: { pin: { createWorktree: true } },
        set_mode: 'deny',
        approve_plan: 'deny',
      },
    },
    handoff: {
      description: 'Spawns against a sealed worker, alive or not.',
      needs: [{ stage: 'sealed', liveness: 'any' }],
      tools: { spawn_instance: 'allow' },
    },
    loose: {
      description: 'Ungated worker, its own run root.',
      tools: { spawn_instance: 'allow' },
    },
  },
  transitions: [
    { from: 'draft', to: 'build', on: 'approve_plan' }, // an `on` driver
    { from: 'build', to: 'amend' },                     // no `on` ⇒ send_prompt
    { from: 'amend', to: 'amend' },                     // DECLARED self-loop ⇒ ledgered
  ],                                                    // no draft->draft ⇒ undeclared self-edge
};

// The raw literal above is what a test writes to the user-overlay directory for
// the server to load; GATELAB_PB is the same graph POST-VALIDATION (defaults
// applied), which is what decide() takes. Validating at module load also means a
// rejected fixture can never leave a consumer's tests vacuously green.
export const GATELAB_PB = pb(GATELAB);

// A GATELAB run part-way through: the drafter has been approved into `build`,
// and an auditor has been spawned against it.
export const GATELAB_RUN = [
  { kind: 'spawn', sessionId: 'w-drafter-1', playbook: 'gatelab', stage: 'draft', project: 'demo' },
  { kind: 'transition', sessionId: 'w-drafter-1', from: 'draft', to: 'build', via: 'approve_plan' },
  { kind: 'spawn', sessionId: 'w-auditor-1', playbook: 'gatelab', stage: 'audit',
    provenance: { build: 'w-drafter-1' }, project: 'demo' },
];
