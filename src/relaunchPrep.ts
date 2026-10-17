// The preparation every cc relaunch runs in the OLD process before anything is
// torn down — one implementation for the restart route (src/restart.ts
// runRestart) and self-update (src/selfUpdate.ts):
//
//   - ensureDependencies: `npm install` only when node_modules does not satisfy
//     package.json (src/depsDrift.ts), never into a linked node_modules, and
//     verified by a re-check afterwards;
//   - the web build staged beside the served one (src/webBuild.ts stageWebBuild);
//   - withMaintenanceLock: one restart, self-update or Claude CLI update
//     (src/claudeUpdate.ts) at a time.
//
// A failure throws, and the caller refuses the relaunch, so the running cc keeps
// serving.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyDrift } from './depsDrift.ts';
import { httpError } from './httpError.ts';
import { runGroupedCommand, GROUP_OUTPUT_CAP, RESULT_TAIL_CAP } from './groupedCommand.ts';
import { hostPlatform } from './platform/index.ts';
import { stageWebBuild } from './webBuild.ts';

const NPM_TIMEOUT_MS = 300_000;

export type InstallResult = { ran: false } | { ran: true; ok: true; code: number; tail: string };

/**
 * Brings node_modules in line with package.json. In sync → `{ ran: false }`
 * without running anything. A linked node_modules (a worktree's, an isolated
 * preview's) is refused 409 `DEPS_LINKED` rather than installed into: it is
 * another checkout's tree. Otherwise `npmCmd` runs in a detached process group
 * (`CC_NPM_INSTALL_CMD`, default `npm install`); a non-zero exit or a drift that
 * survives it throws with `{ ran, exitCode, tail }`.
 */
export async function ensureDependencies({
  repoRoot,
  npmCmd = process.env.CC_NPM_INSTALL_CMD || 'npm install',
  onChunk,
}: { repoRoot: string; npmCmd?: string; onChunk?: (text: string) => void }): Promise<InstallResult> {
  const drift = dependencyDrift(repoRoot);
  if (!drift) return { ran: false };
  const modules = path.join(repoRoot, 'node_modules');
  let linked = false;
  try { linked = fs.lstatSync(modules).isSymbolicLink(); } catch { /* absent: install creates it */ }
  if (linked) {
    throw httpError(409,
      `node_modules does not satisfy package.json (${drift.reason}) and is a link to ${fs.readlinkSync(modules)}, `
      + 'which cc does not install into — run npm install there.',
      { code: 'DEPS_LINKED', ran: false });
  }
  const r = await runGroupedCommand({ shell: npmCmd }, {
    cwd: repoRoot, env: process.env, timeoutMs: NPM_TIMEOUT_MS, cap: GROUP_OUTPUT_CAP, onChunk,
  }, hostPlatform);
  const tail = r.output.trimEnd().slice(-RESULT_TAIL_CAP);
  if (r.code !== 0) {
    throw httpError(500, `npm install failed (exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { ran: true, exitCode: r.code, tail });
  }
  const after = dependencyDrift(repoRoot);
  if (after) {
    throw httpError(500, `npm install finished but node_modules still differs: ${after.reason}`, { ran: true, exitCode: 0, tail });
  }
  return { ran: true, ok: true, code: r.code, tail };
}

// The one slot restart, self-update and the Claude CLI update share: a pull
// under a draining restart, or two installs into one tree, must never overlap,
// and a restart mid `claude update` would orphan it and lose its log.
let maintenance: string | null = null;

export async function withMaintenanceLock<T>(kind: 'restart' | 'update' | 'claude-update', fn: () => Promise<T>): Promise<T> {
  if (maintenance) {
    throw httpError(409, `a restart or update is already in progress (${maintenance})`, { code: 'MAINTENANCE_IN_PROGRESS' });
  }
  maintenance = kind;
  try { return await fn(); }
  finally { maintenance = null; }
}

/** The relaunch's preparation steps, as runRestart (src/restart.ts) drives them; tests inject stubs. */
export interface RelaunchPrep {
  drift(): { reason: string } | null;
  installDeps(onChunk: (text: string) => void): Promise<unknown>;
  stageWeb(onChunk: (text: string) => void): Promise<unknown>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const relaunchPrep: RelaunchPrep = {
  drift: () => dependencyDrift(repoRoot),
  installDeps: (onChunk) => ensureDependencies({ repoRoot, onChunk }),
  stageWeb: (onChunk) => stageWebBuild({ onChunk }),
};
