@../CLAUDE.md

## Exploring this repo

Always read `README.md` at the project root before exploring the codebase. It has up-to-date functional and technical overviews (project list behavior, worktree layout, server architecture, etc.) and will usually answer orientation questions without needing to grep the source.

When `README.md` doesn't go deep enough, load the relevant detail file:
- **Feature / UI behavior** → `docs/features.md`
- **Subprocess protocol, WebSocket messages, REST endpoints** → `docs/protocol.md`
- **Component layout, instance lifecycle, on-disk state, migrations, testing** → `docs/architecture.md`
- **Conductor role prompt / orchestration contract** → `conduct/core.md` (always-on core) + `conduct/modules/*.md` (toggleable modules); composed into the live `.conduct/CONDUCT.md` by `src/conductModules.js`
- **Conventions (three scopes, all on `src/fragmentCatalog.js`)** → Conductor: `conduct/*` + `src/conductModules.js` (→ `.conduct/CONDUCT.md`). Workspace: `baseline/core.md` + `baseline/modules/*.md` + `src/workspaceModules.js`, regenerated into the app-owned projects-root `CLAUDE.md` by `src/rootClaudeMd.js` (`ensureRootClaudeMd`). Project: `project-conventions/*.md` + `src/projectConventions.js`, snapshotted into each new project's `CLAUDE.md` at creation.

## Code conventions

Load-bearing rules — stay inside them when writing code. Rationale + examples in `docs/architecture.md` → "Conventions"; don't restate it here.

- **YAGNI** — implement only what a current, concrete requirement needs; no speculative abstractions/config/extension points "for later." If code isn't exercised by a real caller or test, remove it rather than keep it "just in case."
- Feature logic lives in a `public/` `installX({...})` module (or a stateful class); **app.js is bootstrap/wiring only** — build state + DOM, call each installX once, inject live state via getters. Don't grow app.js with feature logic.
- **No god-modules** — when a module takes on a second responsibility, extract it as a composed collaborator with a stable delegating surface (cf. InstanceManager→IdleSubscriptionHub/OverageResumeController, handlers.js→diffPaging/messageReconstruction, whisper/tts→installRunner).
- **REST and MCP share one service layer** — git/worktree/diff/session logic lives once (`src/worktrees.js` + siblings), imported by both `routes.js` and `mcp/handlers.js`; never reimplement per surface.
- **Single-source-of-truth catalogs shipped to the client** — `modelVersions`/`whisperModels`/`ttsModels` own the authoritative list + allow-list server-side and are fetched by the client; never hardcode the canonical set as client literals (a first-paint fallback is fine — it's a fallback, not a second source).
- **No read-time backwards compatibility** — the conductor has no external API clients, so there's no stable-API obligation. When a persisted format or config key changes, ship a one-shot migration in `migrations/` (see `migrations/migrations.md`) and make application code assume the current format; never keep legacy aliases, dual-shape parsing, or "back-compat" defaults on the MCP/REST surface. Exception: read-time tolerance is allowed for formats owned by external tools (e.g. the Claude CLI's session jsonls) that we can't migrate.

## Documentation updates

When a turn meaningfully changes user-facing behavior, update the **correct detail file** — not just the README:

| Change type | File to update |
|---|---|
| New/changed UI element, feature behavior, MCP tool | `docs/features.md` + one-liner summary in `README.md` if it adds a new top-level subsystem |
| Subprocess protocol flag, WebSocket message type, REST endpoint | `docs/protocol.md` |
| New source file, component wiring, lifecycle change, on-disk layout, migration, test pattern | `docs/architecture.md` |
| Quick start step, key default, known limitation | `README.md` directly |

## Testing

Prefer **automated integration tests** over manual verification checklists when shipping a feature. Write runnable proof, not a script for the user to follow by hand.

- In plan files, use an "Integration tests" section listing the actual test files, what they cover, and the command to run them (e.g. `node tests/run.mjs`) — not a "Manual verification" section.
- Use Node's built-in `node:test` + `node:assert` runner unless a project already uses another framework — no extra deps on Termux.
- For tests that would otherwise hit expensive/external systems (e.g. the real `claude` CLI), build a small fake binary (a Node script emitting canned stream-json) and inject it via env var (e.g. `CLAUDE_BIN`). Keep one real-binary smoke test if practical, but gate it behind an env flag (e.g. `RUN_REAL_CLAUDE=1`).
- Run tests as the last implementation step and report pass/fail, rather than asking the user to click through the UI.
