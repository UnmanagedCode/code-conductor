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

**Root `CLAUDE.md` reconcile.** On boot (in `start()`, after migrations) the server mirrors the bundled canonical workspace-conventions (`assets/cc-projects-CLAUDE.md`) into `<PROJECTS_ROOT>/CLAUDE.md` via `src/rootClaudeMd.js` and logs the outcome. Strictly **non-fatal** — a reconcile failure is warned and boot continues (unlike a migration, which aborts). The automatic cases are create / up-to-date / silent-update / keep; a both-changed **conflict** is left untouched for you to resolve in **⚙ Settings → Workspace conventions**.

**Voice dictation (optional).** Open **⚙ Settings → Transcribe** and Install a model from the UI (runs `bin/install-whisper.sh` server-side, streams the log, sets the model active), or run that script manually (`WHISPER_MODEL_NAME=<name>` picks the model; default `ggml-small.en-q5_1.bin`, ~182 MB). The composer's mic affordance appears once whisper is available. Override paths via `WHISPER_CLI` / `WHISPER_MODEL` / `FFMPEG_BIN` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `transcribe.js`.

**Text-to-speech (optional).** Same shape: open **⚙ Settings → TTS** and Install a voice from the UI (runs `bin/install-piper.sh` server-side, streams the log, sets the voice active), or run that script manually (`PIPER_VOICE_NAME=<name>`; default `en_US-lessac-medium`). The conversation's 🔊 buttons appear once Piper is available. Override paths via `PIPER_PYTHON` / `PIPER_VENV` / `PIPER_VOICE` / `PIPER_SYNTH_SCRIPT` / `INSTALL_ROOT` env vars. Build internals: [docs/architecture.md](docs/architecture.md) → `tts.js`.

**Install on Android.** Chrome → ⋮ → **Install app** / **Add to home screen**. Uses Web App Manifest (`public/manifest.webmanifest`) + SVG icon + Service Worker for standalone-mode launch.

**Visual debug.** Playwright + Termux Chromium harness in `debug/`, which is a thin wrapper over the **sibling repo** — clone `termux-playwright-harness` to the parent directory of code-conductor and `npm install` once. Not wired into the main test suite.

## Features

- **Projects & workspaces** — sidebar project list with git-status pills; workspaces nest projects under collapsible headers; project create/delete with cascade.
- **Worktrees** — isolated git worktrees per spawn; two-step land-back: sync (FF, auto-rebase, or agent-driven rebase on conflict) then no-ff merge into parent.
- **Diff & history** — mobile-friendly full-page diff browser: `±` on a worktree row shows its `base...HEAD` diff; `≡` on a project row shows the current branch's commit log (capped, newest first) with a `git log --graph`–style branch/merge graph rail to the left (colored lanes, dots, fork/merge diagonals; computed client-side from commit parents), and tapping a commit reuses the same renderer for that single commit's change (`git show`).
- **Sessions & instances** — unified live + historical session list; conducted sessions (MCP-spawned, durable marker); temp sessions with promote; rewind & fork; crash recovery; session anchor (`#session=<sid>`).
- **Resume after restart** — restarting with live sessions offers a graceful drain → restart → resurrect: wind every turn down to idle, carry sessions (incl. temps) over via `<store>/pending-resume.json`, then on boot re-spawn (`--resume`) and notify each one (conductors re-spawn their workers from an injected project+sessionId+worktree list). See [docs/features.md](docs/features.md).
- **Spawn options** — mode (`plan` / `ask` / `code`), effort, thinking, model family (Haiku 200k / Sonnet 200k or 1M per stored preference / Opus 1M / Fable 5 1M; Fable 5 can be disabled in Settings → Models), temp session, debug capture.
- **Live conversation** — streaming markdown, TTS read-aloud (Piper, per-sentence), thinking blocks, tool diffs, plan-mode approval cards, AskUserQuestion cards, ask-mode permission cards; long histories load tail-first with scroll-up lazy-load of earlier messages.
- **UI elements** — task panel, a combined **context-usage + rate-limit chip** (live, colour-graded ctx %; live bucket/utilization/reset-time with an OVERAGE badge when `isUsingOverage`; pinned at the turn-indicator footer right, tap for the usage popover), voice dictation (whisper.cpp — tap empty-composer mic or hold Send to append), settings page (models incl. Fable 5 toggle + default spawn model + **Action on overage** control + optional **usage threshold** slider, transcribe, TTS, workspace conventions, archived sessions), OS notifications via Service Worker.
- **Conduct mode** — `🎼 Conduct` spawns a conductor temp session in `.conduct` project, pre-loaded with `CONDUCT.md` role prompt, orchestrates workers via MCP. While viewing the conductor, a **Sub-agents** strip above the task panel lists each spawned worker with live status and is tap-to-navigate.
- **MCP interface** — 33 tools (`mcp__code-conductor__*`) auto-registered at spawn: read, create, workspaces, spawn/drive (incl. `promote_session`), plan handling, worktrees. The worker handle is always `sessionId` (stable across respawn/restart; the per-process `instanceId` is never exposed); worktree always `worktree`; strict-live resolution soft-refuses with `{ok:false, code:'SESSION_NOT_LIVE'|'SESSION_UNKNOWN'}`; unknown args rejected (legacy `{id}` hard-fails). Full wire contract in [docs/protocol.md](docs/protocol.md#mcp-tool-protocol).
- **Cost dashboard** — full-page `#costs` view aggregating spend from the per-turn `costs.jsonl` log: total + turn count, by-project (drill-down to per-model tokens), by-model, and daily-spend trend. Backed by `GET /api/costs/summary`.

See [docs/features.md](docs/features.md) for the exhaustive feature and UI-element catalog.

## Key defaults

- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load). Override with `PROJECTS_ROOT=<abs-path>`. The whole orchestrator (project list, central store at `<root>/.code-conductor/`, the hidden `.conduct` project) lives under this dir.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- New instance: `plan` mode, `high` effort, `adaptive` thinking, no model flag. `InstanceManager.create()` is policy-light — mode never depends on `temp`. The UI/REST temp checkbox ⇒ `bypassPermissions` mapping is applied at the `POST /api/instances` route. **MCP `spawn_instance`** defaults to `temp:true` but mode still defaults to `plan` (conducted-worker safety contract, since `create()` doesn't couple them) — explicit `temp:false`/`mode` still win.
- Sidebar one-click resume: `bypassPermissions` mode (continuing real work), same effort/thinking defaults. Crash-respawn preserves whatever mode was running.
- Resume without an explicit `model` recovers the model the session was last run with by reading the most-recent `assistant.message.model` from the jsonl — otherwise `claude --resume` falls back to the account default (often Opus) and silently flips a Sonnet/Haiku session. The recovered (bare) id is run through `canonicalizeModel` with the current Sonnet context-window preference (set in **⚙ Settings → Models**), so the window is always re-derived at spawn time and never persisted. Explicit `model` on the POST still wins (also canonicalized).
- Event ring: capped at 2000 events / instance (drop-oldest, `ORCH_EVENT_RING_CAP`); WS subscribe sends only the trailing ≤500 (`ORCH_SNAPSHOT_TAIL`). Older / evicted events are paged on demand from `GET /api/instances/:id/events` (jsonl-replay fallback) — the conversation lazy-loads them on scroll-up.
- Control-request timeout: 5 s. Kill grace: stdin closed → 2 s → SIGTERM → 3 s → SIGKILL (5 s total).

## Known limitations
- **Overage auto-stop is global & conductor-aware; auto-resume is in-memory** — **Settings → Models →
  Action on overage** is `Off` / `Stop` / `Stop & resume` (a **global** setting, not per-session). A trip
  fires on a `rate_limit_event` with `isUsingOverage:true` — or, with the optional **usage-threshold**
  toggle on, when `utilization` crosses the configured percent (default 85%, range **10–99**). The
  threshold is watched from **two** equal-footing sources: the live `rate_limit_event` stream (which
  Anthropic only emits near its own ~90% mark) **and** a periodic server-side usage poll
  (`src/usageOverageMonitor.js`; cadence `ORCH_USAGE_POLL_MS`, default 60 s) of the **five-hour** window —
  so a *low* threshold (e.g. 25%) trips even though the stream never reports that low. Both sources drive
  the same machinery and are deduped by the global one-shot (`_overageActive`), so they never double-trip;
  the poll degrades silently (no trip) when its usage fetch fails/times out.
  Stopped sessions stay idle-but-alive and manually resumable; `Stop & resume` schedules an **in-memory**
  resume timer (~5 s after the five-hour window's `resetsAt`, **not** the far-future overage window) that
  is **lost on orchestrator restart**. The timer is armed for direct-stopped sessions **and** steered
  conductors (both mid-turn and idle-subscribed); orchestrator-injected prompts (the idle-subscription
  wake, the conductor steer) don't cancel a pending resume — only a genuine user takeover does. Routing
  (direct-interrupt vs steer-the-conductor) and clear semantics: see [docs/architecture.md](docs/architecture.md) → overage trip detection + central routing.
- **Opus 4.7/4.8 thinking is redacted** — no readable content (4.7 sends only `signature_delta`; 4.8 sends empty `thinking_delta`s). Both render as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **AskUserQuestion answered via next prompt** — PreToolUse hook denies; tool_result is `is_error:true`; answer is fed in as a normal user prompt. Functionally fine, but the original tool_result is still an error for diagnostics.
- **`--effort` / `--thinking` are spawn-time only** — switching mid-session needs respawn + resume. Only `mode` is live-switchable.
- **Forced interrupt discards partial work** — ⏹ Interrupt now (`force:true`) hard-aborts via `control_request`; the CLI severs the turn, keeps no assistant content, and leaves a `[Request interrupted by user]` tombstone. The default **soft** ⏸ Interrupt avoids this by injecting a steering message that asks the model to wind down gracefully; the message appears in the conversation as a `soft_interrupted` system annotation ("⏸ Turn interrupted"). A **post-hard-abort drain window** (default 3 s) automatically kills any spurious new turns the CLI starts from its leftover input queue, so the model doesn't unexpectedly reactivate after a hard abort (see docs/features.md → Controls → Two-tier interrupt).
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — auto-registered MCP lets any session call `spawn_instance`; children inherit the auto-registration, no depth guard. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — via `wait:true` or (preferred, per `CONDUCT.md`) `wait:false` + `subscribe_to_idle`.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.

## Documentation

- [docs/features.md](docs/features.md) — exhaustive feature and UI-element catalog (projects, worktrees, sessions, spawn options, conversation, UI, conduct mode, MCP)
- [docs/protocol.md](docs/protocol.md) — subprocess protocol (CLI flags + hooks), WebSocket protocol, REST endpoints
- [docs/architecture.md](docs/architecture.md) — stack, component layout, instance lifecycle, on-disk state, migrations, testing
- [CONDUCT.md](CONDUCT.md) — conductor role prompt / orchestration contract (loaded by every Conduct session)
