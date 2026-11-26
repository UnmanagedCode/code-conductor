// Real `node server.ts` processes for the headless-family e2e suites (a
// headless run, a `--replay`, an ordinary server with `--ui`) over a fresh
// projects root with the fake CLI, and `nodeClient`: cc's REAL client modules
// (shared/http.ts, ws.ts, viewOnly.ts, focus.ts, capabilities.ts) driven from
// node against such a process, so a UI-mode refusal is proven at the client's
// own chokepoints before anything reaches the server or the CLI.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './poll.mjs';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');
const SHARED = path.resolve(__dirname, '..', 'shared');
export const fx = (n) => path.join(__dirname, 'fixtures', n);
export const BANNER = /code-conductor listening on http:\/\/127\.0\.0\.1:(\d+)\n/;
// The assistant text finishedRun seeds into the run's transcript.
export const SEEDED = 'REPLAY-MARKER finished';

/** A scratch HOME holding the projects root (`project/`) and the CLI's projects dir; removed after the test. */
export async function freshHome(t, prefix = 'headless-') {
  const home = await mkdtemp(prefix);
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** `node server.ts <args>` on `home` with the fake CLI (scenario-basic.json unless `env` names one); SIGKILLed after the test if still up. */
export function spawnServer(t, home, args, env = {}) {
  const child = spawn(process.execPath, [SERVER_TS, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      HOST: '127.0.0.1',
      PROJECTS_ROOT: path.join(home, 'project'),
      CLAUDE_PROJECTS_ROOT: path.join(home, '.claude', 'projects'),
      CLAUDE_BIN: `${process.execPath} ${FAKE_CLAUDE}`,
      FAKE_CLAUDE_SCENARIO: fx('scenario-basic.json'),
      ORCH_IDLE_DRAIN_SETTLE_MS: '100',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } });
  return { child, out, closed };
}

export const until = (pred, what, timeout = 30_000) => waitFor(pred, { timeout, interval: 50, label: what });

/** Exactly one line on stdout, parsed. */
export function onlyJson(stdout) {
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `one line then the newline: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

/** The base URL once the process's listening banner is out (stderr for a headless boot, stdout for an ordinary one). */
export async function baseOf(proc) {
  const port = Number((await until(() => BANNER.exec(proc.out.stderr) ?? BANNER.exec(proc.out.stdout), 'the listening banner'))[1]);
  return `http://127.0.0.1:${port}`;
}

// A finished headless run on `home`: its session's public id, and the transcript
// its CLI would have written seeded under the segment's backing id (the fake
// CLI writes none).
export async function finishedRun(t, home) {
  const run = spawnServer(t, home, ['--prompt', 'say hi and finish'], { FAKE_CLAUDE_ARGV_DUMP: path.join(home, 'run-argv') });
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  const sessionId = onlyJson(run.out.stdout).sessionId;
  const store = path.join(home, 'project', '.code-conductor');
  const rec = JSON.parse(fs.readFileSync(path.join(store, 'sessions.json'), 'utf8')).sessions[sessionId];
  const dir = path.join(home, '.claude', 'projects', encodeCwd(path.join(fs.realpathSync(path.join(home, 'project')), '.conduct')));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.current}.jsonl`), [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'say hi and finish' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: SEEDED }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { sessionId, backingId: rec.current, store };
}

/** One MCP tools/call, as `caller` (a session id) or anonymous; the parsed JSON-RPC body. */
export async function mcpCall(base, name, args, { caller = null } = {}) {
  const url = caller ? `${base}/mcp/${encodeURIComponent(caller)}?format=text` : `${base}/mcp?format=text`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

/** Registers project `demo` and spawns an idle worker in it from the live conductor `rootSid`; the worker's instance row. */
export async function spawnWorker(base, rootSid) {
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo' }) });
  assert.ok(created.ok || created.status === 409, `project create: ${created.status}`);
  const body = await mcpCall(base, 'spawn_instance', { project: 'demo', mode: 'bypassPermissions', playbook: 'freeform', stage: 'freeform' }, { caller: rootSid });
  assert.ok(body.result && !body.result.isError, JSON.stringify(body));
  const { sessionId } = JSON.parse(body.result.content[0].text);
  return until(async () => (await (await fetch(`${base}/api/instances`)).json()).find((r) => r.sessionId === sessionId && r.status === 'idle'), 'the worker idle');
}

/** The live instance row of `sessionId` in `status` (any live status when omitted). */
export function liveRow(base, sessionId, status) {
  return until(async () => (await (await fetch(`${base}/api/instances`)).json())
    .find((r) => r.sessionId === sessionId && (status ? r.status === status : true)), `${sessionId} ${status ?? 'live'}`);
}

/** Every user text the fake CLIs wrote to FAKE_CLAUDE_TRANSCRIPT (root and workers append to one file). */
export function stdinText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// The client modules, loaded once per process: a relative import inside them
// resolves to the same module, so every load shares one viewOnly/focus state.
let modules = null;
// Node's own WebSocket, captured before any client replaces the global.
const NodeWebSocket = globalThis.WebSocket;
async function clientModules() {
  const load = (f) => import(pathToFileURL(path.join(SHARED, f)).href);
  modules ??= { http: await load('http.ts'), ws: await load('ws.ts'), vo: await load('viewOnly.ts'), focus: await load('focus.ts') };
  return modules;
}

/**
 * cc's real client against `base`: `location`, `fetch` (a '/api…' path
 * resolves against `base`) and `WebSocket` are the globals the shared modules
 * read. `ready()` reads GET /api/health through a fresh capabilities.ts (its
 * success is memoised per module instance), opens the socket and loads the
 * instance → session lookup from GET /api/instances; `refresh()` re-reads both.
 * One client per process at a time; `close()` restores `fetch`, makes every
 * later socket inert, and resets the mode, focus and lookup.
 */
export async function nodeClient(t, base) {
  const { http, ws, vo, focus } = await clientModules();
  const realFetch = globalThis.fetch;
  globalThis.location = { protocol: 'http:', host: new URL(base).host };
  globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? `${base}${u}` : u, o);
  let sessions = new Map();
  vo.setInstanceSessionLookup((id) => sessions.get(id) ?? null);
  const refresh = async () => {
    const caps = await import(`${pathToFileURL(path.join(SHARED, 'capabilities.ts')).href}?client=${Math.random()}`);
    assert.ok(await caps.loadCapabilities(), 'the health read succeeded');
    const rows = await http.apiFetch('/api/instances');
    sessions = new Map(rows.map((r) => [r.id, r.sessionId]));
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Every later reconnect constructs an inert socket: no events, no timers.
    globalThis.WebSocket = class { static OPEN = 1; static CLOSED = 3; readyState = 3; addEventListener() {} close() {} };
    // `location` stays: a reconnect already scheduled reads it before it builds the inert socket.
    globalThis.fetch = realFetch;
    vo.setUiMode('full');
    focus.setFocus(null);
    vo.setInstanceSessionLookup(null);
    for (const s of live) s.close();
  };
  // The sockets this client opened, closed with it.
  const live = new Set();
  globalThis.WebSocket = class extends NodeWebSocket {
    constructor(...a) { super(...a); live.add(this); }
  };
  t.after(close);
  return {
    http, ws, vo, focus, refresh, close,
    async ready() {
      await refresh();
      const opened = new Promise((resolve) => ws.bus.addEventListener('open', resolve, { once: true }));
      ws.connect();
      await opened;
    },
  };
}
