// THE session store: one global file, `<store>/sessions.json`, keyed by a
// session's PERMANENT public id. It holds every fact cc records about a session:
//
//   { "sessions": { "<publicId>": {
//       "current":  "<backingId>",
//       "segments": [ { "id", "reason", "at", "dropped"?, "temp"?, "archived"? } ],
//       "title"?, "mode"?, "backend"?: {backend, model, contextWindowTokens},
//       "summaries"?: { <tier>: {summary, generatedAt, messageCount} },
//       "conducted"?, "turnEndSeq"?, "viewedSeq"?, "parent"?, "project"?,
//       "worktree"? } } }
//
// Two kinds of fact, and the split is the point of the shape:
//   - SESSION facts (title, mode, backend, summaries, conducted, the turn marks,
//     parent, project, worktree) sit on the record. A rotation moves only `current`, so nothing
//     has to carry them from one transcript to the next.
//   - TRANSCRIPT facts (temp, archived) sit on the segment they describe: each
//     segment is one jsonl, and each jsonl is one listing row.
// Every optional field is present only when set — `true`, a non-empty value, or
// a positive count — and the parser keeps a flag only when it is `=== true`.
//
// The segment chain's identity rules (mint, rotation, tombstones, the BASE CASE)
// belong to src/sessionLineage.ts, which runs over `mutateSessions` and
// `loadSessions` below. RECORD INVARIANT, kept by every mutation: a persisted
// record has at least one live (non-dropped) segment and `current` is live; a
// mutation that would leave none deletes the record — and with it every session
// fact. Only the explicit session delete may do that. The one other deleter,
// removeSessionRecords (run at boot by src/sessionCleanup.ts), removes whole
// records whose lineage has no transcript left, never a segment.
//
// RESOLUTION.
//   - Readers resolve a public key first, then a LIVE segment's owner. Unknown
//     means no facts.
//   - Session-level writers (ensureRecord) resolve a public key, then ANY segment
//     of the full chain (tombstones too, so a write never forks a second record
//     for a known id). An unknown MINTED-shaped id (isMintedPublicId) is refused
//     — it can only be a public id whose record is gone. Anything else unknown is
//     the base case: a record `{current: id, segments: [{id, 'initial'}]}` is
//     created, exactly the lazy promotion recordRotation does.
//   - Segment-level writers (ensureSegment) take a backing id and an optional
//     `owner`. A known segment wins, but a dropped one is refused. An `owner`
//     whose record exists WITHOUT this segment is refused: the rotation write
//     that would add it has not landed (or failed), and the next per-turn write
//     retries. A minted-shaped id is refused; anything else is the base case.
//
// WRITES: mutateSessions = serialize → [precheck] → withLock → strict re-read →
// apply → write → `.bak` refresh → cache.
//   - serialize: one per-process chain for every writer, lineage included. It is
//     a contention guard (withLock already excludes a same-process second
//     caller, but by burning its bounded retries).
//   - precheck: runs INSIDE serialize (so it sees every earlier same-process
//     write) against the cached doc, and returns without locking or writing when
//     nothing would change. The per-turn mode/temp/conducted writes cost one
//     `stat` each in steady state.
//   - withLock (src/storeLock.ts): the cross-process correctness guard. The
//     contended window is a hot restart, where the exiting and booting servers
//     both write.
//   - a failure anywhere in the locked half is logged HERE, once, then rethrown,
//     and the cache is left alone — so the next per-turn call's precheck still
//     sees the old value and retries. Fire-and-forget callers keep their
//     `.catch(() => {})`; the failure is no longer silent.
//
// READS go through a stat-validated cache: the last doc read or written, with
// the file's `{ino, size, mtimeNs, ctimeNs}`. A read whose stat matches serves
// the cache; any other re-reads. Residual: another process rewriting the file
// in place to the same size within the same nanosecond stamps, on the same
// inode — a rename (every cc writer) changes ctime, so only a non-cc in-place
// writer can reach it.
//
// RECOVERY: a rolling `<file>.bak`, refreshed inside the lock after each write.
// A lenient read serves `.bak` when the primary is missing or corrupt; the strict
// in-mutation read quarantines a corrupt primary to `.corrupt-<pid>-<ts>` and
// recovers from `.bak`; absent primary AND absent `.bak` is legitimately empty;
// any other I/O error aborts the mutation. The file is ALWAYS written, never
// unlinked — an empty store is `{"sessions":{}}` — so an absent primary always
// means external loss.
// The `.bak` refresh is skipped when a write would drop the record count or the
// archived-segment count by more than one against the current `.bak`: no single
// mutation removes more than one of either, so such a write is a wrongly-small
// base (a leaked or blipped read), and canonizing it would lose the rest.
//
// READ BARRIER (kick-anchored). Two lineage writes are kicked fire-and-forget
// onto an instance's `_lineageWrite` chain (Instance._kickLineageWrite: the
// rotation seen in `system/init`, and dropSegment on a missing-transcript
// replay), and registered here by trackLineageWrite. `loadSessions` — the
// chokepoint every async reader funnels through — awaits one snapshot of that
// set, so a read never serves the pre-rotation record. Segment-level writers
// await it too before resolving, so a per-turn `setSegmentTemp(newId)` after a
// typed `/clear` lands on the recorded segment rather than forking a base-case
// record. Session-level writers don't need it: the public id doesn't move.
// DEADLOCK RULE: nothing reachable from a kicked write (recordRotation,
// retireSegment, dropSegment) may await the barrier, and every mutation re-reads
// with the strict loader, never `loadSessions` — or it waits on itself.
// A rejected kicked write is swallowed by the barrier (its failure has an owner:
// Instance._lineageError → flushLineage). `mintPublicId` is awaited in launch()
// and deliberately untracked; a read racing a fresh spawn just misses the new
// record, which is the base case. The spawn-time facts (temp, backend,
// conducted, mode) are likewise untracked: launch() awaits them, so a read
// ordered after an awaited launch() caller sees them, and a read racing an
// in-flight launch may miss them. Each such write takes the store lock on its
// own and spends its own LOCK_RETRY_MAX budget, so a lock held by another
// process delays launch() by up to the sum over the writes the spawn issued.
//
// TEARDOWN DRAIN: settleSessionWrites waits out both the serialize chain and
// the barrier set, looping until neither moves. Only once the writers have
// stopped; it is the barrier's one exception to the one-snapshot rule.
//
// SYNC READ: loadSessionsSync, for the restart path, which stays synchronous up
// to process.exit(). It never consults the cache or the barrier.
//
// Growth is bounded only by the two deleters: every session ever recorded keeps
// its record until it is explicitly deleted or the boot cleanup finds no
// transcript left anywhere in its lineage.

import { promises as fs, readFileSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic, isMintedPublicId } from './projects.ts';
import { withLock } from './storeLock.ts';
import { MODES } from './sessionModes.ts';
import { normalizeTitle } from './sessionTitles.ts';
import { normalizeSummaryTiers, normalizeTierRecord, SUMMARY_LENGTHS, type SummaryTiers, type TierRecord } from './sessionSummaries.ts';

export type RotationReason = 'initial' | 'renew' | 'prune';
export const VALID_REASONS: ReadonlySet<RotationReason> = new Set<RotationReason>(['initial', 'renew', 'prune']);

export interface Segment {
  id: string;
  reason: RotationReason;
  at: string;
  dropped?: true;
  temp?: true;
  archived?: true;
}

export interface SessionBackendRecord {
  backend: string;
  model: string | null;
  contextWindowTokens: number | null;
}

// One restart model switch (Instance.switchModel), success or failure. The
// session's transcript divider: replayPersistedText splices it into every replay
// of `segment` right after the jsonl line whose `uuid` is `afterUuid` (null =
// before the first line).
export interface ModelSwitchEntry {
  id: string;
  at: string;
  segment: string;
  afterUuid: string | null;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  // A failure that was the user's Terminate landing mid-switch, not the model's.
  cancelled?: true;
}

export interface SessionRecord {
  current: string;
  // The full chain, tombstones included, oldest first.
  segments: Segment[];
  title?: string;
  mode?: string;
  backend?: SessionBackendRecord;
  summaries?: SummaryTiers;
  conducted?: true;
  // The turn marks: how many turn ends the session has had, and the turnEndSeq
  // the human last saw. Absent means 0; unread ⇔ turnEndSeq > viewedSeq.
  turnEndSeq?: number;
  viewedSeq?: number;
  // The caller's public id when a conductor spawned this session.
  parent?: string;
  project?: string;
  // The worktree NAME (WorktreeMeta.worktreeName), absent for a project root.
  worktree?: string;
  // Oldest first. Absent means none.
  modelSwitches?: ModelSwitchEntry[];
}

// publicId → record. The only persisted structure.
export type SessionsDoc = Map<string, SessionRecord>;

export interface SessionIndex {
  byPublic: SessionsDoc;
  // LIVE segment id → the public id that owns it. Built at load, never persisted.
  byBacking: Map<string, string>;
}

export function sessionsFile(): string {
  return path.join(orchStoreRoot(), 'sessions.json');
}

function backupFile(): string {
  return sessionsFile() + '.bak';
}

// ── doc model ────────────────────────────────────────────────────────────────

export function liveSegments(rec: SessionRecord): Segment[] {
  return rec.segments.filter(s => !s.dropped);
}

function parseBackend(raw: unknown): SessionBackendRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { backend?: unknown; model?: unknown; contextWindowTokens?: unknown };
  if (typeof r.backend !== 'string' || !r.backend) return null;
  return {
    backend: r.backend,
    model: typeof r.model === 'string' && r.model ? r.model : null,
    contextWindowTokens: typeof r.contextWindowTokens === 'number' && Number.isFinite(r.contextWindowTokens)
      ? r.contextWindowTokens : null,
  };
}

function parseModelSwitch(raw: unknown): ModelSwitchEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = nonEmpty(r.id), segment = nonEmpty(r.segment), from = nonEmpty(r.from), to = nonEmpty(r.to);
  if (!id || !segment || !from || !to || typeof r.ok !== 'boolean') return null;
  if (r.afterUuid !== null && !nonEmpty(r.afterUuid)) return null;
  return {
    id, at: typeof r.at === 'string' ? r.at : '', segment,
    afterUuid: (r.afterUuid as string | null), from, to, ok: r.ok,
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
    ...(r.cancelled === true ? { cancelled: true as const } : {}),
  };
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// A count field: a positive integer, or nothing (0 reads as absent).
function count(v: unknown): number | undefined {
  return Number.isInteger(v) && (v as number) > 0 ? v as number : undefined;
}

// JSON.parse output → the doc. The untyped on-disk boundary, so every field is
// validated: a malformed segment is dropped, a malformed fact is dropped, and a
// record left with no live segment is dropped.
export function parseSessionsDoc(obj: unknown): SessionsDoc {
  const out: SessionsDoc = new Map();
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return out;
  const sessions = (obj as { sessions?: unknown }).sessions;
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return out;
  for (const [publicId, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!publicId || typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.current !== 'string' || !v.current || !Array.isArray(v.segments)) continue;
    const segments: Segment[] = [];
    for (const seg of v.segments) {
      if (typeof seg !== 'object' || seg === null) continue;
      const s = seg as Record<string, unknown>;
      if (typeof s.id !== 'string' || !s.id) continue;
      if (typeof s.reason !== 'string' || !VALID_REASONS.has(s.reason as RotationReason)) continue;
      segments.push({
        id: s.id, reason: s.reason as RotationReason, at: typeof s.at === 'string' ? s.at : '',
        ...(s.dropped === true ? { dropped: true as const } : {}),
        ...(s.temp === true ? { temp: true as const } : {}),
        ...(s.archived === true ? { archived: true as const } : {}),
      });
    }
    const rec: SessionRecord = { current: v.current, segments };
    if (liveSegments(rec).length === 0) continue;
    const title = typeof v.title === 'string' ? normalizeTitle(v.title) : '';
    if (title) rec.title = title;
    if (typeof v.mode === 'string' && (MODES as readonly string[]).includes(v.mode)) rec.mode = v.mode;
    const backend = parseBackend(v.backend);
    if (backend) rec.backend = backend;
    const summaries = normalizeSummaryTiers(v.summaries);
    if (summaries) rec.summaries = summaries;
    if (v.conducted === true) rec.conducted = true;
    const turnEndSeq = count(v.turnEndSeq); if (turnEndSeq) rec.turnEndSeq = turnEndSeq;
    const viewedSeq = count(v.viewedSeq); if (viewedSeq) rec.viewedSeq = viewedSeq;
    const parent = nonEmpty(v.parent); if (parent) rec.parent = parent;
    const project = nonEmpty(v.project); if (project) rec.project = project;
    const worktree = nonEmpty(v.worktree); if (worktree) rec.worktree = worktree;
    if (Array.isArray(v.modelSwitches)) {
      const switches = v.modelSwitches.map(parseModelSwitch).filter((e): e is ModelSwitchEntry => e !== null);
      if (switches.length) rec.modelSwitches = switches;
    }
    out.set(publicId, rec);
  }
  return out;
}

// Doc → the persisted JSON, keys sorted, each record's fields in one fixed order.
export function serializeSessionsDoc(doc: SessionsDoc): string {
  const sessions: Record<string, unknown> = {};
  for (const key of [...doc.keys()].sort((a, b) => a.localeCompare(b))) {
    const r = doc.get(key) as SessionRecord;
    sessions[key] = {
      current: r.current,
      segments: r.segments.map(s => ({
        id: s.id, reason: s.reason, at: s.at,
        ...(s.dropped ? { dropped: true } : {}),
        ...(s.temp ? { temp: true } : {}),
        ...(s.archived ? { archived: true } : {}),
      })),
      ...(r.title ? { title: r.title } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(r.backend ? { backend: r.backend } : {}),
      ...(r.summaries && Object.keys(r.summaries).length ? { summaries: r.summaries } : {}),
      ...(r.conducted ? { conducted: true } : {}),
      ...(r.turnEndSeq ? { turnEndSeq: r.turnEndSeq } : {}),
      ...(r.viewedSeq ? { viewedSeq: r.viewedSeq } : {}),
      ...(r.parent ? { parent: r.parent } : {}),
      ...(r.project ? { project: r.project } : {}),
      ...(r.worktree ? { worktree: r.worktree } : {}),
      ...(r.modelSwitches?.length ? { modelSwitches: r.modelSwitches.map(e => ({
        id: e.id, at: e.at, segment: e.segment, afterUuid: e.afterUuid, from: e.from, to: e.to, ok: e.ok,
        ...(e.error ? { error: e.error } : {}),
        ...(e.cancelled ? { cancelled: true } : {}),
      })) } : {}),
    };
  }
  return JSON.stringify({ sessions }, null, 2) + '\n';
}

export function indexSessions(doc: SessionsDoc): SessionIndex {
  const byBacking = new Map<string, string>();
  for (const [publicId, rec] of doc) {
    for (const seg of liveSegments(rec)) byBacking.set(seg.id, publicId);
  }
  return { byPublic: doc, byBacking };
}

// ── resolution ───────────────────────────────────────────────────────────────

// Reader rule: a public key, then a LIVE segment's owner.
export function resolveOwner(index: SessionIndex, id: string): string | null {
  if (index.byPublic.has(id)) return id;
  return index.byBacking.get(id) ?? null;
}

function recordFor(index: SessionIndex, id: string): SessionRecord | null {
  const owner = resolveOwner(index, id);
  return owner === null ? null : index.byPublic.get(owner) ?? null;
}

// The owner of `id` over the FULL chain, tombstones included.
function fullChainOwner(doc: SessionsDoc, id: string): string | null {
  for (const [publicId, rec] of doc) {
    if (rec.segments.some(s => s.id === id)) return publicId;
  }
  return null;
}

function baseCaseRecord(id: string): SessionRecord {
  return { current: id, segments: [{ id, reason: 'initial', at: new Date().toISOString() }] };
}

// Session-level write target, or a refusal reason. `create:false` resolves
// without creating (the precheck's pure lookup).
export function ensureRecord(
  doc: SessionsDoc, id: string, { create = true }: { create?: boolean } = {},
): { publicId: string; record: SessionRecord } | { refused: string } | null {
  const direct = doc.get(id);
  if (direct) return { publicId: id, record: direct };
  const owner = fullChainOwner(doc, id);
  if (owner !== null) return { publicId: owner, record: doc.get(owner) as SessionRecord };
  if (isMintedPublicId(id)) return { refused: 'unknown public id' };
  if (!create) return null;
  const record = baseCaseRecord(id);
  doc.set(id, record);
  return { publicId: id, record };
}

// Segment-level write target, or a refusal reason. `create:false` as above.
export function ensureSegment(
  doc: SessionsDoc, backingId: string, { owner, create = true }: { owner?: string | null; create?: boolean } = {},
): { publicId: string; record: SessionRecord; segment: Segment } | { refused: string } | null {
  const known = fullChainOwner(doc, backingId);
  if (known !== null) {
    const record = doc.get(known) as SessionRecord;
    const segment = record.segments.find(s => s.id === backingId) as Segment;
    if (segment.dropped) return { refused: 'segment is dropped' };
    return { publicId: known, record, segment };
  }
  if (owner && doc.has(owner)) return { refused: `record ${owner} does not hold this segment yet` };
  if (isMintedPublicId(backingId)) return { refused: 'minted-shaped id is not a transcript' };
  if (!create) return null;
  const record = baseCaseRecord(backingId);
  doc.set(backingId, record);
  return { publicId: backingId, record, segment: record.segments[0] };
}

function warnRefused(op: string, id: string, reason: string): void {
  console.warn(`sessionStore: ${op} ${id} refused: ${reason}`);
}

// A transcript FILENAME's facts: its owning session (public id), that session's
// record, and the segment the file is. Unknown file → no record, no segment,
// and its public id is the filename itself (the base case).
export function fileFacts(index: SessionIndex, filename: string): {
  publicId: string; record: SessionRecord | null; segment: Segment | null;
} {
  const owner = index.byBacking.get(filename);
  if (!owner) return { publicId: filename, record: null, segment: null };
  const record = index.byPublic.get(owner) as SessionRecord;
  return { publicId: owner, record, segment: record.segments.find(s => s.id === filename && !s.dropped) ?? null };
}

// ── read barrier ─────────────────────────────────────────────────────────────

const inFlightWrites = new Set<Promise<unknown>>();

export function trackLineageWrite(p: Promise<unknown>): void {
  const tracked = p.then(() => {}, () => {});
  inFlightWrites.add(tracked);
  // DELIBERATELY UNPINNED — shedding a settled entry is a MEMORY property:
  // Promise.all over settled promises still resolves in a microtask, so a set
  // that never shrinks reads identically. Review is the only guard.
  void tracked.then(() => { inFlightWrites.delete(tracked); });
}

// ONE snapshot, not a drain loop: a read sees every write kicked BEFORE it
// began. A loop would starve under a steady write stream.
async function awaitKickedWrites(): Promise<void> {
  await Promise.all([...inFlightWrites]);
}

// ── reads ────────────────────────────────────────────────────────────────────

interface CacheEntry { file: string; sig: string; doc: SessionsDoc }
let cache: CacheEntry | null = null;

function sigOf(st: BigIntStats): string {
  return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

// The PRIMARY only: its doc (from the cache when the stat matches), or why it
// could not be read. Never touches `.bak`.
async function readPrimary(): Promise<{ doc: SessionsDoc } | { error: unknown; missing: boolean }> {
  const file = sessionsFile();
  let st: BigIntStats;
  try { st = await fs.stat(file, { bigint: true }); }
  catch (e) { return { error: e, missing: errCode(e) === 'ENOENT' }; }
  const sig = sigOf(st);
  if (cache && cache.file === file && cache.sig === sig) return { doc: cache.doc };
  let doc: SessionsDoc;
  try { doc = parseSessionsDoc(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (e) { return { error: e, missing: errCode(e) === 'ENOENT' }; }
  cache = { file, sig, doc };
  return { doc };
}

async function readBackupLenient(): Promise<SessionsDoc> {
  try { return parseSessionsDoc(JSON.parse(await fs.readFile(backupFile(), 'utf8'))); }
  catch { return new Map(); }
}

async function loadLenient(): Promise<SessionsDoc> {
  const r = await readPrimary();
  if ('doc' in r) return r.doc;
  if (!r.missing) {
    // Not under the lock, so nothing is quarantined here — the next mutation does it.
    console.warn(`sessionStore: failed to read ${sessionsFile()}: ${errMsg(r.error)}; serving the backup`);
  }
  return readBackupLenient();
}

// Every async reader's entry point. The returned doc is shared with the cache:
// read it, never mutate it.
export async function loadSessions(): Promise<SessionIndex> {
  await awaitKickedWrites();
  return indexSessions(await loadLenient());
}

// Sync twin for the restart path. Falls back to `.bak` on a missing or corrupt
// primary; never consults the barrier or the cache.
export function loadSessionsSync(): SessionIndex {
  const read = (file: string): SessionsDoc => parseSessionsDoc(JSON.parse(readFileSync(file, 'utf8')));
  try { return indexSessions(read(sessionsFile())); }
  catch (e) {
    if (errCode(e) !== 'ENOENT') console.warn(`sessionStore: failed to read ${sessionsFile()}: ${errMsg(e)}; serving the backup`);
  }
  try { return indexSessions(read(backupFile())); }
  catch { return indexSessions(new Map()); }
}

// ── writes ───────────────────────────────────────────────────────────────────

async function quarantine(file: string): Promise<void> {
  const dest = `${file}.corrupt-${process.pid}-${Date.now()}`;
  try { await fs.rename(file, dest); } catch { /* best-effort */ }
}

async function recoverBackupStrict(): Promise<SessionsDoc> {
  let raw: string;
  try { raw = await fs.readFile(backupFile(), 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return new Map(); // no backup → legitimately empty
    throw e;
  }
  try { return parseSessionsDoc(JSON.parse(raw)); }
  catch {
    await quarantine(backupFile()); // backup corrupt too → set aside, start clean
    return new Map();
  }
}

// The canonical read INSIDE the lock. Never the cache: anything read before
// acquiring the lock is already stale.
async function loadStrict(): Promise<SessionsDoc> {
  let raw: string;
  try { raw = await fs.readFile(sessionsFile(), 'utf8'); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return recoverBackupStrict();
    throw e; // an I/O error must never be laundered into "empty"
  }
  try { return parseSessionsDoc(JSON.parse(raw)); }
  catch {
    await quarantine(sessionsFile());
    return recoverBackupStrict();
  }
}

function archivedCount(doc: SessionsDoc): number {
  let n = 0;
  for (const rec of doc.values()) for (const s of rec.segments) if (s.archived) n++;
  return n;
}

// Refresh `.bak` unless this write drops more than one record or more than one
// archived segment relative to it, beyond `expectedDrop` — what a bulk removal
// (removeSessionRecords) says it removed on purpose. Absent or corrupt `.bak` →
// write it; an unreadable one is left alone.
async function refreshBackup(
  doc: SessionsDoc, json: string, expectedDrop: { records: number; archived: number } = { records: 0, archived: 0 },
): Promise<void> {
  let bak: SessionsDoc | null = null;
  try { bak = parseSessionsDoc(JSON.parse(await fs.readFile(backupFile(), 'utf8'))); }
  catch (e) {
    const code = errCode(e);
    if (code !== undefined && code !== 'ENOENT') return;
  }
  if (bak && (bak.size - doc.size > 1 + expectedDrop.records
    || archivedCount(bak) - archivedCount(doc) > 1 + expectedDrop.archived)) return;
  await writeFileAtomic(backupFile(), json);
}

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<R>(fn: () => Promise<R>): Promise<R> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

// TEARDOWN DRAIN: resolves once every write already issued — serialized or
// still parked on the read barrier — has landed. The store resolves its file
// when a write RUNS, so a caller about to retarget PROJECTS_ROOT drains first
// or its writes land in the next root. Loops (unlike awaitKickedWrites)
// because a landed write's continuation may issue the next one; that is safe
// only once nothing kicks new writes. Never reachable
// from a kicked write — it would wait on itself.
export async function settleSessionWrites(): Promise<void> {
  for (;;) {
    const tail = writeChain;
    await Promise.all([tail, ...inFlightWrites]);
    await new Promise<void>(r => setImmediate(r));
    if (writeChain === tail && inFlightWrites.size === 0) return;
  }
}

export type Apply<R> = (doc: SessionsDoc) => { changed: boolean; value: R };
// Non-null ⇒ nothing would change; its value is the call's result.
export type Precheck<R> = (doc: SessionsDoc) => { value: R } | null;

// THE write path. `op`/`id` label the one failure log line.
export function mutateSessions<R>(op: string, id: string, apply: Apply<R>, precheck?: Precheck<R>): Promise<R> {
  return serialize(async () => {
    if (precheck) {
      const r = await readPrimary();
      if ('doc' in r) {
        const hit = precheck(r.doc);
        if (hit) return hit.value;
      }
    }
    const file = sessionsFile();
    try {
      return await withLock(file, async () => {
        const doc = await loadStrict();
        const { changed, value } = apply(doc);
        if (!changed) return value;
        const json = serializeSessionsDoc(doc);
        await writeFileAtomic(file, json);
        await refreshBackup(doc, json);
        cache = { file, sig: sigOf(await fs.stat(file, { bigint: true })), doc };
        return value;
      });
    } catch (e) {
      console.warn(`sessionStore: ${op} ${id} failed: ${errMsg(e)}`);
      throw e;
    }
  });
}

// THE SECOND DELETER (beside the explicit session delete): remove whole records
// in one write. `pick` sees the parsed doc under the lock and names the public
// ids to remove. Before anything else, the primary's raw bytes are written to
// `snapshotFile` — every call, overwriting the last one, whether or not
// anything is removed — and a failed snapshot throws before the store changes.
// An absent primary is skipped with no snapshot; a corrupt one is snapshotted
// and skipped, left for the next ordinary mutation's loadStrict to quarantine.
export function removeSessionRecords(
  pick: (doc: SessionsDoc) => string[], { snapshotFile }: { snapshotFile: string },
): Promise<{ removed: string[]; skipped?: string }> {
  return serialize(async () => {
    const file = sessionsFile();
    return withLock(file, async () => {
      let raw: Buffer;
      try { raw = await fs.readFile(file); }
      catch (e) {
        if (errCode(e) === 'ENOENT') {
          console.warn(`sessionStore: removeSessionRecords: ${file} is absent; skipped`);
          return { removed: [], skipped: 'store absent' };
        }
        console.warn(`sessionStore: removeSessionRecords: failed to read ${file}: ${errMsg(e)}`);
        throw e;
      }
      await writeFileAtomic(snapshotFile, raw);
      let doc: SessionsDoc;
      try { doc = parseSessionsDoc(JSON.parse(raw.toString('utf8'))); }
      catch (e) {
        console.warn(`sessionStore: removeSessionRecords: ${file} is corrupt (${errMsg(e)}); skipped`);
        return { removed: [], skipped: 'store corrupt' };
      }
      const removed = [...new Set(pick(doc))].filter(id => doc.has(id));
      if (removed.length === 0) return { removed };
      let archived = 0;
      for (const id of removed) {
        for (const s of (doc.get(id) as SessionRecord).segments) if (s.archived) archived++;
        doc.delete(id);
      }
      const json = serializeSessionsDoc(doc);
      await writeFileAtomic(file, json);
      await refreshBackup(doc, json, { records: removed.length, archived });
      cache = { file, sig: sigOf(await fs.stat(file, { bigint: true })), doc };
      return { removed };
    });
  });
}

// ── session-level facts ──────────────────────────────────────────────────────

// Shared shape of a session-level upsert: resolve (creating the base case),
// compare, set. `same` decides the no-op; `set` writes the value.
function sessionWrite<R>(
  op: string, id: string, refusedValue: R,
  same: (rec: SessionRecord) => boolean, set: (rec: SessionRecord) => R, current: (rec: SessionRecord) => R,
): Promise<R> {
  return mutateSessions(op, id, (doc) => {
    const hit = ensureRecord(doc, id);
    if (hit === null || 'refused' in hit) {
      warnRefused(op, id, hit ? hit.refused : 'unresolvable');
      return { changed: false, value: refusedValue };
    }
    if (same(hit.record)) return { changed: false, value: current(hit.record) };
    return { changed: true, value: set(hit.record) };
  }, (doc) => {
    const hit = ensureRecord(doc, id, { create: false });
    return hit && !('refused' in hit) && same(hit.record) ? { value: current(hit.record) } : null;
  });
}

export async function getTitle(id: string): Promise<string | null> {
  if (typeof id !== 'string' || !id) return null;
  return recordFor(await loadSessions(), id)?.title ?? null;
}

// Empty/whitespace clears the title; otherwise trimmed and capped (normalizeTitle).
export function setTitle(id: string, title: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !id) return Promise.resolve(null);
  const v = normalizeTitle(title) || undefined;
  return sessionWrite('setTitle', id, null,
    rec => rec.title === v,
    rec => { if (v) rec.title = v; else delete rec.title; return v ?? null; },
    rec => rec.title ?? null);
}

// The recorded mode, or null when never recorded (effectiveResumeMode resolves it).
export async function getSessionMode(id: string | undefined): Promise<string | null> {
  if (typeof id !== 'string' || !id) return null;
  return recordFor(await loadSessions(), id)?.mode ?? null;
}

export function setSessionMode(id: string | null | undefined, mode: string | undefined): Promise<boolean> {
  if (typeof id !== 'string' || !id) return Promise.resolve(false);
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return Promise.resolve(false);
  return sessionWrite('setSessionMode', id, false,
    rec => rec.mode === mode, rec => { rec.mode = mode; return true; }, () => true);
}

// The backend a session runs on and its EXACT launch model, or null for a plain
// `claude` session (absence = 'claude').
export async function getSessionBackend(id: string | undefined): Promise<SessionBackendRecord | null> {
  if (typeof id !== 'string' || !id) return null;
  return recordFor(await loadSessions(), id)?.backend ?? null;
}

export function setSessionBackend(
  id: string | null | undefined, backend: string | undefined,
  model: string | null = null, contextWindowTokens: number | null = null,
): Promise<boolean> {
  if (typeof id !== 'string' || !id) return Promise.resolve(false);
  if (typeof backend !== 'string' || !backend) return Promise.resolve(false);
  const value: SessionBackendRecord = {
    backend,
    model: typeof model === 'string' && model ? model : null,
    contextWindowTokens: typeof contextWindowTokens === 'number' && Number.isFinite(contextWindowTokens)
      ? contextWindowTokens : null,
  };
  return sessionWrite('setSessionBackend', id, false,
    rec => rec.backend?.backend === value.backend && rec.backend.model === value.model
      && rec.backend.contextWindowTokens === value.contextWindowTokens,
    rec => { rec.backend = value; return true; }, () => true);
}

export async function isConducted(id: string): Promise<boolean> {
  if (typeof id !== 'string' || !id) return false;
  return recordFor(await loadSessions(), id)?.conducted === true;
}

// Mark conducted and patch the spawn-time facts. A null/absent extra is left as
// recorded, never cleared.
export function markConducted(
  id: string | null | undefined,
  extras: { parent?: string | null; project?: string | null; worktree?: string | null } = {},
): Promise<boolean> {
  if (typeof id !== 'string' || !id) return Promise.resolve(false);
  const patch: Partial<Pick<SessionRecord, 'parent' | 'project' | 'worktree'>> = {};
  if (extras.parent) patch.parent = extras.parent;
  if (extras.project) patch.project = extras.project;
  if (extras.worktree) patch.worktree = extras.worktree;
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  return sessionWrite('markConducted', id, false,
    rec => rec.conducted === true && keys.every(k => rec[k] === patch[k]),
    rec => { rec.conducted = true; Object.assign(rec, patch); return true; }, () => true);
}

// Append one model-switch ledger entry to the session's record.
export function appendModelSwitch(id: string, entry: ModelSwitchEntry): Promise<boolean> {
  if (typeof id !== 'string' || !id) return Promise.resolve(false);
  return mutateSessions('appendModelSwitch', id, (doc) => {
    const hit = ensureRecord(doc, id, { create: false });
    if (hit === null || 'refused' in hit) {
      warnRefused('appendModelSwitch', id, hit ? hit.refused : 'unresolvable');
      return { changed: false, value: false };
    }
    hit.record.modelSwitches = [...(hit.record.modelSwitches ?? []), { ...entry }];
    return { changed: true, value: true };
  });
}

// The ledger entries recorded against transcript segment `backingId` (a live or
// retired segment of any record), oldest first; [] when none.
export async function getModelSwitchesForSegment(backingId: string): Promise<ModelSwitchEntry[]> {
  if (typeof backingId !== 'string' || !backingId) return [];
  const index = await loadSessions();
  const owner = resolveOwner(index, backingId) ?? fullChainOwner(index.byPublic, backingId);
  const rec = owner === null ? undefined : index.byPublic.get(owner);
  return (rec?.modelSwitches ?? []).filter(e => e.segment === backingId);
}

// A rewind truncated `segment`'s jsonl: move each of its entries whose anchor
// line did not survive (`survivingUuids`) to `anchor`, the last surviving line.
export function reanchorModelSwitches(
  id: string, segment: string, survivingUuids: readonly string[], anchor: string | null,
): Promise<number> {
  if (typeof id !== 'string' || !id) return Promise.resolve(0);
  const surviving = new Set(survivingUuids);
  const stale = (e: ModelSwitchEntry): boolean =>
    e.segment === segment && e.afterUuid !== null && !surviving.has(e.afterUuid);
  return mutateSessions('reanchorModelSwitches', id, (doc) => {
    const hit = ensureRecord(doc, id, { create: false });
    if (hit === null || 'refused' in hit) return { changed: false, value: 0 };
    const list = hit.record.modelSwitches ?? [];
    const moved = list.filter(stale).length;
    if (moved === 0) return { changed: false, value: 0 };
    hit.record.modelSwitches = list.map(e => (stale(e) ? { ...e, afterUuid: anchor } : e));
    return { changed: true, value: moved };
  }, (doc) => {
    const hit = ensureRecord(doc, id, { create: false });
    return hit && !('refused' in hit) && !(hit.record.modelSwitches ?? []).some(stale) ? { value: 0 } : null;
  });
}

export interface TurnMarks { turnEndSeq: number; viewedSeq: number }

function marksOf(rec: SessionRecord | null | undefined): TurnMarks {
  return { turnEndSeq: rec?.turnEndSeq ?? 0, viewedSeq: rec?.viewedSeq ?? 0 };
}

export async function getTurnMarks(id: string): Promise<TurnMarks> {
  if (typeof id !== 'string' || !id) return marksOf(null);
  return marksOf(recordFor(await loadSessions(), id));
}

// One turn end: turnEndSeq + 1. Always a write (one per turn end, beside
// _writeSessionMetadata's), so there is no precheck.
export function recordTurnEnd(id: string): Promise<TurnMarks> {
  if (typeof id !== 'string' || !id) return Promise.resolve(marksOf(null));
  return mutateSessions('recordTurnEnd', id, (doc) => {
    const hit = ensureRecord(doc, id);
    if (hit === null || 'refused' in hit) {
      warnRefused('recordTurnEnd', id, hit ? hit.refused : 'unresolvable');
      return { changed: false, value: marksOf(null) };
    }
    hit.record.turnEndSeq = (hit.record.turnEndSeq ?? 0) + 1;
    return { changed: true, value: marksOf(hit.record) };
  });
}

// The human saw turn end `seq`. Clamped to turnEndSeq (a future turn cannot be
// pre-marked) and never lowered, so a stale or replayed call is harmless.
export function markViewed(id: string, seq: number): Promise<TurnMarks> {
  if (typeof id !== 'string' || !id) return Promise.resolve(marksOf(null));
  const target = (rec: SessionRecord): number =>
    Math.max(rec.viewedSeq ?? 0, Math.min(seq, rec.turnEndSeq ?? 0));
  return sessionWrite('markViewed', id, marksOf(null),
    rec => target(rec) === (rec.viewedSeq ?? 0),
    rec => { rec.viewedSeq = target(rec); return marksOf(rec); },
    rec => marksOf(rec));
}

// Every tier of a session's summaries — `{}` when none.
export async function getSummaries(id: string): Promise<SummaryTiers> {
  if (typeof id !== 'string' || !id) return {};
  return { ...(recordFor(await loadSessions(), id)?.summaries ?? {}) };
}

// Merge one tier into the session's summaries (never clobbering the others).
export function setSummary(id: string, length: string, record: unknown): Promise<TierRecord | null> {
  if (typeof id !== 'string' || !id) return Promise.resolve(null);
  if (!(SUMMARY_LENGTHS as readonly string[]).includes(length)) return Promise.resolve(null);
  const tier = normalizeTierRecord(record);
  if (!tier) return Promise.resolve(null);
  const len = length as keyof SummaryTiers;
  return mutateSessions('setSummary', id, (doc) => {
    const hit = ensureRecord(doc, id);
    if (hit === null || 'refused' in hit) {
      warnRefused('setSummary', id, hit ? hit.refused : 'unresolvable');
      return { changed: false, value: null };
    }
    hit.record.summaries = { ...(hit.record.summaries ?? {}), [len]: tier };
    return { changed: true, value: tier };
  });
}

// ── transcript-level facts ───────────────────────────────────────────────────

function segmentFlag(index: SessionIndex, backingId: string, flag: 'temp' | 'archived'): boolean {
  const owner = index.byBacking.get(backingId);
  if (!owner) return false;
  const seg = (index.byPublic.get(owner) as SessionRecord).segments.find(s => s.id === backingId && !s.dropped);
  return seg?.[flag] === true;
}

export async function isTemp(backingId: string): Promise<boolean> {
  if (typeof backingId !== 'string' || !backingId) return false;
  return segmentFlag(await loadSessions(), backingId, 'temp');
}

export async function isArchived(backingId: string): Promise<boolean> {
  if (typeof backingId !== 'string' || !backingId) return false;
  return segmentFlag(await loadSessions(), backingId, 'archived');
}

function setFlag(seg: Segment, flag: 'temp' | 'archived', on: boolean): void {
  if (on) seg[flag] = true; else delete seg[flag];
}

// Shared body of the segment flag setters. Awaits the read barrier first (see
// the header) — so it must never be reached from a kicked write.
async function segmentWrite(
  op: string, backingId: string, flag: 'temp' | 'archived', on: boolean, owner: string | null | undefined,
): Promise<boolean> {
  await awaitKickedWrites();
  return mutateSessions(op, backingId, (doc) => {
    const hit = ensureSegment(doc, backingId, { owner });
    if (hit === null || 'refused' in hit) {
      warnRefused(op, backingId, hit ? hit.refused : 'unresolvable');
      return { changed: false, value: false };
    }
    if ((hit.segment[flag] === true) === on) return { changed: false, value: true };
    setFlag(hit.segment, flag, on);
    return { changed: true, value: true };
  }, (doc) => {
    const hit = ensureSegment(doc, backingId, { owner, create: false });
    return hit && !('refused' in hit) && (hit.segment[flag] === true) === on ? { value: true } : null;
  });
}

export function setSegmentTemp(backingId: string | null | undefined, on: boolean, { owner }: { owner?: string | null } = {}): Promise<boolean> {
  if (typeof backingId !== 'string' || !backingId) return Promise.resolve(false);
  return segmentWrite('setSegmentTemp', backingId, 'temp', on, owner);
}

export function setSegmentArchived(backingId: string | null | undefined, on: boolean, { owner }: { owner?: string | null } = {}): Promise<boolean> {
  if (typeof backingId !== 'string' || !backingId) return Promise.resolve(false);
  return segmentWrite('setSegmentArchived', backingId, 'archived', on, owner);
}

// Live temp segments with no live instance: sessions that crashed before this
// process could retire them. `liveBackingIds` is every backing id this process
// tracks as a live temp instance.
export function orphanedTempIdsSync(liveBackingIds: Iterable<string>): string[] {
  const live = new Set(liveBackingIds);
  const out: string[] = [];
  for (const rec of loadSessionsSync().byPublic.values()) {
    for (const s of liveSegments(rec)) if (s.temp && !live.has(s.id)) out.push(s.id);
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
