// Settings → About's Claude CLI update: `claude update` run with the binary and
// environment a worker spawn uses — `resolveClaudeBin()` + `cliEnvBase()`, as in
// src/claudeAuthStatus.ts — under the maintenance lock (src/relaunchPrep.ts), so
// it, a cc restart and a cc self-update refuse each other.
//
// No restart follows: a running session keeps the CLI process it started, and
// every new spawn resolves the binary afresh. The result carries the version a
// `--version` probe of that binary reports AFTER the run — what the next spawn
// gets, which a `CLAUDE_BIN` pinned to a versioned path leaves unchanged.

import { resolveClaudeBin } from './claudeLauncher.ts';
import { cliEnvBase } from './cliEnv.ts';
import { runGroupedCommand, GROUP_OUTPUT_CAP, RESULT_TAIL_CAP } from './groupedCommand.ts';
import { probeClaudeBin } from './health.ts';
import { httpError } from './httpError.ts';
import type { Platform } from './platform/index.ts';
import { withMaintenanceLock } from './relaunchPrep.ts';

export const CLAUDE_UPDATE_TIMEOUT_MS = 10 * 60_000;

export async function applyClaudeUpdate({ platform, timeoutMs = CLAUDE_UPDATE_TIMEOUT_MS, onChunk, onValidated }: {
  platform: Platform; timeoutMs?: number; onChunk?: (text: string) => void; onValidated?: () => void;
}): Promise<{ ok: true; version: string | null }> {
  return withMaintenanceLock('claude-update', async () => {
    onValidated?.();
    const { command, prefixArgs } = resolveClaudeBin(platform);
    const r = await runGroupedCommand(
      { argv: [command, ...prefixArgs, 'update'] },
      { cwd: process.cwd(), env: cliEnvBase(platform), timeoutMs, cap: GROUP_OUTPUT_CAP, stdin: 'ignore', onChunk: (t) => onChunk?.(t) },
      platform,
    );
    const tail = r.output.slice(-RESULT_TAIL_CAP);
    if (r.spawnError !== null) throw httpError(502, `claude CLI could not be started (${command}): ${r.spawnError}`, { tail });
    if (r.timedOut) throw httpError(504, `claude update timed out after ${timeoutMs} ms`, { tail });
    if (r.code !== 0) throw httpError(502, `claude update exited with code ${r.code}`, { tail });
    const probe = await probeClaudeBin({ platform });
    return { ok: true as const, version: probe.found ? probe.version ?? null : null };
  });
}
