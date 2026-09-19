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
  // The last completed discovery scan could not reach a project an ENABLED
  // plugin lives in, so the catalog built over it is incomplete. See
  // discoveryDegraded (src/plugins/registry.ts) for what that read narrows on
  // and what it deliberately cannot.
  discoveryDegraded: () => boolean;
}

export function createContributions({ ensureInit, contributingEntries, resolvePlacement, discoveryDegraded }: ContributionsDeps) {
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
  //
  // THE INVARIANT, and it is the whole of this cache's correctness:
  //
  //   A CACHED BODY IS SERVED ONLY UNDER THE EXACT STATE IT WAS READ UNDER.
  //
  // It is enforced by giving every ENTRY its own label rather than by tracking
  // one label for the map, because a per-map label is a claim made at ONE
  // INSTANT while a scan reads and inserts over its whole DURATION. Two
  // interleaves broke exactly that (card 2026-0263, review rounds 1 and 2): a
  // degraded compose discards the memoized result while leaving the bodies, and
  // an invalidation landing MID-SCAN voids the running scan's claim after some
  // of its inserts have already happened. Both ended the same way — a body from
  // one machine served for another at degraded:false.
  //
  // With the label on the entry, neither is expressible. There is exactly ONE
  // insert site and ONE lookup site (both below), and the insert always writes
  // the label its caller was handed. A scan whose label is voided while it runs
  // therefore cannot contribute a SERVABLE entry at all — its inserts are inert,
  // not mislabelled — and that holds without any assumption about which other
  // gesture fired when.
  //
  // TWO GUARDS KEEP A RETIRED ENTRY OUT, AND THE REDUNDANCY IS DELIBERATE: the
  // lookup refuses an entry whose label does not match, and the start-of-scan
  // sweep in conventions() deletes it. NEITHER IS "THE" GUARD — mutation proof
  // measured that removing either one ALONE leaves the whole suite green,
  // because each is sufficient on its own; what breaks the invariant is removing
  // BOTH. They are kept together because they cover it from opposite ends (one
  // refuses to serve, one refuses to retain) for the price of a string compare,
  // so a future edit that drops one has not silently created a hole.
  const fragmentBodyCache = new Map<string, { label: string; body: string }>();

  // Bumped by invalidate(). The label's two halves answer two different
  // questions, and neither implies the other:
  //   * `cacheEpoch` — "the BYTES at this path may have changed" under a
  //     placement that did not move: a `git pull` into the same checkout, an
  //     active-version switch, a fragment edited while its plugin sat disabled.
  //     Nothing about the placement tells you that, which is why invalidate()
  //     exists at all.
  //   * the placement fingerprint — "the PATH may name a different tree": the
  //     project moved, or the machine behind its system id did. No invalidate()
  //     is called on either (setProjectRemote and updateSystem are outside this
  //     host entirely), which is why the fingerprint cannot be folded into the
  //     epoch.
  let cacheEpoch = 0;

  // The label a scan stamps on everything it inserts, captured ONCE at the top
  // of that scan so every body it caches is attributed to the state the scan
  // actually resolved placements under.
  function cacheLabel(fp: string): string { return `${cacheEpoch}\u0001${fp}`; }

  async function readFragment(system: System, abs: string, label: string): Promise<string> {
    const key = `${system.id}\0${system.remoteId ?? ''}\0${abs}`;
    const cached = fragmentBodyCache.get(key);
    // GUARD 1 of the deliberately redundant pair above: an entry whose label
    // does not match is not a hit — it is a body read under state that no longer
    // holds, and re-reading is the only correct answer.
    if (cached !== undefined && cached.label === label) return cached.body;
    const body = (await system.readFile(abs)).replace(/\s+$/, '');
    fragmentBodyCache.set(key, { label, body });
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
  //
  // And bumps the cache EPOCH, which is what makes the drop safe against a
  // compose that is running right now: clearing the map alone would be undone by
  // an in-flight scan repopulating it, and those late inserts carry the epoch
  // their scan started with, so they can never be served afterwards. That is why
  // this is three statements and not two.
  function invalidate(): void { fragmentBodyCache.clear(); cacheEpoch++; registryGeneration++; }

  // Registry state changed in a way that can alter what conventions() computes,
  // but the fragment BODIES on disk did not: every registry.json write (the
  // store calls this from its save path, which is what makes the set provably
  // complete — every mutation of the persisted records goes through a save),
  // and doStart's manifest reassignment.
  function noteRegistryChange(): void { registryGeneration++; }

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
  // returned array (see fragmentCatalog.ts's CatalogList). EVERY scope array is flagged,
  // including ones left empty: the failure isn't attributable to a single
  // scope, and an empty-and-unflagged array is exactly what "no plugin
  // contributes to this scope" looks like — the failed plugin may have been
  // the only would-be contributor. A vanished fragment/scaffold FILE is a
  // different, already-accepted case (the file is just gone, not transiently
  // unreachable) and is not treated as degraded — it is skipped with a
  // warning as before, same as it always has been.
  //
  // THE DISCOVERY-TIME SOURCE IS THE OTHER HALF, AND ITS POLICY IS A
  // DOCUMENTED SUPERSET OF THIS ONE — not the same policy at a second site
  // (card 2026-0272). Everything above is about a placement resolved DURING
  // this compose. A project can also have been dropped by the SCAN that built
  // the catalog (rescanInternal skips a project it cannot resolve through its
  // System), and then the entry is not merely unplaceable, it is not in the
  // catalog at all. `degraded` is seeded from discoveryDegraded() below so that
  // absence is flagged too, instead of reading as confirmed.
  //
  // The two sites agree on REACHABILITY CLASS and on nothing else. That much
  // is structural rather than measured: the discovery drop fires on any throw
  // out of resolveProjectDir (tryResolveProject returns system:null only for a
  // throw), and resolvePlacement lets every such throw propagate to the catch
  // below — so whatever that throw set is, both sites see the same one.
  //
  // Everything past that they cannot agree on. Five filters stand between a
  // persisted record and a degrade here: `discoveryState === 'ok'`, a string
  // id, and a non-null manifest (all three in contributingEntries,
  // registry.ts), a non-empty `conventions` list (the `list.length === 0`
  // continue below), and store.isEnabled. FOUR of the five are read out of the
  // manifest — exactly the file the scan never got to read, because the
  // project did not resolve through its System (a box that is down and a
  // remote record with no systemPath both land here; cc has established that
  // the resolution failed, not what caused it) — so at scan time all four are
  // unknowable. Only store.isEnabled is answerable, off cc's own disk, and the
  // persisted record it reads is `{project, enabled, activeVersion}` and
  // nothing else, identically for a plugin declaring conventions and one
  // declaring none. This is not a stale-unsafe term being refused; there is no
  // such term.
  //
  // So the scan-time flag is a strict SUPERSET: an enabled plugin in an
  // unresolvable project degrades the catalog even if, had the project
  // resolved, its manifest would have turned out invalid, incompatible,
  // id-less, or simply free of any conventions entry — every one of which is
  // skipped here at degraded:false. That direction is the safe one and is chosen deliberately:
  // over-flagging costs a freeze, which the next Rescan clears; under-flagging
  // rewrites a committed CONVENTIONS.md, which is the defect.
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
  // The discovery-sourced degrade adds no fourth part. It is a memo BYPASS, not
  // an invalidation: it does not mark a memo stale, it declines to serve one
  // that may be perfectly valid for the scan that produced it. And it is
  // redundant by construction today, on both of its terms: the unreachable set
  // only gains entries in rescanInternal, which calls invalidate() first, and a
  // record only becomes enabled either through the store's single save path
  // (which calls noteRegistryChange()) or through the boot load, which
  // ensureInit follows with that same rescanInternal. So no memo written by a
  // healthy scan can still be live while this reads true. It is kept for the
  // same reason the second guard at fragmentBodyCache is kept: it makes "a memo
  // may not be served while the scan that produced it is known to have been
  // incomplete" structural, rather than an argument spanning two modules.
  // Redundant, kept — not necessary.
  //
  // A COMPOSE-SOURCED DEGRADED RESULT IS NOT MEMOIZED. That degrade means "a
  // transient failure stopped me telling you", and a cached transient needs an
  // unrelated gesture to clear: a remote system coming back up changes neither
  // the generation nor the fingerprint, so the catalog would keep declaring
  // itself degraded (and keep every referencing CONVENTIONS.md frozen) until
  // the next rescan.
  //
  // The DISCOVERY-sourced one is the other way round: latching until the next
  // rescan IS the design (the catalog really is missing that project's plugins
  // until something rebuilds it), and not-memoizing is not what clears it. It
  // is kept out of the memo by the bypass above, and it clears when
  // discoveryDegraded() goes false — a clean rescan, or the affected plugin
  // being disabled.
  //
  // The cost of re-scanning while EITHER holds is the same ORDER as a memo
  // hit, not a different one — a hit is not free either, since it still builds
  // the placement fingerprint and stats every cached dir. What the bypassed
  // call adds is placement re-resolution, so it scales with the number of
  // contributing plugins. NO NUMBER IS QUOTED HERE ON PURPOSE: both the hit
  // and the bypass move enough run to run that successive benches of this have
  // produced mutually contradictory ratios, in both directions. Measure it in
  // your own conditions if you need one, and don't write the answer down here.
  // For the compose-sourced case the cost is additionally
  // bounded by the fact that a degraded catalog is exactly the state in which
  // the fan-out it feeds does not write.
  //
  // The RETURNED OBJECT IS SHARED BY REFERENCE — callers must treat it as
  // read-only. Both consumers do: fragmentCatalog.ts reads `.degraded` and then
  // `raw.map(r => ({...r, builtin:false}))` (copying every entry), and
  // server.ts's two providers only index `.project` / `.conductor`. A defensive
  // shallow copy is deliberately NOT made: the entry objects would still be
  // shared, so it would buy the appearance of safety rather than safety.
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
    // The DISCOVERY-sourced degrade, read once for this call: the scan that
    // built the catalog could not reach a project an enabled plugin lives in,
    // so what follows is composed over a catalog known to be incomplete.
    const scanDegraded = discoveryDegraded();
    const fp = await placementFingerprint();
    if (!scanDegraded && conventionsCache && conventionsCache.gen === gen && conventionsCache.fp === fp
        && conventionsCache.dirs.every(d => existsSync(d))) {
      return conventionsCache.value;
    }
    // This scan's label, captured before the loop and handed to every read it
    // makes.
    //
    // The sweep below is GUARD 2 of the deliberately redundant pair documented
    // at fragmentBodyCache: it deletes every entry labelled for state that no
    // longer holds, which readFragment would also refuse to serve. Do not read
    // either half as merely decorative — measured, each is sufficient alone and
    // only removing both reopens the hole — and the sweep additionally reclaims
    // the memory of entries that can never be served again, over a map holding a
    // handful of small .md files.
    const label = cacheLabel(fp);
    for (const [k, v] of fragmentBodyCache) {
      if (v.label !== label) fragmentBodyCache.delete(k);
    }
    const byScope: Record<string, Array<{ slug: string; name: string; description: string; body: string; scaffold?: string; plugin: string }>>
      = Object.fromEntries(SUPPORTED_CONVENTION_SCOPES.map(s => [s, []]));
    // Every checkout dir this scan read, for the liveness re-check above. Both
    // the resolved project dir AND the active version's cwd: for a
    // worktree-pinned plugin they differ, and losing EITHER changes what a fresh
    // scan would produce (the project dir is what the resolution itself needs).
    const dirs = new Set<string>();
    let degraded = scanDegraded;
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
          try { body = await readFragment(place.system, path.join(place.cwd, g.file), label); }
          catch (e) { console.warn(`plugins: convention '${entry.id}/${g.slug}' body unreadable: ${errMsg(e)}`); continue; }
        }
        let scaffold: string | undefined;
        if (g.scaffold) {
          if ('text' in g.scaffold) scaffold = g.scaffold.text;
          else {
            try { scaffold = await readFragment(place.system, path.join(place.cwd, g.scaffold.file), label); }
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
      //
      // INSIDE THE SAME PER-ENTRY CATCH as the resolution below, because the
      // record read THROWS on a record it cannot parse. Left outside, one
      // unreadable `project.json` rejects this whole function — and its only
      // consumer (`src/instances.ts`) catches with a bare warn and spawns with
      // `claudePluginDirs: []`, so a single broken record silently strips every
      // plugin's `--plugin-dir` from every launch. The conventions path degrades
      // that same record loudly one branch over; this is that, per entry.
      let place: PluginPlacement;
      try {
        if ((await projectPlacement(entry.project))?.system !== LOCAL_SYSTEM_ID) continue;
        // Local from here, so this resolution never leaves cc's own machine. No
        // memo to fingerprint either — the placement above and the cwd below are
        // both read fresh on every call, which is all this member needs.
        place = await resolvePlacement(entry);
      } catch (e) { console.warn(`plugins: claudePlugin placement for '${entry.id}' failed: ${errMsg(e)}`); continue; }
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
