import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  projectsRoot, selfProjectDir, orchStoreRoot, writeFileAtomic, listProjects, projectStoreDir,
  readProjectMeta, writeProjectMeta, addWorkspace,
} from '../projects.ts';
import {
  readManifest,
  type PluginManifest, type PluginMcp, type ReadManifestResult, type ManifestSource,
} from './manifest.ts';
import { httpError } from '../httpError.ts';
import { createSupervisor, httpOk, type ChildRuntime } from './supervisor.ts';
import { createMcpBridge } from './mcpBridge.ts';
import { createContributions } from './contributions.ts';
import { createPluginStore } from './store.ts';
import { buildPluginRow, type PluginRow } from './row.ts';
import { pidAlive, waitForPort } from './ports.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import type { WorktreeMeta } from '../worktrees.ts';
import { LOCAL_SYSTEM_ID, resolveSystem, tryResolveSystem } from '../systems/registry.ts';
import type { System } from '../systems/system.ts';

// Plugin registry — the single service layer behind the REST api
// (src/plugins/api.ts), the reverse proxy (src/plugins/proxy.ts) and MCP
// forwarding (src/plugins/mcpBridge.ts). Owns discovery, active-version
// resolution, lifecycle state and lazy starts. Two more composed collaborators
// own the rest:
// src/plugins/contributions.ts (conventions/roles/claudePlugin roots, and the
// caches behind them) and src/plugins/store.ts (the persisted registry.json /
// runtime.json, their load-notice policy, and the adopt pass) — the matching
// public members point straight at them.
//
// activeVersion = {type:'main'} | {type:'worktree', name} — drives the
// supervisor cwd; the manifest is re-read from the active checkout on
// every start (id must match).
//
// Restart semantics: adopt, don't drain. Children are detached process
// groups, so they survive the conductor's self-respawn; init() re-adopts
// any recorded child whose pid is alive and answering, else clears the
// record. Health monitoring is passive (child exit events, proxy upstream
// errors, on-demand probes) — no periodic poller.

const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;
const BACKOFF_UNIT_MS = 1000;   // backoff = min(2^n, BACKOFF_CAP_UNITS) * unit
const BACKOFF_CAP_UNITS = 30;
// Exported so server.ts can reuse the same literal for the conductor's own
// boot-time self-seed instead of duplicating it.
export const WORKSPACE_AUTO_ASSIGN = 'CC-Dev';

// First-class placement: an unassigned project joins the CC-Dev workspace
// (same primitives as set_project_workspace). Never overrides a workspace
// the user has deliberately assigned. Non-fatal — a failure here must never
// block discovery or enable.
async function autoAssignToCcDev(projectName: string): Promise<void> {
  try {
    const meta = await readProjectMeta(projectName);
    if (meta.workspace == null) {
      await writeProjectMeta(projectName, { workspace: WORKSPACE_AUTO_ASSIGN });
      await addWorkspace(WORKSPACE_AUTO_ASSIGN);
    }
  } catch (e) {
    console.warn(`plugins: workspace auto-assign for '${projectName}' failed: ${errMsg(e)}`);
  }
}

// A discovered plugin project: either usable (manifest + id) or broken
// (invalid/conflicting/incompatible manifest). `id` is null only for an
// invalid manifest that carried no id; `dir` stays '' for the synthetic rows
// describe()/list() build for registry entries whose project vanished (their
// dir is never read). `manifestSource` is optional only because those
// synthetic rows don't carry one (describeRow falls back to {type:'main'}).
interface PluginEntry {
  id: string | null;
  project: string;
  dir: string;
  // The System the plugin's project lives on. A plugin is discovered wherever
  // its project is, but two of its capabilities are LOCAL-ONLY (a backend is a
  // process cc talks to on a local port; a `--plugin-dir` root must be an
  // absolute local directory), so every consumer needs to know.
  system: string;
  manifest: PluginManifest | null;
  manifestSource?: ManifestSource;
  discoveryState: 'ok' | 'invalid' | 'incompatible' | 'conflict';
  errors: string[];
}

// The slice of a PluginEntry that active-version resolution reads. Named
// separately so the accessors injected into collaborators (which declare their
// own narrow entry shapes) stay assignable without importing PluginEntry.
type VersionedEntry = { id: string | null; project: string; dir: string; system: string };

type PluginRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'crashed' | 'failed';

interface RuntimeState {
  status: PluginRuntimeStatus;
  crashTimes: number[];
  backoffUntil: number;
  startPromise: Promise<PluginRow | null> | null;
  tail: string | null;
  adopted: boolean;
}

export function createPluginHost(opts: {
  instances?: InstanceManagerLike | null;
  _crashWindowMs?: number;
  _backoffUnitMs?: number;
  _supervisorOpts?: Omit<Parameters<typeof createSupervisor>[0], 'onExit'>;
} = {}) {
  const {
    instances = null,
    _crashWindowMs = CRASH_WINDOW_MS,
    _backoffUnitMs = BACKOFF_UNIT_MS,
    _supervisorOpts = {},
  } = opts;
  // Discovery catalog: rebuilt by rescan(). `entries` keeps every
  // manifest-bearing dir (including invalid ones, for listing); `byId`
  // indexes only usable ids (states ok/conflict).
  let entries: PluginEntry[] = [];
  let byId = new Map<string, PluginEntry>();

  // In-memory runtime per id: status stopped|starting|ready|crashed|failed,
  // crash bookkeeping for backoff, the in-flight start dedupe promise, and
  // the last crash tail for 503 bodies.
  const rt = new Map<string, RuntimeState>();

  let serverPort: number | null = null;
  let initPromise: Promise<void> | null = null;
  let initedFor: string | null = null; // projectsRoot() the current state was built for (test roots swap)

  // Convention/role/claudePlugin contributions live in their own collaborator;
  // the registry hands it narrow accessors over its discovery + persisted state
  // and keeps no cache of its own. Declared before its first use — the injected
  // accessors are hoisted `function` declarations, and nothing runs during
  // construction.
  const contributions = createContributions({ ensureInit, contributingEntries, resolveCwd });
  // Persisted state, loaded by init(). Every registry.json write signals the
  // contributions cache from the store's single save path.
  const store = createPluginStore({ onRegistryChange: () => contributions.noteRegistryChange() });

  const supervisor = createSupervisor({ onExit: handleChildExit, ..._supervisorOpts });

  function runtimeState(id: string): RuntimeState {
    let s = rt.get(id);
    if (!s) { s = { status: 'stopped', crashTimes: [], backoffUntil: 0, startPromise: null, tail: null, adopted: false }; rt.set(id, s); }
    return s;
  }

  // ── init / discovery ────────────────────────────────────────────────
  // Memoized per projectsRoot() — but NOT on rejection: caching a rejected
  // promise here would mean one transient init failure (e.g. a boot-time
  // EMFILE/EIO inside adoptRunning()) permanently poisons every subsequent
  // plugin-host call for the life of the process, with no retry. The `.catch`
  // clears `initPromise` before rethrowing so the NEXT call reinitializes;
  // it does not swallow or alter the rejection itself.
  function ensureInit(): Promise<void> {
    if (initPromise && initedFor === projectsRoot()) return initPromise;
    initedFor = projectsRoot();
    rt.clear();
    initPromise = (async () => {
      await store.load();
      await rescanInternal();
      await adoptRunning();
    })().catch(e => { initPromise = null; throw e; });
    return initPromise;
  }

  async function rescanInternal(): Promise<void> {
    contributions.invalidate();
    const projects = await listProjects();
    const found: Array<{ project: string; dir: string; system: string; result: Exclude<ReadManifestResult, null>; manifestSource: ManifestSource }> = [];
    for (const p of projects) {
      // Through the project's System. A project whose system cannot be reached
      // contributes no plugin — and, critically, does NOT fall back to reading
      // cc's own disk at the same path, which would register whatever happens
      // to sit there as this project's plugin.
      const { system, unreachable } = await tryResolveSystem(p.name);
      if (!system) {
        console.warn(`plugins: skipped '${p.name}' — ${unreachable}`);
        continue;
      }
      let result = await readManifest(system, p.path);
      let manifestSource: ManifestSource = { type: 'main' };
      // Bootstrap fallback: a project whose main checkout has NO manifest
      // file at all may still be a plugin-in-progress living in an unmerged
      // worktree (first-time plugin-ification). A present-but-invalid main
      // manifest keeps its `invalid` state — never masked by a worktree.
      if (result === null) {
        const fallback = await worktreeManifestFallback(system, p.name);
        if (fallback) ({ result, manifestSource } = fallback);
      }
      if (result === null) continue;
      found.push({ project: p.name, dir: p.path, system: system.id, result, manifestSource });
    }
    // Every discovered plugin project (valid, invalid, or conflicting
    // manifest — being discovered at all is what matters here) joins
    // CC-Dev if it isn't assigned anywhere yet. Runs on every rescan/boot;
    // the workspace==null guard inside makes repeats a no-op.
    for (const f of found) {
      await autoAssignToCcDev(f.project);
    }
    // Deterministic conflict resolution: first alphabetical project wins.
    found.sort((a, b) => a.project.localeCompare(b.project));
    const next: PluginEntry[] = [];
    const nextById = new Map<string, PluginEntry>();
    for (const f of found) {
      const { result, manifestSource } = f;
      if ('errors' in result) {
        next.push({
          id: result.id ?? null, project: f.project, dir: f.dir, system: f.system,
          manifest: null, manifestSource,
          discoveryState: result.incompatible ? 'incompatible' : 'invalid',
          errors: result.errors,
        });
        continue;
      }
      const m = result.manifest;
      const existing = nextById.get(m.id);
      if (existing) {
        next.push({ id: m.id, project: f.project, dir: f.dir, system: f.system, manifest: m, manifestSource, discoveryState: 'conflict', errors: [`duplicate id '${m.id}' — already provided by project '${existing.project}'`] });
        continue;
      }
      const entry: PluginEntry = { id: m.id, project: f.project, dir: f.dir, system: f.system, manifest: m, manifestSource, discoveryState: 'ok', errors: [] };
      next.push(entry);
      nextById.set(m.id, entry);
    }
    entries = next;
    byId = nextById;
  }

  // First VALID manifest among the project's worktrees, in sorted-name order.
  // Reads the worktree store metadata directly (no git spawns — this runs
  // for every manifest-less project on every rescan); a stale entry's
  // worktreePath has no manifest and is skipped.
  async function worktreeManifestFallback(system: System, projectName: string): Promise<{ result: Exclude<ReadManifestResult, null>; manifestSource: ManifestSource } | null> {
    const wtDir = path.join(projectStoreDir(projectName), 'worktrees');
    let names: string[];
    try { names = (await fs.readdir(wtDir)).sort((a, b) => a.localeCompare(b)); }
    catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
    if (names.length === 0) return null;
    const { readWorktreeMeta } = await import('../worktrees.ts');
    for (const name of names) {
      const meta = await readWorktreeMeta(projectName, name).catch(() => null);
      if (!meta?.worktreePath) continue;
      const result = await readManifest(system, meta.worktreePath);
      if (result && !('errors' in result)) {
        return { result, manifestSource: { type: 'worktree', name } };
      }
    }
    return null;
  }

  // Adopt-don't-drain: a recorded child whose pid is alive and answering on
  // its recorded port is adopted as ready; anything else is cleared.
  // The store owns the record pruning + its single write; the liveness test and
  // the lifecycle mutation stay here, where the discovery catalog and the
  // runtime state live. The predicate's && order is load-bearing: probeAnswers
  // does real I/O with a 1 s timeout, so it must stay last.
  async function adoptRunning(): Promise<void> {
    const adopted = await store.adopt({
      isAdoptable: async (id, rec) => {
        const entry = byId.get(id);
        return store.isEnabled(id) && !!entry && pidAlive(rec.pid) && await probeAnswers(rec.port, entry.manifest);
      },
    });
    for (const id of adopted) {
      const s = runtimeState(id);
      s.status = 'ready';
      s.adopted = true;
    }
  }

  async function probeAnswers(port: number, manifest: PluginManifest | null | undefined): Promise<boolean> {
    if (!port) return false;
    if (manifest?.backend?.healthPath) return httpOk(port, manifest.backend.healthPath);
    try { await waitForPort(port, { timeoutMs: 1000, intervalMs: 200 }); return true; }
    catch { return false; }
  }

  // ── crash bookkeeping ───────────────────────────────────────────────
  function recordCrash(id: string, tail: string | null): void {
    const s = runtimeState(id);
    const now = Date.now();
    s.crashTimes = s.crashTimes.filter(t => now - t < _crashWindowMs);
    s.crashTimes.push(now);
    s.tail = tail ?? s.tail;
    if (s.crashTimes.length >= CRASH_LIMIT) {
      s.status = 'failed';
    } else {
      s.status = 'crashed';
      s.backoffUntil = now + Math.min(2 ** s.crashTimes.length, BACKOFF_CAP_UNITS) * _backoffUnitMs;
    }
  }

  // Supervisor exit callback. Pre-ready crashes ('crashed') are observed by
  // the in-flight doStart() poll — handling them here too would double-count.
  // Post-ready exits ('exited') have no watcher, so this is where they land.
  function handleChildExit(id: string, info: ChildRuntime): void {
    if (info.status !== 'exited') return;
    store.clearRuntimeDetached(id);
    recordCrash(id, `${info.error}\n${(info.output ?? '').slice(-2000)}`);
  }

  // A dead child discovered passively (status probe, proxy upstream error).
  function markDead(id: string, reason: string): void {
    store.clearRuntimeDetached(id);
    recordCrash(id, reason);
  }

  // ── lookups ─────────────────────────────────────────────────────────
  function requireEntry(id: string): PluginEntry {
    const entry = byId.get(id);
    if (entry) return entry;
    // byId indexes only usable ids — a known-but-unusable manifest still
    // deserves a 409 with its errors rather than a bare 404.
    const broken = entries.find(e => e.id === id);
    if (broken) throw httpError(409, `plugin '${id}' is not usable (${broken.discoveryState}): ${broken.errors.join('; ')}`);
    throw httpError(404, `unknown plugin '${id}'`);
  }

  function requireEnabled(id: string): PluginEntry {
    const entry = requireEntry(id);
    if (!store.isEnabled(id)) throw httpError(409, `plugin '${id}' is not enabled`);
    return entry;
  }

  // A persisted worktree activeVersion can outlive the worktree itself
  // (deleted via removeWorktree, or its store entry pruned). Detect that
  // here — the one place both describeRow (status) and resolveCwd (start)
  // read activeVersion — and self-heal back to main so neither has to
  // special-case staleness, and a plugin stuck on a dead worktree recovers
  // without hand-editing registry.json.
  async function reconcileActiveVersion(entry: VersionedEntry): Promise<{ activeVersion: ManifestSource; worktreeMeta: WorktreeMeta | null }> {
    const id = entry.id;
    const reg = id ? store.get(id) : undefined;
    const av = reg?.activeVersion ?? { type: 'main' };
    if (av.type !== 'worktree') return { activeVersion: av, worktreeMeta: null };
    // Never string-assemble worktree paths — resolve via the store metadata.
    const { getWorktree } = await import('../worktrees.ts');
    const meta = await getWorktree(entry.project, av.name);
    if (meta?.worktreePath) return { activeVersion: av, worktreeMeta: meta };
    // Reaching here means `av` came from a record, so `id` is non-null.
    if (id) await store.setActiveVersion(id, { type: 'main' });
    return { activeVersion: { type: 'main' }, worktreeMeta: null };
  }

  async function resolveCwd(entry: VersionedEntry): Promise<string> {
    const { activeVersion, worktreeMeta } = await reconcileActiveVersion(entry);
    return activeVersion.type === 'worktree' && worktreeMeta
      ? worktreeMeta.worktreePath
      : entry.dir;
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  async function enable(id: string): Promise<PluginRow | null> {
    await ensureInit();
    const entry = requireEntry(id);
    const prev = store.get(id);
    // A worktree-sourced plugin (manifest only in an unmerged worktree)
    // must default its active version to that worktree — the main checkout
    // has nothing to start.
    const defaultVersion: ManifestSource = entry.manifestSource?.type === 'worktree'
      ? { type: 'worktree', name: entry.manifestSource.name }
      : { type: 'main' };
    await store.upsert(id, {
      project: entry.project,
      enabled: true,
      activeVersion: prev?.activeVersion ?? defaultVersion,
    });
    // A fragment edited while this plugin was disabled must not keep serving
    // its pre-edit body now that enable makes it contribute again.
    contributions.invalidate();
    // Manual re-enable is the recovery path out of `failed`.
    const s = runtimeState(id);
    if (s.status === 'failed' || s.status === 'crashed') { s.status = 'stopped'; s.crashTimes = []; s.backoffUntil = 0; }
    await autoAssignToCcDev(entry.project);
    return describe(id);
  }

  async function disable(id: string): Promise<PluginRow | null> {
    await ensureInit();
    if (!store.has(id)) throw httpError(404, `plugin '${id}' has no registry entry`);
    await stopInternal(id);
    await store.setEnabled(id, false);
    return describe(id);
  }

  // Deduped start: concurrent callers (proxy requests, MCP calls) share one
  // in-flight promise; it resolves once the child is ready or throws with
  // the crash tail.
  function doStart(id: string): Promise<PluginRow | null> {
    const s = runtimeState(id);
    if (s.startPromise) return s.startPromise;
    s.startPromise = (async () => {
      contributions.invalidate();
      const entry = requireEnabled(id);
      // BUCKET 3. A plugin backend is a long-lived process started in the
      // project dir, talking to cc on a LOCAL port. Crossing to a system needs
      // remote process lifecycle plus a port forwarded back here, neither of
      // which exists — so this is refused with its own code rather than started
      // in a directory that belongs to another machine. The row carries the same
      // code, so the UI hides the control instead of offering a button that
      // always fails.
      if (entry.system !== LOCAL_SYSTEM_ID) {
        throw httpError(
          501,
          `PLUGIN_BACKEND_LOCAL_ONLY: plugin '${id}' lives in project '${entry.project}' on system `
          + `'${entry.system}', and a plugin backend runs only on the machine cc runs on`,
        );
      }
      const cwd = await resolveCwd(entry);
      // Re-read the manifest from the active checkout — contributions follow
      // the running version, and a checkout that stopped being this plugin
      // must not start under its id.
      const result = await readManifest(await resolveSystem(entry.project), cwd);
      if (!result) throw httpError(400, `no ${path.basename(cwd)}/conductor.plugin.json in the active checkout`);
      if ('errors' in result) throw httpError(400, `manifest in active checkout is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in active checkout does not match plugin '${id}'`);
      entry.manifest = result.manifest;
      // Not covered by the contributions.invalidate() at the top of this body:
      // the manifest is REASSIGNED here, ten lines later, and its `conventions`
      // list is exactly what conventions() reads.
      contributions.noteRegistryChange();
      const backend = result.manifest.backend;
      if (!backend) throw httpError(400, `plugin '${id}' has no backend to start`);

      s.status = 'starting';
      s.adopted = false;
      // Inject the conductor's *resolved* projects root + its own checkout dir
      // explicitly (not via inheritance): a plugin reads projectsRoot()'s
      // authoritative value even in the default case where the conductor's own
      // env never set PROJECTS_ROOT, and locates the conductor even when its
      // checkout lives outside projectsRoot().
      const env: Record<string, string> = {
        PROJECTS_ROOT: projectsRoot(),
        CONDUCTOR_PROJECT_DIR: selfProjectDir(),
        ...(serverPort ? { CONDUCTOR_URL: `http://127.0.0.1:${serverPort}` } : {}),
      };
      const rec = await supervisor.start({ id, manifest: { backend }, cwd, env });
      await store.recordStart(id, rec);

      const settled = await waitSettled(id);
      if (settled.status !== 'ready') {
        await store.clearRuntime(id);
        const tail = settled.error ?? settled.output?.slice(-2000) ?? '';
        recordCrash(id, tail);
        throw httpError(502, `plugin '${id}' failed to start`, { tail });
      }
      s.status = 'ready';
      s.tail = null;
      return describe(id);
    })();
    s.startPromise.finally(() => { s.startPromise = null; }).catch(() => {});
    return s.startPromise;
  }

  // Poll the supervisor runtime until readiness settles one way or the other.
  async function waitSettled(id: string, { timeoutMs = 35_000 }: { timeoutMs?: number } = {}): Promise<ChildRuntime | { status: 'crashed'; error: string; output?: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = supervisor.runtime(id);
      if (!r) return { status: 'crashed', error: 'child record vanished' };
      if (r.status !== 'starting') return r;
      if (Date.now() >= deadline) return { status: 'crashed', error: 'readiness poll timed out', output: r.output };
      await new Promise(res => setTimeout(res, 50));
    }
  }

  async function start(id: string): Promise<PluginRow | null> {
    await ensureInit();
    requireEnabled(id);
    const s = runtimeState(id);
    if (s.status === 'ready') return describe(id);
    // Explicit start is a manual recovery action — clear crash history.
    s.crashTimes = []; s.backoffUntil = 0;
    if (s.status === 'failed' || s.status === 'crashed') s.status = 'stopped';
    return doStart(id);
  }

  async function stopInternal(id: string): Promise<void> {
    const rec = store.runtimeRecord(id);
    const s = runtimeState(id);
    if (rec) {
      supervisor.stop({ id, pgid: rec.pgid });
      await store.clearRuntime(id);
    }
    if (s.status !== 'failed') s.status = 'stopped';
  }

  async function stop(id: string): Promise<PluginRow | null> {
    await ensureInit();
    if (!byId.get(id) && !store.has(id)) throw httpError(404, `unknown plugin '${id}'`);
    await stopInternal(id);
    return describe(id);
  }

  // The lazy-start gate used by the proxy and the MCP bridge. Resolves once
  // the plugin is ready (requests wait through the readiness poll window in `waitSettled`);
  // throws 503 when the plugin can't serve.
  async function ensureStarted(id: string): Promise<void> {
    await ensureInit();
    const entry = byId.get(id);
    if (!entry || !store.isEnabled(id)) throw httpError(404, `unknown or disabled plugin '${id}'`);
    const s = runtimeState(id);
    if (s.status === 'ready') return;
    if (s.status === 'failed') {
      throw httpError(503, `plugin '${id}' is failed (${CRASH_LIMIT} crashes in ${Math.round(_crashWindowMs / 1000)}s) — re-enable or start it manually`, { status: 'failed', tail: s.tail });
    }
    if (s.status === 'crashed' && Date.now() < s.backoffUntil) {
      const retryAfter = Math.ceil((s.backoffUntil - Date.now()) / 1000);
      throw httpError(503, `plugin '${id}' crashed — restarting is backed off, retry in ${retryAfter}s`, { status: 'crashed', tail: s.tail, retryAfter });
    }
    await doStart(id);
  }

  // ── views ───────────────────────────────────────────────────────────
  function describe(id: string): Promise<PluginRow> | null {
    const entry = byId.get(id) ?? entries.find(e => e.id === id) ?? null;
    if (entry) return describeRow(entry);
    const reg = store.get(id);
    if (!reg) return null;
    return describeRow({ id, project: reg.project, dir: '', system: LOCAL_SYSTEM_ID, manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] });
  }

  // Gathers the five owners the projection reads (discovery entry, persisted
  // record, runtime state, runtime record, resolved active version) and hands
  // them to the pure view-model in row.ts.
  async function describeRow(entry: PluginEntry): Promise<PluginRow> {
    const id = entry.id;
    const { activeVersion, worktreeMeta } = await reconcileActiveVersion(entry);
    // Pure, no I/O — hoisting it out of the staleness branch it used to sit in
    // costs nothing; the git spawn itself stays behind that branch, in row.ts.
    const cwd = activeVersion.type === 'worktree' && worktreeMeta
      ? worktreeMeta.worktreePath
      : entry.dir;
    return buildPluginRow({
      entry,
      reg: id ? store.get(id) ?? null : null,
      runtime: id ? runtimeState(id) : null,
      record: id ? store.runtimeRecord(id) ?? null : null,
      activeVersion,
      cwd,
    });
  }

  async function list(): Promise<PluginRow[]> {
    await ensureInit();
    const rowPromises: Array<Promise<PluginRow>> = entries.map(describeRow);
    // Registry entries whose project/manifest vanished still deserve a row
    // (they hold state the user may want to disable).
    for (const [id, reg] of store.entries()) {
      if (!entries.some(e => e.id === id)) {
        rowPromises.push(describeRow({ id, project: reg.project, dir: '', system: LOCAL_SYSTEM_ID, manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] }));
      }
    }
    return Promise.all(rowPromises);
  }

  async function rescan(): Promise<PluginRow[]> {
    await ensureInit();
    await rescanInternal();
    return list();
  }

  // Merged row + live probe: catches children that died silently (Doze,
  // OOM-kill) since the last event we saw.
  async function status(id: string): Promise<PluginRow | null> {
    await ensureInit();
    if (!byId.get(id) && !store.has(id)) throw httpError(404, `unknown plugin '${id}'`);
    const s = runtimeState(id);
    const rec = store.runtimeRecord(id);
    if (s.status === 'ready' && rec) {
      const entry = byId.get(id);
      const answers = await probeAnswers(rec.port, entry?.manifest);
      if (!answers && !pidAlive(rec.pid)) {
        markDead(id, s.tail ?? `process ${rec.pid} died silently`);
      }
    }
    return describe(id);
  }

  // Proxy hook: an upstream connection error may mean the child is gone.
  function reportUpstreamFailure(id: string): void {
    const rec = store.runtimeRecord(id);
    const s = rt.get(id);
    if (!rec || !s || s.status !== 'ready') return;
    if (!pidAlive(rec.pid)) markDead(id, s.tail ?? `process ${rec.pid} died (upstream connection failed)`);
  }

  // Worktree-version activation: which checkout the supervisor cwd points
  // at. Guard: the target checkout must contain a valid manifest with a
  // matching id, else 400 and the previous state is kept. Restarts the
  // child when it was running so the switch takes effect immediately.
  async function setActiveVersion(id: string, v: unknown): Promise<PluginRow | null> {
    await ensureInit();
    const entry = requireEntry(id);
    if (!store.has(id)) throw httpError(409, `plugin '${id}' has no registry entry — enable it first`);
    const ver = v as { type?: unknown; name?: unknown } | null | undefined;
    let next: ManifestSource;
    if (ver?.type === 'main') {
      // Same pre-validation as the worktree target: the main checkout must
      // actually BE this plugin (a worktree-sourced plugin's main checkout
      // has no manifest until the worktree lands).
      const result = await readManifest(await resolveSystem(entry.project), entry.dir);
      if (!result) throw httpError(400, `the main checkout of '${entry.project}' has no conductor.plugin.json`);
      if ('errors' in result) throw httpError(400, `manifest in the main checkout is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in the main checkout does not match plugin '${id}'`);
      next = { type: 'main' };
    } else if (ver?.type === 'worktree') {
      if (typeof ver.name !== 'string' || ver.name === '') throw httpError(400, "worktree version requires a 'name'");
      const { getWorktree } = await import('../worktrees.ts');
      const meta = await getWorktree(entry.project, ver.name);
      if (!meta?.worktreePath) throw httpError(404, `worktree '${ver.name}' of project '${entry.project}' not found`);
      const result = await readManifest(await resolveSystem(entry.project), meta.worktreePath);
      if (!result) throw httpError(400, `no conductor.plugin.json in worktree '${ver.name}'`);
      if ('errors' in result) throw httpError(400, `manifest in worktree '${ver.name}' is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in worktree '${ver.name}' does not match plugin '${id}'`);
      // Persist the canonical name: reconcileActiveVersion re-resolves this
      // on load, and the GUI matches its option values on it.
      next = { type: 'worktree', name: meta.worktreeName };
    } else {
      throw httpError(400, "version must be {type:'main'} or {type:'worktree', name}");
    }
    await store.setActiveVersion(id, next);
    contributions.invalidate();
    const s = runtimeState(id);
    if (s.status === 'ready' || s.status === 'starting') {
      if (s.startPromise) await s.startPromise.catch(() => {});
      await stopInternal(id);
      await doStart(id);
    }
    return describe(id);
  }

  // Manual pick-up of new code in the active checkout: stop the running
  // child and start it again (re-reads the manifest + recomputes gitHead via
  // doStart/supervisor.start, same as setActiveVersion's restart branch).
  async function restart(id: string): Promise<PluginRow | null> {
    await ensureInit();
    requireEnabled(id);
    const s = runtimeState(id);
    if (s.status !== 'ready' && s.status !== 'starting') {
      throw httpError(409, `plugin '${id}' is not running`);
    }
    if (s.startPromise) await s.startPromise.catch(() => {});
    await stopInternal(id);
    return doStart(id);
  }

  // MCP forwarding lives in a composed collaborator; the registry only
  // hands it narrow accessors over its own state.
  const mcpBridge = createMcpBridge({
    instances,
    listMcpPlugins: () => [...byId.values()].filter((e): e is PluginEntry & { id: string; manifest: PluginManifest & { mcp: PluginMcp } } =>
      e.discoveryState === 'ok' && typeof e.id === 'string' && e.manifest !== null && e.manifest.mcp != null
        && store.isEnabled(e.id)),
    ensureStarted,
    portFor: (id: string) => store.runtimeRecord(id)?.port ?? null,
    reportUpstreamFailure,
  });
  const toolsFor = () => mcpBridge.toolsFor();

  function runtimeInfo(id: string): { status: string; port: number | null } {
    const rec = store.runtimeRecord(id);
    const s = rt.get(id);
    return { status: s?.status ?? 'stopped', port: rec?.port ?? null };
  }

  // ── convention contributions ────────────────────────────────────────
  // The registry's half of the contributions collaborator: which plugins get to
  // contribute at all. Only enabled + `ok` plugins do — a crashed/disabled/
  // invalid plugin never surfaces its conventions, roles or claudePlugin roots.
  // Stays here because it reads BOTH the discovery catalog and the persisted
  // records, neither of which the collaborator owns.
  function contributingEntries(): Array<PluginEntry & { id: string; manifest: PluginManifest }> {
    return [...byId.values()].filter((e): e is PluginEntry & { id: string; manifest: PluginManifest } =>
      e.discoveryState === 'ok' && typeof e.id === 'string' && e.manifest !== null && store.isEnabled(e.id));
  }

  function setServerPort(p: number | null): void { serverPort = p; }

  // Test/shutdown teardown: kill every child this host started or adopted.
  // No `!initPromise` early return: a FAILED init still clears `initPromise`
  // to null (see ensureInit) but can leave the store's runtime records already
  // loaded with live backends from a previous process (store.load() runs before
  // rescanInternal()/adoptRunning()) — "never initialized" is no longer the only
  // reason `initPromise` can be null. The record set starts empty, so skipping
  // the await when init never ran is just as correct as awaiting it.
  async function stopAll(): Promise<void> {
    try { if (initPromise) await initPromise; } catch { /* init failed; stop whatever was already recorded */ }
    for (const id of store.runtimeIds()) {
      try { await stopInternal(id); } catch { /* best-effort */ }
    }
  }

  return {
    init: ensureInit,
    list, rescan, enable, disable, start, stop, restart, status,
    ensureStarted, setActiveVersion, toolsFor, runtimeInfo,
    conventions: contributions.conventions,
    roles: contributions.roles,
    claudePluginDirs: contributions.claudePluginDirs,
    reportUpstreamFailure, setServerPort, stopAll,
    notices: store.notices,
  };
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
