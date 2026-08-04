// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot } from './projects.ts';

export const CONDUCT_PROJECT_NAME = '.conduct';

export function conductProjectPath(): string {
  return path.join(projectsRoot(), CONDUCT_PROJECT_NAME);
}

// Idempotent: ensures the `.conduct` dir exists (it is the cwd of every
// conductor session, so it must be present before spawn).
//
// The conductor's composed role doc is NOT written here — it is composed
// fresh by composeCurrentConduct() and injected at spawn time via
// `claude --append-system-prompt` (see Instance.launch/spawn in
// src/instances.js), so selection edits take effect on the next spawn/resume
// with no on-disk artifact to keep in sync. Edit paths for its content are the
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

// The `code` on a thrown Node error (e.g. 'EEXIST'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
