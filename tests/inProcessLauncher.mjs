import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runFakeClaude } from './fake-claude-engine.mjs';

// A ChildProcess-like handle backed by in-memory streams — no OS process. It
// provides exactly the surface Instance consumes from `this.proc`:
//   .pid (null), .stdin/.stdout/.stderr (streams), .kill(signal),
//   EventEmitter 'exit'(code,signal) / 'close'(code,signal) / 'error'(err).
//
// pid is deliberately null: the manager's sync-shutdown paths
// (shutdownTempSync / shutdownForResumeSync) guard on `inst.pid` before issuing
// OS-level process.kill, so null makes those a safe skip rather than risking a
// process.kill against a synthetic pid that could collide with a real process.
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdin = new PassThrough();   // parent writes; engine reads
    this.stdout = new PassThrough();  // engine writes; parent readline reads
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this._exited = false;
    this._closeReader = null; // set once the engine's readline is up
  }

  // Gate exit on the READABLE-side 'end' of stdout/stderr: that only fires after
  // the parent's readline has consumed to EOF, so 'exit' can never precede
  // delivery of the last turn_end/result line (the crux of turn-assert fidelity).
  _drainThenFinish(code, signal) {
    if (this._exited) return;
    let pending = 2;
    const done = () => { if (--pending === 0) this._finish(code, signal); };
    this.stdout.once('end', done);
    this.stderr.once('end', done);
    this.stdout.end();
    this.stderr.end();
  }

  _finish(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    // Async, mirroring a real ChildProcess: 'exit' then 'close' on later ticks.
    setImmediate(() => {
      this.emit('exit', code, signal);
      setImmediate(() => this.emit('close', code, signal));
    });
  }

  kill(signal = 'SIGTERM') {
    if (this._exited) return false;
    this.killed = true;
    if (signal === 'SIGKILL') {
      // Uncatchable: tear down streams immediately, no drain, report a killed-
      // by-signal exit (code null, signal 'SIGKILL') exactly like a real kill.
      for (const s of [this.stdin, this.stdout, this.stderr]) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      this._finish(null, 'SIGKILL');
    } else {
      // Graceful (SIGTERM/default): mirror fake-claude's SIGTERM handler —
      // close the reader, which resolves the engine → drain → exit(0, null).
      if (this._closeReader) this._closeReader();
      else { try { this.stdin.end(); } catch { /* ignore */ } }
    }
    return true;
  }
}

// Test launcher: runs the fake-claude scenario engine on the event loop against
// in-memory streams. Stateless — everything (scenario path, transcript/dump
// paths, plan file) is read from the `env` handed to each launch, exactly as the
// real subprocess reads process.env. Ignores `command` (there is no binary).
export class InProcessClaudeLauncher {
  launch({ command, args, cwd, env }) {
    const child = new FakeChildProcess();
    // Defer all engine activity: the parent wires up readline + 'exit'/'error'
    // listeners AFTER launch() returns, so nothing must emit synchronously.
    setImmediate(() => {
      runFakeClaude({
        argv: args,
        env,
        cwd,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onReaderReady: (closeReader) => { child._closeReader = closeReader; },
      }).then(
        (code) => child._drainThenFinish(code ?? 0, null),
        (err) => {
          try { child.stderr.write(String(err?.stack ?? err) + '\n'); } catch { /* ignore */ }
          // A bad/missing scenario resolves via `return 2` (not a throw); a
          // genuine throw here is an engine bug — surface as a nonzero exit so
          // Instance flips to 'crashed' rather than hanging.
          child._drainThenFinish(1, null);
        },
      );
    });
    return child;
  }
}
