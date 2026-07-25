// Supersedes the on-disk delivery of the conductor role doc. Previously
// ensureConductProject() wrote the composed doc to `.conduct/CONDUCT.md` and
// seeded `.conduct/CLAUDE.md` with an in-project `@CONDUCT.md` import (0003 →
// 0010 lineage). The doc is now composed fresh and injected at conductor spawn
// via `claude --append-system-prompt` (see Instance.launch/spawn in
// src/instances.js), so both artifacts are orphans. This migration:
//   1. Removes the generated `.conduct/CONDUCT.md` (a fully-owned generated
//      file — safe to unlink outright; unlink also clears any legacy symlink).
//   2. Strips the `@CONDUCT.md` seed line from `.conduct/CLAUDE.md`. Every
//      other line is preserved verbatim (a user may have hand-added content
//      below the seed), and the file is only unlinked when the remainder is
//      blank — so a lone-seed CLAUDE.md is removed but a customized one is kept.
//
// Idempotent: no-op once CONDUCT.md is absent and CLAUDE.md carries no
// `@CONDUCT.md` line. Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0022-drop-conduct-md-file';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const conductDir = path.join(projectsRoot, '.conduct');
  const conductMd = path.join(conductDir, 'CONDUCT.md');
  const claudeMd = path.join(conductDir, 'CLAUDE.md');

  let conductMdRemoved = false;
  try {
    await fs.unlink(conductMd);
    conductMdRemoved = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let seedStripped = false;
  let claudeMdRemoved = false;
  try {
    const text = await fs.readFile(claudeMd, 'utf8');
    const kept = text.split('\n').filter(line => line.trim() !== '@CONDUCT.md');
    if (kept.length !== text.split('\n').length) {
      seedStripped = true;
      if (kept.join('\n').trim() === '') {
        await fs.unlink(claudeMd);
        claudeMdRemoved = true;
      } else {
        await fs.writeFile(claudeMd, kept.join('\n'), 'utf8');
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (!conductMdRemoved && !seedStripped) return { applied: false };
  if (conductMdRemoved) log(`  ✓ removed orphan CONDUCT.md at ${conductMd}`);
  if (claudeMdRemoved) log(`  ✓ removed lone-seed CLAUDE.md at ${claudeMd}`);
  else if (seedStripped) log(`  ✓ stripped @CONDUCT.md seed from ${claudeMd}`);
  return { applied: true, summary: { conductMdRemoved, seedStripped, claudeMdRemoved } };
}
