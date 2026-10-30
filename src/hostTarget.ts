// Where a plugin-facing host operation runs: the target forms shared by
// `POST /api/exec` (src/hostExec.ts) and `GET /api/terminal`
// (src/hostTerminal.ts) — a project (+ worktree), or a system (+ remoteId) + an
// absolute cwd on it — their shape rules, the env overlay's, and resolution
// through the same resolvers the MCP surface uses (resolveProjectCwd,
// systemById) behind the platform's remoteSystems gate.
//
// Every message is prefixed with the caller's operation name (`op`), so each
// surface's refusals read as its own.

import path from 'node:path';
import type { PlatformCapabilities } from './platform/index.ts';
import { capabilityRefusal } from './capabilities.ts';
import { httpError } from './httpError.ts';
import { resolveProjectCwd } from './worktrees.ts';
import { LOCAL_SYSTEM_ID, systemById } from './systems/registry.ts';
import { ENV_NAME_RE } from './systems/execWrap.ts';
import type { System } from './systems/system.ts';

// The request keys `parseHostTarget` reads.
export const HOST_TARGET_KEYS = ['project', 'worktree', 'system', 'remoteId', 'cwd'] as const;

export type HostTarget =
  | { project: string; worktree: string | null }
  | { system: string; remoteId: string | null; cwd: string };

export function invalidArgument(op: string, message: string): Error {
  return httpError(400, `${op}: ${message}`, { code: 'INVALID_ARGUMENT' });
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Shape only: every refusal is a 400, raised before anything is resolved.
export function parseHostTarget(body: Record<string, unknown>, op: string): HostTarget {
  const invalid = (m: string) => invalidArgument(op, m);
  const has = (k: string) => body[k] !== undefined;
  const formA = has('project') || has('worktree');
  const formB = has('system') || has('remoteId') || has('cwd');
  if (formA && formB) throw invalid('name the target by project (+ worktree) or by system (+ remoteId) + cwd, not both');
  if (formA) {
    if (typeof body.project !== 'string' || body.project === '') throw invalid('project must be a non-empty string');
    if (body.worktree !== undefined && body.worktree !== null && (typeof body.worktree !== 'string' || body.worktree === '')) {
      throw invalid('worktree must be a non-empty string');
    }
    return { project: body.project, worktree: (body.worktree as string | null | undefined) ?? null };
  }
  if (formB) {
    if (typeof body.system !== 'string' || body.system === '') throw invalid('system must be a non-empty string');
    if (body.remoteId !== undefined && body.remoteId !== null && typeof body.remoteId !== 'string') {
      throw invalid('remoteId must be a string');
    }
    // '' and absent both mean the provider's own default target, as on
    // system_bash (addressedSystem, src/mcp/handlers.ts).
    const remoteId = body.remoteId === '' || body.remoteId === undefined ? null : body.remoteId as string | null;
    if (body.system === LOCAL_SYSTEM_ID && remoteId !== null) {
      throw invalid(`system '${LOCAL_SYSTEM_ID}' has no targets — remoteId must be absent`);
    }
    if (typeof body.cwd !== 'string' || body.cwd === '') throw invalid('cwd is required with system, as an absolute path on it');
    if (!path.isAbsolute(body.cwd)) {
      throw httpError(400, `${op}: cwd must be an absolute path on the system, got ${JSON.stringify(body.cwd)}`,
        { code: 'CWD_NOT_ABSOLUTE' });
    }
    return { system: body.system, remoteId, cwd: body.cwd };
  }
  throw invalid('name a target: project (+ worktree), or system (+ remoteId) + cwd');
}

// An env overlay: an object of ENV_NAME_RE names to strings without NUL.
export function parseEnvOverlay(v: unknown, op: string): Record<string, string> {
  if (!isPlainObject(v)) throw invalidArgument(op, 'env must be an object of string values');
  for (const [k, val] of Object.entries(v)) {
    if (!ENV_NAME_RE.test(k)) throw invalidArgument(op, `env name ${JSON.stringify(k)} does not match ${ENV_NAME_RE}`);
    if (typeof val !== 'string' || val.includes('\0')) throw invalidArgument(op, `env value for ${k} must be a string without NUL`);
  }
  return v as Record<string, string>;
}

// The System and the cwd on it. A non-local system on a platform without
// remote Systems is refused 501 SYSTEMS_UNAVAILABLE — in the system form
// BEFORE systemById, so no provider is launched to refuse with.
export async function resolveHostTarget(
  target: HostTarget, capabilities: PlatformCapabilities, op: string,
): Promise<{ sys: System; cwd: string }> {
  if ('project' in target) {
    const resolved = await resolveProjectCwd(target.project, target.worktree);
    if (resolved.system.id !== LOCAL_SYSTEM_ID && !capabilities.remoteSystems) throw capabilityRefusal('remoteSystems');
    return { sys: resolved.system, cwd: resolved.cwd };
  }
  if (target.system !== LOCAL_SYSTEM_ID && !capabilities.remoteSystems) throw capabilityRefusal('remoteSystems');
  const sys = await systemById(target.system, target.remoteId, `${op} on system '${target.system}'`);
  return { sys, cwd: target.cwd };
}

// What ran and where, as the caller addressed it. `local` has no targets by
// contract (System.remoteId), so its remoteId is always null here.
export function placeOf(sys: System, cwd: string): { system: string; remoteId: string | null; cwd: string } {
  return { system: sys.id, remoteId: sys.id === LOCAL_SYSTEM_ID ? null : sys.remoteId, cwd };
}
