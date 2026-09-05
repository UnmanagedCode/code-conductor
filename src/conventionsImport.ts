// The one implementation of "make this dir's CLAUDE.md import its
// CONVENTIONS.md". Shared by `.conduct` (src/conduct.ts) and every project
// (src/projectClaudeMd.ts): both deliver a generated CONVENTIONS.md through
// the same `@`-import channel, and a CONVENTIONS.md nothing imports delivers
// nothing.
//
// migrations/0031-conduct-conventions-import.mjs duplicates the literal and the
// prepend shape (built-ins only — see migrations/migrations.md); all three must
// emit the identical line so a migrated install and a fresh ensure converge.

import path from 'node:path';
import type { System } from './systems/system.ts';

export const CONVENTIONS_IMPORT_LINE = '@CONVENTIONS.md';

// Guarantee `<dir>/CLAUDE.md` carries a line whose trim() is exactly the
// import. Three branches, and the third is what makes this safe to run on boot,
// on the Conduct-tap ensure route, on resume-restart and on every project
// regeneration:
//   - absent            → create with the import alone;
//   - present, no import → PREPEND it, every existing byte kept below (the file
//                          may be the user's own; nothing here may rewrite it);
//   - present, imported  → NO WRITE AT ALL, so repeat ensures cause no mtime
//                          churn.
// Detection is line-level, not substring: prose mentioning the filename must
// not read as an import.
export async function ensureConventionsImport(system: System, dir: string): Promise<void> {
  const target = path.join(dir, 'CLAUDE.md');
  let existing: string | null = null;
  try {
    // Exclusive create so a concurrent ensure can't clobber a file that appeared
    // between a read and a write; EEXIST just means "someone got here first,
    // re-read it".
    await system.writeFile(target, `${CONVENTIONS_IMPORT_LINE}\n`, { exclusive: true });
    return;
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
    existing = await system.readFile(target);
  }
  if (existing.split('\n').some(line => line.trim() === CONVENTIONS_IMPORT_LINE)) return;
  await system.writeFile(target, `${CONVENTIONS_IMPORT_LINE}\n${existing}`, { atomic: true });
}

// The `code` on a thrown Node error (e.g. 'EEXIST'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
