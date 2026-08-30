// Ownership of a project's in-tree `CONVENTIONS.md` — the one file
// code-conductor writes into a project tree, imported by that project's
// `CLAUDE.md` via `@CONVENTIONS.md`. It carries BOTH convention scopes:
//   - workspace ("applies to every project"), composed unconditionally from the
//     installation-wide selection in <store>/conventions/workspace.json;
//   - project (per-project pick), whose source of truth is line 1 of this very
//     file — a machine-readable marker
//       <!-- cc:conventions design-guidelines,testing-guidelines -->
//     listing the selected slugs.
//
// The project selection travels WITH the project so any cc instance (a fresh
// install, a moved/renamed project, an import into a different store) can
// regenerate from the file alone; the workspace selection deliberately does NOT
// travel — it is an installation-level choice that must not drift per project.
// Nothing here assumes the project sits under the projects root.
//
// The file is app-owned: cc overwrites it, whatever is in it. No sentinel, no
// backup, no hand-edit detection — recovery for a hand-authored body is git
// (every project is a repo from birth, and the file is tracked). The one
// safety net is a transient-failure guard: regeneration composes whichever
// marker slugs it *can* resolve and names the rest in a visible in-body note,
// keeping them in the marker so they recover verbatim if they resolve again,
// and it declines to write at all when a marker slug is unresolvable while the
// catalog is degraded (can't tell "genuinely gone" from "temporarily
// unreachable" — see getCatalog). That is the ONLY decline: a project with no
// file, a non-marker first line, or a zero-slug marker is regenerated with the
// workspace block and an empty project part.

import path from 'node:path';
import { listProjects, resolveProjectDir } from './projects.ts';
import { composeProjectConventionsBlock, getCatalog } from './projectConventions.ts';
import { composeCurrentWorkspace } from './workspaceConventions.ts';
import { ensureConventionsImport } from './conventionsImport.ts';

const CONVENTIONS_FILENAME = 'CONVENTIONS.md';

// Workspace conventions open with an H1 and their sections are H2s; project
// fragments are bare H2s. Concatenated without this separator, project
// conventions would read as workspace ones. Heading only — no prose.
const PROJECT_HEADING = '# Project conventions';

// Line-1 marker: `<!-- cc:conventions a,b,c -->` (slugs are comma-safe — the
// slug charset is [a-zA-Z0-9._-] plus plugin `<id>/<slug>`, never a comma).
const MARKER_RE = /^<!-- cc:conventions ?(.*?) ?-->$/;

interface RegenerateLog {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export function conventionsTargetPath(projectPath: string): string {
  return path.join(projectPath, CONVENTIONS_FILENAME);
}

export function buildMarker(slugs: string[]): string {
  return slugs.length ? `<!-- cc:conventions ${slugs.join(',')} -->` : '<!-- cc:conventions -->';
}

// Visible in-body note naming marker slugs that don't resolve locally. This is
// system-prompt text for every worker in the project, so it states only what
// an agent can't otherwise tell — the document is incomplete, and which slug
// is missing — no mechanics, no rationale, no imperative. Slugs keep marker
// order. The note can never be mistaken for the marker (always line 1) or for
// leftover content (the whole body is discarded before recomposition — see
// ensureProjectConventionsMd), so nothing more needs to be said here.
function unresolvedNote(missing: string[]): string {
  return `> Convention unavailable: ${missing.map(s => `\`${s}\``).join(', ')}.`;
}

// Parse the first line of a CONVENTIONS.md. Returns the slug array (possibly
// empty) if it is a valid marker, else null (not our file / grandfathered).
export function parseMarker(firstLine: string | null | undefined): string[] | null {
  const m = MARKER_RE.exec(firstLine ?? '');
  if (!m) return null;
  const inner = m[1].trim();
  return inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
}

// Full CONVENTIONS.md document for a project selection: marker, the composed
// workspace conventions, then the project ones under their own H1.
// `missing` (marker slugs that don't resolve here) is kept in the MARKER — so the
// convention recovers verbatim if it returns — but contributes a visible note
// instead of a body. Unknown slug outside `missing` → 400 (via
// composeProjectConventionsBlock); callers at project creation rely on that.
// With no project part at all (zero slugs, or none of them resolving to a body
// or a note) the heading is omitted too and the document is marker + workspace.
export async function composeProjectConventionsDoc(slugs: string[], missing: string[] = []): Promise<string> {
  const marker = buildMarker(slugs);
  const workspace = await composeCurrentWorkspace();          // ends with '\n'
  const gone = new Set(missing);
  const body = await composeProjectConventionsBlock(slugs.filter(s => !gone.has(s)));
  const note = gone.size ? `${unresolvedNote(missing)}\n` : '';
  const project = (note || body)
    ? `\n${PROJECT_HEADING}\n${note ? `\n${note}` : ''}${body}`
    : '';
  return `${marker}\n\n${workspace}${project}`;
}

// Regenerate one project's CONVENTIONS.md: the workspace block always, plus
// whatever the file's own marker selects for the project scope.
//   - project not found        → { skipped: 'no-project' }
//   - a marker slug is unresolvable AND the catalog is degraded (can't tell "gone"
//     from "temporarily unreachable") → { skipped: 'catalog-degraded', missing }
//     — the ONLY decline, and it freezes the WHOLE file, workspace block
//     included; transient by definition, so the next regenerate picks it up.
//   - anything else            → recompose + overwrite → { regenerated: true, missing }
//     (no file / non-marker line 1 / zero-slug marker all mean "no project
//     selection recorded": the old body is discarded, the marker — when there
//     is one — is kept verbatim.)
// Also ensures the project's CLAUDE.md carries the `@CONVENTIONS.md` import on
// every non-declining run: a CONVENTIONS.md nothing imports delivers nothing,
// and a project can appear at any time (a repo dropped into the projects root).
export async function ensureProjectConventionsMd(projectName: string, { log }: { log?: RegenerateLog } = {}): Promise<
  | { skipped: 'no-project' }
  | { skipped: 'catalog-degraded'; missing: string[] }
  | { path: string; regenerated: true; missing: string[] }
> {
  const projects = await listProjects();
  if (!projects.some(p => p.name === projectName)) return { skipped: 'no-project' };
  // This is one of the only two places cc writes INSIDE a project tree, so it
  // reads and writes through the project's system, never with a bare fs call.
  //
  // resolveProjectDir, NOT resolveSystem: this needs a PATH as much as a
  // handle, and the two are not the same question. A record naming a reachable
  // system with no `systemPath` resolves its system perfectly well and has no
  // tree — and the listing row it comes from carries an empty path, so
  // composing against it wrote `CLAUDE.md` and `CONVENTIONS.md` to a bare
  // filename on the far side, landing wherever the provider ran and reporting
  // success. Resolving the project refuses instead, and the sweep's
  // per-project catch turns that into an error entry.
  const resolved = await resolveProjectDir(projectName);
  if (!resolved) return { skipped: 'no-project' };
  const { path: projPath, system } = resolved;
  const target = conventionsTargetPath(projPath);

  let existing: string | null = null;
  try { existing = await system.readFile(target); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }

  const slugs = (existing === null ? null : parseMarker(existing.split('\n', 1)[0])) ?? [];

  const catalog = await getCatalog();
  // Resolve against the local catalog. Unresolvable slugs (a custom convention
  // absent on this instance, a disabled/absent plugin, a retired seed) stay in
  // the marker — so the text returns verbatim if they do — but drop out of the
  // body in favour of a visible note. The resolvable ones refresh normally.
  const bySlug = new Map(catalog.map(e => [e.slug, e]));
  const missing = slugs.filter(s => !bySlug.has(s));
  // A degraded catalog (extraProvider threw, or a plugin's own cwd resolution
  // transiently failed — see CatalogList) can't tell "genuinely gone" from
  // "temporarily unreachable" for a slug it's about to drop. Degradation only
  // ever OMITS catalog entries — it never alters the body of one that's still
  // present — so it matters only when this marker actually has a slug about
  // to be dropped (i.e. `missing` is non-empty here): if every marker slug
  // still resolves, the composed output is identical to what a healthy
  // catalog would produce, and declining the write would freeze a project
  // over a failure that has nothing to do with it. A project with no marker
  // slugs at all therefore always writes — `missing` is empty — and the
  // WORKSPACE catalog carries no extraProvider (src/workspaceConventions.ts),
  // so it can never be the degraded one.
  if (catalog.degraded && missing.length > 0) {
    if (log?.log) log.log(`CONVENTIONS.md left as-is for '${projectName}': catalog degraded, unresolvable ${missing.join(', ')}`);
    return { skipped: 'catalog-degraded', missing };
  }

  await ensureConventionsImport(system, projPath);
  const content = await composeProjectConventionsDoc(slugs, missing);
  await system.writeFile(target, content);
  if (log?.log) {
    log.log(missing.length
      ? `CONVENTIONS.md regenerated without unresolvable ${missing.join(', ')}: ${target}`
      : `CONVENTIONS.md regenerated: ${target}`);
  }
  return { path: target, regenerated: true, missing };
}

// Boot / post-mutation fan-out over every project. Per-project try/catch so one
// bad project can't abort the sweep. `.conduct` is excluded by listProjects().
export async function regenerateAllProjectConventions({ log }: { log?: RegenerateLog } = {}): Promise<Array<{ name: string; [key: string]: unknown }>> {
  const projects = await listProjects();
  const results: Array<{ name: string; [key: string]: unknown }> = [];
  for (const p of projects) {
    try { results.push({ name: p.name, ...(await ensureProjectConventionsMd(p.name, { log })) }); }
    catch (e) {
      if (log?.warn) log.warn(`CONVENTIONS.md regenerate failed for '${p.name}': ${errMsg(e)}`);
      results.push({ name: p.name, error: errMsg(e) });
    }
  }
  return results;
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
