import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_CONVENTION_SCOPES, claudePluginPaths, type PluginManifest } from './manifest.ts';
import type { BackendBinding, TierBinding } from '../modelVersions.ts';
import { LOCAL_SYSTEM_ID, systemById } from '../systems/registry.ts';

// What enabled plugins contribute to the conductor beyond an HTTP backend:
// convention fragments, role bindings and Claude Code plugin roots. Composed by
// the registry (src/plugins/registry.ts), which hands it narrow accessors over
// its own discovery/persistence state and keeps the three public members
// (conventions/roles/claudePluginDirs) pointing straight at this module.
//
// Owns BOTH caches the registry used to hold — the fragment bodies and the
// memoized conventions() result — and, with them, the generation counter that
// invalidates the latter. The registry retains no cache state; it only signals
// change through invalidate() / noteRegistryChange().

// The shape `conventions()` returns: one array per SUPPORTED_CONVENTION_SCOPES
// key, each optionally flagged `degraded` (see fragmentCatalog.ts's CatalogList).
export type ConventionGroups = Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }> & { degraded?: boolean }>;

// The registry's PluginEntry, narrowed to what contributions actually reads —
// declared locally so neither module has to import the other's types.
interface ContributingEntry {
  id: string;
  project: string;
  dir: string;
  // The System the plugin's checkout lives on, and which TARGET of it. Fragment
  // bodies are read through the pair — they are files in a project tree — while
  // claudePluginDirs refuses a non-local one outright (see there).
  system: string;
  remoteId: string | null;
  manifest: PluginManifest;
}

export interface ContributionsDeps {
  ensureInit: () => Promise<void>;
  // Enabled + `ok` plugins only: a crashed/disabled/invalid plugin never
  // surfaces its contributions.
  contributingEntries: () => ContributingEntry[];
  resolveCwd: (entry: ContributingEntry) => Promise<string>;
}

export function createContributions({ ensureInit, contributingEntries, resolveCwd }: ContributionsDeps) {
  // Bumped by every state change that could alter what conventions() computes;
  // see the cache below for what reads it.
  let registryGeneration = 0;

  // Bodies are resolved from the active checkout; a fragment path that vanished
  // after load is skipped with a warning (manifest load already rejects missing
  // files).
  // Keyed by (system, remoteId, abs path): a path is only a file together with
  // the machine it is on, and one registered system can BE many machines — two
  // targets hosting a project at the same path would otherwise share one cached
  // body. NUL-separated because a remote id may contain `:`.
  const fragmentBodyCache = new Map<string, string>();
  async function readFragment(systemId: string, remoteId: string | null, abs: string): Promise<string> {
    const key = `${systemId}\0${remoteId ?? ''}\0${abs}`;
    const cached = fragmentBodyCache.get(key);
    if (cached !== undefined) return cached;
    const system = await systemById(systemId, remoteId, `plugin fragment '${abs}'`);
    const body = (await system.readFile(abs)).replace(/\s+$/, '');
    fragmentBodyCache.set(key, body);
    return body;
  }

  // Bodies above are keyed by absolute path and otherwise live for the whole
  // process — a `git pull` into the same checkout leaves the key unchanged.
  // Every explicit "the checkout on disk moved, or a disabled plugin's
  // fragments are about to matter again" event therefore drops the whole
  // map (a handful of small .md files, repopulated on the next compose):
  // rescanInternal, doStart, setActiveVersion, and enable (a fragment can be
  // edited while its plugin sits disabled — enable is the user's own
  // recovery gesture for exactly that).
  // Bumps the generation too: a stale fragment body must never survive inside a
  // cached conventions() result. This covers rescanInternal (and with it the
  // `byId = nextById` swap and the projectsRoot() swap path), enable, doStart
  // and setActiveVersion.
  function invalidate(): void { fragmentBodyCache.clear(); registryGeneration++; }

  // Registry state changed in a way that can alter what conventions() computes,
  // but the fragment BODIES on disk did not: every registry.json write (the
  // store calls this from its save path, which is what makes the set provably
  // complete — every mutation of the persisted records goes through a save),
  // and doStart's manifest reassignment.
  function noteRegistryChange(): void { registryGeneration++; }

  // Convention entries contributed by enabled plugins, GROUPED BY SCOPE so
  // each scope routes to its own catalog. `project` and `conductor` are both
  // wired today (server.ts routes each into its own catalog); `workspace` is
  // rejected at manifest load (manifest.ts's SUPPORTED_CONVENTION_SCOPES), so
  // its group here stays empty. Each entry: { slug:'<plugin-id>/<slug>', name, description,
  // body, scaffold?, plugin:id } — `body` is '' when the convention carries no
  // fragment (scaffold-only); `scaffold` is the resolved directive text, present
  // only when the entry carries a scaffold facet.
  // If an entry's cwd fails to resolve, that is transient infra (e.g. a
  // worktree checkout not yet mounted) rather than "this plugin genuinely
  // contributes nothing here" — the entry is silently absent from every
  // scope's list unless a reader checks `.degraded` on the returned array
  // (see fragmentCatalog.ts's CatalogList). EVERY scope array is flagged,
  // including ones left empty: the failure isn't attributable to a single
  // scope, and an empty-and-unflagged array is exactly what "no plugin
  // contributes to this scope" looks like — the failed plugin may have been
  // the only would-be contributor. A vanished fragment/scaffold FILE is a
  // different, already-accepted case (the file is just gone, not transiently
  // unreachable) and is not treated as degraded — it is skipped with a
  // warning as before, same as it always has been.
  //
  // MEMOIZED, because this is not a cheap read: it walks contributingEntries()
  // and calls resolveCwd() per contributing plugin, and resolveCwd →
  // reconcileActiveVersion does a dynamic import of worktrees.ts plus a store
  // read for any worktree-pinned plugin. server.ts wires TWO providers onto it
  // (project + conductor), so a single GET /api/settings/conventions/conductor
  // was two full scans, and a mutating plugin route fans out through
  // regenerateAllProjectConventions at two scans per project.
  //
  // The invalidation signal has TWO parts, and both are load-bearing:
  //
  //   1. `registryGeneration` — every mutation of the host's own state (see
  //      invalidate() and noteRegistryChange() above, and their call sites in
  //      registry.ts and store.ts).
  //   2. A per-call liveness re-check of the checkout dirs the cached scan
  //      actually read. A checkout deleted from under a running server mutates
  //      NO registry state, so (1) alone cannot see it — and answering "still
  //      here" on its behalf would silently disable the `.degraded` flag, whose
  //      whole job is to say "I can't tell gone from temporarily unreachable"
  //      (fragmentCatalog.ts's CatalogList; the never-blanks decline in
  //      projectClaudeMd.ts's ensureProjectConventionsMd depends on it). One
  //      existsSync per contributing plugin is negligible against the dynamic
  //      import + store read it guards, and a vanished dir just falls through to
  //      the real scan, which degrades exactly as it does uncached.
  //
  // The re-check is deliberately on the DIRS, not on the store metadata that
  // resolves them: a worktree pin going stale in the store is registry state,
  // self-healed by reconcileActiveVersion on the next recomputation, and is
  // covered by (1).
  //
  // The RETURNED OBJECT IS SHARED BY REFERENCE — callers must treat it as
  // read-only. Both consumers do: fragmentCatalog.ts reads `.degraded` and then
  // `raw.map(r => ({...r, builtin:false}))` (copying every entry), and
  // server.ts's two providers only index `.project` / `.conductor`. A defensive
  // shallow copy is deliberately NOT made: the entry objects would still be
  // shared, so it would buy the appearance of safety rather than safety.
  let conventionsCache: { gen: number; dirs: string[]; value: ConventionGroups } | null = null;
  async function conventions(): Promise<ConventionGroups> {
    await ensureInit();
    // Snapshotted BEFORE the loop on purpose: resolveCwd → reconcileActiveVersion
    // can call saveRegistry() mid-computation when it self-heals a vanished
    // worktree, bumping the generation. Tagging the result with the pre-loop
    // value marks it stale, so the next call recomputes once — and that second
    // run finds the self-heal already applied, so it does not bump again.
    // Self-limiting.
    const gen = registryGeneration;
    if (conventionsCache && conventionsCache.gen === gen && conventionsCache.dirs.every(d => existsSync(d))) {
      return conventionsCache.value;
    }
    const byScope: Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }>>
      = Object.fromEntries(SUPPORTED_CONVENTION_SCOPES.map(s => [s, []]));
    // Every checkout dir this scan read, for the liveness re-check above. Both
    // the discovered project dir AND the resolved cwd: for a worktree-pinned
    // plugin they differ, and losing EITHER changes what a fresh scan would
    // produce (the project dir is what resolveCwd's getProject() lookup needs).
    const dirs = new Set<string>();
    let degraded = false;
    for (const entry of contributingEntries()) {
      const list = entry.manifest.conventions ?? [];
      if (list.length === 0) continue;
      if (entry.dir) dirs.add(entry.dir);
      let cwd: string;
      try { cwd = await resolveCwd(entry); } catch (e) { console.warn(`plugins: conventions cwd for '${entry.id}' failed: ${errMsg(e)}`); degraded = true; continue; }
      dirs.add(cwd);
      for (const g of list) {
        let body = '';
        if (g.file) {
          try { body = await readFragment(entry.system, entry.remoteId, path.join(cwd, g.file)); }
          catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' body unreadable: ${errMsg(e)}`); continue; }
        }
        let scaffold: string | undefined;
        if (g.scaffold) {
          if ('text' in g.scaffold) scaffold = g.scaffold.text;
          else {
            try { scaffold = await readFragment(entry.system, entry.remoteId, path.join(cwd, g.scaffold.file)); }
            catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' scaffold unreadable: ${errMsg(e)}`); continue; }
          }
        }
        byScope[g.scope].push({ slug: `${entry.id}/${g.slug}`, name: g.name, description: g.description, body, ...(scaffold !== undefined ? { scaffold } : {}), plugin: entry.id });
      }
    }
    if (degraded) for (const arr of Object.values(byScope)) Object.assign(arr, { degraded: true });
    conventionsCache = { gen, dirs: [...dirs], value: byScope };
    return byScope;
  }

  // Roles contributed by enabled plugins. SYNCHRONOUS — unlike conventions(),
  // a role binding is inline in the manifest (no fragment file to resolve), so
  // spawn-time resolution (appSettings.resolveRoleBackend) stays synchronous.
  // Each entry: { role:'<plugin-id>/<slug>', label, binding, plugin:id }. Only
  // enabled+ok plugins contribute, so disabling/removing a plugin drops its
  // roles automatically (no purge, mirroring conductor conventions).
  function roles(): Array<{ role: string; label: string; binding: BackendBinding | TierBinding; plugin: string }> {
    const out: Array<{ role: string; label: string; binding: BackendBinding | TierBinding; plugin: string }> = [];
    for (const entry of contributingEntries()) {
      for (const r of entry.manifest.roles ?? []) {
        // A null binding means the manifest failed role validation, which
        // excludes it from contributingEntries (discoveryState must be 'ok');
        // skip defensively so the provider's binding type holds without a cast.
        if (!r.binding) continue;
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
      // BUCKET 3. `--plugin-dir` takes an absolute LOCAL directory, and a plugin
      // dir is unbounded in size, so pulling one across is not on the table
      // either. Passing the remote path through would be worse than failing:
      // whatever sits at that path on THIS machine would be loaded into every
      // session instead. The row carries PLUGIN_DIR_LOCAL_ONLY so the UI says
      // this rather than showing a contribution that is not loaded.
      if (entry.system !== LOCAL_SYSTEM_ID) continue;
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

  return { conventions, roles, claudePluginDirs, invalidate, noteRegistryChange };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
