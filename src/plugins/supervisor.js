import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { allocatePort, waitForPort, pidAlive } from './ports.js';

// Plugin child-process supervisor — a port of code-hub's src/runner.js.
// Each child is the manifest's blocking `backend.start` command spawned in
// its OWN process group (detached ⇒ pgid === pid) with $PORT injected, so
// children survive the conductor's self-respawn (adopt-don't-drain) and a
// stop can kill the whole tree via the group. NOT InstanceManager — plugin
// children speak plain HTTP, not the claude stream-json protocol.

const GRACE_MS = 3000;        // SIGTERM → SIGKILL grace period
const READY_TIMEOUT_MS = 30000;
const OUTPUT_CAP = 16 * 1024; // per-plugin crash-tail
const EADDRINUSE_RETRIES = 3;
const SPAWN_SETTLE_MS = 400;  // window to catch a fast EADDRINUSE crash before committing to this attempt's port

// Factory (not module state) so each plugin host — and each test — gets an
// isolated child table. Options beyond onExit exist only for test speed.
export function createSupervisor({
  onExit,
  _allocatePort = allocatePort,
  _readyTimeoutMs = READY_TIMEOUT_MS,
  _settleMs = SPAWN_SETTLE_MS,
} = {}) {
  // id → { proc, pgid, status, error, output }. Children adopted after a
  // conductor restart have no entry here (their stdout can't be recaptured);
  // the registry tracks those via the persisted runtime record only.
  const children = new Map();

  function runtime(id) {
    const c = children.get(id);
    if (!c) return null;
    return { status: c.status, error: c.error, output: c.output };
  }

  function appendOutput(c, chunk) {
    c.output += chunk;
    if (c.output.length > OUTPUT_CAP) c.output = c.output.slice(-OUTPUT_CAP);
  }

  function settle(c, status, error = null) {
    if (c.status !== 'starting') return;
    c.status = status;
    c.error = error;
  }

  function spawnChild({ id, manifest, cwd, env }, port) {
    const proc = spawn('bash', ['-lc', manifest.backend.start], {
      cwd,
      env: { ...process.env, ...env, PORT: String(port), CONDUCTOR_PLUGIN_ID: id },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const c = { proc, pgid: proc.pid, status: 'starting', error: null, output: '' };

    const onData = (d) => appendOutput(c, d.toString());
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
  function raceSettle(c, ms) {
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
  async function start({ id, manifest, cwd, env = {} }) {
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
          (e) => settle(c, 'crashed', `${e.message}\n${c.output.slice(-2000)}`),
        );
      }
      const gitHead = await headSha(cwd);
      return { pid: c.proc.pid, pgid: c.proc.pid, port, startedAt: new Date().toISOString(), gitHead };
    }
  }

  function detectReady(manifest, port, c) {
    const { readyWhen, healthPath } = manifest.backend;
    if (readyWhen) {
      const re = new RegExp(readyWhen);
      return poll(() => re.test(c.output));
    }
    if (healthPath) {
      return poll(() => httpOk(port, healthPath));
    }
    return waitForPort(port, { timeoutMs: _readyTimeoutMs });
  }

  function poll(pred, { timeoutMs = _readyTimeoutMs, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        let ok = false;
        try { ok = await pred(); } catch { ok = false; }
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('readiness not confirmed within timeout'));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // Kill the process group: SIGTERM, then SIGKILL after a grace period if
  // the leader is still alive. Only needs the pgid, so it also works for
  // adopted children with no `children` entry.
  function stop({ id, pgid }) {
    children.delete(id);
    try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
    const t = setTimeout(() => {
      if (pidAlive(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
    }, GRACE_MS);
    t.unref();
  }

  return { start, stop, runtime };
}

// Any HTTP response counts — "the server answered", not "2xx".
export function httpOk(port, path) {
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
export function headSha(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}
