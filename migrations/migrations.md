# Migrations

This directory holds idempotent migration scripts that mutate on-disk state to
keep the workspace aligned with the current codebase. They run **automatically
on server startup** via `migrations/index.mjs`, which is invoked by
`server.ts` before the HTTP listener binds.

## How auto-run works

`server.ts` calls `runMigrations({ root: projectsRoot() })` once at boot. Migrations run in order (oldest first); each self-checks "already applied?" and returns `{ applied: false }` as a fast no-op (steady state) or `{ applied: true, summary }` (logged one-line, e.g. `migration 0001-centralize-orchestrator-state: applied — {…}`). A migration that **throws aborts the boot** — fix and restart. You never run them by hand; a new release's migration applies itself on the next `git pull && npm start`.

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
- **A FIXED-path snapshot, when the snapshot's value is the PRE-migration
  state.** `<stamp>` is right for a move-aside, whose destination must be
  unique across runs. It is wrong for a whole-store snapshot taken once at
  step 0: a resumed run would stamp a fresh directory and capture a
  half-migrated store — worse than useless — and every boot would leave
  another. `0037` writes `migrated-backup-0037/` once, via `…-0037.tmp/` +
  `fs.rename`, and skips the step entirely when it already exists.
- **An UNRESOLVED LEDGER, for a per-item migration whose items can refuse.**
  Classify every failure as either a refusal ABOUT THE INPUT (this item cannot
  be processed and retrying will not change that) or a fault about the
  ENVIRONMENT (throw; the operator fixes it and restarts) — there is no third
  outcome and no silent `continue`. A refusal is recorded in
  `<root>/.code-conductor/migration-<n>-unresolved.json`, written incrementally
  and atomically, logged with its manual repair, and EXCLUDED from the
  convergence probe so the migration converges around it instead of
  re-running for ever. Removing an entry by hand re-arms the retry. `0037` is
  the first migration with one.
- **A completion marker, when the migration BACKFILLS from a source that
  stops being authoritative afterwards.** A structural probe cannot see the
  difference between "not migrated yet" and "the user made this after the
  migration" — `0037` backfills a project record from a directory in the
  projects root, which is an ordinary grouping directory once the model
  changed. It writes `migration-<n>-complete.json` as its last act and
  enumerates those one-time sources only while the marker is absent; the
  structural clauses still run, and are what heals a torn row afterwards.
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

See `migrations/` (and `ALL` in `migrations/index.mjs`) for the current set of migrations; each migration file carries its own self-check summary (a `Before`/`After` header comment describing the state transition and its idempotency probe). Superseded migrations are kept on disk (frozen) for history and noted as such in their header — they are no longer registered in `ALL`.
