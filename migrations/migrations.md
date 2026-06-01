# Migrations

This directory holds idempotent migration scripts that mutate on-disk state to
keep the workspace aligned with the current codebase. They run **automatically
on server startup** via `migrations/index.mjs`, which is invoked by
`server.js` before the HTTP listener binds.

## How auto-run works

`server.js` calls `runMigrations({ root: projectsRoot() })` once at boot:

- Each migration runs in order (oldest first).
- A migration that detects "already applied" returns
  `{ applied: false }` and exits in a few milliseconds — the normal case on
  every boot after the first.
- A migration that does real work returns `{ applied: true, summary }` and
  the runner logs a one-line summary like
  `migration 0001-centralize-orchestrator-state: applied — {"projectsMigrated":3,...}`.
- A migration that throws **aborts the boot**. Fix the error and restart.

## When to apply a migration

You don't — they apply themselves the next time you start the server. If a
release ships with a new migration, just `git pull && npm start`.

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
- **Respect `PROJECTS_ROOT`.** The runner passes `root` in — never hard-
  code `~/cc-projects` or `~/project`.

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
| `0003-conduct-md-symlink` | Drops a `<root>/.conduct/CONDUCT.md` symlink to the repo's `CONDUCT.md`, and rewrites any external `@…CONDUCT.md` line in `<root>/.conduct/CLAUDE.md` to `@CONDUCT.md`. Other lines (user customisations) are preserved verbatim. Fixes silent no-op of external @-imports in headless / `-p` mode. |
| `0004-relocate-av-installs` | Moves the whisper.cpp + piper installs from the old default `$HOME/.code-conductor/{whisper.cpp,piper}` into the central store `<root>/.code-conductor/...` (the new default install root). No-op when `INSTALL_ROOT` is set (pinned location) or nothing is present at the old default. On a destination collision the stale old copy is moved to `<root>/.code-conductor/migrated-backup-<stamp>/` rather than clobbering the newer install. |
