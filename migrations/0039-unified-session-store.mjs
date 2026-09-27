// Migration 0039: merge the eight per-session sidecar stores into one
// `<store>/sessions.json`, keyed by the session's PUBLIC id (src/sessionStore.ts).
//
// Before (under <root>/.code-conductor/):
//   session-lineage.json       {sessions: {<publicId>: {current, segments: [{id, reason, at, dropped?}]}}}
//   session-titles.json        {titles: {<backingId>: title}}
//   session-modes.json         {sessions: {<backingId>: mode}}
//   session-backends.json      {sessions: {<backingId>: {backend, model, contextWindowTokens}}}
//   session-summaries.json     {summaries: {<any id>: {short?, medium?, long?, title?}}}
//   conducted-sessions.json    {sessions: [<backingId>, …]}
//   temp-sessions.json         {sessions: [<backingId>, …]}
//   archived-sessions.json     {sessions: [<backingId>, …]}   (+ archived-sessions.json.bak)
// After: sessions.json
//   {sessions: {<publicId>: {current, segments: [{id, reason, at, dropped?, temp?, archived?}],
//                            title?, mode?, backend?, summaries?, conducted?}}}
// and the legacy files moved to <store>/migrated-backup-0039/ (a `-<ms>` suffix
// on a name clash). `.lock` files are left where they are.
//
// PROBE: none of the legacy files present → {applied:false}. So a legacy file
// recreated after the merge (by an exiting old server during a hot restart, or
// by 0005 from a stray conductor-sessions.json) is merged on the next boot.
//
// MERGE RULES
//   - Base: the existing sessions.json, if any. Missing, or unparseable (then
//     quarantined, best-effort, to `.corrupt-<pid>-<ts>` first) → its
//     `sessions.json.bak`, by the store's recovery rule (absent → empty;
//     corrupt → set aside, empty). Only a genuine I/O error reading either
//     throws (boot aborts).
//   - Lineage rows are copied verbatim into records, tombstones included. When
//     the base already holds the record and the legacy row's chain has segments
//     the record lacks (an old-version process rotated after an earlier merge),
//     those segments are appended in chain order and `current` advances to the
//     legacy `current` when that segment is live; a legacy chain that adds
//     nothing is skipped. A segment some record already holds is never taken
//     by another, so every segment the migration PLACES has one owner. The base
//     itself is not deduplicated; every store writer already keeps one owner.
//     A row that places nothing is counted (`skipped`).
//   - A record none of whose segments survives validation is dropped and
//     counted (`invalid`): the store's parser would never see it.
//   - Each legacy key is attributed: a record key; else the owner of any segment
//     (tombstones included); else, if minted-shaped (8 hex, or 8-4), it is
//     UNATTRIBUTABLE — counted, logged, and left in the backup dir; else a new
//     base-case record `{current: key, segments: [{id: key, reason: 'initial'}]}`.
//   - A fact the record already holds wins: legacy data only fills gaps, which
//     makes a re-run additive.
//   - Title, mode, backend: the value keyed by the newest segment in chain order
//     that has one (live segments before dropped ones), then the public-id key.
//   - Conducted: true if any segment or the public id is in the set.
//   - Summaries: every key that maps to the record merges; per tier, the larger
//     `generatedAt` wins.
//   - Temp, archived: set on the LIVE segment whose id is the key — only on a
//     segment NEW to the base, so a stale legacy file cannot re-archive a
//     segment the user has since restored. Archived comes from the primary, or
//     from `.bak` when the primary is absent or corrupt.
//   - `parent`/`project`/`worktree` are not backfilled.
//
// KNOWN LIMITS (best-effort by design): no store locks are taken; a crash
// between the write and the move re-merges additively next boot. A hot-restart
// old server's temp unmark can land in a legacy file after the move; the boot
// sweep of pending-temp-cleanup.json and the next restart's orphan sweep retire
// such segments anyway. A stale legacy lineage row naming a session the user has
// since DELETED re-creates that session's record from the row's chain, and any
// stale sibling legacy file still naming its ids fills that record's session
// facts and segment flags as for any other record. Flags apply only to segments
// new to the base, so a genuinely newer flag an old-version server writes for an
// already-merged segment after the merge is dropped too: a temp flag is
// backstopped by the orphan sweeps above, an archived flag only by the restart
// manifest (pending-temp-cleanup.json).
//
// `sessions.json.bak` is written beside the primary only when it is absent or
// corrupt, or when the merged doc holds every store-readable record it holds
// (shouldWriteBackup) — so the recovery net exists before the store's first
// mutation and a thin base never overwrites it.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0039-unified-session-store';

const DEFAULT_PROJECTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const LEGACY = {
  lineage: 'session-lineage.json',
  titles: 'session-titles.json',
  modes: 'session-modes.json',
  backends: 'session-backends.json',
  summaries: 'session-summaries.json',
  conducted: 'conducted-sessions.json',
  temp: 'temp-sessions.json',
  archived: 'archived-sessions.json',
};
const ARCHIVED_BAK = 'archived-sessions.json.bak';
const TARGET = 'sessions.json';
const BACKUP_DIR = 'migrated-backup-0039';

const MINTED_RE = /^[0-9a-f]{8}(-[0-9a-f]{4})?$/;
const REASONS = new Set(['initial', 'renew', 'prune']);
const MODES = new Set(['plan', 'bypassPermissions']);
const TIERS = ['short', 'medium', 'long', 'title'];
const MAX_TITLE_LEN = 100;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

// A legacy file's parsed JSON, or null when absent. A corrupt one is logged and
// read as empty — its bytes survive in the backup dir.
async function readLegacy(file, log) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(raw); }
  catch (e) {
    log(`  ! ${path.basename(file)} is unparseable (${e.message}); treated as empty, kept in ${BACKUP_DIR}/`);
    return {};
  }
}

function parseSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!isObj(s) || typeof s.id !== 'string' || !s.id || !REASONS.has(s.reason)) continue;
    out.push({
      id: s.id, reason: s.reason, at: typeof s.at === 'string' ? s.at : '',
      ...(s.dropped === true ? { dropped: true } : {}),
      ...(s.temp === true ? { temp: true } : {}),
      ...(s.archived === true ? { archived: true } : {}),
    });
  }
  return out;
}

const live = (rec) => rec.segments.filter((s) => !s.dropped);

function normTitle(t) { return typeof t === 'string' ? t.trim().slice(0, MAX_TITLE_LEN) : ''; }

function normBackend(r) {
  if (!isObj(r) || typeof r.backend !== 'string' || !r.backend) return null;
  return {
    backend: r.backend,
    model: typeof r.model === 'string' && r.model ? r.model : null,
    contextWindowTokens: typeof r.contextWindowTokens === 'number' && Number.isFinite(r.contextWindowTokens)
      ? r.contextWindowTokens : null,
  };
}

function normTier(r) {
  if (!isObj(r) || typeof r.summary !== 'string' || !r.summary.trim()) return null;
  return {
    summary: r.summary.trim(),
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : 0,
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
  };
}

// The whole target file as-is, records keyed by public id. A MISSING primary
// is external loss (the store always writes one) and an UNPARSEABLE one is
// quarantined to `.corrupt-<pid>-<ts>`, exactly as the store's strict read
// does; either way the base is its `.bak`, by the store's own recovery rule:
// absent `.bak` → empty; corrupt `.bak` → set aside, empty; any other I/O
// error → throw.
async function readBase(file, log) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    return readBackupBase(`${file}.bak`);
  }
  try {
    const obj = JSON.parse(raw);
    return isObj(obj?.sessions) ? { ...obj.sessions } : {};
  } catch (e) {
    // Best-effort, like the store's quarantine(): a failed rename is logged and
    // the merge still bases on `.bak` (the write below replaces the primary).
    const dest = `${file}.corrupt-${process.pid}-${Date.now()}`;
    try {
      await fs.rename(file, dest);
      log(`  ! ${path.basename(file)} is unparseable (${e.message}); quarantined to ${path.basename(dest)}, merging onto its .bak`);
    } catch (re) {
      log(`  ! ${path.basename(file)} is unparseable (${e.message}); could not quarantine it (${re?.message ?? re}), merging onto its .bak`);
    }
    return readBackupBase(`${file}.bak`);
  }
}

async function readBackupBase(bak) {
  let raw;
  try { raw = await fs.readFile(bak, 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return {}; throw e; }
  try {
    const obj = JSON.parse(raw);
    return isObj(obj?.sessions) ? { ...obj.sessions } : {};
  } catch {
    await fs.rename(bak, `${bak}.corrupt-${process.pid}-${Date.now()}`).catch(() => {});
    return {};
  }
}

// A record the store's parser would keep: at least one live, valid segment.
const readable = (rec) => isObj(rec) && typeof rec.current === 'string' && rec.current !== ''
  && parseSegments(rec.segments).some((s) => !s.dropped);

// Whether to REPLACE `.bak` with the merged doc: when it is absent or corrupt,
// never when unreadable, and otherwise only when the merged doc holds every
// store-readable record the `.bak` holds. Stricter than the store's own
// drop-at-most-one refresh rule on purpose: one store mutation removes at most
// one record, but this write derives from a primary that may be thin, so any
// missing record means `.bak` is the only copy left. There is no archived-flag
// clause: this merge never clears a flag, so a merged doc that keeps every
// record keeps every flag its primary holds, and a flag the primary lacks
// against `.bak` is an un-archive the store itself already accepted.
async function shouldWriteBackup(bak, sessions) {
  let raw;
  try { raw = await fs.readFile(bak, 'utf8'); }
  catch (e) { return e?.code === 'ENOENT'; }
  let old;
  try { old = JSON.parse(raw)?.sessions; } catch { return true; }
  if (!isObj(old)) return true;
  return Object.entries(old).every(([pub, rec]) => !readable(rec) || Object.hasOwn(sessions, pub));
}

function mapOf(obj, key) {
  const m = obj && isObj(obj[key]) ? obj[key] : {};
  return new Map(Object.entries(m).filter(([k]) => k));
}

function setOf(obj) {
  const arr = Array.isArray(obj?.sessions) ? obj.sessions : [];
  return new Set(arr.filter((s) => typeof s === 'string' && s));
}

export async function run({ root, log = console.log } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const store = path.join(projectsRoot, '.code-conductor');
  const legacyPaths = [...Object.values(LEGACY), ARCHIVED_BAK].map((n) => path.join(store, n));
  const present = [];
  for (const p of legacyPaths) if (await exists(p)) present.push(p);
  if (present.length === 0) return { applied: false };

  const target = path.join(store, TARGET);
  const sessions = await readBase(target, log);
  const file = (k) => path.join(store, LEGACY[k]);

  // 0. The base, validated. Its segment ids are what "new to the base" is
  //    measured against in step 5.
  let invalid = 0;
  for (const [pub, rec] of Object.entries(sessions)) {
    if (!isObj(rec) || !Array.isArray(rec.segments)) { delete sessions[pub]; invalid++; continue; }
    rec.segments = parseSegments(rec.segments);
    if (!rec.segments.some((s) => !s.dropped)) { delete sessions[pub]; invalid++; }
  }
  const baseSegmentIds = new Set();
  for (const rec of Object.values(sessions)) for (const s of rec.segments) baseSegmentIds.add(s.id);
  // Every segment id some record already holds. Grows as step 1 appends, so a
  // segment ends up in at most one record however many legacy rows name it.
  const claimed = new Set(baseSegmentIds);

  // 1. Lineage rows: verbatim for a record the base lacks; for one it holds,
  //    the segments it lacks, appended in chain order.
  const lineage = await readLegacy(file('lineage'), log);
  let advanced = 0;
  let skipped = 0;
  for (const [pub, row] of mapOf(lineage, 'sessions')) {
    if (!isObj(row) || typeof row.current !== 'string' || !row.current) { invalid++; continue; }
    const segments = parseSegments(row.segments);
    if (!segments.some((s) => !s.dropped)) { invalid++; continue; }
    const unclaimed = segments.filter((seg) => !claimed.has(seg.id));
    const rec = sessions[pub];
    if (!rec) {
      const liveKept = unclaimed.filter((seg) => !seg.dropped);
      if (liveKept.length === 0) { skipped++; continue; } // every live segment is another record's
      for (const seg of unclaimed) claimed.add(seg.id);
      const cur = liveKept.find((seg) => seg.id === row.current) ?? liveKept.at(-1);
      sessions[pub] = { current: cur.id, segments: unclaimed };
      continue;
    }
    if (unclaimed.length === 0) { skipped++; continue; }
    for (const seg of unclaimed) claimed.add(seg.id);
    rec.segments.push(...unclaimed);
    const cur = rec.segments.find((seg) => seg.id === row.current && !seg.dropped);
    if (cur) rec.current = cur.id;
    advanced++;
  }

  // 2. The legacy stores.
  const titles = mapOf(await readLegacy(file('titles'), log), 'titles');
  const modes = mapOf(await readLegacy(file('modes'), log), 'sessions');
  const backends = mapOf(await readLegacy(file('backends'), log), 'sessions');
  const summaries = mapOf(await readLegacy(file('summaries'), log), 'summaries');
  const conducted = setOf(await readLegacy(file('conducted'), log));
  const temp = setOf(await readLegacy(file('temp'), log));
  let archivedDoc = await readLegacy(file('archived'), log);
  if (archivedDoc === null || !Array.isArray(archivedDoc?.sessions)) {
    const bak = await readLegacy(path.join(store, ARCHIVED_BAK), log);
    if (Array.isArray(bak?.sessions)) archivedDoc = bak;
  }
  const archived = setOf(archivedDoc);

  // 3. Attribute every legacy key, creating base-case records for unknown ones.
  const owner = new Map(); // any segment id (tombstones too) → public id
  for (const [pub, rec] of Object.entries(sessions)) for (const s of rec.segments) if (!owner.has(s.id)) owner.set(s.id, pub);
  const attributed = (id) => (sessions[id] ? id : owner.get(id) ?? null);
  let created = 0;
  const unattributable = new Set();
  const allKeys = new Set([...titles.keys(), ...modes.keys(), ...backends.keys(), ...summaries.keys(),
    ...conducted, ...temp, ...archived]);
  for (const id of allKeys) {
    if (attributed(id) !== null) continue;
    if (MINTED_RE.test(id)) { unattributable.add(id); continue; }
    sessions[id] = { current: id, segments: [{ id, reason: 'initial', at: new Date().toISOString() }] };
    owner.set(id, id);
    created++;
  }

  // 4. Session facts, gaps only.
  const facts = { titles: 0, modes: 0, backends: 0, summaries: 0, conducted: 0, temp: 0, archived: 0 };
  for (const [pub, rec] of Object.entries(sessions)) {
    const liveIds = live(rec).map((s) => s.id).reverse();
    const droppedIds = rec.segments.filter((s) => s.dropped).map((s) => s.id).reverse();
    const candidates = [...new Set([...liveIds, ...droppedIds, pub])];
    const first = (map, norm) => {
      for (const id of candidates) {
        if (!map.has(id)) continue;
        const v = norm(map.get(id));
        if (v) return v;
      }
      return null;
    };
    if (!normTitle(rec.title)) {
      const t = first(titles, normTitle);
      if (t) { rec.title = t; facts.titles++; }
    }
    if (!MODES.has(rec.mode)) {
      const m = first(modes, (v) => (MODES.has(v) ? v : null));
      if (m) { rec.mode = m; facts.modes++; }
    }
    if (!normBackend(rec.backend)) {
      const b = first(backends, normBackend);
      if (b) { rec.backend = b; facts.backends++; }
    }
    if (rec.conducted !== true && candidates.some((id) => conducted.has(id))) {
      rec.conducted = true; facts.conducted++;
    }
    const merged = isObj(rec.summaries) ? { ...rec.summaries } : {};
    let tierAdded = false;
    for (const tier of TIERS) {
      if (normTier(merged[tier])) continue;
      let best = null;
      for (const id of candidates) {
        const t = normTier(summaries.get(id)?.[tier]);
        if (t && (!best || t.generatedAt > best.generatedAt)) best = t;
      }
      if (best) { merged[tier] = best; tierAdded = true; }
    }
    if (tierAdded) { rec.summaries = merged; facts.summaries++; }
  }

  // 5. Segment facts, on the live segment the key names.
  for (const [set, flag] of [[temp, 'temp'], [archived, 'archived']]) {
    for (const id of set) {
      const pub = owner.get(id);
      const seg = pub ? sessions[pub].segments.find((s) => s.id === id && !s.dropped) : null;
      if (!seg) { if (!pub) unattributable.add(id); continue; }
      if (baseSegmentIds.has(id)) continue; // the merged store already owns this segment's flags
      if (seg[flag] !== true) { seg[flag] = true; facts[flag]++; }
    }
  }

  if (unattributable.size > 0) {
    log(`  ! ${unattributable.size} legacy key(s) name no session and were not merged `
      + `(kept in ${BACKUP_DIR}/): ${[...unattributable].sort().join(', ')}`);
  }

  // 6. Write, then move the legacy files aside.
  const ordered = {};
  for (const k of Object.keys(sessions).sort((a, b) => a.localeCompare(b))) ordered[k] = sessions[k];
  await fs.mkdir(store, { recursive: true });
  const json = JSON.stringify({ sessions: ordered }, null, 2) + '\n';
  const dests = [target];
  if (await shouldWriteBackup(`${target}.bak`, ordered)) dests.push(`${target}.bak`);
  for (const dest of dests) {
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, dest);
  }

  const backupDir = path.join(store, BACKUP_DIR);
  await fs.mkdir(backupDir, { recursive: true });
  for (const p of present) {
    let dest = path.join(backupDir, path.basename(p));
    if (await exists(dest)) dest = `${dest}-${Date.now()}`;
    await fs.rename(p, dest);
  }
  log(`  ✓ merged ${present.length} legacy session file(s) into ${target}`);
  return {
    applied: true,
    summary: { records: Object.keys(ordered).length, created, advanced, skipped, invalid, facts, unattributable: unattributable.size },
  };
}
