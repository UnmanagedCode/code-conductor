// Renames the custom-convention store <root>/.code-conductor/optional-guidelines.json
// → project-conventions.json. The "Optional guidelines" feature was renamed to
// "Project conventions" (one noun — Conventions — across Conductor / Workspace /
// Project scopes); the module, REST route, and MCP tool were renamed to match,
// and application code reads only the new filename (no back-compat alias).
//
// No-op once the old file is gone. If the destination already exists we leave
// both untouched (don't clobber a newer file) and report a skip.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = '0011-rename-optional-guidelines-store';

export async function run({ root }) {
  const store = path.join(root, '.code-conductor');
  const oldPath = path.join(store, 'optional-guidelines.json');
  const newPath = path.join(store, 'project-conventions.json');

  const oldExists = await fileExists(oldPath);
  if (!oldExists) return { applied: false };

  if (await fileExists(newPath)) {
    // Destination already present — don't overwrite. Leave the stale old file
    // in place for manual inspection rather than silently discarding it.
    return { applied: false };
  }

  await fs.rename(oldPath, newPath);
  return { applied: true, summary: { renamed: 'optional-guidelines.json → project-conventions.json' } };
}

async function fileExists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}
