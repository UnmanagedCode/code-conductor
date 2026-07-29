// Migration 0023: bump a persisted `models.conductorCompactWindowK` below the
// new 100 (k-tokens) floor up to 100.
//
// Before: `COMPACT_K_MIN` was 20, so a user could persist a value in
//         [20, 99] via the Settings slider.
// After:  `COMPACT_K_MIN` is 100 — the Claude Code CLI floors
//         `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at 100,000 tokens itself
//         (`Math.max(100000, effective)`), so any value below 100 was
//         already a silent no-op at spawn time. Without this migration a
//         pre-existing sub-100 value would still be read back verbatim by
//         `getConductorCompactWindow()` and seeded onto the `.conduct` child
//         env, reproducing the exact no-op the new floor exists to prevent.
//
// Scope: a single file in the central store, `<root>/.code-conductor/settings.json`.
// Idempotent: a no-op once no persisted value is below 100.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0023-clamp-compact-window-floor';

// Default projects root = parent dir of the repo (migrations/0023…mjs →
// ../../). Mirrors src/projects.js's DEFAULT_PROJECTS_ROOT; kept self-
// contained per the migrations conventions.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// Hardcoded rather than imported from src/appSettings.js (migrations use
// built-ins only). Matches COMPACT_K_MIN at the time this migration was written.
const COMPACT_K_MIN = 100;

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const file = path.join(projectsRoot, '.code-conductor', 'settings.json');

  const settings = await readJsonSafe(file);
  if (!settings || typeof settings !== 'object' || !settings.models || typeof settings.models !== 'object') {
    return { applied: false };
  }

  const k = settings.models.conductorCompactWindowK;
  if (typeof k !== 'number' || !Number.isFinite(k) || k >= COMPACT_K_MIN) {
    return { applied: false };
  }

  const from = k;
  settings.models.conductorCompactWindowK = COMPACT_K_MIN;
  await writeJsonAtomic(file, settings);
  log(`  ✓ bumped conductorCompactWindowK ${from} -> ${COMPACT_K_MIN} in ${file}`);
  return { applied: true, summary: { from, to: COMPACT_K_MIN } };
}
