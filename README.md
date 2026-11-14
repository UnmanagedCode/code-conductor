<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-light.svg" alt="Code Conductor" width="296">
  </picture>
</p>

# CodeConductor

[Promo video](https://unmanagedcode.github.io/code-conductor-promo/) · [Windows installer releases](https://github.com/UnmanagedCode/code-conductor-windows/releases)

Local webapp for orchestrating multiple Claude Code CLI instances across projects in the parent directory of this repo (override with the `PROJECTS_ROOT` env var). Spawn, watch, and interact with several `claude` subprocesses in parallel from one browser tab.

Runs on Termux (localhost-only, single user) or any host with Node 24+ and the `claude` CLI on `$PATH`. Windows 11: see [Windows](#windows). Server-side `src/*.ts` runs directly via Node 24's native type stripping (no build step) and is type-checked by an enforced `tsc --noEmit` gate — see `npm run typecheck` below.

```
        browser tab               HTTP + WS (:8787)
       (React web UI)      ┌──────────────────────┐
             │◄────────────►│   Node server        │
             │              │  (express + ws)      │
             │              └─────────┬────────────┘
             │                   ┌────┴───┬──────┐
             │           ┌───────┴───┐ ┌──┴──────┐ ┌─────────┐
             └──────────►│ claude -p │ │claude -p│ │claude -p│
                         │ project A │ │project B│ │project C│
                         └───────────┘ └─────────┘ └─────────┘
                         (stream-json stdin/stdout per instance)
```

## Quick start

```bash
git clone <repo-url> code-conductor
cd code-conductor
npm install            # express, ws, typescript + @types/node (dev)
npm start              # http://127.0.0.1:8787  (process title: code-conductor)
npm run typecheck      # strict tsc, both halves: typecheck:node (the root program: server, harness; + shared/) + typecheck:web (web/, bridge, web/e2e)
npm test               # both typecheck halves, node:test suite, then the web Vitest suite — the gate
npm test -- <files>    # tests/ files to node, web/src/ files to Vitest, each after its typecheck half
npm test -- --changed  # only the suites the diff against main reaches; unclassifiable runs everything. A pre-merge shortcut, not a substitute for the full gate
RUN_REAL_CLAUDE=1 npm test   # also runs opt-in real-claude smoke
npm run test:node      # node:test suite only, after typecheck:node (-- <files>; no flags)
npm run test:web       # web UI suite only (Vitest, web/), after typecheck:web (-- <file> or -t name)
npm run test:e2e       # web UI end-to-end (Playwright; first: npx playwright install chromium)
npm run dev:web        # Vite dev server for web/, proxying the API to a running cc (CC_DEV_SERVER)
npm run build          # build web/ into web/dist/ by hand (the server also builds it at start and before a restart)
PORT=8790 npm run start:isolated   # an isolated cc: scratch projects root + empty Claude config dir (CC_ISOLATED_ROOT), no Claude login
PROJECTS_ROOT=/abs/root PORT=8791 node server.ts --prompt 'summarise the repo'   # one headless conductor run: JSON result on stdout, logs on stderr
```

Prefer containers? **Docker Compose**: [docker/README.md](docker/README.md) — one host projects dir + this checkout.

- **Startup check** — boot probes the `claude` CLI and its credentials, then prints `claude OK` or one framed `WARNING` listing each issue. The server starts either way; sign in from **Settings → Account → Claude login** (or `claude auth login`), no restart needed. [`src/health.ts`](docs/components/web.md#srchealthts).
- **Startup session cleanup** — each boot drops session records whose transcripts are all gone, after saving the store's pre-image, and removes nothing when every record looks transcript-less (a wrong `HOME` / `CLAUDE_CONFIG_DIR`). Rules: [`src/sessionCleanup.ts`](docs/components/store.md#srcsessioncleanupts).
- **Workspace conventions** — composed from `conventions/workspace/` into every project's tracked `CONVENTIONS.md` and into `.conduct/CONVENTIONS.md`. The files are app-owned and overwritten: edit them in **⚙ Settings → Conventions → Workspace**.
- **Voice (optional)** — install a dictation model (whisper.cpp) or a speech voice (Piper) from **⚙ Settings → Voice**, or run `bin/install-whisper.sh` / `bin/install-piper.sh` by hand; the composer mic and the 🔊 buttons appear once installed. Env overrides: [docs/architecture.md](docs/architecture.md#environment-variables); build internals: [`transcribe.ts`](docs/components/restart.md#srctranscribets), [`tts.ts`](docs/components/restart.md#srcttsts).
- **Install on Android** — Chrome → ⋮ → **Install app** / **Add to home screen** launches it standalone, also through an authenticated proxy such as a code-hub share; it needs HTTPS or loopback. [docs/features.md](docs/features.md#the-ui) → PWA and service worker.
- **Web UI** — `web/` is the React UI served at `/`, rebuilt into `web/dist/` at start when its sources changed; `shared/` holds the modules it shares with the server and the node tests (`@shared/*`). [docs/components/web.md](docs/components/web.md#srcwebbuildts).
- **Browser tests** — one Playwright harness in `web/e2e/` (`npm run test:e2e`, not part of `npm test`): [`web/e2e/README.md`](web/e2e/README.md). Mutation testing over the node, Vitest and Playwright suites: [`harness/mutation/README.md`](harness/mutation/README.md).

## Features

- **Projects & workspaces** — sidebar project list with git-status pills, nested under collapsible workspaces. A project is a stored record (`<store>/projects/<name>/project.json`) whose tree may sit under the projects root, anywhere else on disk, or on a [system](#systems); a directory is not a project until it is registered.
- **Adding and deleting projects** — **+ Add project** (`adopt_project`, `POST /api/projects/external`) registers an existing directory in place, nothing copied or moved. Deleting deregisters: the tree stays unless you tick the opt-in, which a project on a system does not offer.
- **Worktrees** — isolated git worktrees per spawn; two-step land-back: sync (FF, auto-rebase, or a rebase brief handed back for the conductor/user to dispatch) then no-ff merge into parent.
- **Diff & history** — a mobile-friendly full-page diff browser for a worktree's `base...HEAD`, a project's commit log with a branch-graph rail, and any single commit.
- **Sessions & instances** — unified live + historical session list; conducted sessions (MCP-spawned, durable marker); normal and persistent sessions (↑ makes a live one persistent); rewind & fork; crash recovery; session anchor (`#session=<sid>`).
- **Power menu & resume banner** — **Restart** and **Shut down** carry live sessions over and re-spawn them on the next boot, where a banner offers **Continue** / **Dismiss**; a crash is recovered the same way. [docs/features.md](docs/features.md#ui-elements) → Power menu, Resume banner.
- **Spawn options** — mode, effort, thinking, capability tier (each bound in Settings → Models to a backend + model and a default effort), persistent session, debug capture. Every model has one native context window. [docs/models.md](docs/models.md).
- **Live conversation** — streaming markdown, thinking blocks, tool diffs, plan and question cards, per-sentence TTS read-aloud, tail-first history with scroll-up lazy-load across renews and prunes.
- **UI elements** — task panel, a context-usage + rate-limit chip beside Send, voice dictation, a settings page (models and roles, backends, account and overage, voice, conventions, archived sessions), OS notifications.
- **Conduct mode** — `🎼 Conduct` spawns a conductor in the `.conduct` project that orchestrates workers over MCP, its role prompt composed from **Settings → Conventions → Conductor**. A **Workers** panel tracks its workers, and a finished worker wakes it with its output folded in.
- **Headless mode** — `node server.ts --prompt <text>` runs one conductor session with no browser and prints one JSON result; `make headless` runs one in docker. [docs/features.md](docs/features.md#headless-mode).
- **Playbooks** — declarative, enforceable conductor workflows: stage graphs whose illegal moves are refused at the MCP boundary, every governed call logged to `<store>/events.jsonl` ([docs/event-log.md](docs/event-log.md)). Built-in, your own, or plugin-shipped; `enforce` out of the box. [docs/protocol.md](docs/protocol.md#playbooks).
- **MCP interface** — `mcp__code-conductor__*` tools auto-registered at spawn; a worker's handle is its permanent `sessionId`. The same `/mcp` serves applications in JSON with a REST alias ([docs/mcp-applications.md](docs/mcp-applications.md)), and `run_code` chains calls in one program ([docs/code-mode.md](docs/code-mode.md)). Attach another Claude Code session: `claude mcp add --transport http code-conductor 'http://127.0.0.1:8787/mcp?format=text'` (anonymous, so caller-dependent tools refuse). Wire contract: [docs/protocol.md](docs/protocol.md#mcp-tool-protocol); catalog: [docs/features.md](docs/features.md#mcp-interface).
- **Cost dashboard** — a `#costs` view of spend by project, model and day, a per-session **Statistics** panel, and cross-turn cache-miss detection.
- **Core skills** — `claude-plugin/` is passed as `--plugin-dir` to every session, so its skills appear as `code-conductor:<skill>`. [docs/features.md](docs/features.md#core-skills).
- **Plugins** — projects with a `conductor.plugin.json` run as embedded extensions: a supervised backend, an iframe frontend, forwarded MCP tools, conventions, roles, playbooks, row-⋮ buttons and Claude Code skills. Managed in **⚙ Settings → Plugins** + **Plugin Library**; trusted own code, no sandboxing. [docs/plugins.md](docs/plugins.md); UI: [docs/features.md](docs/features.md#plugins).

See [docs/features.md](docs/features.md) for the exhaustive feature and UI-element catalog.

## Windows

cc runs on Windows 11 under Git for Windows (Git Bash); Systems, the FUSE union and Voice are off there. The per-user installer is the separate `code-conductor-windows` project — see [docs/windows.md](docs/windows.md).

## Systems

A **System** puts a project's tree, git repo and shell commands on another machine, chosen per project when it is created or added. It is an execution environment, not a remote filesystem: cc ships no transport, you register a **provider command** (argv) in **⚙ Settings → Systems**, and one system can serve many named targets (`remoteId`).

| | Where it runs |
|---|---|
| the `claude` CLI, cc's store, `~/.claude/` | **cc's host**, the CLI inside a chroot onto a FUSE union rooted at the system |
| the project tree, its git repo, `Bash` | **the system** |
| `Glob` / `Grep` | **refused**; `find` / `grep` through `Bash` run on the system |

- Using one (create, adopt, change target, delete, refusals): [docs/features.md](docs/features.md#projects--workspaces) → Projects on a system, Worker sessions on a system.
- Writing a provider: [docs/systems-protocol.md](docs/systems-protocol.md); `tests/systems-protocol-conformance.test.mjs` is the definition of a valid one.
- Internals: [`src/systems/`](docs/components/systems.md#srcsystems), [`src/systems/fuse/`](docs/components/fuse.md#srcsystemsfuse); gates and suites: [docs/testing-systems.md](docs/testing-systems.md); on-disk state: [docs/architecture.md](docs/architecture.md#on-disk-state).

## Key defaults

- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load). Override with `PROJECTS_ROOT=<abs-path>`. cc's own state lives under this dir — the central store at `<root>/.code-conductor/`, every local worktree checkout at `<root>/.worktrees/<project>/<key>/`, Library plugin installs at `<root>/.plugins/<name>/`, and the hidden `.conduct` project. A **project's** tree may be anywhere its record says, inside this dir or not.
- **Transcripts**: a local session's jsonls live in the CLI's own `<configDir>/projects/` (`CLAUDE_CONFIG_DIR`, default `~/.claude`); a remote-backed place gets a cc-owned config dir per `(system, remoteId)` under the store.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- **One server per projects root**: a second server on a held root exits **7** naming the holder's pid; a dead holder's root boots again at once. [The projects-root lock](docs/components/headless.md#the-projects-root-lock).
- **New instance**: `plan` mode, `adaptive` thinking, and the Settings → Models row the spawn names (`role` / `tier`, else the default spawn tier), so it always launches with an explicit `--model`; effort comes from that row (`high` out of the box). MCP `spawn_instance` always spawns a normal session. [docs/models.md](docs/models.md#default-effort).
- **Resume**: without an explicit `mode` / `model`, a session comes back in the mode and on the backend + model it last ran (`<store>/sessions.json`); an unrecorded one resumes `bypassPermissions`, which `list_sessions` flags `resumes-hot`.
- **Event ring**: capped per instance (`ORCH_EVENT_RING_CAP`); older events page from `GET /api/instances/:id/events`.
- Control-request timeout and kill grace are fixed defaults in `Instance` (see `src/instances.ts`).

## Known limitations

- **Overage auto-stop is global** — **Settings → Account → Action on overage** (`Off` / `Stop` / `Stop & resume`) covers every session; `Stop & resume` is a hard lockout that queues every send until the window resets. A tree with no `claude`-backed agent is exempt. [docs/features.md](docs/features.md#ui-elements) → Account.
- **Opus 4.7/4.8 thinking is redacted** — it renders as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **Interactive tools answered via next prompt** — AskUserQuestion / ExitPlanMode / EnterPlanMode are denied and answered as a normal user prompt, so the model sees an errored tool_result (the UI shows it as handed to the user).
- **`--thinking` is spawn-time only** — changing it needs respawn + resume; mode, effort and model switch live. A tier/role's changed default effort moves only new spawns ([docs/models.md](docs/models.md#default-effort)).
- **Only the forced interrupt discards partial work** — ⏹ Interrupt now (`force:true`) discards in-progress work; the default ⏸ Interrupt waits for the next output boundary. [docs/features.md](docs/features.md#ui-elements) → Two-tier interrupt.
- **Playbook definitions are unpinned** — in-flight workers drift onto an edited graph, and a worker spawned illegally under `warn` stays untracked ([docs/protocol.md](docs/protocol.md#playbooks)).
- **Adopting a git repo dirties its working tree** — `adopt_project` always writes `CONVENTIONS.md` and an `@CONVENTIONS.md` import in `CLAUDE.md` into the target; how to undo both: [docs/features.md](docs/features.md#projects--workspaces) → Adopted projects.
- **Systems** — a target must be POSIX with GNU coreutils ([docs/systems-protocol.md](docs/systems-protocol.md) §1); `Glob` / `Grep` are refused; two places cannot share one transcript directory (`TRANSCRIPT_DIR_COLLISION`); a remote project's transcripts under the host's `~/.claude/projects/` are no longer read, deliberately unmigrated ([docs/architecture.md](docs/architecture.md#on-disk-state)).
- **Remote Systems, the FUSE-union chroot and Voice are per-platform capabilities** (`Platform.capabilities`) — hidden in the UI and refused with a stable code where off; [table](docs/components/platform.md#platform-capabilities).
- **Windows: a kill takes up to ~5 s** (an interrupted turn is given time to exit cleanly).
- **A CLI that outlives cc is stopped at boot only where its start time can be read** — otherwise it is left running with a warning and the resumed session may share its transcript until it exits. [`src/runningRecord.ts`](docs/components/restart.md#srcrunningrecordts).
- **A restart or update installs and builds before relaunching** — a failure refuses the restart and cc keeps running; it never installs into a symlinked `node_modules`. [docs/features.md](docs/features.md#ui-elements) → Power menu.
- **A cold start after a `web/` change rebuilds the web UI** (`npm start`, `conductor.sh`, the Windows launcher) and installs nothing — the previous build keeps serving; with none, `/` shows "Building the interface…", or a `503` naming the error if the build fails (the API, MCP and plugin routes stay up).
- **Where hard links are unavailable a crash can leave an empty lockfile** (FAT/exFAT, Android storage) — it blocks store writes or every boot (`ROOT_LOCK_UNREADABLE`) until deleted. [The projects-root lock](docs/components/headless.md#the-projects-root-lock).
- **The projects-root lock covers one kernel only** — not a root shared across machines (NFS) or between a macOS host and a Docker Desktop container.
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — workers are not offered `spawn_instance`; a `.conduct` session (section leads included) can spawn with no depth guard, and an anonymous `/mcp` caller is unrestricted. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — you are woken when the worker's turn ends.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.

## Documentation

- [docs/features.md](docs/features.md) — exhaustive feature and UI-element catalog
- [docs/models.md](docs/models.md) — backend registry, custom models, capability tiers & roles, Claude context windows
- [docs/protocol.md](docs/protocol.md) — subprocess protocol (CLI flags + hooks), WebSocket protocol, REST endpoints
- [docs/architecture.md](docs/architecture.md) — stack, environment variables, conventions, instance lifecycle, on-disk state, migrations
- [docs/components.md](docs/components.md) — the per-module catalogue: an index into `docs/components/*.md`
- [docs/testing.md](docs/testing.md) — the test gate, suites, fakes and isolation
- [docs/testing-systems.md](docs/testing-systems.md) — the systems gate, the FUSE-union chroot suites and the gated real-dependency suites
- [docs/testing-hang-guard.md](docs/testing-hang-guard.md) — the suite hang guard and reproducing CPU starvation
- [docs/frontend-testing.md](docs/frontend-testing.md) — how the web UI is tested (Vitest and Playwright) and what each can reach
- [docs/windows.md](docs/windows.md) — Windows runtime, launcher and installer contract
- [docs/plugins.md](docs/plugins.md) — plugin manifest, reverse proxy, bridge, `/api/plugins`, Plugin Library, compliance checklist
- [docs/plugin-ui.md](docs/plugin-ui.md) — building a plugin's UI: the host contract, theme, security advisories
- [docs/systems-protocol.md](docs/systems-protocol.md) — the System provider wire protocol and how to write or verify a provider
- [conventions/conductor/](conventions/conductor/) — the conductor role prompt, composed into `.conduct/CONVENTIONS.md` before every Conduct spawn/resume (Settings → Conventions → Conductor)
- [conventions/workspace/](conventions/workspace/) — workspace conventions, composed into every project's `CONVENTIONS.md` and `.conduct/CONVENTIONS.md` (Settings → Conventions → Workspace)
- [conventions/project/](conventions/project/) — the project-conventions catalog, composed into a project's `CONVENTIONS.md` (Settings → Conventions → Project)

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

Copyright © 2026 UnmanagedCode

See the [LICENSE](LICENSE) file for the full license text.

## Attribution

The running app surfaces its legal notice at **⚙ Settings → About** — project name, `Copyright © 2026 UnmanagedCode`, the AGPL-3.0 license, and the source link (https://github.com/UnmanagedCode/code-conductor). This is the "Appropriate Legal Notices" surface required by AGPL-3.0 §5(d); forks and network hosts must keep it intact so downstream users can find the corresponding source (§13).
