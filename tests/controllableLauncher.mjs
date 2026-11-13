import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';

// A controllable launcher whose child stays alive until the test triggers a
// spontaneous crash() (nonzero exit + stderr) or Instance.kill() (signalled
// exit). Mirrors FakeChildProcess's drain-then-exit so stderr is fully read by
// the parent readline before 'exit' fires.
//
// Note this launcher's healthy children emit ONLY 'exit', never 'close' — so
// nothing in the terminal-latch design may REQUIRE a 'close', and nothing does.
// `failNext` arms the opposite shape (card 2026-0286 §2): a spawn that never
// started, which emits 'error' then 'close' and no 'exit' at all.
// `crashNext(stderr, code)` arms a CLI that started and then exited on its own
// before anything was sent to it — a startup crash. With `{exitFirst:true}` the
// child emits 'exit' BEFORE its last stderr line is written, then 'close' once
// stdio ends — the order a real child process may deliver them in.
//
// `realProcess: true` backs each child with a real idle node process, so
// `child.pid` is a real pid (the running record names it) and `kill()` signals
// it. `orphanAll()` detaches every such process from its fake child: the fake
// still exits on kill(), the real process keeps running — what a crash of cc
// leaves behind. `orphans` lists those pids for the test's own cleanup.
// `onLaunch(spec)` runs at the start of every launch.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() ignores it.
export class ControllableLauncher {
  constructor({ realProcess = false, onLaunch = null } = {}) {
    this.children = []; this.failNext = null; this._crashNext = null;
    this.realProcess = realProcess; this.onLaunch = onLaunch; this.orphans = [];
  }
  orphanAll() {
    for (const child of this.children) {
      if (!child._real) continue;
      this.orphans.push(child._real.pid);
      child._real = null;
    }
  }
  crashNext(stderr, code = 1, { exitFirst = false } = {}) { this._crashNext = { stderr, code, exitFirst }; }
  // Whether the next launch is one of this launcher's armed failures.
  get armed() { return this._crashNext !== null || this.failNext !== null; }
  launch(spec) {
    this.onLaunch?.(spec);
    const child = new EventEmitter();
    child.pid = null;
    if (this.realProcess) {
      child._real = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
      child.pid = child._real.pid;
    }
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child._exited = false;
    // Settles on 'close', for a test that must wait out the post-exit stderr.
    child.closed = new Promise(r => child.once('close', r));
    const finish = (code, signal) => {
      if (child._exited) return; child._exited = true;
      let pending = 2;
      const done = () => { if (--pending === 0) setImmediate(() => child.emit('exit', code, signal)); };
      child.stdout.once('end', done);
      child.stderr.once('end', done);
      child.stdout.end();
      child.stderr.end();
    };
    child.crash = (msg, code = 1) => { child.stderr.write(msg + '\n'); finish(code, null); };
    child.crashExitFirst = (msg, code = 1) => {
      if (child._exited) return; child._exited = true;
      child.emit('exit', code, null);
      setImmediate(() => {
        let pending = 2;
        const done = () => { if (--pending === 0) setImmediate(() => child.emit('close', code, null)); };
        child.stdout.once('end', done);
        child.stderr.once('end', done);
        child.stderr.write(msg + '\n');
        child.stdout.end();
        child.stderr.end();
      });
    };
    child.kill = (signal = 'SIGTERM') => {
      if (child._real) { try { child._real.kill(signal); } catch { /* gone */ } child._real = null; }
      finish(null, 'SIGTERM');
      return true;
    };
    // A spawn that NEVER STARTED, matching real child_process.spawn against a
    // missing binary: 'error' then 'close(-2, null)', never 'exit', and no
    // stderr — the process never ran, so the reason rides on the spawn_error
    // event rather than launch_failed's stderr field.
    child.failSpawn = (msg) => {
      if (child._exited) return; child._exited = true;
      child.stdout.end(); child.stderr.end();
      child.emit('error', Object.assign(new Error(msg), { code: 'ENOENT' }));
      child.emit('close', -2, null);
    };
    // Both arms are deferred a tick: Instance wires its listeners AFTER launch() returns.
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      setImmediate(() => child.failSpawn(msg));
    } else if (this._crashNext) {
      const { stderr, code, exitFirst } = this._crashNext;
      this._crashNext = null;
      setImmediate(() => (exitFirst ? child.crashExitFirst(stderr, code) : child.crash(stderr, code)));
    }
    this.children.push(child);
    return child;
  }
  get last() { return this.children[this.children.length - 1]; }
}
