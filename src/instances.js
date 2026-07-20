import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { promises as fsp, readFileSync, mkdirSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Parser, SOFT_INTERRUPT_MARKER, isOuterUserEcho, snapStartToQuiescent, firstQuiescentAtOrAfter } from './parser.js';
import { getProject, claudeProjectsRoot, encodeCwd, findSessionLocation, readFirstPrompt } from './projects.js';
import { createWorktree, getWorktree, debugBaseDir } from './worktrees.js';
import { getTitle as getSessionTitle, setTitle as setSessionTitle, deleteTitle as deleteSessionTitle } from './sessionTitles.js';
import { getOllamaSession, markOllamaSession, unmarkOllamaSession } from './sessionBackends.js';
import { preflightOllamaBackend } from './ollamaBackend.js';
import { isConducted, markConducted, unmarkConducted } from './conductedSessions.js';
import { SessionRenewController } from './sessionRenew.js';
import { isTemp, markTemp, unmarkTemp } from './tempSessions.js';
import { markArchived } from './archivedSessions.js';
import { CONDUCT_PROJECT_NAME } from './conduct.js';
import { buildSettingsJSON, buildMcpConfigJSON, AWAITING_INPUT_MESSAGE } from './settings.js';
import { getOnOverageAction, getOverageThreshold, getConductorCompactWindow, getSonnetContextWindow, getOllamaContextWindow } from './appSettings.js';
import { HookBroker } from './hookBroker.js';
import { loadPersistedTranscript, writeSessionMetadata, readLastSessionModel, hasResumableConversation } from './transcript.js';
import { canonicalizeModel, familyOf } from './modelVersions.js';
import { truncateSessionAtUserMessage } from './sessionEdit.js';
import { saveAttachment, isImageType } from './attachments.js';
import { buildApprovePrompt } from './planApproval.js';
import { reconstructTasks } from './taskReconstruct.js';
import { IdleSubscriptionHub } from './idleSubscriptions.js';
import { OverageResumeController } from './overageResume.js';
import { UsageOverageMonitor } from './usageOverageMonitor.js';
import { usageDomainOfBackend, isMonitoredDomain } from './usageWindowDomains.js';
import { defaultClaudeLauncher } from './claudeLauncher.js';

// `AUTO_RESUME_TEXT` now lives with the overage timer machine in
// overageResume.js; re-export it here so existing importers (and tests) that
// reach for `instances.js` keep resolving it unchanged.
export { AUTO_RESUME_TEXT } from './overageResume.js';

// Three user-facing modes:
//   - `plan`              — read-only planning; CLI is in plan mode
//   - `ask`               — full power but every destructive tool is gated
//                           by an interactive PreToolUse hook; CLI is in
//                           bypassPermissions
//   - `bypassPermissions` — full power, no gating; CLI is in bypassPermissions
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
const VALID_MODES = new Set(['plan', 'ask', 'bypassPermissions']);

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

// The hidden steering instruction a SOFT interrupt injects mid-turn. It
// tells the model to stop all work and wind down — a graceful stop, not a
// hard abort — but still asks for one brief visible line of acknowledgement:
// a fully silent turn makes the CLI inject a "no visible output" follow-up
// prompt that re-engages the model, defeating the interrupt. Prefixed with
// SOFT_INTERRUPT_MARKER at send time so it never renders / replays.
const SOFT_INTERRUPT_TEXT =
  'Stop now. Do not make any more tool calls or start any new work. Reply with one short line acknowledging you have stopped, then end your turn.';

// After a hard abort, the CLI's internal input queue is not cleared. Any
// messages written to stdin before the abort (the soft steer, or several
// prompts sent mid-turn) remain queued; the CLI dequeues them after the abort
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

// Steering message injected into the CONDUCTOR (never its workers) when an
// overage auto-stop fires. One frame — why (rate-limit crossed) + when (no new
// workers until the window resets) — with a single conditional clause: when the
// conductor still owns live in-control workers it's told to halt each of them
// itself (the orchestrator deliberately does NOT interrupt the workers
// directly); when it has nothing in flight (it tripped itself, or its workers
// were momentarily idle) that sentence is dropped so it isn't sent chasing
// phantom workers (which would waste a list_instances recon round-trip).
// Delivered mid-turn via windDown(), or as a fresh prompt() when the conductor
// is idle+subscribed.
function overageConductorSteerText({ hasWorkers }) {
  const halt = hasWorkers
    ? 'halt every worker you are conducting now — for each live worker call ' +
      '`mcp__code-conductor__interrupt_turn` (or `mcp__code-conductor__kill_instance` ' +
      'if it must be torn down), do not send them any more prompts, and then end ' +
      'your own turn'
    : 'end your own turn now (you have no workers in flight)';
  return '⚠️ An overage auto-stop just fired: the account has crossed its rate-limit ' +
    `threshold. STOP dispatching work and ${halt}. Do not start new workers ` +
    'until the rate-limit window has reset.';
}

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

// Returns true when a rate_limit_event signals the session is now using
// paid overage credits. Defensive: matches isUsingOverage at either
// nesting level (nested under rate_limit_info or flat on the event).
function isOverageEvent(data) {
  return data?.rate_limit_info?.isUsingOverage === true
      || data?.isUsingOverage === true;
}

// Normalise the rate-limit window reset time to epoch SECONDS, or null.
// The live `rate_limit_event` field is the camelCase epoch-seconds `resetsAt`
// (confirmed against a real CLI capture). The snake_case ISO `resets_at` (as in
// the account-usage payload / header.js's `new Date(bucket.resets_at)`) and a
// raw epoch number are accepted only as defensive fallbacks. The overage
// auto-resume timer (overageResume.js arm()) and the global clear timer both
// expect epoch seconds, so this is the single place the shape is reconciled.
export function parseResetEpochSecs(info) {
  const v = info?.resetsAt ?? info?.resets_at ?? null;
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null; // already epoch secs
  const ms = Date.parse(v);                                        // ISO-8601 string
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
// Start fresh instances in read-only plan mode by default. The user can pick
// `ask` or `code` (= bypassPermissions) in the new-instance dialog, or
// approve a plan to flip the running instance to bypassPermissions
// mid-session. **Resumes** default to `bypassPermissions` instead — a
// resume is almost always continuing real work rather than re-planning,
// so plan mode would be the wrong starting point.
const DEFAULT_MODE = 'plan';
const DEFAULT_RESUME_MODE = 'bypassPermissions';

// `ask` is orchestrator-only — the CLI itself doesn't know about it. At
// spawn / set_permission_mode time the CLI receives the equivalent
// bypassPermissions value; the orchestrator tracks `ask` separately and
// uses it to decide whether the interactive hook callback should prompt
// the user or auto-allow.
function cliPermissionMode(mode) {
  return mode === 'ask' ? 'bypassPermissions' : mode;
}
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';
const VALID_THINKING = new Set(['adaptive', 'enabled', 'disabled']);
const DEFAULT_THINKING = 'adaptive';

export function resolveClaudeBin() {
  // CLAUDE_BIN may be "node /path/to/script.mjs" so callers can swap in the
  // fake CLI used by tests; split on whitespace.
  const raw = (process.env.CLAUDE_BIN ?? 'claude').trim();
  const parts = raw.split(/\s+/);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

// Bounded drop-oldest event log per instance. `_seq` is stamped here at
// push time and stays monotonic for the life of the Instance — eviction
// never renumbers, so consumers keyed on `_seq` (WS client dedup,
// get_transcript({sinceSeq}), GET /api/instances/:id/events) survive
// trims. Evicted events remain reconstructable from the session jsonl
// (see src/eventArchive.js).
//
// Trimming is batched (amortized O(1) per push): once the buffer exceeds
// cap + slack, the front is spliced down to cap, then "snapped" forward so
// the surviving head is an outer user_echo — a turn boundary — which lets
// the jsonl-replay archive be cut against the retained ring with no
// overlap. When no echo is within cap/2 of the tail (a single giant turn
// spans the whole droppable region), the snap falls back to the nearest
// QUIESCENT point (whole blocks only — see parser.js) so the gap-case head
// still renders cleanly; only a giant non-quiescent span forces a plain cut.
const DEFAULT_RING_CAP = 2000;
const RING_TRIM_SLACK = 256;
// Max events sent in a WS `subscribe` snapshot (see Instance.snapshotTail).
// Matches the long-documented "500 events" figure, so sessions under 500
// events behave exactly as before. Override with ORCH_SNAPSHOT_TAIL.
const DEFAULT_SNAPSHOT_TAIL = 500;

export class EventLog {
  constructor({ cap } = {}) {
    const envCap = Number(process.env.ORCH_EVENT_RING_CAP);
    this.cap = Number.isInteger(cap) && cap > 0 ? cap
      : (Number.isInteger(envCap) && envCap > 0 ? envCap : DEFAULT_RING_CAP);
    // For tiny caps (tests) the trim trigger scales down with the cap.
    this.slack = Math.min(RING_TRIM_SLACK, this.cap);
    this.buf = [];
    this.nextSeq = 0;
  }
  // First retained `_seq` — everything below it was evicted (0 when
  // nothing was). Equals nextSeq for an empty ring.
  get trimmedBefore() { return this.buf.length ? this.buf[0]._seq : this.nextSeq; }
  push(v) {
    v._seq = this.nextSeq;
    this.nextSeq += 1;
    this.buf.push(v);
    if (this.buf.length > this.cap + this.slack) this._trim();
  }
  _trim() {
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
  toArray() { return this.buf.slice(); }
  clear() { this.buf.length = 0; this.nextSeq = 0; }
}

export class Instance extends EventEmitter {
  constructor({ id, project, cwd, mode, effort, thinking, model, backendKind = 'claude', hookCallbackUrl = null, mcpServerUrl = null, worktree = null, temp = false, conducted = false, callerInstanceId = null, debug = false, launcher = defaultClaudeLauncher }) {
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
    // `model` holds the concrete id for BOTH kinds: a Claude version id
    // ('claude-…', possibly with a [1m]/[200k] window suffix) or an Ollama tag
    // ('gemma4:cloud'). `backendKind` ('claude' | 'ollama') is the sole
    // discriminator — it selects the launch command; the claude args
    // (including --model) are built uniformly.
    this.model = model;
    this.backendKind = backendKind === 'ollama' ? 'ollama' : 'claude';
    this.hookCallbackUrl = hookCallbackUrl;
    this.mcpServerUrl = mcpServerUrl;
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
    this._pending = new Map(); // request_id -> { resolve, reject, timer }
    // Per-instance PreToolUse hook callback broker (held-open
    // responses + timeout fallbacks + the ask-mode permission_request
    // emission). See src/hookBroker.js.
    this._hooks = new HookBroker({
      getMode: () => this.mode,
      emit: (ev) => this._emitUi(ev),
    });
    this._stderr = '';
    this._lastLeafUuid = null;     // for last-prompt jsonl marker
    this._lastPlanFilePath = null; // last Write to ~/.claude/plans/*.md, used to enrich ExitPlanMode
    // Cached first user-prompt text (200-char cap matching readFirstPrompt
    // in projects.js). Surfaced via summary() so the sidebar can label a
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
    // Transient flag layered on top of `status: 'turn'`: set true when a
    // SOFT interrupt injects its hidden steering message and the model is
    // winding the turn down; cleared automatically by _setStatus on any
    // exit from `turn` (turn_end → idle, crash, exit). Drives the
    // "stopping…" marker + the "Interrupt now" escalate affordance.
    this.interrupting = false;
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
    // as an ollama launch failure. Reset to false on every spawn().
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
    // True when this session was genuinely stopped MID-WORK (direct interrupt /
    // conductor steer) vs. queued-only (idle/new session that queued while the
    // global window was active). Softens the resume preamble for queued-only —
    // buildCombinedResumeText drops "continue where you left off". Reset on
    // (re)spawn; persisted across a resume-restart.
    this._overageWasStopped = false;
    // Messages typed while auto-stopped-and-armed for overage resume are
    // QUEUED here (entries `{text, attachments, ts}`) instead of resuming the
    // still-throttled session; the auto-resume delivers them as one combined
    // prompt when the window-reset deadline fires. Reset on (re)spawn and
    // cleared on cancel/flush. Persisted across a resume-restart.
    this._overageQueue = [];
    // In-flight Agent-tool (subagent) tasks, keyed by task_id → tool_use_id.
    // Populated from the raw `system/task_started` event and cleared on a
    // terminal `system/task_updated` / `task_notification` (see the stdout
    // event loop in _handleStdoutLine). A backgrounded Agent call's tool_use
    // resolves immediately (`isAsync:true`), so `turn_end` can legitimately
    // fire while this is still non-empty — that's the whole point: `status`
    // stays the true process lifecycle value, while `summary().displayStatus`
    // (see below) overlays `running` for as long as this map is non-empty.
    // Reset on (re)spawn so a stale entry never survives a respawn/resume.
    this._activeAgentTasks = new Map();
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
    //             through verbatim by parser.js), then latched at turn_end.
    // MISS ⇔ read_N < P_{N-1} - tolerance: this turn served less of the prefix
    // than was demonstrably cached at the end of last turn ⇒ eviction (full OR
    // partial). Warm continuation reads exactly P_{N-1} (drop 0). Tolerance
    // (max(1024, 1% of P)) absorbs tokenization-boundary noise.
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
  }

  // Live count of in-flight background Agent-tool (subagent) tasks. Read by
  // IdleSubscriptionHub to defer the idle wake until a worker's turn
  // ends with no subagents still running. Mirrors summary().activeAgentTasks
  // without building the whole summary object.
  get activeAgentTaskCount() { return this._activeAgentTasks.size; }

  // True when a mid-turn task_notification is still unconsumed (so a
  // re-invocation turn is owed — see the _taskNotificationPending comment).
  // Read by IdleSubscriptionHub as a second defer reason alongside
  // activeAgentTaskCount.
  get taskNotificationPending() { return this._taskNotificationPending; }

  // True when the current idle window contains non-task-lifecycle activity
  // (see the _idleWindowDirty comment). Read by IdleSubscriptionHub to refuse
  // arming an idle task-drain settle.
  get idleWindowDirty() { return this._idleWindowDirty; }

  summary() {
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
      backendKind: this.backendKind,
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
      createdAt: this.createdAt,
      autoApprovePlan: this.autoApprovePlan,
      interrupting: this.interrupting,
      autoResumeAt: this.autoResumeAt,
      queuedCount: this._overageQueue.length,
      overageActive: !!gate.active,
      overageResetsAt: gate.active ? gate.resetsAt : null,
    };
  }

  setAutoApprovePlan(enabled) {
    const next = !!enabled;
    if (this.autoApprovePlan === next) return;
    this.autoApprovePlan = next;
    this.emit('status', this.summary());
  }

  // Update the cached custom session title and broadcast the new
  // summary so all subscribed clients re-render the active header chip.
  // Pass null/'' to clear. Callers (the PUT route, the resume hydration
  // path) are responsible for the sidecar write; this just updates the
  // in-memory mirror.
  setTitle(title) {
    const next = (typeof title === 'string' && title.trim()) ? title.trim() : null;
    if (this.title === next) return;
    this.title = next;
    this.emit('status', this.summary());
  }

  // Hydrate the in-memory title from the sidecar. Called after the
  // sessionId becomes known so the active header chip survives a
  // resume/respawn without the user re-typing.
  async _hydrateTitle() {
    if (!this.sessionId) return;
    try {
      const t = await getSessionTitle(this.sessionId);
      if (t && this.title !== t) {
        this.title = t;
        this.emit('status', this.summary());
      }
    } catch { /* sidecar read is best-effort */ }
  }

  ringSnapshot() { return this.ring.toArray(); }

  // Trailing slice of the ring for the WS `subscribe` snapshot — tabs no
  // longer receive the whole ring on every subscribe; older events are
  // lazy-loaded via GET /api/instances/:id/events. The window start is
  // snapped to a QUIESCENT point (no open block, no unresolved tool — see
  // snapStartToQuiescent in parser.js): the first one inside the window when
  // present, else the nearest one below it. A non-quiescent tail start would
  // strand a half block / a result-less tool across the isolated page
  // renderer and the live view. Quiescent points are dense, so the snap
  // normally moves a few events; the worst case (one giant non-quiescent
  // span) is the whole ring, same as the old whole-turn extension. The
  // helper also enforces sub-agent group integrity — an in-tail child pulls
  // its Task head (and thus the whole group so far) into the tail, which is
  // what keeps NESTED blocks whole; an evicted head advances the start past
  // its children (they are served later via lazy paging alongside their
  // head).
  snapshotTail(max) {
    const envMax = Number(process.env.ORCH_SNAPSHOT_TAIL);
    const cap = Number.isInteger(max) && max > 0 ? max
      : (Number.isInteger(envMax) && envMax > 0 ? envMax : DEFAULT_SNAPSHOT_TAIL);
    const buf = this.ring.buf;
    if (buf.length <= cap) return buf.slice();
    const start = snapStartToQuiescent(buf, buf.length - cap, buf.length);
    return buf.slice(start);
  }

  // Task-batch state as of `beforeSeq` — the in-flight batch that was open when
  // the snapshot tail begins. The client seeds its TaskTracker with this before
  // replaying the tail, so a batch whose TaskCreate sits below the tail still
  // shows the active panel (and completes correctly if it finishes inside the
  // tail). Reconstructed from the retained ring only: a create evicted below
  // the ring (created > cap events ago) is not recovered here — deep lazy pages
  // that load the jsonl archive reconstruct it instead.
  reconstructActiveTasks(beforeSeq) {
    const events = this.ring.buf.filter(ev => ev._seq < beforeSeq);
    return reconstructTasks(events).activeAtEnd;
  }

  // Open log files for the raw CLI streams when debug mode is on. Called
  // exactly once at the top of spawn(), before any data flows. Best-effort:
  // a failure here demotes the instance to non-debug rather than blocking
  // the spawn — the user is debugging, not depending on the logs.
  _openDebugStreams(args) {
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
        sessionId: this.sessionId,
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
        data: { line: `debug-mode setup failed: ${e.message}` } });
      this.debug = false;
      this.debugDir = null;
      this._debugStreams = null;
    }
  }

  _closeDebugStreams() {
    if (!this._debugStreams) return;
    for (const s of Object.values(this._debugStreams)) {
      try { s.end(); } catch { /* ignore */ }
    }
    this._debugStreams = null;
  }

  _debugLog(kind, line) {
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
  enableDebug() {
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

  _setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    // Any exit from `turn` ends an in-flight soft interrupt — the model
    // either wound down (turn_end → idle) or the process died.
    if (next !== 'turn') this.interrupting = false;
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
    }
    this.emit('status', this.summary());
  }

  _emitUi(ev) {
    const wrapped = { ...ev };
    // Every outer user_echo funnels through here (live prompt(), parser
    // queued-prompt echoes, jsonl replay), so this counter matches the
    // Nth-pure-user-prompt-line semantics sessionEdit.js truncates by.
    if (isOuterUserEcho(wrapped)) {
      wrapped.userIndex = this._userEchoCount;
      this._userEchoCount += 1;
    }
    this.ring.push(wrapped); // stamps wrapped._seq
    this.emit('event', wrapped);
  }

  // Track the model the CLI is actually running, live. `this.model` starts
  // as the spawn-time request but the CLI can switch models interactively
  // mid-session with no discrete event of its own — system/init (and
  // message_start) just start reporting a different id. Canonicalize before
  // comparing: the CLI reports a bare id, while this.model already carries
  // the [1m]/[200k] suffix from spawn-time canonicalization, so a raw-string
  // compare would false-positive on every single init.
  _trackModel(rawModel) {
    if (!rawModel) return;
    const canonical = canonicalizeModel(rawModel, { sonnetWindow: getSonnetContextWindow() });
    if (canonical === this.model) return;
    // Ollama's inner CLI reports its model bare, dropping the `:tag` suffix
    // (`ollama launch claude --model <tag>` still surfaces just the base name
    // in system/init and message_start). canonicalizeModel is a no-op for
    // non-Claude ids, so without this guard that bare report never matches
    // this.model and looks like a genuine switch — overwriting this.model
    // with the untagged id breaks the next resume's `ollama launch --model
    // <tag>` (spawn() refuses to launch without the tag).
    if (this.backendKind === 'ollama' && this.model && this.model.split(':')[0] === canonical) return;
    if (this.model) {
      const from = this.model;
      this.model = canonical;
      // The cache is model-specific, so a switch legitimately shrinks/invalidates
      // the prefix; re-baseline next turn instead of flagging a cross-turn miss.
      this._prefixBaselineInvalid = true;
      this._emitUi({ kind: 'system', subtype: 'model_changed', data: { from, to: canonical } });
    } else {
      // No explicit spawn-time model (account default) — this is discovery
      // of the resolved default, not a user-visible switch. Adopt silently.
      this.model = canonical;
    }
  }

  async loadHistory(sessionId) {
    const result = await loadPersistedTranscript({
      cwd: this.cwd, sessionId, seqHint: this.ring.nextSeq,
    });
    if (!result) return; // ENOENT or no sessionId — silent no-op.
    for (const line of result.lines) {
      for (const ev of line.events) this._emitUi(ev);
    }
    if (result.lastLeafUuid) this._lastLeafUuid = result.lastLeafUuid;
    if (result.replayedCount > 0) {
      this._emitUi({
        kind: 'system', subtype: 'history_replayed',
        data: { sessionId, count: result.replayedCount },
      });
    }
  }

  spawn({ resume } = {}) {
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
    this._overageQueue = [];
    // A fresh process starts with no in-flight Agent tasks — any entries
    // from a prior run's background subagents are gone with that process.
    this._activeAgentTasks = new Map();
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
    // Backend-agnostic launch: compute ONLY command + prefix from backendKind,
    // then append the SAME claude args (including --model) uniformly below.
    //   claude  → command from resolveClaudeBin(); prefix = its prefixArgs
    //             (empty in prod; the test CLAUDE_BIN="node fake.mjs" injection).
    //   ollama  → `ollama launch claude --model <tag> --yes --` as a drop-in
    //             substitute for `claude`. ollama sets the Anthropic endpoint +
    //             auth internally and re-injects --model into the child; the
    //             forwarded --model below is a matching no-op (verified). --yes
    //             bypasses the non-agent-capable confirmation (else a piped
    //             spawn fails). Localhost only — no host plumbing.
    const { command: claudeCmd, prefixArgs } = resolveClaudeBin();
    let command, launchPrefix;
    if (this.backendKind === 'ollama') {
      // Invariant: an ollama-backed instance always has a concrete tag in
      // `model` (resolver + resume-guard enforce it) — never emit `--model
      // undefined`.
      if (!this.model) {
        this._setStatus('crashed');
        throw new Error('ollama-backed spawn requires a model (tag); none resolved — rebind the tier or resume with an explicit model');
      }
      command = 'ollama';
      launchPrefix = ['launch', 'claude', '--model', this.model, '--yes', '--'];
    } else {
      command = claudeCmd;
      launchPrefix = prefixArgs;
    }
    if (resume) this.sessionId = resume;
    else if (!this.sessionId) this.sessionId = randomUUID();
    // Persist the temp marker at spawn time so it survives a SIGKILL that
    // happens before the first turn_end (where _writeSessionMetadata also
    // calls markTemp). Fire-and-forget — spawn() must stay synchronous.
    if (this.temp && this.sessionId) markTemp(this.sessionId).catch(() => {});
    // Persist the Ollama backend marker + tagged model durably (the two things
    // jsonl can't carry — kind, and the model TAG the inner CLI drops) so every
    // resume path re-acquires both. Runs on every spawn/resume, so a legacy
    // tag-unknown entry self-heals once this.model holds a real tag.
    if (this.backendKind === 'ollama' && this.sessionId) {
      markOllamaSession(this.sessionId, this.model).catch(() => {});
    }
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
      '--effort', this.effort,
      '--thinking', this.thinking,
      // PreToolUse hooks. The static `command` deny on
      // AskUserQuestion|ExitPlanMode replaces the old auto-interrupt +
      // marker-scrub plumbing. When a hookCallbackUrl is supplied, an
      // interactive `http` hook is ALSO registered for the destructive
      // tools — its behaviour at callback time depends on the
      // orchestrator-tracked mode (ask = prompt user, otherwise = allow).
      '--settings', buildSettingsJSON({ hookCallbackUrl: this.hookCallbackUrl }),
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
      // can identify it when it calls caller-dependent tools (subscribe_to_idle,
      // renew_session). The instanceId (NOT the sessionId) is used deliberately:
      // a managed /clear rotates the sessionId in place, but this URL is frozen in
      // the subprocess's --mcp-config for the life of the process — a baked
      // sessionId would go stale after the first renewal. The instanceId
      // never rotates; the MCP boundary resolves it to the caller's CURRENT
      // sessionId per request (see InstanceManager.callerSessionId / mcp/server.js).
      const url = `${this.mcpServerUrl}?caller=${encodeURIComponent(this.id)}`;
      args.push('--mcp-config', buildMcpConfigJSON({ url }));
    }
    // Each family runs at one fixed context window, pinned via the model id
    // itself (Sonnet carries the CLI-native `[1m]` suffix; Opus/Haiku are
    // bare — see canonicalizeModel in modelVersions.js). Strip any ambient
    // CLAUDE_CODE_DISABLE_1M_CONTEXT so a user-level export can't silently
    // downgrade our 1M Opus/Sonnet sessions to 200k.
    const spawnEnv = { ...process.env };
    delete spawnEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    // Ollama-backed sessions: honour the model's native context window so the
    // CLI auto-compacts at the real limit instead of its ~200k default. The
    // value is already a raw token count (unlike the conductor override below,
    // which stores k-tokens), so set it directly. A custom model with no
    // declared window resolves to null → leave the var unset (CLI default).
    // Runs for both fresh spawns and every resume path (single spawn() method;
    // backendKind + model are recovered before this block).
    if (this.backendKind === 'ollama' && this.model) {
      const cw = getOllamaContextWindow(this.model);
      if (cw) spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cw);
    }
    // Apply the compact-window override ONLY to the Conduct orchestrator session
    // (project === '.conduct'). Do NOT gate on this.conducted — that flag marks
    // MCP-spawned *worker* agents that the orchestrator spawns, which is the
    // opposite of the orchestrator session itself. The explicit conductor knob
    // wins over the Ollama window above when both apply.
    if (this.project === CONDUCT_PROJECT_NAME) {
      const cw = getConductorCompactWindow();
      if (cw.enabled) {
        spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cw.value * 1000);
      }
    }
    // Uniform --model append for BOTH kinds (no backendKind check). For ollama
    // this duplicates the launch-slot --model with the same value — a confirmed
    // no-op (ollama consumes its own copy and re-injects the tag).
    if (this.model) args.push('--model', this.model);
    if (resume) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);

    this._setStatus('spawning');
    this.parser.reset();
    // Remember the full launch argv so a later runtime enableDebug()
    // call can still write an accurate meta.json bundle.
    this._spawnArgv = [command, ...args];
    this._openDebugStreams(this._spawnArgv);

    this.proc = this._launcher.launch({ command, args, cwd: this.cwd, env: spawnEnv });
    this.pid = this.proc.pid;

    const outRl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    outRl.on('line', (line) => {
      this._debugLog('stdout', line);
      this._handleStdoutLine(line);
    });

    const errRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });
    errRl.on('line', (line) => {
      this._debugLog('stderr', line);
      this._stderr += line + '\n';
      this._emitUi({ kind: 'system', subtype: 'stderr', data: { line } });
    });

    this.proc.on('exit', (code, signal) => this._handleExit(code, signal));
    this.proc.on('error', (err) => {
      this._emitUi({ kind: 'system', subtype: 'spawn_error', data: { message: err.message } });
      this._setStatus('crashed');
    });

    // Real claude is silent until it receives the first user message — `init`
    // arrives bundled with the first turn's response, not at startup. So we
    // can't gate "ready to accept prompts" on init. As soon as the subprocess
    // is alive and stdin is writable, we're idle. If we're resuming, replay
    // the persisted transcript into the ring buffer first so the UI shows
    // prior history alongside the new live stream.
    (async () => {
      if (resume) {
        try { await this.loadHistory(this.sessionId); }
        catch (err) {
          this._emitUi({ kind: 'system', subtype: 'history_load_error', data: { message: err.message } });
        }
      }
      if (this.proc && this.proc.stdin.writable && this.status === 'spawning') {
        this._setStatus('idle');
      }
    })();
  }

  _handleStdoutLine(line) {
    const events = this.parser.handleLine(line);
    // Track the latest event uuid we've seen — used as the leaf marker we
    // append to the session jsonl so `claude --resume` from the shell can
    // discover this session in its interactive picker.
    let leafUuidThisLine = null;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.uuid === 'string') {
        leafUuidThisLine = obj.uuid;
      }
    } catch { /* ignore */ }
    if (leafUuidThisLine) this._lastLeafUuid = leafUuidThisLine;

    for (const ev of events) {
      // Idle-window dirty tracking (see the _idleWindowDirty comment):
      // evaluated BEFORE the event's own state mutations so it reflects the
      // status the event ARRIVED under. Any idle-time event that isn't pure
      // task bookkeeping dirties the window; turn_end below starts it clean.
      if (this.status === 'idle'
          && !(ev.kind === 'system' && TASK_LIFECYCLE_SUBTYPES.has(ev.subtype))) {
        this._idleWindowDirty = true;
      }
      if (ev.kind === 'system' && ev.subtype === 'init') {
        const sid = ev.data?.session_id;
        if (sid && sid !== this.sessionId) {
          this.sessionId = sid;
          this._hydrateTitle().catch(() => {});
        }
        const mode = ev.data?.permissionMode;
        if (mode && VALID_MODES.has(mode)) {
          // The CLI reports its own mode value ('plan' or
          // 'bypassPermissions'). Don't clobber the orchestrator-only
          // 'ask' label when the CLI says bypassPermissions — they're
          // CLI-equivalent and we own the higher-level distinction.
          if (!(mode === 'bypassPermissions' && this.mode === 'ask')) {
            this.mode = mode;
          }
        }
        this._trackModel(ev.data?.model);
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
        const reqRead = ev.usage.cache_read_input_tokens ?? 0;
        const reqCreation = ev.usage.cache_creation_input_tokens ?? 0;
        // Cross-turn cache-miss detection. The FIRST message_start of this turn
        // (the reset above/in _setStatus left `_turnFirstReqCacheRead` null)
        // decides; later message_starts only keep P (`_turnLastReqPrefix`)
        // current. The parser only emits message_start when usage is present
        // (src/parser.js), so ev.usage is always defined here.
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
            const data = { cacheRead: reqRead, cacheCreation: reqCreation };
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
      // friendly message: the deny ends the turn (verified: stop_reason
      // end_turn), so the plan_request / user_question card already emitted from
      // the tool-use surfaces and the orchestrator drives forward exactly as
      // before (subscribe_to_idle wakes on turn_end → approve_plan/reject_plan,
      // or questions via the next prompt). Holding the request open for an
      // in-turn answer would break that contract — no turn_end, so a conductor's
      // subscribe_to_idle never wakes. Any OTHER tool arriving here (rare —
      // --allow-dangerously-skip-permissions auto-allows normal tools, so they
      // don't reach can_use_tool) is allowed through unchanged.
      if (ev.kind === 'system' && ev.subtype === 'control_request'
          && ev.data?.request?.subtype === 'can_use_tool') {
        const req = ev.data.request;
        const gated = req?.tool_name === 'ExitPlanMode'
          || req?.tool_name === 'EnterPlanMode'
          || req?.tool_name === 'AskUserQuestion';
        const decision = gated
          ? { behavior: 'deny', message: AWAITING_INPUT_MESSAGE }
          : { behavior: 'allow', updatedInput: req?.input };
        try {
          this._sendRaw({
            type: 'control_response',
            response: { subtype: 'success', request_id: ev.data.request_id, response: decision },
          });
        } catch { /* stdin gone — CLI will time the permission out */ }
      }
      if (ev.kind === 'control_response') {
        const p = this._pending.get(ev.requestId);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(ev.requestId);
          if (ev.ok) p.resolve(ev.response);
          else p.reject(new Error(ev.error ?? 'control_request failed'));
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
        this._writeSessionMetadata().catch(() => {});
      }
      // Agent-tool (subagent) task lifecycle. `task_started` fires the moment
      // the tool_use dispatches — for a backgrounded call (`run_in_background:
      // true`) its tool_result resolves immediately, so `turn_end` above can
      // fire while the task is still running. Track it here so `summary()`
      // can report `displayStatus:'running'` through that window; a
      // foreground call's task_started/task_updated pair always resolves
      // before the model can reach turn_end, so this never affects the
      // ordinary idle case.
      if (ev.kind === 'system' && ev.subtype === 'task_started' && ev.data?.task_id) {
        const grew = this._activeAgentTasks.size === 0;
        this._activeAgentTasks.set(ev.data.task_id, ev.data.tool_use_id ?? null);
        if (grew) this.emit('status', this.summary());
      }
      if (ev.kind === 'system' && ev.subtype === 'task_updated' && ev.data?.task_id
          && TERMINAL_TASK_STATUSES.has(ev.data.patch?.status)) {
        if (this._activeAgentTasks.delete(ev.data.task_id) && this._activeAgentTasks.size === 0) {
          this.emit('status', this.summary());
        }
      }
      // Belt-and-suspenders: task_notification always carries a terminal
      // top-level `status` (it's the human/model-facing "it's done" ping),
      // so delete unconditionally here in case task_updated was ever missed
      // for a given completion. Map.delete is a no-op if already gone.
      if (ev.kind === 'system' && ev.subtype === 'task_notification' && ev.data?.task_id) {
        // A mid-turn notification MAY owe an unprompted re-invocation turn —
        // or may be consumed in-turn (sync-delivered / attached). Assume owed
        // until a delivery edge (top-level tool_result below, or the next
        // idle→turn transition) proves otherwise — see the
        // _taskNotificationPending comment for the full protocol model. A
        // completion while idle never sets it: the CLI dequeues immediately
        // and the re-invocation turn's start would clear it anyway.
        if (this.status === 'turn') this._taskNotificationPending = true;
        if (this._activeAgentTasks.delete(ev.data.task_id) && this._activeAgentTasks.size === 0) {
          this.emit('status', this.summary());
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
      // Track the most recent plan file the model wrote, so we can enrich
      // an upcoming ExitPlanMode plan_request with the saved plan text
      // when the model omits `plan` from the tool input.
      if (ev.kind === 'tool_use' && ev.name === 'Write' && typeof ev.input?.file_path === 'string') {
        const fp = ev.input.file_path;
        if (fp.includes('/.claude/plans/') && fp.endsWith('.md')) {
          this._lastPlanFilePath = fp;
        }
      }
      if (ev.kind === 'plan_request' && !ev.plan && this._lastPlanFilePath) {
        ev.planPath = this._lastPlanFilePath;
        try { ev.plan = readFileSync(this._lastPlanFilePath, 'utf8'); }
        catch { /* best-effort — UI will just show "(no plan content)" */ }
      }
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
      // Instance has no reference to the manager / idle-subscription graph, so
      // it can't make a conductor-aware stop decision — it just SIGNALS the
      // manager (`overage` emit), which owns the global one-shot flag and the
      // routing (see InstanceManager._handleOverageTrip). `_overageHandled`
      // throttles re-emits within a run; it's reset at spawn() and by the
      // resume controller on cancel/skip. The trip fires on the always-on
      // `isUsingOverage` hard flag OR the optional usage threshold (any window).
      if (ev.kind === 'system' && ev.subtype === 'rate_limit_event'
          && !this._overageHandled && this._isOverageTrip(ev.data)) {
        this._overageHandled = true;
        const resetsAt = parseResetEpochSecs(ev.data?.rate_limit_info) ?? parseResetEpochSecs(ev.data);
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
  _isOverageTrip(data) {
    if (isOverageEvent(data)) return true;
    const t = getOverageThreshold();
    if (!t.enabled) return false;
    const u = data?.rate_limit_info?.utilization;
    return typeof u === 'number' && u >= t.value / 100;
  }

  _fireAutoApprovePlan() {
    // Run after the current stdout line has finished dispatching so the
    // plan_request event reaches subscribers before the resulting mode
    // flip / user_echo / turn-start events do. ExitPlanMode's can_use_tool
    // request was denied in _handleStdoutLine (ending the turn), so we
    // drive the model forward with setMode + an explicit approval prompt —
    // same flow as a manual Approve click in the UI.
    queueMicrotask(async () => {
      try {
        if (!this.proc) return;
        if (this.mode === 'plan') await this.setMode('bypassPermissions');
        if (!this.proc) return;
        await this.prompt(buildApprovePrompt());
      } catch (err) {
        this._emitUi({ kind: 'system', subtype: 'stderr',
          data: { line: `auto-approve plan failed: ${err.message}` } });
      }
    });
  }

  async _writeSessionMetadata() {
    // Persist the durable temp + conducted markers BEFORE the temp early
    // return, so a temp session that survives SIGKILL recovers BOTH flags on
    // respawn (InstanceManager.create() OR-recovers them via isTemp/isConducted).
    // These only need sessionId, not the leaf uuid. The last-prompt /
    // permission-mode write below stays after the early return — it exists
    // only to surface a session in the shell-side `claude --resume` picker,
    // which temp sessions must not appear in.
    if (this.temp && this.sessionId) {
      try { await markTemp(this.sessionId); } catch { /* best effort */ }
    }
    if (this.conducted && this.sessionId) {
      try { await markConducted(this.sessionId); } catch { /* best effort */ }
    }
    if (this.temp) return;
    if (!this.sessionId || !this._lastLeafUuid) return;
    try {
      // Persist the CLI-level permission mode (not the orchestrator's
      // 'ask' label) so `claude --resume` from the shell can pick up
      // a valid value. The 'ask' nuance is orchestrator-only and
      // doesn't survive a shell-side resume — deliberate.
      await writeSessionMetadata({
        cwd: this.cwd,
        sessionId: this.sessionId,
        leafUuid: this._lastLeafUuid,
        permissionMode: cliPermissionMode(this.mode),
      });
    } catch { /* best effort */ }
  }

  _handleExit(code, signal) {
    this.pid = null;
    this.proc = null;
    this._closeDrainWindow();
    const crashed = !(code === 0 && !signal);
    this._emitUi({ kind: 'system', subtype: 'exit', data: { code, signal } });
    // An ollama-backed subprocess that crashed on its own (not a commanded
    // kill) is the silent-launch-failure case: `ollama launch claude …` died
    // — server gone, cloud-auth 401, etc. Surface it distinctly from the bare
    // `exit`, carrying the captured stderr so the reason is visible. Claude
    // exits and clean/commanded ollama exits are untouched.
    if (crashed && this.backendKind === 'ollama'
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
  async _archiveTempSession() {
    if (!this.sessionId) return;
    const dir = path.join(claudeProjectsRoot(), encodeCwd(this.cwd));
    const subagents = path.join(dir, this.sessionId);
    await fsp.rm(subagents, { recursive: true, force: true });
    try { await unmarkTemp(this.sessionId); } catch { /* best-effort */ }
    try { await markArchived(this.sessionId); } catch { /* best-effort */ }
  }

  _sendRaw(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('subprocess not writable');
    }
    const line = JSON.stringify(obj);
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
  async prompt(text, attachments = [], { annotateIfMidTurn = true, internal = false } = {}) {
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
    // manager's resume-cancel handler never runs. Internal prompts (idle-wake
    // stub, conductor steer, and the auto-resume's own send — which first clears
    // these flags via cancel) fall through and resume normally.
    const gate = this._overageGate ? this._overageGate() : { active: false, resetsAt: null };
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
    // A genuine (user/MCP-driven) prompt cancels a pending overage auto-resume —
    // the session is being driven again. Orchestrator-injected prompts
    // (`internal:true` — the idle-subscription wake stub, the conductor overage
    // steer, and the auto-resume's own send) must NOT cancel it and must skip the
    // global queue intercept above: the auto-resume already tore down its own
    // deadline via cancel() before sending, and the global window may still be
    // active when it fires.
    this.emit('user_prompt', { internal });
    const safeText = typeof text === 'string' ? text : '';
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!safeText.length && atts.length === 0) {
      throw new Error('prompt requires non-empty text or at least one attachment');
    }

    const content = [];
    const echoAttachments = [];
    if (safeText.length) content.push({ type: 'text', text: safeText });

    for (const a of atts) {
      if (!a || typeof a.name !== 'string' || typeof a.dataBase64 !== 'string') continue;
      const mediaType = typeof a.mediaType === 'string' ? a.mediaType : 'application/octet-stream';
      let saved;
      try { saved = await saveAttachment(this.project, this.worktree?.worktreeName ?? null, a); }
      catch (e) {
        this._emitUi({ kind: 'system', subtype: 'stderr', data: { line: `attachment save failed (${a.name}): ${e.message}` } });
        continue;
      }
      content.push({ type: 'text', text: `Attached file: \`${saved.promptPath}\`` });
      echoAttachments.push({
        kind: isImageType(mediaType) ? 'image' : 'file',
        name: a.name,
        mediaType,
        path: saved.promptPath,
        filename: saved.filename,
        // For the live user_echo bubble only — lets the frontend show
        // the thumbnail without a round-trip. Not written to the CLI's
        // stdin or the session jsonl. On replay/refresh the frontend
        // fetches the bytes from /api/instances/:id/attachments/<file>.
        dataBase64: isImageType(mediaType) ? a.dataBase64 : undefined,
      });
    }

    if (content.length === 0) {
      throw new Error('prompt requires non-empty text or at least one valid attachment');
    }

    // A real prompt is a genuine turn boundary — any Skill invocation still
    // awaiting its content injection is stale (see parser.js:attachSkillLoad).
    this.parser.expirePendingSkillLoads();
    this._emitUi({ kind: 'user_echo', text: safeText, attachments: echoAttachments });
    if (this.firstPrompt == null && safeText.length) {
      this.firstPrompt = safeText.slice(0, 200);
    }
    if (annotateIfMidTurn && this.status === 'turn') {
      content.unshift({ type: 'text', text: MID_TURN_NOTE });
    }
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    this._setStatus('turn');
  }

  // Drive a server-managed `/clear` on this session: send the slash command on
  // the SAME stdin path a user turn uses, which rotates the CLI's context in
  // place — a fresh sessionId, SAME OS process/pid, and the old jsonl preserved.
  // Deliberately bypasses prompt()'s user_echo + overage-queue intercept: this
  // is a server-internal control send, not a user turn. The rotation is picked
  // up by the system/init handler (which updates this.sessionId), and the
  // SessionRenewController reseeds the cleared session on the following
  // turn_end. See src/sessionRenew.js.
  clearContext() {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('not running');
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/clear' }] },
      parent_tool_use_id: null,
    });
    this._setStatus('turn');
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
  async carryMarkersAcrossRenewal(oldSid) {
    const newSid = this.sessionId;
    if (!newSid || !oldSid || newSid === oldSid) return;
    try { if (this.temp) await markTemp(newSid); } catch { /* best-effort */ }
    try { if (this.conducted) await markConducted(newSid); } catch { /* best-effort */ }
    try { if (this.title) await setSessionTitle(newSid, this.title); } catch { /* best-effort */ }
    try {
      if (this.backendKind === 'ollama') {
        await markOllamaSession(newSid, this.model);
        await unmarkOllamaSession(oldSid);
      }
    } catch { /* best-effort */ }
    try { await unmarkTemp(oldSid); } catch { /* best-effort */ }
    try { await markArchived(oldSid); } catch { /* best-effort */ }
  }

  async _controlRequest(request, { timeout = 5000 } = {}) {
    const requestId = randomUUID();
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error('control_request timeout'));
      }, timeout);
      this._pending.set(requestId, { resolve, reject, timer });
    });
    this._sendRaw({ type: 'control_request', request_id: requestId, request });
    return p;
  }

  async setMode(mode) {
    if (!VALID_MODES.has(mode)) throw new Error('invalid mode');
    await this._controlRequest({ subtype: 'set_permission_mode', mode: cliPermissionMode(mode) });
    this.mode = mode;
    this.emit('status', this.summary());
    this._writeSessionMetadata().catch(() => {});
    return this.mode;
  }

  async setModel(model, backendKind = 'claude') {
    // Live "Change model" sends a set_model control_request to the RUNNING
    // process, whose Anthropic endpoint + auth are fixed at launch time. Any
    // switch that involves Ollama (Claude↔Ollama, or Ollama↔Ollama) can't be
    // done live — refuse it with a clear message rather than a silently-broken
    // switch that keeps hitting the old model. Cross-kind kill+respawn is a
    // separate, later enhancement.
    if (this.backendKind === 'ollama' || backendKind === 'ollama') {
      throw Object.assign(
        new Error('Cannot change model live for an Ollama-backed session — kill and respawn on that tier.'),
        { statusCode: 409, code: 'BACKEND_KIND_LOCKED' },
      );
    }
    if (!model || !familyOf(model)) throw new Error('invalid model');
    await this._controlRequest({ subtype: 'set_model', model });
    this.model = model;
    this.emit('status', this.summary());
    this._writeSessionMetadata().catch(() => {});
    return this.model;
  }

  // Promote a temp session to a normal one: stop suppressing the
  // resume-picker metadata appends and stop the on-exit cleanup of
  // the jsonl. The jsonl itself was already being written by the CLI
  // — only the orchestrator's bookkeeping was opting out.
  async promoteToNormal() {
    if (!this.temp) throw Object.assign(new Error('instance is not temp'), { statusCode: 400 });
    this.temp = false;
    try { await unmarkTemp(this.sessionId); } catch { /* best-effort */ }
    // Persist last-prompt + permission-mode now, so the standalone
    // `claude --resume` picker sees this session immediately — without
    // waiting for the next turn-end / setMode cycle to trigger it.
    await this._writeSessionMetadata().catch(() => {});
    this.emit('status', this.summary());
    return this.summary();
  }

  // Thin delegate so callers (routes.js / wsHub.js) keep talking to
  // the Instance — the broker holds the actual state.
  handleHookCallback(envelope, res) { this._hooks.handle(envelope, res); }
  resolveHookCallback(toolUseId, allow) { return this._hooks.resolve(toolUseId, allow); }

  // Two-tier interrupt. FORCED (`force:true`) is the hard abort: a
  // control_request the CLI honours by severing the in-flight turn and
  // discarding partial work. SOFT (default) injects a hidden steering
  // user message mid-turn — the CLI delivers it into the live turn (it is
  // NOT queued until turn_end) — telling the model to stop all work and
  // end its turn after one brief acknowledgement line, so it winds down
  // gracefully without triggering the CLI's empty-turn follow-up. The steer
  // itself is never echoed to the UI as a user_echo (that would shift the
  // live userIndex rewind/fork keys off from the JSONL-derived count, which
  // deliberately excludes it — see isPureUserPromptLine in transcript.js).
  // Instead we emit a live system/soft_interrupted annotation carrying the
  // text, so the human sees what was said without affecting prompt indices.
  // JSONL replay independently produces the same bare annotation (no text)
  // via SOFT_INTERRUPT_MARKER filtering in parser.js / transcript.js.
  async interrupt({ force = false } = {}) {
    if (this.status !== 'turn') return;
    if (force) {
      await this._controlRequest({ subtype: 'interrupt' });
      // Open the drain window synchronously in the same microtask as the ACK.
      // Any system/init that follows (the CLI dequeuing its leftover input queue)
      // will be caught before the spurious API round-trip begins. Opening here
      // (not before the await) is safe because the CLI emits system/init only
      // AFTER the result/interrupted events that follow the control_response ACK.
      this._openDrainWindow();
      return;
    }
    if (this.interrupting) return; // idempotent — one steer per turn
    this._emitUi({ kind: 'system', subtype: 'soft_interrupted', data: { text: SOFT_INTERRUPT_TEXT } });
    this._sendRaw({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${SOFT_INTERRUPT_TEXT}\n${SOFT_INTERRUPT_MARKER}` }],
      },
      parent_tool_use_id: null,
    });
    this.interrupting = true;
    this.emit('status', this.summary());
  }

  // Like the SOFT path of interrupt() but with caller-supplied wind-down text
  // — used by the resume-restart drain so each instance gets a restart-specific
  // (and, for conductors, worker-aware) stop notice. The text is emitted as a
  // visible user_echo bubble so the human sees it in the transcript. The CLI
  // receives the message with SOFT_INTERRUPT_MARKER appended so the parser
  // drops it on JSONL replay after resume (no duplicate bubble in resumed
  // session). Mid-turn only; idempotent within a turn via `interrupting`.
  windDown(text) {
    if (this.status !== 'turn') return;
    if (this.interrupting) return;
    const body = typeof text === 'string' && text.trim() ? text : SOFT_INTERRUPT_TEXT;
    // Same turn-boundary rationale as prompt() above.
    this.parser.expirePendingSkillLoads();
    this._emitUi({ kind: 'user_echo', text: body });
    this._sendRaw({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${body}\n${SOFT_INTERRUPT_MARKER}` }],
      },
      parent_tool_use_id: null,
    });
    this.interrupting = true;
    this.emit('status', this.summary());
  }

  // Open a drain window after a hard abort. Attaches a one-time-per-event
  // listener on 'event' that watches for system/init — the earliest signal
  // that the CLI has dequeued a leftover message and started a spurious new
  // turn. On each hit, fires _controlRequest interrupt immediately (before
  // the API round-trip) and slides the window deadline so a queue of N
  // messages is fully drained. Closes automatically when the window elapses
  // with no new turn-start, or earlier when an explicit prompt() is called.
  _openDrainWindow() {
    this._closeDrainWindow(); // cancel any prior window
    let drainCount = 0;

    const onEvent = (ev) => {
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
      clearTimeout(this._drainTimer);
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

  _closeDrainWindow() {
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null; }
    if (this._drainListener) { this.off('event', this._drainListener); this._drainListener = null; }
  }

  async kill({ graceMs = 2000 } = {}) {
    if (!this.proc) return;
    // Mark this as a commanded teardown so _handleExit doesn't mistake the
    // resulting signalled exit for a spontaneous ollama launch crash.
    this._killing = true;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const proc = this.proc;
    await new Promise((resolve) => {
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
  async rewindToUserMessage(userMessageIndex) {
    if (this._mutating) {
      throw Object.assign(new Error('another rewind/fork is in progress'), { statusCode: 409 });
    }
    if (!this.sessionId) {
      throw Object.assign(new Error('no sessionId — instance has not yet received a turn'), { statusCode: 400 });
    }
    if (this.status === 'turn') {
      throw Object.assign(new Error('cannot rewind during a running turn — interrupt first'), { statusCode: 409 });
    }
    this._mutating = true;
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
        sessionId: this.sessionId,
        userMessageIndex,
        permissionMode: cliPermissionMode(this.mode),
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
        const dir = path.join(claudeProjectsRoot(), encodeCwd(this.cwd));
        await fsp.rm(path.join(dir, `${this.sessionId}.jsonl`), { force: true });
        await fsp.rm(path.join(dir, this.sessionId), { recursive: true, force: true });
        this.spawn({});
      } else {
        this.spawn({ resume: this.sessionId });
      }

      return { droppedText: result.droppedText };
    } finally {
      this._mutating = false;
    }
  }

  // Wipe in-memory state (ring buffer, parser, leaf marker, pending hook
  // resolutions) before a resume that will call loadHistory(). Without this,
  // a respawn into an instance that still has prior events would replay the
  // persisted transcript on top of the existing ring and every message would
  // render twice. Also broadcasts `snapshot_reset` so subscribed clients
  // clear their conversation DOM before the new replay starts streaming.
  _wipeForResume(extra = {}) {
    this.ring.clear();
    this._userEchoCount = 0;
    this.parser.reset();
    this._lastLeafUuid = null;
    this._lastPlanFilePath = null;
    this._hooks.discardAll();
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
  consumePrefill() {
    const t = this.pendingPrefill;
    this.pendingPrefill = null;
    return t;
  }

  // Snapshot frame used at rewind broadcast time. Mirrors the shape of the
  // `snapshot` WS frame so the client can apply it through the same path.
  _snapshotForReset() {
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

export class InstanceManager extends EventEmitter {
  constructor({ claudeLauncher = defaultClaudeLauncher } = {}) {
    super();
    this.byId = new Map();
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
    this._resuming = new Map();
    // Set by the server after `server.listen()` resolves. New instances
    // spawned without a port set get null hookCallbackUrl, which disables
    // the interactive http hook (ask mode falls back to auto-allow).
    this.serverPort = null;
    // Two self-contained subsystems composed as collaborators. Each owns its
    // backing state (the idle-subscription graph map / the auto-resume timer
    // map) and resolves cross-instance lookups + event emission back through
    // `this`. The manager keeps thin delegating methods (and live-map getters)
    // so every external caller sees an unchanged surface.
    this._idleHub = new IdleSubscriptionHub(this);
    this._overageResume = new OverageResumeController(this);
    // Managed session renewal (`renew_session` MCP tool): drives a server-side
    // `/clear` at the caller's turn_end and reseeds the rotated session with a
    // handoff summary. Keyed by instanceId so it tracks the caller across the
    // sessionId rotation `/clear` performs. See src/sessionRenew.js.
    this._sessionRenew = new SessionRenewController(this);
    // Server-side usage poller: a second, equal-footing source for the overage
    // auto-stop. The stream `rate_limit_event` only reports near Anthropic's own
    // ~90% threshold, so a LOW configured threshold (e.g. 25%) is invisible to
    // it — only a live usage poll sees it. The poller drives the SAME
    // `_handleOverageTrip` machinery (deduped via `_overageActive`). Its timer is
    // started by the server after listen() and stopped in both shutdown paths.
    this._usageMonitor = new UsageOverageMonitor(this);
    this.on('event', (e) => this._idleHub.onEvent(e));
    this.on('event', (e) => this._sessionRenew.onEvent(e));
    // Global overage auto-stop state. The decision moved off the per-Instance
    // handler (which can't reach the idle-subscription graph) up to here:
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

  // Idle-subscription graph — see src/idleSubscriptions.js. The manager keeps
  // these names/signatures and forwards to the hub so MCP handlers, wsHub, the
  // resume path, and tests see an unchanged surface.
  subscribeIdle(callerSessionId, targetSessionId, timeoutMs) {
    return this._idleHub.subscribe(callerSessionId, targetSessionId, timeoutMs);
  }
  unsubscribeIdle(callerSessionId, targetSessionId) {
    return this._idleHub.unsubscribe(callerSessionId, targetSessionId);
  }
  _idleSubscriberSnapshot() { return this._idleHub.snapshot(); }
  _purgeIdleFor(instanceId) { return this._idleHub.purge(instanceId); }
  // Sibling to _idleSubscriberSnapshot, but caller-indexed and sessionId-shaped
  // — which targets THIS instanceId (as caller) currently watches. Used by the
  // renewal state block (src/sessionRenew.js) to enumerate the caller's own
  // pending idle subscriptions.
  idleSubscriptionsOf(instanceId) { return this._idleHub.subscriptionsOf(instanceId); }

  // Managed session renewal — see src/sessionRenew.js. Arm a `/clear`+reseed
  // on the given instance; the controller fires at the instance's next turn_end.
  // No sessionId-rotation bookkeeping is needed: the idle-subscription graph and
  // overage timers are keyed by the stable instanceId, which `/clear` preserves.
  armSessionRenew(instanceId, opts) { return this._sessionRenew.arm(instanceId, opts); }

  // Returns true when a turn_notification for instanceId should be suppressed:
  //   Condition 1 — session is a conductor mid-orchestration (subscribed as caller
  //                 to a worker); isCaller() is reliable here because the caller's
  //                 subscription is only consumed when the TARGET finishes (its
  //                 turn_end or the idle task-drain settle) or times out.
  //   Condition 2 — session is a worker whose turn_end fired with a subscribed
  //                 conductor watching (whether it woke the conductor now or was
  //                 deferred pending the worker's background subagents);
  //                 wasConsumed() reads _justConsumed, populated in
  //                 IdleSubscriptionHub._onTurnEnd() before the defer check /
  //                 before subscribers clears, so the worker's ping stays
  //                 suppressed across the whole deferral. (The settle path never
  //                 marks it — no turn_notification exists at settle-fire time.)
  // ORDERING DEPENDENCY: the idle hub's 'event' listener (registered in the
  // InstanceManager constructor, instances.js) must run before wsHub's listener
  // (registered by attachWsHub in server.js). wasConsumed() is only valid during
  // the same synchronous dispatch cycle as the hub's turn_end handling. Do not
  // reorder those registrations without revisiting this method.
  shouldSuppressTurnNotification(instanceId) {
    if (this._idleHub.isCaller(instanceId)) return true;   // Condition 1
    if (this._idleHub.wasConsumed(instanceId)) return true; // Condition 2
    return false;
  }

  setServerPort(port) {
    this.serverPort = port;
  }

  hookCallbackUrl(id) {
    if (!this.serverPort) return null;
    return `http://127.0.0.1:${this.serverPort}/api/instances/${id}/hook-callback`;
  }

  // Auto-registered orchestrator MCP server URL. Returns the BASE URL (no
  // ?caller=) — Instance.spawn() appends the worker's own sessionId as the
  // caller suffix once it's known, so the MCP server can identify which worker
  // is calling (needed by subscribe_to_idle to route the turn_end callback).
  // Honours ORCH_DISABLE_MCP_AUTOREGISTER at call time.
  mcpServerUrl() {
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
  callerSessionId(handle) {
    if (!handle) return null;
    return this.byId.get(handle)?.sessionId ?? null;
  }

  hasIdleSubscriber(instanceId) { return this._idleHub.hasSubscriber(instanceId); }

  // Returns true when instanceId is the *caller* (conductor) in any pending
  // subscription — i.e. this instance is actively waiting for a worker to finish.
  isIdleCaller(instanceId) { return this._idleHub.isCaller(instanceId); }

  list() {
    return [...this.byId.values()].map(i => ({
      ...i.summary(),
      hasIdleSubscriber: this.isIdleCaller(i.id),
    }));
  }
  get(id) { return this.byId.get(id); }
  idsForProject(name) {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.id);
  }
  idsForWorktree(project, worktreeName) {
    return [...this.byId.values()]
      .filter(i => i.project === project && i.worktree?.worktreeName === worktreeName)
      .map(i => i.id);
  }
  sessionIdsForProject(name) {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.sessionId).filter(Boolean);
  }
  sessionIdsForWorktree(project, worktreeName) {
    return [...this.byId.values()]
      .filter(i => i.project === project && i.worktree?.worktreeName === worktreeName)
      .map(i => i.sessionId)
      .filter(Boolean);
  }
  idsForSession(sessionId) {
    return [...this.byId.values()]
      .filter(i => i.sessionId === sessionId)
      .map(i => i.id);
  }
  // The single live (proc-attached) instance for a sessionId, or null. Folds
  // the `idsForSession(sid).map(get).find(i => i && i.proc)` idiom scattered
  // across the MCP handlers + idle-callback delivery.
  liveForSession(sessionId) {
    return this.idsForSession(sessionId).map(id => this.byId.get(id)).find(i => i && i.proc) ?? null;
  }
  // Any instance (live or exited) for a sessionId, or null — the `.find(Boolean)`
  // counterpart used where a non-running instance is still a valid target.
  anyForSession(sessionId) {
    return this.idsForSession(sessionId).map(id => this.byId.get(id)).find(Boolean) ?? null;
  }
  // Resolve an MCP input that is either a full sessionId or an unambiguous PREFIX
  // to a canonical full sessionId. The MCP dispatch layer (src/mcp/server.js) uses
  // this to let conductors address workers by a short prefix (e.g. first 8 chars)
  // instead of the error-prone 36-char UUID. Universe = the distinct sessionIds
  // across ALL byId instances (live AND exited) — broader than live-only, so a
  // prefix unique among live workers but shared with an exited in-memory session
  // resolves AMBIGUOUS rather than silently mis-resolving. Historical disk-only
  // sessions are intentionally NOT in scope (they stay addressable by full id).
  // Returns one of:
  //   null                              → no match (caller leaves the arg untouched,
  //                                         so the handler's existing SESSION_UNKNOWN /
  //                                         SESSION_NOT_LIVE / disk-probe path runs)
  //   { sessionId }                     → exact full-id match (always wins), or a
  //                                         unique prefix >= SESSION_PREFIX_MIN chars
  //   { ambiguous:[fullIds], tooShort } → prefix matches >1 id, OR a too-short
  //                                         (< SESSION_PREFIX_MIN) prefix matches >=1
  resolveSessionRef(input) {
    if (typeof input !== 'string' || !input) return null;
    const all = [...new Set([...this.byId.values()].map(i => i.sessionId).filter(Boolean))];
    if (all.includes(input)) return { sessionId: input }; // exact match always wins
    const matches = all.filter(s => s.startsWith(input));
    if (matches.length === 0) return null;
    if (input.length < SESSION_PREFIX_MIN) return { ambiguous: matches, tooShort: true };
    if (matches.length === 1) return { sessionId: matches[0] };
    return { ambiguous: matches, tooShort: false };
  }
  // SessionIds of live (proc-attached) temp instances whose cwd matches.
  // Routes use this to strip running temp jsonls from the regular Sessions
  // list — otherwise clicking the row would 409 against the live instance.
  tempSessionIdsForCwd(cwd) {
    const out = new Set();
    for (const i of this.byId.values()) {
      if (i.temp && i.proc && i.cwd === cwd && i.sessionId) out.add(i.sessionId);
    }
    return out;
  }

  // Thin wrapper over _doCreate that serialises concurrent resumes of the same
  // session. The corruption-prevention checks live HERE, in the synchronous
  // prefix (no `await` before they run), so two concurrent resume calls — the
  // restart anchor auto-resume racing the manifest restore, or a manual
  // stop+resume — can't both slip past during the await gap _doCreate opens
  // before spawn() attaches `.proc`.
  create(opts = {}) {
    const { resume } = opts;
    if (!resume) return this._doCreate(opts);
    // Already fully live: a running instance owns this session. `claude
    // --resume <sid>` would otherwise race two subprocesses on one jsonl.
    const conflict = [...this.byId.values()].find(i => i.sessionId === resume && i.proc);
    if (conflict) {
      throw Object.assign(
        new Error(`session ${resume} is already attached to a running instance (${conflict.id.slice(0, 8)}…)`),
        { statusCode: 409 },
      );
    }
    // In-flight: a concurrent create() is already resuming this sid but hasn't
    // spawned yet (so the live-guard above can't see it). Coalesce onto that
    // promise — both callers get the same restored instance, one subprocess.
    const inflight = this._resuming.get(resume);
    if (inflight) return inflight;
    const p = this._doCreate(opts);
    this._resuming.set(resume, p);
    // Release when the create settles — success OR failure. On success `.proc`
    // is set, so the live-guard above covers subsequent resumes; on failure
    // (bad sid / spawn throw) we must clear the entry so it doesn't wedge
    // future resumes of this session.
    const release = () => { if (this._resuming.get(resume) === p) this._resuming.delete(resume); };
    p.then(release, release);
    return p;
  }

  async _doCreate({ project, resume, mode, effort, thinking, model, backendKind: explicitBackendKind, worktree, temp, conducted, callerInstanceId, debug, autoApprovePlan, prefill } = {}) {
    // On resume, when the caller didn't pin an explicit worktree, recover the
    // session's recorded project + worktree via findSessionLocation. This is
    // what makes spawn_instance({resume}) "just work" for an MCP conductor
    // that only knows the sessionId — and it's not cosmetic: spawn() below
    // launches the subprocess with this cwd, and the CLI derives the
    // transcript path from cwd, so a wrong cwd silently drops prior history
    // even though --resume <id> is passed correctly.
    if (resume && worktree === undefined) {
      const hit = await findSessionLocation(resume).catch(() => null);
      if (hit) {
        project = hit.project;
        if (hit.worktreeName) worktree = hit.worktreeName;
      }
    }
    if (!project) {
      throw Object.assign(new Error('project required'), { statusCode: 400 });
    }
    const proj = await getProject(project);
    // create() is policy-light: mode never depends on temp here. The UI's
    // temp⇒bypassPermissions shortcut is applied at the REST route
    // (POST /api/instances), not in this shared path.
    const defaultMode = resume ? DEFAULT_RESUME_MODE : DEFAULT_MODE;
    const finalMode = mode ?? defaultMode;
    if (!VALID_MODES.has(finalMode)) {
      throw Object.assign(new Error('invalid mode (must be plan, ask, or bypassPermissions)'), { statusCode: 400 });
    }
    const finalEffort = effort ?? DEFAULT_EFFORT;
    if (!VALID_EFFORTS.has(finalEffort)) {
      throw Object.assign(new Error('invalid effort'), { statusCode: 400 });
    }
    const finalThinking = thinking ?? DEFAULT_THINKING;
    if (!VALID_THINKING.has(finalThinking)) {
      throw Object.assign(new Error('invalid thinking'), { statusCode: 400 });
    }
    let finalModel = (typeof model === 'string' && model.trim()) ? model.trim() : null;

    // Backend kind (Claude vs Ollama) — the sole discriminator. `model` is a
    // plain id for BOTH kinds (Claude version id OR Ollama tag) and is NOT
    // cleared for ollama, so the canonicalize + jsonl model-recovery below
    // apply uniformly. Sources, in priority order:
    //   (a) explicit backendKind param — fresh spawn (client/handlers resolved
    //       the tier to {kind, model}) and restart-manifest restore.
    //   (b) resume with no explicit kind — the durable sidecar marks
    //       ollama-backed sessions (the one bit jsonl can't carry), covering UI
    //       resume / crash / anchor / respawn_instance uniformly.
    let backendKind = explicitBackendKind === 'ollama' ? 'ollama' : 'claude';
    if (!explicitBackendKind && resume) {
      try {
        const backend = await getOllamaSession(resume);
        if (backend.ollama) {
          backendKind = 'ollama';
          // The backend store carries the FULL tagged model; the jsonl only
          // holds the CLI's bare (tag-stripped) report. Prefer the store's tag
          // — this is what stops `deepseek-v4-flash:cloud` resuming as the
          // unpullable tagless `deepseek-v4-flash`. A null (legacy) entry falls
          // through to the readLastSessionModel jsonl recovery below.
          if (!finalModel && backend.model) finalModel = backend.model;
        }
      } catch { /* best-effort */ }
    }

    // Optional worktree attachment:
    //   worktree === true  → create a fresh worktree off the parent's HEAD
    //   worktree === '<existingName>' → spawn into the named existing worktree
    //   omitted/null/false → normal spawn at proj.path
    let worktreeMeta = null;
    let cwd = proj.path;
    if (worktree === true) {
      worktreeMeta = await createWorktree(project);
      cwd = worktreeMeta.worktreePath;
    } else if (typeof worktree === 'string' && worktree.trim()) {
      worktreeMeta = await getWorktree(project, worktree.trim());
      if (!worktreeMeta) {
        throw Object.assign(new Error(`worktree '${worktree}' not found under project '${project}'`), { statusCode: 404 });
      }
      cwd = worktreeMeta.worktreePath;
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

    // Re-derive the context-window suffix from the family + the user's Sonnet
    // window preference (Sonnet → '1m' or '200k'; Opus/Haiku always bare).
    // A no-op for a non-Claude id (familyOf(tag) === null → returned unchanged),
    // so this runs uniformly for both backend kinds.
    if (finalModel) finalModel = canonicalizeModel(finalModel, { sonnetWindow: getSonnetContextWindow() });

    // Null-model guard (note 1): an ollama-backed session with no resolvable
    // model — e.g. a resume whose jsonl is empty/corrupt so readLastSessionModel
    // returned nothing — must fail clearly here rather than emit `--model
    // undefined` at spawn.
    if (backendKind === 'ollama' && !finalModel) {
      throw Object.assign(
        new Error('ollama-backed session has no resolvable model (tag) — rebind the tier or resume with an explicit model'),
        { statusCode: 422, code: 'OLLAMA_MODEL_MISSING' },
      );
    }

    // Reachability preflight for ollama-backed launches — fail here with a clear
    // diagnostic instead of spawning into a silent `ollama launch` death. Runs
    // for fresh spawns AND every resume path (backendKind was recovered above),
    // before the Instance is created so a failure leaves nothing to unwind.
    // No-op for Claude backends (zero added latency).
    await this._preflightBackend(backendKind, finalModel);

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
    // manifest-driven restart-resume path (resumeRestart.js), which seeds it
    // from its own in-memory snapshot, every OTHER resume (a UI "resume dead
    // session" click, crash/anchor auto-resume, respawn_instance) had nothing
    // recovering it, so the next prompt()'s fallback-when-null guard
    // (see prompt() below) would clobber the label with whatever was just
    // typed. `--resume` does not fork history into a new jsonl (verified:
    // same sessionId, same file, across a real resume) — the original file
    // still holds the true first line, so this is reliable.
    let recoveredFirstPrompt = null;
    if (resume) {
      try { recoveredFirstPrompt = await readFirstPrompt(path.join(claudeProjectsRoot(), encodeCwd(cwd), `${resume}.jsonl`)); }
      catch { /* best-effort */ }
    }

    const id = randomUUID();
    const inst = new Instance({
      id, project, cwd,
      mode: finalMode, effort: finalEffort, thinking: finalThinking, model: finalModel,
      backendKind,
      hookCallbackUrl: this.hookCallbackUrl(id),
      // Base MCP URL (no ?caller=) — the per-worker caller suffix is appended in
      // Instance.spawn() once the sessionId is known.
      mcpServerUrl: this.mcpServerUrl(),
      worktree: worktreeMeta,
      temp: !!temp,
      conducted: conductedFlag,
      callerInstanceId: callerInstanceId ?? null,
      debug: !!debug,
      launcher: this._claudeLauncher,
    });
    if (recoveredFirstPrompt) inst.firstPrompt = recoveredFirstPrompt;

    inst.on('event', (ev) => this.emit('event', { id, ev }));
    // The Instance signals (rather than self-handles) an overage trip — central
    // routing lives on the manager where the idle-subscription graph is reachable.
    inst.on('overage', (info) => this._handleOverageTrip(inst, info));
    // Live GLOBAL-overage gate, injected as a small callback (not a manager ref).
    // active ⇒ this session must queue every non-internal send. SAFETY RAIL: only
    // engages when the window is active in stop-resume mode AND there is a valid
    // FUTURE resetsAt with an armed clear timer — a queued send bypasses the
    // manual-resume clear path, so a missing/past/NaN resetsAt must mean
    // active:false (sends flow normally) or every session would lock out forever.
    inst._overageGate = () => {
      const resetsAt = this._overageResetsAt;
      const atMs = Number(resetsAt) * 1000;
      // `_inUsageWindowFlow(inst)` keeps an exempt (e.g. Ollama-only) session out
      // of the gate: its sends flow normally AND its summary reports
      // overageActive:false, so no overage/queued badge shows (summary() derives
      // overageActive/overageResetsAt from this same gate).
      const active = this._overageActive && this._overageResumeMode &&
        Number.isFinite(atMs) && atMs > Date.now() && this._inUsageWindowFlow(inst);
      return { active, resetsAt: active ? resetsAt : null };
    };
    // A queued-only (idle/new) session signals it needs a resume deadline armed
    // immediately — it has no mid-turn→idle transition for the status handler to
    // arm on.
    inst.on('overage_queued', (info) => this._armQueuedOnly(inst, info?.resetsAt));
    // A user/MCP-driven turn cancels any pending overage auto-resume. If the
    // turn is a manual takeover of an overage-stopped session, it also clears
    // the global overage flag so the stop can trip again. Capture the flag
    // BEFORE cancel (which resets it). Orchestrator-injected prompts
    // (`internal` — idle-subscription wake, conductor overage steer) skip this:
    // they must not discard a pending resume armed for an overage-stopped
    // session (the auto-resume's own fire sends a non-internal prompt, so its
    // teardown still runs).
    inst.on('user_prompt', (meta) => {
      if (meta?.internal) return;
      const wasOverageStopped = inst.autoStoppedForOverage;
      this._cancelAutoResume(inst.id);
      if (wasOverageStopped && this._overageActive) this._clearOverage();
    });
    inst.on('status', (summary) => {
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
    inst.on('snapshot_reset', (snap) => this.emit('snapshot_reset', snap));

    this.byId.set(id, inst);
    if (autoApprovePlan) inst.autoApprovePlan = true;
    // Fork prefill: the dropped prompt rides the new instance's first
    // `snapshot` frame (see Instance.consumePrefill / wsHub subscribe).
    if (typeof prefill === 'string') inst.pendingPrefill = prefill;
    inst.spawn({ resume });
    this.emit('list_changed');
    return inst;
  }

  // Overage auto-resume timer machine — see src/overageResume.js. The manager
  // keeps these names/signatures and forwards to the controller (internal
  // callers + the overage tests reach for them on the manager).
  _armAutoResume(inst) { return this._overageResume.arm(inst); }
  // Arm a resume deadline for a queued-only session (idle/new — it queued a send
  // while the global window was active but was never stopped mid-work). The
  // status→idle arm path can't fire for it, so arm here off the window reset.
  // Leaves `_overageWasStopped` false so the resume preamble stays softened.
  _armQueuedOnly(inst, resetsAt) {
    if (inst.autoResumeAt || this._autoResumeTimers.has(inst.id)) return; // already armed
    inst._overageResetsAt = Number.isFinite(Number(resetsAt)) ? resetsAt : this._overageResetsAt;
    inst.autoStoppedForOverage = true; // so cancel/flush treats it like an armed session
    this._armAutoResume(inst);         // arm() re-checks the future-resetsAt safety rail
  }
  _armRestoredAutoResume(inst, fireAtMs) { return this._overageResume.armRestored(inst, fireAtMs); }
  _runAutoResume(inst, instanceId) { return this._overageResume.run(inst, instanceId); }
  _fireAutoResumeNow(instanceId) { return this._overageResume.fireNow(instanceId); }
  _cancelAutoResume(instanceId) { return this._overageResume.cancel(instanceId); }

  // Force-reevaluate every parked overage auto-resume session against the CURRENT
  // threshold — called after Settings → Models Apply raises/disables the threshold so
  // a session parked under the OLD bar doesn't wait out its full deadline (which can
  // be hours away, armed at window-reset). Reuses fireNow's usage-verified resolve
  // unchanged; a session still over the new bar just reschedules, exactly like a
  // normal sweep tick. Snapshot the keys first — fireNow synchronously deletes its own
  // timers entry before doing anything async, so iterating the live map would skip
  // entries.
  reevaluateOverageResumes() {
    for (const id of [...this._overageResume.timers.keys()]) {
      this._overageResume.fireNow(id);
    }
  }

  // ---- Usage-window domain resolution (overage exemption seam) -------------
  // The set of backend kinds used across an instance's AGENT TREE: its own
  // backend plus every conducted-worker descendant (separate Instances linked by
  // `callerInstanceId`, each with its own backendKind). In-process Agent-tool
  // subagents run inside the parent CLI process — the backend (endpoint + auth)
  // is fixed at `ollama launch claude` / `claude` launch time, so they share the
  // parent's backend and add no new kind. Cycle-safe.
  agentTreeBackends(inst) {
    const kinds = new Set();
    const seen = new Set();
    const stack = [inst];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur.id)) continue;
      seen.add(cur.id);
      kinds.add(cur.backendKind === 'ollama' ? 'ollama' : 'claude');
      for (const child of this.byId.values()) {
        if (child.callerInstanceId === cur.id) stack.push(child);
      }
    }
    return kinds;
  }

  // The usage-window domains an instance's agent tree belongs to.
  usageWindowDomainsOf(inst) {
    return new Set([...this.agentTreeBackends(inst)].map(usageDomainOfBackend));
  }

  // True iff the instance's agent tree touches a domain with an ACTIVE
  // usage-window monitor — the single predicate the overage stop/resume flow
  // consults. A purely-Ollama tree → {ollama} → unmonitored → EXEMPT (never
  // auto-stopped, queued, or armed). A tree with any Claude agent → {anthropic}
  // → in-flow (holds even for an Ollama conductor whose workers are Claude).
  _inUsageWindowFlow(inst) {
    for (const d of this.usageWindowDomainsOf(inst)) {
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
  _handleOverageTrip(inst, info) {
    const action = getOnOverageAction();
    if (action === 'none') return;          // no flag flip, no routing
    // Domain scoping: a stream `rate_limit_event` from a purely-Ollama session
    // belongs to the (unmonitored) ollama domain and must NOT trip the anthropic
    // flow. The poll monitor passes inst=null (account-global) and is unaffected.
    if (inst && !this._inUsageWindowFlow(inst)) return;
    if (this._overageActive) return;        // one-shot while active
    this._overageActive = true;
    this._overageResetsAt = info?.resetsAt ?? null;
    const resume = action === 'stop-resume';
    // Global queueing engages ONLY in stop-resume mode (it has a flush path).
    this._overageResumeMode = resume;
    this._routeOverageStop({ resume, resetsAt: this._overageResetsAt });
    this._armOverageClear(this._overageResetsAt);
  }

  // Route a single overage stop across all live instances. Steer-first: a
  // conductor that owns an in-control conducted worker is steered to halt its
  // own workers (and the worker is left untouched), which takes precedence over
  // the generic direct-interrupt — otherwise a mid-turn conductor would be
  // plain-interrupted as an "active session" before it could be told to stop
  // its workers. Everything else still mid-turn gets a direct soft-interrupt.
  _routeOverageStop({ resume, resetsAt }) {
    // Exempt instances whose agent tree is purely in an unmonitored usage-window
    // domain (e.g. Ollama-only): they consume no monitored account window, so
    // they are never stopped/steered/marked. A Claude conductor with an
    // Ollama-only worker keeps the worker running and stops the conductor.
    const live = [...this.byId.values()].filter(i => i.proc && this._inUsageWindowFlow(i));
    // Pass 1: resolve which conductors to steer and which workers they protect.
    const steerConductors = new Map();  // conductor id → conductor instance
    const protectedWorkers = new Set(); // worker ids owned by a steered conductor
    for (const inst of live) {
      if (!inst.conducted) continue;
      const conductor = this._ownerConductor(inst);
      const inControl = conductor && conductor.proc &&
        (conductor.status === 'turn' || this.isIdleCaller(conductor.id));
      if (inControl) {
        steerConductors.set(conductor.id, conductor);
        protectedWorkers.add(inst.id);
      }
    }
    // Pass 2: steer each in-control conductor once (it owns ≥1 protected worker).
    for (const conductor of steerConductors.values()) {
      this._steerConductor(conductor, { resume, resetsAt, hasWorkers: true });
    }
    // Pass 3: stop every other mid-turn instance — plain sessions, conducted
    // workers with NO in-control conductor (dead / idle-unsubscribed → fallback),
    // and the Conduct orchestrator when it has no in-control workers (it tripped
    // itself, or its workers were momentarily idle). The orchestrator ALWAYS gets
    // the graceful conductor steer — it's the brain that reconstructs state on
    // resume, so the terse leaf-worker soft-interrupt is semantically wrong for
    // it; hasWorkers is false here because any in-control workers would have
    // routed it through Pass 2 above. Skips steered conductors and their workers.
    for (const inst of live) {
      if (steerConductors.has(inst.id) || protectedWorkers.has(inst.id)) continue;
      if (inst.status !== 'turn') continue;
      if (inst.project === CONDUCT_PROJECT_NAME) {
        this._steerConductor(inst, { resume, resetsAt, hasWorkers: false });
      } else {
        this._directOverageStop(inst, { resume, resetsAt });
      }
    }
  }

  // The owning conductor of a conducted worker: callerInstanceId is the
  // conductor's instanceId, mapped back through the live registry — which is
  // exactly the key isIdleCaller() uses. Null when the conductor is gone.
  _ownerConductor(worker) {
    return (worker.callerInstanceId && this.byId.get(worker.callerInstanceId)) || null;
  }

  // Direct soft-interrupt path (the preserved pre-refactor behavior). For
  // stop-resume, mark the instance so the status handler arms its per-session
  // resume timer on the resulting turn→idle transition.
  _directOverageStop(inst, { resume, resetsAt }) {
    if (resume) {
      inst.autoStoppedForOverage = true;
      inst._overageWasStopped = true; // genuinely stopped mid-work → full preamble
      inst._overageResetsAt = resetsAt;
    }
    inst._emitUi({ kind: 'system', subtype: 'auto_stop_overage', data: { resume, resetsAt } });
    inst.interrupt().catch(() => {});
  }

  // Steer a conductor (never its workers) to halt the work it's conducting.
  // Mid-turn → windDown (visible, soft); idle+subscribed → inject a fresh
  // prompt, same shape as the idle-subscription wake stub. For `stop-resume`
  // BOTH branches arm a resume: the conductor is the orchestrating brain, so
  // resuming it after the window resets re-drives its workers (the protected
  // worker is intentionally left un-armed). Resume is armed via the
  // autoStoppedForOverage flag, which the status→idle handler turns into a
  // per-session timer.
  _steerConductor(conductor, { resume, resetsAt, hasWorkers }) {
    const steerText = overageConductorSteerText({ hasWorkers });
    if (conductor.status === 'turn') {
      if (resume) {
        conductor.autoStoppedForOverage = true;
        conductor._overageWasStopped = true; // stopped mid-work → full preamble
        conductor._overageResetsAt = resetsAt;
      }
      conductor.windDown(steerText);
    } else {
      // `internal:true` so the steer's user_prompt doesn't cancel the resume we
      // arm next; set the flags AFTER the call regardless, so the steer turn's
      // turn→idle transition arms the timer (same mechanism as the windDown
      // branch above).
      conductor.prompt(steerText, [], { internal: true }).catch(() => {});
      if (resume) {
        conductor.autoStoppedForOverage = true;
        conductor._overageWasStopped = true; // stopped mid-work → full preamble
        conductor._overageResetsAt = resetsAt;
      }
    }
    conductor._emitUi({ kind: 'system', subtype: 'auto_stop_overage', data: { resume, resetsAt, steered: true } });
  }

  // Arm the global clear: release `_overageActive` when the rate-limit window
  // resets, so a later overage can trip again. Covers the plain-`stop` case
  // (no resume timer) and is the backstop for stop-resume too. Skips when
  // resetsAt is missing/past (the flag then clears only on manual resume).
  // ORCH_OVERAGE_RESUME_BUFFER_MS doubles as the test seam (shared with the
  // resume controller) so tests don't sleep out the wall clock.
  _armOverageClear(resetsAt) {
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
  _maybeReleaseOverageLock() {
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
  _clearOverage() {
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
      this.emit('status', inst.summary());
    }
  }

  // Ollama-only reachability + model-availability preflight, run before any
  // subprocess is launched. No-op (zero added latency) for Claude backends, so
  // it never touches the common spawn path. On failure it THROWS a shaped error
  // (mirroring the null-model guard's style) so both surfaces render the reason:
  // REST via next(e) → HTTP 503; MCP via server.js's catch → isError with the
  // "Ollama not reachable at …" / "not found" prose. Reuses the same
  // preflightOllamaBackend the add-custom-model route uses.
  async _preflightBackend(backendKind, model) {
    if (backendKind !== 'ollama') return;
    const pre = await preflightOllamaBackend({ model });
    if (!pre.ok) {
      throw Object.assign(new Error(pre.error),
        { statusCode: 503, code: 'OLLAMA_PREFLIGHT_FAILED' });
    }
  }

  async respawn(id) {
    const inst = this.byId.get(id);
    if (!inst) {
      throw Object.assign(new Error('instance not found'), { statusCode: 404 });
    }
    if (inst.proc) {
      throw Object.assign(new Error('instance still running'), { statusCode: 409 });
    }
    // A manual respawn supersedes any pending auto-resume for this session.
    this._cancelAutoResume(inst.id);
    if (!inst.sessionId) {
      throw Object.assign(new Error('no sessionId to resume'), { statusCode: 400 });
    }
    // An ollama-backed respawn with Ollama down must fail clearly too — check
    // before _wipeForResume() so a failed preflight never discards history.
    await this._preflightBackend(inst.backendKind, inst.model);
    // Drop the prior run's events before loadHistory() replays the persisted
    // transcript into the ring — otherwise the replay piles up on top of the
    // existing conversation and every message renders twice.
    inst._wipeForResume();
    inst.spawn({ resume: inst.sessionId });
    this.emit('list_changed');
    return inst;
  }

  async remove(id) {
    const inst = this.byId.get(id);
    if (!inst) {
      throw Object.assign(new Error('instance not found'), { statusCode: 404 });
    }
    if (inst.proc) await inst.kill({ graceMs: 500 });
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
  async removeAllForProject(projectName) {
    const victims = [...this.byId.values()].filter(i => i.project === projectName);
    await Promise.all(victims.map(async (i) => {
      try { if (i.proc) await i.kill({ graceMs: 200 }); } catch { /* ignore */ }
      this.byId.delete(i.id);
      this._cancelAutoResume(i.id);
      this._purgeIdleFor(i.id);
    }));
    if (victims.length > 0) this.emit('list_changed');
    return victims.length;
  }

  async shutdown() {
    if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
    this._usageMonitor.stop();
    this._overageResume.clearAll();
    const all = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(all.map(i => i.kill({ graceMs: 200 }).catch(() => {})));
  }

  // Snapshot of live temp sessions keyed by what's needed to find their
  // on-disk jsonl: {cwd, sessionId}. Used by the restart path to write a
  // pending-cleanup manifest that the next boot can replay (defence in
  // depth against orphaned post-exit writes).
  tempCleanupSnapshot() {
    const out = [];
    for (const inst of this.byId.values()) {
      if (!inst.temp || !inst.sessionId) continue;
      out.push({ cwd: inst.cwd, sessionId: inst.sessionId });
    }
    return out;
  }

  // Synchronously kill every live temp subprocess and delete its persisted
  // jsonl + sub-agent dir. The async `shutdown()` above relies on subprocess
  // `exit` events to fire `_archiveTempSession()`, which races process.exit()
  // during the restart path — so the restart path calls this first to
  // guarantee on-disk cleanup before we exit.
  //
  // SIGKILL (not SIGTERM) because claude's SIGTERM handler can flush one
  // last line to the jsonl, and the CLI opens it `O_APPEND|O_CREAT`, so a
  // post-`rmSync` write re-creates the file at the same path. SIGKILL is
  // unmaskable — once the kernel delivers it, the process can't write again.
  // We then block briefly until every targeted pid is reaped before deleting,
  // and wipe a second time as belt-and-braces.
  shutdownTempSync() {
    const temps = [];
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
    const wipe = () => {
      for (const inst of temps) {
        if (!inst.sessionId) continue;
        const dir = path.join(claudeProjectsRoot(), encodeCwd(inst.cwd));
        try { rmSync(path.join(dir, inst.sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
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
      if (!inst.sessionId) continue;
      unmarkTemp(inst.sessionId).catch(() => {});
      markArchived(inst.sessionId).catch(() => {});
    }
  }

  // Resume-restart counterpart of shutdownTempSync: gracefully close every live
  // subprocess (temp AND non-temp) via stdin EOF — all turns are already done
  // before this is called, so no orphan can still be writing the jsonl we are
  // about to carry over. DO NOT delete any jsonl. Set `_suppressTempDelete`
  // first so each temp instance's _handleExit skips _archiveTempSession(),
  // preserving the transcript for `--resume` on boot.
  shutdownForResumeSync() {
    this._usageMonitor.stop();
    const live = [];
    for (const inst of this.byId.values()) {
      if (!inst.proc) continue;
      inst._suppressTempDelete = true;
      live.push(inst);
      // Graceful close: end stdin so the CLI exits normally when idle.
      // All turns are already complete before this is called (the drain
      // waits for all-idle), so the session JSONL is fully flushed.
      try { inst.proc.stdin.end(); } catch { /* gone */ }
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
  conductedWorkersOf(conductorId) {
    const out = [];
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
  // state block (src/sessionRenew.js) — a safety net so a worker missing from
  // a degraded self-authored summary is never orphaned. Distinct from
  // conductedWorkersOf: this filters to LIVE only and carries `status`, since
  // the resume manifest's use case (any-with-sessionId, no status) differs.
  liveOwnedBy(conductorId) {
    const out = [];
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
