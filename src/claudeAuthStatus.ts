// The orchestrator CLI's sign-in state, as `claude auth status --json` reports
// it. The CLI is the only authority: its credential layout is private (a token
// file plus an `oauthAccount` record in the global config on Linux, the Keychain
// on macOS), so cc never reads those files to answer this.
//
// The binary and environment are the ones a worker spawn uses —
// `resolveClaudeBin()` + `cliEnvBase()`, no CLAUDE_CONFIG_DIR pin — so the store
// reported is the store sessions sign in with.
//
// `loggedIn` means credentials are PRESENT, not that they are valid: the command
// is local-only and never checks a token with the server.

import { resolveClaudeBin } from './claudeLauncher.ts';
import { cliEnvBase } from './cliEnv.ts';
import { runGroupedCommand } from './groupedCommand.ts';
import type { Platform } from './platform/index.ts';

const STATUS_TIMEOUT_MS = 10_000;
// How long one answer serves every reader. `GET /api/claude-auth/status` is a
// plain unauthenticated GET any page can fire, and each miss forks the CLI.
export const STATUS_CACHE_TTL_MS = 5_000;

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  apiKeySource: string | null;
  configDirectory: string | null;
}

// An external tool's output, so read-time tolerance is allowed here: every field
// but `loggedIn` is optional, and the identity fields are null when the token
// exists but the global config lost its `oauthAccount`.
export function parseAuthStatus(stdout: string): ClaudeAuthStatus {
  let raw: unknown;
  try { raw = JSON.parse(stdout); }
  catch { throw new Error(`claude auth status printed non-JSON output: ${JSON.stringify(stdout.slice(0, 200))}`); }
  if (typeof raw !== 'object' || raw === null || typeof (raw as { loggedIn?: unknown }).loggedIn !== 'boolean') {
    throw new Error('claude auth status output has no boolean `loggedIn`');
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === 'string' ? o[k] as string : null);
  return {
    loggedIn: o.loggedIn as boolean,
    authMethod: str('authMethod') ?? 'none',
    apiProvider: str('apiProvider'),
    email: str('email'),
    orgId: str('orgId'),
    orgName: str('orgName'),
    subscriptionType: str('subscriptionType'),
    apiKeySource: str('apiKeySource'),
    configDirectory: str('configDirectory'),
  };
}

export async function getClaudeAuthStatus({ platform, timeoutMs = STATUS_TIMEOUT_MS }: { platform: Platform; timeoutMs?: number }): Promise<ClaudeAuthStatus> {
  const { command, prefixArgs } = resolveClaudeBin(platform);
  const r = await runGroupedCommand(
    { argv: [command, ...prefixArgs, 'auth', 'status', '--json'] },
    { cwd: process.cwd(), env: cliEnvBase(platform), timeoutMs, stdin: 'ignore' },
    platform,
  );
  if (r.spawnError !== null) throw new Error(`claude CLI could not be started (${command}): ${r.spawnError}`);
  if (r.timedOut) throw new Error(`claude auth status timed out after ${timeoutMs} ms`);
  // The exit code is NOT checked: signed out is exit 1 with the JSON on stdout.
  try {
    return parseAuthStatus(r.stdout.trim());
  } catch (e) {
    const tail = r.stderr.trim().slice(-500);
    throw new Error(`${(e as Error).message} (exit ${r.code}${tail ? `, stderr: ${tail}` : ''})`);
  }
}

export interface ClaudeAuthStatusReader {
  get(): Promise<ClaudeAuthStatus>;
  invalidate(): void;
}

// The cached, single-flight front of getClaudeAuthStatus — one per createServer.
// Concurrent readers share one in-flight CLI run; a success serves for `ttlMs`;
// a failure is shared by the readers already waiting but never cached.
// `invalidate()` (a login started or succeeded) drops the cached answer AND
// detaches any run in flight, whose result is then neither cached nor handed to
// later readers.
export function createClaudeAuthStatusReader({
  platform, ttlMs = STATUS_CACHE_TTL_MS, now = Date.now, read = () => getClaudeAuthStatus({ platform }),
}: {
  platform: Platform;
  ttlMs?: number;
  now?: () => number;
  read?: () => Promise<ClaudeAuthStatus>;
}): ClaudeAuthStatusReader {
  let cached: { value: ClaudeAuthStatus; at: number } | null = null;
  let inflight: Promise<ClaudeAuthStatus> | null = null;
  let generation = 0;

  function get(): Promise<ClaudeAuthStatus> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inflight) return inflight;
    const gen = generation;
    const p = read().then(
      (value) => {
        if (gen === generation) { cached = { value, at: now() }; inflight = null; }
        return value;
      },
      (e: unknown) => {
        if (gen === generation) inflight = null;
        throw e;
      },
    );
    inflight = p;
    return p;
  }

  function invalidate(): void {
    generation++;
    cached = null;
    inflight = null;
  }

  return { get, invalidate };
}
