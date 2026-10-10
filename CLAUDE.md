@CONVENTIONS.md

## Exploring this repo

Always read `README.md` at the project root before exploring the codebase. It has up-to-date functional and technical overviews (project list behavior, worktree layout, server architecture, etc.) and will usually answer orientation questions without needing to grep the source.

When `README.md` doesn't go deep enough, load the relevant detail file — every doc named below is a layer under `CONVENTIONS.md`'s "update the most specific file" rule:
- **Feature / UI behavior** → `docs/features.md`
- **The web UI** → `web/`, the React UI served at `/next/` beside the old `public/` UI; its shared client modules are `public/` files reached through the `@/lib/core/*` alias. Build, mounts and layout: `docs/architecture.md` → `src/webBuild.ts`, `web/`
- **Backend registry (launch templates + env), custom models, tiers/roles, Claude context windows** → `docs/models.md`
- **Subprocess protocol, WebSocket messages, REST endpoints** → `docs/protocol.md`
- **Component layout, instance lifecycle, on-disk state, migrations, testing** → `docs/architecture.md`
- **Project name → directory resolution** → `resolveProjectDir` in `src/projects.ts` is the single chokepoint every project path comes from, and it is ONE record read; `registerProject` is the one guarded writer. The realpath rule, the delete-means-deregister rule and the reserved-name refusal are in `docs/architecture.md` → `src/projects.ts`
- **Plugin manifest schema, reverse proxy + bridge protocol, `/api/plugins`, Plugin Library** → `docs/plugins.md`
- **Windows launcher / installer contract (installer itself is the separate code-conductor-windows project)** → `docs/windows.md`
- **Host-OS differences (spawn options, shell, kill, command splitting, path keys, feature capabilities)** → `Platform` in `src/platform/`; no `process.platform` elsewhere
- **Project-scoped I/O — git, files in a project tree, commands run in one** → take the project's `System` handle (`src/systems/`) rather than bare `node:fs`/`spawn`; `docs/architecture.md` → Conventions carries the rule and the list of sanctioned exceptions
- **The System provider wire protocol — frames, capabilities, the `exec` lifecycle, the derivations, the error taxonomy, how to write or verify a provider** → `docs/systems-protocol.md`
- **A remote worker's FUSE-union chroot — the tier table, the mount record, teardown, the boot sweep** → `src/systems/fuse/`; `docs/architecture.md` → "The FUSE-union chroot" and "FUSE teardown"
- **Conductor role prompt / orchestration contract** → `conventions/conductor/core.md` (always-on core) + `conventions/conductor/*.md` (toggleable conventions); composed by `src/conductorConventions.ts` (`composeCurrentConduct`), written to `.conduct/CONVENTIONS.md` by `materializeCurrentConduct` (`src/conduct.ts`) before every conductor spawn/resume from `Instance.launch` (`src/instances.ts`), and loaded via that dir's `CLAUDE.md` `@CONVENTIONS.md` import
- **Conventions (three scopes, all on `src/fragmentCatalog.ts`; sources under `conventions/<scope>/`, stores under `<store>/conventions/<scope>.json`)** → Conductor: `conventions/conductor/*` + `src/conductorConventions.ts` (regenerated into `.conduct/CONVENTIONS.md` before every spawn by `src/conduct.ts`, imported by `.conduct/CLAUDE.md` via `@CONVENTIONS.md`). Workspace: `conventions/workspace/core.md` + `conventions/workspace/*.md` + `src/workspaceConventions.ts`, composed into every project's in-tree `CONVENTIONS.md` by `src/projectClaudeMd.ts` (above the project block) and into `.conduct/CONVENTIONS.md` by `src/conduct.ts` — no file outside the projects. Project: `conventions/project/*.md` + `src/projectConventions.ts`, regenerated into each project's in-tree `CONVENTIONS.md` by `src/projectClaudeMd.ts` (selection = its line-1 `<!-- cc:conventions … -->` marker) and imported by that project's `CLAUDE.md` via `@CONVENTIONS.md` — as this repo does.

## Code conventions

Where the `CONVENTIONS.md` rules land in this codebase. Rationale + examples in `docs/architecture.md` → "Conventions".

- Thin wiring: feature logic lives in a `public/` `installX({...})` module (or a stateful class); app.js builds state + DOM, calls each installX once, injects live state via getters.
- Thin wiring in `web/`: UI feature logic lives in `web/src/features/<area>/` (DOM-free logic in the `@/lib/core` modules, the transcript model in `web/src/conversation/`); `main.tsx`/`App.tsx` only mount and start features. Features reach each other only through the `open*` APIs (`features/dialogs/api.ts`, `features/views/api.ts`) and `app/events.ts`.
- One implementation across surfaces: git/worktree/diff/session logic lives once in `src/worktrees.ts` + siblings, imported by both `routes.ts` and `mcp/handlers.ts`.
- Single-source catalogs: `modelVersions`/`whisperModels`/`ttsModels` own the authoritative list + allow-list server-side; the client fetches them.
- Migrations go in `migrations/` (see `migrations/migrations.md`). cc has no external API clients, so the whole MCP/REST surface is unstable-by-design; the only read-time-tolerance exception is the Claude CLI's session jsonls.

## Testing

- `npm test` is the gated command (runs the `pretest` typecheck, which also checks `web/`); bare `node tests/run.mjs` skips it.
- `npm run test:web` is the Vitest suite for `web/`; it is not part of `npm test`. `npm run test:all` runs both and is the gate for any work touching `web/`.
- The node suite's runner is `node:test` + `node:assert` and adds no dependency (Termux).
- Fake-binary env var: `CLAUDE_BIN`. Real-binary smoke gate: `RUN_REAL_CLAUDE=1`.
