// `POST /api/exec` — run one command on a project's System, or on a System
// addressed directly, for a plugin backend (docs/plugins.md → Host exec).
//
// All of it lives here so the route in src/routes.ts stays a mount: request
// validation, the capability gate, target resolution through the same
// resolvers the MCP surface uses (resolveProjectCwd, systemById), and the
// mapping from an ExecResult to a status and a body.
//
// OUTPUT IS BUFFERED WHOLE BEHIND A FAILURE FENCE (`maxBufferBytes`). Paging
// would mean re-running a command for page two, which is neither idempotent nor
// free, and streaming would put framing on every one of a caller's many small
// calls. Past the fence the command is killed and the answer is
// EXEC_OUTPUT_TOO_LARGE — never a clipped success.

import path from 'node:path';
import type { PlatformCapabilities } from './platform/index.ts';
import { capabilityRefusal } from './capabilities.ts';
import { httpError } from './httpError.ts';
import { resolveProjectCwd } from './worktrees.ts';
import { LOCAL_SYSTEM_ID, systemById } from './systems/registry.ts';
import { ENV_NAME_RE } from './systems/execWrap.ts';
import { isBase64 } from './systems/protocol.ts';
import type { ExecResult, ExecSpec, System } from './systems/system.ts';

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_DEFAULT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const EXEC_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
// The route's own JSON body limit — above the router-wide one, so stdin of a
// useful size fits. Mounted ahead of that parser (src/routes.ts).
export const EXEC_BODY_LIMIT = 16 * 1024 * 1024;

const KEYS = new Set([
  'project', 'worktree', 'system', 'remoteId', 'cwd',
  'argv', 'shell', 'env', 'stdin', 'stdinB64', 'timeoutMs', 'encoding', 'maxOutputBytes',
]);

type Encoding = 'utf8' | 'base64';

interface HostExecRequest {
  target: { project: string; worktree: string | null } | { system: string; remoteId: string | null; cwd: string };
  spec: ExecSpec;
  env: Record<string, string> | undefined;
  stdin: Buffer | undefined;
  timeoutMs: number;
  encoding: Encoding;
  maxOutputBytes: number;
}

export interface HostExecResponse {
  status: number;
  body: Record<string, unknown>;
}

function invalid(message: string): Error {
  return httpError(400, `exec: ${message}`, { code: 'INVALID_ARGUMENT' });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function boundedInt(v: unknown, name: string, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > max) {
    throw invalid(`${name} must be a positive integer no greater than ${max}`);
  }
  return v;
}

// Shape only: every refusal here is a 400 raised before anything is resolved
// or launched.
function parseRequest(body: unknown): HostExecRequest {
  if (!isPlainObject(body)) throw invalid('the body must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!KEYS.has(k)) throw invalid(`unknown field ${JSON.stringify(k)}`);
  }
  const has = (k: string) => body[k] !== undefined;

  let target: HostExecRequest['target'];
  const formA = has('project') || has('worktree');
  const formB = has('system') || has('remoteId') || has('cwd');
  if (formA && formB) throw invalid('name the target by project (+ worktree) or by system (+ remoteId) + cwd, not both');
  if (formA) {
    if (typeof body.project !== 'string' || body.project === '') throw invalid('project must be a non-empty string');
    if (body.worktree !== undefined && body.worktree !== null && (typeof body.worktree !== 'string' || body.worktree === '')) {
      throw invalid('worktree must be a non-empty string');
    }
    target = { project: body.project, worktree: (body.worktree as string | null | undefined) ?? null };
  } else if (formB) {
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
      throw httpError(400, `exec: cwd must be an absolute path on the system, got ${JSON.stringify(body.cwd)}`,
        { code: 'CWD_NOT_ABSOLUTE' });
    }
    target = { system: body.system, remoteId, cwd: body.cwd };
  } else {
    throw invalid('name a target: project (+ worktree), or system (+ remoteId) + cwd');
  }

  let spec: ExecSpec;
  if (has('argv') === has('shell')) throw invalid('give exactly one of argv and shell');
  if (has('argv')) {
    const argv = body.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string' || a.includes('\0'))) {
      throw invalid('argv must be a non-empty array of strings without NUL');
    }
    if (argv[0] === '') throw invalid('argv[0] must be a non-empty string');
    spec = { argv: argv as string[] };
  } else {
    if (typeof body.shell !== 'string' || body.shell.trim() === '' || body.shell.includes('\0')) {
      throw invalid('shell must be a non-empty string without NUL');
    }
    spec = { shell: body.shell };
  }

  let env: Record<string, string> | undefined;
  if (has('env')) {
    if (!isPlainObject(body.env)) throw invalid('env must be an object of string values');
    for (const [k, v] of Object.entries(body.env)) {
      if (!ENV_NAME_RE.test(k)) throw invalid(`env name ${JSON.stringify(k)} does not match ${ENV_NAME_RE}`);
      if (typeof v !== 'string' || v.includes('\0')) throw invalid(`env value for ${k} must be a string without NUL`);
    }
    env = body.env as Record<string, string>;
  }

  let stdin: Buffer | undefined;
  if (has('stdin') && has('stdinB64')) throw invalid('give at most one of stdin and stdinB64');
  if (has('stdin')) {
    if (typeof body.stdin !== 'string') throw invalid('stdin must be a string');
    stdin = Buffer.from(body.stdin, 'utf8');
  } else if (has('stdinB64')) {
    if (typeof body.stdinB64 !== 'string' || !isBase64(body.stdinB64)) throw invalid('stdinB64 must be strict base64');
    stdin = Buffer.from(body.stdinB64, 'base64');
  }

  if (has('encoding') && body.encoding !== 'utf8' && body.encoding !== 'base64') {
    throw invalid(`encoding must be 'utf8' or 'base64'`);
  }

  return {
    target, spec, env, stdin,
    timeoutMs: boundedInt(body.timeoutMs, 'timeoutMs', EXEC_MAX_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS),
    encoding: (body.encoding as Encoding | undefined) ?? 'utf8',
    maxOutputBytes: boundedInt(body.maxOutputBytes, 'maxOutputBytes', EXEC_MAX_OUTPUT_BYTES, EXEC_DEFAULT_OUTPUT_BYTES),
  };
}

// The errno a never-started command carries: the far side's own code when it
// sent one, else the token closing Node's `spawn <file> <ERRNO>` wording — the
// shape a local spawn failure and an unwrapped wrapper failure both have.
function spawnErrno(r: ExecResult): string | null {
  if (r.spawnErrorCode) return r.spawnErrorCode;
  const m = /^spawn .* (E[A-Z0-9]+)$/.exec(r.spawnError ?? '');
  return m ? m[1] : null;
}

function encodeStream(r: ExecResult, which: 'out' | 'err', encoding: Encoding): string {
  if (encoding === 'base64') return ((which === 'out' ? r.stdoutBytes : r.stderrBytes) ?? Buffer.alloc(0)).toString('base64');
  return which === 'out' ? r.stdout : r.stderr;
}

// What ran and where, as the caller addressed it. `local` has no targets by
// contract (System.remoteId), so its remoteId is always null here.
function placeOf(sys: System, cwd: string): { system: string; remoteId: string | null; cwd: string } {
  return { system: sys.id, remoteId: sys.id === LOCAL_SYSTEM_ID ? null : sys.remoteId, cwd };
}

function mapResult(r: ExecResult, sys: System, cwd: string, req: HostExecRequest): HostExecResponse {
  const subject = `exec on system '${sys.id}'`;
  // The far side was not there to answer: a dead transport, or a staging write
  // or provider that never replied. A refusal with a code, never raw text.
  if (r.transportFailure || r.spawnErrorCode === 'ETRANSPORT' || r.spawnErrorCode === 'ETIMEDOUT') {
    return { status: 502, body: { error: `${subject}: the system could not be reached: ${r.spawnError}`, code: 'SYSTEM_UNREACHABLE' } };
  }
  if (r.spawnErrorCode === 'ENOREMOTE') {
    return { status: 502, body: { error: `${subject}: ${r.spawnError}`, code: 'REMOTE_NOT_FOUND' } };
  }
  if (r.spawnError !== null) {
    return {
      status: 422,
      body: { error: `${subject}: the command did not start: ${r.spawnError}`, code: 'EXEC_SPAWN_FAILED', errno: spawnErrno(r) },
    };
  }
  if (r.outputOverflowed) {
    return {
      status: 422,
      body: {
        error: `${subject}: output exceeded the ${req.maxOutputBytes}-byte limit — command killed`,
        code: 'EXEC_OUTPUT_TOO_LARGE', limitBytes: req.maxOutputBytes,
      },
    };
  }
  const streams = {
    stdout: encodeStream(r, 'out', req.encoding),
    stderr: encodeStream(r, 'err', req.encoding),
    encoding: req.encoding,
    durationMs: r.durationMs,
    ...(r.descendantsMaySurvive ? { descendantsMaySurvive: true } : {}),
  };
  if (r.timedOut) {
    return {
      status: 504,
      body: {
        error: `${subject}: the command did not finish within ${req.timeoutMs}ms — killed`,
        code: 'EXEC_TIMEOUT',
        ...streams,
        ...(r.abandonedAfterMs === undefined ? {} : { abandonedAfterMs: r.abandonedAfterMs }),
      },
    };
  }
  return { status: 200, body: { exitCode: r.code, ...streams, ...placeOf(sys, cwd) } };
}

// Validation, the capability gate, resolution and the run, in that order. A
// refusal before the run THROWS (an httpError the route's error middleware
// renders); an outcome of the run is RETURNED, because several carry fields
// beyond `{error, code}`.
export async function runHostExec(
  body: unknown,
  { capabilities, signal }: { capabilities: PlatformCapabilities; signal?: AbortSignal },
): Promise<HostExecResponse> {
  const req = parseRequest(body);
  let sys: System;
  let cwd: string;
  if ('project' in req.target) {
    const resolved = await resolveProjectCwd(req.target.project, req.target.worktree);
    if (resolved.system.id !== LOCAL_SYSTEM_ID && !capabilities.remoteSystems) throw capabilityRefusal('remoteSystems');
    sys = resolved.system;
    cwd = resolved.cwd;
  } else {
    // BEFORE systemById, so a platform without remote Systems launches no
    // provider to refuse with.
    if (req.target.system !== LOCAL_SYSTEM_ID && !capabilities.remoteSystems) throw capabilityRefusal('remoteSystems');
    sys = await systemById(req.target.system, req.target.remoteId, `exec on system '${req.target.system}'`);
    cwd = req.target.cwd;
  }
  const r = await sys.exec(req.spec, {
    cwd,
    timeoutMs: req.timeoutMs,
    stdin: req.stdin ?? 'ignore',
    envOverlay: req.env,
    encoding: req.encoding === 'base64' ? 'buffer' : 'utf8',
    maxBufferBytes: req.maxOutputBytes,
    signal,
  });
  return mapResult(r, sys, cwd, req);
}
