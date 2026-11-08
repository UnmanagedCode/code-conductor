// Migration 0042: the generated /mcp client directory is retired.
//
// Before (under <root>/.code-conductor/):
//   mcp-client/             generated Node + Python clients a worker's script imported
// After:
//   migrated-backup-0042-<ms>/mcp-client/   the old directory, moved aside
//
// Workers chain cc calls through the `run_code` tool now (docs/code-mode.md),
// and nothing writes or reads the directory any more.
//
// ── PROBE ──────────────────────────────────────────────────────────────────
// No mcp-client directory → no-op. The move removes it, so a second run is one.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0042-remove-mcp-client-dir';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const store = path.join(projectsRoot, '.code-conductor');
  const dir = path.join(store, 'mcp-client');
  try { await fs.lstat(dir); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { applied: false };
    throw e;
  }
  const backup = path.join(store, `migrated-backup-0042-${Date.now()}`);
  await fs.mkdir(backup, { recursive: true });
  await fs.rename(dir, path.join(backup, 'mcp-client'));
  log(`  ${name}: moved ${dir} to ${backup}`);
  return { applied: true, summary: { movedTo: backup } };
}
