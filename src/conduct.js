// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsRoot } from './projects.js';

export const CONDUCT_PROJECT_NAME = '.conduct';

// Absolute path to the repo-root CONDUCT.md. Resolved once at module load
// from import.meta.url so it follows wherever the orchestrator is checked
// out — no environment variable, no hardcoded user path.
export const CONDUCT_MD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'CONDUCT.md',
);

export function conductProjectPath() {
  return path.join(projectsRoot(), CONDUCT_PROJECT_NAME);
}

// Idempotent: creates the .conduct dir (if missing), drops a symlink at
// .conduct/CONDUCT.md pointing at the repo's CONDUCT.md, and seeds
// CLAUDE.md with a single in-project @CONDUCT.md import.
//
// Why the symlink: Claude Code gates @-import paths that resolve outside
// the project root behind an "external includes approved" dialog that
// never fires in headless / `-p` mode (which is how every conductor
// session is spawned), so external imports silently no-op. Keeping the
// import path in-project bypasses that gate while the symlink keeps the
// content tracking the committed file. The workspace-wide ../CLAUDE.md
// is omitted on purpose — Claude Code's ancestor walk-up already pulls
// in cc-projects/CLAUDE.md.
//
// The `wx` flag preserves any user-customised CLAUDE.md once it exists.
// Symlink creation is best-effort: if a non-symlink file is already at
// .conduct/CONDUCT.md (user override) it is left alone. Returns {path,
// created, claudeMdPath, claudeMdSeeded} so callers (and tests) can
// tell what happened.
export async function ensureConductProject() {
  const dir = conductProjectPath();
  let created = false;
  try {
    await fs.mkdir(dir, { recursive: false });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const conductMdSymlinkPath = path.join(dir, 'CONDUCT.md');
  const conductMdRel = path.relative(dir, CONDUCT_MD_PATH);
  try {
    await fs.symlink(conductMdRel, conductMdSymlinkPath);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Already present — user override or prior run. Leave alone.
  }

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

  return { path: dir, created, claudeMdPath, claudeMdSeeded };
}
