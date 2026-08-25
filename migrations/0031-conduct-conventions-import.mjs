// The conductor role doc moved off the CLI's appended-system-prompt channel and
// onto the messages stream: it is now composed into
// `<root>/.conduct/CONVENTIONS.md` before every conductor spawn and reaches the
// session as a CLAUDE.md `@`-import. (A translation proxy in front of a
// non-Anthropic backend can drop an extra `system` block; a CLAUDE.md import it
// cannot.) Two consequences for an existing install, handled as two INDEPENDENT
// halves so an early return can never skip one:
//   1. `<root>/.code-conductor/conductor-prompt.md` is an orphan — nothing reads
//      it any more. Unlink it. This half runs whether or not `.conduct/` exists,
//      because the orphan lives in the store.
//   2. `.conduct/CLAUDE.md` must carry an `@CONVENTIONS.md` line, or the doc
//      reaches nothing. Create it if absent; otherwise PREPEND the import,
//      keeping every existing byte below it (a user may own this file). Already
//      imported ⇒ no write.
// When `.conduct/` itself is absent this is a fresh install: skip half 2, since
// boot's ensureConductProject() creates both the dir and the import.
//
// The import literal and the prepend shape are duplicated from
// src/conduct.ts's ensureConductClaudeMd rather than imported (built-ins only —
// see migrations/migrations.md); both must emit the identical line so a migrated
// install and a fresh ensure converge.
//
// Idempotent: no-op once the orphan is gone and the import line is present.
// Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0031-conduct-conventions-import';

const IMPORT_LINE = '@CONVENTIONS.md';

const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const promptPath = path.join(projectsRoot, '.code-conductor', 'conductor-prompt.md');
  const conductDir = path.join(projectsRoot, '.conduct');
  const claudeMd = path.join(conductDir, 'CLAUDE.md');

  // Half 1 — the store orphan.
  let promptRemoved = false;
  try {
    await fs.unlink(promptPath);
    promptRemoved = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Half 2 — the import line, only for an install that already has `.conduct/`.
  let claudeMdChange = false;
  let conductExists = true;
  try {
    await fs.stat(conductDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    conductExists = false;
  }
  if (conductExists) {
    let existing = null;
    try {
      existing = await fs.readFile(claudeMd, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (existing === null) {
      await fs.writeFile(claudeMd, `${IMPORT_LINE}\n`, 'utf8');
      claudeMdChange = 'created';
    } else if (!existing.split('\n').some(line => line.trim() === IMPORT_LINE)) {
      await fs.writeFile(claudeMd, `${IMPORT_LINE}\n${existing}`, 'utf8');
      claudeMdChange = 'prepended';
    }
  }

  if (!promptRemoved && !claudeMdChange) return { applied: false };
  if (promptRemoved) log(`  ✓ removed orphan conductor-prompt.md at ${promptPath}`);
  if (claudeMdChange === 'created') log(`  ✓ created ${claudeMd} with ${IMPORT_LINE}`);
  else if (claudeMdChange === 'prepended') log(`  ✓ prepended ${IMPORT_LINE} to ${claudeMd}`);
  return { applied: true, summary: { promptRemoved, claudeMd: claudeMdChange } };
}
