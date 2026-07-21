// Cached, per-(`claude`-version, shell) shell-env bundle. The MCP daemon runs
// detached with no CLAUDE_* env vars, so a plain spawned shell never sees the
// rg/find/grep shims claude's own Bash tool gets from its shell snapshot. We
// recover them by forcing one Bash toolcall inside a throwaway `claude -p`
// run that dumps `declare -f; alias -p; shopt -p` + the resolved PATH /
// CLAUDE_CODE_EXECPATH to a file; sourcing that file into a fresh shell
// restores the same environment. Which shell actually executes that Bash
// toolcall depends on the host's $SHELL (bash or zsh) — we can't control it,
// and a zsh-flavored dump can contain zsh-only syntax (e.g. oh-my-zsh
// completion internals) that a bash parser can't source. So the directive
// also probes $ZSH_VERSION/$BASH_VERSION to record which shell produced the
// dump, and that shell is baked into the cache filename
// (bundle-<version>-<bash|zsh>.sh, see bundleShellKind()) so project_bash
// (mcp/handlers.js) can spawn a matching shell to source it. Generated once
// per (claude version, shell) and cached on disk. The daemon runs fixed code
// between restarts, so a version/shell change can only happen across a
// restart — the resolved path is additionally memoized in-memory for the
// life of the process (see `_singleton` below), skipping the `claude
// --version` spawn and disk scan on every call after the first.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { orchStoreRoot, writeFileAtomic } from './projects.js';
import { resolveClaudeBin, resolveBackendLaunch } from './claudeLauncher.js';
import { getTierBackend } from './appSettings.js';
import { preflightOllamaBackend, ollamaPreflightError } from './ollamaBackend.js';

const VERSION_TIMEOUT_MS = 5000;
const MARKER = 'CLAUDE_CODE_EXECPATH';
const SHELL_KIND_MARKER = 'CLAUDE_CODE_SHELL_KIND';
const BUNDLE_NAME_RE = /^bundle-(.+)-(bash|zsh)\.sh$/;

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

function parseShellKind(contents) {
  const m = contents.match(new RegExp(`^export ${SHELL_KIND_MARKER}=(\\S*)$`, 'm'));
  return m ? m[1] : '';
}

// Parses the shell that produced a bundle back out of its cache filename
// (see the `bundle-<version>-<bash|zsh>.sh` scheme in generateBundle()).
// Falls back to 'bash' for any unrecognized/legacy path — never actually
// hit in practice, since generateBundle()/findCachedBundle() only ever
// produce the new-format name.
export function bundleShellKind(bundlePath) {
  const m = path.basename(bundlePath).match(/-(bash|zsh)\.sh$/);
  return m ? m[1] : 'bash';
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

async function generateBundle(key, command, prefixArgs) {
  const dir = shellEnvDir();
  const spawnDir = path.join(dir, 'spawn');
  await fs.mkdir(spawnDir, { recursive: true });
  const tmpTarget = path.join(dir, `.gen-${randomUUID()}.tmp`);

  const directive = `Run exactly one Bash tool call with this exact command and nothing else — no commentary, no other tool calls:

{ printf 'export CLAUDE_CODE_EXECPATH=%q\\n' "$CLAUDE_CODE_EXECPATH"; printf 'export PATH=%q\\n' "$PATH"; printf 'export ${SHELL_KIND_MARKER}=%s\\n' "\${ZSH_VERSION:+zsh}\${BASH_VERSION:+bash}"; declare -f; alias -p; shopt -p; } > ${shQuote(tmpTarget)}

Then stop — do not summarize the output.`;

  // Honor the fast tier's bound backend (Claude or Ollama) unconditionally —
  // don't fall back to an Anthropic default: on hosts where only the Ollama
  // backend is available that model wouldn't exist.
  const fastBackend = getTierBackend('fast');

  // Ollama-only reachability + model-availability preflight, mirroring
  // Instance._preflightBackend's use of the same helper — no-op for Claude
  // backends. Without this, a down/unreachable daemon would only surface as an
  // opaque spawn failure after the full genTimeoutMs (45s default), and because
  // the bundle is cached process-wide, EVERY project_bash call would eat that
  // same slow failure until the daemon comes back.
  if (fastBackend.kind === 'ollama') {
    const pre = await preflightOllamaBackend({ model: fastBackend.model });
    if (!pre.ok) throw ollamaPreflightError(pre, 'claudeShellEnv');
  }

  const { command: spawnCommand, prefixArgs: spawnPrefixArgs } =
    resolveBackendLaunch(fastBackend.kind, fastBackend.model, { command, prefixArgs });

  const args = [
    ...spawnPrefixArgs,
    '-p',
    '--model', fastBackend.model,
    '--session-id', randomUUID(),
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Bash',
  ];

  await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(spawnCommand, args, { cwd: spawnDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const shell = parseShellKind(contents);
  if (shell !== 'bash' && shell !== 'zsh') {
    throw new Error(`claudeShellEnv: generated bundle failed validation (missing or unrecognized ${SHELL_KIND_MARKER} marker)`);
  }

  // Only write to the real cache path once validation has passed — a
  // failure above never leaves a partial/bad file behind. The shell is only
  // known now (post-capture), so the final filename is computed here rather
  // than passed in.
  const finalPath = path.join(dir, `bundle-${key}-${shell}.sh`);
  await writeFileAtomic(finalPath, contents);
  await fs.unlink(tmpTarget).catch(() => {});
  return finalPath;
}

// Old-format `bundle-<version>.sh` files (pre-dating shell-matching) never
// match BUNDLE_NAME_RE, so they're simply never returned here — no explicit
// migration needed, they're just unreferenced disk cruft from here on.
async function findCachedBundle(key) {
  const dir = shellEnvDir();
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const m = name.match(BUNDLE_NAME_RE);
    if (!m || m[1] !== key) continue;
    const finalPath = path.join(dir, name);
    try {
      const stat = await fs.stat(finalPath);
      if (stat.size > 0) return finalPath;
    } catch { /* skip */ }
  }
  return null;
}

async function resolveFresh() {
  // The cache key is intentionally (claude version, shell) and
  // backend-independent: the captured shims/PATH/aliases come from the
  // `claude` CLI build itself, not from which provider (Claude or Ollama)
  // the fast tier happens to be bound to right now.
  const { command, prefixArgs } = resolveClaudeBin();
  const key = await getClaudeVersionKey(command, prefixArgs);

  const cached = await findCachedBundle(key);
  if (cached) return cached;

  return generateBundle(key, command, prefixArgs);
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
