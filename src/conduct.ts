// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, projectsRoot, writeFileAtomic } from './projects.ts';
import { composeCurrentConduct } from './conductorConventions.ts';

export const CONDUCT_PROJECT_NAME = '.conduct';

export function conductProjectPath(): string {
  return path.join(projectsRoot(), CONDUCT_PROJECT_NAME);
}

// "Is this instance a conductor?" — the one predicate, so every consumer asks
// the same question. Conductor-ness is a property of the project: `.conduct` is
// the reserved home of orchestrating sessions and nothing else lives there.
// (Distinct from `conducted`, which marks a WORKER spawned BY a conductor.)
export function isConductorInstance(inst: { project: string } | null | undefined): boolean {
  return !!inst && inst.project === CONDUCT_PROJECT_NAME;
}

// Idempotent: ensures the `.conduct` dir exists (it is the cwd of every
// conductor session, so it must be present before spawn).
//
// The conductor's composed role doc is NOT written here — it lives in the
// app-owned store (see conductPromptPath below) and is delivered at spawn via
// `claude --append-system-prompt-file`. Edit paths for its content are the
// `conventions/conductor/*.md` fragments (built-in text) and Settings →
// Conductor conventions (toggles + custom conventions). Workspace conventions
// still reach the conductor via Claude Code's ancestor walk-up to the
// app-owned <projectsRoot>/CLAUDE.md; no in-project CLAUDE.md is seeded.
//
// Returns {path, created} so callers (and tests) can tell what happened.
export async function ensureConductProject(): Promise<{ path: string; created: boolean }> {
  const dir = conductProjectPath();
  let created = false;
  try {
    await fs.mkdir(dir, { recursive: false });
    created = true;
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  return { path: dir, created };
}

// Where the composed conductor role doc is materialized for the CLI to read.
//
// It lives in the app-owned store, NOT in `.conduct/` — that is what keeps
// this from being a revert of migrations/0022, which deleted the old
// `.conduct/CONDUCT.md` and its `@CONDUCT.md` seed line. The differences are
// load-bearing, so don't "restore" the old shape:
//   - location:  app-owned store, outside every project tree (the old file sat
//                inside a user-visible project dir with ambiguous ownership);
//   - delivery:  an explicit `--append-system-prompt-file` argv, not a CLAUDE.md
//                `@`-import resolved by the CLI's ancestor walk-up — that import
//                was gated behind the external-includes dialog that never fires
//                in headless `-p` mode, which was migration 0003's whole problem;
//   - freshness: rewritten immediately before EVERY spawn and resume, where the
//                old file was written once at ensure-time and drifted from the
//                live convention selection.
// `.conduct` itself stays a bare dir (pinned by tests/conduct.test.mjs).
//
// One fixed path, overwritten in place — not a per-spawn or content-addressed
// name. The conductor is a singleton, and the CLI reads this file exactly once
// at startup (verified against 2.1.223 by strace: a single openat across a
// multi-turn session, and a session survives the file being deleted mid-run),
// so an overwrite cannot disturb an already-running conductor. writeFileAtomic
// renames into place, so even a hypothetical concurrent reader sees one whole
// document, never a torn one.
export function conductPromptPath(): string {
  return path.join(orchStoreRoot(), 'conductor-prompt.md');
}

// Compose the current conductor role doc and write it to conductPromptPath(),
// returning that path for the launch argv. Wired as the Instance
// appendSystemPromptFileProvider for `.conduct` sessions only.
export async function materializeCurrentConduct(): Promise<string> {
  const target = conductPromptPath();
  await writeFileAtomic(target, await composeCurrentConduct());
  return target;
}

// The `code` on a thrown Node error (e.g. 'EEXIST'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
