import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { Parser } from './parser.js';
import { getProject, encodeCwd, claudeProjectsRoot } from './projects.js';

const RING_SIZE = 500;
// Only two modes are exposed: `plan` (read-only planning) and
// `bypassPermissions` (full power). The CLI's `default`/`acceptEdits`
// modes auto-deny tool calls in stream-json --print (no SDK canUseTool
// callback registered), and the only way to recover would be to make the
// model re-emit the entire tool input — expensive for anything with a
// large `content` field. We force the choice up front instead.
const VALID_MODES = new Set(['plan', 'bypassPermissions']);
// Start new instances in read-only plan mode by default. The user can pick
// `code` (= bypassPermissions) in the new-instance dialog, or approve a
// plan to flip the running instance to bypassPermissions mid-session.
const DEFAULT_MODE = 'plan';
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
  constructor({ id, project, cwd, mode, effort, thinking, model }) {
    super();
    this.id = id;
    this.project = project;
    this.cwd = cwd;
    this.mode = mode;
    this.effort = effort;
    this.thinking = thinking;
    this.model = model;
    this.sessionId = null;
    this.pid = null;
    this.status = 'idle';
    this.proc = null;
    this.parser = new Parser();
    this.ring = new Ring(RING_SIZE);
    this._pending = new Map(); // request_id -> { resolve, reject, timer }
    this._stderr = '';
    this._lastLeafUuid = null;     // for last-prompt jsonl marker
    this._lastPlanFilePath = null; // last Write to ~/.claude/plans/*.md, used to enrich ExitPlanMode
    this._autoInterruptedThisTurn = false; // true while orchestrator-driven interrupt is in flight
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
      '--permission-mode', this.mode,
      '--effort', this.effort,
      '--thinking', this.thinking,
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
        if (mode && VALID_MODES.has(mode)) this.mode = mode;
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
      // Only strip the `[Request interrupted by user]` marker when WE
      // triggered the interrupt as part of the AskUserQuestion / ExitPlanMode
      // flow. If the user manually clicked Interrupt the marker should
      // still appear in the conversation as visible confirmation.
      if (ev.kind === 'text_end' && ev.isInterruptMarker) {
        if (this._autoInterruptedThisTurn) {
          ev.kind = 'text_strip';
        }
        delete ev.isInterruptMarker;
      }
      if (ev.kind === 'turn_end') {
        this._autoInterruptedThisTurn = false;
      }
      this._emitUi(ev);
      // Pre-empt the model's follow-up after AskUserQuestion or
      // ExitPlanMode. In stream-json mode the CLI auto-errors both tools
      // ("Answer questions?" / "Exit plan mode?"), and without an
      // interrupt the model would compose a confused follow-up that
      // makes the inline approval / question card feel ignorable.
      if (ev.kind === 'user_question' || ev.kind === 'plan_request') {
        this._autoInterruptedThisTurn = true;
        this.interrupt().catch(() => {});
      }
    }
  }


  async _writeSessionMetadata() {
    if (!this.sessionId || !this._lastLeafUuid) return;
    const dir = path.join(claudeProjectsRoot(), encodeCwd(this.cwd));
    const file = path.join(dir, `${this.sessionId}.jsonl`);
    const lines =
      JSON.stringify({ type: 'last-prompt', leafUuid: this._lastLeafUuid, sessionId: this.sessionId }) + '\n' +
      JSON.stringify({ type: 'permission-mode', permissionMode: this.mode, sessionId: this.sessionId }) + '\n';
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
    await this._controlRequest({ subtype: 'set_permission_mode', mode });
    this.mode = mode;
    this.emit('status', this.summary());
    this._writeSessionMetadata().catch(() => {});
    return this.mode;
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
  }

  list() { return [...this.byId.values()].map(i => i.summary()); }
  get(id) { return this.byId.get(id); }
  idsForProject(name) {
    return [...this.byId.values()].filter(i => i.project === name).map(i => i.id);
  }

  async create({ project, resume, mode, effort, thinking, model } = {}) {
    if (!project) {
      throw Object.assign(new Error('project required'), { statusCode: 400 });
    }
    const proj = await getProject(project);
    const finalMode = mode ?? DEFAULT_MODE;
    if (!VALID_MODES.has(finalMode)) {
      throw Object.assign(new Error('invalid mode (must be plan or bypassPermissions)'), { statusCode: 400 });
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
    const id = randomUUID();
    const inst = new Instance({
      id, project, cwd: proj.path,
      mode: finalMode, effort: finalEffort, thinking: finalThinking, model: finalModel,
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

  async shutdown() {
    const all = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(all.map(i => i.kill({ graceMs: 200 }).catch(() => {})));
  }
}
