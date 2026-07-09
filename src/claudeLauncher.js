import { spawn } from 'node:child_process';

// The single seam through which an Instance launches its `claude` subprocess.
// `launch({command,args,cwd,env})` returns a ChildProcess-like handle:
//   .pid, .stdin (Writable), .stdout/.stderr (Readable), .kill(signal?),
//   and EventEmitter 'exit'(code,signal) / 'close'(code,signal) / 'error'(err).
// Instance.spawn() treats the return value as opaque, so the production path
// (RealClaudeLauncher) hands back a raw ChildProcess with zero behavior change,
// while tests inject an in-process implementation that runs the fake-claude
// scenario engine on the event loop (no OS process — see tests/inProcessLauncher.mjs).
export class RealClaudeLauncher {
  launch({ command, args, cwd, env }) {
    return spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

// Production default. Injected at the composition root (createServer) only when a
// caller overrides it; omitting the option keeps this real launcher.
export const defaultClaudeLauncher = new RealClaudeLauncher();
