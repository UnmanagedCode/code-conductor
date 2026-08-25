import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { allocatePort, tcpOpen } from './ports.ts';
import { killProcessGroup, GROUP_OUTPUT_CAP } from '../groupedCommand.ts';
import type { PluginBackend } from './manifest.ts';

// Plugin child-process supervisor — a port of code-hub's src/runner.js.
// Each child is the manifest's blocking `backend.start` command spawned in
// its OWN process group (detached ⇒ pgid === pid) with $PORT injected, so
// children survive the conductor's self-respawn (adopt-don't-drain) and a
// stop can kill the whole tree via the group. NOT InstanceManager — plugin
// children speak plain HTTP, not the claude stream-json protocol.

const GRACE_MS = 3000;        // SIGTERM → SIGKILL grace period
const READY_TIMEOUT_MS = 30000;
const OUTPUT_CAP = GROUP_OUTPUT_CAP; // per-plugin crash-tail
const EADDRINUSE_RETRIES = 3;
const SPAWN_SETTLE_MS = 400;  // window to catch a fast EADDRINUSE crash before committing to this attempt's port

export type ChildStatus = 'starting' | 'ready' | 'crashed' | 'exited';

interface ChildRecord {
  proc: ReturnType<typeof spawn>;
  pgid: number;
  status: ChildStatus;
  error: string | null;
  output: string;
}

export interface ChildRuntime {
  status: ChildStatus;
  error: string | null;
  output: string;
}

export interface SupervisorStartInput {
  id: string;
  manifest: { backend: PluginBackend };
  cwd: string;
  env?: Record<string, string>;
}

export interface StartedChild {
  pid: number;
  pgid: number;
  port: number;
  startedAt: string;
  gitHead: string | null;
}

// Factory (not module state) so each plugin host — and each test — gets an
// isolated child table. Options beyond onExit exist only for test speed and
// determinism: `_spawn` lets a test stand in a child that settles on
// `process.nextTick`, so the settle-window branch under test is decided by
// ORDERING rather than by racing a real `bash -lc node` boot against a wall
// clock (see docs/architecture.md → "Testing" on the 400 ms window).
export function createSupervisor({
  onExit,
  _allocatePort = allocatePort,
  _readyTimeoutMs = READY_TIMEOUT_MS,
  _settleMs = SPAWN_SETTLE_MS,
  _spawn = spawn,
}: {
  onExit?: (id: string, runtime: ChildRuntime) => void;
  _allocatePort?: () => Promise<number>;
  _readyTimeoutMs?: number;
  _settleMs?: number;
  _spawn?: typeof spawn;
} = {}) {
  // id → { proc, pgid, status, error, output }. Children adopted after a
  // conductor restart have no entry here (their stdout can't be recaptured);
  // the registry tracks those via the persisted runtime record only.
  const children = new Map<string, ChildRecord>();

  function runtime(id: string): ChildRuntime | null {
    const c = children.get(id);
    if (!c) return null;
    return { status: c.status, error: c.error, output: c.output };
  }

  function appendOutput(c: ChildRecord, chunk: string): void {
    c.output += chunk;
    if (c.output.length > OUTPUT_CAP) c.output = c.output.slice(-OUTPUT_CAP);
  }

  function settle(c: ChildRecord, status: ChildStatus, error: string | null = null): void {
    if (c.status !== 'starting') return;
    c.status = status;
    c.error = error;
  }

  function spawnChild({ id, manifest, cwd, env }: SupervisorStartInput, port: number): ChildRecord {
    const proc = _spawn('bash', ['-lc', manifest.backend.start], {
      cwd,
      env: { ...process.env, ...env, PORT: String(port), CONDUCTOR_PLUGIN_ID: id },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const c: ChildRecord = { proc, pgid: proc.pid ?? 0, status: 'starting', error: null, output: '' };

    const onData = (d: Buffer) => appendOutput(c, d.toString());
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code, signal) => {
      // Exit before readiness = crash; after = the plugin stopped on its own.
      if (c.status === 'starting') settle(c, 'crashed', `start command exited (code=${code}, signal=${signal})\n${c.output.slice(-2000)}`);
      else if (c.status === 'ready') { c.status = 'exited'; c.error = `exited (code=${code}, signal=${signal})`; }
      if (children.get(id) === c) onExit?.(id, { status: c.status, error: c.error, output: c.output });
    });
    proc.on('error', (e) => {
      settle(c, 'crashed', e.message);
      if (children.get(id) === c) onExit?.(id, { status: c.status, error: c.error, output: c.output });
    });

    return c;
  }

  // Resolve once the child settles (crashes) or `ms` elapses, whichever
  // first — only used to decide whether an early death was an EADDRINUSE
  // race worth retrying on a new port.
  function raceSettle(c: ChildRecord, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    return new Promise((resolve) => {
      const tick = () => {
        if (c.status !== 'starting' || Date.now() >= deadline) return resolve();
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  // Spawn + return the record to persist; readiness runs in the background
  // and updates the in-memory runtime status. If the fresh child dies almost
  // immediately with EADDRINUSE (the allocated port got claimed before this
  // bind), retry on a new port a bounded number of times.
  async function start(input: SupervisorStartInput): Promise<StartedChild> {
    const { id, manifest, cwd, env } = input;
    let port = await _allocatePort();
    for (let attempt = 1; ; attempt++) {
      const c = spawnChild({ id, manifest, cwd, env }, port);
      children.set(id, c);

      await raceSettle(c, _settleMs);

      const isPortRace = c.status === 'crashed' && /EADDRINUSE/.test(c.error ?? '');
      if (isPortRace && attempt <= EADDRINUSE_RETRIES) {
        console.error(`[plugins] ${id}: port ${port} was claimed before bind (attempt ${attempt}/${EADDRINUSE_RETRIES}) — retrying on a new port`);
        port = await _allocatePort();
        continue;
      }
      if (isPortRace) {
        console.error(`[plugins] ${id}: still hitting EADDRINUSE after ${EADDRINUSE_RETRIES} retries — giving up`);
      }

      if (c.status === 'starting') {
        detectReady(manifest, port, c).then(
          () => settle(c, 'ready'),
          (e) => settle(c, 'crashed', `${(e as Error).message}\n${c.output.slice(-2000)}`),
        );
      }
      const gitHead = await headSha(cwd);
      return { pid: c.proc.pid ?? 0, pgid: c.proc.pid ?? 0, port, startedAt: new Date().toISOString(), gitHead };
    }
  }

  // ONE poll for all three readiness modes — the branch picks the predicate,
  // not the loop. Single-sourcing the loop is what single-sources the abort
  // below: there is no per-branch cancellation to forget.
  function detectReady(manifest: { backend: PluginBackend }, port: number, c: ChildRecord): Promise<void> {
    const { readyWhen, healthPath } = manifest.backend;
    const re = readyWhen ? new RegExp(readyWhen) : null;
    const pred = re ? () => re.test(c.output)
      : healthPath ? () => httpOk(port, healthPath)
      : () => tcpOpen(port);
    // A child that dies before readiness ends the probing — the deadline is NOT
    // the only exit. Without this, a crash after the settle window leaves up to
    // `_readyTimeoutMs` of HTTP GETs / connects aimed at a port this child
    // never owned and `allocatePort()` may already have reissued. The predicate
    // is `settle()`'s own guard, so liveness has exactly one authority.
    return poll(pred, { abort: () => c.status !== 'starting' });
  }

  function poll(pred: () => boolean | Promise<boolean>, { timeoutMs = _readyTimeoutMs, intervalMs = 200, abort }: { timeoutMs?: number; intervalMs?: number; abort?: () => boolean } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (abort?.()) return reject(new Error('child exited before readiness'));
        let ok = false;
        try { ok = await pred(); } catch { ok = false; }
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('readiness not confirmed within timeout'));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // Kill the process group: SIGTERM, then SIGKILL after a grace period. Only
  // needs the pgid, so it also works for adopted children with no `children`
  // entry. The grace is far longer than the one-shot default — a plugin backend
  // is an HTTP server that deserves time to drain, not a script to cut off.
  function stop({ id, pgid }: { id: string; pgid: number }): void {
    children.delete(id);
    killProcessGroup(pgid, { graceMs: GRACE_MS });
  }

  return { start, stop, runtime };
}

// Any HTTP response counts — "the server answered", not "2xx".
export function httpOk(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode != null);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// HEAD sha of the checkout the child was started from (staleness display).
// Null on any failure — a plugin dir need not be a git repo.
export function headSha(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}
