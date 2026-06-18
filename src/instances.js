import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { promises as fsp, readFileSync, mkdirSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Parser, SOFT_INTERRUPT_MARKER } from './parser.js';
import { getProject, claudeProjectsRoot, encodeCwd } from './projects.js';
import { createWorktree, getWorktree, debugBaseDir } from './worktrees.js';
import { getTitle as getSessionTitle, deleteTitle as deleteSessionTitle } from './sessionTitles.js';
import { isConducted, markConducted, unmarkConducted } from './conductedSessions.js';
import { isTemp, markTemp, unmarkTemp } from './tempSessions.js';
import { markArchived } from './archivedSessions.js';
import { CONDUCT_PROJECT_NAME } from './conduct.js';
import { buildSettingsJSON, buildMcpConfigJSON } from './settings.js';
import { getOnOverageAction, getConductorCompactWindow, getSonnetContextWindow } from './appSettings.js';
import { HookBroker } from './hookBroker.js';
import { loadPersistedTranscript, writeSessionMetadata, readLastSessionModel } from './transcript.js';
import { canonicalizeModel } from './modelVersions.js';
import { truncateSessionAtUserMessage } from './sessionEdit.js';
import { saveAttachment, isImageType } from './attachments.js';
import { buildApprovePrompt } from './planApproval.js';

// Three user-facing modes:
//   - `plan`              — read-only planning; CLI is in plan mode
//   - `ask`               — full power but every destructive tool is gated
//                           by an interactive PreToolUse hook; CLI is in
//                           bypassPermissions
//   - `bypassPermissions` — full power, no gating; CLI is in bypassPermissions
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
const VALID_MODES = new Set(['plan', 'ask', 'bypassPermissions']);

// The hidden steering instruction a SOFT interrupt injects mid-turn. It
// must forbid any further output and direct the model to end its turn
// silently — a graceful stop, not a hard abort. Prefixed with
// SOFT_INTERRUPT_MARKER at send time so it never renders / replays.
const SOFT_INTERRUPT_TEXT =
  'Stop now. Do not make any more tool calls. End your turn immediately. And don\'t reply in any way.';

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

// Prompt delivered by the overage auto-resume timer to a still-alive session
// once the rate-limit window has reset (onOverage: 'stop-resume').
export const AUTO_RESUME_TEXT =
  'The rate-limit window has reset. Please continue where you left off.';

// Returns true when a rate_limit_event signals the session is now using
// paid overage credits. Defensive: matches isUsingOverage at either
// nesting level (nested under rate_limit_info or flat on the event).
function isOverageEvent(data) {
  return data?.rate_limit_info?.isUsingOverage === true
      || data?.isUsingOverage === true;
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

function isOuterUserEcho(ev) {
  return ev?.kind === 'user_echo' && !ev.parentToolUseId;
}

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
    // Set true by the resume-restart path before SIGKILL so _handleExit
    // skips _deleteTempArtifacts() — the temp jsonl must survive to be
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
  }

  summary() {
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
    // Re-runs after every adjustment because fixing one group can expose
    // a different group that also straddles the new start boundary.
    {
      let gChanged = true;
      while (gChanged) {
        gChanged = false;
        const headIds = new Set();
        for (let i = start; i < buf.length; i++) {
          if (buf[i].toolUseId &&
              (buf[i].kind === 'tool_use_start' || buf[i].kind === 'tool_use')) {
            headIds.add(buf[i].toolUseId);
          }
        }
        for (let i = start; i < buf.length; i++) {
          const pid = buf[i].parentToolUseId;
          if (!pid || headIds.has(pid)) continue;
          headIds.add(pid); // don't re-process this group in the same pass
          let headIdx = -1;
          for (let j = start - 1; j >= 0; j--) {
            if (buf[j].toolUseId === pid &&
                (buf[j].kind === 'tool_use_start' || buf[j].kind === 'tool_use')) {
              headIdx = j; break;
            }
          }
          if (headIdx >= 0) {
            start = headIdx; // head is in ring — extend backward to include it
          } else {
            // Head is evicted — advance past all children of this group so
            // the snapshot stays consistent; they'll come via lazy paging.
            for (let j = start; j < buf.length; j++) {
              if (buf[j].parentToolUseId === pid) start = j + 1;
            }
          }
          gChanged = true;
          break; // restart with updated start
        }
      }
    }
    return buf.slice(start);
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
      // Action on overage: when this event signals the session crossed into
      // paid overage credits, apply the configured action. `stop` and
      // `stop-resume` share the identical soft-interrupt path; `stop-resume`
      // additionally marks the instance so the manager arms a per-session
      // resume timer on the next idle transition (see InstanceManager
      // _armAutoResume). One-shot per run via _overageHandled.
      if (ev.kind === 'system' && ev.subtype === 'rate_limit_event'
          && isOverageEvent(ev.data) && !this._overageHandled) {
        const action = getOnOverageAction();
        if (action === 'stop' || action === 'stop-resume') {
          this._overageHandled = true;
          const resume = action === 'stop-resume';
          let resetsAt = null;
          if (resume) {
            resetsAt = ev.data?.rate_limit_info?.resetsAt ?? ev.data?.resetsAt ?? null;
            this.autoStoppedForOverage = true;
            this._overageResetsAt = resetsAt;
          }
          this._emitUi({ kind: 'system', subtype: 'auto_stop_overage', data: { resume, resetsAt } });
          // rate_limit_event only arrives mid-turn → interrupt always has a turn
          // to wind down, and the manager arms the resume timer off the resulting
          // turn→idle status transition.
          this.interrupt().catch(() => {});
        }
      }
    }
  }

  _fireAutoApprovePlan() {
    // Run after the current stdout line has finished dispatching so the
    // plan_request event reaches subscribers before the resulting mode
    // flip / user_echo / turn-start events do. ExitPlanMode is held off
    // by the static PreToolUse command-deny hook in settings.js (the
    // CLI auto-errors the tool in stream-json --print mode regardless),
    // so we drive the model forward with setMode + an explicit approval
    // prompt — same flow as a manual Approve click in the UI.
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
  async prompt(text, attachments = [], { annotateIfMidTurn = true } = {}) {
    if (!this.proc) throw new Error('not running');
    // Any prompt cancels a pending overage auto-resume — the session is being
    // driven again. When the auto-resume timer itself fires this is a harmless
    // no-op: the callback deletes its timer + clears the flags BEFORE calling
    // prompt(), so the resume message still sends (see _armAutoResume).
    this.emit('user_prompt');
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
  // end its turn without responding, so it winds down gracefully. The
  // steer is never echoed to the UI and is filtered from replay (see
  // SOFT_INTERRUPT_MARKER in parser.js / transcript.js).
  async interrupt({ force = false } = {}) {
    if (this.status !== 'turn') return;
    if (force) {
      await this._controlRequest({ subtype: 'interrupt' });
      return;
    }
    if (this.interrupting) return; // idempotent — one steer per turn
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
    if (this.temp) {
      throw Object.assign(new Error('temp sessions cannot be rewound'), { statusCode: 400 });
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
    // One-shot idle subscriptions: when target hits turn_end, deliver
    // a stub user prompt to every registered caller and clear the set.
    // Keyed by targetSessionId → Map<callerSessionId, { timerId: Timeout | null }>.
    // sessionId (not instanceId) so the graph survives respawn / restart.
    this._idleSubscribers = new Map();
    // Pending overage auto-resume timers, keyed by sessionId (survives the
    // instanceId churn the way _idleSubscribers does). Armed on the idle
    // transition after an `onOverage: 'stop-resume'` soft-interrupt; fires a
    // resume prompt at the rate-limit reset time. In-memory only — lost on
    // restart (the session just stays manually resumable).
    this._autoResumeTimers = new Map(); // sessionId → Timeout
    this.on('event', ({ id: targetInstanceId, ev }) => {
      if (ev?.kind !== 'turn_end') return;
      // The event payload carries the instanceId; resolve its sessionId, which
      // is what the subscription graph is keyed by.
      const tSid = this.byId.get(targetInstanceId)?.sessionId;
      const subs = tSid && this._idleSubscribers.get(tSid);
      if (!subs || subs.size === 0) return;
      const entries = [...subs.entries()];
      subs.clear();
      this._idleSubscribers.delete(tSid);
      for (const [callerSid, { timerId }] of entries) {
        clearTimeout(timerId); // cancel watchdog — turn_end arrived first
        this._deliverIdleCallback(callerSid, tSid);
      }
    });
  }

  // Register a one-shot callback: when targetId's next turn_end fires,
  // a stub user prompt lands in callerId pointing at get_recent_messages.
  // Re-subscribing the same pair before the callback fires is a no-op.
  // Optional timeoutMs: arm a watchdog that fires the subscription early
  // (with a timeout-flagged stub) if turn_end hasn't arrived in time.
  // Only armed when timeoutMs is a finite number > 0; ignored otherwise.
  subscribeIdle(callerSessionId, targetSessionId, timeoutMs) {
    if (typeof callerSessionId !== 'string' || !callerSessionId) {
      throw new Error('callerSessionId required');
    }
    if (typeof targetSessionId !== 'string' || !targetSessionId) {
      throw new Error('targetSessionId required');
    }
    if (callerSessionId === targetSessionId) {
      throw new Error('cannot subscribe to self');
    }
    // Both must resolve to a LIVE (proc-attached) instance.
    const isLive = (sid) => this.idsForSession(sid).some(id => this.byId.get(id)?.proc);
    if (!isLive(callerSessionId)) {
      throw new Error(`caller session not live: ${callerSessionId}`);
    }
    if (!isLive(targetSessionId)) {
      throw new Error(`target session not live: ${targetSessionId}`);
    }
    let subs = this._idleSubscribers.get(targetSessionId);
    if (!subs) {
      subs = new Map();
      this._idleSubscribers.set(targetSessionId, subs);
    }
    const already = subs.has(callerSessionId);
    if (!already) {
      const useTimeout = typeof timeoutMs === 'number' && isFinite(timeoutMs) && timeoutMs > 0;
      let timerId = null;
      if (useTimeout) {
        timerId = setTimeout(() => {
          const s = this._idleSubscribers.get(targetSessionId);
          if (s) {
            s.delete(callerSessionId);
            if (s.size === 0) this._idleSubscribers.delete(targetSessionId);
          }
          this.emit('subscription_changed', { targetId: targetSessionId });
          this._deliverIdleCallback(callerSessionId, targetSessionId, { timedOut: true, timeoutMs });
        }, timeoutMs);
      }
      subs.set(callerSessionId, { timerId });
      this.emit('subscription_changed', { targetId: targetSessionId });
    }
    return { already };
  }

  // Cancel a pending subscription. Idempotent. Clears any watchdog timer.
  unsubscribeIdle(callerSessionId, targetSessionId) {
    const subs = this._idleSubscribers.get(targetSessionId);
    if (!subs) return { removed: false };
    const entry = subs.get(callerSessionId);
    if (!entry) return { removed: false };
    clearTimeout(entry.timerId);
    subs.delete(callerSessionId);
    if (subs.size === 0) this._idleSubscribers.delete(targetSessionId);
    this.emit('subscription_changed', { targetId: targetSessionId });
    return { removed: true };
  }

  // Snapshot of the current idle-subscription graph. Test-only — gives
  // tests a way to assert that purging on remove() actually happened.
  _idleSubscriberSnapshot() {
    const out = {};
    for (const [target, callers] of this._idleSubscribers) {
      out[target] = [...callers.keys()];
    }
    return out;
  }

  // Drop a sessionId from every subscription map (as caller) AND drop any
  // entry where it was the target. Clears watchdog timers. Called on instance
  // removal so dead sessions can't accumulate subscriptions. Guards null
  // sessionId (an instance may exit before ever minting one).
  _purgeIdleFor(sessionId) {
    if (!sessionId) return;
    const asTarget = this._idleSubscribers.get(sessionId);
    if (asTarget) {
      for (const [, { timerId }] of asTarget) clearTimeout(timerId);
      this._idleSubscribers.delete(sessionId);
    }
    for (const [target, subs] of this._idleSubscribers) {
      const entry = subs.get(sessionId);
      if (entry) {
        clearTimeout(entry.timerId);
        subs.delete(sessionId);
        if (subs.size === 0) this._idleSubscribers.delete(target);
      }
    }
  }

  _deliverIdleCallback(callerSessionId, targetSessionId, opts) {
    // Resolve the live caller instance from its sessionId.
    const caller = this.idsForSession(callerSessionId).map(id => this.byId.get(id)).find(i => i && i.proc);
    if (!caller) return; // caller gone — drop silently.
    const stub = opts?.timedOut
      ? `Worker \`${targetSessionId}\` did NOT finish — timed out after ${opts.timeoutMs}ms; ` +
        `it may still be busy or stuck. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to check its current state, then decide whether to resubscribe, ` +
        `call interrupt_turn, or escalate.`
      : `Worker \`${targetSessionId}\` finished its turn. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to inspect the result.`;
    const deliver = async () => {
      try {
        if (!caller.proc) return;
        await caller.prompt(stub);
      } catch (err) {
        caller._emitUi({
          kind: 'system', subtype: 'stderr',
          data: { line: `idle-callback delivery failed: ${err.message}` },
        });
      }
    };
    if (caller.status === 'turn') {
      // Wait for the caller to finish its own turn before injecting the
      // stub, so we don't try to write to stdin while another turn is
      // in flight. One-shot listener.
      const onStatus = (s) => {
        if (s.status === 'turn' || s.status === 'spawning') return;
        caller.off('status', onStatus);
        if (s.status === 'idle') queueMicrotask(deliver);
        // exited/crashed → drop silently.
      };
      caller.on('status', onStatus);
      return;
    }
    queueMicrotask(deliver);
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

  hasIdleSubscriber(sessionId) {
    const subs = this._idleSubscribers.get(sessionId);
    return subs != null && subs.size > 0;
  }

  // Returns true when sessionId is the *caller* (conductor) in any pending
  // subscription — i.e. this session is actively waiting for a worker to finish.
  isIdleCaller(sessionId) {
    for (const callers of this._idleSubscribers.values()) {
      if (callers.has(sessionId)) return true;
    }
    return false;
  }

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
    // A user/MCP-driven turn cancels any pending overage auto-resume.
    inst.on('user_prompt', () => this._cancelAutoResume(inst.sessionId));
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
      // jsonl has been wiped by _deleteTempArtifacts(), so Resume can
      // never recover them. Drop them from byId on exit/crash so the
      // sidebar's Temp Sessions subnode collapses instead of piling up
      // dim ghost rows the user would have to delete by hand.
      // `inst.temp` is read at event time, so a session promoted via
      // /promote (which flips temp=false) survives this path.
      if (inst.temp && !inst.proc &&
          (summary.status === 'exited' || summary.status === 'crashed') &&
          this.byId.has(id)) {
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

  // Arm a per-session overage auto-resume timer. Called from the status
  // handler on the idle transition after a `stop-resume` soft-interrupt. Fires
  // at `resetsAt + BUFFER` seconds with a resume prompt to the still-alive
  // session. Skips (with a notice) when resetsAt is missing or already past —
  // we never arm a negative/NaN timer.
  _armAutoResume(inst) {
    // Slack past the reported reset time before resuming. Overridable via env
    // (a test seam — lets integration tests fire the resume promptly).
    const envBuf = Number(process.env.ORCH_OVERAGE_RESUME_BUFFER_MS);
    const BUFFER_MS = Number.isFinite(envBuf) ? envBuf : 5000;
    const nowMs = Date.now();
    const atMs = inst._overageResetsAt * 1000; // resetsAt is epoch SECONDS
    if (!Number.isFinite(atMs) || atMs <= nowMs) {
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped',
        data: { reason: 'missing or past resetsAt' } });
      inst.autoStoppedForOverage = false;
      inst._overageHandled = false;
      return;
    }
    const fireAtMs = atMs + BUFFER_MS;
    inst.autoResumeAt = Math.round(fireAtMs / 1000); // epoch secs for the badge
    const sid = inst.sessionId;
    const t = setTimeout(() => this._runAutoResume(inst, sid), Math.max(0, fireAtMs - nowMs));
    this._autoResumeTimers.set(sid, t);
    this.emit('status', inst.summary()); // push autoResumeAt → client (badge)
  }

  // The body the armed timer fires (extracted so it can also be triggered
  // on-demand via _fireAutoResumeNow). Resumes the still-live session, or tears
  // down with a notice if the process vanished. No respawn, ever.
  _runAutoResume(inst, sid) {
    if (inst.proc) {
      // prompt() synchronously emits 'user_prompt' → _cancelAutoResume performs
      // the single teardown (clearTimeout of this already-fired timer is a no-op,
      // deletes the Map entry, clears the flags, emits status to drop the badge);
      // then the resume message sends. _cancelAutoResume is the sole owner of
      // teardown — do NOT pre-clear here or it double-runs.
      inst.prompt(AUTO_RESUME_TEXT).catch(() => {});
    } else {
      // Process gone (crashed / killed externally) — no send means no
      // user_prompt, so tear down explicitly. Keep it simple: no respawn.
      this._cancelAutoResume(sid);
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped',
        data: { reason: 'session no longer running' } });
    }
  }

  // Test/control seam: fire a pending overage auto-resume immediately rather than
  // waiting out the wall-clock timer (lets tests exercise the full arm→fire path
  // without a real multi-second sleep). Clears the real timer first so it can't
  // double-fire. Returns false if nothing was armed for this session.
  _fireAutoResumeNow(sessionId) {
    const t = this._autoResumeTimers.get(sessionId);
    if (!t) return false;
    clearTimeout(t);
    this._autoResumeTimers.delete(sessionId);
    const inst = [...this.byId.values()].find(i => i.sessionId === sessionId);
    if (!inst) return false;
    this._runAutoResume(inst, sessionId);
    return true;
  }

  // Cancel a pending overage auto-resume timer and clear the instance flags.
  // Idempotent. Called on user takeover, manual respawn/kill/remove, shutdown,
  // and once the timer itself fires.
  _cancelAutoResume(sessionId) {
    const t = this._autoResumeTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this._autoResumeTimers.delete(sessionId);
    }
    for (const inst of this.byId.values()) {
      if (inst.sessionId !== sessionId) continue;
      const had = inst.autoResumeAt !== null || inst.autoStoppedForOverage;
      inst.autoResumeAt = null;
      inst.autoStoppedForOverage = false;
      inst._overageHandled = false;
      if (had) this.emit('status', inst.summary()); // clear the badge
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
    for (const t of this._autoResumeTimers.values()) clearTimeout(t);
    this._autoResumeTimers.clear();
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
  // `exit` events to fire `_deleteTempArtifacts()`, which races process.exit()
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
  // first so each temp instance's _handleExit skips _deleteTempArtifacts(),
  // preserving the transcript for `--resume` on boot.
  shutdownForResumeSync() {
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
