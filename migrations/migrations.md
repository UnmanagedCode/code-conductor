# Migrations

This directory holds idempotent migration scripts that mutate on-disk state to
keep the workspace aligned with the current codebase. They run **automatically
on server startup** via `migrations/index.mjs`, which is invoked by
`server.js` before the HTTP listener binds.

## How auto-run works

`server.js` calls `runMigrations({ root: projectsRoot() })` once at boot. Migrations run in order (oldest first); each self-checks "already applied?" and returns `{ applied: false }` as a fast no-op (steady state) or `{ applied: true, summary }` (logged one-line, e.g. `migration 0001-centralize-orchestrator-state: applied — {…}`). A migration that **throws aborts the boot** — fix and restart. You never run them by hand; a new release's migration applies itself on the next `git pull && npm start`.

## Adding a new migration

1. Pick the next number: `NNNN-short-kebab-name.mjs` (zero-padded 4-digit
   sequence + slug). Numbers establish order, never reuse one.
   - **Must slot BETWEEN two shipped migrations?** Letter-suffix it —
     `0018b-short-kebab-name.mjs` runs after `0018` and before `0019`, so numeric
     (lexicographic) order still equals execution order. Reach for this only when an
     earlier shipped migration would otherwise destroy state yours needs; renumbering
     a shipped migration is never an option. Example: `0018b-backend-registry` must
     precede `0019`, which deletes `models.sonnetContextWindow` unconditionally.
2. Create the file. It must export two things:
   - `export const name = '<NNNN-short-kebab-name>'` — used in log lines. This is the
     ONLY consumer of the name; nothing parses the numeric prefix.
   - `export async function run({ root, log })` — does the work.
3. The first thing `run()` should do is probe for "already applied" and
   `return { applied: false }`. On real work, return
   `{ applied: true, summary: {...} }`.
4. Add the module to `ALL` in `migrations/index.mjs` — append to the end, or at the
   position its number implies if you letter-suffixed. `ALL` is the sole source of
   execution order (explicit imports, no glob), so keep it numerically sorted.

### Authoring conventions

- **Frozen artifacts.** Once a migration ships, don't edit it. New
  corrections go in a follow-up migration.
- **Built-ins only.** Use only `node:fs`, `node:path`, `node:os`, etc.
  Don't `import` from `../src/` — the codebase moves on; the migration must
  stay faithful to the world it was written for.
- **Aggressively idempotent.** Re-running on an already-migrated
  workspace must be a fast no-op.
- **Don't destroy data you can't reconstruct.** When in doubt, move
  artifacts into `<root>/.code-conductor/migrated-backup-<stamp>/...`
  instead of `rm`-ing them.
- **Respect `PROJECTS_ROOT`.** The runner passes `root` in — never hard-code
  an absolute projects-root path (e.g. a home-anchored `~/…`).

## Running outside the server

For debugging:

```sh
node -e "import('./migrations/index.mjs').then(m => m.runMigrations({ root: process.env.PROJECTS_ROOT }))"
```

Stop the orchestrator first — running migrations in parallel with a live
server is undefined.

## Listing

| Migration | Description |
|-----------|-------------|
| `0001-centralize-orchestrator-state` | Moves per-project `.code-conductor/` dotfolder state (project.json, attachments/, debug/, worktree.json) into a single central store at `<root>/.code-conductor/projects/<project>/...`. Removes the matching `.git/info/exclude` line from each worktree. |
| `0002-rename-group-to-workspace` | Renames the project-grouping field `group` to `workspace` in every `<root>/.code-conductor/projects/<project>/project.json`, and seeds `<root>/.code-conductor/workspaces.json` from the union of observed values so empty workspaces can persist independently of membership. |
| `0003-conduct-md-symlink` | **Superseded by 0010 — no longer registered in `index.mjs`.** Originally dropped a `<root>/.conduct/CONDUCT.md` symlink to the repo's `CONDUCT.md`. That path is now a fully-owned generated file, so the symlink job is obsolete; 0010 took over dropping the legacy symlink and repairing the `@…CONDUCT.md` import. The file is kept on disk (frozen) for history. |
| `0004-relocate-av-installs` | Moves the whisper.cpp + piper installs from the old default `$HOME/.code-conductor/{whisper.cpp,piper}` into the central store `<root>/.code-conductor/...` (the new default install root). No-op when `INSTALL_ROOT` is set (pinned location) or nothing is present at the old default. On a destination collision the stale old copy is moved to `<root>/.code-conductor/migrated-backup-<stamp>/` rather than clobbering the newer install. |
| `0005-rename-conducted-marker` | Renames the durable worker-session marker sidecar `<root>/.code-conductor/conductor-sessions.json` → `conducted-sessions.json` (the marker for MCP-spawned worker sessions was renamed conductor→conducted). No-op once the old file is gone. If both files exist, their `{sessions:[…]}` sets are unioned into the new file so no marker is lost. |
| `0007-migrate-legacy-model-settings` | Rewrites `<root>/.code-conductor/settings.json`: legacy `models.autoStopOnOverage:true` → `models.onOverage:'stop'` (only when `onOverage` is unset), legacy `models.fable5Enabled:false` → `models.enabledFamilies:{fable:false,...}` (only when `enabledFamilies` is unset). Both legacy keys are deleted unconditionally. No-op once neither legacy key is present. |
| `0008-migrate-tiered-session-summaries` | Rewrites old flat entries (`{summary,length,generatedAt,messageCount}`) in `<root>/.code-conductor/session-summaries.json` to the tiered `{[length]:{summary,generatedAt,messageCount}}` shape. Entries with an invalid `length` or empty `summary` are dropped. No-op once no entry is in the old flat shape. |
| `0009-seed-legacy-shell-installer-baseline` | Seeds `<root>/.code-conductor/workspace-claudemd/baseline.md` from the legacy shell-installer's `~/.cache/code-conductor-bootstrap/CLAUDE.md.installed`, if that legacy file exists and our baseline doesn't yet. No-op once the baseline exists or no legacy file is present. |
| `0010-conduct-md-generated-file` | Supersedes 0003. Removes the legacy `<root>/.conduct/CONDUCT.md` *symlink* so `ensureConductProject()` can regenerate it as a fully-owned file composed from `conduct/core.md` + enabled `conduct/modules/*.md`, and repairs a broken external `@…CONDUCT.md` import in `<root>/.conduct/CLAUDE.md` → `@CONDUCT.md` (0003's other job). No-op when CONDUCT.md is already a regular file (or absent) and CLAUDE.md carries no broken import. |
| `0011-rename-optional-guidelines-store` | Renames the custom-convention store `<root>/.code-conductor/optional-guidelines.json` → `project-conventions.json` (the "Optional guidelines" feature was renamed to "Project conventions", one noun — Conventions — across Conductor / Workspace / Project scopes). No-op once the old file is gone; skips (leaves both) if the destination already exists. |
| `0012-drop-retired-execution-modes-slug` | Drops the retired `execution-modes` slug (folded into `canonical-workflow`) from the `enabled` array in `<root>/.code-conductor/conduct-modules.json`, so `compose()` doesn't throw on a stale reference. No-op once the slug is absent. |
| `0013-drop-retired-talking-to-user-slug` | Drops the retired `talking-to-user` slug (folded into `conduct/core.md`) from the `enabled` array in `<root>/.code-conductor/conduct-modules.json`, so `compose()` doesn't throw on a stale reference. No-op once the slug is absent. |
| `0014-backfill-cache-miss-flags` | Backfills `cache_miss` onto pre-existing `<root>/.code-conductor/costs.jsonl` rows using the original session-relative heuristic (`cache_creation_tokens >= max(50000, 4 × median(non-first creation tokens))`, first turn per session and null-sessionId rows excluded). A row still carrying the old `cache_flush` key (a decisive live-captured verdict from before the field was renamed) is renamed in place — value preserved, not recomputed. Cache-miss detection is now decisive live (from the turn's first `message_start`); this is the heuristic's permanent home for legacy rows. Rewrites atomically. No-op once the file is absent, or every row has `cache_miss` and none still carries `cache_flush`. |
| `0015-enable-context-renewal-module` | Appends the new `context-renewal` slug to the `enabled` array in `<root>/.code-conductor/conduct-modules.json`, for any install that already has a persisted selection (the SEED_MODULES "default enabled" fallback only covers installs with no selection at all). No-op once the slug is present, or if the file/array doesn't exist yet. |
| `0016-migrate-family-settings-to-tiers` | Rewrites `<root>/.code-conductor/settings.json`: `models.enabledFamilies` → `models.enabledTiers` and `models.defaultFamily` → `models.defaultTier` (mapped via the frozen `haiku:fast, sonnet:balanced, opus:powerful, fable:frontier` table), and seeds `models.tierBackend` to the default tier→backend binding (`{fast:haiku, balanced:sonnet, powerful:opus, frontier:fable}`) if absent. Legacy keys are deleted unconditionally. No-op once neither legacy key is present. |
| `0017-collapse-tier-backend-to-kind-model` | **Superseded by 0018b — no longer registered in `index.mjs`.** Originally collapsed `models.tierBackend[tier]` from a family key / `ollama:<slug>` string to `{kind,model}`, dropped `id`+`host` from `models.customBackends`, deleted the dead per-family active-version keys, and reshaped the `session-backends.json` sidecar from `{backends:{sid:{kind}}}` to the `{sessions:[…]}` set form. 0018b renames the `kind` key it keyed its own "already applied?" probe on, so leaving it registered would make it re-run every boot and reset every tier binding to its Claude default; 0018b absorbs all of those pre-0017 shapes instead. The file is kept on disk (frozen) for history. |
| `0018-session-backends-carry-model` | Reshapes `<root>/.code-conductor/session-backends.json` from the set form `{sessions:[sid,…]}` (0017's output) to the map form `{sessions:{sid: model|null}}`, so the sidecar can carry each ollama session's full tagged launch model (the tag the CLI drops from its jsonl). Pre-existing sessions get `null` (tag was never persisted) and self-heal on their next tagged relaunch. No-op once `sessions` is already an object (or the file is absent). |
| `0018b-backend-registry` | Turns the hardcoded `claude`/`ollama` provider union into the data-driven backend registry. **Letter-suffixed to run between `0018` and `0019`:** `0019` deletes `models.sonnetContextWindow` unconditionally, and on a pre-0017 store its backfill guard cannot match the still-STRING tier bindings — running it first would destroy a user's explicit 200k Sonnet pin. Acts on `<root>/.code-conductor/settings.json`: seeds `models.backends` as an empty array (the two managed rows — `claude` identity + `ollama` with template `ollama launch claude --model {model} --yes --` — are code-authoritative in `src/modelVersions.js`; `getBackends()` reads only their `env` from the store, so the key's mere PRESENCE is what marks this migration applied); re-keys every concrete `models.tierBackend[tier]` / `models.roleBackend[role]` binding from `{kind,model}` to `{backend,model}` (same value), leaving tier-reference bindings `{kind:'tier',tier}` untouched — iterating `roleBackend`'s values covers plugin-role override keys (`<plugin-id>/<slug>`) too; and renames `models.customBackends` → `models.customModels`, adding `backend:'ollama'` plus the now-REQUIRED `contextWindow` (kept if declared, else the curated-catalog value for that tag, else 200000). Also reshapes `<root>/.code-conductor/session-backends.json` from `{sessions:{sid: model|null}}` to `{sessions:{sid:{backend:'ollama', model}}}`, **carrying the existing tagged model across** (it is the authority for a tag the CLI jsonl can't hold). **Absorbs `0019`'s job** as a consequence of the ordering: inlines `models.sonnetContextWindow` onto every selectable-Sonnet (4.x) `claude` binding in `tierBackend` + `roleBackend` — both the pre-0017 family-key-string form it materializes and the post-0017 `{kind,model}` form — never overwriting a window already on a binding, then deletes the global. That leaves `0019` permanently `applied:false` while it stays registered as the historical record. No-op once `models.backends` exists and every sidecar value is an object. |
| `0019-inline-sonnet-window-into-bindings` | Moves the Sonnet context window from the global `models.sonnetContextWindow` into the bindings that use it: backfills the old global as `window` onto every persisted Sonnet 4.x Claude binding in `models.tierBackend` + direct-claude `models.roleBackend`, then deletes the global. Exhaustive without silent flips — the only bindings the global could affect (explicit Sonnet 4.x; the default `balanced`=Sonnet 5 is fixed-1M) are exactly the persisted ones. Non-Sonnet / Sonnet-5 / Ollama / tier-reference bindings untouched. No-op once the global key is absent. **Now permanently inert:** `0018b` runs before it and consumes the global for both binding shapes, so its probe is false on every store from here on; kept registered as the historical record and so an already-migrated store still reads as applied. |
| `0020-consolidate-convention-stores` | Consolidates the three convention-scope stores under a shared `<root>/.code-conductor/conventions/` dir (matching the source-tree move to `conventions/{conductor,workspace,project}/`): `conduct-modules.json` → `conventions/conductor.json`, `workspace-modules.json` → `conventions/workspace.json`, `project-conventions.json` → `conventions/project.json`. The "modules" noun was renamed to "conventions" across all three scopes (loaders, REST routes, MCP tool). Idempotent: skips a scope whose old file is gone; never clobbers an existing destination. Runs after the frozen `enabled`-mutating migrations (0012/0013/0015), which keep pointing at the old flat `conduct-modules.json` and no-op once this has moved it. |
| `0021-strip-plugin-slugs-from-conductor-conventions` | Strips plugin conductor-convention slugs (`<plugin-id>/<slug>`, contain `/`) out of the `enabled` array in `<root>/.code-conductor/conventions/conductor.json` (the path 0020 relocates to — runs after it). Plugin conventions are now on-by-default for enabled plugins (derived from the live catalog) with only explicit off-switches persisted (`pluginOff`), so `enabled` holds seed/custom slugs only. Cosmetic cleanup — does **not** populate `pluginOff` (these were user-enabled; leaving them out keeps them on). Consequence (intended): a convention that was default-off under the old model turns on after upgrade for an already-enabled plugin. No-op once `enabled` holds no `/`-slug. |
| `0022-drop-conduct-md-file` | Supersedes 0010. The conductor role doc is now composed fresh and injected at spawn via `claude --append-system-prompt` (`Instance.launch`/`spawn` in `src/instances.js`), so the on-disk delivery is obsolete. Removes the orphan generated `<root>/.conduct/CONDUCT.md` (unlink also clears any legacy symlink) and strips the `@CONDUCT.md` seed line from `<root>/.conduct/CLAUDE.md`, preserving any other lines; the CLAUDE.md is unlinked only when the remainder is blank (a lone-seed file), so a hand-customized one is kept. No-op once CONDUCT.md is absent and CLAUDE.md carries no `@CONDUCT.md` line. |
| `0023-clamp-compact-window-floor` | Bumps a persisted `models.conductorCompactWindowK` below the new `COMPACT_K_MIN` (100, i.e. 100k tokens) up to 100, in `<root>/.code-conductor/settings.json`. The Claude Code CLI floors `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at 100,000 tokens itself, so a persisted value below 100 was already a silent no-op at spawn time — this normalizes pre-existing installs to match. No-op once no persisted value is below 100. |
| `0024-drop-managed-backend-env-overrides` | Managed-backend `env` became fully code-authoritative (empty, from `MANAGED_BACKENDS` in `src/modelVersions.js`), so `getBackends()` no longer reads a managed row's `env` from the store — exactly mirroring how its `id`/`label`/`template` were already code-authoritative. Strips any stored `{id, env}` managed-row entries (`claude`/`ollama`) from `<root>/.code-conductor/settings.json` `models.backends` (dead data the reader now ignores); user rows pass through untouched. No-op once `models.backends` holds no managed-id entry (or the array/file is absent). |
