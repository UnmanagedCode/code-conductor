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
2. Create the file. It must export two things:
   - `export const name = '<NNNN-short-kebab-name>'` — used in log lines.
   - `export async function run({ root, log })` — does the work.
3. The first thing `run()` should do is probe for "already applied" and
   `return { applied: false }`. On real work, return
   `{ applied: true, summary: {...} }`.
4. Append the module to `ALL` in `migrations/index.mjs`.

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
