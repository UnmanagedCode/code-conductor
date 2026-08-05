// The playbook enforcement gate — the ONE policy checkpoint on the MCP
// tools/call path, plus every write to the playbook ledger.
//
// src/mcp/server.ts stays transport (JSON-RPC, arg validation, prefix
// resolution); this module owns the policy question and the audit trail. It sits
// between them as a composed collaborator, the same shape handlers.ts uses for
// diffPaging / messageReconstruction.
//
// CHECK BEFORE, COMMIT AFTER — one checkpoint, two moments. A `spawn` ledger
// event needs the NEW worker's sessionId, which does not exist until
// spawn_instance's handler has run, so check() decides and commit() records:
//
//   const gate = await playbookGate.check({toolName, args, callerId});
//   if ('refusal' in gate) -> return it verbatim as a soft result
//   const result = await tool.handler(gate.args, ctx);
//   await gate.commit?.(result);
//
// A handler that THROWS never reaches commit(), and a handler that soft-refuses
// ({ok:false}) is not committed either: in both cases the move did not happen,
// so the ledger must not claim it did.
//
// SCOPE. Policy applies only when the caller is the conductor
// (isConductorInstance) — worker-side calls keep their existing recursion rules
// — and only to tools in the derived governable set. Everything else passes
// through untouched.
//
// `off` IS FULLY INERT. No decide(), no arg patching, no ledger append. That is
// the highest-priority invariant here: enforcement defaults to 'off', so an
// upgrade must leave every existing conductor flow working byte-for-byte,
// including spawns that name no `playbook`/`stage`. The consequence is that a
// run started under 'off' is untracked, so flipping to 'enforce' mid-run leaves
// those workers ungoverned while new spawns are governed — that is the intended
// rollout, not a gap.

import {
  decide, loadToolIndex, loadPlaybooks, normalizeToolName,
  type Move, type Playbook, type RefusalCode, type LegalMoves,
} from '../playbooks.ts';
import { createPlaybookLedger, ledgerFile, type PlaybookLedger } from '../playbookLedger.ts';
import { isConductorInstance } from '../conduct.ts';
import type { InstanceManagerLike, InstanceSummary } from '../instanceTypes.ts';

// The soft-refusal body, serialized exactly like the transport's own
// SESSION_AMBIGUOUS result: a normal tool result, never `isError`, never a
// throw. Refusal TEXT is the entire UX — there is no server→client notification
// channel, so a conductor's tool list is fetched once and never refreshed and a
// denied tool cannot be hidden. Hence `legalMoves`: every refusal carries the
// way forward from where the worker actually is.
export interface GateRefusal {
  ok: false;
  code: RefusalCode;
  reason: string;
  legalMoves: LegalMoves;
  playbookEnforcement: 'enforce';
}

export type GateOutcome =
  | { args: unknown; commit?: (result: unknown) => Promise<void> }
  | { refusal: GateRefusal };

export interface PlaybookGate {
  check(input: { toolName: unknown; args: unknown; callerId: string | null }): Promise<GateOutcome>;
  // Test seam: the ledger this gate appends to.
  ledger(): PlaybookLedger;
}

// The gate's default ledger PINS its path on first resolution instead of
// re-resolving per write. ledgerFile() stays lazy (so it is never captured at
// module load, and a PROJECTS_ROOT override is honoured), but one gate must
// serve exactly one store: appends are asynchronous and some are fire-and-forget
// from the status stream, so a write can land after PROJECTS_ROOT has moved on —
// recording an event in a store other than the one it was decided against. First
// resolution happens on the first governed call, by which point the environment
// is settled.
function pinnedLedger(): PlaybookLedger {
  let resolved: string | null = null;
  return createPlaybookLedger({ file: () => (resolved ??= ledgerFile()) });
}

export function createPlaybookGate(
  { instances, ledger = pinnedLedger() }:
  { instances?: InstanceManagerLike | null; ledger?: PlaybookLedger },
): PlaybookGate {
  let loading: Promise<unknown> | null = null;

  // Fold the ledger from disk once, on the first governed call rather than at
  // construction: the router is built before a test has finished pointing
  // PROJECTS_ROOT at its temp store, and an 'off'-only session must never touch
  // the filesystem at all. The PROMISE is memoised, not a boolean — a tools/call
  // and a status event can both arrive first, and two concurrent load() calls
  // would fold the same events into the projection twice.
  function ensureLoaded(): Promise<unknown> {
    if (!loading) loading = ledger.load();
    return loading;
  }

  // Definitions are read PER CALL, never memoised for the process lifetime.
  // That is a deliberate property of the catalog (src/playbooks.ts): a
  // hand-authored playbook dropped into <orchStoreRoot>/playbooks/ takes effect
  // without an orchestrator restart. Conductor tool calls happen at agent pace,
  // so a handful of small JSON reads per call costs nothing worth trading it for.
  async function definitions(): Promise<Map<string, Playbook>> {
    const { playbooks, errors } = await loadPlaybooks();
    for (const e of errors) console.warn(`playbooks: '${e.id}' rejected at load: ${e.message}`);
    return playbooks;
  }

  // Appends are SERIALIZED through one chain. ledger.append() reads the current
  // seq, then awaits the write, so two overlapping appends would take the same
  // seq — reachable here because the status stream (retires, toggle changes)
  // fires independently of the tools/call path.
  let appendChain: Promise<unknown> = Promise.resolve();

  function append(ev: Parameters<PlaybookLedger['append']>[0]): Promise<unknown> {
    appendChain = appendChain.then(() => ledger.append(ev)).catch(e => {
      // The ledger is the audit trail, not the authority for THIS call's
      // outcome. A failed append must never turn a successful tool call into an
      // error reply, so it warns and the call stands — and the chain is caught
      // here so one failure cannot poison every later append.
      console.warn(`playbookLedger: append failed (${ev.kind}): ${errMsg(e)}`);
    });
    return appendChain;
  }

  // ── the manager status stream: retire events + enforcement-toggle events ──
  //
  // Both are things the gate must record that no tools/call can tell it about.
  // Watching the one 'status' stream means whichever surface flips the toggle
  // (the WS message, a spawn-time value, a restart restore) is recorded without
  // that surface knowing the ledger exists.
  const lastMode = new Map<string, string>();
  if (instances) {
    instances.on('status', (summary: InstanceSummary) => {
      void onStatus(summary);
    });
  }

  async function onStatus(summary: InstanceSummary): Promise<void> {
    const sessionId = typeof summary.sessionId === 'string' ? summary.sessionId : null;
    if (!sessionId) return;
    // RETIRE — the ONE retire path, for both a deliberate kill_instance and an
    // unexpected crash, since either way the subprocess exits and lands here.
    // Capacity (`workers: "one"`) counts LIVE workers, so a worker that never
    // retires holds its stage's slot forever.
    if (summary.status === 'exited' || summary.status === 'crashed') {
      // The projection MUST be folded before probing it. It is otherwise loaded
      // lazily on the first governed call, so a worker that crashes after a
      // restart but before that call would be read against an empty projection,
      // never retire, and stay `live` in the on-disk ledger forever — leaking its
      // workers:"one" slot with no way to recover.
      //
      // This does not break `off` inertness: load() is READ-ONLY (a missing file
      // folds to an empty projection and creates nothing), and the append below
      // is guarded on the worker already being tracked. So the guard is "was this
      // worker ever recorded", NOT "is enforcement on" — deliberately, because a
      // worker tracked by an earlier enforcing run must still retire correctly
      // even if enforcement is off right now.
      await ensureLoaded();
      const st = ledger.projection().bySession.get(sessionId);
      if (st?.live) await append({ kind: 'retire', sessionId, reason: `subprocess ${summary.status}` });
    }
    // ENFORCEMENT. Without this, backtracking cannot explain why an
    // illegal-looking move was allowed.
    if (!isConductorInstance({ project: String(summary.project) })) return;
    const mode = typeof summary.playbookEnforcement === 'string' ? summary.playbookEnforcement : 'off';
    // The FIRST observation of a conductor is the baseline, not a change: a
    // conductor created with `enforce` was never `off`, and recording
    // {from:'off', to:'enforce'} would put a value in the audit trail that never
    // held. Assuming a default here rather than reading the instance is safe
    // because create() awaits launch(), which emits status — so a conductor has
    // always ticked at least once before any client can flip its toggle.
    if (!lastMode.has(sessionId)) {
      lastMode.set(sessionId, mode);
      return;
    }
    const prev = lastMode.get(sessionId) as string;
    if (mode === prev) return;
    lastMode.set(sessionId, mode);
    await ensureLoaded();
    await append({ kind: 'enforcement', conductorSessionId: sessionId, from: prev, to: mode });
  }

  // ── the checkpoint ──

  async function check(
    { toolName, args, callerId }: { toolName: unknown; args: unknown; callerId: string | null },
  ): Promise<GateOutcome> {
    const pass: GateOutcome = { args };
    if (!instances || !callerId || typeof toolName !== 'string' || !isRecord(args)) return pass;

    // Only the conductor's calls are governed. One predicate, shared with every
    // other consumer (src/conduct.ts).
    const caller = instances.liveForSession(callerId);
    if (!caller || !isConductorInstance(caller)) return pass;

    const mode = caller.playbookEnforcement;
    if (mode === 'off') return pass;

    // Governable = the derived set (tools taking a sessionId, plus
    // spawn_instance). Never a literal list.
    const name = normalizeToolName(toolName);
    const index = await loadToolIndex();
    if (!index.has(name)) return pass;

    await ensureLoaded();
    const playbooks = await definitions();
    const decision = decide({ toolName: name, args, projection: ledger.projection(), playbooks });

    if (!decision.ok) {
      // Recorded under BOTH warn and enforce — under warn the call proceeds
      // anyway, and the ledger is the only trace that it should not have.
      await append({
        kind: 'refusal',
        ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
        tool: name,
        code: decision.code,
        reason: decision.reason,
      });
      if (mode === 'warn') return pass;
      return {
        refusal: {
          ok: false,
          code: decision.code,
          reason: decision.reason,
          legalMoves: decision.legalMoves,
          playbookEnforcement: 'enforce',
        },
      };
    }

    const move = decision.move;
    const patched = decision.patchedArgs;
    return {
      args: patched,
      commit: (result: unknown) => commitMove({ move, args: patched, toolName: name, result }),
    };
  }

  async function commitMove(
    { move, args, toolName, result }:
    { move: Move; args: Record<string, unknown>; toolName: string; result: unknown },
  ): Promise<void> {
    // A soft refusal from the handler means the call did not do what policy
    // authorised — do not record a move that never happened.
    if (isRecord(result) && result.ok === false) return;
    const needs = suppliedNeeds(args.needs);

    if (move.kind === 'spawn' && move.playbook && move.to) {
      // The new worker's identity comes from the RESULT, not the arguments:
      // createWorktree:true generates the worktree name server-side, and the
      // sessionId does not exist until the subprocess is up.
      const view = asRecord(result);
      const sessionId = typeof view.sessionId === 'string' ? view.sessionId : '';
      if (!sessionId) return;
      const worktree = asRecord(view.worktree).worktreeName;
      await append({
        kind: 'spawn',
        sessionId,
        playbook: move.playbook,
        stage: move.to,
        // Absent `needs` ⇒ a run root. Keep it off the event entirely rather
        // than writing `{}`, so the fold can tell the two apart.
        ...(Object.keys(needs).length > 0 ? { needs } : {}),
        ...(typeof view.project === 'string' ? { project: view.project } : {}),
        ...(typeof worktree === 'string' ? { worktree } : {}),
      });
      return;
    }

    if (move.kind === 'transition' && move.from && move.to) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!sessionId) return;
      await append({
        kind: 'transition',
        sessionId,
        from: move.from,
        to: move.to,
        via: move.via ?? toolName,
        ...(Object.keys(needs).length > 0 ? { needs } : {}),
      });
      return;
    }

    // Nothing else to record. kind 'self' and 'none' move nothing — a self-edge
    // is explicitly NOT a transition, and every ordinary follow-up prompt is a
    // self-edge.
    //
    // `retire` is deliberately NOT written here, including for kill_instance:
    // killing a worker makes its subprocess exit, so the status stream above
    // already emits the retire — and it emits it FIRST, because the kill resolves
    // through the same status transition the listener watches. A second writer
    // here would be dead code that only looked like a safety net. The status
    // stream is therefore the single retire path, covering deliberate kills and
    // unexpected crashes identically.
  }

  return { check, ledger: () => ledger };
}

// The caller's `needs` map, narrowed to the {stage: sessionId} string pairs the
// ledger stores. Prefix values have already been resolved to full sessionIds at
// the transport's prefix chokepoint.
function suppliedNeeds(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [stage, sid] of Object.entries(v)) if (typeof sid === 'string') out[stage] = sid;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
