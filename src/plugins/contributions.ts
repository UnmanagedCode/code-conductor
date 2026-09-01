import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_CONVENTION_SCOPES, claudePluginPaths, type PluginManifest } from './manifest.ts';
import type { BackendBinding, TierBinding } from '../modelVersions.ts';
import { LOCAL_SYSTEM_ID, projectPlacement, systemHandleGeneration } from '../systems/registry.ts';
import { placementToken } from '../projects.ts';
import type { System } from '../systems/system.ts';

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
//
// IT CARRIES NO PLACEMENT. `dir`, `system` and `remoteId` used to be here,
// stamped at the last rescan, and reading a fragment through that copy is
// exactly the defect card 2026-0263 fixed: a key computed from a rescan-captured
// target is internally consistent and still a correct key for the WRONG machine,
// so a stale body is served as healthy. Placement comes from resolvePlacement,
// live, per read — and leaving these fields here is the trap that produced the
// bug, so they are gone rather than merely unused.
interface ContributingEntry {
  id: string;
  project: string;
  manifest: PluginManifest;
}

// Where a contributing plugin's checkout is, resolved live by the registry. See
// resolvePlacement (src/plugins/registry.ts) for the three answers and why the
// third one is a throw rather than a value.
export type PluginPlacement =
  | { kind: 'ok'; system: System; dir: string; cwd: string }
  | { kind: 'unregistered' };

export interface ContributionsDeps {
  ensureInit: () => Promise<void>;
  // Enabled + `ok` plugins only: a crashed/disabled/invalid plugin never
  // surfaces its contributions.
  contributingEntries: () => ContributingEntry[];
  resolvePlacement: (entry: ContributingEntry) => Promise<PluginPlacement>;
}

export function createContributions({ ensureInit, contributingEntries, resolvePlacement }: ContributionsDeps) {
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
  //
  // THE KEY IS TAKEN OFF THE HANDLE THE READ GOES THROUGH, never from a copy of
  // the placement stored somewhere else. That is not tidiness: a key derived
  // from a second source can be a correct key for a machine this read never
  // spoke to, which is a stale body served as healthy (card 2026-0263). Taking
  // both from one object makes that unrepresentable.
  const fragmentBodyCache = new Map<string, string>();
  async function readFragment(system: System, abs: string): Promise<string> {
    const key = `${system.id}\0${system.remoteId ?? ''}\0${abs}`;
    const cached = fragmentBodyCache.get(key);
    if (cached !== undefined) return cached;
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
  // If an entry's placement cannot be RESOLVED, that is transient infra (e.g. a
  // worktree checkout not yet mounted, or a system that is down) rather than
  // "this plugin genuinely contributes nothing here" — the entry is silently
  // absent from every scope's list unless a reader checks `.degraded` on the
  // returned array
  // (see fragmentCatalog.ts's CatalogList). EVERY scope array is flagged,
  // including ones left empty: the failure isn't attributable to a single
  // scope, and an empty-and-unflagged array is exactly what "no plugin
  // contributes to this scope" looks like — the failed plugin may have been
  // the only would-be contributor. A vanished fragment/scaffold FILE is a
  // different, already-accepted case (the file is just gone, not transiently
  // unreachable) and is not treated as degraded — it is skipped with a
  // warning as before, same as it always has been.
  //
  // An UNREGISTERED project is the third case and NOT degraded: cc's own record
  // and the artefact registering the project are both gone (resolvePlacement in
  // registry.ts owns that test), which is the most authoritative answer in the
  // system and is read locally. So the plugin's fragments are simply absent, and
  // a referencing project regenerates without them — rather than freezing until
  // someone presses Rescan, which in a running server is the ONLY thing that
  // retires a discovery entry.
  //
  // MEMOIZED, because this is not a cheap read: it walks contributingEntries()
  // and calls resolvePlacement() per contributing plugin, and that resolves the
  // project (a record read plus, for a worktree-pinned plugin, a dynamic import
  // of worktrees.ts and a store read). server.ts wires TWO providers onto it
  // (project + conductor), so a single GET /api/settings/conventions/conductor
  // was two full scans, and a mutating plugin route fans out through
  // regenerateAllProjectConventions at two scans per project.
  //
  // The invalidation signal has THREE parts, and all three are load-bearing:
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
  //   3. A per-call PLACEMENT FINGERPRINT — placementFingerprint() below. Part
  //      (2) exists because a project's tree is state this host does not own;
  //      a project's PLACEMENT is the same kind of state, and (1) cannot see it
  //      either. It is the same argument one step out, which is why this is an
  //      extension of the existing signal rather than a third mechanism
  //      (card 2026-0263).
  //
  // The re-check in (2) is deliberately on the DIRS, not on the store metadata
  // that resolves them: a worktree pin going stale in the store is registry
  // state, self-healed by reconcileActiveVersion on the next recomputation, and
  // is covered by (1).
  //
  // A DEGRADED RESULT IS NOT MEMOIZED. Degraded means "a transient failure
  // stopped me telling you", and a cached transient needs an unrelated gesture
  // to clear: a remote system coming back up changes neither the generation nor
  // the fingerprint, so the catalog would keep declaring itself degraded (and
  // keep every referencing CONVENTIONS.md frozen) until the next rescan. The
  // cost of re-scanning while degraded is bounded by the fact that a degraded
  // catalog is exactly the state in which the fan-out it feeds does not write.
  //
  // The RETURNED OBJECT IS SHARED BY REFERENCE — callers must treat it as
  // read-only. Both consumers do: fragmentCatalog.ts reads `.degraded` and then
  // `raw.map(r => ({...r, builtin:false}))` (copying every entry), and
  // server.ts's two providers only index `.project` / `.conductor`. A defensive
  // shallow copy is deliberately NOT made: the entry objects would still be
  // shared, so it would buy the appearance of safety rather than safety.
  // WHICH MACHINES THE CACHED SCAN WAS ABOUT, as one string. Two terms:
  //
  //   * each contributing plugin's placement, via placementToken — the cheap
  //     LOCAL prefix of resolveProjectDir (src/projects.ts). It reaches no
  //     system on purpose: this runs on every compose, and a check that resolved
  //     a system would throw while a box was down and flip the catalog
  //     permanently degraded instead of merely re-checking.
  //   * systemHandleGeneration() — the one term the per-plugin tokens cannot
  //     carry. Re-pointing a system's provider command leaves the project
  //     record, the fragment path and the fragment cache key byte-identical
  //     while the machine behind them changes, so the ONLY signal is that the
  //     live handle was dropped (src/systems/registry.ts).
  async function placementFingerprint(): Promise<string> {
    const parts = [String(systemHandleGeneration())];
    for (const entry of contributingEntries()) {
      parts.push(`${entry.id}\0${await placementToken(entry.project)}`);
    }
    return parts.join('\u0001');
  }

  let conventionsCache: { gen: number; fp: string; dirs: string[]; value: ConventionGroups } | null = null;
  async function conventions(): Promise<ConventionGroups> {
    await ensureInit();
    // Snapshotted BEFORE the loop on purpose: resolvePlacement →
    // reconcileActiveVersion can call saveRegistry() mid-computation when it
    // self-heals a vanished worktree, bumping the generation. Tagging the result
    // with the pre-loop value marks it stale, so the next call recomputes once —
    // and that second run finds the self-heal already applied, so it does not
    // bump again. Self-limiting.
    const gen = registryGeneration;
    const fp = await placementFingerprint();
    if (conventionsCache && conventionsCache.gen === gen && conventionsCache.fp === fp
        && conventionsCache.dirs.every(d => existsSync(d))) {
      return conventionsCache.value;
    }
    // A placement change can leave the fragment cache KEY identical while the
    // bytes behind it belong to another machine — that is exactly what
    // re-pointing a system does — so the bodies go with the fingerprint, not
    // just the memoized result.
    if (conventionsCache && conventionsCache.fp !== fp) fragmentBodyCache.clear();
    const byScope: Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }>>
      = Object.fromEntries(SUPPORTED_CONVENTION_SCOPES.map(s => [s, []]));
    // Every checkout dir this scan read, for the liveness re-check above. Both
    // the resolved project dir AND the active version's cwd: for a
    // worktree-pinned plugin they differ, and losing EITHER changes what a fresh
    // scan would produce (the project dir is what the resolution itself needs).
    const dirs = new Set<string>();
    let degraded = false;
    for (const entry of contributingEntries()) {
      const list = entry.manifest.conventions ?? [];
      if (list.length === 0) continue;
      let place: PluginPlacement;
      try { place = await resolvePlacement(entry); }
      catch (e) { console.warn(`plugins: conventions placement for '${entry.id}' failed: ${errMsg(e)}`); degraded = true; continue; }
      // Authoritatively unregistered: not a failure to report, just a plugin
      // whose project cc no longer tracks. Skipped, catalog stays healthy.
      if (place.kind !== 'ok') continue;
      dirs.add(place.dir);
      dirs.add(place.cwd);
      for (const g of list) {
        let body = '';
        if (g.file) {
          try { body = await readFragment(place.system, path.join(place.cwd, g.file)); }
          catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' body unreadable: ${errMsg(e)}`); continue; }
        }
        let scaffold: string | undefined;
        if (g.scaffold) {
          if ('text' in g.scaffold) scaffold = g.scaffold.text;
          else {
            try { scaffold = await readFragment(place.system, path.join(place.cwd, g.scaffold.file)); }
            catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' scaffold unreadable: ${errMsg(e)}`); continue; }
          }
        }
        byScope[g.scope].push({ slug: `${entry.id}/${g.slug}`, name: g.name, description: g.description, body, ...(scaffold !== undefined ? { scaffold } : {}), plugin: entry.id });
      }
    }
    if (degraded) {
      for (const arr of Object.values(byScope)) Object.assign(arr, { degraded: true });
      // Deliberately NOT memoized — see the note above the cache.
      conventionsCache = null;
      return byScope;
    }
    conventionsCache = { gen, fp, dirs: [...dirs], value: byScope };
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
      // BUCKET 3, and read from the RECORD — live, but without reaching the
      // system. `--plugin-dir` takes an absolute LOCAL directory, and a plugin
      // dir is unbounded in size, so pulling one across is not on the table
      // either. Passing the remote path through would be worse than failing:
      // whatever sits at that path on THIS machine would be loaded into every
      // session instead. The row carries PLUGIN_DIR_LOCAL_ONLY so the UI says
      // this rather than showing a contribution that is not loaded.
      //
      // The record, not resolvePlacement, because resolving first would CONNECT
      // to a system only to conclude cc will not use it — a connect attempt and
      // a log line on every session launch while that system is down. It also
      // keeps this skip silent and by-design, which is what it is.
      if ((await projectPlacement(entry.project)).system !== LOCAL_SYSTEM_ID) continue;
      // Local from here, so this resolution never leaves cc's own machine. No
      // memo to fingerprint either — the placement above and the cwd below are
      // both read fresh on every call, which is all this member needs.
      let place: PluginPlacement;
      try { place = await resolvePlacement(entry); }
      catch (e) { console.warn(`plugins: claudePlugin placement for '${entry.id}' failed: ${errMsg(e)}`); continue; }
      if (place.kind !== 'ok') continue; // unregistered: nothing to contribute
      for (const rel of rels) {
        const root = path.join(place.cwd, rel);
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
