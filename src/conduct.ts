// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, writeFileAtomic } from './projects.ts';
import { composeCurrentConduct } from './conductorConventions.ts';

export const CONDUCT_PROJECT_NAME = '.conduct';

export function conductProjectPath(): string {
  return path.join(projectsRoot(), CONDUCT_PROJECT_NAME);
}

// "Is this instance a conductor?" — the one predicate, so every consumer asks
// the same question. Conductor-ness is a property of the project: `.conduct` is
// the reserved home of orchestrating sessions and nothing else lives there.
// (Distinct from `conducted`, which marks a WORKER spawned BY a conductor.)
export function isConductorInstance(inst: { project: string } | null | undefined): boolean {
  return !!inst && inst.project === CONDUCT_PROJECT_NAME;
}

// The import line `.conduct/CLAUDE.md` must carry for the composed role doc to
// reach the conductor. Both this module and
// migrations/0031-conduct-conventions-import.mjs must emit this exact literal,
// so a migrated install and a fresh ensure converge on one shape.
const CONDUCT_IMPORT_LINE = '@CONVENTIONS.md';

// Idempotent: ensures the `.conduct` dir exists (it is the cwd of every
// conductor session, so it must be present before spawn) and that its
// `CLAUDE.md` imports the generated role doc.
//
// The doc itself is NOT written here — the pre-spawn materializer is its sole
// writer (see conductConventionsPath below). Edit paths for its content are the
// `conventions/conductor/*.md` fragments (built-in text) and Settings →
// Conductor conventions (toggles + custom conventions). Workspace conventions
// reach the conductor via Claude Code's ancestor walk-up to the app-owned
// <projectsRoot>/CLAUDE.md.
//
// Returns {path, created} so callers (and tests) can tell what happened;
// `created` means the DIR was created, independent of the CLAUDE.md step.
export async function ensureConductProject(): Promise<{ path: string; created: boolean }> {
  const dir = conductProjectPath();
  let created = false;
  try {
    await fs.mkdir(dir, { recursive: false });
    created = true;
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  await ensureConductClaudeMd(dir);
  return { path: dir, created };
}

// Guarantee `.conduct/CLAUDE.md` carries a line whose trim() is exactly the
// import. Three branches, and the third is what makes this safe to run on boot,
// on the Conduct-tap ensure route, and on resume-restart:
//   - absent            → create with the import alone;
//   - present, no import → PREPEND it, every existing byte kept below (the file
//                          may be the user's own; nothing here may rewrite it);
//   - present, imported  → NO WRITE AT ALL, so repeat ensures cause no mtime
//                          churn.
// Detection is line-level, not substring: prose mentioning the filename must
// not read as an import.
async function ensureConductClaudeMd(dir: string): Promise<void> {
  const target = path.join(dir, 'CLAUDE.md');
  let existing: string | null = null;
  try {
    // `wx` so a concurrent ensure can't clobber a file that appeared between a
    // read and a write; EEXIST just means "someone got here first, re-read it".
    await fs.writeFile(target, `${CONDUCT_IMPORT_LINE}\n`, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
    existing = await fs.readFile(target, 'utf8');
  }
  if (existing.split('\n').some(line => line.trim() === CONDUCT_IMPORT_LINE)) return;
  await writeFileAtomic(target, `${CONDUCT_IMPORT_LINE}\n${existing}`);
}

// Where the composed conductor role doc is materialized for the CLI to read:
// in the project, delivered over the MESSAGES stream as a CLAUDE.md `@`-import.
//
// Why the messages stream and not the CLI's appended-system-prompt flag: every
// non-Anthropic backend here is the same `claude` CLI with ANTHROPIC_BASE_URL
// pointed at a translation proxy, and a proxy that reads only `system[0]` — or
// flattens `system` to a string — silently drops the appended block, leaving
// the conductor with NO role doc. The CLAUDE.md channel is one the backend
// already honours for every worker, so it cannot be dropped in translation.
//
// Why in the project rather than a store path `@`-imported from here: an import
// resolving outside the project root is gated behind the external-includes
// dialog, which never fires in headless `-p` mode — migration 0003's whole
// problem.
//
// This is a partial revert of migrations/0022, whose two objections are
// answered rather than reintroduced:
//   - freshness: the pre-spawn materializer is the SOLE writer of this file, so
//     there is no ensure-time copy that can drift from the live selection;
//   - ownership: the file is app-owned and generated (it says so in its own
//     footer), and the user's `.conduct/CLAUDE.md` — a separate file — only
//     ever gains an import line, never loses a byte.
//
// One fixed path, overwritten in place. writeFileAtomic mkdir -p's the parent
// and renames into place, so a concurrent reader sees one whole document,
// never a torn one.
export function conductConventionsPath(): string {
  return path.join(conductProjectPath(), 'CONVENTIONS.md');
}

// Compose the current conductor role doc and write it where the conductor's
// CLAUDE.md imports it from. Self-sufficient: it ensures the dir and the import
// line first, so no spawn depends on someone having tapped Conduct earlier.
// Called from Instance.launch() for conductor instances only.
export async function materializeCurrentConduct(): Promise<void> {
  await ensureConductProject();
  await writeFileAtomic(conductConventionsPath(), await composeCurrentConduct());
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
