// A ClaudeLauncher that replays a captured CLI stdout stream
// (tests/fixtures/auto-background/<cell>.stdout.ndjson) on the captured schedule,
// for cc's real Instance to consume. Test-only: passed to
// bootServer({claudeLauncher}).
//
// WHY NOT tests/fake-claude-engine.mjs: that engine emits only in response to a
// stdin line, with ONE delay between every event, so it cannot stage a turn the
// CLI starts by itself (no stdin) nor the captured, uneven gaps. This launcher
// keeps the engine's child-process shape (in-memory streams, an 'exit' that
// follows stdout/stderr EOF) and adds a schedule.
//
// Schedule: the capture's own order. A recorded stdin write becomes a GATE (wait
// for the k-th user line from cc), a recorded SIGTERM a gate on
// kill('SIGTERM'), a recorded stdin close a gate on stdin end. Between events
// the captured gap is kept up to REPLAY_GAP_CAP_MS (default 3000); longer gaps
// (the wait for the threshold, the task's run time) are cut to that cap. Every
// captured gap below the cap — including the backgrounding→result gap and
// notification→init→message_start — is exact.
//
// Routing: a launch whose env carries CC_TEST_REPLAY_CAPTURE=<fixture file>
// replays it; every other launch (the owner session) goes to `delegate`.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import fs from 'node:fs';

const CAP_MS = Number(process.env.REPLAY_GAP_CAP_MS ?? 3000);

export function buildPlan(file) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const plan = []; let prevT = 0; let userN = 0;
  for (const e of entries) {
    const gap = Math.max(0, (e.t - prevT) * 1000);
    prevT = e.t;
    if (e.stdin_sent !== undefined) { plan.push({ gate: 'user', n: ++userN }); continue; }
    if (e.sigterm_sent) { plan.push({ gate: 'term' }); continue; }
    if (e.stdin_closed) { plan.push({ gate: 'stdin_end' }); continue; }
    if (e.idle_exit || e.sigkill_max) continue; // the capture harness's own cleanup, not CLI behaviour
    if (e.exit) { if (e.exit.code !== null) plan.push({ wait: Math.min(gap, CAP_MS), exit: e.exit }); continue; }
    if (e.line !== undefined) plan.push({ wait: Math.min(gap, CAP_MS), line: e.line });
  }
  return plan;
}

class ReplayChild extends EventEmitter {
  constructor(plan, { sid, cwd }) {
    super();
    this.pid = null; this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.killed = false; this._exited = false;
    this.plan = plan; this.sid = sid; this.cwd = cwd;
    this.userLines = 0; this.waiters = []; this.stdinEnded = false; this.termSeen = false;
    this.done = new Promise((r) => { this._doneResolve = r; });
    readline.createInterface({ input: this.stdin, crlfDelay: Infinity })
      .on('line', (l) => { let o; try { o = JSON.parse(l); } catch { return; } if (o.type === 'user') { this.userLines++; this._poke(); } })
      .on('close', () => { this.stdinEnded = true; this._poke(); });
    this._run().catch((e) => { this.stderr.write(String(e?.stack ?? e) + '\n'); this._drain(1, null); });
  }
  _poke() { for (const w of this.waiters.splice(0)) w(); }
  _until(pred) { return new Promise((res) => { const chk = () => (pred() ? res() : this.waiters.push(chk)); chk(); }); }
  _rewrite(line) {
    const o = JSON.parse(JSON.stringify(line).replaceAll('"S1"', JSON.stringify(this.sid)));
    if (o.type === 'system' && o.subtype === 'init') { o.session_id ??= this.sid; o.cwd ??= this.cwd; }
    return JSON.stringify(o);
  }
  async _run() {
    for (const step of this.plan) {
      if (this._exited) return;
      if (step.gate === 'user') await this._until(() => this.userLines >= step.n || this._exited);
      else if (step.gate === 'term') await this._until(() => this.termSeen || this._exited);
      else if (step.gate === 'stdin_end') await this._until(() => this.stdinEnded || this._exited);
      if (this._exited) return;
      if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
      if (this._exited) return;
      if (step.line !== undefined) this.stdout.write(this._rewrite(step.line) + '\n');
      else if (step.exit) { this._drain(step.exit.code, step.exit.sig); return; }
    }
    this._doneResolve(true);
    // Plan exhausted: stay alive like an idle CLI; leave only when cc closes stdin or kills us.
    await this._until(() => this.stdinEnded || this.termSeen || this._exited);
    if (!this._exited) this._drain(this.termSeen ? 143 : 0, null);
  }
  _drain(code, signal) {
    if (this._exited) return; this._exited = true; this._doneResolve(true); this._poke();
    let pending = 2;
    const done = () => {
      if (--pending) return;
      this.exitCode = code; this.signalCode = signal;
      setImmediate(() => { this.emit('exit', code, signal); setImmediate(() => this.emit('close', code, signal)); });
    };
    this.stdout.once('end', done); this.stderr.once('end', done); this.stdout.end(); this.stderr.end();
  }
  kill(signal = 'SIGTERM') {
    if (this._exited) return false;
    this.killed = true;
    if (signal === 'SIGKILL') {
      for (const s of [this.stdin, this.stdout, this.stderr]) { try { s.destroy(); } catch { /* ignore */ } }
      this._exited = true; this._doneResolve(true); this._poke();
      setImmediate(() => { this.emit('exit', null, 'SIGKILL'); setImmediate(() => this.emit('close', null, 'SIGKILL')); });
      return true;
    }
    this.termSeen = true; this._poke();
    // Plan has no SIGTERM gate left: exit as a SIGTERMed CLI does.
    if (!this.plan.some((s) => s.gate === 'term')) this._drain(143, null);
    return true;
  }
}

export class ReplayLauncher {
  inProcess = true;
  constructor(delegate) { this.delegate = delegate; this.children = []; }
  launch(opts) {
    const file = opts.env?.CC_TEST_REPLAY_CAPTURE;
    if (!file) return this.delegate.launch(opts);
    const a = opts.args; const i = Math.max(a.indexOf('--session-id'), a.indexOf('--resume'));
    const child = new ReplayChild(buildPlan(file), { sid: a[i + 1], cwd: opts.cwd });
    this.children.push(child);
    return child;
  }
}
