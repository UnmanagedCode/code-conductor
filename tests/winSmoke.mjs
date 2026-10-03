// Harness for tests/win-smoke.real.test.mjs: Windows process probes, the
// server-under-test lifecycle, and the WS / MCP clients the steps drive it with.
// Not named *.test.mjs, so discover() ignores it. Nothing here runs at import.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { launcherEnv, findOnPath, detectClaude } from '../bin/windows-launch.mjs';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

// Every child process the steps run is async: a test process that blocks its
// event loop past the server's keep-alive timeout reuses a socket the server
// has already closed, and the next request fails with ECONNRESET.
const run = promisify(execFile);

// waitFor with the condition named in the timeout error.
export async function until(what, predicate, timeout, interval = 300) {
  try { return await waitFor(predicate, { timeout, interval }); }
  catch { throw new Error(`timed out after ${timeout} ms waiting for ${what}`); }
}

async function powershell(command) {
  const { stdout } = await run(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function jsonRows(out) {
  const v = out.trim() ? JSON.parse(out) : [];
  return Array.isArray(v) ? v : [v];
}

// Every process on the box but this probe's own powershell and its conhost.
// `created` is epoch ms, so a reused pid never matches an earlier snapshot.
// Throws with the probe's stderr; under a network logon a standard user is
// refused here, and that refusal reads as `Access denied`.
export async function processTable() {
  const out = await powershell(
    'Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID } | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine,' +
    "@{n='Created';e={[long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds}} | " +
    'ConvertTo-Json -Compress');
  return jsonRows(out).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, cmd: r.CommandLine ?? '', created: r.Created }));
}

// A child is never older than its parent. Windows keeps a dead parent's pid as
// ppid and reuses pids, so a ppid match alone can adopt an unrelated process.
export const isChildOf = (p, parent) => p.ppid === parent.pid && p.pid !== parent.pid && p.created >= parent.created;

// `pid`'s entry plus every transitive child, from one snapshot.
export function treeOf(table, pid) {
  const out = table.filter(p => p.pid === pid);
  for (let i = 0; i < out.length; i++) {
    for (const p of table) if (isChildOf(p, out[i]) && !out.includes(p)) out.push(p);
  }
  return out;
}

// The entries of an earlier snapshot still running now.
export async function aliveOf(snapshot) {
  const table = await processTable();
  return snapshot.filter(s => table.some(p => p.pid === s.pid && p.created === s.created));
}

export function describeProcs(list) {
  return list.map(p => `${p.pid}/${p.name} ppid=${p.ppid} [${p.cmd}]`).join('; ');
}

// Processes holding a visible top-level window, filtered by image name.
export async function visibleWindows(names) {
  const out = await powershell('Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName | ConvertTo-Json -Compress');
  const want = new Set(names.map(n => n.toLowerCase()));
  return jsonRows(out).filter(r => want.has(String(r.ProcessName).toLowerCase())).map(r => ({ pid: r.Id, name: r.ProcessName }));
}

// Forced tree kill. An already-gone pid is not a failure here.
export async function taskkillTree(pid) {
  try {
    await run(path.join(SYSTEM32, 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
  } catch { /* gone already */ }
}

// The server's environment from the launcher's own `launcherEnv`, over an
// install layout (`<installDir>\\node`, the checkout at `<installDir>\\app`).
// The base is this process's env minus the test plumbing's overrides, which a
// launcher started from the Start menu would never inherit.
export function serverEnv({ installDir, projectsRoot, port }) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PROJECTS_ROOT' || k.startsWith('FAKE_CLAUDE_')) delete env[k];
  }
  for (const k of ['CLAUDE_BIN', 'CLAUDE_CODE_GIT_BASH_PATH', 'GIT_CONFIG_GLOBAL', 'CLAUDE_PROJECTS_ROOT', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
  const gitExe = findOnPath('git', env);
  if (!gitExe) throw new Error('git.exe not found on PATH');
  const claude = detectClaude(env);
  if (!claude) throw new Error('claude.exe not found on PATH or in ~/.local/bin');
  env.PROJECTS_ROOT = projectsRoot;
  env.PORT = String(port);
  return { ...launcherEnv({ env, installDir, git: { gitExe, cmdDir: path.dirname(gitExe) }, claude }), ...gitIdentityEnv() };
}

// The box has no git identity and the suite must not write user config.
export function gitIdentityEnv() {
  return {
    GIT_AUTHOR_NAME: 'cc-smoke', GIT_AUTHOR_EMAIL: 'cc-smoke@example.invalid',
    GIT_COMMITTER_NAME: 'cc-smoke', GIT_COMMITTER_EMAIL: 'cc-smoke@example.invalid',
  };
}

export async function git(dir, ...args) {
  const { stdout } = await run('git', ['-C', dir, ...args],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...gitIdentityEnv() } });
  return stdout.trim();
}

// Runs npm through node + npm-cli.js: spawning npm.cmd without a shell is EINVAL.
export async function npm(cwd, ...args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error(`npm-cli.js not found next to node: ${cli}`);
  await run(process.execPath, [cli, ...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

export async function healthPid(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).pid : null;
  } catch { return null; }
}

// `node server.ts` with the launcher's stdio shape: both streams appended to one
// log file, which a restart's replacement inherits.
export async function startServer({ appDir, env, logFile, base }) {
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, ['server.ts'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally { fs.closeSync(fd); }
  await until(`server health (log: ${logTail(logFile)})`, async () => (await healthPid(base)) != null, 60_000);
  return { child, health: (await api(base, 'GET', '/api/health')).body };
}

export function logTail(file, n = 20) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n'); }
  catch { return '(no log)'; }
}

export function claudeProjectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

// The transcript the CLI wrote most recently for `cwd`: finding it checks cc and
// the CLI agree on the directory's spelling.
export function newestJsonl(cwd, sinceMs) {
  const dir = claudeProjectDir(cwd);
  if (!fs.existsSync(dir)) throw new Error(`no transcript dir ${dir}`);
  const f = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    .map(n => ({ p: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .filter(x => x.m >= sinceMs).sort((a, b) => b.m - a.m)[0];
  if (!f) throw new Error(`no jsonl in ${dir} since ${new Date(sinceMs).toISOString()}`);
  return f.p;
}

// One frame over the WS, resolved on its ack; ok:false rejects.
export function wsSend(wsUrl, frame) {
  return new Promise((resolve, reject) => {
    const reqId = `smoke-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocket(wsUrl);
    const done = (fn, v) => { clearTimeout(timer); ws.terminate(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`no ack for ${frame.t} within 15s`)), 15_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'subscribe', id: frame.id }));
      ws.send(JSON.stringify({ ...frame, reqId }));
    });
    ws.on('message', (m) => {
      const f = JSON.parse(String(m));
      if (f.t !== 'ack' || f.reqId !== reqId) return;
      if (f.ok) done(resolve, f);
      else done(reject, new Error(`${frame.t} refused: ${f.error}`));
    });
    ws.on('error', (e) => done(reject, e));
  });
}

export function wsPrompt(wsUrl, id, text, attachments) {
  return wsSend(wsUrl, { t: 'prompt', id, text, ...(attachments ? { attachments } : {}) });
}

async function rpc(base, method, params) {
  const r = await api(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params });
  if (r.status !== 200) throw new Error(`/mcp ${method} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const mcpCall = (base, name, args) => rpc(base, 'tools/call', { name, arguments: args });
export const mcpList = async (base) => (await rpc(base, 'tools/list', {})).result.tools.map(t => t.name);
