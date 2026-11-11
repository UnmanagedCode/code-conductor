// The `run_code` tool: an agent-written async function body, run in a Node
// child process whose `cc` object calls back into this server as the calling
// session — so every call it makes goes through the same runTool gate as a
// direct call. The contract is docs/code-mode.md.

import { fileURLToPath } from 'node:url';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { localSystem } from '../systems/registry.ts';
import { LOCAL_SYSTEM_ID } from '../systems/localSystem.ts';
import type { ExecResult } from '../systems/system.ts';
import { dualResult, textPayload, utf8Prefix, type DualResult } from '../mcp/content.ts';
import type { CodeModeCtx, RunCodeMember } from './ctx.ts';
import {
  RUN_LOGS_CAP, PROGRESS_HEARTBEAT_MS, PROGRESS_MIN_INTERVAL_MS, clampRunCodeTimeoutMs,
} from './limits.ts';
import { startProgressPump, type ProgressPump } from './progressPump.ts';
import { literalPaths, checkPaths } from './precheck.ts';
import { RUN_URL_ENV, RUN_TOKEN_ENV, RUN_MEMBERS_ENV } from './runtimeApi.ts';
import { capOutcome, type RunOutcome } from './runs.ts';

const RUNTIME_PATH = fileURLToPath(new URL('./runtime.ts', import.meta.url));

// A plan-mode session is read-only. The Node permission model gives its child
// the same: reads, and no writes, child processes, workers, addons or WASI. The
// child's calls back into cc are network, which a Node that gates it needs
// `--allow-net` for (a flag an older Node rejects at startup, so it is added
// only when this Node knows it).
export function childArgv(planMode: boolean, knowsAllowNet = process.allowedNodeEnvironmentFlags.has('--allow-net')): string[] {
  const flags = planMode
    ? ['--permission', '--allow-fs-read=*', ...(knowsAllowNet ? ['--allow-net'] : [])]
    : [];
  return [process.execPath, ...flags, RUNTIME_PATH];
}

export interface RunCodeCtx extends CodeModeCtx {
  instances?: InstanceManagerLike | null;
  callerId?: string | null;
}

// The tool result from the process's exit and what it delivered. `cancelled`
// is the caller going away (cancel notification or closed connection).
export function assembleResult(r: ExecResult, deliveredRaw: RunOutcome | undefined, cancelled: boolean): DualResult {
  const delivered = deliveredRaw && capOutcome(deliveredRaw);
  const logs = utf8Prefix(r.output, RUN_LOGS_CAP);
  // One flag, two causes: a cap cut the logs, or a background process held the
  // output open after the program exited, so later output was not read.
  const logsTruncated = r.truncated || r.outputMayBeIncomplete === true || logs.length < r.output.length;
  const killed = r.timedOut || cancelled;
  const meta: Record<string, unknown> = {
    exitCode: killed || r.spawnError ? null : r.code,
    timedOut: r.timedOut,
    truncated: delivered?.truncated ?? false,
    durationMs: r.durationMs,
  };
  if (delivered?.truncated) meta.resultChars = delivered.resultChars;
  if (logsTruncated) meta.logsTruncated = true;
  if (delivered?.error) meta.error = delivered.error;
  else if (r.spawnError) meta.error = { name: 'SpawnError', message: r.spawnError };
  else if (cancelled) meta.error = { name: 'Cancelled', message: 'the run was cancelled before it finished', code: 'RUN_CANCELLED' };
  else if (!delivered && !r.timedOut) {
    meta.error = { name: 'NoResult', message: `the process exited (code ${r.code}) before the function returned` };
  }
  const result = delivered?.result ?? null;
  return dualResult({ result, logs, ...meta }, () => textPayload(meta, [result ?? '', logs]));
}

function refusal(code: string, reason: string, extra: Record<string, unknown> = {}) {
  return { ok: false, code, reason, ...extra };
}

export async function runCode({ code, timeoutMs }: { code: string; timeoutMs?: number; description?: string }, ctx: RunCodeCtx) {
  if (ctx.run) {
    return refusal('SCRIPT_NESTED', 'run_code cannot be called from inside a run_code program — call the tool directly from the program with cc.<tool>(args)');
  }
  if (!ctx.instances) throw new Error('orchestrator has no InstanceManager');
  if (!ctx.callerId) {
    throw new Error(
      'caller identity missing — call the MCP URL as `/mcp/<sessionId>`. ' +
      'run_code runs as the calling session, so it only works for a code-conductor-managed instance.',
    );
  }
  const inst = ctx.instances.liveForSession(ctx.callerId);
  if (!inst) throw new Error(`session ${ctx.callerId} is not live`);
  if (inst.transcriptPlace.system !== LOCAL_SYSTEM_ID) {
    return refusal('SCRIPT_UNAVAILABLE_REMOTE',
      "run_code runs on cc's own machine, and this session's project lives on another system — call the tools directly instead");
  }
  const names = new Set([...(ctx.tools ?? []).map(t => t.name), ...(ctx.textOnlyTools?.keys() ?? [])]);
  const paths = literalPaths(code);
  const members = ctx.runCodeMembers ?? new Map<string, readonly RunCodeMember[]>();
  const memberNames = new Map([...members].map(([id, ms]) => [id, new Set(ms.map(m => m.name))] as const));
  const unknown = checkPaths(paths, names, memberNames);
  // Paths that are tools, just not this caller's: known once barred names count.
  const stillUnknown = new Set(checkPaths(paths, new Set([...names, ...(ctx.barredTools?.keys() ?? [])]), memberNames).map(u => u.path));
  const notTools = unknown.filter(u => stillUnknown.has(u.path));
  if (notTools.length > 0) {
    return refusal('TOOL_UNKNOWN',
      `the program calls ${notTools.map(u => u.path).join(', ')}, which ${notTools.length === 1 ? 'is not a tool' : 'are not tools'} — nothing ran. ` +
      'Look names up with `return await cc.describe_tools({query})`.',
      { unknown: notTools });
  }
  const barred = unknown.filter(u => !stillUnknown.has(u.path));
  if (barred.length > 0) {
    return refusal('TOOL_UNAVAILABLE_TO_CALLER',
      `the program calls ${barred.map(u => u.path).join(', ')}, which ${barred.length === 1 ? 'is a tool' : 'are tools'} not offered to ${ctx.callerKind ?? 'this'} sessions — nothing ran.`,
      { unavailable: barred.map(u => u.path) });
  }
  if (!ctx.runs || !ctx.selfUrl) throw new Error('run_code: the MCP router did not provide the run channel');
  const runs = ctx.runs;
  let token: string | null = null;
  let pump: ProgressPump | null = null;
  let result: ExecResult;
  let delivered: RunOutcome | undefined;
  try {
    token = runs.open(ctx.callerId);
    const live = pump = ctx.progress
      ? startProgressPump({
        emit: ctx.progress,
        heartbeatMs: ctx.codeModeTiming?.heartbeatMs ?? PROGRESS_HEARTBEAT_MS,
        minIntervalMs: ctx.codeModeTiming?.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS,
      })
      : null;
    result = await localSystem().exec({ argv: childArgv(inst.mode === 'plan') }, {
      cwd: inst.cwd,
      timeoutMs: clampRunCodeTimeoutMs(timeoutMs),
      stdin: Buffer.from(code),
      headCapBytes: RUN_LOGS_CAP,
      signal: ctx.signal,
      envOverlay: {
        [RUN_URL_ENV]: `${ctx.selfUrl}/${encodeURIComponent(ctx.callerId)}`,
        [RUN_TOKEN_ENV]: token,
        // Names only; schemas travel on the child's lookup.
        [RUN_MEMBERS_ENV]: JSON.stringify(Object.fromEntries([...memberNames].map(([id, ns]) => [id, [...ns]]))),
      },
      onChunk: live ? (text) => live.onOutput(text) : undefined,
    });
  } finally {
    pump?.stop();
    if (token !== null) delivered = runs.close(token);
  }
  return assembleResult(result, delivered, ctx.signal?.aborted === true);
}
