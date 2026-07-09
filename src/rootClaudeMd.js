// Ownership of the projects-root `CLAUDE.md` — the file every project imports
// via `@../CLAUDE.md`. code-conductor now *fully owns* this file: it is
// regenerated (overwritten) on boot and after every Settings → Workspace
// conventions change from the composed workspace modules
// (baseline/core.md + enabled baseline/modules/*.md), exactly like
// .conduct/CONDUCT.md. There is no three-way reconcile and no conflict UI.
//
// Safety on the co-owned → app-owned transition: the FIRST time we take
// ownership we back up a hand-edited target to `<target>.bak-<stamp>` so a
// user's edits are never silently destroyed. "First transition" is detected
// by the absence of the sentinel `<store>/workspace-claudemd/owned.json`.
// "Hand-edited" is judged against the legacy reconcile baseline
// (`<store>/workspace-claudemd/baseline.md`, the last-applied canonical from
// the retired reconcile era) when present, else against the freshly composed
// content. The one-time backup fires at most once; after the sentinel is
// written the file is overwritten silently on every regenerate.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, orchStoreRoot, writeFileAtomic } from './projects.js';
import { composeCurrentWorkspace } from './workspaceModules.js';

// ── Paths ────────────────────────────────────────────────────────────────

export function targetPath() {
  return path.join(projectsRoot(), 'CLAUDE.md');
}

function storeDir() {
  return path.join(orchStoreRoot(), 'workspace-claudemd');
}

function ownedMarkerPath() {
  return path.join(storeDir(), 'owned.json');
}

// Legacy last-applied canonical from the retired reconcile machinery. Used
// once, as the "was the target hand-edited?" oracle on the first app-owned
// regeneration. Absent on fresh installs (and after the transition).
function legacyBaselinePath() {
  return path.join(storeDir(), 'baseline.md');
}

// ── small fs helpers ────────────────────────────────────────────────────────

async function readFileOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function fileExists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

function timestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Regenerate (mutating; runs on boot + after settings changes) ─────────────

// Overwrite <PROJECTS_ROOT>/CLAUDE.md with the composed workspace conventions.
// On the first app-owned regeneration, back up a hand-edited target once.
// Returns { path, created, backedUp, backupPath }.
export async function ensureRootClaudeMd({ log } = {}) {
  const target = targetPath();
  const content = await composeCurrentWorkspace();

  const firstTransition = !(await fileExists(ownedMarkerPath()));
  let backedUp = false;
  let backupPath = null;
  if (firstTransition) {
    const existing = await readFileOrNull(target);
    if (existing != null) {
      // Back up only a hand-edited copy. Prefer the legacy reconcile baseline
      // as the "was it edited?" oracle; fall back to "differs from generated".
      const legacyBaseline = await readFileOrNull(legacyBaselinePath());
      const diverged = legacyBaseline != null
        ? existing !== legacyBaseline
        : existing !== content;
      if (diverged) {
        backupPath = `${target}.bak-${timestamp(new Date())}`;
        await fs.writeFile(backupPath, existing);
        backedUp = true;
      }
    }
    await writeFileAtomic(ownedMarkerPath(), JSON.stringify({ ownedSince: new Date().toISOString() }, null, 2) + '\n');
  }

  const created = !(await fileExists(target));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);

  if (log && typeof log.log === 'function') {
    const note = backedUp ? ` (backed up prior copy → ${backupPath})` : '';
    log.log(`root CLAUDE.md regenerated: ${target}${note}`);
  }
  return { path: target, created, backedUp, backupPath };
}
