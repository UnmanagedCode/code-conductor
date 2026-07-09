// Supersedes 0003-conduct-md-symlink. `.conduct/CONDUCT.md` is no longer a
// symlink into the repo's CONDUCT.md — it is now a fully-owned *generated*
// file composed from conduct/core.md + enabled conduct/modules/*.md, written
// by ensureConductProject() (invoked at boot right after migrations, and on
// every Conduct-dialog-open / settings change).
//
// 0003 is unregistered from the runner because its symlink job now fights
// this design (it would recreate the link / warn every boot once the path is
// a regular file). This migration therefore takes over 0003's two jobs in a
// forward-compatible way:
//   1. Remove a legacy `.conduct/CONDUCT.md` *symlink* so ensureConductProject
//      can write a regular file in its place.
//   2. Repair a broken external `@…/CONDUCT.md` import line in
//      `.conduct/CLAUDE.md` → `@CONDUCT.md` (external @-imports silently no-op
//      in headless / `-p` mode). Every other line is preserved verbatim.
//
// Idempotent: no-op once CONDUCT.md is a regular file (or absent) and
// CLAUDE.md carries no broken import. Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0010-conduct-md-generated-file';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

// A line is a broken external CONDUCT.md import if it starts with '@',
// references CONDUCT.md, and resolves outside the .conduct/ dir.
// `@CONDUCT.md` itself is in-project and stays.
function isBrokenConductImport(line, conductDir) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return false;
  const target = trimmed.slice(1).trim();
  if (!target.endsWith('CONDUCT.md')) return false;
  if (target === 'CONDUCT.md') return false;
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(conductDir, target);
  const rel = path.relative(conductDir, resolved);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const conductDir = path.join(projectsRoot, '.conduct');
  const conductMd = path.join(conductDir, 'CONDUCT.md');
  const claudeMd = path.join(conductDir, 'CLAUDE.md');

  let symlinkRemoved = false;
  try {
    const st = await fs.lstat(conductMd);
    if (st.isSymbolicLink()) {
      await fs.unlink(conductMd);
      symlinkRemoved = true;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let claudeMdFixed = false;
  try {
    const text = await fs.readFile(claudeMd, 'utf8');
    const lines = text.split('\n');
    let mutated = false;
    const out = lines.map(line => {
      if (isBrokenConductImport(line, conductDir)) { mutated = true; return '@CONDUCT.md'; }
      return line;
    });
    if (mutated) {
      await fs.writeFile(claudeMd, out.join('\n'), 'utf8');
      claudeMdFixed = true;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (!symlinkRemoved && !claudeMdFixed) return { applied: false };
  if (symlinkRemoved) log(`  ✓ removed legacy CONDUCT.md symlink at ${conductMd} (now generated)`);
  if (claudeMdFixed) log(`  ✓ repaired broken external CONDUCT.md @-import in ${claudeMd}`);
  return { applied: true, summary: { symlinkRemoved, claudeMdFixed } };
}
