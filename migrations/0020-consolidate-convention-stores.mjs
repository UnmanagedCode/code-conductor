// Consolidates the three convention-scope stores under a shared
// <root>/.code-conductor/conventions/ directory, matching the source-tree
// consolidation (conventions/{conductor,workspace,project}/):
//   conduct-modules.json     → conventions/conductor.json
//   workspace-modules.json   → conventions/workspace.json
//   project-conventions.json → conventions/project.json
//
// The "modules" noun was renamed to "conventions" across all three scopes; the
// module, REST route, and MCP tool were renamed to match, and application code
// reads only the new paths (no back-compat alias).
//
// Idempotent: skips any scope whose old file is already gone; never clobbers an
// existing destination (leaves the stale old file for manual inspection). Runs
// after the frozen enabled-mutating migrations (0012/0013/0015), which keep
// pointing at the old flat paths and no-op once this has moved the files.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0020-consolidate-convention-stores';

const MOVES = [
  { old: 'conduct-modules.json', new: 'conductor.json' },
  { old: 'workspace-modules.json', new: 'workspace.json' },
  { old: 'project-conventions.json', new: 'project.json' },
];

export async function run({ root }) {
  const store = path.join(root, '.code-conductor');
  const destDir = path.join(store, 'conventions');
  const renamed = [];

  for (const { old, new: dest } of MOVES) {
    const oldPath = path.join(store, old);
    const newPath = path.join(destDir, dest);
    if (!(await fileExists(oldPath))) continue;
    if (await fileExists(newPath)) continue; // don't clobber a newer file
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(oldPath, newPath);
    renamed.push(`${old} → conventions/${dest}`);
  }

  if (renamed.length === 0) return { applied: false };
  return { applied: true, summary: { renamed } };
}

async function fileExists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}
