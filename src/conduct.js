// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot } from './projects.js';
import { composeCurrentConduct } from './conductorConventions.js';

export const CONDUCT_PROJECT_NAME = '.conduct';

export function conductProjectPath() {
  return path.join(projectsRoot(), CONDUCT_PROJECT_NAME);
}

// Idempotent: creates the .conduct dir (if missing), (re)generates
// .conduct/CONDUCT.md from the current core + enabled conventions,
// and seeds CLAUDE.md with a single in-project @CONDUCT.md import.
//
// The composed doc is a fully-owned generated artifact: it is overwritten
// on every call (boot, Conduct-dialog-open, conductor resume, and after a
// settings change), so selection edits take effect for newly-spawned /
// next-context-refresh conductor sessions. Edit paths for its content are
// the `conventions/conductor/*.md` fragments (built-in text) and Settings →
// Conductor conventions (toggles + custom conventions) — never the generated file.
//
// A legacy `.conduct/CONDUCT.md` *symlink* (from migration 0003, the
// pre-generation era) is swapped for a regular file idempotently.
//
// Why the in-project @import: Claude Code gates @-import paths that resolve
// outside the project root behind an "external includes approved" dialog
// that never fires in headless / `-p` mode (which is how every conductor
// session is spawned), so external imports silently no-op. Keeping the
// import path in-project (`@CONDUCT.md`) bypasses that gate. The
// workspace-wide ../CLAUDE.md is omitted on purpose — Claude Code's
// ancestor walk-up already pulls in cc-projects/CLAUDE.md.
//
// The `wx` flag preserves any user-customised CLAUDE.md once it exists.
// Returns {path, created, conductMdPath, claudeMdPath, claudeMdSeeded} so
// callers (and tests) can tell what happened.
export async function ensureConductProject() {
  const dir = conductProjectPath();
  let created = false;
  try {
    await fs.mkdir(dir, { recursive: false });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const conductMdPath = path.join(dir, 'CONDUCT.md');
  const content = await composeCurrentConduct();
  try {
    const st = await fs.lstat(conductMdPath);
    if (st.isSymbolicLink()) await fs.unlink(conductMdPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.writeFile(conductMdPath, content);

  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  const seedContent = '@CONDUCT.md\n';
  let claudeMdSeeded = false;
  try {
    await fs.writeFile(claudeMdPath, seedContent, { flag: 'wx' });
    claudeMdSeeded = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Existing CLAUDE.md left alone — user may have customised it.
  }

  return { path: dir, created, conductMdPath, claudeMdPath, claudeMdSeeded };
}
