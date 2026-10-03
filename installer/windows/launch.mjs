// The launcher the Start-menu stub (code-conductor.exe) runs:
//   node launch.mjs            start (or reuse) the server and open the UI
//   node launch.mjs --status   exit 0 running, 1 not running, 2 unidentified answer
//   node launch.mjs --stop     kill the running server tree
// It lives in the checkout, so self-update updates it. Every side effect is
// injectable (`deps`) so tests drive it without Windows.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectGit, detectClaude, launcherEnv, getEnv } from './toolchain.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portOf(env) {
  return Number(getEnv(env, 'PORT') || 8787);
}

// 'cc' (with pid) | 'unidentified' (answers 200 JSON but has no `app`: a build
// that predates the identity field) | 'other' (something else answers) | 'none'
export async function probe(port, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return { kind: 'none' };
  }
  try {
    const body = await res.json();
    if (body && body.app === 'code-conductor') return { kind: 'cc', pid: body.pid };
    if (res.ok && body && typeof body === 'object' && !('app' in body)) return { kind: 'unidentified' };
  } catch { /* not JSON */ }
  return { kind: 'other' };
}

export function makeLog(logFile) {
  return (msg) => fs.appendFileSync(logFile, `[launcher ${new Date().toISOString()}] ${msg}\n`);
}

function tail(file, n = 15) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

const otherMessage = (port) => `port ${port} is in use by another program (set PORT to use a different one)`;
const unidentifiedMessage = (port) => `a server is answering on port ${port} but doesn't identify as code-conductor (pre-Windows build?)`;

export class LaunchError extends Error {
  constructor(message, tailText = '') {
    super(message);
    this.tail = tailText;
  }
}

function defaultCommit(git, appDir) {
  try {
    return execFileSync(git.gitExe, ['-C', appDir, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return 'unknown'; }
}

const defaults = {
  fetch,
  spawn,
  sleep,
  now: Date.now,
  pollMs: 250,
  deadlineMs: 60_000,
  openUrl: (url) => {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  },
  kill: (pid) => execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }),
  readCommit: defaultCommit,
  detectGit,
  detectClaude,
};

export async function launch({ installDir, env = process.env, ...overrides }) {
  const d = { ...defaults, ...overrides };
  const port = portOf(env);
  const url = `http://127.0.0.1:${port}/`;
  const logDir = path.join(installDir, 'logs');
  const logFile = path.join(logDir, 'server.log');
  const appDir = path.join(installDir, 'app');
  fs.mkdirSync(logDir, { recursive: true });

  const state = await probe(port, d.fetch);
  if (state.kind === 'other') throw new LaunchError(otherMessage(port));
  if (state.kind === 'unidentified') throw new LaunchError(unidentifiedMessage(port));
  if (state.kind === 'cc') {
    makeLog(logFile)(`reuse: code-conductor already running (pid ${state.pid}); opening ${url}`);
    d.openUrl(url);
    return { reused: true, pid: state.pid };
  }

  const git = d.detectGit(env);
  if (!git) throw new LaunchError('Git for Windows (with Git Bash) was not found; run the installer again');
  const claude = d.detectClaude(env);
  const serverEnv = launcherEnv({ env, installDir, git, claude });
  const projectsRoot = getEnv(serverEnv, 'PROJECTS_ROOT');

  const prev = path.join(logDir, 'server.prev.log');
  if (fs.existsSync(logFile)) {
    fs.rmSync(prev, { force: true });
    fs.renameSync(logFile, prev);
  }
  const log = makeLog(logFile);
  const pathHead = (getEnv(serverEnv, 'PATH') || '').split(';').slice(0, 4).join(';');
  log(`start: commit ${d.readCommit(git, appDir)}, cwd ${appDir}`);
  log(`start: PROJECTS_ROOT=${projectsRoot}`);
  log(`start: PATH head ${pathHead}`);
  log(`start: claude ${claude ? claude.claudeExe : 'NOT FOUND (run "claude auth login" after installing it)'}`);
  fs.mkdirSync(projectsRoot, { recursive: true });

  const fd = fs.openSync(logFile, 'a');
  let exited = null;
  let child;
  try {
    child = d.spawn(process.execPath, ['server.ts'], {
      cwd: appDir, env: serverEnv, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  child.once('exit', (code, signal) => { exited = `exited with ${code ?? signal}`; });
  child.once('error', (e) => { exited = `failed to start: ${e.message}`; });
  child.unref?.();

  const deadline = d.now() + d.deadlineMs;
  for (;;) {
    const s = await probe(port, d.fetch);
    if (s.kind === 'cc') {
      log(`start: healthy on port ${port} (pid ${s.pid}); opening ${url}`);
      d.openUrl(url);
      return { reused: false, pid: s.pid };
    }
    if (exited) {
      log(`start: server ${exited}`);
      throw new LaunchError(`code-conductor server ${exited}. See ${logFile}`, tail(logFile));
    }
    if (d.now() > deadline) {
      // The pre-spawn probe refused any existing listener, so child.pid is
      // provably ours — and the only process this ever kills.
      const why = s.kind === 'unidentified' ? unidentifiedMessage(port)
        : s.kind === 'other' ? otherMessage(port) : 'code-conductor did not become healthy in time';
      log(`start: gave up waiting for the server to identify itself (port: ${s.kind}); killing pid ${child.pid}`);
      try { if (child.pid) d.kill(child.pid); } catch { /* already gone */ }
      throw new LaunchError(`${why}. See ${logFile}`, tail(logFile));
    }
    await d.sleep(d.pollMs);
  }
}

export async function stop({ env = process.env, ...overrides }) {
  const d = { ...defaults, ...overrides };
  const port = portOf(env);
  const state = await probe(port, d.fetch);
  if (state.kind === 'unidentified') throw new LaunchError(`cannot stop: ${unidentifiedMessage(port)}; close it by hand`);
  if (state.kind !== 'cc') return { stopped: false };
  if (!Number.isInteger(state.pid)) throw new LaunchError('code-conductor is running but its health endpoint reports no pid');
  d.kill(state.pid);
  const deadline = d.now() + 10_000;
  while ((await probe(port, d.fetch)).kind === 'cc') {
    if (d.now() > deadline) throw new LaunchError(`code-conductor (pid ${state.pid}) is still running after taskkill`);
    await d.sleep(d.pollMs);
  }
  return { stopped: true, pid: state.pid };
}

// 0 running, 1 not running (or a stranger holds the port), 2 answering but
// not identifiable as cc (a build that predates the identity field).
export async function status(port, fetchFn = fetch, err = console.error) {
  const kind = (await probe(port, fetchFn)).kind;
  if (kind === 'cc') return 0;
  if (kind === 'unidentified') {
    err(unidentifiedMessage(port));
    return 2;
  }
  return 1;
}

export async function main(argv, env = process.env) {
  const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (argv.includes('--status')) {
    return status(portOf(env));
  }
  try {
    if (argv.includes('--stop')) {
      const r = await stop({ env });
      console.log(r.stopped ? `stopped code-conductor (pid ${r.pid})` : 'code-conductor is not running');
      return 0;
    }
    await launch({ installDir, env });
    return 0;
  } catch (e) {
    if (!(e instanceof LaunchError)) console.error(e.stack);
    console.error(e.message.split('\n')[0]);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
