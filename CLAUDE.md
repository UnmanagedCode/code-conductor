@../CLAUDE.md
@CONVENTIONS.md

## Exploring this repo

Always read `README.md` at the project root before exploring the codebase. It has up-to-date functional and technical overviews (project list behavior, worktree layout, server architecture, etc.) and will usually answer orientation questions without needing to grep the source.

When `README.md` doesn't go deep enough, load the relevant detail file:
- **Feature / UI behavior** → `docs/features.md`
- **Backend registry (launch templates + env), custom models, tiers/roles, Claude context windows** → `docs/models.md`
- **Subprocess protocol, WebSocket messages, REST endpoints** → `docs/protocol.md`
- **Component layout, instance lifecycle, on-disk state, migrations, testing** → `docs/architecture.md`
- **Conductor role prompt / orchestration contract** → `conventions/conductor/core.md` (always-on core) + `conventions/conductor/*.md` (toggleable conventions); composed by `src/conductorConventions.ts` (`composeCurrentConduct`) and injected at conductor spawn via `claude --append-system-prompt` (`Instance.launch`/`spawn` in `src/instances.ts`)
- **Conventions (three scopes, all on `src/fragmentCatalog.ts`; sources under `conventions/<scope>/`, stores under `<store>/conventions/<scope>.json`)** → Conductor: `conventions/conductor/*` + `src/conductorConventions.ts` (injected at spawn via `--append-system-prompt`). Workspace: `conventions/workspace/core.md` + `conventions/workspace/*.md` + `src/workspaceConventions.ts`, regenerated into the app-owned projects-root `CLAUDE.md` by `src/rootClaudeMd.ts` (`ensureRootClaudeMd`). Project: `conventions/project/*.md` + `src/projectConventions.ts`, regenerated into each project's in-tree `CONVENTIONS.md` by `src/projectClaudeMd.ts` (selection = its line-1 `<!-- cc:conventions … -->` marker) and imported by that project's `CLAUDE.md` via `@CONVENTIONS.md` — as this repo does.

## Code conventions

Where the `CONVENTIONS.md` rules land in this codebase. Rationale + examples in `docs/architecture.md` → "Conventions".

- Thin wiring: feature logic lives in a `public/` `installX({...})` module (or a stateful class); app.js builds state + DOM, calls each installX once, injects live state via getters.
- One implementation across surfaces: git/worktree/diff/session logic lives once in `src/worktrees.ts` + siblings, imported by both `routes.ts` and `mcp/handlers.ts`.
- Single-source catalogs: `modelVersions`/`whisperModels`/`ttsModels` own the authoritative list + allow-list server-side; the client fetches them.
- Migrations go in `migrations/` (see `migrations/migrations.md`). cc has no external API clients, so the whole MCP/REST surface is unstable-by-design; the only read-time-tolerance exception is the Claude CLI's session jsonls.

## Documentation guidelines

`docs/models.md` (see "Exploring this repo" above) is a fifth layer alongside the four in `CONVENTIONS.md`.

## Testing

- `npm test` is the gated command (runs the `pretest` typecheck); bare `node tests/run.mjs` skips it.
- Built-in runner here is `node:test` + `node:assert`; no extra deps (Termux).
- Fake-binary env var: `CLAUDE_BIN`. Real-binary smoke gate: `RUN_REAL_CLAUDE=1`.
