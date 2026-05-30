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

// Idempotent: creates the .conduct dir (if missing) and seeds CLAUDE.md
// with two imports — the workspace-wide @../CLAUDE.md and a relative
// path to CONDUCT.md so conductor instances pick up the role definition
// regardless of cwd quirks. Claude Code only expands relative @-imports
// in CLAUDE.md, not absolute ones — so the CONDUCT.md path must be made
// relative to the .conduct dir. The `wx` flag preserves any user-
// customised CLAUDE.md once it exists. Returns {path, created,
// claudeMdPath, claudeMdSeeded} so callers (and tests) can tell what
// happened.
export async function ensureConductProject() {
  const dir = conductProjectPath();
  let created = false;
  try {
    await fs.mkdir(dir, { recursive: false });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  const conductMdRel = path.relative(dir, CONDUCT_MD_PATH);
  const seedContent = `@../CLAUDE.md\n@${conductMdRel}\n`;
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
