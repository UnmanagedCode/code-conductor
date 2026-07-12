// Cached, per-`claude`-version shell-env bundle. The MCP daemon runs
// detached with no CLAUDE_* env vars, so a plain spawned bash never sees the
// rg/find/grep shims claude's own Bash tool gets from its shell snapshot. We
// recover them by forcing one Bash toolcall inside a throwaway `claude -p`
// run that dumps `declare -f; alias -p; shopt -p` + the resolved PATH /
// CLAUDE_CODE_EXECPATH to a file; sourcing that file into a fresh bash
// restores the same environment. Generated once per claude version and
// cached on disk; project_bash (mcp/handlers.js) sources the result. The
// daemon runs fixed code between restarts, so a version change can only
// happen across a restart — the resolved path is additionally memoized
// in-memory for the life of the process (see `_singleton` below), skipping
// the `claude --version` spawn and disk `stat` on every call after the
// first.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { orchStoreRoot, writeFileAtomic } from './projects.js';
import { resolveClaudeBin } from './instances.js';
import { DEFAULT_VERSIONS } from './modelVersions.js';

const VERSION_TIMEOUT_MS = 5000;
const MARKER = 'CLAUDE_CODE_EXECPATH';

// Read live (not a module-level constant) so tests can shrink it via env var
// per-case without needing to reload the module.
function genTimeoutMs() {
  return Number(process.env.CLAUDE_SHELL_ENV_TIMEOUT_MS) || 45_000;
}

function shellEnvDir() {
  return path.join(orchStoreRoot(), 'shell-env');
}

function sanitizeVersionKey(raw) {
  const token = raw.trim().split(/\s+/)[0] || 'unknown';
  return token.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Single-quote-escape for safe interpolation inside a single-quoted bash
// string — orchStoreRoot() derives from user-configurable PROJECTS_ROOT.
function shQuote(p) {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

async function getClaudeVersionKey(command, prefixArgs) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, [...prefixArgs, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`claudeShellEnv: failed to spawn claude --version: ${err.message}`));
      return;
    }
    let stdout = '';
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle(() => reject(new Error('claudeShellEnv: claude --version timed out')));
    }, VERSION_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', (err) => {
      settle(() => reject(new Error(`claudeShellEnv: claude --version failed: ${err.message}`)));
    });
    proc.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`claudeShellEnv: claude --version exited with code ${code}`));
          return;
        }
        resolve(sanitizeVersionKey(stdout));
      });
    });
  });
}

async function generateBundle(finalPath, command, prefixArgs) {
  const dir = shellEnvDir();
  const spawnDir = path.join(dir, 'spawn');
  await fs.mkdir(spawnDir, { recursive: true });
  const tmpTarget = path.join(dir, `.gen-${randomUUID()}.tmp`);

  const directive = `Run exactly one Bash tool call with this exact command and nothing else — no commentary, no other tool calls:

{ printf 'export CLAUDE_CODE_EXECPATH=%q\\n' "$CLAUDE_CODE_EXECPATH"; printf 'export PATH=%q\\n' "$PATH"; declare -f; alias -p; shopt -p; } > ${shQuote(tmpTarget)}

Then stop — do not summarize the output.`;

  const args = [
    ...prefixArgs,
    '-p',
    '--model', DEFAULT_VERSIONS.haiku,
    '--session-id', randomUUID(),
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Bash',
  ];

  await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, { cwd: spawnDir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`claudeShellEnv: failed to spawn claude -p: ${err.message}`));
      return;
    }
    const stderrChunks = [];
    proc.stderr.on('data', (c) => stderrChunks.push(c));
    proc.stdout.resume(); // discard — we only care about the side-effect file

    const timeoutMs = genTimeoutMs();
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`claudeShellEnv: bundle generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claudeShellEnv: bundle generation spawn error: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`claudeShellEnv: bundle-generation claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve();
    });

    proc.stdin.write(directive);
    proc.stdin.end();
  });

  let contents;
  try {
    contents = await fs.readFile(tmpTarget, 'utf8');
  } catch (err) {
    throw new Error(`claudeShellEnv: bundle-generation did not produce the expected file: ${err.message}`);
  }
  if (!contents.trim() || !contents.includes(MARKER)) {
    throw new Error('claudeShellEnv: generated bundle failed validation (empty or missing CLAUDE_CODE_EXECPATH marker)');
  }

  // Only write to the real cache path once validation has passed — a
  // failure above never leaves a partial/bad file at finalPath.
  await writeFileAtomic(finalPath, contents);
  await fs.unlink(tmpTarget).catch(() => {});
  return finalPath;
}

async function resolveFresh() {
  const { command, prefixArgs } = resolveClaudeBin();
  const key = await getClaudeVersionKey(command, prefixArgs);
  const finalPath = path.join(shellEnvDir(), `bundle-${key}.sh`);

  try {
    const stat = await fs.stat(finalPath);
    if (stat.size > 0) return finalPath;
  } catch { /* cache miss — fall through to generation */ }

  return generateBundle(finalPath, command, prefixArgs);
}

// Process-lifetime memo of the resolved bundle path. Holding the promise
// (not just the settled value) means two synchronous back-to-back callers
// share the same in-flight resolveFresh() call — `_singleton = p` is
// assigned before either caller has awaited anything, so this doubles as
// the concurrent-first-caller coalescer.
let _singleton = null;

export async function getShellEnvBundlePath() {
  if (_singleton) return _singleton;
  const p = resolveFresh();
  _singleton = p;
  // Side-effect only: a rejected resolution must not stay memoized, so the
  // next call retries from scratch. Doesn't alter what callers of `p` see.
  p.catch(() => { if (_singleton === p) _singleton = null; });
  return p;
}

export function _resetForTest() {
  _singleton = null;
}
