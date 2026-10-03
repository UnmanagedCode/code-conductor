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
