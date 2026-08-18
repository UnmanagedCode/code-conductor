import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot, writeFileAtomic } from '../projects.ts';
import type { ManifestSource } from './manifest.ts';

// The plugin host's persistence collaborator: the two JSON files under
// `<orchStoreRoot()>/plugins/`, the corrupt-file preservation policy, the
// load notices that policy produces, and the adopt pass that prunes stale
// runtime records.
//
//   registry.json  {plugins: {<id>: {project, enabled, activeVersion}}}
//   runtime.json   {<id>: {pid, pgid, port, startedAt, gitHead}}
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
}

export interface RuntimeRecord {
  pid: number;
  pgid: number;
  port: number;
  startedAt: string;
  gitHead: string | null;
}

export interface PluginStoreDeps {
  // Fired by every registry.json write, BEFORE the write — a failed write still
  // leaves the signal sent. Signalling from the one save path rather than at
  // each mutator's call site is what makes the set provably complete.
  onRegistryChange: () => void;
}

export function createPluginStore({ onRegistryChange }: PluginStoreDeps) {
  let persisted: { plugins: Record<string, PersistedPluginRecord> } = { plugins: {} };
  let runtimeRecords: Record<string, RuntimeRecord> = {};

  // Non-ENOENT load failures from THIS load pass — surfaced on GET /api/plugins so
  // a user whose plugins came back disabled learns why, and where the old file went.
  let loadNotices: Array<{ file: string; reason: string; backup: string | null }> = [];

  const registryFile = (): string => path.join(orchStoreRoot(), 'plugins', 'registry.json');
  const runtimeFile = (): string => path.join(orchStoreRoot(), 'plugins', 'runtime.json');

  // Backs BOTH registry.json and runtime.json, deliberately: carving out a
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

  async function saveRuntimeRecords(): Promise<void> {
    await writeFileAtomic(runtimeFile(), JSON.stringify(runtimeRecords, null, 2) + '\n');
  }

  // Registry first, then runtime — the adopt pass reads both, and a corrupt
  // registry.json must produce its notice before runtime.json's.
  async function load(): Promise<void> {
    // Reset first: a projectsRoot() swap or a retry after a failed init must
    // start clean, not inherit the previous pass's notices.
    loadNotices = [];
    persisted = (await loadJson(registryFile(), { plugins: {} })) as { plugins: Record<string, PersistedPluginRecord> };
    if (typeof persisted?.plugins !== 'object' || persisted.plugins === null) persisted = { plugins: {} };
    runtimeRecords = (await loadJson(runtimeFile(), {})) as Record<string, RuntimeRecord>;
  }

  // ── registry.json ───────────────────────────────────────────────────
  function get(id: string): PersistedPluginRecord | undefined {
    const rec = persisted.plugins[id];
    return rec ? { ...rec } : undefined;
  }

  function has(id: string): boolean { return persisted.plugins[id] !== undefined; }

  function isEnabled(id: string): boolean { return persisted.plugins[id]?.enabled === true; }

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

  // Fire-and-forget variant for the two passive death paths (a supervisor exit
  // event, a dead pid noticed by a probe): neither has anything to await into,
  // so the write is detached and a failure is warned rather than thrown.
  function clearRuntimeDetached(id: string): void {
    delete runtimeRecords[id];
    saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${errMsg(e)}`));
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
    get, has, isEnabled, entries, upsert, setEnabled, setActiveVersion,
    runtimeRecord, runtimeIds, recordStart, clearRuntime, clearRuntimeDetached, adopt,
    notices,
  };
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict).
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
