import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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
// This module is NOT named `*.test.mjs`, so run.mjs's discover() ignores it.
export class ControllableLauncher {
  constructor() { this.children = []; this.failNext = null; this._crashNext = null; }
  crashNext(stderr, code = 1, { exitFirst = false } = {}) { this._crashNext = { stderr, code, exitFirst }; }
  // Whether the next launch is one of this launcher's armed failures.
  get armed() { return this._crashNext !== null || this.failNext !== null; }
  launch() {
    const child = new EventEmitter();
    child.pid = null;
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
    child.kill = () => { finish(null, 'SIGTERM'); return true; };
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
