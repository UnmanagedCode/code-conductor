// Migration 0009: seed the workspace-CLAUDE.md "last-applied canonical"
// baseline from the legacy shell-installer's baseline file, if present.
//
// Before: src/rootClaudeMd.js's seedBaselineIfNeeded() fell back to reading
//         `~/.cache/code-conductor-bootstrap/CLAUDE.md.installed` (written
//         by the old termux-code-conductor shell installer) at read time,
//         whenever our own baseline.md was missing, so existing installs
//         wouldn't see a spurious "vendor changed" conflict on first boot.
// After:  that seed happens once, here, at boot — src/rootClaudeMd.js only
//         ever seeds from the vendored text going forward.
//
// Scope: a single file in the central store,
// `<root>/.code-conductor/workspace-claudemd/baseline.md`. `TCC_LEGACY_BASELINE`
// overrides the legacy source path (test injection only — mirrors the env
// var src/rootClaudeMd.js used to read).
// Idempotent: a no-op once baseline.md exists, or if no legacy file exists.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = '0009-seed-legacy-shell-installer-baseline';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

async function readFileOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function fileExists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const baselineFile = path.join(projectsRoot, '.code-conductor', 'workspace-claudemd', 'baseline.md');
  const legacyFile = process.env.TCC_LEGACY_BASELINE
    ?? path.join(os.homedir(), '.cache', 'code-conductor-bootstrap', 'CLAUDE.md.installed');

  if (await fileExists(baselineFile)) return { applied: false };

  const legacy = await readFileOrNull(legacyFile);
  if (legacy == null) return { applied: false };

  await writeFileAtomic(baselineFile, legacy);
  log(`  ✓ seeded ${baselineFile} from legacy baseline ${legacyFile}`);
  return { applied: true, summary: { seededFrom: 'legacy' } };
}
