import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from '../projects.ts';
import { isSlug } from '../identifiers.ts';
import type { ManifestSource } from './manifest.ts';
import { errCode, errMsg } from '../../shared/basics.ts';

// The plugin host's persistence collaborator: the three JSON files under
// `<orchStoreRoot()>/plugins/`, the corrupt-file preservation policy, the
// load notices that policy produces, and the adopt pass that prunes stale
// runtime records.
//
//   registry.json  {plugins: {<id>: {project, enabled, activeVersion, autoStart}}}
//   runtime.json   {<id>: {pid, pgid, port, startedAt, gitHead}}
//   exits.json     {<id>: ExitRecord[]}  newest first, EXIT_HISTORY per id. Independent
//                  of runtime.json, so the next start overwriting a runtime record
//                  loses no exit.
//   data/<id>/     plugin-owned; handed to that plugin's backend as
//                  CONDUCTOR_PLUGIN_DATA_DIR (`pluginDataDir`), never read or
//                  written by the store. It sits under its own `data/` subdir
//                  because a plugin id may equal a host entry name such as `library`.
//
// Reads hand out SHALLOW COPIES and every mutator writes. That is the point of
// the boundary, not a convention on top of it: after the split no code outside
// this module can change persisted state without going through a method that
// persists it. `PersistedPluginRecord`'s only non-primitive is `activeVersion`,
// which is always replaced wholesale, so a shallow copy is sufficient.
//
// The file paths are FUNCTIONS, recomputed per call: `orchStoreRoot()` follows
// `PROJECTS_ROOT`, which swaps between test roots (the host's init memo is
// keyed on the same thing).

export interface PersistedPluginRecord {
  project: string;
  enabled: boolean;
  activeVersion?: ManifestSource;
  // Start the backend at boot when it is not already running.
  autoStart: boolean;
}

export interface RuntimeRecord {
  pid: number;
  pgid: number;
  port: number;
  startedAt: string;
  gitHead: string | null;
}

// How the backend's last run ended, as far as cc could tell:
//  - 'exit'    cc's own child, from its 'exit' event: code/signal/time are exact.
//  - 'gone'    a backend cc did not spawn (adopted) found dead on a passive touch.
//              Its exit code and signal are unknowable; the death happened in
//              (lastAliveAt ?? startedAt, at], and `at` is when cc next looked.
//  - 'stopped' cc stopped an adopted backend (no exit event will follow).
export interface ExitRecord {
  pid: number;
  startedAt: string;
  at: string;
  how: 'exit' | 'gone' | 'stopped';
  code: number | null;
  signal: string | null;
  // cc asked it to stop (Stop, Restart, Disable, a version switch).
  stopRequested: boolean;
  // 'gone' only: the last passive touch that saw the pid alive; null = unknown (boot).
  lastAliveAt: string | null;
}

export const EXIT_HISTORY = 10;

export interface PluginStoreDeps {
  // Fired by every registry.json write, BEFORE the write — a failed write still
  // leaves the signal sent. Signalling from the one save path rather than at
  // each mutator's call site is what makes the set provably complete.
  onRegistryChange: () => void;
}

// A plugin's data dir. Recomputed per call (follows `PROJECTS_ROOT`) and absolute
// even for a relative root. The id is slug-guarded here so traversal-safety does
// not rest on callers. The host never creates or touches the dir.
export function pluginDataDir(id: string): string {
  if (!isSlug(id)) throw new Error(`pluginDataDir: '${id}' is not a valid plugin id`);
  return path.resolve(orchStoreRoot(), 'plugins', 'data', id);
}

export function createPluginStore({ onRegistryChange }: PluginStoreDeps) {
  let persisted: { plugins: Record<string, PersistedPluginRecord> } = { plugins: {} };
  let runtimeRecords: Record<string, RuntimeRecord> = {};
  let exitRecords: Record<string, ExitRecord[]> = {};
  // exits.json saves chain: concurrent writeFileAtomic renames could land out of
  // order, and the file must end up carrying the newest state.
  let exitsSaving: Promise<void> = Promise.resolve();

  // Non-ENOENT load failures from THIS load pass — surfaced on GET /api/plugins so
  // a user whose plugins came back disabled learns why, and where the old file went.
  let loadNotices: Array<{ file: string; reason: string; backup: string | null }> = [];

  const registryFile = (): string => path.join(orchStoreRoot(), 'plugins', 'registry.json');
  const runtimeFile = (): string => path.join(orchStoreRoot(), 'plugins', 'runtime.json');
  const exitsFile = (): string => path.join(orchStoreRoot(), 'plugins', 'exits.json');

  // Backs registry.json, runtime.json and exits.json, deliberately: carving out a
  // registry-only variant would need an extra parameter for no benefit, and each
  // notice names its own file.
  async function loadJson(file: string, fallback: unknown): Promise<unknown> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) {
      if (errCode(e) === 'ENOENT') return fallback;
      // The fallback below silently forgets every plugin's enabled state and pinned
      // version, and this file is the only copy of it — so move the bad file aside
      // rather than letting the next save overwrite it, and record a notice the
      // Settings page shows. A log line alone leaves the user guessing why their
      // plugins came back disabled. A previous `.corrupt` IS overwritten: it was
      // already unusable, and a timestamped chain would accumulate forever.
      const backup = `${file}.corrupt`;
      let saved: string | null = null;
      try { await fs.rename(file, backup); saved = backup; }
      catch (re) { console.warn(`plugins: could not preserve ${file} as ${backup}: ${errMsg(re)}`); }
      console.warn(`plugins: failed to read ${file}: ${errMsg(e)}`);
      loadNotices.push({ file: path.basename(file), reason: errMsg(e), backup: saved });
      return fallback;
    }
  }

  async function saveRegistry(): Promise<void> {
    onRegistryChange();
    await writeFileAtomic(registryFile(), JSON.stringify(persisted, null, 2) + '\n');
  }

  // runtime.json saves chain like exits.json: the passive death paths write it
  // detached, and a later write (or a fresh host's load) must never see an older
  // state land after a newer one.
  let runtimeSaving: Promise<void> = Promise.resolve();
  function saveRuntimeRecords(): Promise<void> {
    const next = runtimeSaving.catch(() => {}).then(() => writeFileAtomic(runtimeFile(), JSON.stringify(runtimeRecords, null, 2) + '\n'));
    runtimeSaving = next;
    return next;
  }

  function saveExits(): Promise<void> {
    const next = exitsSaving.catch(() => {}).then(() => writeFileAtomic(exitsFile(), JSON.stringify(exitRecords, null, 2) + '\n'));
    exitsSaving = next;
    return next;
  }

  // Registry first, then runtime, then exits — the adopt pass reads the first
  // two, and a corrupt registry.json must produce its notice before runtime.json's.
  async function load(): Promise<void> {
    // Reset first: a projectsRoot() swap or a retry after a failed init must
    // start clean, not inherit the previous pass's notices.
    loadNotices = [];
    persisted = (await loadJson(registryFile(), { plugins: {} })) as { plugins: Record<string, PersistedPluginRecord> };
    if (typeof persisted?.plugins !== 'object' || persisted.plugins === null) persisted = { plugins: {} };
    runtimeRecords = (await loadJson(runtimeFile(), {})) as Record<string, RuntimeRecord>;
    exitRecords = sanitizeExits(await loadJson(exitsFile(), {}));
  }

  // A hand-edited or damaged exits.json must not throw at every reader of a
  // row: keep the well-formed entries per id, drop the rest, and say so.
  function sanitizeExits(raw: unknown): Record<string, ExitRecord[]> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      loadNotices.push({ file: 'exits.json', reason: 'not an object keyed by plugin id; ignored', backup: null });
      return {};
    }
    const out: Record<string, ExitRecord[]> = {};
    let dropped = 0;
    for (const [id, v] of Object.entries(raw)) {
      const list = Array.isArray(v) ? v : [];
      const ok = list.filter(e => typeof e === 'object' && e !== null && !Array.isArray(e)) as ExitRecord[];
      dropped += (Array.isArray(v) ? list.length - ok.length : 1);
      if (ok.length) out[id] = ok;
    }
    if (dropped) loadNotices.push({ file: 'exits.json', reason: `${dropped} malformed exit entr${dropped === 1 ? 'y' : 'ies'} ignored`, backup: null });
    return out;
  }

  // ── registry.json ───────────────────────────────────────────────────
  function get(id: string): PersistedPluginRecord | undefined {
    const rec = persisted.plugins[id];
    return rec ? { ...rec } : undefined;
  }

  function has(id: string): boolean { return persisted.plugins[id] !== undefined; }

  function isEnabled(id: string): boolean { return persisted.plugins[id]?.enabled === true; }

  function autoStart(id: string): boolean { return persisted.plugins[id]?.autoStart === true; }

  function entries(): Array<[string, PersistedPluginRecord]> {
    return Object.entries(persisted.plugins).map(([id, rec]) => [id, { ...rec }]);
  }

  async function upsert(id: string, rec: PersistedPluginRecord): Promise<void> {
    persisted.plugins[id] = { ...rec };
    await saveRegistry();
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const rec = persisted.plugins[id];
    if (!rec) return;
    rec.enabled = enabled;
    await saveRegistry();
  }

  async function setAutoStart(id: string, on: boolean): Promise<void> {
    const rec = persisted.plugins[id];
    if (!rec) return;
    rec.autoStart = on;
    await saveRegistry();
  }

  async function setActiveVersion(id: string, v: ManifestSource): Promise<void> {
    const rec = persisted.plugins[id];
    if (!rec) return;
    rec.activeVersion = v;
    await saveRegistry();
  }

  // ── runtime.json ────────────────────────────────────────────────────
  function runtimeRecord(id: string): RuntimeRecord | undefined {
    const rec = runtimeRecords[id];
    return rec ? { ...rec } : undefined;
  }

  function runtimeIds(): string[] { return Object.keys(runtimeRecords); }

  async function recordStart(id: string, rec: RuntimeRecord): Promise<void> {
    runtimeRecords[id] = { ...rec };
    await saveRuntimeRecords();
  }

  async function clearRuntime(id: string): Promise<void> {
    delete runtimeRecords[id];
    await saveRuntimeRecords();
  }

  // ── exits.json ──────────────────────────────────────────────────────
  function exits(id: string): ExitRecord[] {
    return (exitRecords[id] ?? []).map(r => ({ ...r }));
  }

  // Never rejects: callers are detached (an exit event, a passive probe) or on a
  // path that must not fail for want of a history write, so a failed write is
  // warned here, naming its file.
  async function recordExit(id: string, rec: ExitRecord): Promise<void> {
    exitRecords[id] = [{ ...rec }, ...(exitRecords[id] ?? [])].slice(0, EXIT_HISTORY);
    try { await saveExits(); }
    catch (e) { console.warn(`plugins: exits.json write failed: ${errMsg(e)}`); }
  }

  // Variant for the two passive death paths (a supervisor exit event, a dead pid
  // noticed by a probe): the record is dropped synchronously and a failed write
  // is warned rather than thrown. The returned promise settles when the write
  // has landed, for a caller that wants the file current before it reports.
  function clearRuntimeDetached(id: string): Promise<void> {
    delete runtimeRecords[id];
    return saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${errMsg(e)}`));
  }

  // Adopt-don't-drain, persistence half. The caller supplies the liveness
  // predicate (which needs the discovery catalog and a health probe, neither of
  // which lives here) and gets back the ids it should mark ready; everything
  // rejected is cleared, in ONE write and only when something actually changed.
  async function adopt({ isAdoptable }: { isAdoptable: (id: string, rec: RuntimeRecord) => Promise<boolean> }): Promise<string[]> {
    const adopted: string[] = [];
    let dirty = false;
    for (const [id, rec] of Object.entries(runtimeRecords)) {
      if (await isAdoptable(id, { ...rec })) {
        adopted.push(id);
      } else {
        delete runtimeRecords[id];
        dirty = true;
      }
    }
    if (dirty) await saveRuntimeRecords();
    return adopted;
  }

  function notices(): Array<{ file: string; reason: string; backup: string | null }> {
    return [...loadNotices];
  }

  return {
    load,
    get, has, isEnabled, autoStart, entries, upsert, setEnabled, setAutoStart, setActiveVersion,
    runtimeRecord, runtimeIds, recordStart, clearRuntime, clearRuntimeDetached, adopt,
    exits, recordExit,
    notices,
  };
}
