import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { promises as fsp, readFileSync, mkdirSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Parser, SOFT_INTERRUPT_MARKER, isOuterUserEcho, snapStartToGroupBoundary } from './parser.js';
import { getProject, claudeProjectsRoot, encodeCwd, findSessionLocation } from './projects.js';
import { createWorktree, getWorktree, debugBaseDir } from './worktrees.js';
import { getTitle as getSessionTitle, deleteTitle as deleteSessionTitle } from './sessionTitles.js';
import { isConducted, markConducted, unmarkConducted } from './conductedSessions.js';
import { isTemp, markTemp, unmarkTemp } from './tempSessions.js';
import { markArchived } from './archivedSessions.js';
import { CONDUCT_PROJECT_NAME } from './conduct.js';
import { buildSettingsJSON, buildMcpConfigJSON, AWAITING_INPUT_MESSAGE } from './settings.js';
import { getOnOverageAction, getOverageThreshold, getConductorCompactWindow, getSonnetContextWindow } from './appSettings.js';
import { HookBroker } from './hookBroker.js';
import { loadPersistedTranscript, writeSessionMetadata, readLastSessionModel } from './transcript.js';
import { canonicalizeModel } from './modelVersions.js';
import { truncateSessionAtUserMessage } from './sessionEdit.js';
import { saveAttachment, isImageType } from './attachments.js';
import { buildApprovePrompt } from './planApproval.js';
import { reconstructTasks } from './taskReconstruct.js';
import { IdleSubscriptionHub } from './idleSubscriptions.js';
import { OverageResumeController } from './overageResume.js';
import { UsageOverageMonitor } from './usageOverageMonitor.js';

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

// Minimum length for a sessionId PREFIX to be eligible for resolution (see
// InstanceManager.resolveSessionRef). An exact full-id match bypasses this floor;
// it only guards non-exact prefixes against absurdly short, fragile matches
// (a 1–3 char hit that the next spawn could collide with). Uniqueness within the
// in-memory universe remains the real guard — this is just a sanity floor.
export const SESSION_PREFIX_MIN = 4;

// The hidden steering instruction a SOFT interrupt injects mid-turn. It
// must forbid any further output and direct the model to end its turn
// silently — a graceful stop, not a hard abort. Prefixed with
// SOFT_INTERRUPT_MARKER at send time so it never renders / replays.
const SOFT_INTERRUPT_TEXT =
  'Stop now. Do not make any more tool calls. End your turn immediately. And don\'t reply in any way.';

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

// Steering message injected into a CONDUCTOR (not its workers) when an overage
// auto-stop fires while the conductor is in control of conducted workers. The
// orchestrator deliberately does NOT interrupt the workers directly — the
// conductor owns them, so it must wind them down itself. Delivered mid-turn via
// windDown(), or as a fresh prompt() when the conductor is idle+subscribed.
const OVERAGE_CONDUCTOR_STEER_TEXT =
  '⚠️ An overage auto-stop just fired: the account has crossed its rate-limit ' +
  'threshold. STOP dispatching work and halt every worker you are conducting ' +
  'now — for each live worker call `mcp__code-conductor__interrupt_turn` (or ' +
  '`mcp__code-conductor__kill_instance` if it must be torn down), do not send ' +
  'them any more prompts, and then end your own turn. Do not start new workers ' +
  'until the rate-limit window has reset.';

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
// overlap. Snapping gives up (plain cut) rather than drop below cap/2,
// e.g. when a single giant turn spans the whole droppable region.
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
    if (cut >= maxIdx) cut = base; // no turn boundary in range — plain cut
    this.buf.splice(0, cut);
  }
  toArray() { return this.buf.slice(); }
  clear() { this.buf.length = 0; this.nextSeq = 0; }
}

export class Instance extends EventEmitter {
  constructor({ id, project, cwd, mode, effort, thinking, model, hookCallbackUrl = null, mcpServerUrl = null, worktree = null, temp = false, conducted = false, callerInstanceId = null, debug = false }) {
    super();
    this.id = id;
    this.project = project;
    this.cwd = cwd;
    this.mode = mode;
    this.effort = effort;
    this.thinking = thinking;
    this.model = model;
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
    // Post-hard-abort drain window: timer handle + listener for killing
    // spurious turns the CLI starts from its leftover input queue after a
    // hard abort. Both null when the window is closed. See _openDrainWindow.
    this._drainTimer = null;
    this._drainListener = null;
    // Set true by the resume-restart path before SIGKILL so _handleExit
    // skips _archiveTempSession() — the temp jsonl must survive to be
    // resumed on the next boot. Never persisted.
    this._suppressTempDelete = false;
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
  }

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
      sessionId: this.sessionId,
      status: this.status,
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
  // snapped forward to the first outer user_echo inside it (a turn
  // boundary) so the initial render doesn't begin mid-message; if the
  // window holds no echo (one giant turn), the plain slice is sent and the
  // client renders the partial turn as-is.
  snapshotTail(max) {
    const envMax = Number(process.env.ORCH_SNAPSHOT_TAIL);
    const cap = Number.isInteger(max) && max > 0 ? max
      : (Number.isInteger(envMax) && envMax > 0 ? envMax : DEFAULT_SNAPSHOT_TAIL);
    const buf = this.ring.buf;
    if (buf.length <= cap) return buf.slice();
    let start = buf.length - cap;
    for (let i = start; i < buf.length; i++) {
      if (isOuterUserEcho(buf[i])) { start = i; break; }
    }
    // Group-integrity snap: ensure the snapshot never begins with sub-agent
    // child events whose owning tool-call head is absent from the window.
    //   - Head present in ring before start → pull start back to include it.
    //   - Head evicted (not in ring) → advance start past all children of
    //     that group; they will be served later via lazy paging alongside
    //     their head from the combined archive+ring.
    start = snapStartToGroupBoundary(buf, start, buf.length);
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
    if (this.model) {
      const from = this.model;
      this.model = canonical;
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
    // Clear any overage auto-stop/resume state from a prior run — a fresh
    // process can re-trigger and any pending timer was cancelled at respawn.
    this.autoStoppedForOverage = false;
    this.autoResumeAt = null;
    this._overageResetsAt = null;
    this._overageHandled = false;
    this._overageWasStopped = false;
    this._overageQueue = [];
    const { command, prefixArgs } = resolveClaudeBin();
    if (resume) this.sessionId = resume;
    else if (!this.sessionId) this.sessionId = randomUUID();
    // Persist the temp marker at spawn time so it survives a SIGKILL that
    // happens before the first turn_end (where _writeSessionMetadata also
    // calls markTemp). Fire-and-forget — spawn() must stay synchronous.
    if (this.temp && this.sessionId) markTemp(this.sessionId).catch(() => {});
    this._hydrateTitle().catch(() => {});
    const args = [
      ...prefixArgs,
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
      // Bake THIS worker's own stable sessionId into ?caller= so the MCP server
      // can identify it when it calls caller-dependent tools (subscribe_to_idle).
      // sessionId isn't known at create() time (the URL is built before spawn()
      // mints it), so the caller suffix is appended here — stable across respawn
      // (same sessionId) and full restart (resume reuses the sessionId).
      const url = `${this.mcpServerUrl}?caller=${encodeURIComponent(this.sessionId)}`;
      args.push('--mcp-config', buildMcpConfigJSON({ url }));
    }
    // Each family runs at one fixed context window, pinned via the model id
    // itself (Sonnet carries the CLI-native `[1m]` suffix; Opus/Haiku are
    // bare — see canonicalizeModel in modelVersions.js). Strip any ambient
    // CLAUDE_CODE_DISABLE_1M_CONTEXT so a user-level export can't silently
    // downgrade our 1M Opus/Sonnet sessions to 200k.
    const spawnEnv = { ...process.env };
    delete spawnEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    // Apply the compact-window override ONLY to the Conduct orchestrator session
    // (project === '.conduct'). Do NOT gate on this.conducted — that flag marks
    // MCP-spawned *worker* agents that the orchestrator spawns, which is the
    // opposite of the orchestrator session itself.
    if (this.project === CONDUCT_PROJECT_NAME) {
      const cw = getConductorCompactWindow();
      if (cw.enabled) {
        spawnEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cw.value * 1000);
      }
    }
    if (this.model) args.push('--model', this.model);
    if (resume) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);

    this._setStatus('spawning');
    this.parser.reset();
    // Remember the full launch argv so a later runtime enableDebug()
    // call can still write an accurate meta.json bundle.
    this._spawnArgv = [command, ...args];
    this._openDebugStreams(this._spawnArgv);

    this.proc = spawn(command, args, {
      cwd: this.cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      if (ev.kind === 'message_start' && ev.model) {
        this._trackModel(ev.model);
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
        this._setStatus('idle');
        this._writeSessionMetadata().catch(() => {});
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
  // end its turn without responding, so it winds down gracefully. The steer
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
      // into the jsonl mid-truncate.
      if (this.proc) await this.kill({ graceMs: 300 });

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
    this.emit('snapshot_reset', { ...this._snapshotForReset(), ...extra });
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
  constructor() {
    super();
    this.byId = new Map();
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
    // Server-side usage poller: a second, equal-footing source for the overage
    // auto-stop. The stream `rate_limit_event` only reports near Anthropic's own
    // ~90% threshold, so a LOW configured threshold (e.g. 25%) is invisible to
    // it — only a live usage poll sees it. The poller drives the SAME
    // `_handleOverageTrip` machinery (deduped via `_overageActive`). Its timer is
    // started by the server after listen() and stopped in both shutdown paths.
    this._usageMonitor = new UsageOverageMonitor(this);
    this.on('event', (e) => this._idleHub.onTurnEnd(e));
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
  _purgeIdleFor(sessionId) { return this._idleHub.purge(sessionId); }
  _deliverIdleCallback(callerSessionId, targetSessionId, opts) {
    return this._idleHub.deliver(callerSessionId, targetSessionId, opts);
  }

  // Returns true when a turn_notification for instanceId should be suppressed:
  //   Condition 1 — session is a conductor mid-orchestration (subscribed as caller
  //                 to a worker); isCaller() is reliable here because the caller's
  //                 subscription is only consumed on the TARGET's turn_end.
  //   Condition 2 — session is a worker whose turn_end just woke a subscribed
  //                 conductor; wasConsumed() reads _justConsumed, populated in
  //                 IdleSubscriptionHub.onTurnEnd() BEFORE subscribers clears.
  // ORDERING DEPENDENCY: the idle hub's 'event' listener (registered in the
  // InstanceManager constructor, instances.js) must run before wsHub's listener
  // (registered by attachWsHub in server.js). wasConsumed() is only valid during
  // the same synchronous dispatch cycle as onTurnEnd(). Do not reorder those
  // registrations without revisiting this method.
  shouldSuppressTurnNotification(instanceId) {
    const sid = this.byId.get(instanceId)?.sessionId;
    if (!sid) return false;
    if (this._idleHub.isCaller(sid)) return true;   // Condition 1
    if (this._idleHub.wasConsumed(sid)) return true; // Condition 2
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

  hasIdleSubscriber(sessionId) { return this._idleHub.hasSubscriber(sessionId); }

  // Returns true when sessionId is the *caller* (conductor) in any pending
  // subscription — i.e. this session is actively waiting for a worker to finish.
  isIdleCaller(sessionId) { return this._idleHub.isCaller(sessionId); }

  list() {
    return [...this.byId.values()].map(i => ({
      ...i.summary(),
      hasIdleSubscriber: this.isIdleCaller(i.sessionId),
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

  async create({ project, resume, mode, effort, thinking, model, worktree, temp, conducted, callerInstanceId, debug, autoApprovePlan } = {}) {
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
    // Refuse to spawn a second live instance against the same session id.
    // `claude --resume <sid>` would otherwise race two subprocesses
    // writing the same jsonl, with predictable corruption.
    if (resume) {
      const conflict = [...this.byId.values()].find(i => i.sessionId === resume && i.proc);
      if (conflict) {
        throw Object.assign(
          new Error(`session ${resume} is already attached to a running instance (${conflict.id.slice(0, 8)}…)`),
          { statusCode: 409 },
        );
      }
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
    // Done on every spawn, including model-recovery from a resumed session's
    // jsonl, so the preference is always honoured and stale `[200k]`/`[1m]`
    // from older clients normalise cleanly.
    if (finalModel) finalModel = canonicalizeModel(finalModel, { sonnetWindow: getSonnetContextWindow() });

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

    const id = randomUUID();
    const inst = new Instance({
      id, project, cwd,
      mode: finalMode, effort: finalEffort, thinking: finalThinking, model: finalModel,
      hookCallbackUrl: this.hookCallbackUrl(id),
      // Base MCP URL (no ?caller=) — the per-worker caller suffix is appended in
      // Instance.spawn() once the sessionId is known.
      mcpServerUrl: this.mcpServerUrl(),
      worktree: worktreeMeta,
      temp: !!temp,
      conducted: conductedFlag,
      callerInstanceId: callerInstanceId ?? null,
      debug: !!debug,
    });

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
      const active = this._overageActive && this._overageResumeMode &&
        Number.isFinite(atMs) && atMs > Date.now();
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
      this._cancelAutoResume(inst.sessionId);
      if (wasOverageStopped && this._overageActive) this._clearOverage();
    });
    inst.on('status', (summary) => {
      this.emit('status', summary);
      // Overage auto-resume: arm the per-session timer on the idle transition
      // that follows a `stop-resume` soft-interrupt (the session stays alive;
      // we never reach 'exited'). Guarded so it arms exactly once.
      if (inst.autoStoppedForOverage && summary.status === 'idle' && inst.proc &&
          !this._autoResumeTimers.has(inst.sessionId)) {
        this._armAutoResume(inst);
      }
      // Temp sessions are disposable: once the subprocess is gone the
      // session is archived by _archiveTempSession() (the jsonl is retained
      // and stays resumable, just moved into the — archived — section), so
      // there's nothing live left to track here. Drop them from byId on
      // exit/crash so the sidebar's Temp Sessions subnode collapses instead
      // of piling up dim ghost rows the user would have to delete by hand.
      // `inst.temp` is read at event time, so a session promoted via
      // /promote (which flips temp=false) survives this path.
      if (inst.temp && !inst.proc &&
          (summary.status === 'exited' || summary.status === 'crashed') &&
          this.byId.has(id)) {
        // Cancel any pending overage auto-resume before dropping the instance:
        // otherwise its wall-clock deadline outlives the session as an orphan
        // (and the badge would outlive the timer). Done while inst is still in
        // byId so cancel can clear its flags + emit the badge-drop status.
        this._cancelAutoResume(inst.sessionId);
        this.byId.delete(id);
        this._purgeIdleFor(inst.sessionId);
        this.emit('list_changed');
      }
    });
    inst.on('snapshot_reset', (snap) => this.emit('snapshot_reset', snap));

    this.byId.set(id, inst);
    if (autoApprovePlan) inst.autoApprovePlan = true;
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
    if (inst.autoResumeAt || this._autoResumeTimers.has(inst.sessionId)) return; // already armed
    inst._overageResetsAt = Number.isFinite(Number(resetsAt)) ? resetsAt : this._overageResetsAt;
    inst.autoStoppedForOverage = true; // so cancel/flush treats it like an armed session
    this._armAutoResume(inst);         // arm() re-checks the future-resetsAt safety rail
  }
  _armRestoredAutoResume(inst, fireAtMs) { return this._overageResume.armRestored(inst, fireAtMs); }
  _runAutoResume(inst, sid) { return this._overageResume.run(inst, sid); }
  _fireAutoResumeNow(sessionId) { return this._overageResume.fireNow(sessionId); }
  _cancelAutoResume(sessionId) { return this._overageResume.cancel(sessionId); }

  // ---- Global overage auto-stop routing -----------------------------------
  // The central handler an Instance's `overage` signal lands in. One-shot per
  // rate-limit window via `_overageActive`. Honours getOnOverageAction():
  // 'none' does nothing at all (no flag flip, no routing). Otherwise it flips
  // the flag, routes the stop across every live instance, and arms the clear
  // timer so the flag releases when the window resets.
  _handleOverageTrip(inst, info) {
    const action = getOnOverageAction();
    if (action === 'none') return;          // no flag flip, no routing
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
    const live = [...this.byId.values()].filter(i => i.proc);
    // Pass 1: resolve which conductors to steer and which workers they protect.
    const steerConductors = new Map();  // conductor id → conductor instance
    const protectedWorkers = new Set(); // worker ids owned by a steered conductor
    for (const inst of live) {
      if (!inst.conducted) continue;
      const conductor = this._ownerConductor(inst);
      const inControl = conductor && conductor.proc &&
        (conductor.status === 'turn' || this.isIdleCaller(conductor.sessionId));
      if (inControl) {
        steerConductors.set(conductor.id, conductor);
        protectedWorkers.add(inst.id);
      }
    }
    // Pass 2: steer each in-control conductor once.
    for (const conductor of steerConductors.values()) {
      this._steerConductor(conductor, { resume, resetsAt });
    }
    // Pass 3: direct-stop every other mid-turn instance — plain sessions, a
    // conductor with no in-control workers (incl. one that tripped itself), and
    // conducted workers with NO in-control conductor (dead / idle-unsubscribed
    // → fallback). Skips steered conductors and the workers they own.
    for (const inst of live) {
      if (steerConductors.has(inst.id) || protectedWorkers.has(inst.id)) continue;
      if (inst.status === 'turn') this._directOverageStop(inst, { resume, resetsAt });
    }
  }

  // The owning conductor of a conducted worker: callerInstanceId is the
  // conductor's instanceId, mapped back through the live registry. Its
  // sessionId is what isIdleCaller() keys on. Null when the conductor is gone.
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
  _steerConductor(conductor, { resume, resetsAt }) {
    if (conductor.status === 'turn') {
      if (resume) {
        conductor.autoStoppedForOverage = true;
        conductor._overageWasStopped = true; // stopped mid-work → full preamble
        conductor._overageResetsAt = resetsAt;
      }
      conductor.windDown(OVERAGE_CONDUCTOR_STEER_TEXT);
    } else {
      // `internal:true` so the steer's user_prompt doesn't cancel the resume we
      // arm next; set the flags AFTER the call regardless, so the steer turn's
      // turn→idle transition arms the timer (same mechanism as the windDown
      // branch above).
      conductor.prompt(OVERAGE_CONDUCTOR_STEER_TEXT, [], { internal: true }).catch(() => {});
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
    this._overageClearTimer = setTimeout(() => this._clearOverage(), delay);
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

  async respawn(id) {
    const inst = this.byId.get(id);
    if (!inst) {
      throw Object.assign(new Error('instance not found'), { statusCode: 404 });
    }
    if (inst.proc) {
      throw Object.assign(new Error('instance still running'), { statusCode: 409 });
    }
    // A manual respawn supersedes any pending auto-resume for this session.
    this._cancelAutoResume(inst.sessionId);
    if (!inst.sessionId) {
      throw Object.assign(new Error('no sessionId to resume'), { statusCode: 400 });
    }
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
    this._cancelAutoResume(inst.sessionId);
    this._purgeIdleFor(inst.sessionId);
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
      this._cancelAutoResume(i.sessionId);
      this._purgeIdleFor(i.sessionId);
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
}
