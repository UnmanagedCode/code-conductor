// One-shot Fast-tier call about a session: `claude -p --output-format=json`
// with the session text as the SYSTEM prompt and the task on stdin. The flag
// set pins everything that sits before the user message in the CLI's cached
// request (tool list, system prompt), so two calls over unchanged session text
// share a cache prefix. No in-process fetch — outbound DNS is broken on this
// host; the CLI handles all networking.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cliEnvBase } from './cliEnv.ts';
import { orchStoreRoot } from './projects.ts';
import { resolveClaudeBin, resolveBackendLaunch } from './claudeLauncher.ts';
import { hostPlatform } from './platform/index.ts';
import { getTierBackend, getBackend } from './appSettings.ts';
import { CLAUDE_BACKEND_ID } from './modelVersions.ts';

// Dedicated cwd for one-shot subprocesses: a subdirectory inside the
// .code-conductor metadata dir, not a named project. Exported so tests can
// introspect the expected spawn cwd.
export function summarySpawnDir(): string {
  return path.join(orchStoreRoot(), 'summaries');
}

// Generation cap. Not unbounded: this one-shot spawn isn't tracked by
// instances.ts's registry, so nothing kills it on server shutdown — a wedged
// child would otherwise hang forever. The REAL governing bound on the HTTP
// path is Node's http.Server default requestTimeout (300_000ms — server.ts sets
// no override); staying under it means our own timer fires first, so a result
// can never persist after the client has already seen the request fail.
const GENERATION_TIMEOUT_MS = 290_000;

// The `claude -p --output-format=json` result envelope (loose — CLI-owned).
interface OneShotEnvelope {
  result?: unknown;
  total_cost_usd?: unknown;
  cost_usd?: unknown;
  usage?: { cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | null;
}

export interface OneShotUsage {
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

export interface OneShotResult {
  result: string;
  durationMs: number;
  costUsd: number | null;
  usage: OneShotUsage;
}

const tokenCount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

export async function runSessionOneShot(opts: { systemPrompt: string; prompt: string; signal?: AbortSignal }): Promise<OneShotResult> {
  const { systemPrompt, prompt, signal } = opts;
  if (signal?.aborted) throw abortError();

  // Honor the fast tier's bound backend unconditionally — no Anthropic
  // fallback, since a host with no Claude access wouldn't have that model. A
  // substitution backend re-execs the SAME claude binary (only the
  // endpoint/auth differ), so the envelope shape is unaffected; a missing cost
  // or usage there reads null.
  const fastBackend = getTierBackend('fast');
  const { command, prefixArgs, env: backendEnvVars } =
    resolveBackendLaunch(getBackend(fastBackend.backend), fastBackend.model, resolveClaudeBin(hostPlatform), hostPlatform);

  const spawnDir = summarySpawnDir();
  await fs.mkdir(spawnDir, { recursive: true });

  // The system prompt travels by file: a single argv entry is capped (128 KiB
  // on Linux, ~32k chars for a whole Windows command line) and the session
  // text can exceed that. The dir is 0700, the file 0600, removed in `finally`.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-oneshot-'));
  try {
    const promptFile = path.join(tmpDir, 'system-prompt.txt');
    await fs.writeFile(promptFile, systemPrompt, { mode: 0o600 });
    const args = [
      ...prefixArgs,
      '-p',
      '--output-format=json',
      '--model', fastBackend.model,
      // Throwaway session-id so each call is independent (no accidental resume).
      '--session-id', randomUUID(),
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--system-prompt-file', promptFile,
    ];

    const startMs = Date.now();
    const parsed = await new Promise<OneShotEnvelope>((resolve, reject) => {
      const child = spawn(command, args, {
        ...hostPlatform.spawnOptions('child'),
        cwd: spawnDir,
        env: { ...cliEnvBase(hostPlatform), ...backendEnvVars },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', chunk => stdoutChunks.push(chunk));
      child.stderr.on('data', chunk => stderrChunks.push(chunk));

      const onAbort = () => {
        clearTimeout(timer);
        hostPlatform.killProcess(child, 'SIGTERM');
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        hostPlatform.killProcess(child, 'SIGTERM');
        reject(new Error(`summary generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s`));
      }, GENERATION_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });

      // A spawn that never starts (ENOENT/EACCES — e.g. a backend template naming
      // a command that isn't installed) emits 'error', never 'close'. Without this
      // listener the EventEmitter default rethrows it as an uncaught exception and
      // takes the whole server down with every live session.
      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`summary generation failed to spawn ${command}: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          return reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
        const stdout = Buffer.concat(stdoutChunks).toString().trim();
        let out: OneShotEnvelope;
        try { out = JSON.parse(stdout) as OneShotEnvelope; }
        catch { return reject(new Error(`failed to parse claude output: ${stdout.slice(0, 200)}`)); }
        resolve(out);
      });

      // Guarded: on a failed spawn the streams are already destroyed, and an
      // unhandled EPIPE here would escape the same way 'error' used to.
      child.stdin.on('error', () => { /* surfaced via the 'error'/'close' paths above */ });
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch { /* ditto */ }
    });

    const durationMs = Date.now() - startMs;
    const result = parsed.result;
    if (typeof result !== 'string' || !result.trim()) {
      throw new Error(`unexpected claude output shape: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    return {
      result: result.trim(),
      durationMs,
      // The CLI's total_cost_usd is Anthropic list pricing — meaningless for a
      // substitution backend (src/costTracking.ts, docs/models.md).
      costUsd: fastBackend.backend === CLAUDE_BACKEND_ID
        ? ((parsed.total_cost_usd ?? parsed.cost_usd ?? null) as number | null)
        : null,
      usage: {
        cacheReadInputTokens: tokenCount(parsed.usage?.cache_read_input_tokens),
        cacheCreationInputTokens: tokenCount(parsed.usage?.cache_creation_input_tokens),
      },
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
