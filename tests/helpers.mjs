import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.ts';
import { encodeCwd } from '../src/projects.ts';
import { getSessionBackend } from '../src/sessionBackends.ts';
import { _resetForTest as resetProjectsCache } from '../src/projectsCache.ts';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

export { rmrf };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');

// A safe store root is in effect the moment this module loads (reuses the
// run-level root inherited from run.mjs, or mints one when a file is run
// standalone). bootServer's teardown restores to it so an out-of-window write
// never falls through to the source-relative production store.
const SAFE = ensureSafeStoreEnv();

export async function makeTmpHome() {
  const dir = await mkdtemp('orch-');
  await fs.mkdir(path.join(dir, 'project'), { recursive: true });
  await fs.mkdir(path.join(dir, '.claude', 'projects'), { recursive: true });
  return dir;
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
//   claudeLauncher     → inject a custom launcher (e.g. one that crashes the
//                        subprocess on demand) instead of the in-process fake.
export async function bootServer({ scenarioPath, useRealClaude = false, realProcess = false, claudeLauncher: claudeLauncherOverride } = {}) {
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
  // An explicit override wins (keeps the in-process env setup above so no real
  // subprocess is spawned, but swaps the launcher itself).
  if (claudeLauncherOverride) claudeLauncher = claudeLauncherOverride;

  const { server, instances, pluginHost, pluginLibrary } = createServer({ claudeLauncher });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  // Mirror server.ts's start() flow — instances need the bound port to
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
    // server.close() waits for existing connections to END, so any still-open
    // WebSocket hangs teardown forever. A test that leaks a socket — e.g. by
    // closing it after its assertions rather than in a finally — would then HANG
    // instead of failing, which is strictly worse: it stalls the run and reads as
    // "no verdict" rather than "caught". Drop the sockets first so teardown is
    // unconditional and no future test can reintroduce that class.
    server.closeAllConnections?.();
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

// Write a session jsonl the Claude CLI would have written, at the path
// hasResumableConversation() / findSessionLocation() read. The fake engine writes
// no transcript, so any test that needs a session to be RESUMABLE has to seed one:
// the pre-flight in _doCreate requires the file to hold >= 1 user/assistant record
// (a marker-only stub does not qualify), and `records` defaults to that minimum.
export async function seedSessionJsonl(claudeProjectsRoot, cwd, sessionId, records = [
  { type: 'user', message: { role: 'user', content: 'do the thing' } },
  { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
]) {
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
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

// Drive one worker turn to completion. Replaces the removed send_prompt blocking-wait option.
// `send` is a thunk performing the actual call — each test file has its own
// callTool signature, so the helper owns only the waiting.
export async function driveTurn(instances, sessionId, send) {
  const seqOf = () => instForSession(instances, sessionId)
    ?.ringSnapshot().filter(e => e.kind === 'turn_end').at(-1)?._seq ?? -1;
  const before = seqOf();
  const res = await send();
  await waitFor(() => seqOf() > before);
  return res;
}

// Yield the event loop a bounded number of times (`turns` setImmediate hops), so
// work ALREADY QUEUED as macrotasks gets to run before you assert an absence.
//
// WHAT IT GUARANTEES, precisely: `turns` full loop iterations have completed. It
// does NOT guarantee that any particular pending operation has finished — a
// spurious delivery whose path includes file I/O, a socket round-trip, or more
// than `turns` chained continuations can still be outstanding when this returns.
// So it is a *drain*, not a barrier, and not strictly load-independent either:
// under enough contention a queued continuation can be preempted.
//
// Use it only AFTER a causal barrier — a waitFor on something downstream of the
// decision under test. The barrier is what establishes that the decision was
// made; settle() only flushes what that decision queued. A settle() with no
// barrier in front of it is exactly as vacuous as the fixed sleep it replaced.
// driveTurn() above is the canonical barrier for "the target finished a turn".
export async function settle(turns = 3) {
  for (let i = 0; i < turns; i++) await new Promise(r => setImmediate(r));
}

// The sidecar backend record for a session, once spawn()'s write has landed.
// spawn() is synchronous and fires markSessionBackend without awaiting it (see
// src/instances.ts spawn()), so a 201 / `idle` / argv-dump wait can beat the
// write by a handful of filesystem ops. Every post-spawn read of this store
// waits here rather than sampling; returns the record.
export function settledSessionBackend(sessionId, opts) {
  return waitFor(async () => await getSessionBackend(sessionId), opts);
}

// Every `type:"user"` line the orchestrator wrote to the fake CLI's stdin, in
// order. Requires FAKE_CLAUDE_TRANSCRIPT to have been set before the instance
// launched (tests/fake-claude.mjs appends each stdin line there verbatim).
// This is the only way to see what actually reached the CLI: the ring's
// user_echo is emitted from the raw text BEFORE Instance.prompt prepends
// MID_TURN_NOTE, so assertions about annotation have to read the wire.
export async function userStdinLines(transcriptPath) {
  const raw = await fs.readFile(transcriptPath, 'utf8');
  return raw.split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.type === 'user' && o.message?.role === 'user');
}

// Strips the "--- message i/N · msgId · textChars chars ---" boundary line
// get_recent_messages prefixes into each body when it returns more than one
// message (src/mcp/handlers.ts messageBoundaryHeader). No-op when absent, so
// callers can run every body through this before asserting on prose content
// regardless of how many messages came back.
const BOUNDARY_HEADER_RE = /^--- message \d+\/\d+ · .*? · \d+ chars ---\n?/;
export function stripMessageBoundaryHeader(body) {
  return body.replace(BOUNDARY_HEADER_RE, '');
}
