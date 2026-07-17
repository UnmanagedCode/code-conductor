import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.js';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');

// A safe store root is in effect the moment this module loads (reuses the
// run-level root inherited from run.mjs, or mints one when a file is run
// standalone). bootServer's teardown restores to it so an out-of-window write
// never falls through to the source-relative production store.
const SAFE = ensureSafeStoreEnv();

export async function makeTmpHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-'));
  await fs.mkdir(path.join(dir, 'project'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude', 'projects'), { recursive: true });
  return dir;
}

export async function rmrf(p) {
  // The orchestrator does best-effort async writes into <root>/.code-conductor
  // (session titles, projects cache, …). Under concurrent test load one can land
  // between fs.rm's readdir and rmdir, throwing ENOTEMPTY (force swallows ENOENT,
  // not ENOTEMPTY). maxRetries retries exactly that class with linear backoff —
  // a deterministic wait for the late writer to finish, not a fixed sleep.
  await fs.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// Launcher selection:
//   default            → InProcessClaudeLauncher: the fake-claude engine runs on
//                        the event loop, ZERO OS subprocesses per instance. This
//                        is the forget-proof default so any normally-written test
//                        spawns no processes (the phantom-process-killer defense).
//   realProcess: true  → real subprocess launcher spawning `node fake-claude.mjs`;
//                        for the handful of tests that need a real .pid / OS
//                        `process.kill` / sync-shutdown SIGKILL+reap.
//   useRealClaude:true → the real `claude` binary (RUN_REAL_CLAUDE smoke suite).
export async function bootServer({ scenarioPath, useRealClaude = false, realProcess = false } = {}) {
  // Reset the projects git-facts cache so stale entries from a previous test
  // can't bleed into this one. TTL=0 gives pure-coalescing semantics:
  // concurrent requests coalesce but sequential requests always recompute,
  // so integration tests always see exact live data.
  resetProjectsCache(0);
  const tmpHome = await makeTmpHome();
  const projectsRoot = path.join(tmpHome, 'project');
  const claudeProjectsRoot = path.join(tmpHome, '.claude', 'projects');

  const prev = {
    PROJECTS_ROOT: process.env.PROJECTS_ROOT,
    CLAUDE_PROJECTS_ROOT: process.env.CLAUDE_PROJECTS_ROOT,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    FAKE_CLAUDE_SCENARIO: process.env.FAKE_CLAUDE_SCENARIO,
  };
  process.env.PROJECTS_ROOT = projectsRoot;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjectsRoot;
  let claudeLauncher; // undefined ⇒ createServer uses the production RealClaudeLauncher
  if (useRealClaude) {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_SCENARIO;
  } else if (realProcess) {
    process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_CLAUDE}`;
    if (scenarioPath) process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
    else delete process.env.FAKE_CLAUDE_SCENARIO;
  } else {
    // In-process default. A BARE sentinel CLAUDE_BIN (no script path) keeps
    // resolveClaudeBin's prefixArgs empty, so the argv the engine sees equals
    // the real CLI flag set — otherwise the fake-claude.mjs path would pollute
    // FAKE_CLAUDE_ARGV_DUMP. The launcher ignores `command` entirely.
    process.env.CLAUDE_BIN = 'claude';
    if (scenarioPath) process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
    else delete process.env.FAKE_CLAUDE_SCENARIO;
    claudeLauncher = new InProcessClaudeLauncher();
  }

  const { server, instances, pluginHost, pluginLibrary } = createServer({ claudeLauncher });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  // Mirror server.js's start() flow — instances need the bound port to
  // construct the PreToolUse http hook callback URL, plugin children get
  // CONDUCTOR_URL from it. (No pluginHost.init() here — it's lazy on first
  // use, and eager discovery would race tests that build projects later.)
  if (instances) instances.setServerPort(port);
  if (pluginHost) pluginHost.setServerPort(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  async function close() {
    if (instances && typeof instances.shutdown === 'function') await instances.shutdown();
    if (pluginHost) await pluginHost.stopAll();
    await new Promise(r => server.close(r));
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) { process.env[k] = v; continue; }
      // Never restore PROJECTS_ROOT/CLAUDE_PROJECTS_ROOT to unset — that would
      // let an out-of-window store write fall through to the real production
      // store. Restore to the safe run-level root instead. CLAUDE_BIN /
      // FAKE_CLAUDE_SCENARIO are fine unset.
      if (k === 'PROJECTS_ROOT') process.env[k] = SAFE.projectsRoot;
      else if (k === 'CLAUDE_PROJECTS_ROOT') process.env[k] = SAFE.claudeProjectsRoot;
      else delete process.env[k];
    }
    await rmrf(tmpHome);
  }

  return { baseUrl, wsUrl, server, instances, pluginHost, pluginLibrary, tmpHome, projectsRoot, claudeProjectsRoot, close };
}

// MCP returns no longer carry the instanceId — resolve a live instance from
// its stable sessionId for tests that need to poke internal Instance state.
export const instForSession = (instances, sid) =>
  instances.get(instances.idsForSession(sid)[0]);

// Point PROJECTS_ROOT/CLAUDE_PROJECTS_ROOT at a fresh temp home so a server
// shared across a file (booted once in before(), torn down in after()) still
// sees a pristine settings/sidecar/project namespace each test. Mirrors the
// per-server tmpHome setup bootServer does internally — projectsRoot() /
// orchStoreRoot() / claudeProjectsRoot() all read process.env live, and the
// appSettings cache keys by settingsPath(), so swapping the root here gives
// each test fresh on-disk + cached state without rebooting the server. Pair
// with `await instances.shutdown()` (clears the in-memory byId map, the only
// non-root-keyed state) and `await rmrf(home)` in afterEach.
export async function freshProjectsRoot() {
  resetProjectsCache(0);
  const home = await makeTmpHome();
  process.env.PROJECTS_ROOT = path.join(home, 'project');
  process.env.CLAUDE_PROJECTS_ROOT = path.join(home, '.claude', 'projects');
  return {
    home,
    projectsRoot: process.env.PROJECTS_ROOT,
    claudeProjectsRoot: process.env.CLAUDE_PROJECTS_ROOT,
  };
}

export async function api(baseUrl, method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// Default deadline is generous on purpose. These tests spawn fake-claude
// (a Node subprocess) and poll for the result of a turn round-trip; under the
// concurrent runner (up to 4 files in parallel) on a slow Termux/Android box
// the children CPU-starve each other, so spawn + round-trip can spike past a
// few seconds. waitFor returns the instant the predicate is true, so a wide
// ceiling is free on the happy path and only widens the failure-detection
// window. 10s stays well under the runner's 60s per-test timeout even when a
// test chains several waits.
export async function waitFor(predicate, { timeout = 10000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = await predicate(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await new Promise(r => setTimeout(r, interval));
  }
}
