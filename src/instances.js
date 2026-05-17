import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { Parser } from './parser.js';
import { getProject, encodeCwd, claudeProjectsRoot } from './projects.js';
import { createWorktree, getWorktree } from './worktrees.js';

// Static deny used for AskUserQuestion / ExitPlanMode. The CLI receives an
// is_error tool_result with this reason and the model typically wraps up
// with a brief "waiting for your response" and ends the turn cleanly — no
// control_request interrupt is needed, no `[Request interrupted by user]`
// marker is inserted.
const HOOK_DENY_REASON_BLOCKING_TOOL =
  'Awaiting user input via the orchestrator UI — please stop and wait for the next user message.';

// Destructive tools gated by the interactive PreToolUse http hook in ask
// mode. Reads (Read|Glob|Grep|LS|WebFetch|WebSearch) are NOT gated so the
// model can explore freely without a prompt per call.
const ASK_GATED_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash';

// Per-hook timeout (seconds) for the interactive http hook. Generous — the
// CLI waits this long for the user to click Allow/Deny in the UI. Server
// resolves with a synthesised deny well before this fires; the headroom is
// just there to avoid the CLI cutting off a slow human.
const HOOK_HTTP_TIMEOUT_S = 660;

// Server-side timeout for a pending interactive hook callback. Must be
// safely under HOOK_HTTP_TIMEOUT_S so we always respond before the CLI
// gives up (an HTTP timeout = non-blocking error = tool proceeds, which is
// the opposite of what we want here).
const HOOK_PENDING_TIMEOUT_MS = 540_000;

// printf-friendly literal: single-quote the JSON so the shell doesn't
// interpolate, escape internal double-quotes via JSON.stringify on the
// REASON above.
function buildBlockingToolHookCommand() {
  const reason = HOOK_DENY_REASON_BLOCKING_TOOL.replace(/"/g, '\\"');
  return `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason}"}}'`;
}

function buildSettingsJSON({ hookCallbackUrl } = {}) {
  const preToolUse = [{
    matcher: 'AskUserQuestion|ExitPlanMode',
    hooks: [{
      type: 'command',
      timeout: 5,
      command: buildBlockingToolHookCommand(),
    }],
  }];
  if (hookCallbackUrl) {
    // Interactive permission gating for destructive tools. Always
    // registered when a callback URL is available so plan→ask runtime
    // switches gate correctly without a respawn. The orchestrator-side
    // callback auto-allows when the instance is NOT in ask mode, so the
    // overhead in plan/code is just a localhost round-trip.
    preToolUse.push({
      matcher: ASK_GATED_TOOL_MATCHER,
      hooks: [{
        type: 'http',
        url: hookCallbackUrl,
        timeout: HOOK_HTTP_TIMEOUT_S,
      }],
    });
  }
  return JSON.stringify({ hooks: { PreToolUse: preToolUse } });
}

const RING_SIZE = 500;
// Three user-facing modes:
//   - `plan`              — read-only planning; CLI is in plan mode
//   - `ask`               — full power but every destructive tool is gated
//                           by an interactive PreToolUse hook; CLI is in
//                           bypassPermissions
//   - `bypassPermissions` — full power, no gating; CLI is in bypassPermissions
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
const VALID_MODES = new Set(['plan', 'ask', 'bypassPermissions']);
// Start new instances in read-only plan mode by default. The user can pick
// `ask` or `code` (= bypassPermissions) in the new-instance dialog, or
// approve a plan to flip the running instance to bypassPermissions
// mid-session.
const DEFAULT_MODE = 'plan';

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

function resolveClaudeBin() {
  // CLAUDE_BIN may be "node /path/to/script.mjs" so callers can swap in the
  // fake CLI used by tests; split on whitespace.
  const raw = (process.env.CLAUDE_BIN ?? 'claude').trim();
  const parts = raw.split(/\s+/);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

function hookResponseBody(decision, reason) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  return out;
}

function respondHookAllow(res) {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('allow'));
}

function respondHookDeny(res, reason) {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('deny', reason));
}

class Ring {
  constructor(cap) { this.cap = cap; this.buf = []; }
  push(v) {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
  toArray() { return this.buf.slice(); }
  clear() { this.buf.length = 0; }
}

export class Instance extends EventEmitter {
  constructor({ id, project, cwd, mode, effort, thinking, model, hookCallbackUrl = null, worktree = null }) {
    super();
    this.id = id;
    this.project = project;
    this.cwd = cwd;
    this.mode = mode;
    this.effort = effort;
    this.thinking = thinking;
    this.model = model;
    this.hookCallbackUrl = hookCallbackUrl;
    // null for a normal instance; otherwise the worktree metadata object
    // (parentProject, worktreeName, worktreePath, branch, baseBranch,
    // baseSha) so the UI can show a chip and the rebase/ff buttons.
    this.worktree = worktree;
    this.sessionId = null;
    this.pid = null;
    this.status = 'idle';
    this.proc = null;
    this.parser = new Parser();
    this.ring = new Ring(RING_SIZE);
    this._pending = new Map(); // request_id -> { resolve, reject, timer }
    // Pending interactive PreToolUse http hook callbacks. Keyed by
    // tool_use_id (the CLI sends a fresh one per tool call). Each entry
    // holds the Express response object — held open until either a WS
    // hook_decision arrives or HOOK_PENDING_TIMEOUT_MS fires.
    this._pendingHookCalls = new Map(); // toolUseId -> { res, timer, toolName }
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
    };
  }

  ringSnapshot() { return this.ring.toArray(); }

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
    if (!sessionId) return;
    const file = path.join(claudeProjectsRoot(), encodeCwd(this.cwd), `${sessionId}.jsonl`);
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let replayed = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (this._replayPersisted(obj)) replayed++;
      if (typeof obj.uuid === 'string') this._lastLeafUuid = obj.uuid;
    }
    if (replayed > 0) {
      this._emitUi({ kind: 'system', subtype: 'history_replayed', data: { sessionId, count: replayed } });
    }
  }

  _replayPersisted(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.isSidechain) return false; // skip sidechain/subagent traces — they're noisy
    if (obj.type === 'user') {
      const msg = obj.message ?? {};
      const content = msg.content;
      if (typeof content === 'string') {
        this._emitUi({ kind: 'user_echo', text: content });
        return true;
      }
      if (Array.isArray(content)) {
        let any = false;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            this._emitUi({
              kind: 'tool_result',
              toolUseId: block.tool_use_id ?? null,
              content: block.content ?? '',
              isError: !!block.is_error,
            });
            any = true;
          } else if (block.type === 'text') {
            this._emitUi({ kind: 'user_echo', text: block.text ?? '' });
            any = true;
          }
        }
        return any;
      }
      return false;
    }
    if (obj.type === 'assistant') {
      const msg = obj.message ?? {};
      const msgId = msg.id ?? obj.uuid ?? `replay-${this.ring.buf.length}`;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let any = false;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          this._emitUi({ kind: 'text_delta', msgId, blockIdx: i, text: b.text ?? '' });
          this._emitUi({ kind: 'text_end', msgId, blockIdx: i });
          any = true;
        } else if (b.type === 'thinking') {
          const text = b.thinking ?? b.text ?? '';
          this._emitUi({ kind: 'thinking_start', msgId, blockIdx: i });
          if (text) {
            this._emitUi({ kind: 'thinking_delta', msgId, blockIdx: i, text });
          } else {
            this._emitUi({ kind: 'thinking_redacted', msgId, blockIdx: i });
          }
          this._emitUi({ kind: 'thinking_end', msgId, blockIdx: i });
          any = true;
        } else if (b.type === 'tool_use') {
          this._emitUi({ kind: 'tool_use_start', msgId, blockIdx: i, toolUseId: b.id ?? null, name: b.name ?? null });
          this._emitUi({ kind: 'tool_use', msgId, blockIdx: i, toolUseId: b.id ?? null, name: b.name ?? null, input: b.input ?? {} });
          // Mirror the parser's structured event emission for the live path —
          // a replayed AskUserQuestion / ExitPlanMode should render as a
          // question / plan card, not just a collapsed generic tool block.
          if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
            this._emitUi({
              kind: 'user_question',
              toolUseId: b.id ?? null,
              questions: b.input.questions,
            });
          }
          if (b.name === 'ExitPlanMode') {
            this._emitUi({
              kind: 'plan_request',
              toolUseId: b.id ?? null,
              plan: typeof b.input?.plan === 'string' ? b.input.plan : null,
              planPath: null,
            });
          }
          any = true;
        }
      }
      return any;
    }
    return false;
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
    if (this.model) args.push('--model', this.model);
    if (resume) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);

    this._setStatus('spawning');
    this.parser.reset();

    this.proc = spawn(command, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.proc.pid;

    const outRl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    outRl.on('line', (line) => this._handleStdoutLine(line));

    const errRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });
    errRl.on('line', (line) => {
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
    if (!this.sessionId || !this._lastLeafUuid) return;
    const dir = path.join(claudeProjectsRoot(), encodeCwd(this.cwd));
    const file = path.join(dir, `${this.sessionId}.jsonl`);
    // Persist the CLI-level permission mode (not the orchestrator's 'ask'
    // label) so `claude --resume` from the shell can pick up a valid
    // value. The 'ask' nuance is orchestrator-only and doesn't survive a
    // shell-side resume — that's deliberate.
    const lines =
      JSON.stringify({ type: 'last-prompt', leafUuid: this._lastLeafUuid, sessionId: this.sessionId }) + '\n' +
      JSON.stringify({ type: 'permission-mode', permissionMode: cliPermissionMode(this.mode), sessionId: this.sessionId }) + '\n';
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file, lines);
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
    // gone, so the tool won't run anyway, but we still need to free the
    // held-open HTTP responses.
    for (const [toolUseId, pending] of this._pendingHookCalls) {
      clearTimeout(pending.timer);
      respondHookDeny(pending.res, 'instance exited before user responded');
      this._emitUi({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'exited' });
    }
    this._pendingHookCalls.clear();
  }

  _sendRaw(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('subprocess not writable');
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  prompt(text) {
    if (typeof text !== 'string' || !text.length) throw new Error('prompt requires non-empty text');
    if (!this.proc) throw new Error('not running');
    this._emitUi({ kind: 'user_echo', text });
    this._sendRaw({
      type: 'user',
      message: { role: 'user', content: text },
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

  // Invoked by the REST hook callback endpoint. Either auto-allows
  // (non-ask modes) or suspends the Express response until the user
  // clicks Allow/Deny in the UI and a WS hook_decision message comes
  // back. The response body is the JSON the CLI reads to decide whether
  // the tool runs.
  handleHookCallback(envelope, res) {
    const toolUseId = envelope?.tool_use_id;
    const toolName = envelope?.tool_name;
    if (this.mode !== 'ask') {
      respondHookAllow(res);
      return;
    }
    if (!toolUseId) {
      // Defensive — without a tool_use_id we can't correlate a later
      // decision back to this pending response. Auto-allow so the user
      // isn't silently blocked by a malformed hook envelope.
      respondHookAllow(res);
      return;
    }
    // Surface the request to the UI so the user sees the Allow/Deny card.
    this._emitUi({
      kind: 'permission_request',
      toolUseId,
      toolName,
      toolInput: envelope?.tool_input ?? {},
    });
    const timer = setTimeout(() => {
      const pending = this._pendingHookCalls.get(toolUseId);
      if (!pending) return;
      this._pendingHookCalls.delete(toolUseId);
      respondHookDeny(pending.res, 'user did not respond in time');
      this._emitUi({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'timeout' });
    }, HOOK_PENDING_TIMEOUT_MS);
    // Don't keep the event loop alive just for this timer — server
    // shutdown should be able to finish even if a permission card is
    // sitting idle.
    if (typeof timer.unref === 'function') timer.unref();
    this._pendingHookCalls.set(toolUseId, { res, timer, toolName });
  }

  resolveHookCallback(toolUseId, allow) {
    const pending = this._pendingHookCalls.get(toolUseId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingHookCalls.delete(toolUseId);
    if (allow) respondHookAllow(pending.res);
    else respondHookDeny(pending.res, 'user denied via orchestrator UI');
    this._emitUi({ kind: 'permission_resolved', toolUseId, allow: !!allow });
    return true;
  }

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

  async create({ project, resume, mode, effort, thinking, model, worktree } = {}) {
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
    const finalMode = mode ?? DEFAULT_MODE;
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
      worktree: worktreeMeta,
    });

    inst.on('event', (ev) => this.emit('event', { id, ev }));
    inst.on('status', (summary) => this.emit('status', summary));

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
