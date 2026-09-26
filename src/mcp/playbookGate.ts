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
// NEITHER LEVEL IS INERT. Both `warn` and `enforce` run decide(), patch args and
// append to the ledger; they part company on one thing only — whether a refusal
// is returned to the caller or merely recorded while the call proceeds. So every
// conductor session materialises the ledger, and a governed call always costs a
// fold plus a definitions read.
//
// A LEGAL spawn is recorded under either level, so a `warn` run that named its
// playbook is fully governable the moment enforcement is flipped on. An illegal
// one is not: under `warn` it proceeds with only the refusal recorded and no
// binding, leaving that worker untracked — so flipping to `enforce` mid-run
// governs new spawns while those workers stay ungoverned.

import {
  decide, loadToolIndex, loadPlaybooks, normalizeToolName, normalizePlaybookEnforcement,
  type Move, type Playbook, type RefusalCode, type LegalMoves,
} from '../playbooks.ts';
import {
  createPlaybookLedger, ledgerFile, readEvents, playbookBinding, liveSessionsOnPlaybook,
  type PlaybookLedger, type Projection, type LedgerEvent,
} from '../playbookLedger.ts';
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
  // `resumeHandle` is spawn_instance({resume})'s PUBLIC id, resolved by the
  // transport. It rides beside `args.resume` rather than replacing it, because
  // the projection is keyed by public id while create() must keep the segment
  // the caller named — see InstanceManager.resolveResumeRef.
  check(input: { toolName: unknown; args: unknown; callerId: string | null; resumeHandle?: string }): Promise<GateOutcome>;
  // READ SURFACE for the introspection tools (src/mcp/handlers.ts). Named methods
  // rather than handing out the ledger, so a read tool never reaches through the
  // test seam below, and so there is exactly one projection in the process — a
  // second one folded independently would drift from the one that enforces.
  //
  // Both fold on demand through the same memoised load the enforcement path uses,
  // and that load is READ-ONLY: a missing ledger folds to an empty projection and
  // creates nothing. That is what lets a read tool answer before any run has been
  // recorded without materialising the file.
  readProjection(): Promise<Projection>;
  readHistory(): Promise<LedgerEvent[]>;
  // The batch binding lookup for a surface that has no other reason to import
  // playbookLedger.ts (src/routes.ts's GET /api/instances — see
  // tests/playbook-ledger-chokepoint.test.mjs, which refuses that import
  // directly). One projection read for the whole list, in input order;
  // null/null per id for an untracked worker. Same read-only-on-a-missing-
  // ledger contract as readProjection — but NOT exception-free: a load
  // failure (anything but ENOENT from the ledger file) still propagates, same
  // as readProjection, so a caller that wants to degrade rather than throw
  // still has to catch it.
  readBindings(sessionIds: unknown[]): Promise<Array<{ playbook: string | null; stage: string | null }>>;
  // The live workers bound to `playbook` (liveSessionsOnPlaybook over this
  // gate's projection and isLive), for src/playbookApi.ts — which, like
  // routes.ts, may not import playbookLedger.ts. Same propagate-on-load-failure
  // contract as readBindings.
  readLiveWorkers(playbook: string): Promise<string[]>;
  // THE liveness oracle this gate's decide() calls use — exposed so a read
  // surface (playbook_state, describe_playbook's dry-run) answers from the same
  // source as enforcement, rather than re-deriving its own.
  isLive(sessionId: string): boolean;
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
// The event shape `append` below takes. Also its THUNK form: an event whose
// shape depends on the projection must be built inside the serialized chain,
// after every earlier append has folded.
type PendingEvent = Parameters<PlaybookLedger['append']>[0];

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
  // PROJECTS_ROOT at its temp store, so resolving the path eagerly would bind the
  // wrong store. The PROMISE is memoised, not a boolean — a tools/call
  // and a status event can both arrive first, and two concurrent load() calls
  // would fold the same events into the projection twice.
  function ensureLoaded(): Promise<unknown> {
    if (!loading) loading = ledger.load();
    return loading;
  }

  // THE liveness oracle every decide() call and read surface goes through.
  // `instances` can be null (a gate built with no registry, e.g. a read-only
  // tool context) — every session reads as not-live in that case: with no
  // registry to ask, "not live" is the only answer that cannot mis-govern.
  function isLive(sessionId: string): boolean {
    return !!instances?.isSessionLive(sessionId);
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

  function append(ev: PendingEvent | (() => PendingEvent)): Promise<unknown> {
    // A thunk is resolved INSIDE the chain, so it reads a projection every
    // earlier append has already folded into. Captured so the warn below can
    // still name the kind.
    let resolved: PendingEvent | null = null;
    appendChain = appendChain.then(async () => {
      resolved = typeof ev === 'function' ? ev() : ev;
      await ledger.append(resolved);
      // AFTER the write has folded (ledger.append folds synchronously before
      // resolving) — a refresh this hint triggers can never read the stage the
      // append just replaced. Only spawn/transition move a worker's
      // playbook/stage; refusal/retire/resume/enforcement fold to no binding
      // change, so emitting for them would be noise with nothing to refresh.
      if (resolved.kind === 'spawn' || resolved.kind === 'transition') {
        instances?.emit('playbook_changed', { sessionId: resolved.sessionId });
      }
    }).catch(e => {
      // The ledger is the audit trail, not the authority for THIS call's
      // outcome. A failed append must never turn a successful tool call into an
      // error reply, so it warns and the call stands — and the chain is caught
      // here so one failure cannot poison every later append.
      console.warn(`playbookLedger: append failed (${resolved?.kind ?? 'unresolved'}): ${errMsg(e)}`);
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
    // RETIRE — an audit record of an observed exit, covering both a deliberate
    // kill_instance and an unexpected crash, since either way the subprocess
    // exits and lands here. Capacity no longer reads this event at all
    // (`workers:"one"` counts LIVE processes via InstanceManager.isSessionLive),
    // so unlike before there is no second case this stream needs to cover: a
    // session whose exit this process never observed (a host reboot) already
    // reads not-live from the manager, with nothing to reconcile.
    if (summary.status === 'exited' || summary.status === 'crashed') {
      // The projection MUST be folded before probing it. It is otherwise loaded
      // lazily on the first governed call, so a worker that crashes after a
      // restart but before that call would be read against an empty projection
      // and never get its retire recorded in the audit trail.
      //
      // load() is READ-ONLY (a missing file folds to an empty projection and
      // creates nothing), and the append below is guarded on the worker already
      // being tracked. So the guard is "was this worker ever recorded", NOT "is
      // enforcement on" — deliberately, because a worker bound by an earlier
      // enforcing run must still retire correctly after a flip to `warn`.
      await ensureLoaded();
      const st = ledger.projection().bySession.get(sessionId);
      if (st) await append({ kind: 'retire', sessionId, reason: `subprocess ${summary.status}` });
    }
    // ENFORCEMENT. Without this, backtracking cannot explain why an
    // illegal-looking move was allowed.
    if (!isConductorInstance({ project: String(summary.project) })) return;
    const mode = normalizePlaybookEnforcement(summary.playbookEnforcement);
    // The FIRST observation of a conductor is its BIRTH, not a change: a
    // conductor created at one level was never at any other, so a synthesized
    // {from:<default>} would put a value in the audit trail that never held. A
    // birth is recorded with `from: null` instead.
    //
    // Every birth is recorded, at either level — neither is inert. The first tick
    // carries the spawn-time value because create() awaits launch(), which emits
    // status, so a conductor has always ticked at least once before any client can
    // reach it to flip the toggle.
    if (!lastMode.has(sessionId)) {
      lastMode.set(sessionId, mode);
      await ensureLoaded();
      await append({ kind: 'enforcement', conductorSessionId: sessionId, from: null, to: mode });
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
    { toolName, args, callerId, resumeHandle }:
    { toolName: unknown; args: unknown; callerId: string | null; resumeHandle?: string },
  ): Promise<GateOutcome> {
    const pass: GateOutcome = { args };
    if (!instances || !callerId || typeof toolName !== 'string' || !isRecord(args)) return pass;

    // Only the conductor's calls are governed. One predicate, shared with every
    // other consumer (src/conduct.ts).
    const caller = instances.liveForSession(callerId);
    if (!caller || !isConductorInstance(caller)) return pass;

    const mode = caller.playbookEnforcement;

    // Governable = the derived set (tools taking a sessionId, plus
    // spawn_instance). Never a literal list.
    const name = normalizeToolName(toolName);
    const index = await loadToolIndex();
    if (!index.has(name)) return pass;

    await ensureLoaded();
    const playbooks = await definitions();
    const decision = decide({ toolName: name, args, projection: ledger.projection(), playbooks, isLive, resumeHandle });

    if (!decision.ok) {
      // Recorded under BOTH warn and enforce — under warn the call proceeds
      // anyway, and the ledger is the only trace that it should not have.
      await append({
        kind: 'refusal',
        ...subjects(args),
        tool: name,
        code: decision.code,
        reason: decision.reason,
      });
      if (mode === 'warn') {
        // warn lets the call through, so the ledger row is its only durable
        // trace — and nothing reads it back. Put the same fact in front of the
        // human by pushing a UI-only bubble into the CONDUCTOR's transcript
        // (it made the call; a refusal may name no worker at all). `_emitUi`
        // reaches the ring and the WS feed only — it is never model input, so
        // the conductor agent still sees the call succeed, exactly as before.
        // Strictly after the append: the audit trail is written first.
        caller._emitUi({
          kind: 'system',
          subtype: 'playbook_warn',
          data: {
            tool: name,
            code: decision.code,
            reason: decision.reason,
            ...subjects(args),
          },
        });
        return pass;
      }
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
    const provenance = suppliedProvenance(args.provenance);

    // A RESUME un-retires an existing worker; it never re-declares one. Writing a
    // `spawn` here would reset that worker's stageHistory and empty its provenance
    // (see the spawn arm of applyEvent), erasing the history every downstream
    // `needs` is answered from. The sessionId comes from the RESULT for the same
    // reason as below — the result is the authority on which worker came back.
    if (move.kind === 'resume') {
      const sessionId = asRecord(result).sessionId;
      if (typeof sessionId !== 'string' || !sessionId) return;
      await append({ kind: 'resume', sessionId });
      return;
    }

    if (move.kind === 'spawn' && move.playbook && move.to) {
      // The new worker's identity comes from the RESULT, not the arguments:
      // createWorktree:true generates the worktree name server-side, and the
      // sessionId does not exist until the subprocess is up.
      const view = asRecord(result);
      const sessionId = typeof view.sessionId === 'string' ? view.sessionId : '';
      if (!sessionId) return;
      const worktree = asRecord(view.worktree).worktreeName;
      const playbook = move.playbook;
      const stage = move.to;
      // THE SAME RULE AS THE ARM ABOVE, enforced against the authoritative id
      // rather than against the decision layer's classification. A `spawn` for a
      // session that ALREADY has a row is never a new declaration — decide() was
      // handed an id it could not place (a ledger/lineage divergence), and the
      // worker that came back is one it already governs. Folding a spawn here
      // would reset its stage, stageHistory and provenance.
      //
      // DECIDED IN THE CHAIN (hence the thunk): the projection is read at append
      // time, so an earlier commit racing this one has already folded. Read out
      // here instead, two concurrent commits on one sessionId both see "unbound"
      // and the second spawn resets the binding the first just created.
      await append((): PendingEvent => (ledger.projection().bySession.has(sessionId)
        ? { kind: 'resume', sessionId }
        : {
          kind: 'spawn',
          sessionId,
          playbook,
          stage,
          // Absent `provenance` ⇒ a run root. Keep it off the event entirely
          // rather than writing `{}`, so the fold can tell the two apart.
          ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
          ...(typeof view.project === 'string' ? { project: view.project } : {}),
          ...(typeof worktree === 'string' ? { worktree } : {}),
        }));
      return;
    }

    // A DECLARED self-loop is ledgered by this same path: the round it closes is
    // the thing worth counting, and writing it as a transition from===to is what
    // makes `stageHistory` show `refine -> refine` per round. It carries no
    // `provenance` — a self-edge never re-runs `needs`, so there is none — but it
    // does carry the forward source like a real move, since that round's handoff
    // is what the row audits.
    if (move.kind === 'transition' && move.from && move.to) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!sessionId) return;
      await append({
        kind: 'transition',
        sessionId,
        from: move.from,
        to: move.to,
        via: move.via ?? toolName,
        ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
        ...forwardSubject(args),
      });
      return;
    }

    if (move.kind === 'self' && move.recorded && move.from && move.to) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!sessionId) return;
      await append({
        kind: 'transition',
        sessionId,
        from: move.from,
        to: move.to,
        via: move.via ?? toolName,
        ...forwardSubject(args),
      });
      return;
    }

    // Nothing else to record. An UNDECLARED self-edge and kind 'none' move
    // nothing — every ordinary follow-up prompt is a self-edge, and a playbook
    // that has not declared the loop is saying it does not want them counted.
    //
    // `retire` is deliberately NOT written here, including for kill_instance:
    // killing a worker makes its subprocess exit, so the status stream above
    // already emits the retire — and it emits it FIRST, because the kill resolves
    // through the same status transition the listener watches. A second writer
    // here would be dead code that only looked like a safety net. The status
    // stream covers deliberate kills and unexpected crashes identically; a
    // process whose exit this one never observed (a host reboot) needs no
    // `retire` at all — isSessionLive already reads it as gone.
  }

  async function readProjection(): Promise<Projection> {
    await ensureLoaded();
    return ledger.projection();
  }

  async function readBindings(sessionIds: unknown[]): Promise<Array<{ playbook: string | null; stage: string | null }>> {
    const proj = await readProjection();
    return sessionIds.map(sid => playbookBinding(proj, sid));
  }

  async function readLiveWorkers(playbook: string): Promise<string[]> {
    return liveSessionsOnPlaybook(await readProjection(), playbook, isLive);
  }

  // Raw events, for the backtrack surface. Re-read per call rather than kept
  // alongside the projection: history is asked for by a human-paced read tool,
  // and holding every event in memory forever to serve it would be a leak.
  async function readHistory(): Promise<LedgerEvent[]> {
    await ensureLoaded();
    return readEvents(ledger.file());
  }

  return { check, readProjection, readHistory, readBindings, readLiveWorkers, isLive, ledger: () => ledger };
}

// The caller's `provenance` map, narrowed to the {stage: sessionId} string pairs the
// ledger stores. Prefix values have already been resolved to full sessionIds at
// the transport's prefix chokepoint.
// EVERY WORKER THE CALL NAMED, for the refusal row and the `playbook_warn`
// bubble alike — one rule, no branch on which side was refused (`code` says
// that). `forwardSessionId` is send_prompt's forward source, a policy subject in
// its own right (see checkForwardSource in ../playbooks.ts); forwardSubject also
// feeds it to every ledgered `transition` row. Keys are OMITTED rather than set
// to undefined, on both: the raw `_emitUi` payload and append()'s argument are
// asserted on.
function subjects(args: Record<string, unknown>): { sessionId?: string; forwardSessionId?: string } {
  return {
    ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
    ...forwardSubject(args),
  };
}

function forwardSubject(args: Record<string, unknown>): { forwardSessionId?: string } {
  const forward = asRecord(args.forward);
  return typeof forward.sessionId === 'string' && forward.sessionId
    ? { forwardSessionId: forward.sessionId }
    : {};
}

function suppliedProvenance(v: unknown): Record<string, string> {
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
