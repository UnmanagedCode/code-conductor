// Migration 0032: workspace conventions no longer live in a file OUTSIDE every
// project. They are composed into each project's own in-tree `CONVENTIONS.md`
// (src/projectClaudeMd.ts) and into `.conduct/CONVENTIONS.md` (src/conduct.ts),
// so `<root>/CLAUDE.md` — and the whole ownership store that made writing a file
// outside every project safe — is retired. Four INDEPENDENT steps so an early
// return can never skip a later one:
//   1. read ownership BEFORE step 3 removes the dir that records it;
//   2. delete `<root>/CLAUDE.md` iff code-conductor owned it;
//   3. remove `<store>/workspace-claudemd/` (owned.json + the legacy baseline.md);
//   4. strip the now-dead `@../CLAUDE.md` import from every project's CLAUDE.md.
//
// The ownership oracle is the SENTINEL, not a content comparison: once
// `owned.json` existed, the retired ensureRootClaudeMd overwrote the target
// unconditionally on every boot, so whatever is on disk is code-conductor's own
// output by construction — whichever fragment version produced it. Comparing
// against freshly composed content would instead mismatch for every user whose
// upgrade also changes `conventions/workspace/*.md`, and the delete would never
// fire.
//
// No sentinel ⇒ never ours ⇒ leave the file completely alone and log. That log
// line does NOT count as `applied`, so it repeats every boot until the user acts
// and goes silent the moment they delete the file. It is the only signal: the
// sentinel under-reports ownership if someone wiped `.code-conductor/`, and an
// in-root project would then load those stale conventions via Claude Code's
// directory walk ON TOP of its own regenerated CONVENTIONS.md.
//
// Idempotent: sentinel gone + target gone is a clean no-op. Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0032-retire-root-claude-md';

const DEAD_IMPORT_LINE = '@../CLAUDE.md';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const ownedDir = path.join(projectsRoot, '.code-conductor', 'workspace-claudemd');
  const sentinel = path.join(ownedDir, 'owned.json');
  const target = path.join(projectsRoot, 'CLAUDE.md');

  // Step 1 — ownership, read before step 3 destroys the evidence.
  const owned = await exists(sentinel);

  // Step 2 — the root file.
  let rootAction = 'absent';
  if (await exists(target)) {
    if (owned) {
      await fs.unlink(target);
      rootAction = 'deleted';
    } else {
      rootAction = 'left';
      log(`  ! left ${target} in place: no ${sentinel} sentinel, so code-conductor never owned it. `
        + `Workspace conventions now come from each project's CONVENTIONS.md; if this file is a `
        + `stale copy of them, delete it.`);
    }
  }

  // Step 3 — the ownership store.
  const storeRemoved = await exists(ownedDir);
  if (storeRemoved) await fs.rm(ownedDir, { recursive: true, force: true });

  // Step 4 — the dead import. Direct children only (the shape listProjects
  // walks), worktree dirs and `.conduct` included: uniform, and a no-op where
  // the line isn't there.
  let stripped = 0;
  let entries = [];
  try { entries = await fs.readdir(projectsRoot, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.code-conductor') continue;
    const file = path.join(projectsRoot, e.name, 'CLAUDE.md');
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    const lines = text.split('\n');
    const kept = lines.filter(l => l.trim() !== DEAD_IMPORT_LINE);
    if (kept.length === lines.length) continue;
    await fs.writeFile(file, kept.join('\n'));
    stripped++;
  }

  if (rootAction !== 'deleted' && !storeRemoved && stripped === 0) return { applied: false };
  if (rootAction === 'deleted') log(`  ✓ removed app-owned ${target}`);
  if (storeRemoved) log(`  ✓ removed retired ownership store ${ownedDir}`);
  if (stripped > 0) log(`  ✓ stripped ${DEAD_IMPORT_LINE} from ${stripped} project CLAUDE.md file(s)`);
  return { applied: true, summary: { rootClaudeMd: rootAction, ownershipStore: storeRemoved, importsStripped: stripped } };
}
