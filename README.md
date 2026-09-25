# CodeConductor

Local webapp for orchestrating multiple Claude Code CLI instances across projects in the parent directory of this repo (override with the `PROJECTS_ROOT` env var). Spawn, watch, and interact with several `claude` subprocesses in parallel from one browser tab.

Runs on Termux (localhost-only, single user) or any host with Node 24+ and the `claude` CLI on `$PATH`. Server-side `src/*.ts` runs directly via Node 24's native type stripping (no build step) and is type-checked by an enforced `tsc --noEmit` gate — see `npm run typecheck` below.

```
        browser tab               HTTP + WS (:8787)
        (vanilla JS)       ┌──────────────────────┐
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
npm run typecheck      # tsc --noEmit — strict; also runs before every npm test (pretest)
npm test               # integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs opt-in real-claude smoke
```

Prefer containers? **Docker Compose**: [docker/README.md](docker/README.md) — one host projects dir + this checkout.

Projects root defaults to the parent directory of this repo; set `PROJECTS_ROOT=<abs-path>` to override.

**Startup check.** Server probes `claude --version` (3s timeout) and credentials (`<configDir>/.credentials.json` or `ANTHROPIC_API_KEY`, where `<configDir>` honours `CLAUDE_CONFIG_DIR` and defaults to `~/.claude`). Emits `claude OK — v…, authenticated via…` or a framed `WARNING` block per issue. Server starts either way. Implemented in `src/health.ts`.

**Workspace conventions.** Composed from an always-on core (`conventions/workspace/core.md`) + enabled toggleable conventions (`conventions/workspace/*.md`) via `src/workspaceConventions.ts`, then written into **every project's own tracked `CONVENTIONS.md`** (above that project's own conventions) and into `.conduct/CONVENTIONS.md` — there is no file outside the projects. Regenerated on boot and after every **⚙ Settings → Conventions → Workspace** change; the files are app-owned and overwritten, so the supported edit path is the Settings panel.

**Voice dictation (optional).** Open **⚙ Settings → Voice → Dictation** and Install a model from the UI (runs `bin/install-whisper.sh` server-side, streams the log, sets the model active), or run that script manually (`WHISPER_MODEL_NAME=<name>` picks the model; default `ggml-small.en-q5_1.bin`, ~182 MB). The composer's mic affordance appears once whisper is available. Override paths via `WHISPER_CLI` / `WHISPER_MODEL` / `FFMPEG_BIN` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `transcribe.ts`.

**Text-to-speech (optional).** Same shape: open **⚙ Settings → Voice → Speech** and Install a voice from the UI (runs `bin/install-piper.sh` server-side, streams the log, sets the voice active), or run that script manually (`PIPER_VOICE_NAME=<name>`; default `en_US-lessac-medium`). The conversation's 🔊 buttons appear once Piper is available. Override paths via `PIPER_PYTHON` / `PIPER_VENV` / `PIPER_VOICE` / `PIPER_SYNTH_SCRIPT` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `tts.ts`.

**Install on Android.** Chrome → ⋮ → **Install app** / **Add to home screen**. Uses Web App Manifest (`public/manifest.webmanifest`) + SVG icon + Service Worker for standalone-mode launch.

**Visual debug.** Playwright + Termux Chromium harness in `harness/playwright/`, which is a thin wrapper over the **code-playwright plugin** — install it from Settings → Plugin Library (it lands at `<projectsRoot>/.plugins/code-playwright`); see [`harness/playwright/README.md`](harness/playwright/README.md). Not wired into the main test suite.

## Features

- **Projects & workspaces** — sidebar project list with git-status pills; workspaces nest projects under collapsible headers; project create/delete with cascade. **A project is a stored record and nothing else**: `<store>/projects/<name>/project.json` holds one `location`, and its tree may sit under the projects root, nested in a container directory there, anywhere else on disk, or **on a system** — a registered execution environment on another machine, reached through a provider command you supply. A directory in the projects root is not a project until it is registered.
- **Adding an existing directory as a project** — register a directory that already lives anywhere on disk, or on a registered system (git repo or not) (sidebar ≡ → **+ Add project**, `adopt_project`, `POST /api/projects/external`): nothing is copied or moved, and every project surface works on it in place. Detail: [docs/features.md](docs/features.md).
- **Deleting a project deregisters it** — the record goes; the tree stays unless you tick the opt-in in the confirm dialog, and there is no such tick for a project on a system. Detail: [docs/features.md](docs/features.md).
- **Systems** — put a project's tree, git repo and shell commands on another machine, chosen per project in **⚙ Settings → Systems**. One registered system can serve many named targets (`remoteId`); the `claude` CLI still runs on cc's machine, but inside a chroot onto a union filesystem whose root is the system's, so it works at the project's real path there and `Bash` is forwarded to run on it. See [Systems](#systems).
- **Worktrees** — isolated git worktrees per spawn; two-step land-back: sync (FF, auto-rebase, or a rebase brief handed back for the conductor/user to dispatch) then no-ff merge into parent.
- **Diff & history** — mobile-friendly full-page diff browser: `±` on a worktree row shows its `base...HEAD` diff; `≡` on a project row shows the current branch's commit log (capped, newest first) with a `git log --graph`–style branch/merge graph rail to the left (colored lanes, dots, fork/merge diagonals; computed client-side from commit parents), and tapping a commit reuses the same renderer for that single commit's change (`git show`).
- **Sessions & instances** — unified live + historical session list; conducted sessions (MCP-spawned, durable marker); temp sessions with promote; rewind & fork; crash recovery; session anchor (`#session=<sid>`).
- **Resume after restart** — restarting with live sessions offers a graceful drain → restart → resurrect: wind every turn down to idle, carry sessions (incl. temps) over via `<store>/pending-resume.json`, then on boot re-spawn (`--resume`) and notify each one (conductors re-spawn their workers from an injected project+sessionId+worktree list). See [docs/features.md](docs/features.md).
- **Spawn options** — mode (`plan` / `code`), effort, thinking, a capability tier (the tiers defined in `src/modelVersions.ts`), each bound in Settings → Models to a backend + model (defaults are all-Claude; see the module for the per-tier mapping) **and a default effort** (`high` for every tier out of the box — `DEFAULT_EFFORT` in `src/effortLevels.ts`), temp session, debug capture. Every model has exactly **one** native context window — there is no window picker — resolved server-side from `{backend, model}`. Detail: [docs/models.md](docs/models.md).
- **Live conversation** — streaming markdown, TTS read-aloud (Piper, per-sentence), thinking blocks, tool diffs, plan-mode approval cards, AskUserQuestion cards; long histories load tail-first with scroll-up lazy-load of earlier messages, across renews and prunes into every earlier context of the session (short transcripts auto-fill the viewport so the "load earlier" sentinel only appears once content is actually scrollable).
- **UI elements** — task panel, a combined **context-usage + rate-limit chip** (live, colour-graded ctx %; live bucket/utilization/reset-time with an OVERAGE badge when `isUsingOverage`; pinned at the turn-indicator footer right, tap for the usage popover), voice dictation (whisper.cpp — tap empty-composer mic or hold Send to append), settings page (models — per-tier backend binding + default effort + enable toggle + default spawn tier, plus per-role bindings + per-role default effort — a role binds to a tier or a concrete backend+model, and inherits that tier's effort unless overridden; the Conduct button spawns via the Conductor role; backends — the user-managed launch-template registry; account — **Action on overage** control + optional **usage threshold** slider, both staged behind an **Apply** button that also re-evaluates any active/parked session against the new threshold immediately; **Voice** (Dictation + Speech grouping boxes), **Conventions** — one section with collapsible Conductor / Workspace / Project blocks, archived sessions), OS notifications via Service Worker.
- **Conduct mode** — `🎼 Conduct` immediately spawns (no dialog) a conductor temp session in `.conduct` project in code mode (bypassPermissions), with its composed role prompt regenerated into `.conduct/CONVENTIONS.md` before every spawn/resume and loaded via that dir's `CLAUDE.md` `@CONVENTIONS.md` import (an always-on core + toggleable conventions, configurable in **Settings → Conventions → Conductor**), orchestrates workers via MCP. While viewing the conductor, a **Sub-agents** strip above the task panel lists each spawned worker with live status and is tap-to-navigate. When a worker finishes (its turn **and** all its background subagents) while the conductor is idle, the wake prompt **folds the worker's recent output inline** (no follow-up `get_recent_messages` round-trip) and renders as a **collapsible wake-callback bubble** (summary always visible, folded payload collapsed).
- **Playbooks** — declarative, **enforceable** conductor workflows: a JSON graph of stages a worker is bound to, with illegal moves refused at the MCP boundary and every legal one appended to a ledger, so the current state is inspectable and the history backtrackable. Four built-ins (solo / relay / forge / freeform) plus your own under `<store>/playbooks/` and any an enabled plugin ships (`<plugin-id>/<slug>`). Per-conductor-session enforcement (`warn` / `enforce`), starting at the level set in **Settings → Conventions → Conductor** (`enforce` out of the box — a fresh install refuses illegal moves; set it to `warn` to ledger and proceed instead) and overridable for one session at **⋮ → Enforce Playbooks**. Detail: [docs/protocol.md](docs/protocol.md#playbooks).
- **MCP interface** — `mcp__code-conductor__*` tools auto-registered at spawn: read, `project_bash`, `system_bash`, create, workspaces, spawn/drive, plan + question handling, worktrees, playbooks, session renewal + context prune. The worker handle is always `sessionId` — a permanent public id, stable across respawn/restart and across a context renewal or prune; the per-process `instanceId` is never exposed — prefix-resolvable at the MCP boundary, strict-live + soft-erroring. Full wire contract: [docs/protocol.md](docs/protocol.md#mcp-tool-protocol); tool catalog: [docs/features.md](docs/features.md#mcp-interface).
- **Cost dashboard** — full-page `#costs` view aggregating per-turn spend by project/model/day (tokens, sessions, cache misses, LLM time/walltime) + a daily trend, and a per-session **Statistics** panel (cost / LLM time / walltime, rolled up across spawned workers). Cross-turn cache-miss detection with an in-session notice. Detail: [docs/features.md](docs/features.md) → Cost dashboard / Session statistics.
- **Plugins** — projects with a `conductor.plugin.json` run as embedded extensions: a conductor-supervised backend, a same-origin iframe frontend (reverse proxy + app-switcher), forwarded MCP tools (`<plugin-id>__<tool>`), **project / conductor conventions** (CLAUDE.md fragments + optional scaffold directives), **roles** (named model-bindings, user-rebindable in Settings → Models → Roles), **playbooks** (stage graphs, namespaced `<plugin-id>/<slug>`), and/or **Claude Code skills** (a `claudePlugin` root added per enabled plugin via session-local `--plugin-dir` at every claude launch). A contributions-only plugin needs no backend. Managed in **⚙ Settings → Plugins** + **Plugin Library** (one-click clone-to-install). Trusted own code — no sandboxing. Schema + wire contracts: [docs/plugins.md](docs/plugins.md); UI + library: [docs/features.md](docs/features.md#plugins).

See [docs/features.md](docs/features.md) for the exhaustive feature and UI-element catalog.

## Systems

A **System** is a third placement for a project: its tree, git repo and shell commands live on another machine, chosen per project. It is an **execution environment, not a remote filesystem** — the `claude` CLI, cc's central store and everything under `~/.claude/` stay on the host cc runs on. cc ships **no transport**: it defines a provider contract and launches a command you supply; it does not implement SSH or docker itself.

### Functional

**Registering one.** **⚙ Settings → Systems** — an id, a label, and a **provider command** entered as argv (`argv[0]` is the executable; spawned directly, never through a shell). The command is **verified before the row is saved**: cc spawns it, completes the handshake and throws the connection away, so a provider that does not answer is refused with its own error text and nothing is written. The built-in `local` row ("This machine") is code-owned — not editable, not removable. Removing a user row is refused while any project still names it, and the refusal lists those projects.

**Endpoints and targets.** One registered system can serve many named **targets**, so one row and one provider process can front a whole fleet. Which target a project is on is its `remoteId`, chosen per project; the tuple that identifies a tree is `(system, remoteId, path)`, so the same path on two targets is two different projects. **Absence of a `remoteId` means the provider's own default target**, exactly as absence of a system means cc's own machine.

**Creating a project on one.** `+ New project` offers a **System** picker — the built-in **This machine** (the default) plus every user row that has a provider command. Choosing a system reveals **Path on that system**, absolute and required since cc has no default location on another machine, and an optional **Remote**: the target's name (a container name, a hostname, a VM id), blank for the provider's default. The `mkdir`, `git init`, seed files and the scaffold commit all happen there; under the projects root there is **no tree and no directory** — only the store record that registers the project. To adopt a tree already on a system, use the same **System** + **Remote** pair in ≡ → **+ Add project**, or `adopt_project({name, path, system, remoteId})`.

**The system pill, and changing target.** A project on a system carries a sidebar pill reading `<system>/<target>` — or just the system, on the provider's default — saying which machine the row's git facts came from; when cc could not reach that machine it turns red and carries the reason instead. It is a **control only when the system is reachable**: clicking opens **Change target**, which verifies the new target there before persisting. A change is refused **409 `PROJECT_PLACEMENT_IN_USE`** while the project has live sessions or registered worktrees; the message names whichever of the two is blocking, and the response body always carries both lists. Kill the sessions, delete the worktrees, retry — nothing is discarded on your behalf. A permitted change leaves nothing cc-owned behind: the worker reads the project's tree through the union at its real path, so there is no local copy of the old target to go stale.

**Deleting a project on a system unregisters it and nothing else.** Its tree, history, worktree directories and branches all live on the system and are never touched — the confirm dialog reads *Unregister* and names what is being left behind before the click.

**What runs where.**

| | Where it runs |
|---|---|
| the `claude` CLI, cc's store, `~/.claude/` | **cc's host**, always |
| the project tree, its git repo, `Bash` | **the system** |
| `Read` / `Write` / `Edit` / `NotebookEdit` | **not hooked at all** — the CLI runs inside a chroot onto the union, so it opens the system's own bytes at the system's own path |
| `Glob` / `Grep` | **neither** — removed and refused; `find` / `grep` through `Bash` answer about the right machine |

The rest — one fresh shell per command and what that means for `cd`, the output fence, and the named refusals for a system that is unreachable, serves no targets, or cannot mount the union — is in [docs/features.md](docs/features.md) → Projects on a system / Worker sessions on a system.

### Technical

**The seam.** Every project-scoped operation — git, project-tree file I/O, commands run in a project dir — goes through a `System` handle (`src/systems/`) rather than `node:fs`/`spawn`. Two implementations: the in-process `local` built-in, and `ProviderSystem`, which reaches a system over the wire protocol. A project on a system with no provider command, or on an id with no registry row, is **refused by name at resolution** rather than resolved local — a fallback would run every operation against a path on the wrong machine and report success. Internals: [docs/architecture.md](docs/architecture.md) → `src/systems/`; the REST surface (`/api/settings/systems`, `PUT /api/projects/:name/remote`) is in [docs/protocol.md](docs/protocol.md) → REST endpoints.

**The provider contract** is complete at [docs/systems-protocol.md](docs/systems-protocol.md) — a conforming provider can be written from that document alone. Section numbers below are its.

| | Rule | § |
|---|---|---|
| **Wire** | cc launches the provider as a child process and speaks **NDJSON over its stdin/stdout**, binary payloads base64 in a `dataB64` field. The framing bounds — `MAX_LINE_BYTES`, `CHUNK_BYTES`, `MAX_FILE_BYTES` — are defined in `src/systems/protocol.ts` and shared by both ends | §1 |
| **Primitives** | A provider implements **`exec`, `readFile`, `writeFile`** and nothing else; every other member of the `System` interface (`src/systems/system.ts`, which owns the list) is **derived** by cc over `exec` | §7 |
| **stdout is frames only** | MUST. Diagnostics go to stderr, which cc never parses | §1 |
| **Handshake first** | MUST. Answer cc's `hello` with a `hello` **before any other frame** | §1, §2 |
| **Lifecycle** | MUST. **Exit at stdin EOF, taking everything you started with you.** A provider whose children are not its OS descendants must relay the kill and reap them itself — a `docker exec` child is reparented inside the container, and cc cannot clean up after one that does not | §1, §11 |
| **Multiplexing** | Ids are concurrent and cc assumes no ordering across them. An id is **bound to one target for its lifetime**, and a refusal about a target (`ENOREMOTE`, or any FS code from an operation on it) MUST be **id-addressed** — an id-less one tears the connection down and fails every other target's work | §4, §9 |
| **Errors** | MUST, not a courtesy: answer with the filesystem code the local filesystem would have raised. cc's callers branch on the exact codes, so a provider answering `EUNKNOWN` for everything would not be wrong on the wire — it would change what the application does | §8 |
| **Capabilities** | Negotiated in the handshake, where a missing key is `false` and an unknown key is ignored. One is acceptable only with a flag name, an absent-behaviour, a user-visible difference **and a test that runs the fallback** | §2 |
| **Supervision** | **Restart-on-demand.** A dead provider fails every in-flight operation `ETRANSPORT` at once, the next operation relaunches, and an operation inside the backoff window is refused rather than queued. A connection cc **disposed** is the exception: it is terminal and never relaunches | §9 |

**The POSIX assumption.** The target must be a competent POSIX environment with GNU coreutils — `find` with `-printf` and `realpath -e` among them — plus a POSIX login shell. That assumption is what shrinks the contract to three operations; the exact commands cc derives are in §7, and non-POSIX targets are out of scope (see Known limitations).

**Writing one, and reaching another machine with it.** `src/systems/referenceProvider.ts` is the worked example: the local machine over the protocol, no cc-specific dependencies, every optional capability settable by flag. For crossing a real boundary the in-repo example is `tests/systems-docker-boundary.real.test.mjs`, which registers a system whose provider command is `docker exec -i <container> node /opt/cc/referenceProvider.ts` — the transport is the launch command, and the provider itself is unmodified. What is **not** thin about it: the provider and `protocol.ts` — its only local import — have to be inside the target first (the test `docker cp`s them in, along with two files the provider does not actually import), the target needs a Node that can run them, and its base image has to satisfy the POSIX assumption. That shape gives **one container per registry row**. For one provider fronting many containers — the container id as `remoteId` — §11 sketches the mapping and names the three things it is not thin about: reaping, real process-group signalling, and the base image.

**The FUSE-union chroot (`src/systems/fuse/`).** A worker on a non-local project runs its CLI inside a private mount namespace whose root is a union filesystem, so a file has ONE spelling whichever tool names it — the filesystem decides which bytes appear at a path, not a pull/push hook. A host that cannot mount FUSE **refuses the spawn by name** (`FUSE_UNAVAILABLE`), and a mount that will not tear down is a **reported** state, never a silent one. Internals: [docs/architecture.md](docs/architecture.md) → `src/systems/fuse/` and "FUSE teardown".

**Running and verifying.** `tests/systems-protocol-conformance.test.mjs` is the definition of a valid provider; where it and the protocol document disagree, the suite is right.

```bash
node tests/run.mjs tests/systems-protocol-conformance.test.mjs   # the reference provider

# your provider, same battery, no test edits (the value is a JSON argv array)
CC_CONFORMANCE_PROVIDER='["python3","my_provider.py"]' \
  node tests/run.mjs tests/systems-protocol-conformance.test.mjs
```

The flags the suite appends to that argv, and the extra `CC_CONFORMANCE_REMOTE_ID`
a provider that serves only **named targets** needs — without which it refuses the
core battery `ENOREMOTE` under the protocol's own rule — are in
[docs/systems-protocol.md](docs/systems-protocol.md) §10, which also names what a
bound run stops proving — and the `--remote` the bound path presupposes.

- **`npm run gate:systems`** — the whole suite once per configuration in `CONFIGS` (`tests/systems-gate.mjs`, which owns the list): `processGroupSignal`+`remotes` on, then `processGroupSignal` off. That fallback is therefore proved to execute rather than merely to exist. The first configuration also carries `--remote`, so every project-scoped operation in that pass is **target-bound** — folded into it rather than given a pass of its own, since a separate pass costs a whole suite and puts the same field on the same frames. The gate does **not** vary `remoteDescriptors`: `mirror()` is unreachable for the system id `local` whatever backs it, so a `--mirror` configuration receives no `describeRemote` frame at all.
- **`CC_LOCAL_SYSTEM_PROVIDER='["your-provider"]' npm test`** — swaps the in-process `local` system for a `ProviderSystem` over the named command, so **every project-scoped operation in cc runs over the protocol** and nothing in the suite knows it. This is the seam `gate:systems` drives.

Two Systems suites are opt-in because they need something the repo does not ship:

- **`RUN_DOCKER_SYSTEM=1 npm test`** — the reference provider *inside* a container over `docker exec -i`, and **the only Systems suite crossing a real machine boundary**: everywhere else the provider sits on cc's own machine, where a wrong-machine bug looks exactly like success. `CC_DOCKER` and `CC_DOCKER_IMAGE` tune it.
- **`RUN_CLI_CONTRACT=1 npm test`** — the undocumented `claude` CLI behaviours redirection rests on, asserted against the installed binary. Unlike the rest it needs account access to the model pinned in `tests/cliContractCase.mjs`, and spends real tokens on every run.

**On-disk state you will see.** A worker session on a system leaves **no local image of its tree**. What cc keeps is the mount scaffolding for the session's chroot:

- **`<store>/systems/fuse/run/<instanceId>/`** — one directory per session: the union mountpoint, the remote tier's mount dir, a private `fusectl`, the generated tier table, and the mount record teardown and the boot sweep read. Removed when the session is torn down; **kept, marked and re-reported** when a teardown could not finish.
- **`<store>/systems/fuse/bin/union-<sha256>`** — the union daemon, compiled on first use and content-addressed on its source plus the compiler flags, so a stale binary is impossible.
- A session's CLI transcript lands in `<configDir>/projects/<encodeCwd(cwd)>/`. For a local place that config dir is the CLI's own `~/.claude`; for a remote-backed place it is a cc-owned directory per `(system, remoteId)` under the store, so two boxes at one absolute path keep separate transcripts. Two places that would still share one directory are **refused at registration**.

Layout: [docs/architecture.md](docs/architecture.md) → On-disk state.

## Key defaults

- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load). Override with `PROJECTS_ROOT=<abs-path>`. cc's own state lives under this dir — the central store at `<root>/.code-conductor/`, every local worktree checkout at `<root>/.worktrees/<project>/<key>/`, Library plugin installs at `<root>/.plugins/<name>/`, and the hidden `.conduct` project. A **project's** tree may be anywhere its record says, inside this dir or not.
- **Transcript roots**: a LOCAL place's session jsonls live in the CLI's own `<configDir>/projects/<encodeCwd(cwd)>/` (`<configDir>` honours `CLAUDE_CONFIG_DIR`, default `~/.claude`; the root alone is overridable with `CLAUDE_PROJECTS_ROOT`). A REMOTE-backed place's live under a cc-owned CLI config directory per `(system, remoteId)` at `<root>/.code-conductor/claude-config/<dirName>/.claude/projects/`. Most of that directory's other entries are symlinks to the host's real config dir, so settings, plugins and skills stay shared — which entries are NOT linked, and why, is in [docs/features.md](docs/features.md). Never deleted on unregister; the CLI prunes its own after ~30 days.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- New instance: `plan` mode, `adaptive` thinking, and — when the spawn names no model — a **Settings → Models row** resolved through its binding: the `role` or `tier` named, else the **default spawn tier** (`defaultSpawnBinding()` in `src/appSettings.ts`). This holds on both the MCP and REST fresh-spawn paths, so a fresh spawn always launches with an explicit `--model` and never the account default — the one case with no row to draw from (a named backend the row isn't bound to) is refused rather than launched (`422 BACKEND_MODEL_MISSING`; per-backend matrix in [docs/models.md](docs/models.md#same-row)). **Effort resolves from the tier/role spawned on** (Settings → Models, `high` — `DEFAULT_EFFORT` in `src/effortLevels.ts` — out of the box and on any path that names neither, e.g. a sidebar/anchor resume; per-path table in [docs/models.md](docs/models.md#default-effort)), and an explicit `effort` still wins. `InstanceManager.create()` is policy-light — mode never depends on `temp`. The UI/REST temp checkbox ⇒ `bypassPermissions` mapping is applied at the `POST /api/instances` route. **MCP `spawn_instance`** always spawns temp — archived on exit, transcript retained; there is no MCP knob — but mode still defaults to `plan` (conducted-worker safety contract, since `create()` doesn't couple them), and an explicit `mode` still wins.
- Resume without an explicit `mode` inherits the mode the session was recorded in (`<store>/session-modes.json`, written on spawn and on every mode change). There is **no backfill**: a session predating that store is unrecorded and falls back to `bypassPermissions` — the previous behaviour — so `list_sessions` flags every resume that will come up hot (`resumes-hot`) rather than reporting only what it has a record for. An explicit `mode` still wins, except against a playbook stage that pins `mode` (see [docs/protocol.md](docs/protocol.md#playbooks)). This is the shared `_doCreate` default, so the sidebar one-click resume and the anchor auto-resume — neither of which names a mode — inherit too. Crash-respawn preserves whatever mode was running.
- Resume without an explicit `model` recovers the model the session was last run with by reading the most-recent `assistant.message.model` from the jsonl — otherwise `claude --resume` falls back to the account default (often Opus) and silently flips a Sonnet/Haiku session. The recovered (bare) id is run through `canonicalizeModel(id, backend)`, which re-applies the model's catalog launch tag for a `claude` session (which builds need one is catalog data — see `src/modelVersions.ts`) and returns a substitution backend's id **byte-exact**, since that id is the registry key. Because every model has one native context window, a cold resume comes back at that model's own capacity with nothing to carry. On a substitution backend the exact id and last known capacity come from the durable session sidecar, which the lossy jsonl can't supply. Explicit `model` on the POST still wins (also canonicalized).
- Event ring: a fixed per-instance cap (`ORCH_EVENT_RING_CAP`, drop-oldest); WS subscribe sends only the trailing slice (`ORCH_SNAPSHOT_TAIL`). Older / evicted events are paged on demand from `GET /api/instances/:id/events` (jsonl-replay fallback; the pager MCP's `get_transcript` shares); the conversation lazy-loads on scroll-up from `GET /api/instances/:id/lineage-events`, which walks the same pager back through the session's earlier backing segments. Retention is storage-only: the CLI's live per-token thinking flood is coalesced (streaming `thinking_delta` folds to one slot per block; the per-token `thinking_tokens` counter is live-only, never retained) so a single long reasoning turn can't overflow the ring — the live per-token stream is unaffected. This is **not** specific to any one backend: the counter is a Claude CLI progress estimate (see [docs/protocol.md](docs/protocol.md) → `thinking_tokens` for the models observed emitting it).
- Control-request timeout and kill grace are fixed defaults in `Instance` (see `src/instances.ts`).

## Known limitations
- **Overage auto-stop is global & conductor-aware; auto-resume is in-memory** — **Settings → Account → Action on overage** is `Off` / `Stop` / `Stop & resume` (a **global** setting, not per-session).
  - A trip fires on a `rate_limit_event` with `isUsingOverage:true`, or — with the optional **usage-threshold** toggle on — when `utilization` crosses the configured percent (default and clamp range defined in `src/appSettings.ts`). The threshold is watched from two equal-footing sources: the live `rate_limit_event` stream (which Anthropic only emits near its own ~90% mark) **and** a periodic server-side usage poll of the five-hour window, so a *low* threshold (e.g. 25%) trips even though the stream never reports that low.
  - Stopped sessions stay idle-but-alive and manually resumable. `Stop & resume` schedules an **in-memory** resume timer (a short buffer after the five-hour window resets; default in `src/overageResume.ts`) that is persisted in the resume manifest across a **graceful** restart only — not a hard crash.
  - **`Stop & resume` is a global hard lockout:** while the window is active, *every* session queues its sends with **no** early-resume/override (a valid *future* reset gates it; plain `Stop` never queues).
  - A session whose **root** agent tree touches no **monitored usage-window domain** (i.e. no `claude`-backed agent anywhere in it) is exempt — never auto-stopped, queued, or armed for auto-resume. The unit of stopping is the tree, resolved from its root, so a non-Claude worker under a Claude conductor is stopped with it; only a whole root tree that touches no monitored domain stays out.
  - Mechanism + routing (soft-interrupt mid-turn, no-send stop when idle, turn-start lockout guard): [docs/features.md](docs/features.md) → Settings → Account; [docs/architecture.md](docs/architecture.md) → overage trip detection + central routing.
- **Opus 4.7/4.8 thinking is redacted** — no readable content (4.7 sends only `signature_delta`; 4.8 sends empty `thinking_delta`s). Both render as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **AskUserQuestion answered via next prompt** — PreToolUse hook denies; tool_result is `is_error:true`; answer is fed in as a normal user prompt. Functionally fine, but the original tool_result is still an error for diagnostics.
- **`--effort` / `--thinking` are spawn-time only** — switching mid-session needs respawn + resume. Only `mode` is live-switchable. Changing a tier/role's **default** effort moves only *new spawns* on that row: a respawn keeps the level the session was already running at, and a sidebar/anchor resume falls back to the global default (it names no tier/role) — see [docs/models.md](docs/models.md#default-effort).
- **Only the forced interrupt discards partial work** — ⏹ Interrupt now (`force:true`) aborts immediately and discards in-progress work; the default ⏸ Interrupt arms the same abort and fires it at the next output boundary, so the current block and every returned tool result survive. A post-abort drain window kills spurious queued turns. Detail: [docs/features.md](docs/features.md) → Controls → Two-tier interrupt.
- **Playbook definitions are unpinned** — editing a definition while workers are in flight lets them drift onto the new graph rather than pinning them to the old, and a worker spawned illegally under `warn` stays untracked, so flipping to `enforce` governs new spawns only. Both are deliberate — see [docs/protocol.md](docs/protocol.md#playbooks).
- **Adopting a git repo dirties its working tree** — `adopt_project` writes cc's own `CONVENTIONS.md` into the target and prepends an `@CONVENTIONS.md` line to its `CLAUDE.md` (creating one if absent). That is the only channel the workspace/project conventions have, so it is unconditional; in a git target both land as uncommitted changes in the adopted repo. Recovery undoes BOTH writes, not just the first: delete `CONVENTIONS.md`, and remove the `@CONVENTIONS.md` line from `CLAUDE.md` — or delete `CLAUDE.md` outright if adopt created it. In a git target, `git checkout --` restores whichever of the two adopt overwrote and `rm` removes whichever it created — name only the pre-existing paths in the checkout, since a pathspec matching nothing in HEAD aborts it and restores neither. In a non-git target it is the deletion and the line removal by hand. Dropping only `CONVENTIONS.md` leaves a dangling import behind.
- **Systems: what a target must provide, and what a session on one gives up** — see [Systems](#systems).
  - **Non-POSIX targets are out of scope by contract.** Alpine and other busybox images do not satisfy the POSIX assumption: `readDir` and `realpath` fail outright there and `stat` loses its millisecond precision silently. cc ships no BSD or busybox dialect — an untested second code path is worse than a refusal. Measured breakdown: [docs/systems-protocol.md](docs/systems-protocol.md) §11.
  - **`Glob` and `Grep` are unavailable in a session on a system.** A search result can be annotated but never substituted, so both are removed and refused by name; `find` and `grep` through `Bash` answer about the right machine.
  - **Two places cannot share one CLI transcript directory.** Registering a project or worktree whose transcript directory is already held is refused **409 `TRANSCRIPT_DIR_COLLISION`**. That is now only reachable for two places on one target, or two local places whose cwds encode alike (`_` and `.` both become `-`).
  - **Upgrading strands existing remote transcripts.** Sessions already on disk for a project on a non-local system stay at `~/.claude/projects/<encodeCwd(systemPath)>/`, which cc no longer reads: they stop listing, locating, reading and resuming. Nothing is deleted — the jsonls remain, and the CLI prunes its own `projects/` after ~30 days. There is deliberately no migration.
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — auto-registered MCP lets any session call `spawn_instance`; children inherit the auto-registration, no depth guard. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — you are woken when the worker's turn ends.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.

## Documentation

- [docs/features.md](docs/features.md) — exhaustive feature and UI-element catalog (projects, worktrees, sessions, spawn options, conversation, UI, conduct mode, MCP)
- [docs/models.md](docs/models.md) — the backend registry (launch templates + env), custom models, capability tiers & roles, Claude context-window policy, the Settings → Backends / → Models panels
- [docs/protocol.md](docs/protocol.md) — subprocess protocol (CLI flags + hooks), WebSocket protocol, REST endpoints
- [docs/architecture.md](docs/architecture.md) — stack, component layout, instance lifecycle, on-disk state, migrations, testing
- [docs/plugins.md](docs/plugins.md) — plugin manifest schema, reverse proxy, bridge protocol, `/api/plugins` REST, child MCP wire contract, Plugin Library, compliance checklist
- [docs/systems-protocol.md](docs/systems-protocol.md) — the System provider wire protocol: frames, capabilities, the `exec` lifecycle, the derivations, the error taxonomy, and how to write or verify a provider
- [conventions/conductor/](conventions/conductor/) (`core.md` + `footer.md` + toggleable `<slug>.md`) — conductor role prompt / orchestration contract; composed (core + enabled toggleable conventions + footer) into `.conduct/CONVENTIONS.md` before every Conduct session's spawn/resume, loaded via that dir's `CLAUDE.md` `@CONVENTIONS.md` import (configurable in Settings → Conventions → Conductor)
- [conventions/workspace/](conventions/workspace/) (`core.md` + toggleable `<slug>.md`) — workspace conventions; composed (core + enabled conventions) into every project's app-owned in-tree `CONVENTIONS.md` and into `.conduct/CONVENTIONS.md` (configurable in Settings → Conventions → Workspace)
- [conventions/project/](conventions/project/) — project conventions; a catalog of `<slug>.md` sections composed into a new project's app-owned, regenerated in-project `CONVENTIONS.md` (imported via `@CONVENTIONS.md`; self-describing line-1 marker, app-owned and overwritten on every regeneration except a transient degraded-catalog freeze — `src/projectClaudeMd.ts`), configurable in Settings → Conventions → Project

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

Copyright © 2026 UnmanagedCode

See the [LICENSE](LICENSE) file for the full license text.

## Attribution

The running app surfaces its legal notice at **⚙ Settings → About** — project name, `Copyright © 2026 UnmanagedCode`, the AGPL-3.0 license, and the source link (https://github.com/UnmanagedCode/code-conductor). This is the "Appropriate Legal Notices" surface required by AGPL-3.0 §5(d); forks and network hosts must keep it intact so downstream users can find the corresponding source (§13).
