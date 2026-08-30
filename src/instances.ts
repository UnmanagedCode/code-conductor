import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { promises as fsp, mkdirSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Parser, QuiescenceScan, SOFT_INTERRUPT_MARKER, isOuterUserEcho, snapStartToQuiescent, firstQuiescentAtOrAfter, lastQuiescentAtOrBefore } from './parser.ts';
import { getProject, findSessionLocation, readFirstPrompt, sessionFilePath, subAgentDirPath, assertBackingId, orchStoreRoot, claudeProjectsRoot } from './projects.ts';
import {
  mintPublicId, recordRotation, revertRotation, resolveBacking, publicIdFor, segmentsFor, dropSegment,
  trackLineageWrite,
} from './sessionLineage.ts';
import { createWorktree, getWorktree, debugBaseDir } from './worktrees.ts';
import { LOCAL_SYSTEM_ID } from './systems/registry.ts';
import { getTitle as getSessionTitle, setTitle as setSessionTitle, deleteTitle as deleteSessionTitle } from './sessionTitles.ts';
import { getSessionBackend, markSessionBackend, unmarkSessionBackend, type SessionBackendRecord } from './sessionBackends.ts';
import {
  MODES, DEFAULT_MODE, DEFAULT_RESUME_MODE, effectiveResumeMode,
  getSessionMode, markSessionMode, unmarkSessionMode,
} from './sessionModes.ts';
import { isConducted, markConducted, unmarkConducted } from './conductedSessions.ts';
import { SessionRenewController, type RenewalOpts } from './sessionRenew.ts';
import { isTemp, markTemp, unmarkTemp } from './tempSessions.ts';
import { markArchived } from './archivedSessions.ts';
import { isConductorInstance, materializeCurrentConduct } from './conduct.ts';
import { getDefaultPlaybookEnforcement } from './conductorConventions.ts';
// The DEFAULT is imported rather than restated: a second copy of the level this
// field is born at would drift from the allow-list that validates it. Safe as a
// runtime edge — playbooks.ts reaches only projects/fragmentCatalog/playbookLedger
// at module scope, and the tool registry through a lazy dynamic import, so nothing
// here closes a cycle. The allow-list itself (PLAYBOOK_ENFORCEMENT_MODES) is still
// applied at the ingress boundaries — the spawn route and the WS toggle — not here.
import { DEFAULT_PLAYBOOK_ENFORCEMENT, type PlaybookEnforcement } from './playbooks.ts';
import { buildSettingsJSON, buildMcpConfigJSON, AWAITING_INPUT_MESSAGE } from './settings.ts';
import { getOnOverageAction, getOverageThreshold, getConductorCompactWindow, resolveContextWindowTokens, resolveMidTurnSteering, getDebugByDefault, getBackend, isKnownBackend, resolveSpawnEffort } from './appSettings.ts';
import { HookBroker, type HookEnvelope } from './hookBroker.ts';
import { SessionRedirect, isRedirectable, type RedirectableSystem } from './systems/toolRedirect.ts';
import { composeSessionRoot } from './systems/sessionRoot.ts';
import { bashRuleSources, bashRulesRefusal, findUnenforceableBashRules } from './systems/bashRules.ts';
import { loadPersistedTranscript, writeSessionMetadata, readLastSessionModel, hasResumableConversation } from './transcript.ts';
import { PlanFileTracker } from './planFile.ts';
import { canonicalizeModel, familyOf, CLAUDE_BACKEND_ID } from './modelVersions.ts';
import { truncateSessionAtUserMessage } from './sessionEdit.ts';
import { pruneSessionToNewId, INPUT_MODES } from './sessionPrune.ts';
import { saveAttachment, isImageType } from './attachments.ts';
import { buildApprovePrompt } from './planApproval.ts';
import { reconstructTasks } from './taskReconstruct.ts';
import { buildArchive } from './eventArchive.ts';
import { IdleSubscriptionHub } from './idleSubscriptions.ts';
import { OverageResumeController } from './overageResume.ts';
import { UsageOverageMonitor } from './usageOverageMonitor.ts';
import { usageDomainOfBackend, isMonitoredDomain } from './usageWindowDomains.ts';
import { defaultClaudeLauncher, resolveClaudeBin, resolveBackendLaunch } from './claudeLauncher.ts';
import type { CreateInstanceInput, InstanceLike, InstanceManagerLike, InstanceSummary } from './instanceTypes.ts';
import type { UiEvent } from './parser.ts';
import type { WorktreeMeta } from './worktrees.ts';
import type { TaskRecord } from './taskReconstruct.ts';
import type { Response } from 'express';
import type { WriteStream } from 'node:fs';
import { httpError } from './httpError.ts';
import { isKnownEffort } from './effortLevels.ts';

// `AUTO_RESUME_TEXT` now lives with the overage timer machine in
// overageResume.ts; re-export it here so existing importers (and tests) that
// reach for `instances.ts` keep resolving it unchanged.
export { AUTO_RESUME_TEXT } from './overageResume.ts';

// The subprocess handle an Instance launches through the injectable launcher
// seam (default: RealClaudeLauncher → a raw ChildProcess; tests inject an
// in-process fake). Structural — covers exactly the surface Instance.spawn()
// consumes: pid, piped stdio, the 'exit'/'error'/'close' EventEmitter surface,
// and kill(). Nullable streams match ChildProcess's own types; the real CLI
// always spawns with ['pipe','pipe','pipe'], so the nulls are unreachable on
// the production path (guarded at the few call sites that touch them).
interface LaunchedProc {
  // Optional to match ChildProcess's `pid?: number` (the fake in tests sets it
  // to null); Instance.pid is normalised with `?? null` at spawn.
  pid?: number | null;
  stdin: { writable: boolean; write(data: string): boolean; end(): void } | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  once(event: string, cb: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}

interface LauncherLike {
  launch(input: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): LaunchedProc;
}

// A held-open control_request (see Instance._controlRequest): the promise
// callbacks + watchdog timer stored in _pending keyed by request_id.
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

// A message the user typed while the session was paused for overage — the
// shape Instance.prompt() pushes onto `_overageQueue`.
interface OverageQueueItem {
  text: string;
  attachments: unknown[];
  ts: number;
}

// One steer parked on `_pendingSteers` until the armed block-edge stop lands.
interface PendingSteer {
  text: string;
  attachments?: unknown[];
  resolve: () => void;
  reject: (e: Error) => void;
}

// Narrow an event's `data` payload (UiEvent's index signature is `unknown`) to
// a record so the per-subtype field reads below stay typed.
function evData(ev: UiEvent): Record<string, unknown> | null | undefined {
  return ev.data as Record<string, unknown> | null | undefined;
}

// The Instance constructor's input. `effort` is the RESOLVED level (spawn-time
// defaulting happens in the manager's _doCreate).
interface InstanceConstructorInput {
  id: string;
  project: string;
  cwd: string;
  mode: string;
  effort: string | null;
  thinking: string;
  model: string | null;
  contextWindowTokens?: number | null;
  backend?: string;
  hookCallbackUrl?: string | null;
  mcpServerUrl?: string | null;
  worktree?: WorktreeMeta | null;
  temp?: boolean;
  conducted?: boolean;
  callerInstanceId?: string | null;
  debug?: boolean;
  claudePluginDirs?: string[];
  launcher?: LauncherLike;
}

// The mode vocabulary and both defaults live in sessionModes.ts, next to the
// store that persists a session's mode and the effectiveResumeMode() resolver
// that reads it — one home for "what modes exist and what does a resume get".
const VALID_MODES = new Set<string>(MODES);

// `system/task_updated` patch.status values that mean an Agent-tool task is
// actually done (vs. an in-flight progress patch). Unrecognized statuses are
// treated as non-terminal on purpose — better to briefly over-report
// `displayStatus:'running'` than to prematurely flip back to `idle` while a
// backgrounded subagent is still working.
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);

// The task-lifecycle system subtypes. Events with any OTHER kind/subtype
// arriving while the instance is idle mark the idle window "dirty" (see
// _idleWindowDirty) — evidence that something beyond background-task
// bookkeeping (e.g. an unprompted re-invocation turn opening) is happening.
const TASK_LIFECYCLE_SUBTYPES = new Set(['task_started', 'task_updated', 'task_notification']);

// Minimum length for a sessionId PREFIX to be eligible for resolution (see
// InstanceManager.resolveSessionRef). An exact full-id match bypasses this floor;
// it only guards non-exact prefixes against absurdly short, fragile matches
// (a 1–3 char hit that the next spawn could collide with). Uniqueness within the
// in-memory universe remains the real guard — this is just a sanity floor.
export const SESSION_PREFIX_MIN = 4;

// The two mechanisms that rotate a session's backing id. Rotation-generic on
// purpose: prune is not MCP-exposed yet, but every seam it will land on — the
// lineage `reason`, the interlock, the idle hub's completion trigger — treats the
// two uniformly, so exposing it later needs no new branch.
export type RotationMechanism = 'renew' | 'prune';

// The backing ids an instance has run under, in memory. Guarded because several
// suites inject bare `{ id, sessionId }` stand-ins straight into `byId`, and the
// resolvers below sit on the MCP hot path — they must degrade on a partial entry,
// never throw. A real Instance always has the array (set in its constructor).
function segmentsOf(i: Instance): string[] {
  return i._segments ?? [];
}

// Does this instance answer to `id`? True for its PERMANENT public id and for
// every backing id it has ever run under, so a conductor's held id, a wiki page
// naming an old segment, and an archived sidebar row all reach the same session.
function answersTo(i: Instance, id: string): boolean {
  return i.sessionId === id || segmentsOf(i).includes(id);
}

// After an abort, the CLI's internal input queue is not cleared. Any messages
// written to stdin before it (a prompt sent mid-turn, or several) remain
// queued; the CLI dequeues them after the abort
// and starts a SPURIOUS NEW TURN for each one. The drain window catches these
// by listening for system/init on the 'event' channel (the earliest per-turn-
// start signal, firing ~39ms before the API round-trip) and immediately firing
// another control_request interrupt to sever the spurious turn.
//
// POST_ABORT_DRAIN_WINDOW_MS — how long to watch after a hard abort. Increase
// if spurious turns are observed arriving later; decrease if the window blocks
// intentional follow-up prompts that come in very quickly after an abort.
const POST_ABORT_DRAIN_WINDOW_MS = 3000;
// Safety cap: max spurious turns killed per window. Guards against a
// misbehaving subprocess that emits system/init in a tight loop.
const POST_ABORT_DRAIN_MAX = 20;

// Bounded terminal outcome for an ARMED soft interrupt, for the three callers
// that have no human behind them (the overage direct stop, the overage
// turn-start guard, the resume-restart drain). An arm normally discharges at
// the next block boundary; when the turn never ends at all — a genuinely wedged
// tool, or a gateway that withholds both a block close and any later block key
// (QuiescenceScan's R1/R2 residuals) — nothing else would ever release it, and
// these callers cannot wait forever. Manual ⏸ / interrupt_turn stay UNBOUNDED:
// a human and a conductor both already have the ⏹ escalate affordance.
//
// Exceptional, not load-bearing: it fires only for a turn that never ends.
// ORCH_SOFT_INTERRUPT_DEADLINE_MS is the test seam (same idiom as
// ORCH_OVERAGE_RESUME_BUFFER_MS) so tests never sleep out a real clock; read at
// call time, not at module load, so a test can set it after import.
const SOFT_INTERRUPT_DEADLINE_MS = 120_000;
export function softInterruptDeadlineMs(): number {
  const env = Number(process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS);
  return Number.isFinite(env) ? env : SOFT_INTERRUPT_DEADLINE_MS;
}

// The two terminal statuses. Exported because "is this worker dead?" is asked
// on two MCP surfaces that MUST agree — list_projects' `live N`
// (liveCountForProject) and whether a worker lands in list_sessions' live rows
// (src/mcp/handlers.ts) — and a second spelling of the rule is how they would
// drift apart. A dead instance retained in byId (non-temp exits are kept
// indefinitely, so respawn can resume them) is NOT a live worker.
export function isDeadStatus(status: unknown): boolean {
  return status === 'exited' || status === 'crashed';
}

// Annotation on the `soft_interrupted` event the turn-start guard emits when a
// turn begins during an overage lockout. Rendered by public/blocks.js as
// `⏸ Turn interrupted: <text>` — the observed defect was that such a turn was cut
// SILENTLY, so naming the lockout as the cause is the point. Not sent to the CLI:
// nothing may be written to a session during the window.
const OVERAGE_TURN_BLOCKED_TEXT =
  'the overage lockout is still active — this turn was stopped rather than run ' +
  'against the throttled account.';

// Prepended to user messages delivered while the worker is mid-turn. Keeps
// the user's text verbatim but gives the worker timing context: the message
// may not have been composed in reaction to the latest output.
export const MID_TURN_NOTE =
  '<system-reminder>\n' +
  'The user sent this message while you were mid-turn. They may not have seen your ' +
  'most recent output, and you\'ve continued working since they began composing. ' +
  'This may be new direction or a reaction to earlier work — weigh it accordingly; ' +
  'don\'t assume it refers to your latest action.\n' +
  '</system-reminder>';

// The note that rides a steer delivered AFTER a block-edge stop, on a model that
// cannot take a mid-turn injection (acceptsMidTurnSteering === false). THIS
// CONSTANT IS THE ONLY PLACE THAT DECISION LIVES — the sender never knows which
// delivery mechanism ran, so the fact that the turn was cut off has to be carried
// here rather than written into each caller's text.
//
// Built by splicing an extra clause INTO MID_TURN_NOTE's <system-reminder>
// wrapper, not concatenated after it: that keeps all three signals
// isMidTurnNoteContent (src/parser.ts) matches on — leading '<system-reminder>',
// the 'mid-turn' token, trailing '</system-reminder>' — true by construction. If
// this ever becomes a second, separate block instead, replay renders it as a real
// user bubble and shifts the rewind/fork user-message index
// (docs/architecture.md → prefix-safety invariant).
export const POST_STOP_STEER_NOTE = MID_TURN_NOTE.replace(
  '\n</system-reminder>',
  '\n\nYour turn was STOPPED at a block boundary so this message could be delivered — ' +
  'it did NOT run to completion. The work you had already finished is intact, but ' +
  'nothing past that point ran: do not read your own transcript as a completed turn. ' +
  'Decide explicitly whether to resume the interrupted work, abandon it, or clean up ' +
  'after it, and say which.\n</system-reminder>',
);

// Returns true when a rate_limit_event signals the session is now using
// paid overage credits. Defensive: matches isUsingOverage at either
// nesting level (nested under rate_limit_info or flat on the event).
function isOverageEvent(data: unknown): boolean {
  const rec = (data ?? null) as { rate_limit_info?: { isUsingOverage?: unknown } | null | undefined; isUsingOverage?: unknown } | null;
  return rec?.rate_limit_info?.isUsingOverage === true
      || rec?.isUsingOverage === true;
}

// Normalise the rate-limit window reset time to epoch SECONDS, or null.
// The live `rate_limit_event` field is the camelCase epoch-seconds `resetsAt`
// (confirmed against a real CLI capture). The snake_case ISO `resets_at` (as in
// the account-usage payload / header.js's `new Date(bucket.resets_at)`) and a
// raw epoch number are accepted only as defensive fallbacks. The overage
// auto-resume timer (overageResume.ts arm()) and the global clear timer both
// expect epoch seconds, so this is the single place the shape is reconciled.
export function parseResetEpochSecs(info: unknown): number | null {
  const rec = (info ?? null) as { resetsAt?: unknown; resets_at?: unknown } | null;
  const v = rec?.resetsAt ?? rec?.resets_at ?? null;
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null; // already epoch secs
  const ms = Date.parse(v as string);                              // ISO-8601 string
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
// `ask` is orchestrator-only — the CLI itself doesn't know about it. At
// spawn / set_permission_mode time the CLI receives the equivalent
// bypassPermissions value; the orchestrator tracks `ask` separately and
// uses it to decide whether the interactive hook callback should prompt
// the user or auto-allow.
//
// LIVE WIRE ONLY — its two call sites are the `--permission-mode` argv below
// and the `set_permission_mode` control request. The collapse is the mechanism
// there: the CLI must stop prompting so the hook can. It is NOT how a mode is
// recorded; the durable jsonl marker goes through markerPermissionMode
// (sessionModes.ts), which maps `ask` to `default` instead. Reaching for this
// one when writing a record is the bug that made the marker claim every gated
// session ran hot.
function cliPermissionMode(mode: string): string {
  return mode === 'ask' ? 'bypassPermissions' : mode;
}

const VALID_THINKING = new Set(['adaptive', 'enabled', 'disabled']);
const DEFAULT_THINKING = 'adaptive';

// Bounded drop-oldest event log per instance. `_seq` is stamped here at
// push time and stays monotonic for the life of the Instance — eviction
// never renumbers, so consumers keyed on `_seq` (WS client dedup,
// get_transcript({fromSeq}), GET /api/instances/:id/events) survive
// trims. Evicted events remain reconstructable from the session jsonl
// (see src/eventArchive.ts).
//
// Trimming is batched (amortized O(1) per push): once the buffer exceeds
// cap + slack, the front is spliced down to cap, then "snapped" forward so
// the surviving head is an outer user_echo — a turn boundary — which lets
// the jsonl-replay archive be cut against the retained ring with no
// overlap. When no echo is within cap/2 of the tail (a single giant turn
// spans the whole droppable region), the snap falls back to the nearest
// QUIESCENT point (whole blocks only — see parser.ts) so the gap-case head
// still renders cleanly; only a giant non-quiescent span forces a plain cut.
const DEFAULT_RING_CAP = 2000;
const RING_TRIM_SLACK = 256;
// Max events sent in a WS `subscribe` snapshot (see Instance.snapshotTail).
// Matches the long-documented snapshot-tail figure, so sessions under that count
// behave exactly as before. Override with ORCH_SNAPSHOT_TAIL.
const DEFAULT_SNAPSHOT_TAIL = 500;

export class EventLog {
  cap: number;
  slack: number;
  buf: Array<UiEvent & { _seq: number }>;
  nextSeq: number;

  constructor({ cap }: { cap?: number } = {}) {
    const envCap = Number(process.env.ORCH_EVENT_RING_CAP);
    this.cap = (typeof cap === 'number' && Number.isInteger(cap) && cap > 0) ? cap
      : (Number.isInteger(envCap) && envCap > 0 ? envCap : DEFAULT_RING_CAP);
    // For tiny caps (tests) the trim trigger scales down with the cap.
    this.slack = Math.min(RING_TRIM_SLACK, this.cap);
    this.buf = [];
    this.nextSeq = 0;
  }
  // First retained `_seq` — everything below it was evicted (0 when
  // nothing was). Equals nextSeq for an empty ring.
  get trimmedBefore(): number { return this.buf.length ? this.buf[0]._seq : this.nextSeq; }
  // Retention is storage-only — it never gates what _emitUi emits to the live
  // WS feed. A `v` this method declines to retain simply never receives a
  // `_seq`, so _emitUi still emits it seq-less (the client renders seq-less
  // events unconditionally — see public/conversation.js). The per-token
  // live-stream floods (one system/thinking_tokens per thinking_delta token,
  // emitted by the Claude CLI as a live progress estimate — docs/protocol.md owns
  // the observed-emitter list; it is NOT specific to any one backend, and prose
  // streams one text_delta per token on every backend) are kept OUT of the ring so
  // a single long turn can't overflow it and strand the archive mid-turn
  // (history_gap):
  //   - thinking_tokens is a live-only counter (last-value-wins, never
  //     persisted, no-op on replay) → never retained. Its final value is
  //     stamped onto the retained thinking_redacted slot (see _emitUi) —
  //     that block replays no text, so the slot is the only place the
  //     estimate can outlive the block.
  //   - consecutive thinking_delta OR text_delta of one block fold into ONE slot
  //     — the same one-delta-per-block shape disk replay produces
  //     (src/transcript.ts), so ring + jsonl-archive reconstruct identically. The
  //     LIVE per-token stream is untouched; only the retained representation
  //     coalesces. The two kinds never fold into each other (tail.kind === v.kind),
  //     and msgId is per-message so a sub-agent block can never fold into an
  //     outer one.
  // The replay-path `message_start` (`replayed: true`, emitted by loadHistory to
  // seed the ctx readout) is declined for the same storage-only reason: it is
  // synthetic, so it must not become history — see loadHistory for why keeping it
  // off the ring is load-bearing rather than merely tidy.
  push(v: UiEvent): void {
    if (v.kind === 'system' && v.subtype === 'thinking_tokens') return;
    if (v.kind === 'message_start' && v.replayed) return;
    // `context_usage` is storage-pointless for the same reason: a re-subscribing
    // client is seeded from the `lastContextUsage` FIELD, and on the only
    // backends that emit it every in-tail message_start carries `usage: null`
    // and so cannot clobber that seed.
    if (v.kind === 'context_usage') return;
    const tail = this.buf[this.buf.length - 1];
    if ((v.kind === 'thinking_delta' || v.kind === 'text_delta')
        && tail && tail.kind === v.kind
        && tail.msgId === v.msgId && tail.blockIdx === v.blockIdx) {
      // The parser emits delta text as a string, so the merge is string
      // concatenation (the index-signature field is unknown).
      tail.text = (tail.text as string) + (v.text as string);
      return;
    }
    v._seq = this.nextSeq;
    this.nextSeq += 1;
    this.buf.push(v as UiEvent & { _seq: number });
    if (this.buf.length > this.cap + this.slack) this._trim();
  }
  _trim(): void {
    const base = this.buf.length - this.cap;                   // plain cut point
    const maxIdx = this.buf.length - Math.ceil(this.cap / 2);  // snap give-up bound
    let cut = base;
    while (cut < maxIdx && !isOuterUserEcho(this.buf[cut])) cut += 1;
    if (cut >= maxIdx) {
      // No turn boundary in reach (one giant turn). Fall back to the nearest
      // quiescent point so the post-eviction ring head still opens on whole
      // blocks — the evicted turn prefix becomes the archive gap case, and
      // its history_gap marker sits above clean content instead of a half
      // block. Last resort: plain cut (a single giant non-quiescent span);
      // the client finalize backstop covers those visuals.
      const q = firstQuiescentAtOrAfter(this.buf, base, maxIdx);
      cut = q !== -1 ? q : base;
    }
    this.buf.splice(0, cut);
  }
  // INVARIANT: ring elements are not fully immutable — an OPEN thinking_delta or
  // text_delta slot's `.text` GROWS in place (push folds later same-block deltas
  // in) until its block closes. Growth is APPEND-ONLY: the slot is never shrunk,
  // replaced by a new object, or renumbered, so a consumer holding a shallow
  // snapshot across an `await` (ringSnapshot → pageInstanceEvents, snapshotTail →
  // wsHub) can only ever observe a longer prefix-extension of the same `_seq`,
  // never a torn or duplicated one. The only hazard is a consumer that re-reads
  // the same `_seq` slot later expecting byte-stable text, or that merges/pages
  // by array position instead of by `_seq`.
  toArray(): Array<UiEvent & { _seq: number }> { return this.buf.slice(); }
  clear(): void { this.buf.length = 0; this.nextSeq = 0; }
}

export class Instance extends EventEmitter implements InstanceLike {
  // All fields are assigned in the constructor below (with the three
  // post-construction additions _mutating/_skipUsageSeed/_spawnArgv/_overageGate
  // declared here too, since the manager and later methods assign them).
  id: string;
  _launcher: LauncherLike;
  project: string;
  cwd: string;
  mode: string;
  effort: string | null;
  thinking: string;
  model: string | null;
  contextWindowTokens: number | null;
  // False when this session's model cannot accept a user message injected into a
  // running turn — see resolveMidTurnSteering. Re-resolved from the live registry
  // whenever the model changes (never persisted: a deleted row degrades to the
  // pre-flag behaviour, which is what a missing capability declaration means).
  acceptsMidTurnSteering: boolean;
  backend: string;
  hookCallbackUrl: string | null;
  mcpServerUrl: string | null;
  claudePluginDirs: string[];
  // THE REDIRECTION, or null for a project on cc's own machine.
  //
  // A worker on a remote system runs the CLI locally in a cc-owned session root
  // and crosses the machine boundary tool by tool (src/systems/toolRedirect.ts).
  // Its presence is what widens the injected hook surface, so it must be
  // attached before launch() — see attachRedirect.
  _redirect: SessionRedirect | null;
  // What a relaunch needs to re-pull the session root, since launch() runs long
  // after create() resolved the system handle.
  _redirectPlacement: RedirectPlacement | null;
  worktree: (WorktreeMeta & { postWorktreeCreate?: unknown }) | null;
  temp: boolean;
  conducted: boolean;
  callerInstanceId: string | null;
  debug: boolean;
  debugDir: string | null;
  _debugStreams: { stdin: WriteStream; stdout: WriteStream; stderr: WriteStream } | null;
  // The session's PERMANENT public id — the one and only handle that crosses an
  // API / MCP / WS / UI / persisted-store boundary, and the one summary() emits.
  sessionId: string | null;
  // The CLI's OWN rotating session_id: what names the transcript file on disk and
  // what goes to `--resume` / `--session-id`. Confined to process launch and
  // transcript resolution, and DELIBERATELY absent from summary() — that absence
  // is what enforces the invariant that a rotating id never reaches a conductor.
  //
  // The two diverge from the first rotation onward. They are EQUAL only for a
  // session with no lineage row (the store's base case — see sessionLineage.ts),
  // where the public id simply is the first backing id.
  backingSessionId: string | null;
  // Every backing id this session has run under, oldest first — the in-memory
  // mirror of its lineage row's segments (src/sessionLineage.ts). Held here so
  // prefix/exact resolution on the MCP hot path stays synchronous and store-free.
  _segments: string[];
  // Serialised chain for this instance's DURABLE lineage writes, plus the last
  // error one produced. A rotation observed in the stdout line loop is recorded
  // in memory immediately and its persist is kicked onto this chain in the same
  // tick — the earliest possible durability point, since the CLI has ALREADY
  // written the new transcript by the time we see its system/init. flushLineage()
  // is how a caller waits for it and learns whether it landed.
  _lineageWrite: Promise<void>;
  _lineageError: Error | null;
  // Non-null while a context rotation is IN FLIGHT on this instance — a managed
  // `/clear` renewal or a prune. ONE field answers "is a rotation happening here",
  // for both mechanisms and both readers: IdleSubscriptionHub defers its armed wake
  // on it (so a conductor's wake cannot be spent a turn early), and each mechanism
  // refuses to start while the other holds it (SESSION_ROTATING).
  //
  // It lives on the Instance rather than in either controller precisely so the
  // hub's defer does not depend on listener registration order — the hub's
  // listener is registered BEFORE the renew controller's, which is why the
  // pre-card code consumed the wake on the ARMED turn_end, a turn early.
  _rotation: { reason: RotationMechanism; startedAt: number } | null;
  // TRUE for the whole renewal sequence: from `arm()` until the reseed prompt()
  // has actually been accepted. A SECOND flag rather than a wider `_rotation`,
  // because the two have genuinely different lifetimes and only their union is
  // safe to mutate against:
  //   `_rotation` must close at the `/clear`'s own turn_end — the idle hub stops
  //   deferring there, and if it did not, the reseed's turn_end could never
  //   deliver a waiting conductor's wake (D3).
  //   `_renewing` must stay set past that point, because between the turn_end and
  //   the reseed landing, `_rotation` is null, `_mutating` is false and status is
  //   'idle' — every guard a prune or a rewind checks. A request landing in that
  //   window kills the proc, and the reseed then 409s in prompt(): context
  //   cleared, handoff summary lost, conductor hearing only heartbeats. Which is
  //   exactly the outcome the interlock exists to prevent.
  _renewing: boolean;
  // TRUE while this instance is between an old proc (killed, or already dead)
  // and the launch() that replaces it, for the two relaunch paths that are
  // NOT `_rotation`: rewindToUserMessage and InstanceManager.respawn. Read
  // ONLY by isSessionLive — deliberately NOT folded into `_rotation`/
  // `rotationPending`, which carries a `reason: RotationMechanism` ('renew' |
  // 'prune') that _assertNoRotationInFlight's error text and the
  // rotation_complete/idle-wake path both key off; widening that union would
  // make a rewind/respawn collision misreport as "a context renewal is in
  // progress" and would wire an unrelated wake path these operations were
  // never meant to arm. This flag has none of that: no reason string, no UI
  // event, no interaction with any other guard — it exists solely so a
  // worker mid-relaunch here reads live the same way prune's window does.
  _relaunching: boolean;
  // The last COMPLETED rotation. Pinning the public id removes the only tell a
  // conductor had that a rotation happened at all, so these replace it. Set here;
  // surfaced on summary() / CONDUCTOR_VIEW_KEYS in stage 8.
  lastRotatedAt: number | null;
  rotationReason: RotationMechanism | null;
  pid: number | null;
  status: string;
  lastResponseAt: number | null;
  createdAt: number;
  proc: LaunchedProc | null;
  parser: Parser;
  ring: EventLog;
  _userEchoCount: number;
  _liveThinkingTokens: number | null;
  _lastContextUsage: unknown;
  _pending: Map<string, PendingRequest>;
  _hooks: HookBroker;
  _stderr: string;
  _lastLeafUuid: string | null;
  _planFiles: PlanFileTracker;
  firstPrompt: string | null;
  title: string | null;
  autoApprovePlan: boolean;
  playbookEnforcement: PlaybookEnforcement;
  interrupting: boolean;
  _quiescence: QuiescenceScan;
  _interruptArmed: boolean;
  _interruptFired: boolean;
  _interruptArmSeq: number;
  _interruptDeadline: ReturnType<typeof setTimeout> | null;
  // This turn was FORCE-aborted (partial output, work discarded). Read by
  // IdleSubscriptionHub at turn_end so an owner is told the turn was interrupted
  // rather than finished. Set in interrupt({force:true}) — the one chokepoint both
  // doors (the MCP tool and the UI's stop button via wsHub) go through, so neither
  // can forget it. Cleared only on a turn START: the turn_end that reads it fires
  // AFTER _setStatus('idle'), and a deferred wake may not read it until a later
  // turn_end still belonging to the same abort.
  _turnForceAborted: boolean;
  pendingPrefill: string | null;
  _drainTimer: NodeJS.Timeout | null;
  _drainListener: ((ev: UiEvent) => void) | null;
  _suppressTempDelete: boolean;
  _killing: boolean;
  autoStoppedForOverage: boolean;
  autoResumeAt: number | null;
  _overageResetsAt: number | null;
  _overageHandled: boolean;
  _overageWasStopped: boolean;
  _overageWasIdleParked: boolean;
  _overageResumeFiring: boolean;
  _overageDroppedCallbacks: boolean;
  _overageUnarmedWorkers: boolean;
  _overageStoppedUnarmed: boolean;
  _overageQueue: OverageQueueItem[];
  // Steers waiting for a block-edge stop to complete before they are sent, on a
  // model that cannot take a mid-turn injection. See queueSteerAfterStop.
  _pendingSteers: PendingSteer[];
  _activeAgentTasks: Map<string, string | null>;
  _taskNotificationPending: boolean;
  _idleWindowDirty: boolean;
  _turnFirstReqCacheRead: number | null;
  _turnFirstReqCacheCreation: number | null;
  _turnMissDetected: boolean;
  _turnLastReqPrefix: number | null;
  _turnEvicted: number;
  _prevTurnPrefix: number | null;
  _prefixBaselineInvalid: boolean;
  _mutating: boolean;
  _skipUsageSeed: boolean;
  _spawnArgv: string[] | null;
  _overageGate: (() => { active: boolean; resetsAt: number | null }) | null;

  constructor({ id, project, cwd, mode, effort, thinking, model, contextWindowTokens = null, backend = CLAUDE_BACKEND_ID, hookCallbackUrl = null, mcpServerUrl = null, worktree = null, temp = false, conducted = false, callerInstanceId = null, debug = false, claudePluginDirs = [], launcher = defaultClaudeLauncher }: InstanceConstructorInput) {
    super();
    this.id = id;
    // The ClaudeLauncher used to spawn the subprocess. Defaults to the real
    // launcher (child_process.spawn); tests inject an in-process one.
    this._launcher = launcher;
    this.project = project;
    this.cwd = cwd;
    this.mode = mode;
    this.effort = effort;
    this.thinking = thinking;
    // `model` holds the concrete id for EVERY backend: a Claude version id
    // ('claude-…', carrying its catalog launch tag where one applies) or another
    // backend's model id ('gemma4:cloud', 'gpt-5.6-sol[1m]'). For a substitution
    // backend this string is the registry KEY — byte-exact, never normalized.
    // `backend` (a registry id) is the sole discriminator: it selects the launch
    // command via its template; the claude args (including --model) are built
    // uniformly.
    this.model = model;
    // This session's context capacity in raw tokens, or null when unknown.
    // Resolved ONCE server-side from {backend, model} (see create()), then
    // recomputed only when this.model genuinely changes. Feeds the substitution
    // backend's context env vars, summary(), the MCP projection, the client ctx
    // chip, forks, and the restart manifest — one number, one source. Null means
    // unknown and must render as unknown.
    this.contextWindowTokens = Number.isFinite(contextWindowTokens) ? contextWindowTokens : null;
    // Registry id, normalized to the identity backend when unknown (a backend
    // the user has since removed must not strand the session unspawnable).
    this.backend = isKnownBackend(backend) ? backend : CLAUDE_BACKEND_ID;
    // Resolved from the same {backend, model} pair as the capacity above; both
    // move together in _refreshModelCapabilities().
    this.acceptsMidTurnSteering = resolveMidTurnSteering({ backend: this.backend, model: this.model });
    this.hookCallbackUrl = hookCallbackUrl;
    this.mcpServerUrl = mcpServerUrl;
    this._redirect = null;
    this._redirectPlacement = null;
    // Absolute Claude Code plugin roots (each directly containing
    // `.claude-plugin/plugin.json`) contributed by enabled cc plugins whose
    // manifest declares `claudePlugin`. Resolved + validated once at create()
    // time (async) and frozen on the instance, mirroring mcpServerUrl; spawn()
    // emits one `--plugin-dir <root>` per entry. Reused verbatim across
    // respawn/rewind (a plugin enabled mid-session is picked up on the next
    // create, not a bare respawn).
    this.claudePluginDirs = Array.isArray(claudePluginDirs) ? claudePluginDirs : [];
    // null for a normal instance; otherwise the worktree metadata object
    // (parentProject, worktreeName, worktreePath, branch, baseBranch,
    // baseSha) so the UI can show a chip and the rebase/ff buttons.
    this.worktree = worktree;
    // When true, the session jsonl + sibling subagents/ directory are
    // deleted from ~/.claude/projects/<encoded-cwd>/ on subprocess exit,
    // and the orchestrator skips its last-prompt / permission-mode
    // metadata appends during the run.
    this.temp = !!temp;
    // When true, this session was spawned via the MCP `spawn_instance`
    // tool (orchestrator-driven) — a *conducted* worker, as opposed to a
    // session from the browser UI / HTTP spawn path. Orthogonal to
    // `temp`. Persisted durably to the `<store>/conducted-sessions.json`
    // sidecar (see _writeSessionMetadata) so it survives exit / restart /
    // --resume; the sidebar groups these under a `— conducted —`
    // separator. Purely a marker + display axis: no behavioural
    // divergence vs a normal session.
    this.conducted = !!conducted;
    // Instance ID of the conductor that spawned this worker via
    // spawn_instance. Null for sessions created by the browser UI / HTTP
    // path. Surfaced in summary() so GET /api/instances lets the frontend
    // build a caller→workers map for the sub-agent panel.
    this.callerInstanceId = callerInstanceId ?? null;
    // When true, raw CLI stdin/stdout/stderr is mirrored to the
    // central store's debug dir for offline inspection. Streams + the
    // debug dir path are populated at spawn time.
    this.debug = !!debug;
    this.debugDir = null;
    this._debugStreams = null;
    this.sessionId = null;
    this.backingSessionId = null;
    this._segments = [];
    this._lineageWrite = Promise.resolve();
    this._lineageError = null;
    this._rotation = null;
    this._renewing = false;
    this._relaunching = false;
    this.lastRotatedAt = null;
    this.rotationReason = null;
    this.pid = null;
    this.status = 'idle';
    // Wall-clock time of the most recent turn_end (i.e. the last completed
    // assistant response), stamped in _handleStdoutLine. Null until the
    // first turn completes. Surfaced in summary() for the messages view's
    // live "time since last response" indicator.
    this.lastResponseAt = null;
    // Wall-clock creation time, stamped once and never re-written. Surfaced in
    // summary() so the sidebar's synthetic (not-yet-on-disk) session rows have a
    // STABLE "last activity" fallback for the pre-first-turn case — before
    // lastResponseAt is set — instead of a per-render Date.now() that would
    // re-stamp in lockstep on every unrelated status broadcast (see mergeLive).
    this.createdAt = Date.now();
    this.proc = null;
    this.parser = new Parser();
    this.ring = new EventLog();
    // Absolute ordinal of the next outer user_echo, stamped onto the event
    // as `userIndex` in _emitUi. Counts exactly the events that correspond
    // 1:1 to `isPureUserPromptLine` jsonl lines (the rewind/fork anchor),
    // so the index stays correct even after the ring trims away early
    // bubbles — the client must NOT derive it by counting rendered bubbles.
    // Reset alongside the ring in _wipeForResume (replay recounts from 0).
    this._userEchoCount = 0;
    // Ephemeral live thinking-token estimate for the OPEN thinking block, or
    // null when none is streaming. The per-token system/thinking_tokens events
    // are never retained in the ring (see EventLog.push), so this O(1)
    // last-value-wins state lets a fresh subscriber's snapshot carry the
    // CURRENT count alongside the coalesced partial thinking text. Cleared when
    // the block closes; a closed block that had text replays it (and finalizes
    // to a char count), while a closed REDACTED block keeps the final estimate
    // on its ring slot (see _emitUi). Reset on resume (see _wipeForResume).
    this._liveThinkingTokens = null;
    // Last observed message_start.usage, or context_usage.usage on a backend
    // whose message_start is all-zero — the current context-size reading that
    // drives the header's ctx chip. Held as O(1) state because the ring is NOT a
    // reliable carrier: the snapshot tail is capped and its start snaps FORWARD
    // past any open block (snapshotTail → snapStartToQuiescent), so a turn whose
    // final text block runs longer than the tail pushes every message_start below
    // the window and a re-subscribing client would rebuild an empty tracker
    // (`ctx —`). A backend that answers in one long unbroken text block hits that
    // routinely. Unlike _liveThinkingTokens this deliberately SURVIVES turn_end —
    // it's last-value-wins for the life of the process. Its only reset is
    // _wipeForResume (rewind/respawn), which rewrites the CLI's prefix in place;
    // a fork or a resume-after-restart needs none, since each builds a NEW
    // Instance that starts here at null (and a fork must leave the parent's value
    // alone — that session continues).
    this._lastContextUsage = null;
    this._pending = new Map<string, PendingRequest>(); // request_id -> { resolve, reject, timer }
    // Per-instance PreToolUse hook callback broker (held-open
    // responses + timeout fallbacks + the ask-mode permission_request
    // emission). See src/hookBroker.ts.
    this._hooks = new HookBroker({
      getMode: () => this.mode,
      emit: (ev: unknown) => this._emitUi(ev as UiEvent),
      // A GETTER, not the value: the redirect is attached after construction
      // (it needs this instance's emit) and dropped when the session ends.
      getRedirect: () => this._redirect,
    });
    this._stderr = '';
    this._lastLeafUuid = null;     // for last-prompt jsonl marker
    this._planFiles = new PlanFileTracker(); // binds a ~/.claude/plans/*.md Write to an ExitPlanMode
    // Cached first user-prompt text (200-char cap matching readFirstPrompt
    // in projects.ts). Surfaced via summary() so the sidebar can label a
    // live temp session's row — temp rows don't read the jsonl, so without
    // this they'd stay as "(new session)" forever.
    this.firstPrompt = null;
    // Custom human-readable label set via the ⋮ menu's Rename session
    // action. When set, the sidebar + header render this in place of the
    // first-prompt preview. Loaded from the sidecar `<store>/session-
    // titles.json` after sessionId is known; mutated by setTitle() from
    // the PUT /api/sessions/:sid/title route.
    this.title = null;
    // When true and the instance is in plan mode, an incoming
    // plan_request is auto-approved server-side (mode flip + approval
    // prompt) without waiting for a client click. Lives on the server so
    // the auto-approve fires regardless of which tab/session is in
    // focus, or whether any client is even connected.
    this.autoApprovePlan = false;
    // How hard this session's playbook is enforced at the MCP boundary, read by
    // src/mcp/playbookGate.ts. Only meaningful on a CONDUCTOR — the gate scopes
    // itself with isConductorInstance, so the field is simply never read on any
    // other instance. The last-resort fallback only: a conductor spawned through
    // Manager._doCreate takes the persisted Settings default (or the caller's
    // explicit value) before it launches.
    this.playbookEnforcement = DEFAULT_PLAYBOOK_ENFORCEMENT;
    // Transient flag layered on top of `status: 'turn'`: set true when a SOFT
    // (deferred) interrupt is ARMED and the abort has not fired yet; cleared
    // automatically by _setStatus on any exit from `turn` (turn_end → idle,
    // crash, exit). Drives the "stopping…" marker + the "Interrupt now"
    // escalate affordance.
    this.interrupting = false;
    // Live quiescence of the OUTER event stream, fed from _emitUi with the same
    // predicate the paging snap uses (QuiescenceScan, parser.ts): empty ⇒
    // nothing is mid-stream and every dispatched tool has returned its result.
    // An armed interrupt fires at the first such point, so no half-streamed
    // block is cut and no completed tool work is thrown away. _interruptArmed
    // is the fire's own gate — deliberately NOT `interrupting`, which is also the
    // WS-visible "stopping…" flag — and _interruptFired holds it to at most one
    // control_request per arm.
    this._quiescence = new QuiescenceScan();
    this._interruptArmed = false;
    this._interruptFired = false;
    // Arm-time snapshot of _quiescence.boundarySeq. The fire predicate reads
    // boundaries crossed SINCE the arm, which is the only way an abort can
    // notice a block being retired by the next block's key (parser.ts, path 2)
    // — that retire is the same event that opens the next block, so `empty`
    // never reads true on such a stream.
    this._interruptArmSeq = 0;
    this._interruptDeadline = null;
    this._turnForceAborted = false;
    // Fork drops the dropped user prompt here so it can ride the new
    // instance's first `snapshot` frame as `droppedText` — the inline
    // analogue of rewind's `reset_snapshot` droppedText. Consumed once by
    // the wsHub subscribe handler (consumePrefill), so a later re-subscribe
    // never re-prefills and clobbers the user's edits.
    this.pendingPrefill = null;
    // Post-hard-abort drain window: timer handle + listener for killing
    // spurious turns the CLI starts from its leftover input queue after a
    // hard abort. Both null when the window is closed. See _openDrainWindow.
    this._drainTimer = null;
    this._drainListener = null;
    // Set true by the resume-restart path before SIGKILL so _handleExit
    // skips _archiveTempSession() — the temp jsonl must survive to be
    // resumed on the next boot. Never persisted.
    this._suppressTempDelete = false;
    // Set true at the top of kill() so _handleExit can tell a COMMANDED
    // teardown (user kill, project delete, shutdown, rewind — all route
    // through kill()) from a spontaneous crash, and not mislabel the former
    // as a substitution-backend launch failure. Reset to false on every spawn().
    this._killing = false;
    // Auto-stop / auto-resume on overage state. `autoStoppedForOverage` is
    // set true when an `onOverage: 'stop-resume'` overage event soft-interrupts
    // the turn; the manager arms a per-session resume timer on the next idle
    // transition and stamps `autoResumeAt` (epoch SECONDS) for the UI badge.
    // `_overageResetsAt` carries the reset time from the rate_limit_event to
    // the manager's arm step; `_overageHandled` is a one-shot guard so repeated
    // rate_limit_events don't re-trigger. All reset on (re)spawn.
    this.autoStoppedForOverage = false;
    this.autoResumeAt = null;
    this._overageResetsAt = null;
    this._overageHandled = false;
    // True when this session was genuinely stopped MID-WORK by a direct interrupt.
    // FIRST of the three resume-preamble selectors resolved by `overageResumeKind`
    // (src/overageResume.ts): this flag → AUTO_RESUME_TEXT ("continue where you left
    // off"); `_overageWasIdleParked` below → IDLE_PARKED_RESUME_TEXT; neither →
    // the softened queued-only line. Reset on (re)spawn; persisted across a
    // resume-restart.
    this._overageWasStopped = false;
    // True when the overage stop found this session ALREADY IDLE: nothing of its own
    // was interrupted, so neither "continue where you left off" nor the queued-only
    // line is true for it — it gets IDLE_PARKED_RESUME_TEXT. Third selector of the
    // resume preamble (src/overageResume.ts → overageResumeKind). Reset on (re)spawn;
    // persisted across a resume-restart.
    this._overageWasIdleParked = false;
    // Set for the duration of the auto-resume's OWN send: that prompt is the one turn
    // allowed to start inside a still-active lockout, so it is exempted from
    // _guardOverageTurnStart. The FLAG is the mechanism, deliberately — whether the
    // lockout is still live at that turn_start depends on the interleaving (see
    // OverageResumeController.run), so a check on the gate or the parked count would
    // pass only sometimes.
    this._overageResumeFiring = false;
    // Two INDEPENDENT facts a stopped conductor's resume prompt must carry, each
    // gated on its own flag because either can hold without the other: a callback
    // can be severed with no un-armed worker (it was waiting on a session it does
    // not own), and a worker can be stopped un-armed with no callback pending. One
    // flag for both would make the other clause assert something that did not
    // happen. Read by buildConductorResumePreamble (src/overageResume.ts).
    this._overageDroppedCallbacks = false;
    this._overageUnarmedWorkers = false;
    // Set on a WORKER the overage stop left un-armed: its conductor is the sole
    // driver, so this session must neither self-resume nor queue sends behind a
    // resume it will never get. prompt() refuses instead — see the overage intercept.
    this._overageStoppedUnarmed = false;
    // Messages typed while auto-stopped-and-armed for overage resume are
    // QUEUED here (entries `{text, attachments, ts}`) instead of resuming the
    // still-throttled session; the auto-resume delivers them as one combined
    // prompt when the window-reset deadline fires. Reset on (re)spawn and
    // cleared on cancel/flush. Persisted across a resume-restart.
    this._overageQueue = [];
    // Steers parked until an armed block-edge stop completes (queueSteerAfterStop).
    this._pendingSteers = [];
    // In-flight Agent-tool (subagent) tasks, keyed by task_id → tool_use_id.
    // Populated from the raw `system/task_started` event and cleared on a
    // terminal `system/task_updated` / `task_notification` (see the stdout
    // event loop in _handleStdoutLine). A backgrounded Agent call's tool_use
    // resolves immediately (`isAsync:true`), so `turn_end` can legitimately
    // fire while this is still non-empty — that's the whole point: `status`
    // stays the true process lifecycle value, while `summary().displayStatus`
    // (see below) overlays `running` for as long as this map is non-empty.
    // Reset on (re)spawn so a stale entry never survives a respawn/resume.
    this._activeAgentTasks = new Map<string, string | null>();
    // True when a `task_notification` fired mid-turn (status === 'turn') and no
    // delivery edge has consumed it yet. Mirrors the CLI's internal message
    // queue, which is unobservable on stdout — but its state is fully inferable
    // from event order. A completed task's notification reaches the model in
    // exactly one of three ways (verified against the CLI 2.1.198 queue-
    // operation records across ~150 real completions):
    //   1. Sync-delivered: the launching tool_use's held-open tool_result (the
    //      full output) lands right after the notification, in-turn. Nothing
    //      queued, nothing owed. Covers fast/foreground Agent calls AND
    //      long-running Bash promoted to a task (e.g. a full test run).
    //   2. Attached: an async (ack'd) task completes mid-turn and the model
    //      makes another tool round-trip — the CLI attaches the queued
    //      notification to that top-level tool_result. Consumed, nothing owed.
    //   3. Queued re-invocation: an async task completes with NO subsequent
    //      top-level tool_result — the notification stays queued and the CLI
    //      opens an unprompted re-invocation turn (immediately when idle, at
    //      turn_end when mid-turn). Only THIS case owes another turn.
    // Hence the flag: SET on a mid-turn task_notification, CLEARED by any
    // top-level tool_result (cases 1+2 — attach is batched, one result flushes
    // the queue), by the next idle→turn transition (case 3 — the dequeued
    // notification IS that turn's input; see _setStatus), and on (re)spawn.
    // Read by IdleSubscriptionHub: still-set at turn_end means a
    // re-invocation turn is genuinely owed, so the idle wake defers to it.
    // (Idle-time completions that get NO re-invocation turn at all are the
    // hub's idle task-drain settle path — see IdleSubscriptionHub.onEvent.)
    this._taskNotificationPending = false;
    // True when any NON-task-lifecycle event was processed while this
    // instance was idle — i.e. the current idle window is not pure background-
    // task bookkeeping. The load-bearing case: an unprompted re-invocation
    // turn announces itself with CLI-local `system/init` + `system/status`
    // lines long before its `message_start` (which waits on the API) flips
    // status to 'turn'. A background task draining inside that window must NOT
    // fire the idle task-drain wake (the opening turn's turn_end owns it), so
    // the hub refuses to arm a settle while this is set. SET at the top of the
    // _handleStdoutLine event loop for any idle-time event outside
    // TASK_LIFECYCLE_SUBTYPES; CLEARED on turn_end (a fresh idle window starts
    // clean) and on (re)spawn. Replayed history (loadHistory) bypasses
    // _handleStdoutLine entirely, so replay can never corrupt it.
    this._idleWindowDirty = false;
    // Cache-miss detection — a CROSS-TURN rule that catches partial (minority)
    // evictions the old stateless `creation>read` rule missed. Each turn is one
    // or more API requests; `message_start` carries that request's cumulative
    // usage (cache_read + cache_creation), and read ACCUMULATES across a turn's
    // tool-call iterations. Two data points drive the verdict:
    //   read_N  = this turn's FIRST request's cache_read (pre-tool-call, before
    //             the cache re-warms) — `_turnFirstReqCacheRead`.
    //   P_{N-1} = the PREVIOUS turn's LAST request's full prefix
    //             (cache_read + cache_creation) — `_prevTurnPrefix`. Captured by
    //             overwriting `_turnLastReqPrefix` on every message_start (no
    //             per-iteration array exists; the CLI result.usage is passed
    //             through verbatim by parser.ts), then latched at turn_end.
    // MISS ⇔ read_N < P_{N-1} - tolerance: this turn served less of the prefix
    // than was demonstrably cached at the end of last turn ⇒ eviction (full OR
    // partial). Warm continuation reads exactly P_{N-1} (drop 0). Tolerance
    // (the tolerance computed in _detectCacheMiss) absorbs tokenization-boundary noise.
    //   Turn 1 (no prior P) or a guard-invalidated turn (see _prefixBaselineInvalid)
    //   falls back to the stateless `creation>read` rule — which still flags a
    //   genuinely COLD prefix (cold start, expiry, resume, cold rewind).
    // GUARDS: compaction/summarization, model switch, and rewind/respawn all
    // legitimately shrink the prefix (read < P with no real eviction). Each sets
    // `_prefixBaselineInvalid`; the next turn's first request consumes it, uses
    // the fallback, and re-establishes P fresh — so the cross-turn rule never
    // false-fires on a legitimate shrink.
    // KNOWN LIMITATION: a miss on a request AFTER the first (e.g. a turn running
    // past the ~1h cache TTL so a later request evicts) is not caught — detection
    // is first-request-only. Rare; not built for.
    // Per-turn fields reset in _setStatus's into-'turn' branch and on (re)spawn;
    // `null` cache-read means "no first request seen yet this turn". `_prevTurnPrefix`
    // and `_prefixBaselineInvalid` persist across the turn boundary (NOT in those resets).
    this._turnFirstReqCacheRead = null;
    this._turnFirstReqCacheCreation = null;
    this._turnMissDetected = false;
    this._turnLastReqPrefix = null;    // running last-request prefix (read+creation) this turn
    this._turnEvicted = 0;             // P_{N-1} - read_N when a cross-turn miss fires
    this._prevTurnPrefix = null;       // P_{N-1}: prior turn's last-request full prefix
    this._prefixBaselineInvalid = false; // set by compaction/model-switch/rewind; consumed next turn
    // Post-construction fields the manager and later methods assign — declared
    // in the field block above, initialised here so they are definite from the
    // start (same falsy values the JS left as undefined).
    this._mutating = false;   // claimed synchronously by rewind/fork/prune
    this._skipUsageSeed = false; // one-shot: suppress the pre-prune ctx seed on replay
    this._spawnArgv = null;   // full launch argv, remembered for enableDebug's meta.json
    this._overageGate = null; // live global-overage gate, injected by the manager
  }

  // Live count of in-flight background Agent-tool (subagent) tasks. Read by
  // IdleSubscriptionHub to defer the idle wake until a worker's turn
  // ends with no subagents still running. Mirrors summary().activeAgentTasks
  // without building the whole summary object.
  get activeAgentTaskCount(): number { return this._activeAgentTasks.size; }

  // True when a mid-turn task_notification is still unconsumed (so a
  // re-invocation turn is owed — see the _taskNotificationPending comment).
  // Read by IdleSubscriptionHub as a second defer reason alongside
  // activeAgentTaskCount.
  get taskNotificationPending(): boolean { return this._taskNotificationPending; }

  // True when the current idle window contains non-task-lifecycle activity
  // (see the _idleWindowDirty comment). Read by IdleSubscriptionHub to refuse
  // arming an idle task-drain settle.
  get idleWindowDirty(): boolean { return this._idleWindowDirty; }

  summary(): InstanceSummary {
    // Live global-overage gate (injected by the manager at create). Surfaces the
    // paused state to the client BEFORE the first message is typed on a session
    // that hasn't queued yet. Absent (no manager wiring) ⇒ not paused.
    const gate = this._overageGate ? this._overageGate() : { active: false, resetsAt: null };
    return {
      id: this.id,
      project: this.project,
      cwd: this.cwd,
      mode: this.mode,
      effort: this.effort,
      thinking: this.thinking,
      model: this.model,
      // Server-resolved context capacity (raw tokens) or null when unknown. The
      // client renders this denominator verbatim and never derives one itself —
      // it can't, since the API reports a bare model id in message_start and a
      // substitution model's id is opaque.
      contextWindowTokens: this.contextWindowTokens,
      backend: this.backend,
      sessionId: this.sessionId,
      status: this.status,
      // Additive, display-only overlay: `status` itself is never repurposed
      // (every existing gate — composer enabled, kill/resume buttons, mode
      // select, idle subscriptions — keeps reading `status`). `displayStatus`
      // only ever overrides the literal `'idle'` value, so it can't mask a
      // crash or collide with `'turn'`.
      activeAgentTasks: this._activeAgentTasks.size,
      displayStatus: (this.status === 'idle' && this._activeAgentTasks.size > 0) ? 'running' : this.status,
      pid: this.pid,
      worktree: this.worktree
        ? {
            worktreeName: this.worktree.worktreeName,
            branch: this.worktree.branch,
            baseBranch: this.worktree.baseBranch,
            baseSha: this.worktree.baseSha,
            postWorktreeCreate: this.worktree.postWorktreeCreate ?? null,
          }
        : null,
      temp: this.temp,
      conducted: this.conducted,
      callerInstanceId: this.callerInstanceId,
      debug: this.debug,
      debugDir: this.debugDir,
      firstPrompt: this.firstPrompt,
      title: this.title,
      lastResponseAt: this.lastResponseAt,
      // Rotation tell. Pinning the public id makes a rotation invisible, which
      // removes the ONLY signal a conductor previously had that one happened — a
      // renewed or pruned worker would otherwise be indistinguishable from one
      // that had simply gone quiet. Rotation-GENERIC, not renew-specific: a
      // conductor deciding what to make of a quiet worker needs to know a prune
      // reset its context just as much as a renewal did.
      //
      // `backingSessionId` is deliberately NOT here. That absence IS the
      // enforcement of the invariant: a rotating id can never reach a conductor
      // if the one projection they all read cannot see it.
      lastRotatedAt: this.lastRotatedAt,
      rotationReason: this.rotationReason,
      segmentCount: this._segments.length,
      createdAt: this.createdAt,
      autoApprovePlan: this.autoApprovePlan,
      playbookEnforcement: this.playbookEnforcement,
      interrupting: this.interrupting,
      autoResumeAt: this.autoResumeAt,
      queuedCount: this._overageQueue.length,
      overageActive: !!gate.active,
      // Stopped for overage and deliberately left UN-ARMED (its conductor is the
      // sole driver). The composer must not offer to queue for it: prompt() refuses
      // such a send rather than stranding it behind a resume that never fires.
      overageStoppedUnarmed: !!this._overageStoppedUnarmed,
      overageResetsAt: gate.active ? gate.resetsAt : null,
    };
  }

  setAutoApprovePlan(enabled: boolean): void {
    const next = !!enabled;
    if (this.autoApprovePlan === next) return;
    this.autoApprovePlan = next;
    this.emit('status', this.summary());
  }

  // Same shape as setAutoApprovePlan: no-op on an unchanged value, otherwise
  // assign and broadcast. The broadcast is load-bearing beyond the UI — the
  // playbook gate watches the manager's 'status' stream to ledger the change,
  // so whichever surface flips the toggle gets recorded without knowing about
  // the ledger.
  setPlaybookEnforcement(mode: PlaybookEnforcement): void {
    if (this.playbookEnforcement === mode) return;
    this.playbookEnforcement = mode;
    this.emit('status', this.summary());
  }

  // Update the cached custom session title and broadcast the new
  // summary so all subscribed clients re-render the active header chip.
  // Pass null/'' to clear. Callers (the PUT route, the resume hydration
  // path) are responsible for the sidecar write; this just updates the
  // in-memory mirror.
  setTitle(title: string | null): void {
    const next = (typeof title === 'string' && title.trim()) ? title.trim() : null;
    if (this.title === next) return;
    this.title = next;
    this.emit('status', this.summary());
  }

  // Hydrate the in-memory title from the sidecar. Called after the
  // sessionId becomes known so the active header chip survives a
  // resume/respawn without the user re-typing.
  async _hydrateTitle(): Promise<void> {
    if (!this.backingSessionId) return;
    try {
      const t = await getSessionTitle(this.backingSessionId);
      if (t && this.title !== t) {
        this.title = t;
        this.emit('status', this.summary());
      }
    } catch { /* sidecar read is best-effort */ }
  }

  ringSnapshot(): Array<UiEvent & { _seq: number }> { return this.ring.toArray(); }

  // Latest live thinking-token estimate for the OPEN thinking block, or null
  // when none is streaming. The WS subscribe path re-attaches this as a
  // seq-less system/thinking_tokens event on the snapshot so a client joining
  // mid-thinking sees the current count immediately (the coalesced ring slot
  // already carries the partial thinking text).
  get liveThinkingTokens(): number | null { return this._liveThinkingTokens; }

  // The current context-size reading, or null before the first one: whichever of
  // message_start.usage / context_usage.usage landed last (see the latch in
  // _emitUi — the two are mutually exclusive per message). The WS subscribe path
  // carries this on the snapshot frame so the client can seed its UsageTracker
  // even when the tail holds no message_start — see the constructor comment for
  // why the ring can't be trusted, and note context_usage is never retained at
  // all, so for that kind this field is the only carrier.
  get lastContextUsage(): unknown { return this._lastContextUsage; }

  // Trailing slice of the ring for the WS `subscribe` snapshot — tabs no
  // longer receive the whole ring on every subscribe; older events are
  // lazy-loaded via GET /api/instances/:id/events. The window start is
  // snapped to a QUIESCENT point (no open block, no unresolved tool — see
  // snapStartToQuiescent in parser.ts): the first one inside the window when
  // present, else the nearest one below it. A non-quiescent tail start would
  // strand a half block / a result-less tool across the isolated page
  // renderer and the live view. Quiescent points are dense, so the snap
  // normally moves a few events; the worst case (one giant non-quiescent
  // span) is the whole ring, same as the old whole-turn extension. The
  // helper also enforces sub-agent group integrity — an in-tail child pulls
  // its Task head (and thus the whole group so far) into the tail, which is
  // what keeps NESTED blocks whole; a child with no head at or before it in
  // the array advances the start past that child, since an orphaned
  // child cannot be rendered (lazy paging reunites them only on a page that
  // holds the head too). INVARIANT (see EventLog.toArray): a still-open
  // thinking_delta or text_delta slot in the returned slice keeps growing its
  // `.text` in place until its block closes. Safe to serialize async — NOT
  // because wsHub is synchronous (it subscribes the socket BEFORE calling this
  // and awaits reconstructActiveTasks before sending), but because growth is
  // append-only and the client clears before replaying a snapshot
  // (public/wsRouter.js), so live frames emitted inside that window are
  // discarded in favour of the grown slot. Only unsafe to re-read a slot
  // expecting byte-stable text or to page/merge by array position rather than
  // `_seq`.
  snapshotTail(max?: number): UiEvent[] {
    const envMax = Number(process.env.ORCH_SNAPSHOT_TAIL);
    const cap = (typeof max === 'number' && Number.isInteger(max) && max > 0) ? max
      : (Number.isInteger(envMax) && envMax > 0 ? envMax : DEFAULT_SNAPSHOT_TAIL);
    const buf = this.ring.buf;
    if (buf.length <= cap) return buf.slice();
    const start = snapStartToQuiescent(buf, buf.length - cap, buf.length);
    // The snap can push all the way to the ring's end (its only tail content
    // was sub-agent children with no reachable head) — an empty tail is worse
    // than the pre-fix no-echo tail, so back off to the last quiescent cut
    // instead of returning nothing.
    if (start >= buf.length) return buf.slice(lastQuiescentAtOrBefore(buf, buf.length - cap));
    return buf.slice(start);
  }

  // Task-batch state as of `beforeSeq` — the in-flight batch that was open when
  // the snapshot tail begins. The client seeds its TaskTracker with this before
  // replaying the tail, so a batch whose TaskCreate sits below the tail still
  // shows the active panel (and completes correctly if it finishes inside the
  // tail). Reconstructed from the retained ring first (cheap); only when the
  // ring alone yields an orphan TaskUpdate (its create was evicted below the
  // ring) do we widen the scan to the jsonl archive — the same combine the lazy
  // paging path uses (buildArchive → archive.cut ++ ring). Bounded by the exact
  // bug condition so the archive read never runs on the common in-ring case.
  async reconstructActiveTasks(beforeSeq: number): Promise<TaskRecord[]> {
    const events = this.ring.buf.filter(ev => ev._seq < beforeSeq);
    const { activeAtEnd, hadOrphanUpdate } = reconstructTasks(events);
    const tb = this.ring.trimmedBefore;
    if (!hadOrphanUpdate || tb <= 0 || !this.backingSessionId) return activeAtEnd;
    // Best-effort widening: a non-ENOENT jsonl read error (EACCES/EIO/…) must
    // never abort the snapshot frame — fall back to the ring-only result the
    // pre-archive code always returned.
    try {
      const archive = await buildArchive({
        cwd: this.cwd, sessionId: this.backingSessionId,
        ring: this.ringSnapshot(), trimmedBefore: tb,
        userEchoCount: this._userEchoCount,
      });
      const combined = archive.events.slice(0, archive.cut).concat(events);
      return reconstructTasks(combined).activeAtEnd;
    } catch {
      return activeAtEnd;
    }
  }

  // Open log files for the raw CLI streams when debug mode is on. Called
  // exactly once at the top of spawn(), before any data flows. Best-effort:
  // a failure here demotes the instance to non-debug rather than blocking
  // the spawn — the user is debugging, not depending on the logs.
  _openDebugStreams(args: string[]): void {
    if (!this.debug) return;
    if (this._debugStreams) return; // idempotent — already capturing.
    try {
      const dir = path.join(
        debugBaseDir(this.project, this.worktree?.worktreeName ?? null),
        this.id,
      );
      mkdirSync(dir, { recursive: true });
      const meta = {
        instanceId: this.id,
        // The BACKING id: this bundle is for correlating against the raw CLI
        // streams and the on-disk transcript, both of which are keyed to it.
        sessionId: this.backingSessionId,
        project: this.project,
        cwd: this.cwd,
        mode: this.mode,
        effort: this.effort,
        thinking: this.thinking,
        model: this.model,
        temp: this.temp,
        worktree: this.worktree,
        spawnedAt: new Date().toISOString(),
        cliArgs: args,
      };
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
      this.debugDir = dir;
      this._debugStreams = {
        stdin:  createWriteStream(path.join(dir, 'claude-stdin.jsonl'),  { flags: 'a' }),
        stdout: createWriteStream(path.join(dir, 'claude-stdout.jsonl'), { flags: 'a' }),
        stderr: createWriteStream(path.join(dir, 'claude-stderr.log'),   { flags: 'a' }),
      };
    } catch (e) {
      // Surface but don't fail the spawn — debug is opportunistic.
      this._emitUi({ kind: 'system', subtype: 'stderr',
        data: { line: `debug-mode setup failed: ${(e as Error).message}` } });
      this.debug = false;
      this.debugDir = null;
      this._debugStreams = null;
    }
  }

  _closeDebugStreams(): void {
    if (!this._debugStreams) return;
    for (const s of Object.values(this._debugStreams)) {
      try { s.end(); } catch { /* ignore */ }
    }
    this._debugStreams = null;
  }

  _debugLog(kind: 'stdin' | 'stdout' | 'stderr', line: string): void {
    const s = this._debugStreams?.[kind];
    if (!s) return;
    try { s.write(line.endsWith('\n') ? line : line + '\n'); }
    catch { /* ignore — best-effort */ }
  }

  // Flip debug ON for an already-running instance. Future stdin/stdout/
  // stderr lines are mirrored to the central-store debug dir. Lines from
  // before the toggle are NOT recoverable — they were never tee'd. Emits a
  // status event so the UI can refresh the DEBUG pill + button label.
  // Idempotent: a second call is a no-op.
  enableDebug(): { ok: boolean; alreadyOn?: boolean; debugDir?: string | null; reason?: string } {
    if (this.debug && this._debugStreams) {
      return { ok: true, debugDir: this.debugDir, alreadyOn: true };
    }
    this.debug = true;
    this._openDebugStreams(this._spawnArgv ?? []);
    // If _openDebugStreams hit an fs error it will have reset this.debug
    // back to false — propagate that to the caller.
    if (!this.debug || !this._debugStreams) {
      return { ok: false, reason: 'failed to open debug streams' };
    }
    this.emit('status', this.summary());
    return { ok: true, debugDir: this.debugDir, alreadyOn: false };
  }

  _setStatus(next: string): void {
    if (this.status === next) return;
    this.status = next;
    // Any exit from `turn` ends an in-flight soft interrupt — the turn either
    // finished on its own (turn_end → idle) or the process died. This is also
    // what closes the "turn ends before the boundary" race BY CONSTRUCTION: the
    // turn_end branch of _handleStdoutLine runs _setStatus('idle') BEFORE it
    // emits the event, so by the time the scan reads empty on that turn_end the
    // status guard in _maybeFireArmedInterrupt already rejects the fire. No
    // armed interrupt can leak into the next turn.
    if (next !== 'turn') {
      this.interrupting = false;
      this._clearInterruptArm();
    }
    // _turnForceAborted is deliberately NOT cleared here. A turn START looked like
    // the safe point, but it is not: _onTurnEnd defers an abort's wake while a
    // subagent is live or a task notification is queued, and the CLI resolves that
    // by opening an UNPROMPTED re-invocation turn — whose start would have wiped
    // the qualifier before the wake it qualifies was ever delivered. It is cleared
    // in prompt() (a genuinely new instruction makes the old abort irrelevant) and
    // by IdleSubscriptionHub.onTurnStart on a turn start that no armed wake survived
    // into — which is the same "turn START" point, minus exactly the case above.
    // The process is gone: a parked steer can never be delivered. Reject each
    // waiter and clear the queue — leaving `steerPending` true on a dead instance
    // would wedge IdleSubscriptionHub's defer indefinitely.
    if (isDeadStatus(next) && this._pendingSteers.length) {
      const entries = this._pendingSteers.splice(0);
      this._emitUi({ kind: 'system', subtype: 'stderr',
        data: { line: `deferred steer delivery failed: instance ${next} before the stop completed` } });
      const err = new Error(`instance ${next} before the queued steer could be delivered`);
      for (const e of entries) e.reject(err);
      this._emitSteerSettled();
    }
    // A new turn is starting (the early-return above means this is a real
    // transition INTO 'turn', covering both prompt()-initiated and unprompted
    // re-invocation turns) — clear the pending task-notification flag: the CLI
    // flushes its queue into every new turn's input, so whatever was queued
    // (the re-invocation payload) is being delivered right now. Mid-turn
    // message_starts never reach here (status is already 'turn'), so agent-loop
    // steps inside a turn can't falsely clear it.
    if (next === 'turn') this._taskNotificationPending = false;
    // A new turn starts: clear the per-turn cache-miss capture so the next
    // message_start is treated as this turn's first request (see the
    // constructor comment). Fires exactly once per turn start, for both
    // prompt-initiated (prompt() → _setStatus) and unprompted (message_start
    // flips idle→turn) turns.
    if (next === 'turn') {
      this._turnFirstReqCacheRead = null;
      this._turnFirstReqCacheCreation = null;
      this._turnMissDetected = false;
      this._turnLastReqPrefix = null;
      this._turnEvicted = 0;
      // NOTE: _prevTurnPrefix and _prefixBaselineInvalid intentionally persist
      // across the turn boundary — they are cross-turn state.
      // …and this is the ARM point for the idle wake: IdleSubscriptionHub arms
      // one entry per owner here, so prompted and unprompted turns re-arm
      // identically (an auto-approved plan rolling into implementation needs no
      // conductor call) and so the arm is synchronous inside prompt() — there is
      // no window for a fast turn_end to land in.
      this.emit('turn_start');
    }
    this.emit('status', this.summary());
  }

  _emitUi(ev: UiEvent): void {
    // Track the ephemeral live thinking-token count for the OPEN thinking
    // block (the per-token thinking_tokens events are never retained — see
    // EventLog.push). Funneled here alongside userIndex so every emit path
    // (live, jsonl replay, direct) stays consistent: a fresh start clears any
    // prior value, each thinking_tokens updates it in place, and closing the
    // block (or the turn) clears it so a finished/replayed block carries no
    // stale live count. Re-attached to a fresh subscriber's snapshot (wsHub).
    if (ev.kind === 'thinking_start') {
      this._liveThinkingTokens = null;
    } else if (ev.kind === 'system' && ev.subtype === 'thinking_tokens') {
      this._liveThinkingTokens = (evData(ev)?.estimated_tokens as number | undefined) ?? null;
    } else if (ev.kind === 'thinking_end' || ev.kind === 'turn_end') {
      this._liveThinkingTokens = null;
    }
    // Same funnel, same reason (every emit path stays consistent): latch the
    // current context-size reading so a re-subscribe can seed the client's
    // UsageTracker from the snapshot frame instead of depending on a
    // message_start surviving the tail's quiescent snap. NOT cleared at
    // turn_end — the reading stays valid between turns, which is exactly the
    // window where a reload would otherwise show `ctx —`.
    // Last-wins over MEASUREMENTS only: the parser nulls out an all-zero usage
    // block (src/parser.ts), and a substitution backend's gateway sends one on
    // every frame — so a null block must leave the latch alone or the very
    // first live frame would wipe the reading loadHistory seeded from the
    // jsonl, and a reload would drop to `ctx —` while the already-subscribed
    // client still shows the number. Mirrors public/usage.js's `&& ev.usage`.
    // `context_usage` is the parser's fallback reading for a backend whose
    // message_start is all-zero (src/parser.ts); it is armed only when THAT
    // message produced no message_start reading, so the two can never fight
    // within one message. Whole-object last-wins, same as above — there is no
    // per-field merge site anywhere on this path.
    if ((ev.kind === 'message_start' || ev.kind === 'context_usage') && ev.usage) {
      this._lastContextUsage = ev.usage;
    }
    // Same funnel again: advance the live quiescence scan so an armed deferred
    // interrupt can fire at the first boundary (see _maybeFireArmedInterrupt,
    // called after the emit below).
    this._quiescence.apply(ev);
    const wrapped = { ...ev };
    // A redacted block carries no text, so once it closes its retained ring
    // slot is the ONLY place the estimate can survive — without this, a
    // re-subscribe rebuilds the block as a bare "thinking (redacted)". The
    // parser emits thinking_redacted BEFORE thinking_end, so the counter is
    // still set here. Live and re-subscribe therefore render identically.
    // Nothing to stamp on the jsonl-replay path: the CLI never persists the
    // counter frames, so the preceding replayed thinking_start has already
    // cleared this to null and the field stays absent.
    if (wrapped.kind === 'thinking_redacted' && this._liveThinkingTokens != null) {
      wrapped.estimatedTokens = this._liveThinkingTokens;
    }
    // Every outer user_echo funnels through here (live prompt(), parser
    // queued-prompt echoes, jsonl replay), so this counter matches the
    // Nth-pure-user-prompt-line semantics sessionEdit.ts truncates by.
    if (isOuterUserEcho(wrapped)) {
      wrapped.userIndex = this._userEchoCount;
      this._userEchoCount += 1;
    }
    // INVARIANT: the ring and the live feed share ONE object. Anything stamped
    // onto `wrapped` above (userIndex, estimatedTokens) must be set BEFORE this
    // point, and neither line may take a copy. The field a copy would cost is
    // `_seq`: push() assigns it to the object it receives (see EventLog.push),
    // so cloning for the ring leaves the live frame with `_seq: undefined` and
    // breaks the monotonic-`_seq` contract the `event` message relies on for
    // idempotent merge (docs/protocol.md). A stamp placed between push() and
    // emit() still reaches both — it is the same object — so only one placed
    // after emit() would miss the WS frame.
    this.ring.push(wrapped); // stamps wrapped._seq
    this.emit('event', wrapped);
    // AFTER the emit: the boundary event that makes the stream quiescent must
    // reach subscribers (and the ring) before the abort is dispatched.
    this._maybeFireArmedInterrupt();
  }

  // Track the model the CLI is actually running, live. `this.model` starts
  // as the spawn-time request but the CLI can switch models interactively
  // mid-session with no discrete event of its own — system/init (and
  // message_start) just start reporting a different id. Canonicalize the report
  // against THIS session's backend before comparing: on `claude`, the CLI
  // reports a bare id while this.model carries the catalog launch tag, so a
  // raw-string compare would false-positive on every init.
  _trackModel(rawModel: unknown): void {
    if (!rawModel) return;
    const canonical = canonicalizeModel(typeof rawModel === 'string' ? rawModel : undefined, this.backend);
    // A truthy non-string report (unreachable — the CLI always reports the
    // model id as a string) yields undefined here; drop it rather than write a
    // garbage value into this.model.
    if (!canonical) return;
    if (canonical === this.model) return;
    // A SUBSTITUTION backend's configured model is NEVER replaced by the CLI's
    // report — not even when the report looks like an unrelated model. Ignoring
    // only *lossy* reports was not enough: anything else fell through and
    // overwrote `this.model`, which for these backends IS the registry key. That
    // breaks the next resume's `<template> --model <key>`, drops the context env
    // vars, and poisons `session-backends.json` (now the authority for both the
    // id and the capacity) with a foreign model.
    //
    // Unconditional is correct rather than merely safe: live model changes are
    // already refused for these backends (`setModel` → 409 BACKEND_LOCKED), so
    // the configured exact id is authoritative by construction and the inner
    // CLI's self-report carries no information we want. Matching more report
    // shapes would only shrink the hole; this closes the class.
    //
    // Deliberately keyed on "not the identity backend" rather than on any one
    // backend id. An `=== 'ollama'` test still passes most of this suite while
    // silently reintroducing the bug for every USER-DEFINED backend — do not
    // narrow it. The `claude` path is untouched, so a genuine interactive
    // switch still fires model_changed.
    //
    // Returning here also skips `_prefixBaselineInvalid`, so if such a backend's
    // inner CLI really did switch model, the next turn reports a spurious
    // cross-turn cache miss instead of re-baselining. Accepted: that path is
    // unsupported (a live switch on these backends is refused 409
    // BACKEND_LOCKED), and a wrong cache-miss notice is strictly cheaper than a
    // corrupted registry key.
    if (this.backend !== CLAUDE_BACKEND_ID && this.model) return;
    if (this.model) {
      const from = this.model;
      this.model = canonical;
      // Capacity is a function of the model, so it must move with it — a stale
      // denominator survives as a wrong ctx% for the rest of the session.
      this._refreshModelCapabilities();
      // The cache is model-specific, so a switch legitimately shrinks/invalidates
      // the prefix; re-baseline next turn instead of flagging a cross-turn miss.
      this._prefixBaselineInvalid = true;
      this._emitUi({ kind: 'system', subtype: 'model_changed', data: { from, to: canonical } });
      // summary() carries contextWindowTokens, so the client chip follows the
      // switch without waiting for an unrelated refetch.
      this.emit('status', this.summary());
    } else {
      // No spawn-time model at all, so this is discovery of what the CLI picked
      // rather than a user-visible switch. Adopt silently: no model_changed event,
      // since nothing changed from the user's view.
      //
      // Reachable only on a RESUME whose model couldn't be recovered — no sidecar,
      // no assistant model in the jsonl yet. Every FRESH spawn now settles a model
      // before launch or refuses: both surfaces resolve a Settings → Models row, and
      // a named backend with no model is filled from a matching row or refused
      // BACKEND_MODEL_MISSING (docs/models.md → Capability tiers & roles).
      this.model = canonical;
      this._refreshModelCapabilities();
      // But DO push the summary, like the sibling branch. This is the first
      // moment the server knows the model — and therefore its capacity — for a
      // session launched with no `--model`. Without the
      // emit the client holds `contextWindowTokens: null` until some unrelated
      // refetch, so the ctx chip reads `ctx —` for the whole first turn.
      this.emit('status', this.summary());
    }
  }

  // Re-resolve capacity from the current {backend, model}, INCLUDING null.
  //
  // Every caller runs because `this.model` just changed, so an unresolvable
  // window means "we don't know this new model's capacity" — never "the old
  // number is still roughly right". Retaining it publishes the previous model's
  // window as this model's measured denominator: a Haiku session switched to an
  // out-of-catalog 1M-class id would read `ctx 95% · 190k/200k`, and the reverse
  // `ctx 30% · 300k/1M` on a session already past its real cap. Unknown must
  // render as unknown (`ctx —`), which is the whole point of the field.
  //
  // The mid-session row-deletion case is NOT handled here and does not need to
  // be: nothing recomputes while the model is unchanged, and a deletion observed
  // across a resume is covered by `carriedContextWindowTokens` in create().
  // Also re-resolves the mid-turn-steering capability: both are pure functions of
  // {backend, model}, and a live model change must move them together or a steer
  // is routed by the OLD model's rules for the rest of the session.
  _refreshModelCapabilities(): void {
    const cw = resolveContextWindowTokens({ backend: this.backend, model: this.model });
    this.contextWindowTokens = Number.isFinite(cw) ? cw : null;
    this.acceptsMidTurnSteering = resolveMidTurnSteering({ backend: this.backend, model: this.model });
  }

  async loadHistory(backingId: string): Promise<void> {
    const result = await loadPersistedTranscript({
      cwd: this.cwd, sessionId: backingId, seqHint: this.ring.nextSeq,
    });
    if (!result) {
      // ENOENT: the transcript this segment named is gone (Claude prunes its own
      // ~/.claude/projects after ~30 days). Drop it from the lineage row so the
      // chain stops pointing at a missing file. This is the ONE opportunistic
      // self-prune, and it is here because this path is async, off the hot read
      // path, and already holds the cwd — reads themselves stay write-free
      // (findSessionLocation tolerates the gap instead).
      this._kickLineageWrite(() => dropSegment(backingId));
      return; // silent no-op for the replay itself
    }
    for (const line of result.lines) {
      for (const ev of line.events) this._emitUi(ev);
    }
    if (result.lastLeafUuid) this._lastLeafUuid = result.lastLeafUuid;
    // One-shot, set by pruneSession(): the jsonl's newest assistant `usage` still
    // reports the PRE-prune context size, so seeding it would tell the user the
    // prune did nothing until the first live turn re-measures. A known-wrong
    // number is worse than none — fall back to `ctx —`. Same reasoning as the
    // `_lastContextUsage = null` in _wipeForResume.
    const skipUsageSeed = this._skipUsageSeed;
    this._skipUsageSeed = false;
    if (result.replayedCount > 0) {
      // Replay emits no `message_start` of its own, so nothing would latch
      // _lastContextUsage and a resumed/respawned/rewound session's ctx chip
      // would read `ctx —` until its first live turn. Feed the jsonl's reading
      // (loadPersistedTranscript owns the snapshot-not-a-sum argument) through
      // the one event kind that already drives the readout end to end: _emitUi
      // latches it, wsHub ships the latch as the snapshot's `lastContextUsage`
      // field, and the live frame reaches UsageTracker.apply — which is what
      // covers a rewind/respawn while a client is subscribed (the wipe nulls
      // the value and broadcasts reset_snapshot BEFORE this replay runs, so a
      // field-only fix could not reach that client).
      //
      // `replayed: true` keeps it OUT of the ring (EventLog.push declines it),
      // so it is emitted seq-less to the live feed only. Two reasons: `events[]`
      // stays free of synthetic message_starts (see docs/protocol.md's snapshot
      // entry), and it can never become the ring head after a trim and fake a
      // `history_gap` at the archive seam (message_start is quiescent —
      // parser.ts). Non-retention also keeps it invisible to ring.nextSeq, which
      // idleSubscriptions.ts arms on as its "activity since arm" marker — that
      // one is defense-in-depth, not a live hazard: this fires once inside
      // loadHistory, before any turn, so it can't land inside an arm→fire
      // window. The guard keeps it from becoming a hazard if the emit ever moves.
      //
      // `model` is deliberately omitted: UsageTracker.apply only adopts
      // ev.model when present, so leaving it out keeps the tracker falling back
      // to the instance's TAGGED model for the window denominator — which we
      // already recover durably at spawn. The jsonl reports it bare (`glm-5.2`,
      // not `glm-5.2:cloud`), so carrying it here would be a redundant second
      // source of truth for the model.
      //
      // Emitted inside this `replayedCount > 0` guard, before the divider: at
      // least one real replayed event has already reached the client, so this
      // one can't be the event that strips the conversation's empty-state
      // placeholder (its only effect on the renderer — conversation.apply has
      // no `message_start` case).
      if (result.lastAssistantUsage && !skipUsageSeed) {
        this._emitUi({
          kind: 'message_start', ...result.lastAssistantUsage,
          replayed: true, parentToolUseId: null,
        });
      }
      this._emitUi({
        kind: 'system', subtype: 'history_replayed',
        data: { sessionId: backingId, count: result.replayedCount },
      });
    }
  }

  // Async pre-spawn seam: rewrite the appended-system-prompt file (if a
  // provider is wired) and stash its path, then hand off to the synchronous
  // spawn(). Every conductor (re)launch entry point routes through here —
  // fresh spawn, resume, respawn, and rewind — so the doc is always freshly
  // composed, and the write always completes BEFORE spawn (the CLI errors at
  // arg-parse time on a missing path). A compose/write error propagates (fail
  // loud): a role-less conductor is worse than a surfaced error, and all
  // callers are async and return errors to REST/MCP.
  // Bind this session's redirection policy. Called by the manager right after
  // construction, BEFORE launch(): spawn() reads `_redirect` to decide whether
  // the injected settings hook Read and PostToolUse and remove Glob/Grep, and a
  // session launched without that surface would answer file tools from cc's own
  // disk.
  attachRedirect(redirect: SessionRedirect, placement: RedirectPlacement): void {
    this._redirect = redirect;
    this._redirectPlacement = placement;
  }

  // Re-pull the session root's config surface. Runs on every (re)launch — the
  // CLI reads CLAUDE.md, CONVENTIONS.md and `.claude/**` once at startup and
  // fires no hook for any of it, so a resume that skipped this would run against
  // whatever the system had at the last spawn. The manifest makes an unchanged
  // surface one `find` and no transfers.
  //
  // A failure is SURFACED, not fatal: the config surface is not the session, and
  // a system that is briefly unreachable should cost a warning rather than a
  // worker that cannot start. Every tool call still refuses honestly.
  async _refreshSessionRoot(): Promise<void> {
    const placement = this._redirectPlacement;
    if (!placement) return;
    try {
      const { skipped } = await composeSessionRoot(placement);
      for (const s of skipped) {
        this._emitUi({ kind: 'system', subtype: 'stderr', data: { line: `systems: session root skipped ${s.path} — ${s.reason}` } });
      }
    } catch (e) {
      this._emitUi({ kind: 'system', subtype: 'stderr', data: {
        line: `systems: could not refresh the session root from '${placement.systemId}': ${(e as Error).message}`,
      } });
    }
  }

  async launch({ resume }: { resume?: string } = {}): Promise<void> {
    // THE one mint site in the codebase. It lives here rather than in spawn()
    // because minting is async (it persists the lineage row under the store
    // lock) and must complete BEFORE the process starts and before the first
    // emit('status', summary()) inside _setStatus('spawning') — so no surface
    // can ever observe a session without its permanent public id. launch() is
    // the sole caller of spawn(), so this covers every fresh-spawn entry point.
    //
    // Distinguished STRUCTURALLY, never by id length: a fresh spawn is the one
    // with neither a resume target nor an id already in hand. The
    // `!this.backingSessionId` half is what preserves rewind's empty-prefix
    // relaunch (`launch({})` on an instance that already has ids), which
    // deliberately reuses the same id under `--session-id`.
    if (!resume && !this.backingSessionId) {
      this.backingSessionId = randomUUID();
      this.sessionId = await mintPublicId(this.backingSessionId);
      this._segments = [this.backingSessionId];
    }
    // Recompose the conductor's role doc into `.conduct/CONVENTIONS.md` before
    // the process starts, so it reflects the live convention selection. HERE and
    // not in spawn(): every (re)launch entry point — fresh spawn, resume,
    // respawn, rewind, resume-after-restart — funnels through launch(), which is
    // also the sole caller of the synchronous spawn(). A compose/write failure
    // propagates deliberately: a role-less conductor is worse than a surfaced
    // error, and every caller is async and returns errors to REST/MCP.
    if (isConductorInstance(this)) await materializeCurrentConduct();
    // The same point in the sequence, for the same reason: the config surface a
    // remote project's session prompt is built from is pulled here, before the
    // process that reads it starts.
    await this._refreshSessionRoot();
    this.spawn({ resume });
  }

  // Await every durable lineage write kicked so far, and RETHROW the first
  // failure since the last flush. A rejection means a rotation is live in memory
  // but absent from disk: after a crash the public id would resolve to the
  // PRE-rotation transcript and orphan the tail. The caller decides what to do
  // about that — this must never swallow it. The error is cleared on read so a
  // later rotation on this instance is not blamed for an older failure.
  async flushLineage(): Promise<void> {
    await this._lineageWrite;
    const err = this._lineageError;
    if (err) { this._lineageError = null; throw err; }
  }

  // Kick a durable lineage write onto the serialised chain. The `.catch` is
  // attached synchronously (so a failure can never surface as an unhandled
  // rejection) and REMEMBERS rather than swallows — flushLineage() rethrows it.
  // Remembering also keeps the chain usable: a failed write does not wedge every
  // subsequent rotation on this instance behind a permanently rejected promise.
  _kickLineageWrite(write: () => Promise<void>): void {
    this._lineageWrite = this._lineageWrite.then(write).catch((err: unknown) => {
      this._lineageError = err instanceof Error ? err : new Error(String(err));
    });
    // Register the WHOLE chain with the lineage store's read barrier, so a read
    // issued from here on waits for this write instead of serving the
    // pre-rotation row (src/sessionLineage.ts → trackLineageWrite). Registering
    // the chain rather than `write` alone is what makes one line cover both
    // kicked writers, and tracking it module-side is what keeps it holding after
    // this instance leaves `byId` — the spontaneous-exit variant, where no
    // `remove()` ever ran and the resume's live-guard is already false.
    trackLineageWrite(this._lineageWrite);
  }

  // Re-kick the CURRENT rotation's durable write. Called by
  // SessionRenewController when the first flush failed: `recordRotation` is
  // idempotent (src/sessionLineage.ts), so a re-kick either lands the missing
  // segment or no-ops on one already written.
  retryRotationWrite(): void {
    const publicId = this.sessionId;
    const backingId = this.backingSessionId;
    if (!publicId || !backingId) return;
    this._kickLineageWrite(() => recordRotation(publicId, backingId, 'renew'));
  }

  spawn({ resume }: { resume?: string } = {}): void {
    if (this.proc) throw new Error('already running');
    // A reused instance object (respawn) may carry _killing from its prior
    // teardown — clear it so this fresh launch's exit is judged on its own.
    this._killing = false;
    // Clear any overage auto-stop/resume state from a prior run — a fresh
    // process can re-trigger and any pending timer was cancelled at respawn.
    this.autoStoppedForOverage = false;
    this.autoResumeAt = null;
    this._overageResetsAt = null;
    this._overageHandled = false;
    this._overageWasStopped = false;
    this._overageWasIdleParked = false;
    this._overageResumeFiring = false;
    this._overageDroppedCallbacks = false;
    this._overageUnarmedWorkers = false;
    this._overageStoppedUnarmed = false;
    this._overageQueue = [];
    // A fresh process starts with no in-flight Agent tasks — any entries
    // from a prior run's background subagents are gone with that process.
    this._activeAgentTasks = new Map<string, string | null>();
    // Same reasoning for the live quiescence scan: a prior run's open blocks /
    // unreturned tools died with its process, so a stale non-empty state must
    // not hold the next run's first armed interrupt.
    this._quiescence = new QuiescenceScan();
    this._clearInterruptArm();
    this._turnForceAborted = false;
    this._taskNotificationPending = false;
    this._idleWindowDirty = false;
    // Per-turn cache-miss capture starts clean on every (re)spawn. Cross-turn
    // state (_prevTurnPrefix, _prefixBaselineInvalid) is NOT reset here: a
    // respawn goes through _wipeForResume, which sets _prefixBaselineInvalid so
    // the resumed session's first turn re-baselines via the fallback rule (see
    // the constructor comment).
    this._turnFirstReqCacheRead = null;
    this._turnFirstReqCacheCreation = null;
    this._turnMissDetected = false;
    this._turnLastReqPrefix = null;
    this._turnEvicted = 0;
    // Backend-agnostic launch: resolveBackendLaunch() computes ONLY command +
    // prefix (+ the backend's env) from the backend RECORD, and owns the
    // template's null-model invariant; the SAME claude args (including --model)
    // are then appended uniformly below. Also used by claudeShellEnv.ts's
    // generateBundle() and summarize.ts's generateSummary() for their own
    // throwaway one-shot spawns.
    const backendRecord = getBackend(this.backend);
    let command: string;
    let launchPrefix: string[];
    let backendEnvVars: Record<string, string>;
    try {
      // A backend removed from the registry while this instance was alive would
      // otherwise fall into resolveBackendLaunch's blank-template (identity) branch
      // — i.e. launch the real `claude` with this session's foreign model id. Refuse
      // instead; the catch below flips the instance to 'crashed' so the failure is
      // visible rather than silently billed.
      if (!backendRecord) {
        throw Object.assign(
          new Error(`backend '${this.backend}' no longer exists — re-add it in Settings → Backends`),
          { statusCode: 422, code: 'BACKEND_GONE' },
        );
      }
      ({ command, prefixArgs: launchPrefix, env: backendEnvVars } =
        resolveBackendLaunch(backendRecord, this.model, resolveClaudeBin()));
    } catch (err) {
      // Instance-specific side effect on the shared helper's invariant
      // failure — resolver + resume-guard are supposed to prevent this ever
      // firing, but a bad caller must still land in 'crashed', not silently
      // hang.
      this._setStatus('crashed');
      throw err;
    }
    // `resume` is ALREADY a backing id: every caller either resolved it
    // (_doCreate, via resolveBacking) or holds one directly (pruneSession /
    // rewind / respawn read backingSessionId). `this.sessionId` is deliberately
    // NOT touched here — the public id is pinned for the life of the session,
    // and every resume path has already set it.
    if (resume) this.backingSessionId = resume;
    // Local capture: launch() has minted one by here on a fresh spawn, and the
    // later method calls (markTemp / _hydrateTitle / getBackend) would reset
    // property narrowing — the args block below needs a non-null id.
    const backingId = this.backingSessionId;
    if (!backingId) {
      // Unreachable via launch(), which is spawn()'s only caller: it mints when
      // there is no resume target. Fail loud rather than spawn an id-less CLI.
      this._setStatus('crashed');
      throw new Error('spawn(): no backing session id — launch() must mint or resolve one first');
    }
    // Everything downstream of here — the `--resume`/`--session-id` argv below
    // and the transcript-keyed sidecar markers — is a backing-id consumer. One
    // assertion at the capture point covers all of them.
    assertBackingId(backingId, 'Instance.spawn');
    // Persist the temp marker at spawn time so it survives a SIGKILL that
    // happens before the first turn_end (where _writeSessionMetadata also
    // calls markTemp). Fire-and-forget — spawn() must stay synchronous.
    if (this.temp) markTemp(backingId).catch(() => {});
    // Persist the backend id + exact model durably (the things jsonl can't carry
    // — which backend ran it, and the full model id the inner CLI reports
    // lossily) so every resume path re-acquires them. The capacity rides along
    // as a last-known fallback for a resume after the custom-model row is
    // deleted. Runs on every spawn/resume, so a legacy model-unknown entry
    // self-heals once this.model holds a real id. Fire-and-forget for the same
    // reason as the temp marker above — spawn() is synchronous and nothing
    // downstream of this call reads the write (the only reader is
    // _doCreate's resume branch, `catch { best-effort }`), so a post-spawn
    // TEST must wait for the write (settledSessionBackend in helpers.mjs),
    // not sample it.
    if (this.backend !== CLAUDE_BACKEND_ID) {
      markSessionBackend(backingId, this.backend, this.model, this.contextWindowTokens).catch(() => {});
    }
    // Same reason as the temp marker: this is the first point a fresh spawn has
    // a sessionId to key the mode record on (the constructor runs before the id
    // exists). Every later mode change goes through _recordMode.
    this._recordMode(this.mode);
    this._hydrateTitle().catch(() => {});
    const args = [
      ...launchPrefix,
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
      '--include-hook-events',
      // Required so a mid-session `set_permission_mode bypassPermissions`
      // control_request is accepted — without it the CLI rejects the
      // switch with "session was not launched with
      // --dangerously-skip-permissions" and the plan-approve flow can't
      // leave plan mode.
      '--allow-dangerously-skip-permissions',
      '--permission-mode', cliPermissionMode(this.mode),
      // `effort` is always resolved to a concrete level by the manager's
      // _doCreate (resolveSpawnEffort never returns null); the field is
      // `string | null` only because the contract allows it.
      '--effort', this.effort as string,
      '--thinking', this.thinking,
      // PreToolUse hooks. The static `command` deny on
      // AskUserQuestion|ExitPlanMode replaces the old auto-interrupt +
      // marker-scrub plumbing. When a hookCallbackUrl is supplied, an
      // interactive `http` hook is ALSO registered for the destructive
      // tools — its behaviour at callback time depends on the
      // orchestrator-tracked mode (ask = prompt user, otherwise = allow).
      '--settings', buildSettingsJSON({
        hookCallbackUrl: this.hookCallbackUrl ?? undefined,
        redirect: this._redirect !== null,
      }),
    ];
    // Route tool-permission prompts over the stream-json control channel as
    // `can_use_tool` control_requests. THIS is what un-strips the interactive
    // tools (ExitPlanMode / EnterPlanMode / AskUserQuestion) under CLI 2.1.x:
    // a headless `-p` session serves the coordinator/agent tool profile with
    // those tools removed UNLESS the client presents as a permission consumer.
    // Verified additive to --allow-dangerously-skip-permissions above (normal
    // tools stay auto-allowed; only the interactive tools reach can_use_tool,
    // which we answer in _handleStdoutLine). Kill-switch:
    // ORCH_DISABLE_STDIO_PERMISSIONS=1 reverts to the fail-closed behavior.
    if (process.env.ORCH_DISABLE_STDIO_PERMISSIONS !== '1') {
      args.push('--permission-prompt-tool', 'stdio');
    }
    // Auto-register the orchestrator's own MCP server so any spawned
    // session can drive `mcp__code-conductor__*` tools without a prior
    // `claude mcp add` step. Disabled when ORCH_DISABLE_MCP_AUTOREGISTER=1
    // is set on the orchestrator (the URL comes through as null).
    if (this.mcpServerUrl) {
      // Bake THIS worker's own stable INSTANCE id into ?caller= so the MCP server
      // can identify it when it calls caller-dependent tools (set_idle_timeout,
      // renew_session). The instanceId (NOT the sessionId) is used deliberately,
      // though no longer for the original reason — a baked PUBLIC sessionId would
      // now stay valid, since a rotation cannot move it. What the instanceId buys
      // is that it names the PROCESS, which is what a caller-addressed tool acts
      // on, and it needs no store read to resolve. The MCP boundary translates it
      // to the caller's sessionId per request (InstanceManager.callerSessionId).
      const url = `${this.mcpServerUrl}?caller=${encodeURIComponent(this.id)}`;
      args.push('--mcp-config', buildMcpConfigJSON({ url }));
    }
    // Session-local Claude Code plugin roots (skills et al.) contributed by
    // enabled cc plugins. Repeatable flag, one per validated root; lands on the
    // claude side of a template's trailing `--` separator (same args array as
    // every other claude flag), so it's correct for every backend. Empty for the
    // common case (no plugin ships a claudePlugin surface).
    for (const dir of this.claudePluginDirs) args.push('--plugin-dir', dir);
    // Each family runs at one fixed context window, pinned via the model id
    // itself (Sonnet carries the CLI-native `[1m]` suffix; Opus/Haiku are
    // bare — see canonicalizeModel in modelVersions.ts). Strip any ambient
    // CLAUDE_CODE_DISABLE_1M_CONTEXT so a user-level export can't silently
    // downgrade our 1M Opus/Sonnet sessions to 200k. Also strip any ambient
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_CODE_MAX_CONTEXT_TOKENS
    // inherited from the conductor's own process env — only the blocks below
    // (the backend's own env, the substitution-backend native window, the
    // .conduct override) are allowed to set them, and they must run after this
    // strip so their values win.
    const spawnEnv = { ...process.env };
    delete spawnEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    delete spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    // The backend's user-configured env pairs (Settings → Backends). Applied
    // BEFORE the cc-managed context vars below so those always win — they are
    // deliberately not exposed in the Backends UI.
    Object.assign(spawnEnv, backendEnvVars);
    // SUBSTITUTION-backend sessions: honour the model's native context window so
    // the CLI auto-compacts at the real limit instead of its ~200k default.
    // AUTO_COMPACT_WINDOW alone is not enough: the CLI clamps it to
    // Math.min(modelWindow, AUTO_COMPACT_WINDOW), and its internal per-model
    // table defaults any unrecognized model (every non-Claude id) to a 200k
    // assumed window — silently capping our value back down. MAX_CONTEXT_TOKENS
    // overrides that assumed window directly for non-Claude models, so both
    // vars are set to the same raw token count. An unknown window (null) leaves
    // both unset (CLI default). These two are cc-MANAGED: implicit to every
    // substitution backend, never applied to plain `claude`.
    // Runs for both fresh spawns and every resume path (single spawn() method;
    // backend + model are recovered before this block).
    //
    // Reads the capacity resolved once at create() rather than re-resolving
    // here, so the number in the child's env is the same one summary(), the MCP
    // projection, and the ctx chip report. A mid-session registry deletion can
    // therefore no longer silently drop the env var on the next respawn.
    if (this.backend !== CLAUDE_BACKEND_ID && this.model && this.contextWindowTokens) {
      spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(this.contextWindowTokens);
      spawnEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(this.contextWindowTokens);
    }
    // Apply the compact-window override ONLY to the Conduct orchestrator session
    // (project === '.conduct'). Do NOT gate on this.conducted — that flag marks
    // MCP-spawned *worker* agents that the orchestrator spawns, which is the
    // opposite of the orchestrator session itself. This only overwrites
    // AUTO_COMPACT_WINDOW, never MAX_CONTEXT_TOKENS, so when the conductor role
    // itself runs on a substitution backend and both blocks apply, the effective window is
    // min(MAX_CONTEXT_TOKENS, AUTO_COMPACT_WINDOW) — the knob wins only when
    // it's smaller than the native window; otherwise the native window still
    // binds, same as docs/protocol.md's "remains the binding minimum".
    if (isConductorInstance(this)) {
      const cw = getConductorCompactWindow();
      if (cw.enabled) {
        spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cw.value * 1000);
      }
    }
    // SINGLE-SLOT CHANNEL — do not add an append-system-prompt flag here. The
    // conductor's role doc is delivered over the MESSAGES stream instead, as a
    // CLAUDE.md `@`-import (see conduct.ts → conductConventionsPath): a
    // translation proxy in front of a non-Anthropic backend may drop the CLI's
    // extra `system` block, and every backend here is that same CLI behind such
    // a proxy. Any future feature that wants to append system-prompt text must
    // compose into that SAME document, not reach for a flag.
    // Uniform --model append for EVERY backend (no backend check). For a
    // template that names {model} this duplicates the launch-slot --model with
    // the same value — a confirmed no-op for ollama (it consumes its own copy and
    // re-injects the tag).
    if (this.model) args.push('--model', this.model);
    if (resume) args.push('--resume', backingId);
    else args.push('--session-id', backingId);

    this._setStatus('spawning');
    this.parser.reset();
    // Remember the full launch argv so a later runtime enableDebug()
    // call can still write an accurate meta.json bundle.
    this._spawnArgv = [command, ...args];
    this._openDebugStreams(this._spawnArgv);

    this.proc = this._launcher.launch({ command, args, cwd: this.cwd, env: spawnEnv });
    this.pid = this.proc.pid ?? null;

    const outRl = readline.createInterface({ input: this.proc.stdout as NodeJS.ReadableStream, crlfDelay: Infinity });
    outRl.on('line', (line) => {
      this._debugLog('stdout', line);
      this._handleStdoutLine(line);
    });

    const errRl = readline.createInterface({ input: this.proc.stderr as NodeJS.ReadableStream, crlfDelay: Infinity });
    errRl.on('line', (line) => {
      this._debugLog('stderr', line);
      this._stderr += line + '\n';
      this._emitUi({ kind: 'system', subtype: 'stderr', data: { line } });
    });

    this.proc.on('exit', (code, signal) => this._handleExit(code as number | null, signal as NodeJS.Signals | null));
    this.proc.on('error', (err) => {
      this._emitUi({ kind: 'system', subtype: 'spawn_error', data: { message: (err as Error).message } });
      this._setStatus('crashed');
    });

    // Real claude is silent until it receives the first user message — `init`
    // arrives bundled with the first turn's response, not at startup. So we
    // can't gate "ready to accept prompts" on init. As soon as the subprocess
    // is alive and stdin is writable, we're idle. If we're resuming, replay
    // the persisted transcript into the ring buffer first so the UI shows
    // prior history alongside the new live stream.
    (async () => {
      if (resume && this.backingSessionId) {
        try { await this.loadHistory(this.backingSessionId); }
        catch (err) {
          this._emitUi({ kind: 'system', subtype: 'history_load_error', data: { message: (err as Error).message } });
        }
      }
      if (this.proc && this.proc.stdin && this.proc.stdin.writable && this.status === 'spawning') {
        this._setStatus('idle');
      }
    })();
  }

  _handleStdoutLine(line: string): void {
    const events = this.parser.handleLine(line);
    // Track the latest event uuid we've seen — used as the leaf marker we
    // append to the session jsonl so `claude --resume` from the shell can
    // discover this session in its interactive picker.
    let leafUuidThisLine: string | null = null;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        const uuid = (obj as { uuid?: unknown }).uuid;
        if (typeof uuid === 'string') leafUuidThisLine = uuid;
      }
    } catch { /* ignore */ }
    if (leafUuidThisLine) this._lastLeafUuid = leafUuidThisLine;

    for (const ev of events) {
      // The CLI's `[Request interrupted by user]` marker for a turn we are
      // DRAINING: that turn already annotates as drain_abort, and the capture
      // shows both would otherwise land for one drain. Dropped whole — a
      // suppressed annotation must not dirty the idle window either.
      if (ev.kind === 'system' && ev.subtype === 'soft_interrupted' && this._drainListener) continue;
      // Idle-window dirty tracking (see the _idleWindowDirty comment):
      // evaluated BEFORE the event's own state mutations so it reflects the
      // status the event ARRIVED under. Any idle-time event that isn't pure
      // task bookkeeping dirties the window; turn_end below starts it clean.
      if (this.status === 'idle'
          && !(ev.kind === 'system' && typeof ev.subtype === 'string' && TASK_LIFECYCLE_SUBTYPES.has(ev.subtype))) {
        this._idleWindowDirty = true;
      }
      if (ev.kind === 'system' && ev.subtype === 'init') {
        const data = evData(ev);
        const sid = data?.session_id;
        if (sid && typeof sid === 'string' && sid !== this.backingSessionId) {
          // A `/clear` rotation: the CLI minted a new session_id and has ALREADY
          // written the new transcript, so durable-before-first-use is
          // physically impossible here. In-memory truth is corrected in this
          // tick (that is what every live consumer reads) and the durable write
          // is kicked onto the chain immediately;
          // SessionRenewController awaits flushLineage() before it reseeds.
          //
          // `this.sessionId` is NOT reassigned — pinning it across this rotation
          // is the whole point of the public id.
          const publicId = this.sessionId;
          this.backingSessionId = sid;
          this._segments.push(sid);
          if (publicId) this._kickLineageWrite(() => recordRotation(publicId, sid, 'renew'));
          this._hydrateTitle().catch(() => {});
        }
        const mode = data?.permissionMode;
        if (mode && typeof mode === 'string' && VALID_MODES.has(mode)) {
          // The CLI reports its own mode value ('plan' or
          // 'bypassPermissions'). Don't clobber the orchestrator-only
          // 'ask' label when the CLI says bypassPermissions — they're
          // CLI-equivalent and we own the higher-level distinction.
          if (!(mode === 'bypassPermissions' && this.mode === 'ask')) {
            this.mode = mode;
            this._recordMode(mode);
          }
        }
        this._trackModel(data?.model);
      }
      // message_start reports the model too, and fires at the actual turn
      // boundary rather than a turn later once the next init lands.
      if (ev.kind === 'message_start') {
        if (ev.model) this._trackModel(ev.model);
        // A turn we didn't initiate (e.g. a ScheduleWakeup fire re-invoking the
        // turn internally) never went through prompt()'s _setStatus('turn').
        // message_start is the earliest turn-start signal on the stream, so flip
        // idle→turn here. Guarded to 'idle' so spawn ('spawning') and dead
        // ('crashed'/'exited') states are untouched, and so it's a no-op for
        // prompt-initiated turns (already 'turn') and mid-turn re-emits. Unlike
        // system/init, message_start doesn't fire at spawn and isn't the drain
        // window's trigger — so no spurious post-spawn turn and no fight with
        // the post-abort drain (which severs on init, before any API round-trip).
        if (this.status === 'idle') this._setStatus('turn');
        // ev.usage may be `null`: the parser nulls out an all-zero block
        // (src/parser.ts) while still emitting the event. The optional chains
        // keep reqRead/reqCreation at 0 — which is exactly what that all-zero
        // block yielded before, so cache-miss verdicts on such a backend are
        // unchanged.
        const usage = ev.usage as { cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | null | undefined;
        const reqRead = (usage?.cache_read_input_tokens as number | undefined) ?? 0;
        const reqCreation = (usage?.cache_creation_input_tokens as number | undefined) ?? 0;
        // Cross-turn cache-miss detection. The FIRST message_start of this turn
        // (the reset above/in _setStatus left `_turnFirstReqCacheRead` null)
        // decides; later message_starts only keep P (`_turnLastReqPrefix`)
        // current. A null ev.usage (all-zero block, nulled by the parser)
        // decides on 0/0 — the same values the zero block itself produced.
        if (this._turnFirstReqCacheRead === null) {
          this._turnFirstReqCacheRead = reqRead;
          this._turnFirstReqCacheCreation = reqCreation;
          // Consume the guard: a preceding compaction/model-switch/rewind (or
          // turn 1, no prior P) forces the stateless fallback and re-baselines P.
          const wasInvalid = this._prefixBaselineInvalid;
          this._prefixBaselineInvalid = false;
          const prevP = this._prevTurnPrefix;
          let miss = false;
          if (prevP === null || wasInvalid) {
            // Fallback: creation>read ⇒ a genuinely cold prefix (cold start,
            // expiry, resume, cold rewind). Warm/content-addressed hits (read≥
            // creation) are not flagged.
            miss = reqCreation > reqRead;
          } else {
            // Cross-turn: served less of the prefix than was cached at the end
            // of last turn ⇒ eviction (full or partial). Tolerance absorbs
            // tokenization-boundary noise; a warm continuation reads exactly P.
            const tolerance = Math.max(1024, Math.round(prevP * 0.01));
            if (reqRead < prevP - tolerance) {
              miss = true;
              this._turnEvicted = prevP - reqRead;
            }
          }
          if (miss && !this._turnMissDetected) {
            this._turnMissDetected = true;
            // Informational in-session notice — one per turn. Mirrors the
            // overage/rate-limit notice surface (an inline SystemBlock); no
            // server-side action, unlike overage. The cross-turn path adds
            // prevPrefix/evicted so the notice can show partial evictions.
            const data: Record<string, number> = { cacheRead: reqRead, cacheCreation: reqCreation };
            if (prevP !== null && !wasInvalid) {
              data.prevPrefix = prevP;
              data.evicted = this._turnEvicted;
            }
            this._emitUi({ kind: 'system', subtype: 'cache_miss', data });
          }
        }
        // Every message_start updates the running prefix; the turn's LAST one
        // holds the fully-accumulated P latched at turn_end for next turn.
        this._turnLastReqPrefix = reqRead + reqCreation;
      }
      // Context compaction/summarization rewrites the prefix — the CLI emits a
      // system/compacting line. Re-baseline next turn instead of flagging the
      // shrink as a cross-turn eviction.
      if (ev.kind === 'system' && ev.subtype === 'compacting') {
        this._prefixBaselineInvalid = true;
      }
      // With `--permission-prompt-tool stdio`, the CLI routes tool-permission
      // prompts to us as `can_use_tool` control_requests. The interactive tools
      // (ExitPlanMode / EnterPlanMode / AskUserQuestion) are DENIED with a
      // friendly message. The deny releases the tool call — the plan_request /
      // user_question card was already emitted from the tool-use surfaces — but
      // it does NOT reliably end the turn: the model gets an is_error tool_result
      // and wraps up only if the CLI has nothing else to do. In a conducted
      // session a wake callback already sitting in the CLI's stdin is injected
      // right after the deny and the SAME turn keeps running for as long as the
      // conductor keeps working, so an answer clicked in that window lands
      // mid-turn (Instance.prompt annotates it with MID_TURN_NOTE). Either way
      // the drive-forward path is unchanged: the conductor's wake fires on the
      // eventual turn_end, and approvals/answers are sent unconditionally rather
      // than waiting for idle. Holding the request open for an in-turn answer
      // would break that contract — no turn_end, so the conductor's wake never
      // fires. Any OTHER tool arriving here (rare —
      // --allow-dangerously-skip-permissions auto-allows normal tools, so they
      // don't reach can_use_tool) is allowed through unchanged.
      if (ev.kind === 'system' && ev.subtype === 'control_request') {
        const req = evData(ev)?.request as { subtype?: unknown; tool_name?: unknown; input?: unknown } | null | undefined;
        if (req?.subtype === 'can_use_tool') {
          const gated = req?.tool_name === 'ExitPlanMode'
            || req?.tool_name === 'EnterPlanMode'
            || req?.tool_name === 'AskUserQuestion';
          const decision = gated
            ? { behavior: 'deny', message: AWAITING_INPUT_MESSAGE }
            : { behavior: 'allow', updatedInput: req?.input };
          try {
            this._sendRaw({
              type: 'control_response',
              response: { subtype: 'success', request_id: evData(ev)?.request_id, response: decision },
            });
          } catch { /* stdin gone — CLI will time the permission out */ }
        }
      }
      if (ev.kind === 'control_response') {
        const p = this._pending.get(ev.requestId as string);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(ev.requestId as string);
          if (ev.ok) p.resolve(ev.response);
          else p.reject(new Error((ev.error as string | undefined) ?? 'control_request failed'));
        }
      }
      if (ev.kind === 'turn_end') {
        // Enrich with the cache-miss verdict + evidence BEFORE the shared
        // _emitUi(ev) below persists the event (costTracking writes these as
        // cache_miss / first_req_cache_read / first_req_cache_creation /
        // first_req_evicted).
        ev.cacheMiss = this._turnMissDetected;
        ev.firstReqCacheRead = this._turnFirstReqCacheRead ?? 0;
        ev.firstReqCacheCreation = this._turnFirstReqCacheCreation ?? 0;
        ev.firstReqEvicted = this._turnEvicted ?? 0;
        // Latch this turn's fully-accumulated prefix as P for next turn's
        // cross-turn comparison. A turn with no requests leaves P unchanged.
        if (this._turnLastReqPrefix !== null) this._prevTurnPrefix = this._turnLastReqPrefix;
        this.lastResponseAt = Date.now();
        this._setStatus('idle');
        this._idleWindowDirty = false; // fresh idle window starts clean
        // This turn's plan-file writes stop corroborating the next turn's
        // inline plans. plan_request and turn_end are distinct events in this
        // same loop and plan_request arrives first, so a same-turn write is
        // still latched when the plan above is enriched.
        this._planFiles.noteTurnBoundary();
        this._writeSessionMetadata().catch(() => {});
        // Deliver any steer parked for a block-edge stop. ONE trigger for both
        // outcomes: the armed abort landed here, or the turn finished on its own
        // before the boundary (in which case _setStatus already cleared the arm
        // and nothing ever reached the CLI). On a microtask, not inline, so this
        // turn_end reaches every subscriber — including IdleSubscriptionHub,
        // which reads `steerPending` synchronously — before prompt() flips the
        // status back to 'turn'.
        if (this._pendingSteers.length) queueMicrotask(() => this._flushPendingSteers());
      }
      // Agent-tool (subagent) task lifecycle. `task_started` fires the moment
      // the tool_use dispatches — for a backgrounded call (`run_in_background:
      // true`) its tool_result resolves immediately, so `turn_end` above can
      // fire while the task is still running. Track it here so `summary()`
      // can report `displayStatus:'running'` through that window. ONLY
      // subagent tasks are tracked: the CLI fires the same lifecycle for Bash
      // tasks (`task_type:'local_bash'` — explicit run_in_background AND any
      // foreground Bash it promotes on timeout/long runtime), and a
      // deliberately started long-lived process (a server via a promoted
      // `./start.sh`) never emits a terminal event — counting it would pin
      // displayStatus:'running' and defer the idle wake / session renewal
      // indefinitely. Unknown task_types stay tracked (same
      // over-report-running polarity as TERMINAL_TASK_STATUSES). A completed
      // Bash task that owes a re-invocation turn is still deferred correctly
      // by _taskNotificationPending, which is task-type-agnostic on purpose.
      if (ev.kind === 'system' && ev.subtype === 'task_started') {
        const data = evData(ev);
        if (data?.task_id && data.task_type !== 'local_bash') {
          const grew = this._activeAgentTasks.size === 0;
          this._activeAgentTasks.set(data.task_id as string, (data.tool_use_id as string | null | undefined) ?? null);
          if (grew) this.emit('status', this.summary());
        }
      }
      if (ev.kind === 'system' && ev.subtype === 'task_updated') {
        const data = evData(ev);
        const patchStatus = (data?.patch as { status?: unknown } | null | undefined)?.status;
        if (data?.task_id && TERMINAL_TASK_STATUSES.has(patchStatus as string)) {
          if (this._activeAgentTasks.delete(data.task_id as string) && this._activeAgentTasks.size === 0) {
            this.emit('status', this.summary());
          }
        }
      }
      // Belt-and-suspenders: task_notification always carries a terminal
      // top-level `status` (it's the human/model-facing "it's done" ping),
      // so delete unconditionally here in case task_updated was ever missed
      // for a given completion. Map.delete is a no-op if already gone.
      if (ev.kind === 'system' && ev.subtype === 'task_notification') {
        const data = evData(ev);
        if (data?.task_id) {
          // A mid-turn notification MAY owe an unprompted re-invocation turn —
          // or may be consumed in-turn (sync-delivered / attached). Assume owed
          // until a delivery edge (top-level tool_result below, or the next
          // idle→turn transition) proves otherwise — see the
          // _taskNotificationPending comment for the full protocol model. A
          // completion while idle never sets it: the CLI dequeues immediately
          // and the re-invocation turn's start would clear it anyway.
          if (this.status === 'turn') this._taskNotificationPending = true;
          if (this._activeAgentTasks.delete(data.task_id as string) && this._activeAgentTasks.size === 0) {
            this.emit('status', this.summary());
          }
        }
      }
      // Any top-level tool_result going back to the model consumes whatever
      // the CLI had queued: a sync-delivered task's own result arrives as the
      // (held-open) tool_result right after its notification, and for async
      // completions the CLI attaches ALL queued notifications to the next
      // outer tool round-trip (batched). Nested (subagent-forwarded) results
      // carry parentToolUseId and ride the subagent's own loop, not the outer
      // conversation — they must not clear the flag.
      if (ev.kind === 'tool_result' && !ev.parentToolUseId) {
        this._taskNotificationPending = false;
      }
      // Track the plan files the model wrote, so an upcoming ExitPlanMode
      // plan_request can be enriched with the file's path (and, when the tool
      // input carried no plan text, its contents). The rule lives in
      // planFile.ts — jsonl replay drives the same tracker.
      if (ev.kind === 'tool_use' && !ev.parentToolUseId) this._planFiles.noteToolUse(ev.name, ev.input);
      // Must stay above the auto-approve block and the _emitUi below: both
      // read the event after enrichment.
      if (ev.kind === 'plan_request') this._planFiles.enrich(ev);
      // Server-side auto-approve. The flag is per-instance and toggled
      // over WS; firing here (not in the client) means it works even
      // when no tab is subscribed to this instance — switching sessions
      // or backgrounding the app no longer drops the approval.
      // The event is annotated so the rendered card still shows the
      // "auto-approved" state on every subscribed client.
      let autoApproveFire = false;
      if (ev.kind === 'plan_request'
          && this.autoApprovePlan
          && this.mode === 'plan'
          && this.proc) {
        ev.autoApproved = true;
        autoApproveFire = true;
      }
      this._emitUi(ev);
      if (autoApproveFire) this._fireAutoApprovePlan();
      // Action on overage: detect the trip here, but route it centrally. The
      // Instance has no reference to the manager / idle-wake graph, so
      // it can't make a conductor-aware stop decision — it just SIGNALS the
      // manager (`overage` emit), which owns the global one-shot flag and the
      // routing (see InstanceManager._handleOverageTrip). `_overageHandled`
      // throttles re-emits within a run; it's reset at spawn() and by the
      // resume controller on cancel/skip. The trip fires on the always-on
      // `isUsingOverage` hard flag OR the optional usage threshold (any window).
      if (ev.kind === 'system' && ev.subtype === 'rate_limit_event'
          && !this._overageHandled && this._isOverageTrip(ev.data)) {
        this._overageHandled = true;
        const rateInfo = (ev.data as { rate_limit_info?: unknown } | null | undefined)?.rate_limit_info;
        const resetsAt = parseResetEpochSecs(rateInfo) ?? parseResetEpochSecs(ev.data);
        this.emit('overage', { resetsAt });
      }
    }
  }

  // True when a rate_limit_event should trip the overage auto-stop: the
  // always-on `isUsingOverage` hard flag, OR (when the optional threshold is
  // enabled) the event's `utilization` crossing the configured percentage —
  // for WHICHEVER window the event reports (no rateLimitType filtering). The
  // two triggers are independent; the hard flag fires regardless of the
  // threshold setting.
  _isOverageTrip(data: unknown): boolean {
    if (isOverageEvent(data)) return true;
    const t = getOverageThreshold();
    if (!t.enabled) return false;
    const rec = (data ?? null) as { rate_limit_info?: { utilization?: unknown } | null | undefined } | null;
    const u = rec?.rate_limit_info?.utilization;
    return typeof u === 'number' && u >= t.value / 100;
  }

  _fireAutoApprovePlan(): void {
    // Run after the current stdout line has finished dispatching so the
    // plan_request event reaches subscribers before the resulting mode
    // flip / user_echo / turn-start events do. ExitPlanMode's can_use_tool
    // request was denied in _handleStdoutLine — which ends the turn only if the
    // CLI has nothing queued behind it, so the approval can land mid-turn — and we
    // drive the model forward with setMode + an explicit approval prompt (routed
    // behind a block-edge stop on a model that cannot take a mid-turn injection);
    // same flow as a manual Approve click in the UI.
    queueMicrotask(async () => {
      try {
        if (!this.proc) return;
        if (this.mode === 'plan') await this.setMode('bypassPermissions');
        if (!this.proc) return;
        await this.promptOrQueueSteer(buildApprovePrompt(undefined));
      } catch (err) {
        this._emitUi({ kind: 'system', subtype: 'stderr',
          data: { line: `auto-approve plan failed: ${(err as Error).message}` } });
      }
    });
  }

  async _writeSessionMetadata(): Promise<void> {
    // Persist the durable temp + conducted markers BEFORE the temp early
    // return, so a temp session that survives SIGKILL recovers BOTH flags on
    // respawn (InstanceManager.create() OR-recovers them via isTemp/isConducted).
    // These only need sessionId, not the leaf uuid. The last-prompt /
    // permission-mode write below stays after the early return — it exists
    // only to surface a session in the shell-side `claude --resume` picker,
    // which temp sessions must not appear in.
    if (this.temp && this.backingSessionId) {
      try { await markTemp(this.backingSessionId); } catch { /* best effort */ }
    }
    if (this.conducted && this.backingSessionId) {
      try { await markConducted(this.backingSessionId); } catch { /* best effort */ }
    }
    if (this.temp) return;
    if (!this.backingSessionId || !this._lastLeafUuid) return;
    try {
      await writeSessionMetadata({
        cwd: this.cwd,
        sessionId: this.backingSessionId,
        leafUuid: this._lastLeafUuid,
        mode: this.mode,
      });
    } catch { /* best effort */ }
  }

  _handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.pid = null;
    this.proc = null;
    this._closeDrainWindow();
    const crashed = !(code === 0 && !signal);
    this._emitUi({ kind: 'system', subtype: 'exit', data: { code, signal } });
    // A SUBSTITUTION-backend subprocess that crashed on its own (not a commanded
    // kill) is the silent-launch-failure case: the wrapper command died — binary
    // missing, server gone, cloud-auth 401, etc. Surface it distinctly from the
    // bare `exit`, carrying the captured stderr so the reason is visible. Plain
    // claude exits and clean/commanded wrapper exits are untouched.
    if (crashed && this.backend !== CLAUDE_BACKEND_ID
        && !this._killing && !this._suppressTempDelete) {
      this._emitUi({
        kind: 'system', subtype: 'launch_failed',
        data: { code, signal, stderr: this._stderr.trim() || null },
      });
    }
    this._setStatus(crashed ? 'crashed' : 'exited');
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('subprocess exited'));
    }
    this._pending.clear();
    // Resolve any in-flight permission prompts with deny — the CLI is
    // gone, so the tool won't run anyway, but we still need to free
    // the held-open HTTP responses.
    this._hooks.discardAll();
    // And close this session's shell on the remote system. It is a process on
    // someone else's machine keyed to a session that no longer exists; nothing
    // will ever write to it again.
    void this._redirect?.close();
    this._closeDebugStreams();
    // `_suppressTempDelete` is set by the resume-restart path
    // (shutdownForResumeSync): there we SIGKILL temp subprocesses but must
    // PRESERVE their jsonl so the next boot can `--resume` them. Without the
    // guard, this exit handler would archive the transcript we're carrying,
    // which is fine for the data but still wrong — it would not be resumable.
    if (this.temp && !this._suppressTempDelete) this._archiveTempSession().catch(() => {});
  }

  // Archive a killed temp session: retain the .jsonl (stays resumable) but
  // mark it archived so it disappears from the normal session list and
  // surfaces in the — archived — section instead. The sub-agent dir is
  // still cleaned up (it is ephemeral; only the main .jsonl matters for
  // restore). Title and conducted markers are kept — they are still
  // meaningful on an archived session.
  async _archiveTempSession(): Promise<void> {
    if (!this.backingSessionId) return;
    await fsp.rm(subAgentDirPath(this.cwd, this.backingSessionId), { recursive: true, force: true });
    try { await unmarkTemp(this.backingSessionId); } catch { /* best-effort */ }
    try { await markArchived(this.backingSessionId); } catch { /* best-effort */ }
  }

  _sendRaw(obj: unknown): void {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      throw new Error('subprocess not writable');
    }
    // _sendRaw only ever receives plain JSON-serializable objects (control /
    // user envelopes), so stringify always yields a string.
    const line = JSON.stringify(obj) as string;
    this._debugLog('stdin', line);
    this.proc.stdin.write(line + '\n');
  }

  // Send a user turn to the CLI. `attachments` is an optional list of
  // {name, mediaType, dataBase64} objects produced by the composer.
  // Every attachment is saved into the central store's attachments
  // dir for this project / worktree and a single
  // "Attached file: `<abs-path>`" text block is appended to the
  // message — Claude's Read tool handles both image files (returns
  // vision content) and arbitrary file bytes on demand. This avoids
  // re-paying the base64 token cost on every subsequent turn and
  // keeps the prompt-cache prefix stable.
  async prompt(text: string, attachments: unknown[] = [], { annotateIfMidTurn = true, internal = false, midTurnNote }: { annotateIfMidTurn?: boolean; internal?: boolean; midTurnNote?: string } = {}): Promise<void> {
    // A rewind/fork/prune is rewriting this session's jsonl. The `!this.proc`
    // check below already rejects for most of that window (the subprocess is
    // killed first), but not for the sliver between the caller's idle check and
    // the kill completing — a prompt landing there is written to stdin, the CLI
    // persists a partial tail, and that tail gets folded into the rewritten file.
    // Closing the window here rather than at each call site fixes rewind too.
    // Not a new failure class for callers: they already have to tolerate the
    // 'not running' throw from the same operation, a few hundred ms later.
    if (this._mutating) {
      throw Object.assign(
        new Error('session is being rewritten (rewind/fork/prune) — retry in a moment'),
        { statusCode: 409 },
      );
    }
    if (!this.proc) throw new Error('not running');
    // An explicit new turn closes the drain window immediately so an intentional
    // follow-up prompt is never intercepted by the post-hard-abort drain logic.
    this._closeDrainWindow();
    // While the overage window is active, a genuine (user/MCP-driven) prompt must
    // NOT resume/hit the still-throttled account — it is QUEUED and delivered as
    // one combined prompt when the resume deadline fires (see
    // OverageResumeController.run). Two ways in: this session was stopped mid-turn
    // and armed (autoStoppedForOverage+autoResumeAt), OR the GLOBAL gate is active
    // (idle/never-stopped/brand-new session sending during the window). The gate
    // enforces the safety rail (only a valid FUTURE resetsAt engages it) — see
    // InstanceManager._overageGate. Return BEFORE emitting `user_prompt` so the
    // manager's resume-cancel handler never runs. `internal:true` is the WHOLE
    // condition for falling through here — no site list gates it — so this stays
    // true as senders come and go. Today's senders, as examples: the idle-wake
    // stub, the renewal reseed (sessionRenew.ts), and the auto-resume's own send
    // (which first clears these flags via cancel).
    const gate = this._overageGate ? this._overageGate() : { active: false, resetsAt: null };
    // A worker the overage stop left UN-ARMED has no resume deadline and must never
    // get one: its conductor is the sole driver, and arming it would have the
    // conductor's re-drive land mid-turn on a worker that just self-resumed. So
    // queueing here would strand the text forever — the queue is flushed only by a
    // fired deadline, and cancel() discards it. Refuse loudly instead (CONVENTIONS:
    // fail loudly, not silently). The composer stops offering to queue for such a
    // session (`overageStoppedUnarmed` on the status frame), so this is the
    // backstop, not the notice.
    if (!internal && this.overageSendRefused) {
      throw Object.assign(
        new Error(
          'this worker was stopped for account overage and is waiting on its conductor, ' +
          'not on the rate-limit window — messages cannot be queued for it. Send to the ' +
          'conductor instead, or resume this worker once the window resets.',
        ),
        { statusCode: 409 },
      );
    }
    if (!internal && (gate.active || (this.autoStoppedForOverage && this.autoResumeAt))) {
      const entry = {
        text: typeof text === 'string' ? text : '',
        attachments: Array.isArray(attachments) ? attachments : [],
        ts: Date.now(),
      };
      this._overageQueue.push(entry);
      this._emitUi({ kind: 'overage_message_queued', data: {
        text: entry.text,
        attachmentCount: entry.attachments.length,
        ts: entry.ts,
        queuedCount: this._overageQueue.length,
      } });
      // Queued-only (idle/new) session with no armed deadline yet: ask the
      // manager to arm one at the window reset NOW (there's no turn→idle
      // transition to arm on, since the session may already be idle).
      if (!this.autoResumeAt) this.emit('overage_queued', { resetsAt: gate.resetsAt });
      this.emit('status', this.summary()); // push queuedCount → badges
      return;
    }
    // A prompt cancels a pending overage auto-resume IFF it is not `internal` —
    // the flag is the whole test, and the manager's `user_prompt` handler reads
    // nothing else. `internal:true` senders today, as examples: the idle-wake stub,
    // the renewal reseed (sessionRenew.ts), and the auto-resume's own send. The
    // last is why the carve-out also has to skip the global queue intercept above:
    // it already tore down its own deadline via cancel() before sending, and the
    // global window may still be active when it fires.
    this.emit('user_prompt', { internal });
    const safeText = typeof text === 'string' ? text : '';
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!safeText.length && atts.length === 0) {
      throw new Error('prompt requires non-empty text or at least one attachment');
    }

    const content: Array<Record<string, unknown>> = [];
    const echoAttachments: unknown[] = [];
    if (safeText.length) content.push({ type: 'text', text: safeText });

    for (const a of atts) {
      if (!a || typeof a !== 'object') continue;
      const rec = a as { name?: unknown; mediaType?: unknown; dataBase64?: unknown };
      if (typeof rec.name !== 'string' || typeof rec.dataBase64 !== 'string') continue;
      const mediaType = typeof rec.mediaType === 'string' ? rec.mediaType : 'application/octet-stream';
      try {
        const saved = await saveAttachment(this.project, this.worktree?.worktreeName ?? null, { name: rec.name, dataBase64: rec.dataBase64 });
        content.push({ type: 'text', text: `Attached file: \`${saved.promptPath}\`` });
        echoAttachments.push({
          kind: isImageType(mediaType) ? 'image' : 'file',
          name: rec.name,
          mediaType,
          path: saved.promptPath,
          filename: saved.filename,
          // For the live user_echo bubble only — lets the frontend show
          // the thumbnail without a round-trip. Not written to the CLI's
          // stdin or the session jsonl. On replay/refresh the frontend
          // fetches the bytes from /api/instances/:id/attachments/<file>.
          dataBase64: isImageType(mediaType) ? rec.dataBase64 : undefined,
        });
      } catch (e) {
        this._emitUi({ kind: 'system', subtype: 'stderr', data: { line: `attachment save failed (${rec.name}): ${(e as Error).message}` } });
        continue;
      }
    }

    if (content.length === 0) {
      throw new Error('prompt requires non-empty text or at least one valid attachment');
    }

    // `@path` PRE-HYDRATION. The CLI expands a mention itself and fires no hook
    // for it — measured — so on a remote project a mentioned file that is not
    // already in the session root is simply absent from the turn. cc owns the
    // one site a prompt is written from, so it fetches them here, before the
    // text goes to stdin. Best effort: a mention that names nothing is the
    // CLI's to report, not a reason to refuse the turn.
    if (this._redirect) await this._redirect.hydrateMentions(safeText);
    // A real prompt is a genuine turn boundary — any Skill invocation still
    // awaiting its content injection is stale (see parser.ts:attachSkillLoad).
    this.parser.expirePendingSkillLoads();
    this._emitUi({ kind: 'user_echo', text: safeText, attachments: echoAttachments });
    if (this.firstPrompt == null && safeText.length) {
      this.firstPrompt = safeText.slice(0, 200);
    }
    // An explicit `midTurnNote` overrides the status test: a steer flushed after
    // a block-edge stop lands while this instance is IDLE, but the message is
    // still a mid-turn one from the sender's point of view (see
    // POST_STOP_STEER_NOTE). Either way the note rides as its OWN content block,
    // never concatenated into the text — see the prefix-safety invariant in
    // docs/architecture.md.
    const note = midTurnNote ?? ((annotateIfMidTurn && this.status === 'turn') ? MID_TURN_NOTE : null);
    if (note) content.unshift({ type: 'text', text: note });
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    // Again, after the send: the user_echo above force-resets the quiescence
    // scan, so a stop armed earlier in this turn FIRES right there and opens a
    // fresh drain window — which would then sever the very turn this prompt is
    // starting. Closing here covers that; the close at the top of prompt()
    // stands for the ordinary post-abort case.
    this._closeDrainWindow();
    // A new instruction supersedes any earlier force-abort, INCLUDING one whose
    // wake is still armed and deferred: the conductor has re-driven the worker, so
    // the wake this turn arms is a report about THIS turn. That armed-and-deferred
    // case is the one the hub's survived-a-wake check deliberately does not clear,
    // which is why this clear is not redundant with it.
    this._turnForceAborted = false;
    this._setStatus('turn');
  }

  // Drive a server-managed `/clear` on this session: send the slash command on
  // the SAME stdin path a user turn uses, which rotates the CLI's context in
  // place — a fresh BACKING id, SAME OS process/pid, and the old jsonl preserved.
  // `this.sessionId` (the public id) does NOT move; see the field declarations.
  // Deliberately bypasses prompt()'s user_echo + overage-queue intercept: this
  // is a server-internal control send, not a user turn. The rotation is picked
  // up by the system/init handler (which updates this.sessionId), and the
  // SessionRenewController reseeds the cleared session on the following
  // turn_end. See src/sessionRenew.ts.
  clearContext(): void {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) throw new Error('not running');
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/clear' }] },
      parent_tool_use_id: null,
    });
    this._setStatus('turn');
  }

  // True while a rotation is in flight. Read by IdleSubscriptionHub's defer gate
  // and by the two refusal sites that keep renew and prune mutually exclusive.
  get rotationPending(): boolean { return this._rotation !== null; }

  // True while a rewindToUserMessage/InstanceManager.respawn relaunch is in
  // flight — see the `_relaunching` field comment. Read ONLY by isSessionLive.
  get relaunching(): boolean { return this._relaunching; }

  // Which mechanism holds the window, or null. The refusal sites need the reason,
  // not just the boolean: a renewal re-arming over its own window is idempotent,
  // while a renewal arming over a PRUNE is the interleaving that must be refused.
  get rotationInFlight(): RotationMechanism | null { return this._rotation?.reason ?? null; }

  // True for the whole renewal sequence, including the reseed window `_rotation`
  // deliberately leaves open. See the field declaration.
  get renewalPending(): boolean { return this._renewing; }

  // Open / close the renewal window. Separate from beginRotation because the
  // reseed has to be inside it and the hub's defer has to be outside it.
  beginRenewal(): void { this._renewing = true; }
  endRenewal(): void { this._renewing = false; }

  // Refuse a destructive rewrite while ANY context rotation is in flight here.
  // Reads the UNION of the two flags — see the `_renewing` field declaration for
  // why one flag cannot cover both lifetimes. Shared by pruneSession and
  // rewindToUserMessage so the two cannot drift; the fork route makes the same
  // check through the `rotationPending`/`renewalPending` getters.
  _assertNoRotationInFlight(): void {
    const inFlight = this._rotation?.reason ?? (this._renewing ? 'renew' : null);
    if (!inFlight) return;
    throw Object.assign(
      new Error(`a context ${inFlight === 'prune' ? 'prune' : 'renewal'} is in progress on `
        + 'this session — retry once it completes'),
      { statusCode: 409, code: 'SESSION_ROTATING' },
    );
  }

  // Open the rotation window. Called by SessionRenewController.arm() — mid-turn,
  // when the tool is called, well before that turn ends — and at the top of
  // pruneSession's critical section. Being set BEFORE the armed turn_end can fire
  // is the whole point: it makes the hub's defer independent of listener order.
  // Idempotent for the same mechanism, so a second renew_session in one turn
  // re-arms without restarting the window.
  beginRotation(reason: RotationMechanism): void {
    if (this._rotation?.reason === reason) return;
    this._rotation = { reason, startedAt: Date.now() };
  }

  // Close the rotation window and announce it. EVERY abandonment path must reach
  // this too, or the hub's defer wedges and the heartbeat reports "did
  // NOT finish" for a rotation that merely gave up.
  //
  // `comesUpIdle` is declared by the MECHANISM, never inferred from status:
  //   - renew  → false. A reseed turn follows by construction, so the correct wake
  //              point is that turn's turn_end. Reading `this.status` here would
  //              misfire — endRotation runs while the instance is still 'idle',
  //              microseconds before prompt() flips it.
  //   - prune  → true. There is no turn at all; this event IS the wake trigger.
  // That contract is why prune's later MCP exposure needs no hub change.
  endRotation({ ok, comesUpIdle }: { ok: boolean; comesUpIdle: boolean }): void {
    const rotation = this._rotation;
    if (!rotation) return; // never begun, or already closed — idempotent
    this._rotation = null;
    if (ok) {
      this.lastRotatedAt = Date.now();
      this.rotationReason = rotation.reason;
    }
    this._emitRotationComplete(rotation.reason, ok, comesUpIdle);
  }

  // A rotation whose window is ALREADY closed has failed to produce the turn it
  // promised — a renewal reseed that never landed. `endRotation` closed the window
  // with `comesUpIdle:false` on the promise that a reseed turn was coming; when
  // that promise breaks, re-announce with `comesUpIdle:true` so a conductor
  // waiting on this worker is woken NOW. Without it the wake waits out the full
  // idle-wake heartbeat and then reports that a perfectly healthy worker
  // "did NOT finish" — the same reasoning that makes every ABANDONMENT path
  // declare comesUpIdle, applied to the one failure that happens after the window
  // has already closed. Same event the hub already consumes; no hub change.
  signalRotationTurnLost(reason: RotationMechanism): void {
    this._emitRotationComplete(reason, false, true);
  }

  private _emitRotationComplete(reason: RotationMechanism, ok: boolean, comesUpIdle: boolean): void {
    this._emitUi({
      kind: 'system', subtype: 'rotation_complete',
      data: { reason, ok, comesUpIdle },
    });
  }

  // Carry this instance's durable, sessionId-keyed state across a managed
  // `/clear` renewal and retire the abandoned pre-clear id. Called by the
  // SessionRenewController once the rotation is confirmed (this.sessionId is
  // already the NEW id; `oldSid` is the pre-clear one). Why this is needed even
  // though _writeSessionMetadata re-writes temp/conducted on the next turn_end:
  //   - it closes the window between rotation and that reseed turn_end, during
  //     which a spawn_instance({resume:newId}) would read isTemp/isConducted on
  //     the new id and get false — silently dropping the flag;
  //   - the title sidecar is carried by NO turn_end path, so without this a
  //     renewed session with a custom title loses it on a later resume/restart;
  //   - and it archives the old id (which `/clear` leaves as a stale, orphaned,
  //     non-archived row) + drops its now-stale temp marker.
  // ORDER MATTERS: mark the NEW id first, retire the old id last, so a crash
  // mid-way can never leave the new id unmarked while the old id is archived.
  // Best-effort throughout (never throws into the reseed path). Mirrors
  // _archiveTempSession for the old id: unmarkTemp + markArchived, keeping the
  // conducted/title markers — they stay meaningful on the archived row.
  async carryMarkersAcrossRenewal(oldSid: string | null): Promise<void> {
    const newSid = this.backingSessionId;
    if (!newSid || !oldSid || newSid === oldSid) return;
    try { if (this.temp) await markTemp(newSid); } catch { /* best-effort */ }
    try { if (this.conducted) await markConducted(newSid); } catch { /* best-effort */ }
    try { if (this.title) await setSessionTitle(newSid, this.title); } catch { /* best-effort */ }
    // Like the conducted/title markers, the old id KEEPS its mode record: the
    // archived row is still listed under includeArchived, and its resumes-hot
    // flag should stay accurate rather than degrade to the unrecorded default.
    try { await markSessionMode(newSid, this.mode); } catch { /* best-effort */ }
    try {
      if (this.backend !== CLAUDE_BACKEND_ID) {
        await markSessionBackend(newSid, this.backend, this.model, this.contextWindowTokens);
        await unmarkSessionBackend(oldSid);
      }
    } catch { /* best-effort */ }
    try { await unmarkTemp(oldSid); } catch { /* best-effort */ }
    try { await markArchived(oldSid); } catch { /* best-effort */ }
  }

  async _controlRequest(request: Record<string, unknown>, { timeout = 5000 }: { timeout?: number } = {}): Promise<unknown> {
    const requestId = randomUUID();
    const p = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // `timedOut` distinguishes the ONE rejection mode that does not mean "the
        // request did not land". Deleting _pending here makes a later
        // control_response unroutable, so a CLI that honours the interrupt and
        // ACKs at 6s rejects us and is then silently dropped: the outcome is
        // genuinely UNKNOWN, not negative. The other modes (an explicit
        // `ok:false` refusal, a dead-stdin throw, `subprocess exited`) do mean it
        // did not land. Interrupt's abort-qualifier rollback keys off this.
        this._pending.delete(requestId);
        reject(Object.assign(new Error('control_request timeout'), { timedOut: true }));
      }, timeout);
      this._pending.set(requestId, { resolve, reject, timer });
    });
    this._sendRaw({ type: 'control_request', request_id: requestId, request });
    return p;
  }

  // Persist the mode a resume should come back up in. Best-effort and
  // fire-and-forget, like the temp/conducted/backend markers beside it: a
  // failed write leaves the session unrecorded, which resolves to
  // DEFAULT_RESUME_MODE — the pre-store behaviour, never a wrong-and-colder
  // one. Every `this.mode` assignment after the sessionId exists routes here.
  _recordMode(mode: string): void {
    if (!this.backingSessionId) return;
    markSessionMode(this.backingSessionId, mode).catch(() => {});
  }

  async setMode(mode: string): Promise<unknown> {
    if (!VALID_MODES.has(mode)) throw new Error('invalid mode');
    await this._controlRequest({ subtype: 'set_permission_mode', mode: cliPermissionMode(mode) });
    this.mode = mode;
    this._recordMode(mode);
    this.emit('status', this.summary());
    this._writeSessionMetadata().catch(() => {});
    return this.mode;
  }

  async setModel(model: string, backend: string = CLAUDE_BACKEND_ID): Promise<unknown> {
    // Live "Change model" sends a set_model control_request to the RUNNING
    // process, whose endpoint + auth are fixed at launch time. Any switch that
    // involves a SUBSTITUTION backend on either side (including
    // substitution↔substitution) can't be done live — refuse it with a clear
    // message rather than a silently-broken switch that keeps hitting the old
    // model. Cross-backend kill+respawn is a separate, later enhancement.
    if (this.backend !== CLAUDE_BACKEND_ID || backend !== CLAUDE_BACKEND_ID) {
      throw Object.assign(
        new Error('Cannot change model live for a session on a non-Claude backend — kill and respawn on that tier.'),
        { statusCode: 409, code: 'BACKEND_LOCKED' },
      );
    }
    // A NAME-PREFIX test on purpose, not a catalog allow-list. An out-of-catalog
    // `claude-*` id is accepted so a model Anthropic ships before this build's
    // catalog learns it can still be switched to live, instead of forcing a
    // kill-and-respawn — and so this matches `spawn_instance`, which already
    // accepts such an id. Capacity is what makes that safe: an id the catalog
    // can't price resolves to null and the chip honestly reads `ctx —` (see
    // _refreshModelCapabilities). Accepting it never fabricates a denominator.
    if (!model || !familyOf(model)) throw new Error('invalid model');
    // Canonicalize the incoming pick rather than trusting the client to have
    // baked the launch tag: the tag is catalog policy and the client now sends
    // bare version ids. The backend is pinned to `claude` — the guard above
    // already refused every other case.
    const canonical = canonicalizeModel(model, CLAUDE_BACKEND_ID) as string;
    await this._controlRequest({ subtype: 'set_model', model: canonical });
    this.model = canonical;
    // Capacity moves with the model.
    this._refreshModelCapabilities();
    this.emit('status', this.summary());
    this._writeSessionMetadata().catch(() => {});
    return this.model;
  }

  // Live "Change effort" — the control protocol has NO `set_effort` subtype (the
  // CLI answers only `set_permission_mode` / `set_model` / `interrupt`), so this
  // writes `/effort <level>` on the SAME stdin path a user turn uses and lets the
  // CLI handle it locally: no model turn, a `<synthetic>` confirmation reply, zero
  // tokens. Synchronous for that reason — there is no ack to await.
  //
  // IDLE-ONLY. Mid-turn the CLI queues an incoming line and flushes it combined
  // with the next turn's input, so it would stop being a lone message and land as
  // prose instead of running as a slash command.
  //
  // Unlike setModel there is deliberately no backend guard: nothing here repoints
  // an endpoint, every backend runs the same inner CLI, and `--effort` is already
  // passed unconditionally at launch.
  //
  // No on-disk store to touch: `this.effort` is the single source every downstream
  // surface reads (summary(), the `--effort` relaunch arg, fork's createArgs, the
  // restart manifest). The debug meta.json `effort` stays put — it records what the
  // process LAUNCHED with, which is still true.
  setEffort(effort: string): string {
    // Validate before anything reaches stdin: an unknown level must never be
    // written to the CLI, where it would land as an ordinary prose message.
    if (!isKnownEffort(effort)) throw new Error('invalid effort');
    if (this.status === 'turn') {
      throw httpError(409, 'cannot change effort during a running turn — interrupt first');
    }
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) throw new Error('not running');
    // The echo is load-bearing, not cosmetic: the CLI persists this line as a
    // `type:"user"` jsonl line, which isPureUserPromptLine counts — so a missing
    // live bubble would shift every rewind/fork userMessageIndex by one.
    this._emitUi({ kind: 'user_echo', text: `/effort ${effort}` });
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] },
      parent_tool_use_id: null,
    });
    this.effort = effort;
    // Assigned BEFORE the transition so the frame _setStatus broadcasts already
    // carries the new level — no second emit needed (unlike setModel, which does
    // not move the status). The CLI's `result` for the local command flips this
    // back to idle through the ordinary turn_end path.
    this._setStatus('turn');
    return this.effort;
  }

  // Promote a temp session to a normal one: stop suppressing the
  // resume-picker metadata appends and stop the on-exit cleanup of
  // the jsonl. The jsonl itself was already being written by the CLI
  // — only the orchestrator's bookkeeping was opting out.
  async promoteToNormal(): Promise<InstanceSummary> {
    if (!this.temp) throw httpError(400, 'instance is not temp');
    this.temp = false;
    try { if (this.backingSessionId) await unmarkTemp(this.backingSessionId); } catch { /* best-effort */ }
    // Persist last-prompt + permission-mode now, so the standalone
    // `claude --resume` picker sees this session immediately — without
    // waiting for the next turn-end / setMode cycle to trigger it.
    await this._writeSessionMetadata().catch(() => {});
    this.emit('status', this.summary());
    return this.summary();
  }

  // Thin delegate so callers (routes.ts / wsHub.ts) keep talking to
  // the Instance — the broker holds the actual state.
  handleHookCallback(envelope: unknown, res: Response): void { this._hooks.handle(envelope as HookEnvelope | null | undefined, res); }
  resolveHookCallback(toolUseId: unknown, allow: boolean): boolean { return this._hooks.resolve(toolUseId, allow); }

  // Two-tier interrupt, both tiers a real `control_request subtype:interrupt` —
  // they differ only in WHEN it fires. FORCED (`force:true`) fires now, severing
  // the turn and discarding whatever was in progress. SOFT (default) ARMS a
  // DEFERRED interrupt: nothing goes to the CLI until the stream reaches its
  // first quiescent point (no block mid-stream, every dispatched tool returned),
  // so partial output and finished tool work survive and the model is never
  // asked to acknowledge anything — no extra request/response round-trip is
  // paid. `interrupting:true` therefore means ARMED, not stopped.
  async interrupt({ force = false, deadlineMs = 0 }: { force?: boolean; deadlineMs?: number } = {}): Promise<void> {
    if (this.status !== 'turn') return;
    if (force) {
      // Also disarms any pending deferred fire: the abort is happening now, so a
      // later boundary must not send a second control_request.
      this._interruptFired = true;
      // Set BEFORE the await, and rolled back if the abort is never confirmed.
      // Before is forced by ordering: the CLI's control_response ACK and the
      // abort's own `result` can arrive in the SAME stdout chunk, and stdout lines
      // are handled synchronously in a loop — so turn_end can be processed before
      // the microtask resuming this await ever runs. Setting it afterwards left
      // that turn_end reading `false` and reporting a killed turn as finished.
      // The rollback is what makes set-before safe: a flag latched on an abort
      // that never landed would tell every owner their finished work had been
      // discarded, inviting them to re-drive it.
      //
      // But it rolls back ONLY on the modes that mean "it did not land" — an
      // explicit refusal, dead stdin, `subprocess exited`. A TIMEOUT means the
      // outcome is unknown (the 5s timer deletes _pending, so a CLI that honours
      // the interrupt and ACKs late is dropped), and the two error directions are
      // not symmetric: a false INTERRUPTED costs a conductor some re-driving of
      // good work, while a false "finished its turn" hands it partial output as a
      // complete result — the failure this whole variant exists to prevent. On an
      // unknown outcome the honest report is the pessimistic one, and the cost is
      // bounded to exactly the one turn in doubt: the next turn start finds no
      // surviving wake and clears the flag, so it never reaches a later turn.
      this._turnForceAborted = true;
      try {
        await this._controlRequest({ subtype: 'interrupt' });
      } catch (e) {
        if (!(e as { timedOut?: boolean })?.timedOut) this._turnForceAborted = false;
        throw e;
      }
      this._releaseParkedPermissions();
      // Open the drain window synchronously in the same microtask as the ACK.
      // Any system/init that follows (the CLI dequeuing its leftover input queue)
      // will be caught before the spurious API round-trip begins. Opening here
      // (not before the await) is safe because the CLI emits system/init only
      // AFTER the result/interrupted events that follow the control_response ACK.
      this._openDrainWindow();
      return;
    }
    // Idempotent: one arm per turn (escalate an already-armed turn with force).
    if (this.interrupting) return;
    this.interrupting = true;
    this._interruptArmed = true;
    // Snapshot BEFORE the fire attempt: "a boundary crossed since the arm" is
    // measured from here (see _maybeFireArmedInterrupt).
    this._interruptArmSeq = this._quiescence.boundarySeq;
    if (deadlineMs > 0) this._armInterruptDeadline(deadlineMs);
    this.emit('status', this.summary());
    this._maybeFireArmedInterrupt(); // fires right here if already quiescent
  }

  // Clear every piece of arm state as one unit — the two flags, the arm-time
  // boundary snapshot, and the deadline timer. Called from every place an arm
  // ends: exit from `turn`, a (re)spawn, a resume wipe, and a failed fire.
  _clearInterruptArm(): void {
    this._interruptArmed = false;
    this._interruptFired = false;
    this._interruptArmSeq = 0;
    if (this._interruptDeadline) { clearTimeout(this._interruptDeadline); this._interruptDeadline = null; }
  }

  // The bounded terminal outcome (see SOFT_INTERRUPT_DEADLINE_MS). On expiry the
  // arm is still undischarged, so escalate to the FORCED tier — and annotate
  // first, naming exactly what withheld the boundary (the held block keys and
  // unreturned toolUseIds), so the next report is a one-line diagnosis instead
  // of a silent run-to-completion.
  _armInterruptDeadline(deadlineMs: number): void {
    if (this._interruptDeadline) clearTimeout(this._interruptDeadline);
    this._interruptDeadline = setTimeout(() => {
      this._interruptDeadline = null;
      // Fired already ⇒ the request DID leave; an ACKed-but-not-honoured stop is
      // a different defect with a different flag (card 2026-0207), not this one.
      if (!this._interruptArmed || this._interruptFired) return;
      if (this.status !== 'turn' || !this.proc) return;
      const blocks = [...this._quiescence.openBlocks.keys()];
      const tools = [...this._quiescence.pendingTools];
      this._emitUi({ kind: 'system', subtype: 'stderr', data: { line:
        `interrupt deadline (${deadlineMs}ms) elapsed with the stop undelivered — forcing. `
        + `blocks still open: [${blocks.join(', ')}]; tools still unreturned: [${tools.join(', ')}]` } });
      this.interrupt({ force: true }).catch(() => {});
    }, deadlineMs);
    // Never hold the event loop open for a stop that is only a backstop.
    this._interruptDeadline.unref?.();
  }

  // True while a tool sits at an unanswered ask-mode permission card. Such a
  // tool has NOT started, so there is no work to preserve — without this the
  // armed interrupt would wait on a `pendingTools` entry that only a human can
  // clear. No timer and no max-defer knob: a genuinely wedged tool is what the
  // forced tier is for.
  _blockedOnPermission(): boolean { return this._hooks.pendingCount > 0; }

  // The armed abort's boundary test. Two clauses, and they are NOT symmetric:
  //
  //   pendingTools empty  — STRICT. A dispatched tool must have returned its
  //     result; nothing retires a span but its own tool_result or a turn
  //     boundary (parser.ts). This is what keeps finished tool work from being
  //     discarded, and it is why S1/S2/S3/D hold indefinitely rather than firing.
  //   openBlocks empty OR a boundary crossed since the arm — the added path. On
  //     a well-formed stream a block's close is its own event, so `empty` reads
  //     true there and this reduces to exactly today's behaviour. On a stream
  //     whose closes never arrive, the block is retired by the NEXT block's key
  //     — the same event that opens that next block, so `empty` never reads
  //     true and only the counter can see it. Cost: the abort lands one block
  //     late instead of never.
  _atInterruptBoundary(): boolean {
    const q = this._quiescence;
    if (q.pendingTools.size > 0) return false;
    return q.openBlocks.size === 0 || q.boundarySeq > this._interruptArmSeq;
  }

  // Called once an interrupt has been ACKED: the turn is severed, so a tool
  // still parked at a permission card will never run. Deny it — freeing the
  // held-open hook HTTP response and resolving the UI card — instead of leaving
  // both hanging until HOOK_PENDING_TIMEOUT_MS (9 min). Scoped by construction
  // to the aborted turn: a pending decision only exists for a tool_use the CLI
  // was about to dispatch in it.
  //
  // ONLY after the ACK, never before the request: a deny released first comes
  // back as an error tool_result, and the CLI's agent loop would spend exactly
  // the extra model round-trip this whole path exists to avoid.
  _releaseParkedPermissions(): void {
    this._hooks.discardAll('turn interrupted before the tool ran', 'interrupted');
  }

  // Fire an armed deferred interrupt if the stream is at a boundary. Called
  // from interrupt() (covers arming into an existing gap) and from the tail of
  // _emitUi (covers every later event). Deliberately synchronous inside the
  // stdout handler — same precedent as the drain listener — and NOT deferred to
  // a microtask, which would drain only after the whole readline chunk and could
  // let another tool dispatch first.
  _maybeFireArmedInterrupt(): void {
    if (!this._interruptArmed || this._interruptFired) return;
    if (this.status !== 'turn' || !this.proc) return;
    if (!this._atInterruptBoundary() && !this._blockedOnPermission()) return;
    this._interruptFired = true;
    this._controlRequest({ subtype: 'interrupt' }).then(
      () => this._releaseParkedPermissions(),
      (e: Error) => {
        // Timed out or the process died mid-flight. Disarm so the UI never
        // sticks on "stopping…" with nothing coming, and clear _interruptFired
        // too: the abort never landed, so this turn must stay RE-ARMABLE (a
        // second ⏸ has to be able to try again). Both flags are cleared BEFORE
        // the annotation is emitted — _emitUi's tail re-runs this method, and an
        // armed-and-unfired state there would spin failed retries.
        this.interrupting = false;
        this._clearInterruptArm();
        this._emitUi({ kind: 'system', subtype: 'stderr',
          data: { line: `interrupt failed: ${e.message}` } });
        this.emit('status', this.summary());
      },
    );
    this._openDrainWindow();
  }

  // True while at least one steer is parked waiting for a block-edge stop. Read
  // by IdleSubscriptionHub: the turn_end an armed stop produces must not consume
  // an armed idle wake (the worker was cut off, it did not finish), and
  // a deferred wake must not race the steer's own prompt().
  get steerPending(): boolean { return this._pendingSteers.length > 0; }

  // True when a send to this session would be neither deliverable (the account is
  // still throttled) nor queueable: the overage stop left it UN-ARMED, so it has no
  // resume deadline, and the queue is flushed only by a fired deadline while
  // cancel() discards it. THE ONE PLACE this is tested — prompt() throws on it and
  // the MCP handlers turn it into a soft `OVERAGE_STOPPED_UNARMED` refusal.
  // Read by IdleSubscriptionHub on every wake-consuming path — see _turnForceAborted.
  get turnForceAborted(): boolean { return this._turnForceAborted; }

  // Read-and-clear, called by IdleSubscriptionHub.onTurnStart when NO armed wake
  // survived into this turn — i.e. nothing is left that the qualifier could
  // describe. That is the hub's single home for the qualifier's lifetime; the only
  // other clear is in prompt(), for the case a wake DID survive but a new
  // instruction superseded the abort anyway.
  consumeTurnForceAborted(): boolean {
    const was = this._turnForceAborted;
    this._turnForceAborted = false;
    return was;
  }

  get overageSendRefused(): boolean {
    if (!this._overageStoppedUnarmed) return false;
    return !!(this._overageGate ? this._overageGate().active : false);
  }

  // True when a user message sent right now would be injected into a running turn
  // on a model that silently drops it. THE ONE PLACE the {status, flag} pair is
  // tested — every injection site reads this rather than spelling it again.
  // `=== false` is the opt-out polarity used everywhere this flag is read: only an
  // explicit declaration diverts, anything unknown keeps the live send.
  get needsPostStopSteer(): boolean {
    return this.status === 'turn' && this.acceptsMidTurnSteering === false;
  }

  // Send `text` by whichever route this model can actually receive. Which route ran
  // is deliberately NOT on the RESULT SHAPE: on both routes the send is pending
  // until the answering turn, so a caller has nothing to branch on, and reporting it
  // would leak the delivery mechanism into the contract. The routes ARE
  // transcript-distinguishable — prompt() emits `user_echo` synchronously, a parked
  // steer only at the block edge — which is why conventions/conductor/core.md tells
  // a conductor that a send it cannot yet see has not failed. Never waits
  // for a block edge: a parked steer resolves as soon as it is queued, because the
  // stop is unbounded and every caller here is answering a request that must return
  // promptly (the WS ack times out in 10s). A parked delivery that fails is
  // annotated into the session's own transcript by _flushPendingSteers.
  //
  // NOT async, and the live branch returns prompt()'s OWN promise rather than a
  // wrapper: callers must be able to await the send and run in the SAME microtask
  // its completion lands in: the idle wake ARMS inside prompt() → _setStatus, so a
  // caller that resumed a tick later could not observe the turn it just started.
  promptOrQueueSteer(text: string, attachments: unknown[] = []): Promise<void> {
    if (this.needsPostStopSteer) {
      void this.queueSteerAfterStop(text, { attachments }).catch(() => {});
      return Promise.resolve();
    }
    return this.prompt(text, attachments);
  }

  // Deliver `text` to a model that cannot take a mid-turn injection: stop the
  // running turn at the next block edge (the SOFT tier — completed work and
  // finished tool results survive, no dangling tool_use), then send the text as a
  // fresh turn carrying POST_STOP_STEER_NOTE. Resolves once the text has actually
  // reached the CLI; rejects if it never can (the process died first).
  //
  // Off-turn this is just a prompt on the next microtask — interrupt() no-ops
  // when the status is not 'turn', so nothing else would ever wake the queue.
  // Coalescing is free: interrupt() is idempotent while armed, so N queued steers
  // arm exactly ONE abort and are delivered as one joined message.
  //
  // Every mid-turn injection site routes here on a model that needs it, through
  // promptOrQueueSteer.
  async queueSteerAfterStop(text: string, opts: { attachments?: unknown[] } = {}): Promise<void> {
    const entry: PendingSteer = { text, attachments: opts.attachments, resolve: () => {}, reject: () => {} };
    const p = new Promise<void>((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    this._pendingSteers.push(entry);
    if (this.status !== 'turn') queueMicrotask(() => this._flushPendingSteers());
    else await this.interrupt();
    return p;
  }

  // Send every parked steer as ONE fresh turn. Called from the turn_end branch
  // (the stop landed, or the turn ended on its own first — one path for both) and
  // from queueSteerAfterStop when there was no turn to stop.
  _flushPendingSteers(): void {
    if (!this._pendingSteers.length) return;
    // Drained BEFORE any await, so a second trigger in the same window delivers
    // nothing twice.
    const entries = this._pendingSteers.splice(0);
    const atts = entries.flatMap(e => Array.isArray(e.attachments) ? e.attachments : []);
    this.prompt(entries.map(e => e.text).join('\n\n'), atts, { midTurnNote: POST_STOP_STEER_NOTE }).then(
      () => {
        for (const e of entries) e.resolve();
        // prompt() can return WITHOUT starting a turn (the overage queue
        // intercept), so no turn_end is coming to flush a wake deferred behind
        // this steer. Say so rather than let it strand.
        if (this.status !== 'turn') this._emitSteerSettled();
      },
      (err: Error) => {
        this._emitUi({ kind: 'system', subtype: 'stderr',
          data: { line: `deferred steer delivery failed: ${err.message}` } });
        for (const e of entries) e.reject(err);
        this._emitSteerSettled();
      },
    );
  }

  // Announce that the steer queue drained without a turn to end. IdleSubscriptionHub
  // treats this exactly like the turn_end it was waiting for, so a wake deferred
  // behind a steer is never stranded by a failed or overage-queued delivery.
  _emitSteerSettled(): void {
    this._emitUi({ kind: 'system', subtype: 'steer_settled', data: { pending: this._pendingSteers.length } });
  }

  // Open a drain window after a hard abort. Attaches a one-time-per-event
  // listener on 'event' that watches for system/init — the earliest signal
  // that the CLI has dequeued a leftover message and started a spurious new
  // turn. On each hit, fires _controlRequest interrupt immediately (before
  // the API round-trip) and slides the window deadline so a queue of N
  // messages is fully drained. Closes automatically when the window elapses
  // with no new turn-start, or earlier when an explicit prompt() is called.
  _openDrainWindow(): void {
    this._closeDrainWindow(); // cancel any prior window
    let drainCount = 0;

    const onEvent = (ev: UiEvent): void => {
      if (ev.kind !== 'system' || ev.subtype !== 'init') return;
      if (drainCount >= POST_ABORT_DRAIN_MAX) {
        console.error(
          `[code-conductor] post-abort drain safety cap (${POST_ABORT_DRAIN_MAX}) reached on instance ${this.id} — closing window`,
        );
        this._closeDrainWindow();
        return;
      }
      drainCount += 1;
      this._emitUi({ kind: 'system', subtype: 'drain_abort', data: { count: drainCount } });
      // Slide the window: another queued message could follow, extend deadline.
      // _drainTimer is always set by the time an event can fire (the listener
      // is attached before the initial timer below), so the guard is type-level.
      if (this._drainTimer) clearTimeout(this._drainTimer);
      this._drainTimer = setTimeout(() => this._closeDrainWindow(), POST_ABORT_DRAIN_WINDOW_MS);
      this._drainTimer.unref?.();
      // Kill the spurious turn immediately, before any API round-trip.
      this._controlRequest({ subtype: 'interrupt' }).catch(() => {});
    };

    this._drainListener = onEvent;
    this.on('event', onEvent);

    this._drainTimer = setTimeout(() => this._closeDrainWindow(), POST_ABORT_DRAIN_WINDOW_MS);
    this._drainTimer.unref?.(); // don't keep the process alive for the window alone
  }

  _closeDrainWindow(): void {
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null; }
    if (this._drainListener) { this.off('event', this._drainListener); this._drainListener = null; }
  }

  async kill({ graceMs = 2000 }: { graceMs?: number } = {}): Promise<void> {
    if (!this.proc) return;
    // Mark this as a commanded teardown so _handleExit doesn't mistake the
    // resulting signalled exit for a spontaneous launch crash.
    this._killing = true;
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      let done = false;
      const onExit = () => { if (!done) { done = true; resolve(); } };
      proc.once('exit', onExit);
      const t1 = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, graceMs);
      const t2 = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, graceMs + 3000);
      proc.once('exit', () => { clearTimeout(t1); clearTimeout(t2); });
    });
  }

  // Rewind this session to before the Nth user prompt (0-indexed). Kills
  // the live subprocess, truncates the persisted jsonl, wipes the in-memory
  // ring buffer, broadcasts a `snapshot_reset` so subscribed clients clear
  // their conversation view, then respawns with `--resume <sessionId>` so
  // the freshly-truncated history is replayed into the ring.
  //
  // Returns { droppedText }: the prompt text of the dropped user message,
  // so the frontend can prefill it back into the composer.
  async rewindToUserMessage(userMessageIndex: number): Promise<{ droppedText: string }> {
    // Same interlock as pruneSession, for the same reason: a rewind kills the proc
    // and rewrites the transcript, so one landing inside a renewal's reseed window
    // makes the reseed 409 and loses the handoff summary.
    this._assertNoRotationInFlight();
    if (this._mutating) {
      throw httpError(409, 'another rewind/fork is in progress');
    }
    const backingId = this.backingSessionId;
    if (!backingId) {
      throw httpError(400, 'no sessionId — instance has not yet received a turn');
    }
    if (this.status === 'turn') {
      throw httpError(409, 'cannot rewind during a running turn — interrupt first');
    }
    this._mutating = true;
    // Marks the kill→relaunch window for isSessionLive — see the
    // `_relaunching` field comment. Deliberately NOT beginRotation: this is
    // not a `renew`/`prune` rotation (no reason string, no rotation_complete
    // event, no interaction with _assertNoRotationInFlight's messaging).
    this._relaunching = true;
    try {
      // Kill the subprocess first so the CLI can't flush a stale tail
      // into the jsonl mid-truncate. Suppress the temp-archive-on-exit
      // behavior in _handleExit — a rewind respawns right after, so a temp
      // session must stay live and temp, not get archived out from under it.
      if (this.proc) {
        this._suppressTempDelete = true;
        try { await this.kill({ graceMs: 300 }); }
        finally { this._suppressTempDelete = false; }
      }

      const result = await truncateSessionAtUserMessage({
        cwd: this.cwd,
        sessionId: backingId,
        userMessageIndex,
        mode: this.mode,
      });

      // Wipe in-memory state and tell subscribers to drop their conversation
      // DOM. `droppedText` rides on the broadcast frame so the client can
      // prefill the composer without racing the rewind HTTP response.
      this._wipeForResume({ droppedText: result.droppedText });

      // Empty prefix (rewound to the first user message): the jsonl now has
      // zero lines, so `--resume <sid>` would point the CLI at a file with
      // no init line and the subprocess would exit immediately. Delete the
      // empty file (plus any stale sub-agent dir from the dropped tail) and
      // respawn with --session-id under the same id so the URL anchor stays
      // valid and the instance comes back ready for a fresh first turn.
      if (result.remainingLineCount === 0) {
        await fsp.rm(sessionFilePath(this.cwd, backingId), { force: true });
        await fsp.rm(subAgentDirPath(this.cwd, backingId), { recursive: true, force: true });
        await this.launch({});
      } else {
        await this.launch({ resume: backingId });
      }

      return { droppedText: result.droppedText };
    } finally {
      this._mutating = false;
      this._relaunching = false;
    }
  }

  // Fork this session at the Nth user prompt (0-indexed): copy the prefix into a
  // fresh sessionId, leaving THIS session untouched. Returns the new sessionId, the
  // dropped prompt text, and the create() argument list the caller must spawn the
  // fork with — every one of those fields is read off THIS instance, so deriving
  // them belongs here and not in the route. The spawn itself stays with the caller:
  // an Instance holds no manager reference.
  async forkAtUserMessage(userMessageIndex: number): Promise<{
    newSessionId: string; droppedText: string; createArgs: CreateInstanceInput;
  }> {
    if (this.temp) throw httpError(400, 'temp sessions cannot be forked');
    // A rewind/prune on the SAME instance rewrites (or truncates) the very
    // jsonl this fork is about to read. Refuse rather than read a file
    // mid-rewrite — the mirror of the `_mutating` check those two already do.
    //
    // Claim the flag SYNCHRONOUSLY with the check: no await may sit between
    // them, or two concurrent forks both pass the check, both set the flag,
    // and the first one's `finally` clears it while the second is still
    // reading — reintroducing exactly the unprotected read this guards.
    // Narrower exposure than rewind/prune — fork never kills the source and
    // holds `_mutating` only for its READ — but a reseed landing inside that
    // read still 409s in prompt() and loses the handoff summary, so it takes
    // the same interlock. Via the SHARED method, not a local re-check of the
    // same two flags: that method exists so these guards cannot drift, and a
    // third condition added to it must reach fork too. Synchronous, and ahead
    // of the claim below.
    this._assertNoRotationInFlight();
    if (this._mutating) {
      throw httpError(409, 'another rewind/fork/prune is in progress');
    }
    const backingId = this.backingSessionId;
    if (!backingId) {
      throw httpError(400, 'no sessionId — instance has not yet received a turn');
    }
    this._mutating = true;
    // Unlike rewind/prune, fork never kills the source subprocess, so
    // `!this.proc` doesn't cover it: a prompt landing here would be written
    // to stdin, the CLI would persist its tail, and that tail could be
    // folded into the prefix being copied. `_mutating` makes prompt() refuse
    // for the duration. Scoped to the READ only — once the copy is on disk,
    // a prompt to the source can no longer affect the fork, so the create()
    // the caller makes (which spawns a whole new instance) stays outside the window.
    let forked: { newSessionId: string; droppedText: string };
    try {
      // Deferred import — keeps this module's eager import graph off
      // sessionEdit for callers that never fork. Inside the try so the flag is
      // released if it throws.
      const { forkSessionAtUserMessage } = await import('./sessionEdit.ts');
      forked = await forkSessionAtUserMessage({
        cwd: this.cwd,
        sessionId: backingId,
        userMessageIndex,
        mode: this.mode,
      });
    } finally {
      this._mutating = false;
    }
    return {
      newSessionId: forked.newSessionId,
      droppedText: forked.droppedText,
      // `backend` is REQUIRED here, not optional: forkSessionAtUserMessage
      // copies the jsonl but writes no backend sidecar for the new sessionId,
      // so create()'s sidecar recovery finds nothing. Omitting it silently
      // falls back to the identity `claude` backend while this.model keeps the
      // substitution backend's foreign model id — and because that model is
      // non-null, the BACKEND_MODEL_MISSING guard never fires, so the fork
      // launches a real `claude --model <foreign-id>` against the Anthropic
      // account. contextWindowTokens rides along as the last-known fallback.
      createArgs: {
        project: this.project,
        resume: forked.newSessionId,
        mode: this.mode,
        effort: this.effort,
        thinking: this.thinking,
        backend: this.backend,
        model: this.model,
        contextWindowTokens: this.contextWindowTokens,
        worktree: this.worktree?.worktreeName ?? null,
        prefill: forked.droppedText,
      },
    };
  }

  // Prune this session's context: write a stubbed COPY of the jsonl under a
  // fresh BACKING id, then respawn this SAME instance against it. Mechanically a
  // cousin of rewindToUserMessage (kill → rewrite → wipe → relaunch), but it
  // rotates the backing id like renew_session does, so it borrows that path's
  // marker carry + auto-archive of the abandoned id.
  //
  // Two divergences from renew_session, both deliberate:
  //   - renewal's `/clear` rotates IN PLACE inside the live process; a prune has
  //     to respawn, because the CLI only re-reads a transcript at launch.
  //   - renewal reseeds the cleared session with a summary as its first user
  //     turn, which auto-starts a turn. A pruned session must come up IDLE, so
  //     nothing here calls prompt().
  //
  // The instanceId AND the public sessionId are both preserved (only the backing
  // id rotates), so the idle-wake graph, overage timers, the renew
  // controller, every `?caller=<instanceId>` MCP handle and every id a conductor
  // holds stay valid with no migration.
  async pruneSession({ cutTurnIndex, keepLatestTurns, pruneThinking = false, inputMode = 'truncate' }: { cutTurnIndex?: unknown; keepLatestTurns?: unknown; pruneThinking?: unknown; inputMode?: unknown } = {}): Promise<Record<string, unknown>> {
    // THE interlock (decision D6). A prune sets `_mutating`, which makes prompt()
    // 409 — and a renewal's reseed IS a prompt(). Interleaving them would clear the
    // context and then lose the summary. Refuse instead of auditing interleavings
    // after the fact. Checked before the `_mutating` guard so the more specific
    // reason wins. This is the REST/internal path, so a throw is the convention
    // here (matching BACKEND_LOCKED in setModel).
    this._assertNoRotationInFlight();
    if (this._mutating) {
      throw httpError(409, 'another rewind/fork/prune is in progress');
    }
    const backingId = this.backingSessionId;
    if (!backingId) {
      throw httpError(400, 'no sessionId — instance has not yet received a turn');
    }
    if (this.status === 'turn') {
      throw httpError(409, 'cannot prune during a running turn — interrupt first');
    }
    // Validate what can be validated BEFORE the kill — no reason to tear down a
    // live subprocess for a request that was always going to be rejected. The
    // cutTurnIndex range check can't move here (it needs the turn count, which
    // means reading the file); that one throws post-kill and is why the catch
    // below has to be able to fail safe.
    const effInputMode = inputMode === undefined ? 'truncate' : inputMode as string;
    if (!INPUT_MODES.has(effInputMode)) {
      throw Object.assign(
        new Error(`inputMode must be one of ${[...INPUT_MODES].join('|')}`), { statusCode: 400 },
      );
    }
    this._mutating = true;
    this.beginRotation('prune');
    let rotationOk = false;
    const oldSid = backingId;
    // Server-minted, up front. Unlike a renewal (where the CLI mints and the
    // file already exists before we hear about it), prune CAN be durable before
    // anything acts on the new id — so it is.
    const newSid = randomUUID();
    try {
      // Kill first so the CLI can't flush a stale tail into the jsonl while we
      // read it. _suppressTempDelete for the same reason rewind sets it: a temp
      // session respawns immediately and must not be archived out from under us.
      if (this.proc) {
        this._suppressTempDelete = true;
        try { await this.kill({ graceMs: 300 }); }
        finally { this._suppressTempDelete = false; }
      }

      const { saved, turnCount, cutTurnIndex: cut } = await pruneSessionToNewId({
        cwd: this.cwd,
        sessionId: oldSid,
        cutTurnIndex: cutTurnIndex as number | undefined,
        keepLatestTurns: keepLatestTurns as number | undefined,
        pruneThinking: !!pruneThinking,
        inputMode: effInputMode as 'truncate' | 'minimal',
        mode: this.mode,
        newSessionId: newSid,
      });

      // Durable, AWAITED, and allowed to throw — the file is on disk and no
      // process has seen the new id yet, so this is the one rotation that can be
      // recorded before first use. `reason:'prune'` is load-bearing: this
      // segment is a filtered COPY that OVERLAPS its predecessor, so a future
      // multi-segment reader must never concatenate across it (a `renew`
      // boundary it must). The rollback below reverts the record, so a throw
      // inside launch() can never leave a segment the process never ran.
      if (this.sessionId) await recordRotation(this.sessionId, newSid, 'prune');

      this._wipeForResume();
      this._skipUsageSeed = true;
      this._segments.push(newSid);
      // The public id is pinned across this rotation — only backingSessionId
      // moves, and spawn() sets it from `resume`.
      await this.launch({ resume: newSid });
      // Carry temp/conducted/title/backend onto the new id and archive the old
      // one. Reads backingSessionId as the NEW id, so it must follow the launch.
      // Awaited (unlike the renewal path, which can't block its reseed turn) so
      // the REST response can't beat the archive into the sidebar refresh.
      await this.carryMarkersAcrossRenewal(oldSid).catch(() => {});

      rotationOk = true;
      return { oldSessionId: oldSid, newSessionId: newSid, turnCount, cutTurnIndex: cut, saved };
    } catch (e) {
      // The subprocess is already dead by the time most of this can throw, and
      // the transform has real failure surface (writeAtomic, copySubAgentDir, a
      // launch that can't spawn). Without this the instance is left wedged: no
      // proc, no respawn, and the user's only recovery is a manual resume.
      //
      // Failing safe back to the UNPRUNED session is always possible: Prune only
      // ever writes a new file, so the original jsonl is intact by construction.
      // Best-effort — a failure here is already the error path, and `e` (the real
      // cause) must be what surfaces.
      // Undo the recorded segment BEFORE relaunching from the original, so a
      // failure anywhere after recordRotation cannot leave the chain pointing at
      // a file this process never ran. Best-effort: `e` is what must surface.
      if (this.sessionId) await revertRotation(this.sessionId, newSid).catch(() => {});
      const at = this._segments.lastIndexOf(newSid);
      if (at !== -1) this._segments.splice(at, 1);
      if (!this.proc) {
        this._wipeForResume();
        // `_skipUsageSeed` may already be set for the PRUNED session's replay. The
        // recovery replays the ORIGINAL instead, whose jsonl usage is accurate —
        // leaving the flag set would suppress a perfectly good ctx reading and
        // strand the recovered session on `ctx —` until its next turn.
        this._skipUsageSeed = false;
        this.backingSessionId = oldSid;
        await this.launch({ resume: oldSid }).catch(() => {});
      }
      throw e;
    } finally {
      this._mutating = false;
      // Prune comes up IDLE with no turn, so the completion event is the ONLY wake
      // point — including on the failure path, where the recovery relaunch also
      // lands idle and an owner must not be left hanging on heartbeats.
      this.endRotation({ ok: rotationOk, comesUpIdle: true });
    }
  }

  // Wipe in-memory state (ring buffer, parser, leaf marker, pending hook
  // resolutions) before a resume that will call loadHistory(). Without this,
  // a respawn into an instance that still has prior events would replay the
  // persisted transcript on top of the existing ring and every message would
  // render twice. Also broadcasts `snapshot_reset` so subscribed clients
  // clear their conversation DOM before the new replay starts streaming.
  _wipeForResume(extra: Record<string, unknown> = {}): void {
    this.ring.clear();
    this._userEchoCount = 0;
    this._liveThinkingTokens = null;
    // The replay about to run feeds _emitUi, so the live quiescence scan must
    // start from the same blank state the ring does.
    this._quiescence = new QuiescenceScan();
    this._clearInterruptArm();
    this._turnForceAborted = false;
    // A rewind/respawn rewrites the CLI's prefix, so the pre-wipe context reading
    // must not leak into the replayed session (it would over-report a rewound
    // session's fill until its first live message_start).
    this._lastContextUsage = null;
    this.parser.reset();
    this._lastLeafUuid = null;
    this._planFiles.reset();
    this._hooks.discardAll();
    // A rewind/respawn rewrites the CLI's prefix, so the shell's accumulated
    // cwd and exports belong to a conversation the worker no longer has. Close
    // it: the next command opens a fresh one and says what it lost.
    void this._redirect?.close();
    // Per-turn cache-miss capture is owned by _setStatus (into-'turn' reset)
    // and the spawn() that always follows a wipe. But a rewind/respawn rewrites
    // the CLI's prefix, so the stale _prevTurnPrefix must NOT drive a cross-turn
    // verdict next turn: invalidate the baseline (a cold rewind still flags via
    // the fallback creation>read rule; a warm-but-smaller one is correctly not).
    this._prefixBaselineInvalid = true;
    this.emit('snapshot_reset', { ...this._snapshotForReset(), ...extra });
  }

  // Read-and-clear the fork prefill. Returns the dropped prompt text (may be
  // '') the first time, then null — so the very first `snapshot` frame after a
  // fork carries `droppedText` and every later subscribe does not.
  consumePrefill(): string | null {
    const t = this.pendingPrefill;
    this.pendingPrefill = null;
    return t;
  }

  // Snapshot frame used at rewind broadcast time. Mirrors the shape of the
  // `snapshot` WS frame so the client can apply it through the same path.
  _snapshotForReset(): { id: string; project: string; status: string; mode: string; sessionId: string | null; events: unknown[] } {
    return {
      id: this.id,
      project: this.project,
      status: 'spawning',
      mode: this.mode,
      sessionId: this.sessionId,
      events: [],
    };
  }
}

export class InstanceManager extends EventEmitter implements InstanceManagerLike {
  byId: Map<string, Instance>;
  _claudeLauncher: LauncherLike;
  _resuming: Map<string, Promise<Instance>>;
  // Public ids with a resume IN FLIGHT. `_resuming` cannot do this job: its key is
  // whatever string the caller passed, and normalizing it to the public id means an
  // async store read (publicIdFor) — which cannot happen in create()'s synchronous
  // prefix, and that prefix being await-free is exactly what closes the race
  // `_resuming` exists for. So a DISK-ONLY session named by two DIFFERENT forms —
  // its public id and one of its segments — gets two distinct keys, does not
  // coalesce, and ends up with TWO live instances sharing one public id: the core
  // invariant broken, and liveForSession then picking between them nondeterministically.
  //
  // This closes it at the first moment the public id is known, with a
  // check-and-claim that has NO await between the two halves — so of two concurrent
  // resumes exactly one proceeds and the other refuses.
  _resumingPublicIds: Set<string>;
  serverPort: number | null;
  _claudePluginDirsResolver: () => Promise<string[]>;
  _idleHub: IdleSubscriptionHub;
  _overageResume: OverageResumeController;
  _sessionRenew: SessionRenewController;
  _usageMonitor: UsageOverageMonitor;
  _overageActive: boolean;
  _overageResetsAt: number | null;
  _overageClearTimer: NodeJS.Timeout | null;
  _overageResumeMode: boolean;

  constructor({ claudeLauncher = defaultClaudeLauncher }: { claudeLauncher?: LauncherLike } = {}) {
    super();
    this.byId = new Map<string, Instance>();
    // Injected launcher, passed to every Instance so it spawns through the
    // seam rather than child_process.spawn directly. Production default is the
    // real launcher; tests inject an in-process one via createServer().
    this._claudeLauncher = claudeLauncher;
    // In-flight resume coalescing: sessionId → Promise<Instance> for a create()
    // that is currently resuming that session but has not yet reached spawn()
    // (create() awaits findSessionLocation/getProject/… before it sets .proc).
    // A second concurrent resume of the same sid returns this promise instead
    // of spawning a colliding `--resume` subprocess — covers the restart anchor
    // auto-resume racing the manifest restore, and manual stop+resume. Entries
    // are deleted when the create settles (success OR failure), by which point
    // .proc is set and the live-guard in create() takes over.
    this._resuming = new Map<string, Promise<Instance>>();
    this._resumingPublicIds = new Set<string>();
    // Set by the server after `server.listen()` resolves. New instances
    // spawned without a port set get null hookCallbackUrl, which disables
    // the interactive http hook (ask mode falls back to auto-allow).
    this.serverPort = null;
    // Resolves the enabled cc plugins' Claude Code plugin roots (validated abs
    // dirs) to add as `--plugin-dir` flags. Injected by server.ts after the
    // plugin host exists (it's constructed after this manager); default [] keeps
    // headless/tests working. Awaited in _doCreate and frozen on each Instance.
    this._claudePluginDirsResolver = async () => [];
    // Two self-contained subsystems composed as collaborators. Each owns its
    // backing state (the idle-wake graph map / the auto-resume timer
    // map) and resolves cross-instance lookups + event emission back through
    // `this`. The manager keeps thin delegating methods (and live-map getters)
    // so every external caller sees an unchanged surface.
    this._idleHub = new IdleSubscriptionHub(this);
    this._overageResume = new OverageResumeController(this);
    // Managed session renewal (`renew_session` MCP tool): drives a server-side
    // `/clear` at the caller's turn_end and reseeds the rotated session with a
    // handoff summary. Keyed by instanceId so it tracks the caller across the
    // backing-id rotation `/clear` performs. See src/sessionRenew.ts.
    this._sessionRenew = new SessionRenewController(this);
    // Server-side usage poller: a second, equal-footing source for the overage
    // auto-stop. The stream `rate_limit_event` only reports near Anthropic's own
    // ~90% threshold, so a LOW configured threshold (e.g. 25%) is invisible to
    // it — only a live usage poll sees it. The poller drives the SAME
    // `_handleOverageTrip` machinery (deduped via `_overageActive`). Its timer is
    // started by the server after listen() and stopped in both shutdown paths.
    this._usageMonitor = new UsageOverageMonitor(this);
    this.on('event', (e: { id: string; ev: UiEvent | null }) => this._idleHub.onEvent(e));
    this.on('event', (e: { id: string; ev: UiEvent | null }) => this._sessionRenew.onEvent(e));
    // Global overage auto-stop state. The decision moved off the per-Instance
    // handler (which can't reach the idle-wake graph) up to here:
    // `_overageActive` is a one-shot guard held from the first trip until the
    // rate-limit window resets (or a manual resume), so routing runs exactly
    // once per window. `_overageResetsAt` is the window reset (epoch secs) used
    // to arm the clear timer and the per-session resume timers.
    this._overageActive = false;
    this._overageResetsAt = null;
    this._overageClearTimer = null;
    // True while the active window's action is `stop-resume` (has a flush path).
    // GLOBAL queueing engages only in this mode — plain `stop` never queues.
    // Set in _handleOverageTrip, cleared in _clearOverage.
    this._overageResumeMode = false;
  }

  // Live backing maps exposed for the subsystems' callers (tests reach for
  // `_idleSubscribers.clear()` / `_autoResumeTimers.has()/.size` directly, and
  // the maps must be the same objects the collaborators mutate).
  get _idleSubscribers() { return this._idleHub.subscribers; }
  get _autoResumeTimers() { return this._overageResume.timers; }

  // Idle-wake graph — see src/idleSubscriptions.ts. The manager forwards to the
  // hub so MCP handlers, wsHub, the resume path, and tests all reach one surface.
  noteDispatch(callerSessionId: string, targetSessionId: string, timeoutMs?: number): void {
    return this._idleHub.noteDispatch(callerSessionId, targetSessionId, timeoutMs);
  }
  setIdleTimeout(callerSessionId: string, targetSessionId: string, timeoutMs: number): { armed: boolean } {
    return this._idleHub.setIdleTimeout(callerSessionId, targetSessionId, timeoutMs);
  }
  // Caller-scoped: only the interrupter's own wake is dropped. See the hub.
  disarmIdleSilently(callerSessionId: string, targetInstanceId: string): void {
    const caller = this.liveForSession(callerSessionId);
    if (!caller) return;
    return this._idleHub.disarmSilently(targetInstanceId, caller.id);
  }
  _idleSubscriberSnapshot(): Record<string, string[]> { return this._idleHub.snapshot(); }
  _purgeIdleFor(instanceId: string): void { return this._idleHub.purge(instanceId); }
  // Sibling to _idleSubscriberSnapshot, but caller-indexed and sessionId-shaped
  // — which targets THIS instanceId OWNS, i.e. whose next turn will wake it.
  // Used by the renewal state block (src/sessionRenew.ts) to enumerate the
  // caller's own live orchestration.
  ownedWakeTargetsOf(instanceId: string): string[] { return this._idleHub.ownedWakeTargetsOf(instanceId); }

  // Managed session renewal — see src/sessionRenew.ts. Arm a `/clear`+reseed
  // on the given instance; the controller fires at the instance's next turn_end.
  // No sessionId-rotation bookkeeping is needed: the idle-wake graph and
  // overage timers are keyed by the stable instanceId, which `/clear` preserves.
  armSessionRenew(instanceId: string, opts: RenewalOpts): { armed: true; rearmed: boolean } { return this._sessionRenew.arm(instanceId, opts); }

  // The conductor-REQUESTED renewal (the targeted `renew_session` form): register
  // the request, then prompt the worker to author its own summary. The worker's own
  // self-call is what actually arms — see src/sessionRenew.ts.
  requestSessionRenew(instanceId: string, opts: { followUp?: string | null; requestedBy?: string | null } = {}): { requested: boolean; rerequested: boolean } {
    return this._sessionRenew.request(instanceId, opts);
  }
  dropSessionRenewRequest(instanceId: string): void { this._sessionRenew.dropRequest(instanceId); }

  // A requested renewal expired unconsumed (the worker declined). Recorded by the
  // idle hub so it rides the REQUESTING conductor's wake — see src/idleSubscriptions.ts.
  noteRenewalDeclined(targetInstanceId: string, requestedBy: string | null): void {
    this._idleHub.noteRenewalDeclined(targetInstanceId, requestedBy);
  }

  // Returns true when a turn_notification for instanceId should be suppressed:
  //   Condition 1 — session is a conductor mid-orchestration (it holds an armed
  //                 wake on a worker); isCaller() is reliable here because an armed
  //                 wake is consumed only when the TARGET finishes (its turn_end,
  //                 the idle task-drain settle, or a rotation that comes up idle) —
  //                 the heartbeat reports without consuming, so a hung worker keeps
  //                 the conductor's ping suppressed rather than un-suppressing it.
  //   Condition 2 — session is a worker whose turn_end fired with an owner watching (whether it woke the conductor now or was
  //                 deferred pending the worker's background subagents);
  //                 wasConsumed() reads _justConsumed, populated in
  //                 IdleSubscriptionHub._onTurnEnd() before the defer check /
  //                 before subscribers clears, so the worker's ping stays
  //                 suppressed across the whole deferral. (The settle path never
  //                 marks it — no turn_notification exists at settle-fire time.)
  // ORDERING DEPENDENCY: the idle hub's 'event' listener (registered in the
  // InstanceManager constructor, instances.ts) must run before wsHub's listener
  // (registered by attachWsHub in server.ts). wasConsumed() is only valid during
  // the same synchronous dispatch cycle as the hub's turn_end handling. Do not
  // reorder those registrations without revisiting this method.
  shouldSuppressTurnNotification(instanceId: string): boolean {
    if (this._idleHub.isCaller(instanceId)) return true;   // Condition 1
    if (this._idleHub.wasConsumed(instanceId)) return true; // Condition 2
    return false;
  }

  setServerPort(port: number): void {
    this.serverPort = port;
  }

  // Injected by server.ts once the plugin host exists: `() =>
  // pluginHost.claudePluginDirs()`. A non-function resets to the [] default.
  setClaudePluginDirsResolver(fn: unknown): void {
    this._claudePluginDirsResolver = typeof fn === 'function' ? (fn as () => Promise<string[]>) : (async () => []);
  }

  hookCallbackUrl(id: string): string | null {
    if (!this.serverPort) return null;
    return `http://127.0.0.1:${this.serverPort}/api/instances/${id}/hook-callback`;
  }

  // Where a redirected Bash's local forwarder posts the worker's original
  // command. Loopback for the same reason the hook callback is: the forwarder
  // is a child of the CLI, which is a child of this process.
  bashForwardUrl(id: string): string | null {
    if (!this.serverPort) return null;
    return `http://127.0.0.1:${this.serverPort}/api/instances/${id}/bash-forward`;
  }

  // Auto-registered orchestrator MCP server URL. Returns the BASE URL (no
  // ?caller=) — Instance.spawn() appends the worker's own sessionId as the
  // caller suffix once it's known, so the MCP server can identify which worker
  // is calling (it is the ownership edge the turn_end wake is routed along).
  // Honours ORCH_DISABLE_MCP_AUTOREGISTER at call time.
  mcpServerUrl(): string | null {
    if (!this.serverPort) return null;
    if (process.env.ORCH_DISABLE_MCP_AUTOREGISTER === '1') return null;
    return `http://127.0.0.1:${this.serverPort}/mcp`;
  }

  // Resolve a worker's `?caller=` handle (the stable instanceId baked into its MCP
  // URL at spawn) to that instance's CURRENT sessionId. This is the single MCP
  // boundary translation that keeps caller identity valid across a `/clear`
  // rotation: the instanceId is frozen in the subprocess config, but its sessionId
  // rotates, so we re-resolve the live value per request. Returns null when the
  // handle names no live instance (or it has no sessionId yet) — callers then see
  // the same "no caller" path as an absent `?caller=`.
  callerSessionId(handle: string | null): string | null {
    if (!handle) return null;
    return this.byId.get(handle)?.sessionId ?? null;
  }

  hasArmedWake(instanceId: string): boolean { return this._idleHub.hasArmedWake(instanceId); }

  // Returns true when instanceId is the *caller* (conductor) of any armed wake —
  // i.e. one of its sessions is mid-turn and it is due a report at that turn's end.
  isIdleCaller(instanceId: string): boolean { return this._idleHub.isCaller(instanceId); }

  // `awaitingWake` is the CALLER side (isIdleCaller — "this instance is waiting on
  // someone"), never the target side. The sidebar's accent idle dot and
  // list_sessions' `awaiting-wake` column both read it.
  list(): Array<InstanceSummary & { awaitingWake: boolean }> {
    return [...this.byId.values()].map(i => ({
      ...i.summary(),
      awaitingWake: this.isIdleCaller(i.id),
    }));
  }

  // How many of a project's workers are NOT dead. The number list_projects
  // prints as `live N`; it reads the same isDeadStatus() rule that decides which
  // of list_sessions' live/inactive rows a session lands in, so the two tools cannot
  // report a different fleet.
  liveCountForProject(name: string): number {
    return [...this.byId.values()].filter(i => i.project === name && !isDeadStatus(i.status)).length;
  }

  // Which backend each tracked instance is on — the seam appSettings' removeBackend
  // consults (via setLiveBackendsProvider) to refuse deleting a backend out from
  // under a running session. Includes instances with no live subprocess: they are
  // still respawnable (crash-respawn, overage auto-resume, rewind), and it is
  // exactly that later relaunch that would otherwise fall through to the real
  // `claude`. Only the identity backend is uninteresting here.
  liveBackendUsage(): Array<{ backend: string; sessionId: string | null }> {
    return [...this.byId.values()]
      .filter(i => i.backend && i.backend !== CLAUDE_BACKEND_ID)
      .map(i => ({ backend: i.backend, sessionId: i.sessionId ?? null }));
  }
  get(id: string): Instance | undefined { return this.byId.get(id); }
  idsForProject(name: string): string[] {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.id);
  }
  idsForWorktree(project: string, worktreeName: string): string[] {
    return [...this.byId.values()]
      .filter(i => i.project === project && i.worktree?.worktreeName === worktreeName)
      .map(i => i.id);
  }
  sessionIdsForProject(name: string): string[] {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.sessionId)
      .filter((sid): sid is string => sid !== null);
  }
  sessionIdsForWorktree(project: string, worktreeName: string): string[] {
    return [...this.byId.values()]
      .filter(i => i.project === project && i.worktree?.worktreeName === worktreeName)
      .map(i => i.sessionId)
      .filter((sid): sid is string => sid !== null);
  }
  idsForSession(sessionId: string): string[] {
    return [...this.byId.values()]
      .filter(i => answersTo(i, sessionId))
      .map(i => i.id);
  }
  // The single live (proc-attached) instance for a sessionId, or null. Folds
  // the `idsForSession(sid).map(get).find(i => i && i.proc)` idiom scattered
  // across the MCP handlers + idle-callback delivery.
  //
  // Answers a DIFFERENT question from isSessionLive below: "is there a proc I
  // can address right now" (can I prompt/interrupt/kill it this instant), not
  // "is this worker coming back". The two deliberately DISAGREE during a
  // coming-up window (a resume in flight, a prune/rewind/respawn relaunch):
  // this reads null there, isSessionLive reads true. That is intended, not a
  // bug to reconcile. Its readers fall into three groups, and only the third
  // is what "governance reads isSessionLive exclusively" is actually about:
  //   - STRICT-LIVE worker-addressing resolution (src/mcp/handlers.ts's
  //     getInst/getInstOrDisk), which hard-refuses SESSION_NOT_LIVE for every
  //     worker-addressing tool — CORRECTLY reads this one, not isSessionLive:
  //     you cannot prompt/interrupt/kill a proc that is not attached yet, so
  //     refusing during a coming-up window is the right answer, not a gap.
  //   - Caller resolution and idle-wake dispatch (handlers.ts's caller
  //     lookups, playbookGate.ts's conductor-caller check, and
  //     src/idleSubscriptions.ts's delivery paths) — same "is there a proc to
  //     act on" question, asked of the CALLER or the WATCHED target rather
  //     than the addressed worker.
  //   - Advisory text (a forward/get_recent_messages hint, a
  //     NOTHING_TO_FORWARD reason) — merely describes state to a human/LLM
  //     reader, refuses nothing.
  // Playbook policy (decide()) is the one caller that must NOT read this —
  // it takes `isLive` as a required parameter, always isSessionLive. Do not
  // fold liveForSession and isSessionLive into one function: that would
  // either make the strict-live resolver wrongly permissive during a
  // coming-up window, or reintroduce a second liveness authority on the
  // governance side — the two questions are different, not the same
  // question answered two different ways.
  liveForSession(sessionId: string): Instance | null {
    return this.idsForSession(sessionId).map(id => this.byId.get(id))
      .find((i): i is Instance => i != null && i.proc != null) ?? null;
  }
  // THE liveness authority for a public sessionId (governance reads this, and
  // only this — see liveForSession above for the "is there a proc I can
  // address right now" counterpart).
  // Three states collapse to one boolean: proc-attached, a resume in flight
  // (no registry entry exists yet), and a relaunch window — the instance is
  // registered with proc null, covering a prune's kill→relaunch (rotationPending)
  // and rewindToUserMessage's/InstanceManager.respawn's (_relaunching), which
  // are structurally the same window but outside the renew/prune `_rotation`
  // machinery. A caller that used liveForSession alone would read a
  // genuinely-coming-up worker as gone in any of these.
  //
  // `_resumingPublicIds` covers from THIS check onward — not the whole
  // create({resume}) call. `publicIdFor`/`resolveBacking` are awaited BEFORE
  // the `.add` (`_doCreate`, below), so a short prefix is not covered; that
  // prefix is unfixable by construction, since the public sessionId is not yet
  // known until `publicIdFor` resolves it.
  isSessionLive(sessionId: string): boolean {
    if (this._resumingPublicIds.has(sessionId)) return true;
    const inst = this.anyForSession(sessionId);
    return !!inst && (inst.proc != null || inst.rotationPending || inst.relaunching);
  }
  // Any instance (live or exited) for a sessionId, or null — the `.find(Boolean)`
  // counterpart used where a non-running instance is still a valid target.
  anyForSession(sessionId: string): Instance | null {
    return this.idsForSession(sessionId).map(id => this.byId.get(id))
      .find((i): i is Instance => i != null) ?? null;
  }
  // Resolve an MCP input to a canonical PUBLIC sessionId. The MCP dispatch layer
  // (src/mcp/server.ts) uses this so conductors can address workers by a short
  // prefix instead of an error-prone 36-char UUID.
  //
  // CANDIDATE UNIVERSE — for every in-memory instance (live AND exited, which is
  // broader than live-only on purpose: a prefix unique among live workers but
  // shared with an exited session must refuse rather than mis-resolve): its public
  // id PLUS every backing id it has run under. Resolution is purely in-memory, so
  // this stays synchronous and store-free on the MCP hot path. Historical
  // disk-only sessions are intentionally out of scope (still addressable by full
  // id through the handlers' disk probe).
  //
  // Answers are ALWAYS public ids — a backing id must never reach a conductor,
  // which is also why `ambiguous` can only ever list public ids.
  // Returns one of:
  //   null                              → no match (caller leaves the arg untouched,
  //                                         so the handler's existing SESSION_UNKNOWN /
  //                                         SESSION_NOT_LIVE / disk-probe path runs)
  //   { sessionId }                     → exact match on any candidate (always
  //                                         wins), or a prefix >= SESSION_PREFIX_MIN
  //                                         chars matching exactly ONE session
  //   { ambiguous:[publicIds], tooShort} → a prefix matching >1 SESSION, OR a
  //                                         too-short (< SESSION_PREFIX_MIN) prefix
  //                                         matching >= 1
  //
  // Two segments of the SAME session sharing a prefix collapse to one answer, not
  // an ambiguity — the set below is of owning sessions, not of candidate strings.
  resolveSessionRef(input: unknown): { sessionId: string } | { ambiguous: string[]; tooShort: boolean } | null {
    if (typeof input !== 'string' || !input) return null;
    // candidate → owning public id. Public ids are claimed FIRST so an exact match
    // on a public id deterministically beats a segment of some other session.
    const owner = new Map<string, string>();
    for (const i of this.byId.values()) {
      if (i.sessionId) owner.set(i.sessionId, i.sessionId);
    }
    for (const i of this.byId.values()) {
      if (!i.sessionId) continue;
      for (const seg of segmentsOf(i)) if (!owner.has(seg)) owner.set(seg, i.sessionId);
    }
    const exact = owner.get(input);
    if (exact !== undefined) return { sessionId: exact }; // exact match always wins
    const sessions = new Set<string>();
    for (const [candidate, publicId] of owner) {
      if (candidate.startsWith(input)) sessions.add(publicId);
    }
    if (sessions.size === 0) return null;
    const ambiguous = [...sessions];
    if (input.length < SESSION_PREFIX_MIN) return { ambiguous, tooShort: true };
    if (ambiguous.length === 1) return { sessionId: ambiguous[0] };
    return { ambiguous, tooShort: false };
  }
  // SessionIds of live (proc-attached) temp instances whose cwd matches.
  // Routes use this to strip running temp jsonls from the regular Sessions
  // list — otherwise clicking the row would 409 against the live instance.
  // BACKING ids of every non-dead instance at this cwd — the exclusion set the
  // on-disk session walk needs. It MUST be backing ids: listSessionsForCwdWithCounts
  // / summarizeSessions match against transcript FILENAMES, so a set of public ids
  // would exclude nothing and every live worker would also be listed as an
  // inactive row off its own transcript. Dead instances are deliberately absent —
  // an exited session reappearing as an inactive row is how it stays resumable.
  liveBackingIdsForCwd(cwd: string): Set<string> {
    const out = new Set<string>();
    for (const i of this.byId.values()) {
      if (i.cwd === cwd && !isDeadStatus(i.status) && i.backingSessionId) out.add(i.backingSessionId);
    }
    return out;
  }
  tempSessionIdsForCwd(cwd: string): Set<string> {
    const out = new Set<string>();
    for (const i of this.byId.values()) {
      if (i.temp && i.proc && i.cwd === cwd && i.backingSessionId) out.add(i.backingSessionId);
    }
    return out;
  }

  // Thin wrapper over _doCreate that serialises concurrent resumes of the same
  // session. The corruption-prevention checks live HERE, in the synchronous
  // prefix (no `await` before they run), so two concurrent resume calls — the
  // restart anchor auto-resume racing the manifest restore, or a manual
  // stop+resume — can't both slip past during the await gap _doCreate opens
  // before spawn() attaches `.proc`.
  create(opts: CreateInstanceInput = {}): Promise<Instance> {
    const { resume } = opts;
    if (!resume) return this._doCreate(opts);
    // Already fully live: a running instance owns this session. `claude
    // --resume <sid>` would otherwise race two subprocesses on one jsonl.
    // liveForSession matches the public id OR any segment, so naming an old
    // segment of a live session is caught too — it is the same transcript lineage.
    const conflict = this.liveForSession(resume);
    if (conflict) {
      throw Object.assign(
        new Error(`session ${resume} is already attached to a running instance (${conflict.id.slice(0, 8)}…)`),
        { statusCode: 409 },
      );
    }
    // In-flight: a concurrent create() is already resuming this session but hasn't
    // spawned yet (so the live-guard above can't see it). Coalesce onto that
    // promise — both callers get the same restored instance, one subprocess.
    //
    // The key is NORMALIZED to the session's public id when we know it, so two
    // callers naming the same session by different forms (its public id and one of
    // its segments) still coalesce instead of racing two subprocesses onto one
    // transcript. anyForSession is synchronous and in-memory, so this stays inside
    // the no-await prefix that makes the guards above sound.
    const key = this.anyForSession(resume)?.sessionId ?? resume;
    const inflight = this._resuming.get(key);
    if (inflight) return inflight;
    const p = this._doCreate(opts);
    this._resuming.set(key, p);
    // Release when the create settles — success OR failure. On success `.proc`
    // is set, so the live-guard above covers subsequent resumes; on failure
    // (bad sid / spawn throw) we must clear the entry so it doesn't wedge
    // future resumes of this session.
    const release = () => { if (this._resuming.get(key) === p) this._resuming.delete(key); };
    p.then(release, release);
    return p;
  }

  // `contextWindowTokens` is a FALLBACK ONLY, never an override: callers that
  // carry a session's last known capacity (fork, restart manifest) pass it so a
  // deleted custom-model row doesn't blank the ctx bar. Live registry
  // resolution wins whenever it succeeds — see finalContextWindowTokens below.
  // Resolve the caller's id ONCE, claim the session, then hand off to the body.
  //
  // `resume` may arrive as a public id (a conductor's handle, the restart
  // manifest), as ANY segment id (a wiki page, an old kanban card, an archived
  // sidebar row), or — for a session with no lineage row — as both at once.
  // Everything downstream consumes the BACKING id (cwd probe, resume pre-flight,
  // sidecar recovery, the `--resume` argv), so `resume` is rebound here and every
  // one of those consumers is correct with no further edit. Naming a SEGMENT
  // resolves to that segment, not to the newest one, so clicking an archived row
  // opens the transcript it names.
  //
  // The claim is the only thing standing between two differently-named concurrent
  // resumes and two live instances on one public id — see `_resumingPublicIds`.
  // Released on settle, success or failure, so a later resume is unaffected.
  async _doCreate(opts: CreateInstanceInput = {}): Promise<Instance> {
    let publicId: string | null = null;
    let resume = opts.resume;
    if (resume) {
      publicId = await publicIdFor(resume);
      resume = await resolveBacking(resume);
      // Check-and-claim, with NO await between them. `liveForSession` covers a
      // session already spawned — which create()'s synchronous prefix can only see
      // when the caller named a form already in memory; `_resumingPublicIds` covers
      // one still inside its own resume, which that prefix cannot see at all.
      const live = this.liveForSession(publicId);
      if (live || this._resumingPublicIds.has(publicId)) {
        throw Object.assign(
          new Error(`session ${publicId} is already attached to a running instance`
            + (live ? ` (${live.id.slice(0, 8)}…)` : ' (a resume is already in flight)')),
          { statusCode: 409 },
        );
      }
      this._resumingPublicIds.add(publicId);
    }
    try {
      return await this._doCreateResolved({ ...opts, resume }, publicId);
    } finally {
      if (publicId) this._resumingPublicIds.delete(publicId);
    }
  }

  async _doCreateResolved({ project, resume, mode, effort, tier, role, thinking, model, contextWindowTokens: carriedContextWindowTokens, backend: explicitBackend, worktree, baseWorktree, name, temp, conducted, callerInstanceId, debug, autoApprovePlan, playbookEnforcement, prefill }: CreateInstanceInput = {}, publicId: string | null = null): Promise<Instance> {
    // On resume, when the caller didn't pin an explicit worktree, recover the
    // session's recorded project + worktree via findSessionLocation. This is
    // what makes spawn_instance({resume}) "just work" for an MCP conductor
    // that only knows the sessionId — and it's not cosmetic: spawn() below
    // launches the subprocess with this cwd, and the CLI derives the
    // transcript path from cwd, so a wrong cwd silently drops prior history
    // even though --resume <id> is passed correctly. `resume` is ALREADY the
    // backing id and `publicId` the session's public one — both from _doCreate.
    if (resume && worktree === undefined) {
      const hit = await findSessionLocation(resume).catch(() => null);
      if (hit) {
        project = hit.project;
        if (hit.worktreeName) worktree = hit.worktreeName;
      }
    }
    if (!project) {
      throw httpError(400, 'project required');
    }
    const proj = await getProject(project);
    // A worker on a NON-LOCAL system still runs the CLI here — the CLI is
    // always local — but never in the project's own directory, which is a path
    // on another machine. Its cwd is a cc-owned session root (resolved below,
    // once the worktree is known), and its tools cross the boundary one call at
    // a time. A system cc cannot open a shell on cannot host a session at all:
    // every non-local system is reached over the provider protocol, so this
    // refuses rather than silently degrading to a session with no Bash.
    const remote = proj.system.id !== LOCAL_SYSTEM_ID;
    if (remote && !isRedirectable(proj.system)) {
      throw httpError(
        501,
        `WORKER_SESSIONS_NEED_A_SHELL: project '${proj.name}' is on system '${proj.system.id}', `
        + `which cc cannot open a shell on, so a worker there would have no Bash.`,
      );
    }
    // create() is policy-light: mode never depends on temp here. The UI's
    // temp⇒bypassPermissions shortcut is applied at the REST route
    // (POST /api/instances), not in this shared path.
    //
    // A resume inherits the mode the session was recorded in, so bringing a
    // planning session back doesn't silently hand it full tool access. An
    // unrecorded session (one that predates the store — there is no backfill)
    // resolves to DEFAULT_RESUME_MODE, i.e. exactly the previous behaviour.
    // An explicit `mode` still wins, via the `??` below.
    const defaultMode = resume
      ? effectiveResumeMode(await getSessionMode(resume).catch(() => null))
      : DEFAULT_MODE;
    const finalMode = mode ?? defaultMode;
    if (!VALID_MODES.has(finalMode)) {
      throw httpError(400, 'invalid mode (must be plan, ask, or bypassPermissions)');
    }
    // `tier`/`role` are carried ONLY to resolve the default effort — the model +
    // backend are already resolved to concrete values by the caller. They are not
    // stored on the Instance: `this.effort` holds the resolved level, which is what
    // respawn/resume reuse. resolveSpawnEffort owns validation too (an explicit
    // invalid effort throws 400 there).
    const finalEffort = resolveSpawnEffort({ effort, tier, role });
    const finalThinking = thinking ?? DEFAULT_THINKING;
    if (!VALID_THINKING.has(finalThinking)) {
      throw httpError(400, 'invalid thinking');
    }
    let finalModel = (typeof model === 'string' && model.trim()) ? model.trim() : null;

    // Backend (a registry id) — the sole discriminator. `model` is a plain id for
    // EVERY backend (Claude version id OR another backend's model id) and is NOT
    // cleared for non-Claude backends, so the canonicalize + jsonl
    // model-recovery below apply uniformly. Sources, in priority order:
    //   (a) explicit `backend` param — fresh spawn (client/handlers resolved
    //       the tier to {backend, model}) and restart-manifest restore.
    //   (b) resume with no explicit backend — the durable sidecar records which
    //       backend ran the session (one of the two bits jsonl can't carry),
    //       covering UI resume / crash / anchor / respawn_instance uniformly.
    // An EXPLICIT backend that isn't in the registry must refuse, not fall back to
    // `claude`: `finalModel` keeps the caller's foreign model id, so the fallback
    // would launch a real `claude --model <foreign-id>` against the Anthropic
    // account. Reachable from POST /api/instances and from the graceful-restart
    // replay (resumeRestart.ts), which carries the recorded backend id forward.
    if (explicitBackend && !isKnownBackend(explicitBackend)) {
      throw Object.assign(
        new Error(`unknown backend '${explicitBackend}' — add it in Settings → Backends, or omit it to use '${CLAUDE_BACKEND_ID}'`),
        { statusCode: 422, code: 'BACKEND_GONE' },
      );
    }
    let backend = explicitBackend || CLAUDE_BACKEND_ID;
    if (!explicitBackend && resume) {
      let rec: SessionBackendRecord | null = null;
      try { rec = await getSessionBackend(resume); } catch { /* best-effort */ }
      if (rec) {
        // The recorded backend may have been REMOVED from the registry since this
        // session last ran. Refuse cleanly: the constructor would normalize the
        // unknown id back to `claude` while finalModel keeps the sidecar's foreign
        // model id, which spawns a real `claude --model <foreign-id>` that fails
        // opaquely deep in the CLI.
        // Deliberately BEFORE the session-existence checks further down: the
        // sidecar is never garbage-collected (unmarkSessionBackend runs only on an
        // in-place /clear renewal), so a stale entry for a long-deleted session
        // reports this instead of a 404. Accepted — the backend error is the more
        // actionable of the two, and a resume that would otherwise launch the real
        // `claude` with a foreign model id must never get further than here.
        if (!isKnownBackend(rec.backend)) {
          throw Object.assign(
            new Error(`session was last run on backend '${rec.backend}', which no longer exists — re-add it in Settings → Backends, or resume with an explicit model`),
            { statusCode: 422, code: 'BACKEND_GONE' },
          );
        }
        backend = rec.backend;
        // The sidecar carries the FULL exact model id; the jsonl only holds the
        // CLI's lossy (tag-stripped) report. Prefer the sidecar's — this is what
        // stops `deepseek-v4-flash:cloud` resuming as the unpullable tagless
        // `deepseek-v4-flash`, and `gpt-5.6-sol[1m]` resuming as an id the
        // registry doesn't know. A null (legacy) model falls through to the
        // readLastSessionModel jsonl recovery below.
        if (!finalModel && rec.model) finalModel = rec.model;
        // Last known capacity, used only if the custom-model row is gone by now.
        if (!Number.isFinite(carriedContextWindowTokens) && Number.isFinite(rec.contextWindowTokens)) {
          carriedContextWindowTokens = rec.contextWindowTokens;
        }
      }
    }

    // Optional worktree attachment:
    //   worktree === true  → create a fresh worktree off the base's HEAD
    //   worktree === '<existingName>' → spawn into the named existing worktree
    //   omitted/null/false → normal spawn at proj.path
    let worktreeMeta: WorktreeMeta | null = null;
    let cwd = proj.path;
    // baseWorktree/name describe a worktree to be CREATED, so they are
    // meaningless without worktree:true. Refusing rather than ignoring is what
    // stops a caller believing it based a new worktree on a feature when it in
    // fact attached to an existing worktree (or to none).
    if ((baseWorktree !== undefined || name !== undefined) && worktree !== true) {
      throw Object.assign(
        new Error(`baseWorktree / name apply only when creating a worktree — pass createWorktree:true (MCP) or worktree:true`),
        { statusCode: 400 },
      );
    }
    if (worktree === true) {
      worktreeMeta = await createWorktree(project, { baseWorktree, name });
      cwd = worktreeMeta.worktreePath;
    } else if (typeof worktree === 'string' && worktree.trim()) {
      worktreeMeta = await getWorktree(project, worktree.trim());
      if (!worktreeMeta) {
        throw httpError(404, `worktree '${worktree}' not found under project '${project}'`);
      }
      cwd = worktreeMeta.worktreePath;
    }

    // THE SESSION ROOT, and the point `cwd` stops meaning "the project's
    // directory" for a remote project.
    //
    // Everything downstream of here reads `cwd` as the CLI's working directory:
    // the resume pre-flight, the transcript path, the model recovery, the
    // subprocess launch. On a remote project the project's directory is on
    // another machine, so the CLI's cwd is a cc-owned local session root
    // holding only the config surface the CLI reads implicitly. `systemCwd`
    // keeps the other half — the tree the shell and the file bridge address.
    let redirectPlacement: RedirectPlacement | null = null;
    if (remote) {
      const systemCwd = cwd;
      redirectPlacement = {
        system: proj.system as RedirectableSystem,
        systemId: proj.system.id,
        systemPath: systemCwd,
        project,
        worktree: worktreeMeta?.worktreeName ?? null,
      };
      // Composed BEFORE the refusal below, because the rules that refusal reads
      // are the project's own `.claude/settings*.json` — which only exist
      // locally once they have been pulled.
      //
      // launch() composes again, and that is not redundant to remove: this call
      // is the only one on the CREATE path that can still refuse, and launch()
      // is the only one that covers a relaunch (rewind, respawn, resume after a
      // restart) which never comes back through here. The second pass is a
      // manifest hit — one `find`, no transfers.
      cwd = (await composeSessionRoot(redirectPlacement)).root;
      const unenforceable = await findUnenforceableBashRules(bashRuleSources(cwd));
      if (unenforceable.length > 0) {
        throw Object.assign(
          new Error(bashRulesRefusal(proj.system.id, unenforceable)),
          { statusCode: 501, code: 'BASH_RULES_NOT_ENFORCEABLE' },
        );
      }
    }

    // Resume pre-flight: refuse a resume id that has no resumable conversation
    // at the resolved cwd BEFORE constructing an Instance or spawning. The
    // earlier findSessionLocation net (above) only runs when the caller left
    // worktree undefined; a caller that pins project+worktree (e.g. an MCP
    // conductor retrying a mistyped sessionId) skips it, and would otherwise
    // spawn `claude --resume <bogus>` → exit 1 "No conversation found" →
    // crash, repeatably. Bailing here means no phantom crashed Instance is
    // registered, so a follow-up respawn_instance also soft-refuses cleanly.
    if (resume && !(await hasResumableConversation({ cwd, sessionId: resume }))) {
      throw Object.assign(
        new Error(`no resumable conversation for session ${resume} in ${cwd}`),
        { statusCode: 404, code: 'SESSION_UNKNOWN' },
      );
    }

    // On resume without an explicit model, recover the model the session
    // was last run with by reading the most-recent assistant line in the
    // jsonl. Otherwise `claude --resume <sid>` falls back to the account
    // default (often Opus) and silently switches the model out from under
    // a session that was spawned with Sonnet/Haiku.
    if (resume && !finalModel) {
      try {
        const prev = await readLastSessionModel({ cwd, sessionId: resume });
        if (prev) finalModel = prev;
      } catch { /* best-effort */ }
    }

    // Apply the launch tag. GATED ON `backend`, not on what the id looks like:
    // for any substitution backend this returns the id byte-exact, because that
    // string is the registry key everything downstream matches on. A Claude id
    // gets its catalog tag (re)applied, which is also what re-tags a bare id
    // recovered from the jsonl on a cold resume.
    if (finalModel) finalModel = canonicalizeModel(finalModel, backend) ?? null;

    // Null-model guard (note 1): a substitution-backend session with no resolvable
    // model — e.g. a resume whose jsonl is empty/corrupt so readLastSessionModel
    // returned nothing — must fail clearly here rather than emit `--model undefined`
    // at spawn.
    //
    // UNCONDITIONAL on the template shape, deliberately. Every supported way to bind
    // a model to a substitution backend goes through a custom-model row (which
    // requires a contextWindow), so such a session always has one; a template that
    // omits `{model}` is a pass-through wrapper, not a licence to spawn model-less.
    // Scoping this to templates naming `{model}` would put template introspection
    // outside resolveBackendLaunch — and then a THIRD site (_trackModel) would have
    // to suppress the CLI's own model report, or run 2 would inject a
    // canonicalized `--model` the wrapper never asked for.
    if (backend !== CLAUDE_BACKEND_ID && !finalModel) {
      throw Object.assign(
        new Error(`session on backend '${backend}' has no resolvable model — rebind the tier or resume with an explicit model`),
        { statusCode: 422, code: 'BACKEND_MODEL_MISSING' },
      );
    }

    // Resolve context capacity ONCE, from the concrete {backend, exact model}
    // pair now settled above. This single number feeds the substitution
    // backend's context env vars, summary(), the MCP projection, the client ctx
    // chip, forks, and the restart manifest.
    //
    // The live registry WINS over any carried value: a custom model's window is
    // user-editable, so a session resumed after the row was corrected must pick
    // up the correction. `carriedContextWindowTokens` (from the session sidecar,
    // the restart manifest, or a fork) is the fallback for exactly one case —
    // the custom-model row was DELETED since the session last ran, so the
    // registry can no longer resolve it. Keeping the last known real number
    // beats rendering a long-running session's ctx bar as unknown.
    const finalContextWindowTokens =
      resolveContextWindowTokens({ backend, model: finalModel })
      ?? (Number.isFinite(carriedContextWindowTokens) ? carriedContextWindowTokens : null);

    // The conducted marker is set explicitly on the MCP spawn path. When
    // resuming a historical session, recover it from the durable sidecar
    // so a UI-resumed conducted session re-acquires the marker (survives
    // --resume). Per-session and immutable, so OR-ing the two is safe.
    let conductedFlag = !!conducted;
    if (!conductedFlag && resume) {
      try { conductedFlag = await isConducted(resume); } catch { /* best-effort */ }
    }
    // Recover temp flag from durable sidecar on resume so a session that
    // survived SIGKILL comes back temp rather than silently going persistent.
    if (!temp && resume) {
      try { if (await isTemp(resume)) temp = true; } catch { /* best-effort */ }
    }
    // Recover firstPrompt from the on-disk jsonl on resume. A resumed session
    // gets a BRAND NEW Instance object (firstPrompt starts null) — unlike the
    // manifest-driven restart-resume path (resumeRestart.ts), which seeds it
    // from its own in-memory snapshot, every OTHER resume (a UI "resume dead
    // session" click, crash/anchor auto-resume, respawn_instance) had nothing
    // recovering it, so the next prompt()'s fallback-when-null guard
    // (see prompt() below) would clobber the label with whatever was just
    // typed. `--resume` does not fork history into a new jsonl (verified:
    // same sessionId, same file, across a real resume) — the original file
    // still holds the true first line, so this is reliable.
    let recoveredFirstPrompt: string | null = null;
    if (resume) {
      try { recoveredFirstPrompt = await readFirstPrompt(sessionFilePath(cwd, resume)); }
      catch { /* best-effort */ }
    }

    // Resolve + validate the enabled plugins' Claude Code plugin roots here (async
    // launch-config, like mcpServerUrl) so the sync spawn() can just append the
    // frozen list. Best-effort: a resolver failure must never block a spawn.
    let claudePluginDirs: string[] = [];
    try { claudePluginDirs = await this._claudePluginDirsResolver(); }
    catch (e) { console.warn(`instances: claudePlugin resolve failed: ${(e as Error).message}`); }

    const id = randomUUID();
    const inst = new Instance({
      id, project, cwd,
      mode: finalMode, effort: finalEffort, thinking: finalThinking, model: finalModel,
      contextWindowTokens: finalContextWindowTokens,
      backend,
      hookCallbackUrl: this.hookCallbackUrl(id),
      // Base MCP URL (no ?caller=) — the per-worker caller suffix is appended in
      // Instance.spawn() once the sessionId is known.
      mcpServerUrl: this.mcpServerUrl(),
      worktree: worktreeMeta,
      temp: !!temp,
      conducted: conductedFlag,
      callerInstanceId: callerInstanceId ?? null,
      // `debug` falls back to the persisted conductor-wide default only when
      // the caller omitted it (undefined) — an explicit true/false always wins.
      // `??` also treats an explicit `null` as "omitted" (falls through to the
      // default) — there is no way to spell "off" other than `debug: false`.
      debug: !!(debug ?? getDebugByDefault()),
      claudePluginDirs,
      launcher: this._claudeLauncher,
    });
    if (recoveredFirstPrompt) inst.firstPrompt = recoveredFirstPrompt;
    // Attached BEFORE launch(): spawn() reads it to widen the injected hook
    // surface, and the hook broker reads it on every tool call.
    if (redirectPlacement) {
      inst.attachRedirect(new SessionRedirect({
        system: redirectPlacement.system,
        systemId: redirectPlacement.systemId,
        systemPath: redirectPlacement.systemPath,
        sessionRoot: inst.cwd,
        forwarderUrl: this.bashForwardUrl(id) ?? '',
        // The LOCAL paths a file tool may legitimately name on a remote
        // project: the store (attachments, debug captures), the CLI's own home
        // (plans, user settings), the transcript root, and cc-managed plugin
        // roots. Anything else outside the session root is refused, because a
        // file written there lands on the orchestrator's machine where no
        // command on the system can ever see it.
        localRoots: [orchStoreRoot(), path.join(os.homedir(), '.claude'), claudeProjectsRoot(), ...claudePluginDirs],
        emit: (ev: unknown) => inst._emitUi(ev as UiEvent),
      }), redirectPlacement);
    }

    inst.on('event', (ev: UiEvent) => this.emit('event', { id, ev }));
    // The Instance signals (rather than self-handles) an overage trip — central
    // routing lives on the manager where the idle-wake graph is reachable.
    inst.on('overage', (info: { resetsAt: number | null }) => this._handleOverageTrip(inst, info));
    // Live GLOBAL-overage gate, injected as a small callback (not a manager ref).
    // active ⇒ this session must queue every non-internal send. SAFETY RAIL: only
    // engages when the window is active in stop-resume mode AND there is a valid
    // FUTURE resetsAt with an armed clear timer — a queued send bypasses the
    // manual-resume clear path, so a missing/past/NaN resetsAt must mean
    // active:false (sends flow normally) or every session would lock out forever.
    inst._overageGate = () => {
      const resetsAt = this._overageResetsAt;
      const atMs = Number(resetsAt) * 1000;
      // `_inUsageWindowFlow(inst)` keeps a ROOT-exempt (e.g. ollama-only tree)
      // session out of the gate: its sends flow normally AND its summary reports
      // overageActive:false, so no overage/queued badge shows (summary() derives
      // overageActive/overageResetsAt from this same gate).
      const active = this._overageActive && this._overageResumeMode &&
        Number.isFinite(atMs) && atMs > Date.now() && this._inUsageWindowFlow(inst);
      return { active, resetsAt: active ? resetsAt : null };
    };
    // A queued-only (idle/new) session signals it needs a resume deadline armed
    // immediately — it has no mid-turn→idle transition for the status handler to
    // arm on.
    inst.on('overage_queued', (info: { resetsAt: number | null }) => this._armResumeNow(inst, info?.resetsAt));
    // A turn began on this session — arm the idle wake for each of its owners.
    // Emitted from _setStatus's into-`turn` branch, so it covers prompted and
    // unprompted turns alike. See src/idleSubscriptions.ts.
    //
    // The overage guard runs AFTER onTurnStart, deliberately: onTurnStart owns the
    // survived-a-wake / consumeTurnForceAborted bookkeeping, and severing before it
    // would make `survived` read false and change the abort qualifier's lifetime.
    inst.on('turn_start', () => {
      this._idleHub.onTurnStart(inst.id);
      this._guardOverageTurnStart(inst);
    });
    // A user/MCP-driven turn cancels any pending overage auto-resume. If the
    // turn is a manual takeover of an overage-stopped session, it also clears
    // the global overage flag so the stop can trip again. Capture the flag
    // BEFORE cancel (which resets it). Orchestrator-injected prompts
    // (`internal` — e.g. the idle-wake stub) skip this: they must not discard a
    // pending resume armed for an overage-stopped session. The auto-resume's own
    // fire is `internal:true` too and tears its deadline down by calling cancel()
    // directly (src/overageResume.ts → run()).
    inst.on('user_prompt', (meta: { internal: boolean }) => {
      if (meta?.internal) return;
      const wasOverageStopped = inst.autoStoppedForOverage;
      this._cancelAutoResume(inst.id);
      if (wasOverageStopped && this._overageActive) this._clearOverage();
    });
    inst.on('status', (summary: InstanceSummary) => {
      this.emit('status', summary);
      // Overage auto-resume: arm the per-session timer on the idle transition
      // that follows a `stop-resume` soft-interrupt (the session stays alive;
      // we never reach 'exited'). Guarded so it arms exactly once.
      if (inst.autoStoppedForOverage && summary.status === 'idle' && inst.proc &&
          !this._autoResumeTimers.has(inst.id)) {
        this._armAutoResume(inst);
      }
      // Temp sessions are disposable: once the subprocess is gone the
      // session is archived by _archiveTempSession() (the jsonl is retained
      // and stays resumable, just moved into the — archived — section), so
      // there's nothing live left to track here. Drop them from byId on
      // exit/crash so the sidebar's Temp Sessions subnode collapses instead
      // of piling up dim ghost rows the user would have to delete by hand.
      // `inst.temp` is read at event time, so a session promoted via
      // /promote (which flips temp=false) survives this path. `_suppressTempDelete`
      // is also checked here (not just in _handleExit's archive call) — a rewind's
      // kill-then-respawn passes through this same exited/crashed transition, and
      // without the guard the instance would vanish from byId before the respawn
      // lands, even though it was never archived on disk.
      if (inst.temp && !inst.proc && !inst._suppressTempDelete &&
          (summary.status === 'exited' || summary.status === 'crashed') &&
          this.byId.has(id)) {
        // Cancel any pending overage auto-resume before dropping the instance:
        // otherwise its wall-clock deadline outlives the session as an orphan
        // (and the badge would outlive the timer). Done while inst is still in
        // byId so cancel can clear its flags + emit the badge-drop status.
        this._cancelAutoResume(inst.id);
        this.byId.delete(id);
        this._purgeIdleFor(id);
        this.emit('list_changed');
      }
    });
    inst.on('snapshot_reset', (snap: { id: string }) => this.emit('snapshot_reset', snap));

    this.byId.set(id, inst);
    if (autoApprovePlan) inst.autoApprovePlan = true;
    // An explicit create-time value WINS over the persisted Settings default:
    // src/resumeRestart.ts carries a restored session's own recorded level, and
    // inheriting a since-changed default would silently up/downgrade it. With no
    // explicit value, a fresh conductor starts at the Settings default — read
    // live (the catalog does not cache), so it lands on the next spawn without a
    // server restart. Set before launch() below, so the first status frame — the
    // one the gate ledgers off — already carries it.
    if (playbookEnforcement) inst.playbookEnforcement = playbookEnforcement;
    else if (isConductorInstance(inst)) inst.playbookEnforcement = await getDefaultPlaybookEnforcement();
    // Fork prefill: the dropped prompt rides the new instance's first
    // `snapshot` frame (see Instance.consumePrefill / wsHub subscribe).
    if (typeof prefill === 'string') inst.pendingPrefill = prefill;
    if (publicId) {
      // Pin the public id BEFORE launch(), so the `!resume` mint guard there
      // stays untouched and the first status frame already carries it. The base
      // case (no lineage row) seeds a single-segment chain from the id itself,
      // which is exactly what the store models implicitly.
      inst.sessionId = publicId;
      const segs = (await segmentsFor(publicId)).map(seg => seg.id);
      inst._segments = segs.length > 0 ? segs : [resume as string];
    }
    await inst.launch({ resume });
    this.emit('list_changed');
    return inst;
  }

  // Overage auto-resume timer machine — see src/overageResume.ts. The manager
  // keeps these names/signatures and forwards to the controller (internal
  // callers + the overage tests reach for them on the manager).
  _armAutoResume(inst: Instance): void { return this._overageResume.arm(inst); }
  // Arm a resume deadline IMMEDIATELY, for a session with no turn→idle transition
  // for the status handler to arm on. Two callers, two reasons:
  //   - a QUEUED-ONLY session (idle/new — it queued a send while the window was
  //     active but was never stopped mid-work): it may already be idle;
  //   - an IDLE-PARKED conductor (`_directOverageStop` with midTurn false): it is
  //     never prompted and never interrupted, so it never transitions at all.
  // Deliberately touches NO preamble selector — `_overageWasStopped` /
  // `_overageWasIdleParked` are the caller's to set (queued-only leaves both false).
  _armResumeNow(inst: Instance, resetsAt: number | null): void {
    if (inst.autoResumeAt || this._autoResumeTimers.has(inst.id)) return; // already armed
    // A worker the stop left un-armed stays un-armed: its conductor is the sole
    // driver. Backstop — prompt() refuses such a send before it can queue, so this
    // guard only catches a future second queueing path.
    if (inst._overageStoppedUnarmed) return;
    inst._overageResetsAt = Number.isFinite(Number(resetsAt)) ? resetsAt : this._overageResetsAt;
    inst.autoStoppedForOverage = true; // so cancel/flush treats it like an armed session
    this._armAutoResume(inst);         // arm() re-checks the future-resetsAt safety rail
  }
  _armRestoredAutoResume(inst: Instance, fireAtMs: number): void { return this._overageResume.armRestored(inst, fireAtMs); }
  _runAutoResume(inst: Instance, instanceId: string): void { return this._overageResume.run(inst, instanceId); }
  _fireAutoResumeNow(instanceId: string): boolean { return this._overageResume.fireNow(instanceId); }
  _cancelAutoResume(instanceId: string): void { return this._overageResume.cancel(instanceId); }

  // Force-reevaluate every parked overage auto-resume session against the CURRENT
  // threshold — called after Settings → Models Apply raises/disables the threshold so
  // a session parked under the OLD bar doesn't wait out its full deadline (which can
  // be hours away, armed at window-reset). Reuses fireNow's usage-verified resolve
  // unchanged; a session still over the new bar just reschedules, exactly like a
  // normal sweep tick. Snapshot the keys first — fireNow synchronously deletes its own
  // timers entry before doing anything async, so iterating the live map would skip
  // entries.
  reevaluateOverageResumes(): void {
    for (const id of [...this._overageResume.timers.keys()]) {
      this._overageResume.fireNow(id);
    }
  }

  // Apply a CHANGED overage policy to sessions already marked under the old one.
  // The policy is live authority, not just trip-time input (card 2026-0231): the
  // moment it is no longer 'stop-resume', no session may carry a resumption mark.
  // Iterates byId, NOT _overageResume.timers: a session mid-verify (fireNow/_tick
  // delete their timers entry before awaiting fetchUsage) has no timer but is still
  // marked, and a session soft-interrupted but not yet at idle has
  // autoStoppedForOverage set with no deadline armed — clearing that flag is what
  // stops the status handler from arming it a moment later. No-op under 'stop-resume':
  // switching INTO it deliberately marks nothing (nothing records which sessions a
  // plain `stop` halted, and engaging the queue gate with no deadline to flush it
  // would strand every send) — it takes effect at the next trip.
  syncOveragePolicy(): void {
    if (getOnOverageAction() === 'stop-resume') return;
    // Kills the queue gate + the _reschedule lockout push. Leaves _overageActive and
    // the clear timer alone: the fleet lands exactly where a native `stop` trip leaves it.
    this._overageResumeMode = false;
    for (const inst of [...this.byId.values()]) {
      const queued = inst._overageQueue.length;
      if (!inst.autoResumeAt && !inst.autoStoppedForOverage && !queued &&
          !inst._overageStoppedUnarmed && !this._overageResume.timers.has(inst.id)) continue;
      this._overageResume.cancel(inst.id);  // deadline + every mark flag + queue, then status emit
      if (queued) {
        inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped', data: {
          reason: `overage handling changed — ${queued} queued message(s) dropped` } });
      }
    }
  }

  // Force the usage poller to tick NOW rather than at its next ~60s beat — the
  // stop-direction half of a Settings → Models Apply, whose release-direction half
  // is reevaluateOverageResumes above. Delegates into the composed
  // UsageOverageMonitor so callers never reach through to it.
  forceUsageTick(): Promise<unknown> { return this._usageMonitor.forceTick(); }

  // ---- Usage-window domain resolution (overage exemption seam) -------------
  // The ROOT of an instance's agent tree: walk `callerInstanceId` UPWARD through the
  // live registry until there is no parent to follow. The stop's unit is the TREE, so
  // membership must be asked of the whole tree — and `agentTreeBackends` only walks
  // DOWNWARD, which would answer for a subtree.
  //
  // Terminates in every degenerate shape rather than looping or throwing:
  //   - no `callerInstanceId`      → this instance IS the root (the common case);
  //   - a parent no longer in byId → stop at the deepest instance we can still see
  //     (a dead conductor's tree is not reconstructible, and its own gate is gone);
  //   - a cycle                    → the `seen` set breaks at the first repeat. Which
  //     member it lands on does not matter: `agentTreeBackends` is itself cycle-safe
  //     and reaches every member of a cycle from any of them, so all members get the
  //     same verdict.
  agentTreeRoot(inst: Instance): Instance {
    const seen = new Set<string>();
    let cur = inst;
    while (!seen.has(cur.id)) {
      seen.add(cur.id);
      if (!cur.callerInstanceId) break;
      const parent = this.byId.get(cur.callerInstanceId);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }

  // The set of backend IDS used across an instance's AGENT TREE: its own backend
  // plus every conducted-worker descendant (separate Instances linked by
  // `callerInstanceId`, each with its own backend). In-process Agent-tool
  // subagents run inside the parent CLI process — the backend (endpoint + auth)
  // is fixed at launch time, so they share the parent's backend and add nothing
  // new. Cycle-safe.
  //
  // DOWNWARD only, deliberately: it answers for the argument's own subtree. What
  // makes the exemption predicate tree-WIDE is `agentTreeRoot` above, applied at the
  // one call site in `_inUsageWindowFlow`.
  agentTreeBackends(inst: Instance): Set<string> {
    const backends = new Set<string>();
    const seen = new Set<string>();
    const stack: Instance[] = [inst];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur.id)) continue;
      seen.add(cur.id);
      backends.add(cur.backend ?? CLAUDE_BACKEND_ID);
      for (const child of this.byId.values()) {
        if (child.callerInstanceId === cur.id) stack.push(child);
      }
    }
    return backends;
  }

  // The usage-window domains the argument's OWN SUBTREE belongs to (it inherits
  // `agentTreeBackends`' downward-only walk). Root resolution lives in
  // `_inUsageWindowFlow`, not here — pushing it down would make
  // `usageWindowDomainsOf(worker)` report its conductor's domains, a lie about the
  // argument.
  usageWindowDomainsOf(inst: Instance): Set<string> {
    return new Set([...this.agentTreeBackends(inst)].map(usageDomainOfBackend));
  }

  // True iff the instance's ROOT agent tree touches a domain with an ACTIVE
  // usage-window monitor — the single predicate every STOP-SIDE decision consults
  // (routing's `live` filter, the per-instance gate, and everything the gate feeds).
  // That list is stop-side only, deliberately — the one RESUME-side consumer,
  // `resumeRestart.ts`'s restored-deadline re-arm, is excluded from it and carries
  // its own root-scoping note there.
  //
  // ROOT-SCOPED (card 2026-0212): the unit of stopping is the TREE, so
  // membership is resolved from the tree's root, not from the session. A tree with
  // no Claude agent → e.g. {ollama} → unmonitored → EXEMPT (never auto-stopped,
  // queued, or armed). A tree with any Claude agent → {anthropic} → in-flow — which
  // holds for a non-Claude conductor whose workers are Claude AND, because of the
  // root walk, for a non-Claude WORKER under a Claude conductor.
  //
  // Not the predicate for "did the monitored account emit this 429?" — see the
  // stop-vs-trip split at `_handleOverageTrip`.
  _inUsageWindowFlow(inst: Instance): boolean {
    for (const d of this.usageWindowDomainsOf(this.agentTreeRoot(inst))) {
      if (isMonitoredDomain(d)) return true;
    }
    return false;
  }

  // ---- Global overage auto-stop routing -----------------------------------
  // The central handler an Instance's `overage` signal lands in. One-shot per
  // rate-limit window via `_overageActive`. Honours getOnOverageAction():
  // 'none' does nothing at all (no flag flip, no routing). Otherwise it flips
  // the flag, routes the stop across every live instance, and arms the clear
  // timer so the flag releases when the window resets.
  _handleOverageTrip(inst: Instance | null, info: { resetsAt: number | null } | null | undefined): void {
    const action = getOnOverageAction();
    if (action === 'none') return;          // no flag flip, no routing
    // STOPPING is a TREE fact; TRIPPING is a per-session BACKEND fact. Do not unify
    // these two predicates — they answer different questions:
    //   - `_inUsageWindowFlow` (root-scoped) asks "is this session a member of a tree
    //     the stop must halt?" — the tree is the unit of stopping (card 2026-0212);
    //   - HERE we ask "did the monitored account emit this 429?", which only the
    //     EMITTING session's own backend can answer. An ollama-backed worker talks to
    //     the ollama endpoint, so its `rate_limit_event` reports ollama's window — it
    //     must not flip an anthropic lockout, even though its tree is in-flow because
    //     its conductor is Claude.
    // Strictly narrower than `_inUsageWindowFlow`: a claude-backed session is always a
    // member of its own root's tree, so this cannot admit a trip the root-scoped
    // predicate would reject. The narrowing also refuses a TRUE trip, not just false
    // ones: a custom backend that actually PROXIES the Anthropic endpoint gets a
    // namespaced `backend:<id>` domain, so its own `rate_limit_event` can no longer
    // trip the flow even in a mixed tree where a Claude ancestor previously admitted
    // it. Accepted because a proxy row is indistinguishable from any other custom
    // backend HERE: nothing at this site can tell which endpoint a launch template
    // dials. The other backstops are real but CONDITIONAL — do not read them as
    // cover. Identity-`claude` sessions' own events require such a session to exist,
    // which a pure-proxy fleet has none of. The account-global poll requires BOTH
    // the usage threshold to be ENABLED (strictly opt-in, `enabled:false` when
    // unset — `getOverageThreshold`, and `UsageOverageMonitor._tick` bails on it)
    // AND the proxy to drain the SAME account the poll watches (`getAccountUsage`
    // reads one fixed `~/.claude/.credentials.json` OAuth token, and a proxy row
    // often exists precisely to drain a different org). Default settings + an
    // all-proxy fleet ⇒ nothing trips at all.
    // The poll monitor passes inst=null (account-global) and is unaffected by either
    // predicate.
    if (inst && !isMonitoredDomain(usageDomainOfBackend(inst.backend))) return;
    if (this._overageActive) return;        // one-shot while active
    this._overageActive = true;
    this._overageResetsAt = info?.resetsAt ?? null;
    const resume = action === 'stop-resume';
    // Global queueing engages ONLY in stop-resume mode (it has a flush path).
    this._overageResumeMode = resume;
    this._routeOverageStop({ resume, resetsAt: this._overageResetsAt });
    this._armOverageClear(this._overageResetsAt);
  }

  // Route a single overage stop across all live instances. EVERY session it
  // touches gets `_directOverageStop` — nothing is sent to anything: the account is
  // throttled, so a message into it is exactly the burn the stop exists to prevent
  // (card 2026-0203). A mid-turn session is soft-interrupted; an idle one has no
  // turn to interrupt and is instead severed, marked, and armed for resume on the
  // spot.
  _routeOverageStop({ resume, resetsAt }: { resume: boolean; resetsAt: number | null }): void {
    // Exempt instances whose ROOT agent tree is purely in an unmonitored
    // usage-window domain (e.g. ollama-only): they consume no monitored account
    // window, so they are never stopped/marked. A Claude conductor's ollama-only
    // worker is NOT such a case — its root tree contains the conductor's `claude`,
    // so it is stopped along with the conductor (card 2026-0212).
    const live = [...this.byId.values()].filter(i => i.proc && this._inUsageWindowFlow(i));
    // Pass 1: resolve which conductors are in control and which workers they protect.
    const inControlConductors = new Map<string, Instance>();  // conductor id → conductor instance
    const protectedWorkers = new Set<string>(); // worker ids owned by an in-control conductor
    for (const inst of live) {
      if (!inst.conducted) continue;
      const conductor = this._ownerConductor(inst);
      const inControl = conductor && conductor.proc &&
        (conductor.status === 'turn' || this.isIdleCaller(conductor.id));
      if (inControl) {
        inControlConductors.set(conductor.id, conductor);
        protectedWorkers.add(inst.id);
      }
    }
    // Pass 2: stop each in-control conductor once (it owns ≥1 protected worker).
    // Mid-turn OR idle — `_directOverageStop` handles both, and the idle case is
    // reachable ONLY from here (Pass 3 skips anything not `status === 'turn'`).
    for (const conductor of inControlConductors.values()) {
      this._directOverageStop(conductor, { resume, resetsAt });
    }
    // Pass 3: stop every other mid-turn instance — plain sessions, conducted
    // workers (with or without an in-control conductor), and the Conduct
    // orchestrator when it has no in-control workers (it tripped itself, or its
    // workers were momentarily idle). Only Pass 2's conductors are skipped; their
    // workers are NOT: the conductor is not asked to halt them, so they are stopped
    // directly.
    //
    // ONE branch (card 2026-0189): a `.conduct` orchestrator is never `conducted`,
    // so it is never a protected worker ⇒ `unarmed` is false for it ⇒ it takes
    // exactly the arming the old conductor branch gave it, and `if (!unarmed)
    // continue` skips the owner-marking that does not apply.
    for (const inst of live) {
      if (inControlConductors.has(inst.id)) continue;
      if (inst.status !== 'turn') continue;
      // A worker owned by an in-control conductor is stopped but deliberately
      // left UN-ARMED: its conductor is the sole driver on resume (told so by
      // UNARMED_WORKERS_CLAUSE, src/overageResume.ts). Arming it too would have the
      // conductor's re-drive land mid-turn on a worker that just self-resumed —
      // the very mid-turn injection this whole path exists to avoid.
      const unarmed = protectedWorkers.has(inst.id);
      this._directOverageStop(inst, { resume, resetsAt, armResume: resume && !unarmed });
      // ASSIGNED, never latched: a later trip can find this worker un-protected
      // (its conductor gone, or idle with no wake armed), and a stale `true` then refuses
      // every send to an ordinary session that `Stop & resume` says should queue —
      // while the only thing that would clear it is the send it refuses. Worse, a
      // later trip can ARM it, leaving the refusal contradicting a resume timer
      // that demonstrably will fire.
      inst._overageStoppedUnarmed = unarmed;
      if (!unarmed) continue;
      // Its conductor is marked too: severForOverageStop only reports a severed
      // CALLBACK, and a conductor can own workers while holding no subscription.
      const owner = this._ownerConductor(inst);
      if (owner) owner._overageUnarmedWorkers = true;
    }
  }

  // The owning conductor of a conducted worker: callerInstanceId is the
  // conductor's instanceId, mapped back through the live registry — which is
  // exactly the key isIdleCaller() uses. Null when the conductor is gone.
  _ownerConductor(worker: Instance): Instance | null {
    const callerId = worker.callerInstanceId;
    if (!callerId) return null;
    return this.byId.get(callerId) ?? null;
  }

  // The ONE stop path, for every session routing touches — mid-turn or idle.
  // NOTHING is sent here: the account is throttled, so a message into it is the
  // burn the stop exists to prevent (card 2026-0203). For stop-resume, mark the
  // instance so its resume arms. `armResume` defaults to `resume` and splits off
  // only for a conductor's own worker, which is stopped un-armed.
  //
  // The event carries `armResume`, NOT the routing mode: `public/blocks.js` renders
  // `resume:true` as "auto-resuming at ⟨time⟩", which for an un-armed worker names
  // a resume that will never happen — and contradicts its own null `autoResumeAt`
  // badge.
  _directOverageStop(inst: Instance, { resume, resetsAt, armResume = resume }: { resume: boolean; resetsAt: number | null; armResume?: boolean }): void {
    // Read BEFORE the interrupt — which is the SOFT tier and changes no status
    // synchronously, but reading first makes that independent of the tier.
    const midTurn = inst.status === 'turn';
    if (armResume) {
      inst.autoStoppedForOverage = true;
      // The preamble selector: stopped mid-work gets "continue where you left off";
      // an already-idle session had nothing of its own interrupted and must not be
      // told otherwise (src/overageResume.ts → overageResumeKind).
      inst._overageWasStopped = midTurn;
      inst._overageWasIdleParked = !midTurn;
      inst._overageResetsAt = resetsAt;
    }
    inst._emitUi({ kind: 'system', subtype: 'auto_stop_overage', data: { resume: armResume, resetsAt } });
    this._severOverageWakes(inst);
    // Harmless no-op when the session is already idle: interrupt() returns
    // immediately on `status !== 'turn'`, so nothing reaches stdin and no status
    // frame is emitted. Pinned by tests/overage-action.test.mjs.
    // BOUNDED (see softInterruptDeadlineMs): no human is behind this stop, so an
    // arm that never reaches a boundary escalates instead of latching for the turn.
    inst.interrupt({ deadlineMs: softInterruptDeadlineMs() }).catch(() => {});
    // An idle session makes no turn→idle transition for the status handler to arm
    // on — and now that it is never prompted either, this is its ONLY arming. Armed
    // through the same controller entry point a queued-only session uses.
    if (armResume && !midTurn) this._armResumeNow(inst, resetsAt);
  }

  // Sever the idle-wake graph around a session, and MARK every caller that loses a
  // wait — marked, not notified: the mark only reaches a caller that has a resume
  // prompt of its own to carry it, which an un-armed or plain-`stop` caller does
  // not. The purge is bidirectional, so a third session waiting ON this one loses
  // its wait too and is marked as well.
  //
  // Why sever at all: a wake is an `internal:true` prompt, which the overage queue
  // intercept deliberately does NOT hold, so it would start a fresh turn inside the
  // lockout. TWO callers, both of which need it for a different reason:
  //   - `_directOverageStop` — the stopped session's own turn_end must wake nobody,
  //     and nothing may later wake it (including via the heartbeat, well inside a
  //     five-hour window, on a target Pass 3 left running).
  //   - `_guardOverageTurnStart` — spawn ownership SURVIVES purge(): `ownersOf`
  //     re-adds the parent from `callerInstanceId` on every call, so a severed
  //     worker whose turn starts again re-arms its conductor's wake at
  //     `onTurnStart`. Without severing here, the guard's own interrupt then wakes
  //     that conductor with an `internal:true` stub — violating 2026-0203 from
  //     inside 2026-0204.
  _severOverageWakes(inst: Instance): void {
    for (const callerId of this._idleHub.severForOverageStop(inst.id)) {
      const caller = this.byId.get(callerId);
      if (caller) caller._overageDroppedCallbacks = true;
    }
  }

  // Turn-start lockout guard (card 2026-0204). A turn that begins during an overage
  // stop-resume lockout is stopped rather than run against the throttled account —
  // wired at the turn-START seam rather than per send site, because the observed
  // defect was workers re-invoked by a path the enumerated sites did not cover.
  //
  // Every scope condition falls out of `_overageGate().active`, which is the single
  // owner of them: it ANDs `_overageActive`, `_overageResumeMode` (so plain `Stop` is
  // out), a FUTURE finite `resetsAt` (the safety rail), and the root-scoped
  // `_inUsageWindowFlow` (so a ROOT-exempt session is out — a non-Claude worker under
  // a Claude conductor is in, and this guard is its backstop).
  _guardOverageTurnStart(inst: Instance): void {
    if (!(inst._overageGate ? inst._overageGate().active : false)) return;
    // The auto-resume's own fire is the one turn that MUST run. Tested by FLAG, not
    // by re-deriving whether the lockout is still live at this instant: it may or may
    // not be, depending on the interleaving (see OverageResumeController.run).
    if (inst._overageResumeFiring) return;
    inst._emitUi({ kind: 'system', subtype: 'soft_interrupted', data: { text: OVERAGE_TURN_BLOCKED_TEXT } });
    this._severOverageWakes(inst);
    // SOFT tier — never force:true up front, but BOUNDED: this caller is automatic.
    inst.interrupt({ deadlineMs: softInterruptDeadlineMs() }).catch(() => {});
  }

  // Arm the global clear: release `_overageActive` when the rate-limit window
  // resets, so a later overage can trip again. Covers the plain-`stop` case
  // (no resume timer) and is the backstop for stop-resume too. Skips when
  // resetsAt is missing/past (the flag then clears only on manual resume).
  // ORCH_OVERAGE_RESUME_BUFFER_MS doubles as the test seam (shared with the
  // resume controller) so tests don't sleep out the wall clock.
  _armOverageClear(resetsAt: number | null): void {
    if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
    const atMs = Number(resetsAt) * 1000; // epoch seconds → ms
    if (!Number.isFinite(atMs)) return;
    const envBuf = Number(process.env.ORCH_OVERAGE_RESUME_BUFFER_MS);
    const bufMs = Number.isFinite(envBuf) ? envBuf : 5000;
    const delay = Math.max(0, atMs + bufMs - Date.now());
    // BACKSTOP only: fires _maybeReleaseOverageLock, which no-ops while any session
    // is still parked-and-rechecking (its resume verify drives the real release) and
    // clears only the "no session ever armed a deadline" case (e.g. plain `stop`, or
    // a stop-resume trip whose sole live session died before arming). This is the fix
    // for the old bug where the clock lifted the lockout at the ORIGINAL resetsAt while
    // sessions were still throttled: parked sessions keep timers, so this now no-ops.
    this._overageClearTimer = setTimeout(() => this._maybeReleaseOverageLock(), delay);
  }

  // Release the global overage lockout iff nothing is parked anymore — i.e. every
  // per-session resume has resolved (usage-verified resumed, failed-open resumed, or
  // torn down because the process vanished). Ties the global release to the SAME
  // usage-verified sweep that resumes sessions, so the lockout and the resumes can't
  // disagree. Called by the resume controller after each deadline-removing outcome
  // and by the clock backstop.
  _maybeReleaseOverageLock(): void {
    if (!this._overageActive) return;
    if (this._overageResume.timers.size > 0) return; // sessions still parked/rechecking
    // A session soft-interrupted for overage but not yet at idle (so no deadline armed
    // yet) will arm imminently — don't lift the lockout out from under it. This also
    // closes the backstop race when resetsAt is past/immediate: autoStoppedForOverage
    // is set synchronously at trip time, before the session round-trips to idle.
    for (const inst of this.byId.values()) {
      if (inst.proc && inst.autoStoppedForOverage) return;
    }
    this._clearOverage();
  }

  // Release the global overage one-shot and re-enable per-instance trip
  // detection. Called by the clear timer (window reset) and on manual resume of
  // an overage-stopped session.
  _clearOverage(): void {
    if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
    this._overageActive = false;
    this._overageResetsAt = null;
    this._overageResumeMode = false;
    // Drop the paused state everywhere: re-enable per-instance trip detection and
    // push a fresh summary for every session so composers that were showing the
    // paused banner (incl. not-yet-queued sessions surfacing it via the gate)
    // drop it now. Armed sessions with queued messages are flushed independently
    // by the resume sweep — this is just the banner/gate teardown.
    for (const inst of this.byId.values()) {
      inst._overageHandled = false;
      // The un-armed refusal's lifetime IS this window (overageSendRefused ANDs the
      // flag with gate.active), so the release ends it. Pass 3's per-trip assignment
      // cannot cover this: it sits behind `if (inst.status !== 'turn') continue`, so a
      // worker that is idle at the next trip is never visited. Left set, the flag
      // outlives its meaning twice over — `summary()` reports it ungated, and this
      // loop's own emit re-renders the composer with Send disabled under "messages
      // can't be queued here" while the server would accept that send; the human
      // cannot clear it, because the only per-session clear needs a successful
      // non-internal prompt and the button that would send one is the disabled one.
      inst._overageStoppedUnarmed = false;
      this.emit('status', inst.summary());
    }
  }

  async respawn(id: string): Promise<Instance> {
    const inst = this.byId.get(id);
    if (!inst) {
      throw httpError(404, 'instance not found');
    }
    if (inst.proc) {
      throw httpError(409, 'instance still running');
    }
    // A manual respawn supersedes any pending auto-resume for this session.
    this._cancelAutoResume(inst.id);
    const sessionId = inst.backingSessionId;
    if (!sessionId) {
      throw httpError(400, 'no sessionId to resume');
    }
    // Drop the prior run's events before loadHistory() replays the persisted
    // transcript into the ring — otherwise the replay piles up on top of the
    // existing conversation and every message renders twice.
    inst._wipeForResume();
    // Marks the relaunch window for isSessionLive (see the `_relaunching`
    // field comment) — `inst.proc` is already null on entry here (checked
    // above), so this whole call IS the coming-up window, not just a kill
    // prefix of it.
    inst._relaunching = true;
    try {
      await inst.launch({ resume: sessionId });
    } finally {
      inst._relaunching = false;
    }
    this.emit('list_changed');
    return inst;
  }

  async remove(id: string): Promise<void> {
    const inst = this.byId.get(id);
    if (!inst) {
      throw httpError(404, 'instance not found');
    }
    if (inst.proc) await inst.kill({ graceMs: 500 });
    // Independently of the kill: an instance can be removed with no live
    // process (it crashed, or it already exited), and its shell on the remote
    // system would then outlive every reference to the session that owns it.
    await inst._redirect?.close();
    this.byId.delete(id);
    this._cancelAutoResume(id);
    this._purgeIdleFor(id);
    this._sessionRenew.purge(id);
    this.emit('list_changed');
  }

  // Cascade-kill every instance attached to a project (including any
  // running inside worktrees of that project). Used by the
  // project-delete endpoint. Failures are swallowed — we're tearing
  // everything down anyway.
  async removeAllForProject(projectName: string): Promise<number> {
    const victims = [...this.byId.values()].filter(i => i.project === projectName);
    await Promise.all(victims.map(async (i) => {
      try { if (i.proc) await i.kill({ graceMs: 200 }); } catch { /* ignore */ }
      try { await i._redirect?.close(); } catch { /* ignore */ }
      this.byId.delete(i.id);
      this._cancelAutoResume(i.id);
      this._purgeIdleFor(i.id);
    }));
    if (victims.length > 0) this.emit('list_changed');
    return victims.length;
  }

  async shutdown(): Promise<void> {
    if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
    this._usageMonitor.stop();
    this._overageResume.clearAll();
    const all = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(all.map(i => i.kill({ graceMs: 200 }).catch(() => {})));
    // Every session's shell on a remote system, for the same reason remove()
    // does it: the process is on another machine and nothing else will reap it.
    await Promise.all(all.map(i => i._redirect?.close().catch(() => {})));
  }

  // Snapshot of live temp sessions keyed by what's needed to find their
  // on-disk jsonl: {cwd, sessionId}. Used by the restart path to write a
  // pending-cleanup manifest that the next boot can replay (defence in
  // depth against orphaned post-exit writes).
  tempCleanupSnapshot(): Array<{ cwd: string; sessionId: string }> {
    const out: Array<{ cwd: string; sessionId: string }> = [];
    for (const inst of this.byId.values()) {
      if (!inst.temp || !inst.backingSessionId) continue;
      out.push({ cwd: inst.cwd, sessionId: inst.backingSessionId });
    }
    return out;
  }

  // Synchronously kill every live temp subprocess and archive it: keep its
  // persisted jsonl, delete its sub-agent dir. The async `shutdown()` above
  // relies on subprocess `exit` events to fire `_archiveTempSession()`, which
  // races process.exit() during the restart path — so the restart path calls
  // this first to guarantee on-disk cleanup before we exit.
  //
  // SIGKILL (not SIGTERM) because claude's SIGTERM handler can flush one
  // last line to the jsonl, and the CLI opens it `O_APPEND|O_CREAT`, so a
  // post-`rmSync` write re-creates the file at the same path. SIGKILL is
  // unmaskable — once the kernel delivers it, the process can't write again.
  // We then block briefly until every targeted pid is reaped before deleting,
  // and wipe a second time as belt-and-braces.
  shutdownTempSync(): void {
    const temps: Instance[] = [];
    for (const inst of this.byId.values()) {
      if (!inst.temp) continue;
      temps.push(inst);
      if (inst.proc && inst.pid) {
        try { process.kill(inst.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }

    // Bounded sync wait for the SIGKILLed processes to actually be reaped.
    // Atomics.wait is Node's only non-spinning sync sleep primitive.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      let allDead = true;
      for (const inst of temps) {
        if (!inst.pid) continue;
        try { process.kill(inst.pid, 0); allDead = false; break; }
        catch { /* ESRCH = gone */ }
      }
      if (allDead) break;
      Atomics.wait(sab, 0, 0, 20);
    }

    // Remove subagent dirs (ephemeral; not needed for restore). The main
    // .jsonl is KEPT — we archive rather than delete. A double-wipe for
    // belt-and-braces against orphaned subagent writes is still correct here.
    const wipe = (): void => {
      for (const inst of temps) {
        if (!inst.backingSessionId) continue;
        try { rmSync(subAgentDirPath(inst.cwd, inst.backingSessionId), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };
    wipe();
    Atomics.wait(sab, 0, 0, 30);
    wipe();
    // Mark each session archived + unmark temp. Fire-and-forget — the sidecar
    // writes are async and the restart path is about to exit; if they don't
    // land in time the next boot's sweepPendingTempCleanup will pick up the
    // slack via the manifest (which now carries action:"archive").
    for (const inst of temps) {
      if (!inst.backingSessionId) continue;
      unmarkTemp(inst.backingSessionId).catch(() => {});
      markArchived(inst.backingSessionId).catch(() => {});
    }
  }

  // Resume-restart counterpart of shutdownTempSync: gracefully close every live
  // subprocess (temp AND non-temp) via stdin EOF — all turns are already done
  // before this is called, so no orphan can still be writing the jsonl we are
  // about to carry over. DO NOT delete any jsonl. Set `_suppressTempDelete`
  // first so each temp instance's _handleExit skips _archiveTempSession(),
  // preserving the transcript for `--resume` on boot.
  shutdownForResumeSync(): void {
    this._usageMonitor.stop();
    const live: Instance[] = [];
    for (const inst of this.byId.values()) {
      if (!inst.proc) continue;
      inst._suppressTempDelete = true;
      live.push(inst);
      // Graceful close: end stdin so the CLI exits normally when idle.
      // All turns are already complete before this is called (the drain
      // waits for all-idle), so the session JSONL is fully flushed.
      try { inst.proc.stdin?.end(); } catch { /* gone */ }
    }
    // Bounded sync wait for processes to exit after stdin close.
    // 2 s gives the CLI enough time to handle the EOF and exit cleanly.
    // Atomics.wait is Node's only non-spinning sync sleep primitive.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      let allDead = true;
      for (const inst of live) {
        if (!inst.pid) continue;
        try { process.kill(inst.pid, 0); allDead = false; break; }
        catch { /* ESRCH = gone */ }
      }
      if (allDead) break;
      Atomics.wait(sab, 0, 0, 20);
    }
  }

  // Enumerate the workers a conductor spawned via MCP, for the resume manifest's
  // injected worker list. Returns [{project, sessionId, worktreeName}] for every
  // live instance whose callerInstanceId matches and that has a sessionId —
  // `project` is required so the conductor can deterministically re-spawn each
  // worker via spawn_instance without reconstructing it from its transcript.
  conductedWorkersOf(conductorId: string): Array<{ project: string; sessionId: string; worktreeName: string | null }> {
    const out: Array<{ project: string; sessionId: string; worktreeName: string | null }> = [];
    for (const inst of this.byId.values()) {
      if (inst.callerInstanceId !== conductorId || !inst.sessionId) continue;
      out.push({
        project: inst.project,
        sessionId: inst.sessionId,
        worktreeName: inst.worktree?.worktreeName ?? null,
      });
    }
    return out;
  }

  // Live (proc-attached) instances spawned by conductorId, for the renewal
  // state block (src/sessionRenew.ts) — a safety net so a worker missing from
  // a degraded self-authored summary is never orphaned. Distinct from
  // conductedWorkersOf: this filters to LIVE only and carries `status`, since
  // the resume manifest's use case (any-with-sessionId, no status) differs.
  liveOwnedBy(conductorId: string): Array<{ sessionId: string | null; project: string; worktree: string | null; status: string }> {
    const out: Array<{ sessionId: string | null; project: string; worktree: string | null; status: string }> = [];
    for (const inst of this.byId.values()) {
      if (inst.id === conductorId) continue;
      if (inst.callerInstanceId !== conductorId || !inst.proc) continue;
      out.push({
        sessionId: inst.sessionId,
        project: inst.project,
        worktree: inst.worktree?.worktreeName ?? null,
        status: inst.status,
      });
    }
    return out;
  }
}

// Everything a relaunch needs to re-pull a remote project's session root, and
// everything the redirection policy needs to address the system. Held on the
// Instance because launch() runs long after create() resolved the handle.
export interface RedirectPlacement {
  system: RedirectableSystem;
  systemId: string;
  systemPath: string;
  project: string;
  worktree: string | null;
}
