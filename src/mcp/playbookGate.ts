// The playbook enforcement gate — the ONE policy checkpoint on the MCP
// tools/call path, and the ONE write path into the event log
// (src/eventLog.ts, format: docs/event-log.md). Rows reach the log from two
// places, both through this module's `append`: a tools/call (`call` rows,
// written by check/commit/fail below) and the manager's session stream
// (`session`/`turn`/`wake`/`config` rows, src/mcp/sessionRecorder.ts).
//
// src/mcp/server.ts stays transport (JSON-RPC, arg validation, prefix
// resolution); this module owns the policy question and the audit trail. It sits
// between them as a composed collaborator, the same shape handlers.ts uses for
// diffPaging / messageReconstruction.
//
// CHECK BEFORE, COMMIT AFTER — one checkpoint, two moments. A spawn's binding
// needs the NEW worker's sessionId, which does not exist until spawn_instance's
// handler has run, so check() decides and commit()/fail() record:
//
//   const gate = await playbookGate.check({toolName, args, callerId});
//   if ('refusal' in gate) -> return it verbatim as a soft result
//   try { const result = await tool.handler(gate.args, ctx); await gate.commit?.(result); }
//   catch (e) { await gate.fail?.(e); ... }
//
// EXACTLY ONE `call` row per governed call that is refused (either level, any
// tool), and per governed interaction call or spawn_instance that runs —
// `outcome` says which: ok, refused, or failed (an `ok:false` result or a
// throw). A governed read-only call that is not refused writes nothing.
//
// SCOPE. Policy applies only when the caller is the conductor
// (isConductorInstance) — a worker is not offered the tools policy governs (core tool audience)
// — and only to tools in the derived governable set. Everything else passes
// through untouched.
//
// NEITHER LEVEL IS INERT. Both `warn` and `enforce` run decide(), patch args and
// write rows; they part company on one thing only — whether a refusal is
// returned to the caller or merely recorded while the call proceeds.
//
// A LEGAL spawn is bound under either level, so a `warn` run that named its
// playbook is fully governable the moment enforcement is flipped on. An illegal
// one is not: under `warn` it proceeds with only the refusal recorded and no
// binding, leaving that worker untracked.
//
// THE SECOND SCOPE: a bound worker's OWN calls (`checkWorkerTool`). The
// PreToolUse hook's worker-tools entry (src/settings.ts) asks it on every tool
// call of every session; the binding and the stage's `workerTools` are read
// per call, so a move or a definition edit governs the next call. Answers
// `{deny: reason}` or `{deny: null}`; a match writes one `refused` row by the
// worker at either level. Level = the owner conductor's (live, else folded,
// else the Settings default). It FAILS OPEN — passes and warns — when the
// binding's playbook or stage is no longer loaded or the log cannot be loaded:
// failing closed would deny every tool on every session until restart, since
// the memoised load stays rejected.

import {
  decide, loadToolIndex, loadInteractionTools, loadPlaybooks, normalizeToolName,
  resolveWorkerTool, workerToolDeniedReason, WORKER_TOOL_DENIED_IN_STAGE, normalizePlaybookEnforcement,
  type Move, type Playbook, type PlaybookEnforcement, type RefusalCode, type LegalMoves,
} from '../playbooks.ts';
import {
  createEventLog, eventLogFile, readEventLog,
  type AppendInput, type EventLog, type EventRow, type NewEventRow, type WriteLease,
} from '../eventLog.ts';
import {
  applyRow, emptyProjection, foldPlaybookState, playbookBinding, liveSessionsOnPlaybook, type Projection,
} from '../playbookState.ts';
import { attachSessionRecorder } from './sessionRecorder.ts';
import { isConductorInstance } from '../conduct.ts';
import { getDefaultPlaybookEnforcement } from '../conductorConventions.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';

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
  | { args: unknown; commit?: (result: unknown) => Promise<void>; fail?: (err: unknown) => Promise<void> }
  | { refusal: GateRefusal };

export interface PlaybookGate {
  // `resumeHandle` is spawn_instance({resume})'s PUBLIC id, resolved by the
  // transport. It rides beside `args.resume` rather than replacing it, because
  // the projection is keyed by public id while create() must keep the segment
  // the caller named — see InstanceManager.resolveResumeRef.
  check(input: { toolName: unknown; args: unknown; callerId: string | null; resumeHandle?: string }): Promise<GateOutcome>;
  // A worker's OWN tool call against its stage's `workerTools` (header →
  // THE SECOND SCOPE). `ownerSessionId` is the conductor that spawned or
  // resumed it, the source of the level. Never throws.
  checkWorkerTool(input: { sessionId: string | null; ownerSessionId: string | null; toolName: string }): Promise<{ deny: string | null }>;
  // READ SURFACE for the introspection tools (src/mcp/handlers.ts). Named methods
  // rather than handing out the log, so there is exactly one projection in the
  // process — a second one folded independently would drift from the one that
  // enforces.
  //
  // Both fold on demand through the same memoised load the enforcement path uses,
  // and that load is READ-ONLY: a missing log folds to an empty projection and
  // creates nothing.
  readProjection(): Promise<Projection>;
  readHistory(): Promise<EventRow[]>;
  // The batch binding lookup for a surface that may not import the log or the
  // projection directly (src/routes.ts's GET /api/instances — see
  // tests/event-log-chokepoint.test.mjs). One projection read for the whole
  // list, in input order; null/null per id for an untracked worker. A load
  // failure (anything but ENOENT) propagates, so a caller that wants to degrade
  // rather than throw has to catch it.
  readBindings(sessionIds: unknown[]): Promise<Array<{ playbook: string | null; stage: string | null }>>;
  // The live workers bound to `playbook`, for src/playbookApi.ts (same import
  // rule and load-failure contract as readBindings).
  readLiveWorkers(playbook: string): Promise<string[]>;
  // THE liveness oracle this gate's decide() calls use — exposed so a read
  // surface (playbook_state, describe_playbook's dry-run) answers from the same
  // source as enforcement, rather than re-deriving its own.
  isLive(sessionId: string): boolean;
  // Test seam: the log this gate writes.
  eventLog(): EventLog;
}

// `failure.reason` is bounded and taken only from a result's `reason` or an
// error's message, never from tool arguments — so no prompt text reaches the
// file through it beyond this many characters.
export const FAILURE_REASON_MAX = 200;

// Bindings already warned about as drifted, so a worker whose stage vanished
// warns once rather than on every tool call.
const driftWarned = new Set<string>();

export function createPlaybookGate(
  { instances, lease, file }:
  {
    instances?: InstanceManagerLike | null;
    // Who may write (src/eventLog.ts → WriteLease); server.ts passes the
    // projects-root lock's writerCheck.
    lease: WriteLease;
    // Test seam. The default PINS the path on first resolution: eventLogFile()
    // stays lazy (never captured at module load, so a PROJECTS_ROOT override is
    // honoured), but one gate serves exactly one store — a row decided against
    // one store must not land in another after PROJECTS_ROOT moved on.
    file?: () => string;
  },
): PlaybookGate {
  let resolvedFile: string | null = null;
  const logFile = file ?? (() => (resolvedFile ??= eventLogFile()));
  let proj: Projection = emptyProjection();

  const eventLog = createEventLog({
    file: logFile,
    lease,
    onWritten(row) {
      applyRow(proj, row);
      // AFTER the fold — a refresh this hint triggers can never read the stage
      // the row just replaced. Only a bind or a move changes a binding.
      if (row.kind === 'call' && row.subject && (row.bind || row.move)) {
        instances?.emit('playbook_changed', { sessionId: row.subject });
      }
    },
    onBlocked(reason, row) {
      // Put the drop in front of a human: a UI-only bubble in the transcript of
      // the live conductor the row is about (its actor, else its subject).
      // `_emitUi` reaches the ring and the WS feed only — never model input.
      const candidates = [row.actor.type === 'conductor' ? row.actor.sessionId : undefined, row.subject];
      for (const sid of candidates) {
        const inst = sid ? instances?.liveForSession(sid) : null;
        if (inst && isConductorInstance(inst)) {
          inst._emitUi({ kind: 'system', subtype: 'event_log_blocked', data: { reason } });
          return;
        }
      }
    },
  });

  // Fold the log from disk once, on first use rather than at construction: the
  // router is built before a test has finished pointing PROJECTS_ROOT at its
  // temp store, and in production after the root lock is held, so the fold sees
  // every row a previous server wrote. The PROMISE is memoised — two concurrent
  // first uses must not fold twice.
  let loading: Promise<unknown> | null = null;
  function ensureLoaded(): Promise<unknown> {
    if (!loading) loading = readEventLog(logFile()).then(rows => { proj = foldPlaybookState(rows); });
    return loading;
  }

  // THE one append call site in src/. Serialised behind the load, so every row
  // is folded into a projection that already holds the file — and in call
  // order, whichever path (tools/call or the session stream) appended first.
  let chain: Promise<unknown> = Promise.resolve();
  function append(input: AppendInput): Promise<unknown> {
    chain = chain.then(ensureLoaded).then(() => eventLog.append(input)).catch(e => {
      // The log is the audit trail, not the authority for THIS call's outcome.
      console.warn(`eventLog: append skipped — the log could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    });
    return chain;
  }

  // THE liveness oracle every decide() call and read surface goes through.
  // `instances` can be null (a gate built with no registry) — every session
  // reads as not-live then: "not live" is the only answer that cannot mis-govern.
  function isLive(sessionId: string): boolean {
    return !!instances?.isSessionLive(sessionId);
  }

  // Definitions are read PER CALL, never memoised for the process lifetime: a
  // hand-authored playbook dropped into <orchStoreRoot>/playbooks/ takes effect
  // without an orchestrator restart (src/playbooks.ts).
  async function definitions(): Promise<Map<string, Playbook>> {
    const { playbooks, errors } = await loadPlaybooks();
    for (const e of errors) console.warn(`playbooks: '${e.id}' rejected at load: ${e.message}`);
    return playbooks;
  }

  if (instances) attachSessionRecorder({ instances, record: append, projection: () => proj });

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
    const decision = decide({ toolName: name, args, projection: proj, playbooks, isLive, resumeHandle });
    const base = callBase({ name, args, callerId, resumeHandle });

    if (!decision.ok) {
      // Recorded under BOTH levels and for every governable tool — under warn
      // the call proceeds anyway, and this row is the only trace that it
      // should not have.
      await append({ ...base, outcome: 'refused', refusal: { code: decision.code, reason: decision.reason } });
      if (mode === 'warn') {
        // warn lets the call through: put the same fact in front of the human
        // as a UI-only bubble in the CONDUCTOR's transcript (it made the call; a
        // refusal may name no worker at all). Strictly after the row.
        caller._emitUi({
          kind: 'system',
          subtype: 'playbook_warn',
          data: { tool: name, code: decision.code, reason: decision.reason, ...bubbleSubjects(args) },
        });
        // No commit/fail: the refused row is this call's one row.
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
    // A read-only call that ran is not an interaction: no row.
    if (name !== 'spawn_instance' && !(await loadInteractionTools()).has(name)) return { args: patched };
    if (name !== 'spawn_instance' && !base.subject) return { args: patched };
    return {
      args: patched,
      commit: (result: unknown) => commitCall({ base, move, args: patched, result }),
      fail: async (err: unknown) => { await append({ ...base, outcome: 'failed', failure: failureOfError(err) }); },
    };
  }

  async function checkWorkerTool(
    { sessionId, ownerSessionId, toolName }: { sessionId: string | null; ownerSessionId: string | null; toolName: string },
  ): Promise<{ deny: string | null }> {
    const pass = { deny: null };
    if (!sessionId) return pass;
    try {
      await ensureLoaded();
      const bound = proj.bySession.get(sessionId);
      if (!bound) return pass;
      const playbooks = await definitions();
      const stages = playbooks.get(bound.playbook)?.stages;
      // Own stages only: an inherited member named like the recorded stage is drift.
      const stage = stages && Object.hasOwn(stages, bound.stage) ? stages[bound.stage] : undefined;
      if (!stage) {
        const key = `${sessionId}\0${bound.playbook}\0${bound.stage}`;
        if (!driftWarned.has(key)) {
          driftWarned.add(key);
          console.warn(`playbooks: worker-tools check skipped for ${sessionId} — stage '${bound.stage}' of playbook ` +
            `'${bound.playbook}' is not loaded; its calls pass unchecked`);
        }
        return pass;
      }
      const resolved = resolveWorkerTool(stage, toolName);
      if (resolved.decision === 'allow') return pass;
      const { key } = resolved;
      const owner = ownerSessionId ? instances?.liveForSession(ownerSessionId) ?? null : null;
      const liveOwner = owner && isConductorInstance(owner) ? owner : null;
      const mode: PlaybookEnforcement = liveOwner?.playbookEnforcement
        ?? (ownerSessionId && proj.enforcement.has(ownerSessionId)
          ? normalizePlaybookEnforcement(proj.enforcement.get(ownerSessionId))
          : await getDefaultPlaybookEnforcement());
      const reason = workerToolDeniedReason({ playbook: bound.playbook, stage: bound.stage, toolName, key });
      await append({
        kind: 'call', actor: { type: 'worker', sessionId }, subject: sessionId, tool: toolName,
        outcome: 'refused', refusal: { code: WORKER_TOOL_DENIED_IN_STAGE, reason },
      });
      if (mode === 'warn') {
        liveOwner?._emitUi({
          kind: 'system', subtype: 'playbook_warn',
          data: { tool: toolName, code: WORKER_TOOL_DENIED_IN_STAGE, reason, sessionId },
        });
        return pass;
      }
      return { deny: reason };
    } catch (e) {
      console.warn(`playbooks: worker-tools check skipped for ${sessionId} (${toolName}) — ${e instanceof Error ? e.message : String(e)}`);
      return pass;
    }
  }

  async function commitCall(
    { base, move, args, result }:
    { base: CallBase; move: Move; args: Record<string, unknown>; result: unknown },
  ): Promise<void> {
    // A soft refusal from the handler: the call did not do what policy
    // authorised — recorded as failed, with no move and no binding.
    if (isRecord(result) && result.ok === false) {
      await append({ ...base, outcome: 'failed', failure: failureOfResult(result) });
      return;
    }

    if (base.tool === 'spawn_instance') {
      // The session's identity comes from the RESULT, not the arguments: the
      // sessionId does not exist until the subprocess is up, and createWorktree
      // generates the worktree name server-side.
      const view = asRecord(result);
      const sessionId = typeof view.sessionId === 'string' && view.sessionId ? view.sessionId : base.subject;
      const row: NewEventRow = { ...base, ...(sessionId ? { subject: sessionId } : {}), outcome: 'ok' };
      if (move.kind !== 'spawn' || !move.playbook || !move.to || !sessionId) { await append(row); return; }
      const worktree = asRecord(view.worktree).worktreeName;
      const provenance = suppliedProvenance(args.provenance);
      const bind = {
        playbook: move.playbook,
        stage: move.to,
        // Absent `provenance` ⇒ a run root; kept off the row rather than `{}`.
        ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
        ...(typeof view.project === 'string' ? { project: view.project } : {}),
        ...(typeof worktree === 'string' ? { worktree } : {}),
      };
      // A session that ALREADY has a binding is never re-bound — decide() was
      // handed an id it could not place, and the worker that came back is one
      // it already governs; a bind would reset its stage history. DECIDED IN
      // THE CHAIN (a thunk), so two concurrent commits on one session cannot
      // both read "unbound".
      await append(() => (proj.bySession.has(sessionId) ? row : { ...row, bind }));
      return;
    }

    // A real move carries `move` (from !== to by construction — a same-stage
    // send resolves to `self`, which moves nothing). Everything else is the
    // plain row. DECIDED IN THE CHAIN (a thunk), like the bind: two calls
    // decided against the same stage both name it as `from`, and only the first
    // to append still finds the worker there — the second writes its call row
    // without `move`, so neither a stale `from` nor a repeated stage is written.
    if (move.kind === 'transition' && move.from && move.to) {
      const { from, to } = move;
      const provenance = suppliedProvenance(args.provenance);
      const moveField = { from, to, ...(Object.keys(provenance).length > 0 ? { provenance } : {}) };
      const subject = base.subject;
      await append(() => (subject && proj.bySession.get(subject)?.stage === from
        ? { ...base, outcome: 'ok', move: moveField }
        : { ...base, outcome: 'ok' }));
      return;
    }
    await append({ ...base, outcome: 'ok' });
  }

  async function readProjection(): Promise<Projection> {
    await ensureLoaded();
    return proj;
  }

  async function readBindings(sessionIds: unknown[]): Promise<Array<{ playbook: string | null; stage: string | null }>> {
    const p = await readProjection();
    return sessionIds.map(sid => playbookBinding(p, sid));
  }

  async function readLiveWorkers(playbook: string): Promise<string[]> {
    return liveSessionsOnPlaybook(await readProjection(), playbook, isLive);
  }

  // Raw rows, for the backtrack surface. Re-read per call rather than kept
  // alongside the projection: history is asked for by a human-paced read tool,
  // and holding every row in memory forever to serve it would be a leak.
  async function readHistory(): Promise<EventRow[]> {
    await ensureLoaded();
    return readEventLog(logFile());
  }

  return { check, checkWorkerTool, readProjection, readHistory, readBindings, readLiveWorkers, isLive, eventLog: () => eventLog };
}

// The fields every `call` row of one governed call shares.
type CallBase = Omit<Extract<NewEventRow, { kind: 'call' }>, 'outcome'>;
function callBase(
  { name, args, callerId, resumeHandle }:
  { name: string; args: Record<string, unknown>; callerId: string; resumeHandle?: string },
): CallBase {
  // The subject is the worker the call names; for spawn_instance it is the
  // resumed session on a resume, and (until the result names the new session)
  // absent on a fresh spawn.
  const subject = name === 'spawn_instance'
    ? (resumeHandle ?? (typeof args.resume === 'string' && args.resume ? args.resume : undefined))
    : (typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined);
  const forward = forwardOf(args);
  return {
    kind: 'call',
    actor: { type: 'conductor', sessionId: callerId },
    ...(subject ? { subject } : {}),
    tool: name,
    ...(forward ? { forward } : {}),
  };
}

function capReason(s: string): string {
  return s.length > FAILURE_REASON_MAX ? `${s.slice(0, FAILURE_REASON_MAX - 1)}…` : s;
}

function failureOfResult(result: Record<string, unknown>): { code?: string; reason: string } {
  const reason = typeof result.reason === 'string' && result.reason ? result.reason : 'the handler returned ok:false';
  return { ...(typeof result.code === 'string' ? { code: result.code } : {}), reason: capReason(reason) };
}

function failureOfError(err: unknown): { code?: string; reason: string } {
  const code = isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return { ...(code ? { code } : {}), reason: capReason(message || 'the handler threw') };
}

// EVERY WORKER THE CALL NAMED, for the `playbook_warn` bubble — one rule, no
// branch on which side was refused (`code` says that). Keys are OMITTED rather
// than set to undefined: the raw `_emitUi` payload is asserted on.
function bubbleSubjects(args: Record<string, unknown>): { sessionId?: string; forwardSessionId?: string } {
  const forward = forwardOf(args);
  return {
    ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
    ...(forward ? { forwardSessionId: forward } : {}),
  };
}

// send_prompt's forward source, a policy subject in its own right (see
// checkForwardSource in ../playbooks.ts).
function forwardOf(args: Record<string, unknown>): string | undefined {
  const forward = asRecord(args.forward);
  return typeof forward.sessionId === 'string' && forward.sessionId ? forward.sessionId : undefined;
}

// The caller's `provenance` map, narrowed to the {stage: sessionId} string
// pairs the log stores. Prefix values have already been resolved to full
// sessionIds at the transport's prefix chokepoint.
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
