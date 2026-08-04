import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  projectsRoot, selfProjectDir, orchStoreRoot, writeFileAtomic, listProjects, projectStoreDir,
  readProjectMeta, writeProjectMeta, addWorkspace,
} from '../projects.ts';
import {
  readManifest, SUPPORTED_CONVENTION_SCOPES, claudePluginPaths,
  type PluginManifest, type PluginMcp, type ReadManifestResult,
} from './manifest.ts';
import { createSupervisor, httpOk, headSha, type ChildRuntime } from './supervisor.ts';
import { createMcpBridge } from './mcpBridge.ts';
import { pidAlive, waitForPort } from './ports.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import type { WorktreeMeta } from '../worktrees.ts';

// Plugin registry — the single service layer behind the REST api
// (src/plugins/api.js), the reverse proxy (src/plugins/proxy.ts) and MCP
// forwarding (src/plugins/mcpBridge.ts). Owns discovery, the persisted
// registry/runtime files, lifecycle state and lazy starts.
//
// On-disk state (all under `<orchStoreRoot()>/plugins/`):
//   registry.json  {plugins: {<id>: {project, enabled, activeVersion}}}
//   runtime.json   {<id>: {pid, pgid, port, startedAt, gitHead}}
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
// Exported so server.js can reuse the same literal for the conductor's own
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

// Exported for reuse by sibling collaborators (e.g. library.js) that need
// the same statusCode-bearing Error shape without duplicating it.
export function httpError(status: number, message: string, extra: Record<string, unknown> = {}): Error & { statusCode: number } {
  const e = Object.assign(new Error(message), { statusCode: status }, extra);
  return e;
}

type ManifestSource = { type: 'main' } | { type: 'worktree'; name: string };

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
  manifest: PluginManifest | null;
  manifestSource?: ManifestSource;
  discoveryState: 'ok' | 'invalid' | 'incompatible' | 'conflict';
  errors: string[];
}

interface PersistedPluginRecord {
  project: string;
  enabled: boolean;
  activeVersion?: ManifestSource;
}

interface RuntimeRecord {
  pid: number;
  pgid: number;
  port: number;
  startedAt: string;
  gitHead: string | null;
}

type PluginRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'crashed' | 'failed';

interface RuntimeState {
  status: PluginRuntimeStatus;
  crashTimes: number[];
  backoffUntil: number;
  startPromise: Promise<PluginRow | null> | null;
  tail: string | null;
  adopted: boolean;
}

interface PluginRow {
  id: string | null;
  name: string;
  project: string;
  version: string | null;
  state: string;
  enabled: boolean;
  activeVersion: ManifestSource;
  manifestSource: ManifestSource;
  hasBackend: boolean;
  hasFrontend: boolean;
  navLabel: string | null;
  frontendPath: string | null;
  hasMcp: boolean;
  conventions: Array<{ slug: string; name: string; description: string; hasScaffold: boolean }>;
  roles: Array<{ slug: string; name: string }>;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  gitHead: string | null;
  stale: boolean;
  errors: string[];
  crashTail: string | null;
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

  // Persisted state, loaded by init().
  let persisted: { plugins: Record<string, PersistedPluginRecord> } = { plugins: {} };
  let runtimeRecords: Record<string, RuntimeRecord> = {};

  // In-memory runtime per id: status stopped|starting|ready|crashed|failed,
  // crash bookkeeping for backoff, the in-flight start dedupe promise, and
  // the last crash tail for 503 bodies.
  const rt = new Map<string, RuntimeState>();

  let serverPort: number | null = null;
  let initPromise: Promise<void> | null = null;
  let initedFor: string | null = null; // projectsRoot() the current state was built for (test roots swap)

  const supervisor = createSupervisor({ onExit: handleChildExit, ..._supervisorOpts });

  function runtimeState(id: string): RuntimeState {
    let s = rt.get(id);
    if (!s) { s = { status: 'stopped', crashTimes: [], backoffUntil: 0, startPromise: null, tail: null, adopted: false }; rt.set(id, s); }
    return s;
  }

  // ── persistence ─────────────────────────────────────────────────────
  const registryFile = (): string => path.join(orchStoreRoot(), 'plugins', 'registry.json');
  const runtimeFile = (): string => path.join(orchStoreRoot(), 'plugins', 'runtime.json');

  async function loadJson(file: string, fallback: unknown): Promise<unknown> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) {
      if (errCode(e) !== 'ENOENT') console.warn(`plugins: failed to read ${file}: ${errMsg(e)}`);
      return fallback;
    }
  }

  async function saveRegistry(): Promise<void> {
    await writeFileAtomic(registryFile(), JSON.stringify(persisted, null, 2) + '\n');
  }

  async function saveRuntimeRecords(): Promise<void> {
    await writeFileAtomic(runtimeFile(), JSON.stringify(runtimeRecords, null, 2) + '\n');
  }

  // ── init / discovery ────────────────────────────────────────────────
  function ensureInit(): Promise<void> {
    if (initPromise && initedFor === projectsRoot()) return initPromise;
    initedFor = projectsRoot();
    rt.clear();
    initPromise = (async () => {
      persisted = (await loadJson(registryFile(), { plugins: {} })) as { plugins: Record<string, PersistedPluginRecord> };
      if (typeof persisted?.plugins !== 'object' || persisted.plugins === null) persisted = { plugins: {} };
      runtimeRecords = (await loadJson(runtimeFile(), {})) as Record<string, RuntimeRecord>;
      await rescanInternal();
      await adoptRunning();
    })();
    return initPromise;
  }

  async function rescanInternal(): Promise<void> {
    const projects = await listProjects();
    const found: Array<{ project: string; dir: string; result: Exclude<ReadManifestResult, null>; manifestSource: ManifestSource }> = [];
    for (const p of projects) {
      let result = await readManifest(p.path);
      let manifestSource: ManifestSource = { type: 'main' };
      // Bootstrap fallback: a project whose main checkout has NO manifest
      // file at all may still be a plugin-in-progress living in an unmerged
      // worktree (first-time plugin-ification). A present-but-invalid main
      // manifest keeps its `invalid` state — never masked by a worktree.
      if (result === null) {
        const fallback = await worktreeManifestFallback(p.name);
        if (fallback) ({ result, manifestSource } = fallback);
      }
      if (result === null) continue;
      found.push({ project: p.name, dir: p.path, result, manifestSource });
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
          id: result.id ?? null, project: f.project, dir: f.dir, manifest: null, manifestSource,
          discoveryState: result.incompatible ? 'incompatible' : 'invalid',
          errors: result.errors,
        });
        continue;
      }
      const m = result.manifest;
      const existing = nextById.get(m.id);
      if (existing) {
        next.push({ id: m.id, project: f.project, dir: f.dir, manifest: m, manifestSource, discoveryState: 'conflict', errors: [`duplicate id '${m.id}' — already provided by project '${existing.project}'`] });
        continue;
      }
      const entry: PluginEntry = { id: m.id, project: f.project, dir: f.dir, manifest: m, manifestSource, discoveryState: 'ok', errors: [] };
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
  async function worktreeManifestFallback(projectName: string): Promise<{ result: Exclude<ReadManifestResult, null>; manifestSource: ManifestSource } | null> {
    const wtDir = path.join(projectStoreDir(projectName), 'worktrees');
    let names: string[];
    try { names = (await fs.readdir(wtDir)).sort((a, b) => a.localeCompare(b)); }
    catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
    if (names.length === 0) return null;
    const { readWorktreeMeta } = await import('../worktrees.ts');
    for (const name of names) {
      const meta = await readWorktreeMeta(projectName, name).catch(() => null);
      if (!meta?.worktreePath) continue;
      const result = await readManifest(meta.worktreePath);
      if (result && !('errors' in result)) {
        return { result, manifestSource: { type: 'worktree', name } };
      }
    }
    return null;
  }

  // Adopt-don't-drain: a recorded child whose pid is alive and answering on
  // its recorded port is adopted as ready; anything else is cleared.
  async function adoptRunning(): Promise<void> {
    let dirty = false;
    for (const [id, rec] of Object.entries(runtimeRecords)) {
      const entry = byId.get(id);
      const enabled = persisted.plugins[id]?.enabled === true;
      const alive = enabled && entry && pidAlive(rec.pid) && await probeAnswers(rec.port, entry.manifest);
      if (alive) {
        const s = runtimeState(id);
        s.status = 'ready';
        s.adopted = true;
      } else {
        delete runtimeRecords[id];
        dirty = true;
      }
    }
    if (dirty) await saveRuntimeRecords();
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
    delete runtimeRecords[id];
    saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${errMsg(e)}`));
    recordCrash(id, `${info.error}\n${(info.output ?? '').slice(-2000)}`);
  }

  // A dead child discovered passively (status probe, proxy upstream error).
  function markDead(id: string, reason: string): void {
    delete runtimeRecords[id];
    saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${errMsg(e)}`));
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
    if (persisted.plugins[id]?.enabled !== true) throw httpError(409, `plugin '${id}' is not enabled`);
    return entry;
  }

  // A persisted worktree activeVersion can outlive the worktree itself
  // (deleted via removeWorktree, or its store entry pruned). Detect that
  // here — the one place both describeRow (status) and resolveCwd (start)
  // read activeVersion — and self-heal back to main so neither has to
  // special-case staleness, and a plugin stuck on a dead worktree recovers
  // without hand-editing registry.json.
  async function reconcileActiveVersion(entry: PluginEntry): Promise<{ activeVersion: ManifestSource; worktreeMeta: WorktreeMeta | null }> {
    const id = entry.id;
    const reg = id ? persisted.plugins[id] : null;
    const av = reg?.activeVersion ?? { type: 'main' };
    if (av.type !== 'worktree') return { activeVersion: av, worktreeMeta: null };
    // Never string-assemble worktree paths — resolve via the store metadata.
    const { getWorktree } = await import('../worktrees.ts');
    const meta = await getWorktree(entry.project, av.name);
    if (meta?.worktreePath) return { activeVersion: av, worktreeMeta: meta };
    if (reg) reg.activeVersion = { type: 'main' };
    await saveRegistry();
    return { activeVersion: { type: 'main' }, worktreeMeta: null };
  }

  async function resolveCwd(entry: PluginEntry): Promise<string> {
    const { activeVersion, worktreeMeta } = await reconcileActiveVersion(entry);
    return activeVersion.type === 'worktree' && worktreeMeta
      ? worktreeMeta.worktreePath
      : entry.dir;
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  async function enable(id: string): Promise<PluginRow | null> {
    await ensureInit();
    const entry = requireEntry(id);
    const prev = persisted.plugins[id];
    // A worktree-sourced plugin (manifest only in an unmerged worktree)
    // must default its active version to that worktree — the main checkout
    // has nothing to start.
    const defaultVersion: ManifestSource = entry.manifestSource?.type === 'worktree'
      ? { type: 'worktree', name: entry.manifestSource.name }
      : { type: 'main' };
    persisted.plugins[id] = {
      project: entry.project,
      enabled: true,
      activeVersion: prev?.activeVersion ?? defaultVersion,
    };
    await saveRegistry();
    // Manual re-enable is the recovery path out of `failed`.
    const s = runtimeState(id);
    if (s.status === 'failed' || s.status === 'crashed') { s.status = 'stopped'; s.crashTimes = []; s.backoffUntil = 0; }
    await autoAssignToCcDev(entry.project);
    return describe(id);
  }

  async function disable(id: string): Promise<PluginRow | null> {
    await ensureInit();
    if (!persisted.plugins[id]) throw httpError(404, `plugin '${id}' has no registry entry`);
    await stopInternal(id);
    persisted.plugins[id].enabled = false;
    await saveRegistry();
    return describe(id);
  }

  // Deduped start: concurrent callers (proxy requests, MCP calls) share one
  // in-flight promise; it resolves once the child is ready or throws with
  // the crash tail.
  function doStart(id: string): Promise<PluginRow | null> {
    const s = runtimeState(id);
    if (s.startPromise) return s.startPromise;
    s.startPromise = (async () => {
      const entry = requireEnabled(id);
      const cwd = await resolveCwd(entry);
      // Re-read the manifest from the active checkout — contributions follow
      // the running version, and a checkout that stopped being this plugin
      // must not start under its id.
      const result = await readManifest(cwd);
      if (!result) throw httpError(400, `no ${path.basename(cwd)}/conductor.plugin.json in the active checkout`);
      if ('errors' in result) throw httpError(400, `manifest in active checkout is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in active checkout does not match plugin '${id}'`);
      entry.manifest = result.manifest;
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
      runtimeRecords[id] = rec;
      await saveRuntimeRecords();

      const settled = await waitSettled(id);
      if (settled.status !== 'ready') {
        delete runtimeRecords[id];
        await saveRuntimeRecords();
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
    const rec = runtimeRecords[id];
    const s = runtimeState(id);
    if (rec) {
      supervisor.stop({ id, pgid: rec.pgid });
      delete runtimeRecords[id];
      await saveRuntimeRecords();
    }
    if (s.status !== 'failed') s.status = 'stopped';
  }

  async function stop(id: string): Promise<PluginRow | null> {
    await ensureInit();
    if (!byId.get(id) && !persisted.plugins[id]) throw httpError(404, `unknown plugin '${id}'`);
    await stopInternal(id);
    return describe(id);
  }

  // The lazy-start gate used by the proxy and the MCP bridge. Resolves once
  // the plugin is ready (requests wait through the readiness poll window in `waitSettled`);
  // throws 503 when the plugin can't serve.
  async function ensureStarted(id: string): Promise<void> {
    await ensureInit();
    const entry = byId.get(id);
    if (!entry || persisted.plugins[id]?.enabled !== true) throw httpError(404, `unknown or disabled plugin '${id}'`);
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
    const reg = persisted.plugins[id];
    if (!entry && !reg) return null;
    return describeRow(entry ?? { id, project: reg.project, dir: '', manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] });
  }

  async function describeRow(entry: PluginEntry): Promise<PluginRow> {
    const id = entry.id;
    const reg = id ? persisted.plugins[id] : null;
    const s = id ? runtimeState(id) : null;
    const rec = id ? runtimeRecords[id] : null;
    const hasBackend = !!entry.manifest?.backend;
    let state: string;
    if (entry.discoveryState !== 'ok') state = entry.discoveryState;
    else if (!reg?.enabled) state = reg ? 'disabled' : 'discovered';
    // A backendless (conventions-only) plugin has no process lifecycle — it is
    // simply 'enabled', never 'stopped', so the UI shows no (broken) Start button.
    else if (!hasBackend) state = 'enabled';
    else state = s?.status ?? 'stopped';
    const { activeVersion, worktreeMeta } = await reconcileActiveVersion(entry);
    // Staleness: only worth a git spawn for a currently-running plugin — the
    // running child's code may have moved past the sha it was started at.
    let stale = false;
    if (state === 'ready' && rec?.gitHead) {
      const cwd = activeVersion.type === 'worktree' && worktreeMeta
        ? worktreeMeta.worktreePath
        : entry.dir;
      const currentHead = await headSha(cwd);
      stale = !!currentHead && currentHead !== rec.gitHead;
    }
    return {
      id,
      name: entry.manifest?.name ?? entry.project,
      project: entry.project,
      version: entry.manifest?.version ?? null,
      state,
      enabled: reg?.enabled === true,
      activeVersion,
      manifestSource: entry.manifestSource ?? { type: 'main' },
      hasBackend,
      hasFrontend: !!entry.manifest?.frontend,
      navLabel: entry.manifest?.frontend?.navLabel ?? null,
      frontendPath: entry.manifest?.frontend?.path ?? null,
      hasMcp: !!entry.manifest?.mcp,
      // Contribution metadata (slugs namespaced <plugin-id>/<slug>).
      // `hasScaffold` flags a convention whose pick triggers a one-time setup
      // directive (returned by create_project) in addition to any fragment.
      conventions: (entry.manifest?.conventions ?? []).map(g => ({ slug: `${id}/${g.slug}`, name: g.name, description: g.description, hasScaffold: !!g.scaffold })),
      roles: (entry.manifest?.roles ?? []).map(r => ({ slug: `${id}/${r.slug}`, name: r.name })),
      port: rec?.port ?? null,
      pid: rec?.pid ?? null,
      startedAt: rec?.startedAt ?? null,
      gitHead: rec?.gitHead ?? null,
      stale,
      errors: entry.errors ?? [],
      crashTail: s?.tail ?? null,
    };
  }

  async function list(): Promise<PluginRow[]> {
    await ensureInit();
    const rowPromises: Array<Promise<PluginRow>> = entries.map(describeRow);
    // Registry entries whose project/manifest vanished still deserve a row
    // (they hold state the user may want to disable).
    for (const [id, reg] of Object.entries(persisted.plugins)) {
      if (!entries.some(e => e.id === id)) {
        rowPromises.push(describeRow({ id, project: reg.project, dir: '', manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] }));
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
    if (!byId.get(id) && !persisted.plugins[id]) throw httpError(404, `unknown plugin '${id}'`);
    const s = runtimeState(id);
    const rec = runtimeRecords[id];
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
    const rec = runtimeRecords[id];
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
    if (!persisted.plugins[id]) throw httpError(409, `plugin '${id}' has no registry entry — enable it first`);
    const ver = v as { type?: unknown; name?: unknown } | null | undefined;
    let next: ManifestSource;
    if (ver?.type === 'main') {
      // Same pre-validation as the worktree target: the main checkout must
      // actually BE this plugin (a worktree-sourced plugin's main checkout
      // has no manifest until the worktree lands).
      const result = await readManifest(entry.dir);
      if (!result) throw httpError(400, `the main checkout of '${entry.project}' has no conductor.plugin.json`);
      if ('errors' in result) throw httpError(400, `manifest in the main checkout is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in the main checkout does not match plugin '${id}'`);
      next = { type: 'main' };
    } else if (ver?.type === 'worktree') {
      if (typeof ver.name !== 'string' || ver.name === '') throw httpError(400, "worktree version requires a 'name'");
      const { getWorktree } = await import('../worktrees.ts');
      const meta = await getWorktree(entry.project, ver.name);
      if (!meta?.worktreePath) throw httpError(404, `worktree '${ver.name}' of project '${entry.project}' not found`);
      const result = await readManifest(meta.worktreePath);
      if (!result) throw httpError(400, `no conductor.plugin.json in worktree '${ver.name}'`);
      if ('errors' in result) throw httpError(400, `manifest in worktree '${ver.name}' is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in worktree '${ver.name}' does not match plugin '${id}'`);
      next = { type: 'worktree', name: ver.name };
    } else {
      throw httpError(400, "version must be {type:'main'} or {type:'worktree', name}");
    }
    persisted.plugins[id].activeVersion = next;
    await saveRegistry();
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
        && persisted.plugins[e.id]?.enabled === true),
    ensureStarted,
    portFor: (id: string) => runtimeRecords[id]?.port ?? null,
    reportUpstreamFailure,
  });
  const toolsFor = (callerId: string) => mcpBridge.toolsFor(callerId);

  function runtimeInfo(id: string): { status: string; port: number | null } {
    const rec = runtimeRecords[id];
    const s = rt.get(id);
    return { status: s?.status ?? 'stopped', port: rec?.port ?? null };
  }

  // ── convention contributions ────────────────────────────────────────
  // Only enabled + `ok` plugins contribute (a crashed/disabled/invalid plugin
  // never surfaces its conventions). Bodies are resolved from the active
  // checkout; a fragment path that vanished after load is skipped with a
  // warning (manifest load already rejects missing files).
  const fragmentBodyCache = new Map<string, string>(); // abs path -> body
  async function readFragment(abs: string): Promise<string> {
    const cached = fragmentBodyCache.get(abs);
    if (cached !== undefined) return cached;
    const body = (await fs.readFile(abs, 'utf8')).replace(/\s+$/, '');
    fragmentBodyCache.set(abs, body);
    return body;
  }

  function contributingEntries(): Array<PluginEntry & { id: string; manifest: PluginManifest }> {
    return [...byId.values()].filter((e): e is PluginEntry & { id: string; manifest: PluginManifest } =>
      e.discoveryState === 'ok' && typeof e.id === 'string' && e.manifest !== null && persisted.plugins[e.id]?.enabled === true);
  }

  // Convention entries contributed by enabled plugins, GROUPED BY SCOPE so
  // each scope routes to its own catalog. Only `project` is wired today (into
  // the project-conventions catalog via server.js); the workspace/conductor
  // groups already exist here (empty until their scope is enabled in
  // manifest.ts + a provider is wired), so future routing is a localized add,
  // not a redesign. Each entry: { slug:'<plugin-id>/<slug>', name, description,
  // body, scaffold?, plugin:id } — `body` is '' when the convention carries no
  // fragment (scaffold-only); `scaffold` is the resolved directive text, present
  // only when the entry carries a scaffold facet.
  async function conventions(): Promise<Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }>>> {
    await ensureInit();
    const byScope: Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }>>
      = Object.fromEntries(SUPPORTED_CONVENTION_SCOPES.map(s => [s, []]));
    for (const entry of contributingEntries()) {
      const list = entry.manifest.conventions ?? [];
      if (list.length === 0) continue;
      let cwd: string;
      try { cwd = await resolveCwd(entry); } catch (e) { console.warn(`plugins: conventions cwd for '${entry.id}' failed: ${errMsg(e)}`); continue; }
      for (const g of list) {
        if (!byScope[g.scope]) continue; // scope not routed yet — skip defensively
        let body = '';
        if (g.file) {
          try { body = await readFragment(path.join(cwd, g.file)); }
          catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' body unreadable: ${errMsg(e)}`); continue; }
        }
        let scaffold: string | undefined;
        if (g.scaffold) {
          if ('text' in g.scaffold) scaffold = g.scaffold.text;
          else {
            try { scaffold = await readFragment(path.join(cwd, g.scaffold.file)); }
            catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' scaffold unreadable: ${errMsg(e)}`); continue; }
          }
        }
        byScope[g.scope].push({ slug: `${entry.id}/${g.slug}`, name: g.name, description: g.description, body, ...(scaffold !== undefined ? { scaffold } : {}), plugin: entry.id });
      }
    }
    return byScope;
  }

  // Roles contributed by enabled plugins. SYNCHRONOUS — unlike conventions(),
  // a role binding is inline in the manifest (no fragment file to resolve), so
  // spawn-time resolution (appSettings.resolveRoleBackend) stays synchronous.
  // Each entry: { role:'<plugin-id>/<slug>', label, binding, plugin:id }. Only
  // enabled+ok plugins contribute, so disabling/removing a plugin drops its
  // roles automatically (no purge, mirroring conductor conventions).
  function roles(): Array<{ role: string; label: string; binding: { kind: 'tier'; tier: string } | { backend: string; model: string } | null; plugin: string }> {
    const out: Array<{ role: string; label: string; binding: { kind: 'tier'; tier: string } | { backend: string; model: string } | null; plugin: string }> = [];
    for (const entry of contributingEntries()) {
      for (const r of entry.manifest.roles ?? []) {
        out.push({ role: `${entry.id}/${r.slug}`, label: r.name, binding: r.binding, plugin: entry.id });
      }
    }
    return out;
  }

  // Claude Code plugin roots contributed by enabled + `ok` plugins whose manifest
  // declares `claudePlugin`. Each resolved root is validated HERE (at launch/
  // resolve time) — the target must directly contain `.claude-plugin/plugin.json`
  // for Claude Code's `--plugin-dir` to load it. A missing/unreadable one is
  // warned loudly and dropped (adding a broken --plugin-dir would make claude
  // itself fail to start), never silently swallowed. Returns absolute dir paths;
  // Instance.spawn() turns each into a repeated `--plugin-dir <root>` flag.
  async function claudePluginDirs(): Promise<string[]> {
    await ensureInit();
    const out: string[] = [];
    for (const entry of contributingEntries()) {
      const rels = claudePluginPaths(entry.manifest);
      if (rels.length === 0) continue;
      let cwd: string;
      try { cwd = await resolveCwd(entry); } catch (e) { console.warn(`plugins: claudePlugin cwd for '${entry.id}' failed: ${errMsg(e)}`); continue; }
      for (const rel of rels) {
        const root = path.join(cwd, rel);
        try {
          await fs.access(path.join(root, '.claude-plugin', 'plugin.json'));
          out.push(root);
        } catch {
          console.warn(`plugins: '${entry.id}' claudePlugin '${rel}' — no .claude-plugin/plugin.json at ${root}; skipping --plugin-dir`);
        }
      }
    }
    return out;
  }

  function setServerPort(p: number | null): void { serverPort = p; }

  // Test/shutdown teardown: kill every child this host started or adopted.
  async function stopAll(): Promise<void> {
    if (!initPromise) return;
    try { await initPromise; } catch { /* init failure — nothing running */ }
    for (const id of Object.keys(runtimeRecords)) {
      try { await stopInternal(id); } catch { /* best-effort */ }
    }
  }

  return {
    init: ensureInit,
    list, rescan, enable, disable, start, stop, restart, status,
    ensureStarted, setActiveVersion, toolsFor, runtimeInfo,
    conventions, roles, claudePluginDirs,
    reportUpstreamFailure, setServerPort, stopAll,
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
