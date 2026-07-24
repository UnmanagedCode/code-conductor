# CodeConductor

Local webapp for orchestrating multiple Claude Code CLI instances across projects in the parent directory of this repo (override with the `PROJECTS_ROOT` env var). Spawn, watch, and interact with several `claude` subprocesses in parallel from one browser tab.

Runs on Termux (localhost-only, single user) or any host with Node 22+ and the `claude` CLI on `$PATH`.

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
npm install            # express, ws
npm start              # http://127.0.0.1:8787  (process title: code-conductor)
npm test               # integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs opt-in real-claude smoke
```

Projects root defaults to the parent directory of this repo; set `PROJECTS_ROOT=<abs-path>` to override.

**Startup check.** Server probes `claude --version` (3s timeout) and credentials (`~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`). Emits `claude OK — v…, authenticated via…` or a framed `WARNING` block per issue. Server starts either way. Implemented in `src/health.js`.

**Root `CLAUDE.md` regenerate.** code-conductor **fully owns** the projects-root `CLAUDE.md` (the file every project imports via `@../CLAUDE.md`), composing it from an always-on core (`conventions/workspace/core.md`) + enabled toggleable conventions (`conventions/workspace/*.md`) via `src/workspaceConventions.js` + `src/rootClaudeMd.js`. It is **overwritten** on boot (in `start()`, after migrations) and after every **⚙ Settings → Conventions → Workspace** change — exactly like `.conduct/CONDUCT.md`; there is no reconcile or conflict UI. Strictly **non-fatal** on boot: a failure is warned and boot continues. **Safety:** the *first* app-owned regeneration backs up a hand-edited copy to `CLAUDE.md.bak-<timestamp>` (detected via a one-time `<store>/workspace-claudemd/owned.json` sentinel); after that the file is overwritten silently, so the supported edit path is the Settings panel, not the file.

**Voice dictation (optional).** Open **⚙ Settings → Transcribe** and Install a model from the UI (runs `bin/install-whisper.sh` server-side, streams the log, sets the model active), or run that script manually (`WHISPER_MODEL_NAME=<name>` picks the model; default `ggml-small.en-q5_1.bin`, ~182 MB). The composer's mic affordance appears once whisper is available. Override paths via `WHISPER_CLI` / `WHISPER_MODEL` / `FFMPEG_BIN` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `transcribe.js`.

**Text-to-speech (optional).** Same shape: open **⚙ Settings → TTS** and Install a voice from the UI (runs `bin/install-piper.sh` server-side, streams the log, sets the voice active), or run that script manually (`PIPER_VOICE_NAME=<name>`; default `en_US-lessac-medium`). The conversation's 🔊 buttons appear once Piper is available. Override paths via `PIPER_PYTHON` / `PIPER_VENV` / `PIPER_VOICE` / `PIPER_SYNTH_SCRIPT` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `tts.js`.

**Install on Android.** Chrome → ⋮ → **Install app** / **Add to home screen**. Uses Web App Manifest (`public/manifest.webmanifest`) + SVG icon + Service Worker for standalone-mode launch.

**Visual debug.** Playwright + Termux Chromium harness in `debug/`, which is a thin wrapper over the **sibling repo** — clone `code-playwright` to the parent directory of code-conductor and `npm install` once. Not wired into the main test suite.

## Features

- **Projects & workspaces** — sidebar project list with git-status pills; workspaces nest projects under collapsible headers; project create/delete with cascade.
- **Worktrees** — isolated git worktrees per spawn; two-step land-back: sync (FF, auto-rebase, or agent-driven rebase on conflict) then no-ff merge into parent.
- **Diff & history** — mobile-friendly full-page diff browser: `±` on a worktree row shows its `base...HEAD` diff; `≡` on a project row shows the current branch's commit log (capped, newest first) with a `git log --graph`–style branch/merge graph rail to the left (colored lanes, dots, fork/merge diagonals; computed client-side from commit parents), and tapping a commit reuses the same renderer for that single commit's change (`git show`).
- **Sessions & instances** — unified live + historical session list; conducted sessions (MCP-spawned, durable marker); temp sessions with promote; rewind & fork; crash recovery; session anchor (`#session=<sid>`).
- **Resume after restart** — restarting with live sessions offers a graceful drain → restart → resurrect: wind every turn down to idle, carry sessions (incl. temps) over via `<store>/pending-resume.json`, then on boot re-spawn (`--resume`) and notify each one (conductors re-spawn their workers from an injected project+sessionId+worktree list). See [docs/features.md](docs/features.md).
- **Spawn options** — mode (`plan` / `ask` / `code`), effort, thinking, a capability tier (Fast / Balanced / Powerful / Frontier — each bound in Settings → Models to a Claude backend or an **Ollama-backed model** launched via `ollama launch claude`; default binding Fast→Haiku 200k, Balanced→Sonnet 5 1M, Powerful→Opus 1M, Frontier→Fable 5 1M (a tier or role rebound to **Sonnet 4.x** carries its own 200k/1M window on the binding); a tier can be disabled in Settings → Models. Ollama models report their real native context window — curated presets carry it (`src/ollamaCloudModels.js`), custom models can declare one — driving the ctx bar and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at spawn), temp session, debug capture.
- **Live conversation** — streaming markdown, TTS read-aloud (Piper, per-sentence), thinking blocks, tool diffs, plan-mode approval cards, AskUserQuestion cards, ask-mode permission cards; long histories load tail-first with scroll-up lazy-load of earlier messages (short transcripts auto-fill the viewport so the "load earlier" sentinel only appears once content is actually scrollable).
- **UI elements** — task panel, a combined **context-usage + rate-limit chip** (live, colour-graded ctx %; live bucket/utilization/reset-time with an OVERAGE badge when `isUsingOverage`; pinned at the turn-indicator footer right, tap for the usage popover), voice dictation (whisper.cpp — tap empty-composer mic or hold Send to append), settings page (models — per-tier backend binding + enable toggle + default spawn tier, plus per-role bindings — a role binds to a tier or a custom backend, and the Conduct button spawns via the Conductor role; account — **Action on overage** control + optional **usage threshold** slider, both staged behind an **Apply** button that also re-evaluates any active/parked session against the new threshold immediately; transcribe, TTS, **Conventions** — one section with collapsible Conductor / Workspace / Project blocks, archived sessions), OS notifications via Service Worker.
- **Conduct mode** — `🎼 Conduct` immediately spawns (no dialog) a conductor temp session in `.conduct` project in code mode (bypassPermissions), pre-loaded with its composed `CONDUCT.md` role prompt (an always-on core + toggleable conventions, configurable in **Settings → Conventions → Conductor**), orchestrates workers via MCP. While viewing the conductor, a **Sub-agents** strip above the task panel lists each spawned worker with live status and is tap-to-navigate. When a subscribed worker finishes (its turn **and** all its background subagents) while the conductor is idle, the wake prompt **folds the worker's recent output inline** (no follow-up `get_recent_messages` round-trip) and renders as a **collapsible wake-callback bubble** (summary always visible, folded payload collapsed).
- **MCP interface** — `mcp__code-conductor__*` tools auto-registered at spawn: read, `project_bash`, create, workspaces, spawn/drive, plan + question handling, worktrees, session renewal. The worker handle is always `sessionId` (stable across respawn/restart; the per-process `instanceId` is never exposed), prefix-resolvable at the MCP boundary, strict-live + soft-erroring. Full wire contract: [docs/protocol.md](docs/protocol.md#mcp-tool-protocol); tool catalog: [docs/features.md](docs/features.md#mcp-interface).
- **Cost dashboard** — full-page `#costs` view aggregating per-turn spend by project/model/day (tokens, sessions, cache misses, LLM time/walltime) + a daily trend, and a per-session **Statistics** panel (cost / LLM time / walltime, rolled up across spawned workers). Cross-turn cache-miss detection with an in-session notice. Detail: [docs/features.md](docs/features.md) → Cost dashboard / Session statistics.
- **Plugins** — sibling projects with a `conductor.plugin.json` run as embedded extensions: a conductor-supervised backend, a same-origin iframe frontend (reverse proxy + app-switcher), forwarded MCP tools (`<plugin-id>__<tool>`), and/or **project / conductor conventions** (CLAUDE.md fragments + optional scaffold directives). A contributions-only plugin needs no backend. Managed in **⚙ Settings → Plugins** + **Plugin Library** (one-click clone-to-install). Trusted own code — no sandboxing. Schema + wire contracts: [docs/plugins.md](docs/plugins.md); UI + library: [docs/features.md](docs/features.md#plugins).

See [docs/features.md](docs/features.md) for the exhaustive feature and UI-element catalog.

## Key defaults

- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load). Override with `PROJECTS_ROOT=<abs-path>`. The whole orchestrator (project list, central store at `<root>/.code-conductor/`, the hidden `.conduct` project) lives under this dir.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- New instance: `plan` mode, `high` effort, `adaptive` thinking, no model flag. `InstanceManager.create()` is policy-light — mode never depends on `temp`. The UI/REST temp checkbox ⇒ `bypassPermissions` mapping is applied at the `POST /api/instances` route. **MCP `spawn_instance`** defaults to `temp:true` but mode still defaults to `plan` (conducted-worker safety contract, since `create()` doesn't couple them) — explicit `temp:false`/`mode` still win.
- Sidebar one-click resume: `bypassPermissions` mode (continuing real work), same effort/thinking defaults. Crash-respawn preserves whatever mode was running.
- Resume without an explicit `model` recovers the model the session was last run with by reading the most-recent `assistant.message.model` from the jsonl — otherwise `claude --resume` falls back to the account default (often Opus) and silently flips a Sonnet/Haiku session. The recovered (bare) id is run through `canonicalizeModel`, which pins Sonnet 5 to `[1m]` (no 200k build) and, for Sonnet 4.x, applies the window carried on the spawn (`sonnetWindow`, resolved from the tier/role binding — bindings own their window; there is no global). The window rides in `this.model`'s suffix and is carried across a graceful restart via the resume manifest; on a **bare cold resume** (historical/anchor resume where only the jsonl-bare id is recovered) it defaults to **1M** (larger window, never truncates). Explicit `model` on the POST still wins (also canonicalized).
- Event ring: capped at 2000 events / instance (drop-oldest, `ORCH_EVENT_RING_CAP`); WS subscribe sends only the trailing ≤500 (`ORCH_SNAPSHOT_TAIL`). Older / evicted events are paged on demand from `GET /api/instances/:id/events` (jsonl-replay fallback) — the conversation lazy-loads them on scroll-up. Retention is storage-only: the ollama live thinking flood is coalesced (streaming `thinking_delta` folds to one slot per block; the per-token `thinking_tokens` counter is live-only, never retained) so a single long reasoning turn can't overflow the ring — the live per-token stream is unaffected.
- Control-request timeout: 5 s. Kill grace: stdin closed → 2 s → SIGTERM → 3 s → SIGKILL (5 s total).

## Known limitations
- **Overage auto-stop is global & conductor-aware; auto-resume is in-memory** — **Settings → Account → Action on overage** is `Off` / `Stop` / `Stop & resume` (a **global** setting, not per-session).
  - A trip fires on a `rate_limit_event` with `isUsingOverage:true`, or — with the optional **usage-threshold** toggle on — when `utilization` crosses the configured percent (default 85%, range **10–99**). The threshold is watched from two equal-footing sources: the live `rate_limit_event` stream (which Anthropic only emits near its own ~90% mark) **and** a periodic server-side usage poll of the five-hour window, so a *low* threshold (e.g. 25%) trips even though the stream never reports that low.
  - Stopped sessions stay idle-but-alive and manually resumable. `Stop & resume` schedules an **in-memory** resume timer (~5 s after the five-hour window resets) that is persisted in the resume manifest across a **graceful** restart only — not a hard crash.
  - **`Stop & resume` is a global hard lockout:** while the window is active, *every* session queues its sends with **no** early-resume/override (a valid *future* reset gates it; plain `Stop` never queues).
  - A session whose agent tree is purely **Ollama**-backed is exempt — never auto-stopped, queued, or armed for auto-resume.
  - Mechanism + routing (direct-interrupt vs steer-the-conductor): [docs/features.md](docs/features.md) → Settings → Account; [docs/architecture.md](docs/architecture.md) → overage trip detection + central routing.
- **Opus 4.7/4.8 thinking is redacted** — no readable content (4.7 sends only `signature_delta`; 4.8 sends empty `thinking_delta`s). Both render as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **AskUserQuestion answered via next prompt** — PreToolUse hook denies; tool_result is `is_error:true`; answer is fed in as a normal user prompt. Functionally fine, but the original tool_result is still an error for diagnostics.
- **`--effort` / `--thinking` are spawn-time only** — switching mid-session needs respawn + resume. Only `mode` is live-switchable.
- **Forced interrupt discards partial work** — ⏹ Interrupt now (`force:true`) hard-aborts the turn and discards in-progress work; the default soft ⏸ Interrupt preserves it via a steering message; a post-hard-abort drain window kills spurious queued turns. Detail: [docs/features.md](docs/features.md) → Controls → Two-tier interrupt.
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — auto-registered MCP lets any session call `spawn_instance`; children inherit the auto-registration, no depth guard. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — via `wait:true` or (preferred, per `CONDUCT.md`) `wait:false` + `subscribe_to_idle`.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.

## Documentation

- [docs/features.md](docs/features.md) — exhaustive feature and UI-element catalog (projects, worktrees, sessions, spawn options, conversation, UI, conduct mode, MCP)
- [docs/protocol.md](docs/protocol.md) — subprocess protocol (CLI flags + hooks), WebSocket protocol, REST endpoints
- [docs/architecture.md](docs/architecture.md) — stack, component layout, instance lifecycle, on-disk state, migrations, testing
- [docs/plugins.md](docs/plugins.md) — plugin manifest schema, reverse proxy, bridge protocol, `/api/plugins` REST, child MCP wire contract, Plugin Library, compliance checklist
- [conventions/conductor/](conventions/conductor/) (`core.md` + `footer.md` + toggleable `<slug>.md`) — conductor role prompt / orchestration contract; composed (core + enabled toggleable conventions + footer) into the live `.conduct/CONDUCT.md` loaded by every Conduct session (configurable in Settings → Conventions → Conductor)
- [conventions/workspace/](conventions/workspace/) (`core.md` + toggleable `<slug>.md`) — workspace conventions; composed (core + enabled conventions) into the app-owned projects-root `CLAUDE.md` every project imports via `@../CLAUDE.md` (configurable in Settings → Conventions → Workspace)
- [conventions/project/](conventions/project/) — project conventions; a catalog of `<slug>.md` sections snapshotted into a new project's `CLAUDE.md` at creation (configurable in Settings → Conventions → Project)

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

Copyright © 2026 UnmanagedCode

See the [LICENSE](LICENSE) file for the full license text.

## Attribution

The running app surfaces its legal notice at **⚙ Settings → About** — project name, `Copyright © 2026 UnmanagedCode`, the AGPL-3.0 license, and the source link (https://github.com/UnmanagedCode/code-conductor). This is the "Appropriate Legal Notices" surface required by AGPL-3.0 §5(d); forks and network hosts must keep it intact so downstream users can find the corresponding source (§13).
