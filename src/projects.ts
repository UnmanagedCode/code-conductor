import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSessions, fileFacts, setSegmentArchived, type SessionIndex } from './sessionStore.ts';
import { effectiveResumeMode } from './sessionModes.ts';
import { lastActivityOf } from './sessionActivity.ts';
import type { WorktreeMeta } from './worktrees.ts';
import { isSessionId, isMintedPublicId, assertBackingId } from './identifiers.ts';
import { projectsRoot, orchStoreRoot, projectStoreDir, localWorktreesRoot, pluginsRoot } from './storeRoot.ts';
import { validateName, readProjectRecord } from './projectRecord.ts';
import { getProject, listProjects } from './projectRegistry.ts';
import { claudeConfigDir } from './claudeConfigDir.ts';
import { LOCAL_SYSTEM_ID, projectPlacement } from './systems/registry.ts';
import { writeFileAtomic } from './systems/localSystem.ts';
import type { SessionRow, ProjectInfo, SessionCounts } from '../shared/wireRows.ts';
import { firstPromptHead } from '../shared/promptPreview.ts';
import { stripAuthorMarker } from './promptAuthor.ts';
import { errCode } from '../shared/basics.ts';

// Re-exported from its implementation on the local system: the store is always
// local, so cc's own atomic writes and the local System's are one operation.
export { writeFileAtomic };
// Re-exported from the leaves they moved to: each has many importers.
export { projectsRoot, orchStoreRoot, projectStoreDir, localWorktreesRoot, pluginsRoot, validateName, readProjectRecord, assertBackingId };
export {
  addWorkspace, ensureSelfProjectWorkspace, findSelfProject, getProject, listProjects, listWorkspaces,
  placementToken, projectsBySystem, registerProject, removeWorkspace, renameWorkspace, resolveProjectDir,
  selfProjectDir, setProjectWorkspace, summarizeWorkspaces, tryResolveProject, validateProjectRef, writeProjectMeta,
} from './projectRegistry.ts';
export type { ResolvedProject, ResolvedProjectDir, WorkspaceSummary } from './projectRegistry.ts';
export {
  adoptProject, createProject, deleteProject, getProjectForDelete, normalizeSystemPath, removeProjectStoreDir,
  setProjectRemote, validateRemoteId,
} from './projectLifecycle.ts';
export type { AdoptResult, StaleRecordAction } from './projectLifecycle.ts';


// Where a project's worktree REGISTRATIONS live. This directory is the
// authoritative list — listWorktrees enumerates it rather than asking git, so a
// registration survives a system cc cannot reach.
export function worktreesStoreRoot(projectName: string): string {
  return path.join(projectStoreDir(projectName), 'worktrees');
}

export function worktreeStoreDir(projectName: string, worktreeName: string): string {
  return path.join(worktreesStoreRoot(projectName), worktreeName);
}

// Where LOCAL places' transcripts live. A remote-backed place resolves its root
// through `transcriptRoot()` instead — this function is that expression's local
// branch, and nothing else may call it to name a remote place's directory.
//
// `CLAUDE_PROJECTS_ROOT` stays cc's own reader override (the fake CLIs in tests
// honour it); unset, cc and the CLI agree by construction.
export function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_ROOT ?? path.join(claudeConfigDir(), 'projects');
}

// ── ONE CLI CONFIG DIRECTORY PER REMOTE ─────────────────────────────────────
//
// The CLI derives its transcript directory from its own cwd, and under the FUSE
// union a remote-backed worker's cwd is the REMOTE's path spelling — so two
// projects at one absolute path on two boxes derive ONE directory. cc does not
// rename that directory; it gives each remote a config directory of its own, so
// the cwd-derived name is scoped by a root that already differs.
//
// The farm lives under the store, which `buildTierTable` already host-pins whole
// through `projectsRoot` — no tier-table entry is required to reach it.
export const CLAUDE_CONFIG_FARM_DIRNAME = 'claude-config';

export function claudeConfigFarmRoot(): string {
  return path.join(orchStoreRoot(), CLAUDE_CONFIG_FARM_DIRNAME);
}

// A path component built from an arbitrary string: the CHARACTER SET is the
// point, not the prettiness. Empty is a legitimate result and the caller drops
// it — every name still carries the digest below.
function configSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}

// The directory name for one (system, remoteId) — the machine coordinate
// `placementToken` already spells.
//
// NOT `remoteId` ITSELF. `validateRemoteId` deliberately permits `_`, `.`, `/`
// and `..` — it refuses only empty, whitespace, control characters and >128
// chars — so a raw remote id used as a directory name is a path-traversal
// hazard. The 12-hex digest carries the whole uniqueness claim; the slugs are a
// readability hint that truncation may eat down to nothing.
export function remoteConfigDirName(system: string, remoteId: string | null): string {
  const digest = createHash('sha256').update(`${system}\0${remoteId ?? ''}`).digest('hex').slice(0, 12);
  const parts = [configSlug(system), configSlug(remoteId ?? '')].filter(Boolean);
  return [...parts, digest].join('-');
}

// THE DIRECTORY `CLAUDE_CONFIG_DIR` POINTS AT for a worker on this remote.
//
// ITS LAST COMPONENT IS `.claude`, and that is load-bearing rather than
// decorative: the CLI resolves its plans directory as `<configDir>/plans`, and
// `planFileFromToolUse` (src/planFile.ts) recognises a plan file by a
// `.claude` / `plans` segment pair (either separator) — home-agnostically, so it holds for a worker
// whatever machine spelling its config dir has. Renaming this component breaks
// plan-file detection for every remote-backed session.
export function remoteConfigDir(p: { system: string; remoteId: string | null }): string {
  return path.join(claudeConfigFarmRoot(), remoteConfigDirName(p.system, p.remoteId), '.claude');
}

export function encodeCwd(abs: string): string {
  // Mirror Claude Code's own encoding: every char that isn't
  // alphanumeric or a hyphen becomes `-`. This includes underscores!
  // Keeping underscores silently breaks any project path containing
  // `_` (notably the worktree dirs we create at
  // `<project>_worktree_<id>`): the orchestrator's metadata appends
  // land at `<…>_worktree_<…>` while real claude writes the actual
  // session to `<…>-worktree-<…>`. Two separate dirs, both half-empty,
  // and resume / history-replay both broken.
  return abs.replace(/[^A-Za-z0-9-]/g, '-');
}


// WHERE A PLACE'S TRANSCRIPTS LIVE — the coordinate every transcript path is
// built from.
//
// A CWD ALONE CANNOT NAME A DIRECTORY ANY MORE. Under the FUSE union a
// remote-backed worker runs at the remote's own path spelling, so `/root/app3`
// is the same cwd on two different machines. The machine coordinate is what
// tells them apart, and it is carried here rather than re-derived, so no reader
// can accidentally resolve a remote place against the local root.
export interface TranscriptPlacement {
  system: string;
  remoteId: string | null;
  // The CLI's working directory for this place: the project's or worktree's
  // path on whatever machine it lives on.
  cwd: string;
}

// The explicit spelling of a place on THIS machine. Callers that are local by
// construction — `.conduct`, the summariser's scratch dir, a test fixture —
// say so with this rather than letting a default decide for them: a silent
// local default is precisely how a remote place would resolve against the
// wrong root.
export function localPlace(cwd: string): TranscriptPlacement {
  return { system: LOCAL_SYSTEM_ID, remoteId: null, cwd };
}

// The transcript placement of a path on the SAME machine as an already-resolved
// project or worktree. The machine coordinate comes from the project record; the
// cwd is whichever tree path the caller is asking about.
export function placeOf(p: { system: string; remoteId: string | null }, cwd: string): TranscriptPlacement {
  return { system: p.system, remoteId: p.remoteId, cwd };
}

// The transcript ROOT for a place: the directory whose `<encodeCwd(cwd)>`
// subdirectory holds its session jsonls.
//
// `encodeCwd` IS UNCHANGED FOR EVERY PLACE, local and remote — what differs is
// the root it is joined to. For a local place that root is exactly what it
// always was, which is the control tests/systems-remote-config-dir.test.mjs T5
// pins byte-identically.
export function transcriptRoot(p: TranscriptPlacement): string {
  return p.system === LOCAL_SYSTEM_ID
    ? claudeProjectsRoot()
    : path.join(remoteConfigDir(p), 'projects');
}

// THE chokepoint for a persisted transcript path. Every read, write, append, copy
// and unlink of a session jsonl resolves its path here — enforced by
// tests/session-lineage-chokepoint.test.mjs, which fails on any other
// `${…}.jsonl` construction outside this file.
export function sessionFilePath(place: TranscriptPlacement, backingId: string): string {
  assertBackingId(backingId, 'sessionFilePath');
  return path.join(transcriptRoot(place), encodeCwd(place.cwd), sessionFileName(backingId));
}

// The transcript FILENAME a backing id maps to. Split out of sessionFilePath so
// findOrphanedTranscript — which walks encoded-cwd directories it cannot decode
// back into a cwd — names the file through the same one interpolation site
// (tests/session-lineage-chokepoint.test.mjs G4).
function sessionFileName(backingId: string): string {
  return `${backingId}.jsonl`;
}

// The CLI's sibling sub-agent directory for a session — sidechain transcripts
// live at `<this dir>/subagents/agent-<agentId>.jsonl`. Keyed to the transcript,
// so it is a backing-id path under the same rule as sessionFilePath.
export function subAgentDirPath(place: TranscriptPlacement, backingId: string): string {
  assertBackingId(backingId, 'subAgentDirPath');
  return path.join(transcriptRoot(place), encodeCwd(place.cwd), backingId);
}

// Where the CLI saves a tool result too large to show inline, and the path it
// cites in that result. Beside `subagents/` in the same per-session directory.
export function toolResultsDirPath(place: TranscriptPlacement, backingId: string): string {
  return path.join(subAgentDirPath(place, backingId), 'tool-results');
}

// Resolve a caller-supplied session id to the BACKING id that names a transcript,
// or null when nothing on disk can answer to it.
//
// The lazy import is required, not stylistic: sessionLineage.ts imports
// orchStoreRoot() from this module, so a static edge here would close a cycle.
// Same pattern (and same reason) as loadWorktreesFor below. Every caller is async
// and off the hot path.
export async function resolveToBackingId(sessionId: string): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const { resolveBacking } = await import('./sessionLineage.ts');
  const backingId = await resolveBacking(sessionId);
  // Still minted-shaped after resolution ⇒ there is no lineage row, so no file is
  // named by it. Decline cleanly instead of letting sessionFilePath assert.
  return isMintedPublicId(backingId) ? null : backingId;
}

// Project a transcript FILENAME to the id a client should be handed.
//
// A row is projected to its session's PUBLIC id only when it is that session's
// CURRENT segment (or has no lineage row at all — the base case, where the two are
// the same string anyway). That is what makes the sidebar's live/on-disk
// correlation work: a live instance reports its public id, and its one
// non-archived row on disk is always `current`, so the two match again.
//
// A SUPERSEDED segment deliberately keeps its filename. Such a row exists to
// address one specific transcript — Settings → Archived restores and deletes
// individual files — and every superseded segment of a session shares one public
// id, so projecting them would collapse distinct rows onto a single ambiguous
// handle and point Delete at the live transcript instead of the archived one.
function projectRowId(filename: string, index: SessionIndex): string {
  const publicId = index.byBacking.get(filename);
  if (!publicId) return filename; // no record ⇒ public id IS the filename
  return index.byPublic.get(publicId)?.current === filename ? publicId : filename;
}

// readFirstPrompt reads FIRST_PROMPT_READ bytes, and grows the buffer (doubling)
// up to FIRST_RECORD_CAP only while the line it is on has not ended. Measured
// first-record line size over forward-first transcripts: max ≈ 192 KB.
const FIRST_PROMPT_READ = 64 * 1024;
const FIRST_RECORD_CAP = 1024 * 1024;

// The stored head (firstPromptHead) of a transcript's first user prompt; null
// when it has none, or when a record before it does not end within
// FIRST_RECORD_CAP — a later record is never taken for the first.
export async function readFirstPrompt(jsonlPath: string): Promise<string | null> {
  const fh = await fs.open(jsonlPath, 'r');
  try {
    let buf = Buffer.alloc(0);
    let eof = false;
    let pos = 0;
    for (;;) {
      let nl = buf.indexOf(0x0a, pos);
      if (nl < 0 && !eof) {
        if (buf.length >= FIRST_RECORD_CAP) return null;
        const want = Math.min(Math.max(buf.length, FIRST_PROMPT_READ), FIRST_RECORD_CAP - buf.length);
        const chunk = Buffer.alloc(want);
        const { bytesRead } = await fh.read(chunk, 0, want, buf.length);
        if (bytesRead < want) eof = true;
        buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
        continue;
      }
      if (nl < 0) {
        if (pos >= buf.length) return null;
        nl = buf.length;
      }
      const line = buf.toString('utf8', pos, nl);
      pos = nl + 1;
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj !== 'object' || obj === null) continue;
      const rec = obj as { type?: unknown; message?: unknown; lastPrompt?: unknown };
      if (rec.type === 'user' && rec.message != null) {
        const c = (rec.message as { content?: unknown }).content;
        if (typeof c === 'string') return firstPromptHead(c);
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') return firstPromptHead(block.text);
          }
        }
      }
      if (rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') {
        return firstPromptHead(stripAuthorMarker(rec.lastPrompt));
      }
    }
  } finally {
    await fh.close();
  }
}

export type { SessionRow } from '../shared/wireRows.ts';

// One directory walk answering both "which sessions are here" and "how many of
// them are archived". A caller that needs the count as well as the rows must
// use this rather than pairing listSessionsForCwd with summarizeSessions: that
// pairing costs a second readdir, a second stat of every transcript and a
// second archived-set load, for a number this walk already has in hand.
// Archived rows are counted before the includeArchived filter, so the count is
// the same either way — but their `firstPrompt` is only read when they are
// actually being listed, which is where the per-transcript cost lives.
export async function listSessionsForCwdWithCounts(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
  { includeArchived = true, deriveAwaitingFor = null }: { includeArchived?: boolean; deriveAwaitingFor?: string | null } = {},
): Promise<{ rows: SessionRow[]; archivedCount: number }> {
  const dir = path.join(transcriptRoot(place), encodeCwd(place.cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { rows: [], archivedCount: 0 };
    throw e;
  }
  // ONE store read per scanned cwd — never a file open per session.
  const index = await loadSessions();
  const { liveSegmentIdsOf } = await import('./sessionLineage.ts');
  // Same cycle as above: the scanner reads transcripts through this module.
  const { deriveAwaitingUser, chainEndingAt } = await import('./awaitingUserTranscript.ts');
  const out: SessionRow[] = [];
  let archivedCount = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    // The exclusion filter runs BEFORE the projection, deliberately: both
    // normalSessionIdsForPlace and liveBackingIdsForPlace yield backing ids, because
    // what they exclude is a FILE. Projecting first would make every set miss.
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    // Session facts come off the record; persistent/archived off this file's segment.
    const { record, segment } = fileFacts(index, sid);
    const isArchived = segment?.archived === true;
    const isConducted = record?.conducted === true;
    const full = path.join(dir, name);
    // Stat before the archived branch: the count must include only real files,
    // and it is the same stat a listed row needs anyway.
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (isArchived) {
      archivedCount++;
      if (!includeArchived) continue;
    }
    let firstPrompt: string | null = null;
    try { firstPrompt = await readFirstPrompt(full); } catch { /* ignore */ }
    const rowId = projectRowId(sid, index);
    // Cost bound: archived rows (every exited conductor, being normal) are not
    // derived in a list read unless `deriveAwaitingFor` names the row. A
    // conducted row never is — it never carries the flag, on any surface.
    let ask: Awaited<ReturnType<typeof deriveAwaitingUser>> = null;
    if (!isConducted && (!isArchived || rowId === deriveAwaitingFor)) {
      const lineageRow = rowId === sid ? null : index.byPublic.get(rowId);
      const chain = lineageRow ? chainEndingAt(liveSegmentIdsOf(lineageRow), sid) : [sid];
      try { ask = await deriveAwaitingUser(place, chain); }
      catch (e) { console.warn(`awaiting-user: scan of ${sid} failed: ${(e as Error).message}`); }
    }
    out.push({
      // The one projected field. A superseded segment's row shows its
      // session's title, conducted flag and mode, and its own persistent/archived.
      sessionId: rowId,
      firstPrompt,
      title: record?.title ?? null,
      conducted: isConducted,
      turnEndSeq: record?.turnEndSeq ?? 0,
      viewedSeq: record?.viewedSeq ?? 0,
      persistent: segment?.persistent === true,
      archived: isArchived,
      lastActivity: await lastActivityOf(full, stat),
      size: stat.size,
      resumeMode: effectiveResumeMode(record?.mode ?? null),
      awaitingUser: ask?.kind ?? null,
      awaitingUserSource: ask?.source ?? null,
    });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return { rows: out, archivedCount };
}

export async function listSessionsForCwd(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
  opts: { includeArchived?: boolean } = {},
): Promise<SessionRow[]> {
  return (await listSessionsForCwdWithCounts(place, excludeSessionIds, opts)).rows;
}

export async function listSessions(projectName: string, excludeSessionIds: Set<string> | null = null): Promise<SessionRow[]> {
  const proj = await getProject(projectName);
  return listSessionsForCwd(await projectRootPlace(projectName, proj.path), excludeSessionIds);
}

// The transcript placement of a project's OWN tree (not a worktree's): the
// record's machine coordinate, with the resolved path as the cwd. One home for
// the join, so a caller cannot pair a project's path with another's placement.
export async function projectRootPlace(projectName: string, treePath: string): Promise<TranscriptPlacement> {
  // An unregistered name has no record to read a coordinate from, and resolves
  // to cc's own machine — the same answer `resolveSystem` gives it.
  const placement = await projectPlacement(projectName);
  return placement ? placeOf(placement, treePath) : localPlace(treePath);
}

// Archive the session at the conventional path: keep the jsonl (so it
// stays resumable) and just flag its segment archived. The session's facts
// are untouched, so a restore brings the session back intact. Returns true on success, false if the
// jsonl didn't exist (404 path from the route). This is the single
// "remove from the normal list" action — it never deletes from disk.
export async function archiveSessionForCwd(place: TranscriptPlacement, sessionId: string): Promise<boolean> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return false; // unknown session — the route's 404
  const file = sessionFilePath(place, backingId);
  try {
    await fs.access(file);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
  await setSegmentArchived(backingId, true);
  return true;
}

// Permanently remove the persisted session jsonl at the conventional
// path. Returns true on success, false if the file didn't exist (404
// path from the route). This is the ONLY code path that deletes a
// session jsonl from disk; it is reachable only from the explicit
// per-session Delete on the Settings → Archived page. Caller is
// responsible for killing any running instance attached to this
// sessionId first.
export async function deleteSessionForCwd(place: TranscriptPlacement, sessionId: string): Promise<boolean> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return false; // unknown session — the route's 404
  const file = sessionFilePath(place, backingId);
  try {
    await fs.unlink(file);
    // The transcript this segment named is gone for good: tombstone the segment
    // (clearing its flags), and once no live segment is left, delete the
    // session's record with every fact on it — the only path that may.
    // Deliberately on the DELETE path, not on reads — a write inside a read path
    // races concurrent readers.
    try { const { dropSegment } = await import('./sessionLineage.ts'); await dropSegment(backingId); }
    catch { /* best-effort */ }
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
}

// The two lazy worktrees imports below sit on a circular edge
// (projects ↔ worktrees) that must stay lazy — worktrees.ts already imports
// from projects.ts (encodeCwd, etc.). The dynamic import is typed via the
// static `import type` above, so it stays lazy at runtime with no cast.
async function loadWorktreesFor(projectName: string): Promise<WorktreeMeta[]> {
  const { listWorktrees } = await import('./worktrees.ts');
  return listWorktrees(projectName);
}

// ONE PLACE a session could have run: a project or one of its worktrees, and
// the cwd it admits. A LIST rather than a string because the probe walks it, and
// because a place that cannot be located contributes an empty one.
interface SessionPlace {
  project: string;
  worktreeName: string | null;
  primary: TranscriptPlacement[];
}

// What a hit reports. `place` is the full coordinate the transcript was found
// at — a caller that goes on to READ that transcript needs it, because `cwd`
// alone no longer names a directory.
export interface SessionLocation {
  project: string;
  worktreeName: string | null;
  cwd: string;
  place: TranscriptPlacement;
}

// Look up which project (and optionally which worktree) owns a given
// sessionId, and the cwd its transcript was actually found at, by probing the
// conventional `<transcriptRoot(place)>/<encoded-cwd>/<sid>.jsonl` path against
// every place every known project + worktree admits. Returns a SessionLocation
// on hit, null when nothing matches. A worktree session whose worktree is no
// longer registered is found last, at the place its session record names
// (recordedPlace) — its `worktreeName` then names a worktree that no longer
// exists, so a caller that needs the worktree itself must still resolve it.
// `encodeCwd` is one-way (lossy: '_' and '/' both collapse to '-'), so
// we can't reverse-map a directory name back to a project — enumerating
// known paths and probing is the only correct approach.
//
// `cwd` IS THE ANSWER, not a convenience: a caller that re-derives it from the
// project's tree path lands on the OTHER MACHINE for a project on a system, and
// then reads an empty transcript. It is REQUIRED for that reason — an optional
// field invites `hit.cwd ?? proj.path`, which is precisely the bug this fixes
// It is NOT a public field: `GET /sessions/:id/locate`
// projects the body explicitly so it stays in-process.
//
// WHICH CWD A PLACE ADMITS is the same question wherever its tree is: the CLI
// runs at the place's own path, on whatever machine that is — exactly one
// candidate per place.
//
// ONE PASS: the place's own path is the primary and only candidate.
// WHAT THIS NEEDS FROM THE SYSTEM. THE ONE HOME for this contract — the sites
// that care (`src/mcp/handlers.ts`'s disk branch, `docs/components/store.md`,
// tests/systems-remote-session-location.test.mjs) point here instead of keeping
// their own copy, because two comfortable summaries are both FALSE and a third
// paraphrase is how the last two got written:
//   NOT "it never touches the box" — `loadWorktreesFor` reaches for it.
//   NOT "a box that is down cannot change what this returns" — it can.
//
// Almost every candidate cwd is computed from cc's own store and disk:
// `listProjects` (store-derived for a remote row) and `worktreePathFor` — and
// the transcripts are on cc's own disk, because the CLI is always local even
// when its cwd names another machine's tree. ONE INPUT IS NOT, the WORKTREE STORE. `loadWorktreesFor` is
// `listWorktrees`, which runs `git worktree list` THROUGH the project's system
// and then lets the answer PRUNE any registration the box no longer reports,
// while SWALLOWING the box's refusal when it cannot answer (so every
// registration lists). Consequences, both real:
//   - A DOWN box SURFACES a worktree place a HEALTHY box PRUNES. The box's git
//     answer is data this lookup consumes, and losing it changes the answer
//     rather than only costing a swallowed failure.
//   - A WEDGED box can stall this lookup up to DEFAULT_OP_TIMEOUT_MS
//     (src/systems/providerSystem.ts) — one exec per project on that box,
//     measured. Bounded, not removed.
// The lazy composition below is what keeps both off a lookup that a nearer
// place already answers.
export async function findSessionLocation(sessionId: string): Promise<SessionLocation | null> {
  // Permissive validation: sessionIds are UUIDs in practice but we accept
  // anything that's safe to interpolate into a filename. The point is to
  // reject path-traversal payloads before they touch the filesystem.
  if (!isSessionId(sessionId)) return null;
  // Resolve ONCE, here, rather than at each of the four call sites — they pass
  // mixed provenance (a conductor's public id, a REST path param, a segment id
  // off an archived row, an already-backing id from _doCreate) and this is the
  // one home that can normalise all of them.
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return null; // unknown session, not an error

  // `.conduct` is included: conductor sessions live there and must still be
  // locatable for summaries/staleness-checks/locate. It is a registered project
  // like any other now, so it is an opt-in on the listing rather than a
  // hand-rolled synthesis.
  const projects: ProjectInfo[] = await listProjects({ includeConduct: true });

  // One place, one cwd, whatever machine it is on. Under the FUSE-union geometry
  // a remote session runs at the project's real path on its system, and a remote
  // row's `path` IS that path (listProjects) — so local and remote compose
  // identically and there is no search space to enumerate any more.
  //
  // THE MACHINE COORDINATE TRAVELS WITH THE CWD. `/root/app3` is the same cwd on
  // two different boxes, so a place that carried only its path would probe one
  // remote's transcripts for another remote's session and answer with the wrong
  // project.
  const compose = async (
    proj: ProjectInfo, worktreeName: string | null, treePath: string,
  ): Promise<SessionPlace> => ({
    project: proj.name, worktreeName, primary: [placeOf(proj, treePath)],
  });

  // THE PLACE LIST IS COMPOSED LAZILY, IN PROBE ORDER, AND MEMOISED — and the
  // laziness is load-bearing rather than a micro-optimisation. Composing a
  // project's WORKTREE places calls `loadWorktreesFor` = `listWorktrees`, which
  // resolves the project and runs `git worktree list` THROUGH ITS SYSTEM: for a
  // project on a remote system that is a real `exec` over the provider wire. An
  // eager list would therefore put every registered system's responsiveness on
  // the critical path of a lookup that a nearer place already answers, so one
  // wedged provider would stall every locate, transcript read, summary and bare
  // resume up to the operation timeout. Pass 1 composes a place only when the
  // sweep reaches it, exactly as the pre-session-root probe did.
  //
  // The memo means a place is composed AT MOST ONCE per lookup, so pass 2 and
  // the read-tolerance loop do not re-walk. Nothing depends on that beyond
  // cost: pass 2 runs only when pass 1 missed everywhere, which is precisely
  // the case that has already composed every place.
  const rootMemo: Array<SessionPlace | undefined> = new Array(projects.length);
  const rootPlace = async (i: number): Promise<SessionPlace> => {
    const cached = rootMemo[i];
    if (cached) return cached;
    const proj = projects[i];
    const built = await compose(proj, null, proj.path);
    rootMemo[i] = built;
    return built;
  };
  const worktreeMemo: Array<SessionPlace[] | undefined> = new Array(projects.length);
  const worktreePlaces = async (i: number): Promise<SessionPlace[]> => {
    const cached = worktreeMemo[i];
    if (cached) return cached;
    const proj = projects[i];
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* project may not be a git repo, skip */ }
    const built: SessionPlace[] = [];
    // A worktree's offsets come from the WORKTREE's own path on the system, not
    // its project's: the two differ under a mirror root wider than the project.
    for (const wt of wts) built.push(await compose(proj, wt.worktreeName, wt.worktreePath));
    worktreeMemo[i] = built;
    return built;
  };

  const probe = async (id: string): Promise<SessionLocation | null> => {
    const holds = (at: TranscriptPlacement): Promise<boolean> => transcriptAt(at, id);
    const first = async (place: SessionPlace, ats: TranscriptPlacement[]) => {
      for (const at of ats) {
        if (await holds(at)) {
          return { project: place.project, worktreeName: place.worktreeName, cwd: at.cwd, place: at };
        }
      }
      return null;
    };
    for (let i = 0; i < projects.length; i++) {
      // The project's own place BEFORE its worktrees, so a hit at a project root
      // does not pay that project's OWN worktree walk either — the within-project
      // half of the same invariant, and the half a per-project eager build would
      // lose silently. Its observable consequence (no frame reaches that
      // project's box) is pinned by T13 in
      // tests/systems-remote-session-location.test.mjs.
      const root = await rootPlace(i);
      const atRoot = await first(root, root.primary);
      if (atRoot) return atRoot;
      for (const pl of await worktreePlaces(i)) {
        const atWt = await first(pl, pl.primary);
        if (atWt) return atWt;
      }
    }
    return null;
  };

  const hit = await probe(backingId);
  if (hit) return hit;

  // READ TOLERANCE. `current`'s transcript can vanish without going through our
  // delete path — Claude prunes its own ~/.claude/projects after ~30 days. Walk
  // the row's segments newest-first and locate the first one that still exists, so
  // a session with a surviving older segment stays findable. Read-only on purpose:
  // self-pruning here would put a write inside a hot read path and race concurrent
  // readers (the delete path and loadHistory's ENOENT branch own the pruning).
  const { publicIdFor, segmentsFor } = await import('./sessionLineage.ts');
  const publicId = await publicIdFor(sessionId);
  const segments = await segmentsFor(publicId);
  const olderIds: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const id = segments[i].id;
    if (id === backingId || isMintedPublicId(id)) continue;
    olderIds.push(id);
  }
  for (const id of olderIds) {
    const older = await probe(id);
    if (older) return older;
  }

  // RECORDED PLACE. A worktree session whose worktree is no longer registered
  // (delete_worktree removes the registration, never the transcript) is found
  // through the place its session record names — so the `worktreeName` this
  // returns may name a worktree that no longer exists. Only for a listed
  // project: a deregistered project's sessions stay unlocated.
  const rec = (await loadSessions()).byPublic.get(publicId);
  const proj = rec?.worktree ? projects.find(p => p.name === rec.project) : undefined;
  if (rec?.worktree && proj) {
    const { cwd, place } = await recordedPlace(proj, rec.worktree);
    for (const id of [backingId, ...olderIds]) {
      if (await transcriptAt(place, id)) return { project: proj.name, worktreeName: rec.worktree, cwd, place };
    }
  }
  return null;
}

// Does `place` hold `<id>.jsonl`? Any error but ENOENT throws.
async function transcriptAt(place: TranscriptPlacement, id: string): Promise<boolean> {
  try {
    return (await fs.stat(sessionFilePath(place, id))).isFile();
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
    return false;
  }
}

// Where a worktree's transcripts are, from its NAME alone: the worktree layout
// is a pure function of project + name (worktreePathFor), so this holds whether
// or not the worktree is still registered. The one home for that derivation —
// the recorded-place fallback above and the removed-worktree rows of
// listArchivedGroupedByProject both read through it.
async function recordedPlace(
  proj: ProjectInfo, worktreeName: string,
): Promise<{ cwd: string; place: TranscriptPlacement }> {
  const { worktreePathFor } = await import('./worktrees.ts');
  const cwd = worktreePathFor(proj, worktreeName);
  return { cwd, place: placeOf(proj, cwd) };
}

// Does a transcript for `sessionId` exist ANYWHERE under any transcript root cc
// knows about — the local one or any registered remote's — including under an
// encoded-cwd directory no registered project or worktree owns? Returns the
// absolute path on hit, null otherwise.
//
// Existence only — deliberately NOT a route to the content. `encodeCwd` is
// one-way (see its note above: '_' and '/' both collapse to '-'), so the
// directory name this finds cannot be reversed into the `cwd` that
// `loadPersistedTranscript` requires. A caller can therefore say "this session
// is retired and unreachable" instead of "no such session", which is all the
// distinguishability the refusal needs.
//
// Callers must reach this only AFTER findSessionLocation has already missed —
// it costs one readdir plus one stat per encoded-cwd dir, and that miss is
// itself the proof that no registered project or worktree, and no recorded
// place, owns the directory.
export async function findOrphanedTranscript(sessionId: string): Promise<string | null> {
  const backingId = await resolveToBackingId(sessionId);
  if (backingId === null) return null;
  for (const root of await transcriptRoots()) {
    let dirs: Dirent[];
    try { dirs = await fs.readdir(root, { withFileTypes: true }); }
    catch (e) { if (errCode(e) === 'ENOENT') continue; throw e; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(root, d.name, sessionFileName(backingId));
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) return file;
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

// The backing id of EVERY transcript on this machine: every `<id>.jsonl` name
// under the local root and under every farm dir ON DISK — a deregistered
// remote's transcripts included, which is why this globs the farm rather than
// asking transcriptRoots(). Names only, no `isFile`: an odd entry counts as
// present. Transcripts never live on a remote box, so no System handle is taken.
//
// THROWS rather than under-report, because the caller (src/sessionCleanup.ts)
// deletes on absence. Any read error is a throw — ENOENT included — for the local
// root and for every encoded-cwd entry that is a directory or a symlink (a
// dangling symlink is an unmounted volume, not an empty one). Tolerated: ENOENT
// on the farm root; ENOENT or ENOTDIR on a farm entry's `.claude/projects` (a
// dangling farm symlink, one to a file, or a `.claude` that is a file — none
// can hold transcripts); ENOTDIR on an encoded-cwd symlink that resolves to a
// file. Skipped by dirent: a farm-root entry that is neither a directory nor a
// symlink, and the same among the encoded dirs.
export async function transcriptIdsOnDisk(): Promise<Set<string>> {
  const suffix = '.jsonl';
  const roots = [claudeProjectsRoot()];
  const farm = claudeConfigFarmRoot();
  let farmDirs: Dirent[] = [];
  try { farmDirs = await fs.readdir(farm, { withFileTypes: true }); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
  for (const d of farmDirs) {
    if (d.isDirectory() || d.isSymbolicLink()) roots.push(path.join(farm, d.name, '.claude', 'projects'));
  }
  const ids = new Set<string>();
  for (const [i, root] of roots.entries()) {
    let dirs: Dirent[];
    try { dirs = await fs.readdir(root, { withFileTypes: true }); }
    catch (e) {
      const code = errCode(e);
      if (i > 0 && (code === 'ENOENT' || code === 'ENOTDIR')) continue;
      throw e;
    }
    for (const d of dirs) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      let names: string[];
      try { names = await fs.readdir(path.join(root, d.name)); }
      catch (e) { if (errCode(e) === 'ENOTDIR') continue; throw e; }
      for (const name of names) {
        if (name.endsWith(suffix)) ids.add(name.slice(0, -suffix.length));
      }
    }
  }
  return ids;
}

// EVERY transcript root cc knows about: the local one, plus one per registered
// remote. There is no single root any more, so the reverse scanner above has to
// be told where to look — left local-only it would answer "no such session" for
// every remote session, turning the informative SESSION_NOT_LIVE refusal into a
// bare SESSION_UNKNOWN exactly where a transcript does exist.
//
// Store reads only, like `registeredPlaces`: no System handle is taken, so a box
// being down cannot stop a refusal from being composed.
async function transcriptRoots(): Promise<string[]> {
  const roots = new Set<string>([claudeProjectsRoot()]);
  for (const proj of await listProjects()) {
    if (proj.system === LOCAL_SYSTEM_ID) continue;
    roots.add(transcriptRoot(placeOf(proj, proj.path)));
  }
  return [...roots];
}

export interface ArchivedSessionRow {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  lastActivity: number;
  size: number;
  worktreeName: string | null;
}

// List every archived session, grouped by the project (and worktree)
// that owns it — plus every session of a worktree that is no longer registered
// but that a session record still names (recordedPlace). The archived flag is on a transcript's segment, which records
// no location, so we enumerate known project + worktree paths and keep the rows
// listSessionsForCwd already flags as archived (it also reads firstPrompt
// + title). Used by the Settings → Archived page. Only projects with at
// least one listed row are returned; sessions are lastActivity-desc.
//
// DELIBERATELY passes no `excludeSessionIds`. The public-id work required that
// filter to run BEFORE the row projection wherever it is used (both exclusion sets
// yield backing ids, because what they exclude is a FILE) — but there is no filter
// to order here, and adding one would be wrong: both sets name LIVE sessions, and
// a live session's transcript is never archived (archiving force-kills
// the instance first). So the archived view has nothing to exclude, and it keeps
// the behaviour it had before this change. The row ids it reports come already
// projected from listSessionsForCwd, whose rule keeps a SUPERSEDED segment's
// filename precisely so each archived transcript stays individually addressable
// for restore/delete — see projectRowId.
export async function listArchivedGroupedByProject(): Promise<{ project: string; sessions: ArchivedSessionRow[] }[]> {
  // `.conduct` is included here so its archived normal sessions are visible in
  // Settings → Archived — the same opt-in findSessionLocation makes.
  const projects: ProjectInfo[] = await listProjects({ includeConduct: true });
  const recordedWorktrees = await recordedWorktreesByProject();

  const groups: { project: string; sessions: ArchivedSessionRow[] }[] = [];
  for (const proj of projects) {
    const sessions: ArchivedSessionRow[] = [];
    const projRows = (await listSessionsForCwd(placeOf(proj, proj.path))).filter(s => s.archived);
    for (const s of projRows) {
      sessions.push({
        sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
        lastActivity: s.lastActivity, size: s.size, worktreeName: null,
      });
    }
    let wts: WorktreeMeta[] = [];
    try { wts = await loadWorktreesFor(proj.name); } catch { /* not a git repo, skip */ }
    const places: Array<{ name: string; place: TranscriptPlacement; all: boolean }> =
      wts.map(wt => ({ name: wt.worktreeName, place: placeOf(proj, wt.worktreePath), all: false }));
    // A REMOVED worktree's sessions: every row, archived or not, since no other
    // list can show them — its place is gone from the sidebar with it.
    const listed = new Set(wts.map(wt => wt.worktreeName));
    for (const name of recordedWorktrees.get(proj.name) ?? []) {
      if (!listed.has(name)) places.push({ name, place: (await recordedPlace(proj, name)).place, all: true });
    }
    for (const { name, place, all } of places) {
      const wtRows = (await listSessionsForCwd(place)).filter(s => all || s.archived);
      for (const s of wtRows) {
        sessions.push({
          sessionId: s.sessionId, title: s.title, firstPrompt: s.firstPrompt,
          lastActivity: s.lastActivity, size: s.size, worktreeName: name,
        });
      }
    }
    if (sessions.length > 0) {
      sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      groups.push({ project: proj.name, sessions });
    }
  }
  return groups;
}

// Where `sessionId`'s transcripts are when its record places it in worktree
// `worktreeName` of listed project `projectName` — the place a removed
// worktree's Settings → Archived row addresses. Null when the record names any
// other place, or none.
export async function recordedSessionPlace(
  projectName: string, worktreeName: string, sessionId: string,
): Promise<TranscriptPlacement | null> {
  const { publicIdFor } = await import('./sessionLineage.ts');
  const rec = (await loadSessions()).byPublic.get(await publicIdFor(sessionId));
  if (rec?.project !== projectName || rec.worktree !== worktreeName) return null;
  const proj = (await listProjects({ includeConduct: true })).find(p => p.name === projectName);
  return proj ? (await recordedPlace(proj, worktreeName)).place : null;
}

// project name → the distinct worktree names session records place a session
// in (setSessionPlace). Store reads only.
async function recordedWorktreesByProject(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const rec of (await loadSessions()).byPublic.values()) {
    if (!rec.project || !rec.worktree) continue;
    let names = out.get(rec.project);
    if (!names) out.set(rec.project, names = new Set());
    names.add(rec.worktree);
  }
  return out;
}

// Lightweight session summary — used by /api/projects to show a count +
// "last active" stamp in the sidebar without paying the firstPrompt read
// listSessionsForCwd does on every jsonl.
//
// It reports the SAME recency value as the session rows underneath it, so a
// project's "last N ago" can't disagree with its own sessions. That costs a
// bounded tail read per transcript, but only on a transcript that changed
// since the last walk (lastActivityOf memoizes on the stat this loop already
// does) — so the steady-state fan-out across every project stays readdir +
// stat, which is the property this walk has always been protecting.
//
// `handCount` is the non-conducted subset of `count` — what the sidebar's
// Hand-spawned only filter reads to decide whether a place holds a session it
// would list, before any Sessions subnode has loaded its rows. It rides the one
// session-store read per walk, not a read per transcript.
export async function summarizeSessions(
  place: TranscriptPlacement,
  excludeSessionIds: Set<string> | null = null,
): Promise<SessionCounts> {
  const dir = path.join(transcriptRoot(place), encodeCwd(place.cwd));
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch (e) { if (errCode(e) === 'ENOENT') return { count: 0, archivedCount: 0, handCount: 0, lastActivity: 0 }; throw e; }
  const index = await loadSessions();
  let count = 0;
  let archivedCount = 0;
  let handCount = 0;
  let lastActivity = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    if (excludeSessionIds && excludeSessionIds.has(sid)) continue;
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const { record, segment } = fileFacts(index, sid);
    if (segment?.archived) {
      archivedCount++;
    } else {
      count++;
      if (!record?.conducted) handCount++;
      const ts = await lastActivityOf(full, stat);
      if (ts > lastActivity) lastActivity = ts;
    }
  }
  return { count, archivedCount, handCount, lastActivity };
}

