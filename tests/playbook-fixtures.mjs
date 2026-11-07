// Shared fixtures for the playbook test files. Not a *.test.mjs file, so the
// runner never treats it as a suite.

import assert from 'node:assert/strict';
import { validatePlaybook, loadToolIndex, loadPlaybooks } from '../src/playbooks.ts';
import { foldPlaybookState } from '../src/playbookState.ts';

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

// ── event-log row builders ───────────────────────────────────────────────────
// Fixture rows in the event-log shape (src/eventLog.ts), so a test states only
// what matters to its case. `v`/`ts` are filled in by proj().

// The conductor every fixture `call` row is attributed to.
export const TEST_CONDUCTOR = 'c-test-conductor';
const conductorActor = { type: 'conductor', sessionId: TEST_CONDUCTOR };
const systemActor = { type: 'system' };

// A spawn_instance call that bound `sid` to `playbook`/`stage`.
export function bindRow(sid, playbook, stage, { provenance, project, worktree } = {}) {
  return {
    kind: 'call', actor: conductorActor, subject: sid, tool: 'spawn_instance', outcome: 'ok',
    bind: {
      playbook, stage,
      ...(provenance ? { provenance } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(worktree !== undefined ? { worktree } : {}),
    },
  };
}

// A governed call that moved `sid` from `from` to `to` (never equal — a
// same-stage call carries no move; build it with callRow).
export function moveRow(sid, from, to, { tool = 'send_prompt', provenance, forward } = {}) {
  assert.notEqual(from, to, 'a move changes the stage; a same-stage call is a callRow');
  return {
    kind: 'call', actor: conductorActor, subject: sid, tool, outcome: 'ok',
    ...(forward ? { forward } : {}),
    move: { from, to, ...(provenance ? { provenance } : {}) },
  };
}

// A governed call on `sid` that moved nothing.
export function callRow(sid, tool = 'send_prompt', extra = {}) {
  return { kind: 'call', actor: conductorActor, subject: sid, tool, outcome: 'ok', ...extra };
}

export function exitRow(sid, cause = 'exited') {
  return { kind: 'session', actor: systemActor, subject: sid, event: 'exit', cause };
}

export function resumeRow(sid) {
  return { kind: 'session', actor: systemActor, subject: sid, event: 'resume' };
}

// Fold fixture rows into a projection, stamping the envelope's v/ts.
export function proj(rows) {
  return foldPlaybookState(rows.map((r, i) => ({ v: 1, ts: `2026-08-05T00:00:0${i % 10}Z`, ...r })));
}

// decide()'s isLive oracle comes from InstanceManager, not the log — so a pure
// policy test that wants "liveness follows this row list" (bound/started/
// resumed -> live, exited -> not live) builds its own tiny oracle from the same
// fixture rows. ONLY a test fixture: production wires isLive to
// InstanceManager.isSessionLive.
export function isLiveFromEvents(rows) {
  const live = new Set();
  for (const r of rows) {
    if (r.kind === 'call' && r.bind) live.add(r.subject);
    else if (r.kind === 'session' && (r.event === 'start' || r.event === 'resume')) live.add(r.subject);
    else if (r.kind === 'session' && r.event === 'exit') live.delete(r.subject);
  }
  return sid => live.has(sid);
}

// A lease that always grants the write — for a test that needs rows written.
export const OPEN_LEASE = { check: () => null };

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
//           moves nothing). The one stage that both DENIES a tool and has an
//           outgoing edge, so a refusal from it carries a non-empty legalMoves
//   build   omits spawn_instance ⇒ STAGE_NOT_SPAWNABLE; denies nothing that
//           `audit` denies, which is the permitted half of the deny tests
//   audit   `needs` on SPAWN-entry, workers:"many", and the stage-scoped denies
//           (`set_idle_timeout` is a governable no-op on an idle worker —
//           denying it exercises policy without touching the subprocess)
//   amend   `needs` on TRANSITION-entry at the default liveness:"live"; the
//           DECLARED amend->amend self-loop (a no-op, like any self-edge)
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
    { from: 'amend', to: 'amend' },                     // DECLARED self-loop (a no-op)
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
  bindRow('w-drafter-1', 'gatelab', 'draft', { project: 'demo' }),
  moveRow('w-drafter-1', 'draft', 'build', { tool: 'approve_plan' }),
  bindRow('w-auditor-1', 'gatelab', 'audit', { provenance: { build: 'w-drafter-1' }, project: 'demo' }),
];
