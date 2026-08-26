// Bootstrap for the hidden `.conduct` project — home of Conductor
// sessions that orchestrate other Claude sessions via MCP. The dir lives
// at `<projectsRoot>/.conduct/` and is filtered out of listProjects() by
// the existing dot-prefix rule, so it never appears in the sidebar; the
// sidebar synthesises a row only when a live conductor instance exists.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, writeFileAtomic } from './projects.ts';
import { composeCurrentConduct } from './conductorConventions.ts';
import { composeCurrentWorkspace } from './workspaceConventions.ts';
import { ensureConventionsImport } from './conventionsImport.ts';

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

// Idempotent: ensures the `.conduct` dir exists (it is the cwd of every
// conductor session, so it must be present before spawn) and that its
// `CLAUDE.md` imports the generated role doc.
//
// The doc itself is NOT written here — the pre-spawn materializer is its sole
// writer (see conductConventionsPath below). Edit paths for its content are the
// `conventions/conductor/*.md` fragments (built-in text) and Settings →
// Conductor conventions (toggles + custom conventions). Workspace conventions
// reach the conductor because materializeCurrentConduct below prepends them to
// the role doc it writes.
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
  await ensureConventionsImport(dir);
  return { path: dir, created };
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
  // Workspace conventions first, role doc second: composeCurrentWorkspace()
  // ends with a newline, so `\n${role}` leaves exactly one blank line before
  // `# Conductor role` and the role doc's generated footer stays last.
  const [workspace, role] = await Promise.all([composeCurrentWorkspace(), composeCurrentConduct()]);
  await writeFileAtomic(conductConventionsPath(), `${workspace}\n${role}`);
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
