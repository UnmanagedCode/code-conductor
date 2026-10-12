// Boots one real cc server in a scratch root: its own projects root, CLI config
// dir, HOME, git config and free port, the allowlisted env from env.ts, and
// either the fake CLI (default) or — opt-in, CC_E2E_LIVE=1 — the real `claude`
// on PATH with an access-token-only copy of the live credentials.
//
// The server never builds web/dist (CC_SKIP_WEB_BUILD=1): globalSetup built it
// once for the run, and the server serves whatever is there.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeConfigDir } from '../../../src/claudeConfigDir.ts';
import { prepareLiveCredentials, seedLiveGlobalConfig, liveBudgetMs } from './credentials.ts';
import { isolatedEnv, scratchLayout, type ScratchDirs } from './env.ts';
import { redact } from './redact.ts';
import { createScratchRoot, releaseScratchRoot } from './scratch.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES = path.join(REPO_ROOT, 'web', 'e2e', 'fixtures');
export const DEFAULT_SCENARIO = path.join(FIXTURES, 'scenario.json');
const FAKE_CLAUDE = path.join(REPO_ROOT, 'tests', 'fake-claude.mjs');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server.ts');

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_TAIL_BYTES = 8 * 1024;

export type Engine = 'fake' | 'live';
export type CcOptions = {
  /**
   * A name for a spec file's own server. A file that sets ccOptions at all gets
   * a worker, so a cc, of its own; files that set none share one. A file that
   * seeds server state and has nothing else to set sets this. bootCc reads
   * nothing from it.
   */
  server?: string;
  /** Fake engine only: the fake CLI's scenario file (default fixtures/scenario.json). */
  scenario?: string;
  /** Extra env for the server, applied last. */
  env?: Record<string, string>;
  engine?: Engine;
  /** The port to listen on (default: a free one), for a spec that must know it before the server starts. */
  port?: number;
};
export type Cc = {
  url: string;
  port: number;
  engine: Engine;
  dirs: ScratchDirs;
  logPath: string;
  close(): Promise<void>;
};

const GITCONFIG = '[user]\n\tname = e2e\n\temail = e2e@example.invalid\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n';

/** A port nothing on 127.0.0.1 listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function logTail(logPath: string): string {
  try {
    const buf = fs.readFileSync(logPath);
    return redact(buf.subarray(Math.max(0, buf.length - LOG_TAIL_BYTES)).toString('utf8'));
  } catch { return '(no server log)'; }
}

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

// cc spawns its workers detached (each its own process group), so once cc
// exits they are no longer reachable through it — and a real CLI still
// exiting re-creates its config dir inside a root already removed. The tree
// is read before cc is stopped.
function descendants(pid: number): number[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split('\n')) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!c || !p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(c);
  }
  const out: number[] = [];
  const walk = (p: number): void => { for (const c of children.get(p) ?? []) { out.push(c); walk(c); } };
  walk(pid);
  return out;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killAll(pids: number[]): void {
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
}

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter(alive);
  }
  return left;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    const onExit = (): void => { clearTimeout(t); resolve(true); };
    child.once('exit', onExit);
  });
}

export async function bootCc({ scenario = DEFAULT_SCENARIO, env = {}, engine = 'fake', port: fixedPort }: CcOptions = {}): Promise<Cc> {
  if (engine === 'live' && process.env.CC_E2E_LIVE !== '1') {
    throw new Error('bootCc: engine "live" needs CC_E2E_LIVE=1');
  }
  // Resolved in THIS process, from the runner's own env: the booted cc's env
  // points CLAUDE_CONFIG_DIR at the scratch root.
  const liveDir = engine === 'live' ? claudeConfigDir() : null;

  let child: ChildProcess | null = null;
  const root = createScratchRoot({
    beforeRemove: () => {
      if (!child || exited(child)) return;
      const tree = descendants(child.pid!);
      child.kill('SIGKILL');
      killAll(tree);
    },
  });
  const dirs = scratchLayout(root);
  try {
    for (const d of [dirs.projects, dirs.claudeConfig, dirs.claudeProjects, dirs.home]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(dirs.gitconfig, GITCONFIG);

    const engineEnv: Record<string, string> = {};
    if (engine === 'fake') {
      engineEnv.CLAUDE_BIN = `${process.execPath} ${FAKE_CLAUDE}`;
      engineEnv.FAKE_CLAUDE_SCENARIO = scenario;
      engineEnv.ANTHROPIC_API_KEY = 'e2e-fake-key';
    } else {
      prepareLiveCredentials({
        source: path.join(liveDir!, '.credentials.json'),
        dest: path.join(dirs.claudeConfig, '.credentials.json'),
        now: Date.now(),
        budgetMs: liveBudgetMs(),
      });
      seedLiveGlobalConfig({ dest: path.join(dirs.claudeConfig, '.claude.json'), liveConfigDir: liveDir! });
    }

    const port = fixedPort ?? await freePort();
    const url = `http://127.0.0.1:${port}`;
    const log = fs.openSync(dirs.log, 'a');
    try {
      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: isolatedEnv({ dirs, port, env: { ...engineEnv, ...env } }),
        stdio: ['ignore', log, log],
      });
    } finally { fs.closeSync(log); }
    const server = child;

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (exited(server)) throw new Error(`bootCc: the server exited (${server.exitCode ?? server.signalCode}) before answering /; log tail:\n${logTail(dirs.log)}`);
      try {
        const res = await fetch(`${url}/`);
        await res.arrayBuffer();
        if (res.status === 200) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`bootCc: / did not answer 200 within ${READY_TIMEOUT_MS} ms; log tail:\n${logTail(dirs.log)}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    return {
      url, port, engine, dirs, logPath: dirs.log,
      async close() {
        const tree = exited(server) ? [] : descendants(server.pid!);
        if (!exited(server)) {
          server.kill('SIGTERM');
          if (!(await waitExit(server, STOP_TIMEOUT_MS))) {
            server.kill('SIGKILL');
            await waitExit(server, STOP_TIMEOUT_MS);
          }
        }
        // cc's shutdown stops its workers; whatever has not exited in time is killed.
        killAll(await waitGone(tree, STOP_TIMEOUT_MS));
        await waitGone(tree, STOP_TIMEOUT_MS);
        releaseScratchRoot(root);
      },
    };
  } catch (e) {
    if (child && !exited(child)) {
      const tree = descendants(child.pid!);
      child.kill('SIGKILL');
      killAll(tree);
      await waitExit(child, STOP_TIMEOUT_MS);
      await waitGone(tree, STOP_TIMEOUT_MS);
    }
    releaseScratchRoot(root);
    throw new Error(redact((e as Error).message), { cause: e });
  }
}
