// Migration 0043: a session's kind is recorded as `persistent` on the ones that
// stay listed, instead of `temp` on the ones that are archived on exit.
//
// Before (under <root>/.code-conductor/):
//   sessions.json (+ .bak)     {sessions: {<pub>: {current, segments: [{…, temp?, archived?}], …}}}
//                              a session is normal when its segment carries `temp: true`
//   pending-resume.json        {…, instances: [{…, temp: <bool>}], …}
//   running-sessions.json      {…, instances: [{…, temp: <bool>}], …}
//   pending-temp-cleanup.json  the boot archive list
// After:
//   sessions.json (+ .bak)     {version: 2, sessions: {<pub>: {current, segments: [{…, persistent?, archived?}], …}}}
//   pending-resume.json        {…, instances: [{…, persistent: <bool>}], …}
//   running-sessions.json      {…, instances: [{…, persistent: <bool>}], …}
//   pending-archive.json       the same bytes, renamed
//   migrated-backup-0043/      the pre-image of sessions.json and sessions.json.bak
//
// FOUR INDEPENDENT STEPS, each idempotent and each committed by tmp-write + rename.
//
// (A) sessions.json, then sessions.json.bak, each on its own.
//   PROBE: `version === 2` in the file → no-op. A structural probe is impossible:
//   a migrated store holding only normal sessions carries neither flag, exactly
//   like an unmigrated store holding only persistent ones, so a re-run would mark
//   every normal session persistent. The marker lands in the same rename as the
//   transform, so no crash window separates them.
//   TRANSFORM, per record whose `segments` is an array, touching only the
//   segments' `temp` / `persistent` keys (every other key survives verbatim):
//     - a dropped segment carries no flag;
//     - a `temp: true` segment carries no flag (normal);
//     - any other non-archived segment gets `persistent: true`;
//     - an archived segment gets `persistent: true` iff the record's current
//       segment is live, not temp and not archived. Archiving used to clear
//       `temp`, so only the current segment tells an archived predecessor of a
//       persistent session from an exited normal session.
//   The pre-image of both files is copied once to migrated-backup-0043/ (via
//   `…-0043.tmp/` + rename; skipped when the directory already exists). An
//   unparseable file is left alone: the store's strict read quarantines it and
//   recovers from `.bak`, which this step migrates on its own.
//
// (B) pending-resume.json and running-sessions.json: every `instances[]` object
//   with an own `temp` key gets `persistent = temp !== true` and loses `temp`.
//   The writer always wrote the boolean, so the key's presence is the probe.
//   Everything else in the file is untouched; a torn file is left to the
//   restore path's own reader.
//
// (C) pending-temp-cleanup.json → pending-archive.json, renamed when the new
//   name is absent. When both exist the old file is left and logged; the boot
//   consumes the new one, and the next boot renames the old one.
//
// KNOWN LIMITS: no store lock is taken. During a hot restart a late write by the
// exiting old server — or a 0039 re-merge of a legacy file it recreates — drops
// `version` and the `persistent` flags, and the next boot re-migrates that store:
// every live normal session in it comes back persistent. Nothing is lost; the
// error leans toward keeping sessions listed. A persistent session that was
// archived by hand is indistinguishable from an exited normal one and comes back
// normal; ↑ makes it persistent again.
//
// Frozen artifact — do not edit. Uses Node built-ins only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '0043-persistent-sessions';

const DEFAULT_PROJECTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STORE_FILE = 'sessions.json';
const STORE_BAK = 'sessions.json.bak';
const VERSION = 2;
const BACKUP_DIR = 'migrated-backup-0043';
const RESTORE_FILES = ['pending-resume.json', 'running-sessions.json'];
const OLD_ARCHIVE_LIST = 'pending-temp-cleanup.json';
const NEW_ARCHIVE_LIST = 'pending-archive.json';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

// The file's text, or null when absent.
async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

// A parsed store doc that still needs the transform, or null (absent, already
// migrated, or unparseable — the last logged and left in place).
async function pendingStore(file, log) {
  const raw = await readText(file);
  if (raw === null) return null;
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) {
    log(`  ! ${path.basename(file)} is unparseable (${e.message}); left in place`);
    return null;
  }
  if (!isObj(obj) || obj.version === VERSION) return null;
  return obj;
}

function transformStore(obj) {
  let persistent = 0, normal = 0;
  const sessions = isObj(obj.sessions) ? obj.sessions : {};
  for (const rec of Object.values(sessions)) {
    if (!isObj(rec) || !Array.isArray(rec.segments)) continue;
    const cur = rec.segments.find((s) => isObj(s) && s.id === rec.current && s.dropped !== true);
    const sessionPersistent = !!cur && cur.temp !== true && cur.archived !== true;
    for (const s of rec.segments) {
      if (!isObj(s)) continue;
      const wasTemp = s.temp === true;
      delete s.temp;
      delete s.persistent;
      if (s.dropped === true) continue;
      if (wasTemp) { normal++; continue; }
      if (s.archived !== true || sessionPersistent) { s.persistent = true; persistent++; }
      else normal++;
    }
  }
  return { doc: { ...obj, version: VERSION }, persistent, normal };
}

// Write `version` first, then every other key in its original order.
function serializeStore(doc) {
  const { version, ...rest } = doc;
  return JSON.stringify({ version, ...rest }, null, 2) + '\n';
}

async function snapshotStore(store) {
  const dest = path.join(store, BACKUP_DIR);
  if (await exists(dest)) return false;
  const tmp = `${dest}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp);
  for (const f of [STORE_FILE, STORE_BAK]) {
    try { await fs.copyFile(path.join(store, f), path.join(tmp, f)); }
    catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
  await fs.rename(tmp, dest);
  return true;
}

async function migrateStore(store, log) {
  const files = [STORE_FILE, STORE_BAK].map((f) => path.join(store, f));
  const pending = [];
  for (const file of files) {
    const obj = await pendingStore(file, log);
    if (obj) pending.push({ file, obj });
  }
  if (pending.length === 0) return null;
  const bak = await snapshotStore(store);
  const out = { files: [], persistent: 0, normal: 0, backup: bak ? BACKUP_DIR : null };
  for (const { file, obj } of pending) {
    const { doc, persistent, normal } = transformStore(obj);
    await writeAtomic(file, serializeStore(doc));
    out.files.push(path.basename(file));
    if (path.basename(file) === STORE_FILE) { out.persistent = persistent; out.normal = normal; }
  }
  return out;
}

async function migrateRestoreFile(file) {
  const raw = await readText(file);
  if (raw === null) return 0;
  let obj;
  try { obj = JSON.parse(raw); } catch { return 0; }
  if (!isObj(obj) || !Array.isArray(obj.instances)) return 0;
  let n = 0;
  const instances = obj.instances.map((e) => {
    if (!isObj(e) || !Object.hasOwn(e, 'temp')) return e;
    n++;
    const { temp, ...rest } = e;
    return { ...rest, persistent: temp !== true };
  });
  if (n === 0) return 0;
  await writeAtomic(file, JSON.stringify({ ...obj, instances }));
  return n;
}

async function renameArchiveList(store, log) {
  const from = path.join(store, OLD_ARCHIVE_LIST);
  const to = path.join(store, NEW_ARCHIVE_LIST);
  if (!(await exists(from))) return false;
  if (await exists(to)) {
    log(`  ! ${OLD_ARCHIVE_LIST} and ${NEW_ARCHIVE_LIST} both exist; ${OLD_ARCHIVE_LIST} is left for the next boot`);
    return false;
  }
  await fs.rename(from, to);
  return true;
}

export async function run({ root, log = () => {} } = {}) {
  const projectsRoot = root ?? process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
  const store = path.join(projectsRoot, '.code-conductor');
  if (!(await exists(store))) return { applied: false };

  const storeResult = await migrateStore(store, log);
  const restore = {};
  for (const f of RESTORE_FILES) {
    const n = await migrateRestoreFile(path.join(store, f));
    if (n) restore[f] = n;
  }
  const renamed = await renameArchiveList(store, log);

  if (!storeResult && Object.keys(restore).length === 0 && !renamed) return { applied: false };
  return {
    applied: true,
    summary: {
      ...(storeResult ? { store: storeResult } : {}),
      ...(Object.keys(restore).length ? { restoreEntries: restore } : {}),
      ...(renamed ? { renamed: `${OLD_ARCHIVE_LIST} → ${NEW_ARCHIVE_LIST}` } : {}),
    },
  };
}
