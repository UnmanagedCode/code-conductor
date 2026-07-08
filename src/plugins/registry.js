import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  projectsRoot, orchStoreRoot, writeFileAtomic, listProjects,
  readProjectMeta, writeProjectMeta, addWorkspace,
} from '../projects.js';
import { readManifest } from './manifest.js';
import { createSupervisor, httpOk } from './supervisor.js';
import { createMcpBridge } from './mcpBridge.js';
import { pidAlive, waitForPort } from './ports.js';

// Plugin registry — the single service layer behind the REST api
// (src/plugins/api.js), the reverse proxy (src/plugins/proxy.js) and MCP
// forwarding (src/plugins/mcpBridge.js). Owns discovery, the persisted
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
const BACKOFF_UNIT_MS = 1000;   // backoff = min(2^n, 30) * unit
const BACKOFF_CAP_UNITS = 30;
const WORKSPACE_AUTO_ASSIGN = 'CC-Dev';

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.statusCode = status;
  Object.assign(e, extra);
  return e;
}

export function createPluginHost({
  instances = null,
  _crashWindowMs = CRASH_WINDOW_MS,
  _backoffUnitMs = BACKOFF_UNIT_MS,
  _supervisorOpts = {},
} = {}) {
  // Discovery catalog: rebuilt by rescan(). `entries` keeps every
  // manifest-bearing dir (including invalid ones, for listing); `byId`
  // indexes only usable ids (states ok/conflict).
  let entries = [];
  let byId = new Map();

  // Persisted state, loaded by init().
  let persisted = { plugins: {} };
  let runtimeRecords = {};

  // In-memory runtime per id: status stopped|starting|ready|crashed|failed,
  // crash bookkeeping for backoff, the in-flight start dedupe promise, and
  // the last crash tail for 503 bodies.
  const rt = new Map();

  let serverPort = null;
  let initPromise = null;
  let initedFor = null; // projectsRoot() the current state was built for (test roots swap)

  const supervisor = createSupervisor({ onExit: handleChildExit, ..._supervisorOpts });

  function runtimeState(id) {
    let s = rt.get(id);
    if (!s) { s = { status: 'stopped', crashTimes: [], backoffUntil: 0, startPromise: null, tail: null, adopted: false }; rt.set(id, s); }
    return s;
  }

  // ── persistence ─────────────────────────────────────────────────────
  const registryFile = () => path.join(orchStoreRoot(), 'plugins', 'registry.json');
  const runtimeFile = () => path.join(orchStoreRoot(), 'plugins', 'runtime.json');

  async function loadJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') console.warn(`plugins: failed to read ${file}: ${e.message}`);
      return fallback;
    }
  }

  async function saveRegistry() {
    await writeFileAtomic(registryFile(), JSON.stringify(persisted, null, 2) + '\n');
  }

  async function saveRuntimeRecords() {
    await writeFileAtomic(runtimeFile(), JSON.stringify(runtimeRecords, null, 2) + '\n');
  }

  // ── init / discovery ────────────────────────────────────────────────
  function ensureInit() {
    if (initPromise && initedFor === projectsRoot()) return initPromise;
    initedFor = projectsRoot();
    rt.clear();
    initPromise = (async () => {
      persisted = await loadJson(registryFile(), { plugins: {} });
      if (typeof persisted?.plugins !== 'object' || persisted.plugins === null) persisted = { plugins: {} };
      runtimeRecords = await loadJson(runtimeFile(), {});
      await rescanInternal();
      await adoptRunning();
    })();
    return initPromise;
  }

  async function rescanInternal() {
    const projects = await listProjects();
    const found = [];
    for (const p of projects) {
      const result = await readManifest(p.path);
      if (result === null) continue;
      found.push({ project: p.name, dir: p.path, result });
    }
    // Deterministic conflict resolution: first alphabetical project wins.
    found.sort((a, b) => a.project.localeCompare(b.project));
    const next = [];
    const nextById = new Map();
    for (const f of found) {
      const { result } = f;
      if (result.errors) {
        next.push({
          id: result.id ?? null, project: f.project, dir: f.dir, manifest: null,
          discoveryState: result.incompatible ? 'incompatible' : 'invalid',
          errors: result.errors,
        });
        continue;
      }
      const m = result.manifest;
      if (nextById.has(m.id)) {
        next.push({ id: m.id, project: f.project, dir: f.dir, manifest: m, discoveryState: 'conflict', errors: [`duplicate id '${m.id}' — already provided by project '${nextById.get(m.id).project}'`] });
        continue;
      }
      const entry = { id: m.id, project: f.project, dir: f.dir, manifest: m, discoveryState: 'ok', errors: [] };
      next.push(entry);
      nextById.set(m.id, entry);
    }
    entries = next;
    byId = nextById;
  }

  // Adopt-don't-drain: a recorded child whose pid is alive and answering on
  // its recorded port is adopted as ready; anything else is cleared.
  async function adoptRunning() {
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

  async function probeAnswers(port, manifest) {
    if (!port) return false;
    if (manifest?.backend?.healthPath) return httpOk(port, manifest.backend.healthPath);
    try { await waitForPort(port, { timeoutMs: 1000, intervalMs: 200 }); return true; }
    catch { return false; }
  }

  // ── crash bookkeeping ───────────────────────────────────────────────
  function recordCrash(id, tail) {
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
  function handleChildExit(id, info) {
    if (info.status !== 'exited') return;
    delete runtimeRecords[id];
    saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${e.message}`));
    recordCrash(id, `${info.error}\n${(info.output ?? '').slice(-2000)}`);
  }

  // A dead child discovered passively (status probe, proxy upstream error).
  function markDead(id, reason) {
    delete runtimeRecords[id];
    saveRuntimeRecords().catch(e => console.warn(`plugins: runtime.json write failed: ${e.message}`));
    recordCrash(id, reason);
  }

  // ── lookups ─────────────────────────────────────────────────────────
  function requireEntry(id) {
    const entry = byId.get(id);
    if (entry) return entry;
    // byId indexes only usable ids — a known-but-unusable manifest still
    // deserves a 409 with its errors rather than a bare 404.
    const broken = entries.find(e => e.id === id);
    if (broken) throw httpError(409, `plugin '${id}' is not usable (${broken.discoveryState}): ${broken.errors.join('; ')}`);
    throw httpError(404, `unknown plugin '${id}'`);
  }

  function requireEnabled(id) {
    const entry = requireEntry(id);
    if (persisted.plugins[id]?.enabled !== true) throw httpError(409, `plugin '${id}' is not enabled`);
    return entry;
  }

  async function resolveCwd(entry) {
    const av = persisted.plugins[entry.id]?.activeVersion ?? { type: 'main' };
    if (av.type !== 'worktree') return entry.dir;
    // Never string-assemble worktree paths — resolve via the store metadata.
    const { getWorktree } = await import('../worktrees.js');
    const meta = await getWorktree(entry.project, av.name);
    if (!meta?.worktreePath) throw httpError(404, `active version worktree '${av.name}' of project '${entry.project}' not found`);
    return meta.worktreePath;
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  async function enable(id) {
    await ensureInit();
    const entry = requireEntry(id);
    const prev = persisted.plugins[id];
    persisted.plugins[id] = {
      project: entry.project,
      enabled: true,
      activeVersion: prev?.activeVersion ?? { type: 'main' },
    };
    await saveRegistry();
    // Manual re-enable is the recovery path out of `failed`.
    const s = runtimeState(id);
    if (s.status === 'failed' || s.status === 'crashed') { s.status = 'stopped'; s.crashTimes = []; s.backoffUntil = 0; }
    // First-class placement: an unassigned plugin project joins the CC-Dev
    // workspace (same primitives as set_project_workspace).
    try {
      const meta = await readProjectMeta(entry.project);
      if (meta.workspace == null) {
        await writeProjectMeta(entry.project, { workspace: WORKSPACE_AUTO_ASSIGN });
        await addWorkspace(WORKSPACE_AUTO_ASSIGN);
      }
    } catch (e) {
      console.warn(`plugins: workspace auto-assign for '${entry.project}' failed: ${e.message}`);
    }
    return describe(id);
  }

  async function disable(id) {
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
  function doStart(id) {
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
      if (result.errors) throw httpError(400, `manifest in active checkout is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in active checkout does not match plugin '${id}'`);
      entry.manifest = result.manifest;
      if (!entry.manifest.backend) throw httpError(400, `plugin '${id}' has no backend to start`);

      s.status = 'starting';
      s.adopted = false;
      const env = serverPort ? { CONDUCTOR_URL: `http://127.0.0.1:${serverPort}` } : {};
      const rec = await supervisor.start({ id, manifest: entry.manifest, cwd, env });
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
  async function waitSettled(id, { timeoutMs = 35_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = supervisor.runtime(id);
      if (!r) return { status: 'crashed', error: 'child record vanished' };
      if (r.status !== 'starting') return r;
      if (Date.now() >= deadline) return { status: 'crashed', error: 'readiness poll timed out', output: r.output };
      await new Promise(res => setTimeout(res, 50));
    }
  }

  async function start(id) {
    await ensureInit();
    requireEnabled(id);
    const s = runtimeState(id);
    if (s.status === 'ready') return describe(id);
    // Explicit start is a manual recovery action — clear crash history.
    s.crashTimes = []; s.backoffUntil = 0;
    if (s.status === 'failed' || s.status === 'crashed') s.status = 'stopped';
    return doStart(id);
  }

  async function stopInternal(id) {
    const rec = runtimeRecords[id];
    const s = runtimeState(id);
    if (rec) {
      supervisor.stop({ id, pgid: rec.pgid });
      delete runtimeRecords[id];
      await saveRuntimeRecords();
    }
    if (s.status !== 'failed') s.status = 'stopped';
  }

  async function stop(id) {
    await ensureInit();
    if (!byId.get(id) && !persisted.plugins[id]) throw httpError(404, `unknown plugin '${id}'`);
    await stopInternal(id);
    return describe(id);
  }

  // The lazy-start gate used by the proxy and the MCP bridge. Resolves once
  // the plugin is ready (requests wait through the ≤30s readiness window);
  // throws 503 when the plugin can't serve.
  async function ensureStarted(id) {
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
  function describe(id) {
    const entry = byId.get(id) ?? entries.find(e => e.id === id) ?? null;
    const reg = persisted.plugins[id];
    if (!entry && !reg) return null;
    return describeRow(entry ?? { id, project: reg.project, dir: null, manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] });
  }

  function describeRow(entry) {
    const id = entry.id;
    const reg = id ? persisted.plugins[id] : null;
    const s = id ? runtimeState(id) : null;
    const rec = id ? runtimeRecords[id] : null;
    let state;
    if (entry.discoveryState !== 'ok') state = entry.discoveryState;
    else if (!reg?.enabled) state = reg ? 'disabled' : 'discovered';
    else state = s.status;
    return {
      id,
      name: entry.manifest?.name ?? entry.project,
      project: entry.project,
      version: entry.manifest?.version ?? null,
      state,
      enabled: reg?.enabled === true,
      activeVersion: reg?.activeVersion ?? { type: 'main' },
      hasFrontend: !!entry.manifest?.frontend,
      navLabel: entry.manifest?.frontend?.navLabel ?? null,
      frontendPath: entry.manifest?.frontend?.path ?? null,
      hasMcp: !!entry.manifest?.mcp,
      port: rec?.port ?? null,
      pid: rec?.pid ?? null,
      startedAt: rec?.startedAt ?? null,
      gitHead: rec?.gitHead ?? null,
      errors: entry.errors ?? [],
      crashTail: s?.tail ?? null,
    };
  }

  async function list() {
    await ensureInit();
    const rows = entries.map(describeRow);
    // Registry entries whose project/manifest vanished still deserve a row
    // (they hold state the user may want to disable).
    for (const [id, reg] of Object.entries(persisted.plugins)) {
      if (!entries.some(e => e.id === id)) {
        rows.push(describeRow({ id, project: reg.project, dir: null, manifest: null, discoveryState: 'invalid', errors: ['project or manifest no longer present'] }));
      }
    }
    return rows;
  }

  async function rescan() {
    await ensureInit();
    await rescanInternal();
    return list();
  }

  // Merged row + live probe: catches children that died silently (Doze,
  // OOM-kill) since the last event we saw.
  async function status(id) {
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
  function reportUpstreamFailure(id) {
    const rec = runtimeRecords[id];
    const s = rt.get(id);
    if (!rec || !s || s.status !== 'ready') return;
    if (!pidAlive(rec.pid)) markDead(id, s.tail ?? `process ${rec.pid} died (upstream connection failed)`);
  }

  // Worktree-version activation: which checkout the supervisor cwd points
  // at. Guard: the target checkout must contain a valid manifest with a
  // matching id, else 400 and the previous state is kept. Restarts the
  // child when it was running so the switch takes effect immediately.
  async function setActiveVersion(id, v) {
    await ensureInit();
    const entry = requireEntry(id);
    if (!persisted.plugins[id]) throw httpError(409, `plugin '${id}' has no registry entry — enable it first`);
    let next;
    if (v?.type === 'main') {
      next = { type: 'main' };
    } else if (v?.type === 'worktree') {
      if (typeof v.name !== 'string' || v.name === '') throw httpError(400, "worktree version requires a 'name'");
      const { getWorktree } = await import('../worktrees.js');
      const meta = await getWorktree(entry.project, v.name);
      if (!meta?.worktreePath) throw httpError(404, `worktree '${v.name}' of project '${entry.project}' not found`);
      const result = await readManifest(meta.worktreePath);
      if (!result) throw httpError(400, `no conductor.plugin.json in worktree '${v.name}'`);
      if (result.errors) throw httpError(400, `manifest in worktree '${v.name}' is invalid: ${result.errors.join('; ')}`);
      if (result.manifest.id !== id) throw httpError(400, `manifest id '${result.manifest.id}' in worktree '${v.name}' does not match plugin '${id}'`);
      next = { type: 'worktree', name: v.name };
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

  // MCP forwarding lives in a composed collaborator; the registry only
  // hands it narrow accessors over its own state.
  const mcpBridge = createMcpBridge({
    instances,
    listMcpPlugins: () => [...byId.values()].filter(e =>
      e.discoveryState === 'ok' && persisted.plugins[e.id]?.enabled === true && e.manifest.mcp),
    ensureStarted,
    portFor: (id) => runtimeRecords[id]?.port ?? null,
    reportUpstreamFailure,
  });
  const toolsFor = (callerId) => mcpBridge.toolsFor(callerId);

  function runtimeInfo(id) {
    const rec = runtimeRecords[id];
    const s = rt.get(id);
    return { status: s?.status ?? 'stopped', port: rec?.port ?? null };
  }

  function setServerPort(p) { serverPort = p; }

  // Test/shutdown teardown: kill every child this host started or adopted.
  async function stopAll() {
    if (!initPromise) return;
    try { await initPromise; } catch { /* init failure — nothing running */ }
    for (const id of Object.keys(runtimeRecords)) {
      try { await stopInternal(id); } catch { /* best-effort */ }
    }
  }

  return {
    init: ensureInit,
    list, rescan, enable, disable, start, stop, status,
    ensureStarted, setActiveVersion, toolsFor, runtimeInfo,
    reportUpstreamFailure, setServerPort, stopAll,
  };
}
