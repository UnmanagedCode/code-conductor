import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { promises as fsp, readFileSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Parser } from './parser.js';
import { getProject, claudeProjectsRoot, encodeCwd } from './projects.js';
import { createWorktree, getWorktree, debugBaseDir } from './worktrees.js';
import { buildSettingsJSON, buildMcpConfigJSON } from './settings.js';
import { HookBroker } from './hookBroker.js';
import { loadPersistedTranscript, writeSessionMetadata } from './transcript.js';
import { truncateSessionAtUserMessage } from './sessionEdit.js';
import { saveAttachment, isImageType } from './attachments.js';

// Three user-facing modes:
//   - `plan`              — read-only planning; CLI is in plan mode
//   - `ask`               — full power but every destructive tool is gated
//                           by an interactive PreToolUse hook; CLI is in
//                           bypassPermissions
//   - `bypassPermissions` — full power, no gating; CLI is in bypassPermissions
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
const VALID_MODES = new Set(['plan', 'ask', 'bypassPermissions']);
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

// Unbounded append-only event log per instance. Grows for the lifetime of
// the Instance object — no cap, so a resumed session whose persisted
// transcript expands to thousands of UI events keeps every one of them in
// the snapshot. Memory cost is one event per UI delta (~1 KB-ish), so a
// multi-hour session is still well under tens of MB.
class EventLog {
  constructor() { this.buf = []; }
  push(v) { this.buf.push(v); }
  toArray() { return this.buf.slice(); }
  clear() { this.buf.length = 0; }
}

export class Instance extends EventEmitter {
  constructor({ id, project, cwd, mode, effort, thinking, model, hookCallbackUrl = null, mcpServerUrl = null, worktree = null, temp = false, debug = false }) {
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
      debug: this.debug,
      debugDir: this.debugDir,
    };
  }

  ringSnapshot() { return this.ring.toArray(); }

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
    this.emit('status', this.summary());
  }

  _emitUi(ev) {
    const wrapped = { ...ev, _seq: this.ring.buf.length };
    this.ring.push(wrapped);
    this.emit('event', wrapped);
  }

  async loadHistory(sessionId) {
    const result = await loadPersistedTranscript({
      cwd: this.cwd, sessionId, seqHint: this.ring.buf.length,
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
    const { command, prefixArgs } = resolveClaudeBin();
    if (resume) this.sessionId = resume;
    else if (!this.sessionId) this.sessionId = randomUUID();
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
      args.push('--mcp-config', buildMcpConfigJSON({ url: this.mcpServerUrl }));
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
      env: { ...process.env },
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
        if (sid) this.sessionId = sid;
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
      this._emitUi(ev);
    }
  }


  async _writeSessionMetadata() {
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
    if (this.temp) this._deleteTempArtifacts().catch(() => {});
  }

  // Best-effort removal of the CLI's persisted jsonl + sub-agent dir for
  // a temp session. Called after the subprocess exits.
  async _deleteTempArtifacts() {
    if (!this.sessionId) return;
    const dir = path.join(claudeProjectsRoot(), encodeCwd(this.cwd));
    const file = path.join(dir, `${this.sessionId}.jsonl`);
    const subagents = path.join(dir, this.sessionId);
    await fsp.rm(file, { force: true });
    await fsp.rm(subagents, { recursive: true, force: true });
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
  async prompt(text, attachments = []) {
    if (!this.proc) throw new Error('not running');
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

  async interrupt() {
    if (this.status !== 'turn') return;
    await this._controlRequest({ subtype: 'interrupt' });
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
  }

  setServerPort(port) {
    this.serverPort = port;
  }

  hookCallbackUrl(id) {
    if (!this.serverPort) return null;
    return `http://127.0.0.1:${this.serverPort}/api/instances/${id}/hook-callback`;
  }

  // Auto-registered orchestrator MCP server URL. Same for every instance,
  // but exposed as a method to stay parallel with hookCallbackUrl and to
  // honour the ORCH_DISABLE_MCP_AUTOREGISTER opt-out at call time.
  mcpServerUrl() {
    if (!this.serverPort) return null;
    if (process.env.ORCH_DISABLE_MCP_AUTOREGISTER === '1') return null;
    return `http://127.0.0.1:${this.serverPort}/mcp`;
  }

  list() { return [...this.byId.values()].map(i => i.summary()); }
  get(id) { return this.byId.get(id); }
  idsForProject(name) {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.id);
  }
  idsForWorktree(project, worktreeName) {
    return [...this.byId.values()]
      .filter(i => i.project === project && i.worktree?.worktreeName === worktreeName)
      .map(i => i.id);
  }
  idsForSession(sessionId) {
    return [...this.byId.values()]
      .filter(i => i.sessionId === sessionId)
      .map(i => i.id);
  }

  async create({ project, resume, mode, effort, thinking, model, worktree, temp, debug } = {}) {
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
    // Temp sessions default to bypassPermissions instead of plan — a
    // disposable session is almost always for *doing*, not planning. The
    // user can still pick a different mode explicitly.
    const tempFlag = !!temp;
    const defaultMode = resume
      ? DEFAULT_RESUME_MODE
      : (tempFlag ? 'bypassPermissions' : DEFAULT_MODE);
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
    const finalModel = (typeof model === 'string' && model.trim()) ? model.trim() : null;

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

    const id = randomUUID();
    const inst = new Instance({
      id, project, cwd,
      mode: finalMode, effort: finalEffort, thinking: finalThinking, model: finalModel,
      hookCallbackUrl: this.hookCallbackUrl(id),
      mcpServerUrl: this.mcpServerUrl(),
      worktree: worktreeMeta,
      temp: tempFlag,
      debug: !!debug,
    });

    inst.on('event', (ev) => this.emit('event', { id, ev }));
    inst.on('status', (summary) => this.emit('status', summary));
    inst.on('snapshot_reset', (snap) => this.emit('snapshot_reset', snap));

    this.byId.set(id, inst);
    inst.spawn({ resume });
    this.emit('list_changed');
    return inst;
  }

  async respawn(id) {
    const inst = this.byId.get(id);
    if (!inst) {
      throw Object.assign(new Error('instance not found'), { statusCode: 404 });
    }
    if (inst.proc) {
      throw Object.assign(new Error('instance still running'), { statusCode: 409 });
    }
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
    }));
    if (victims.length > 0) this.emit('list_changed');
    return victims.length;
  }

  async shutdown() {
    const all = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(all.map(i => i.kill({ graceMs: 200 }).catch(() => {})));
  }
}
