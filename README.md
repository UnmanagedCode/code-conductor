# CodeConductor

Local webapp for orchestrating multiple Claude Code CLI instances across projects in the parent directory of this repo (typically `~/cc-projects/`; override with the `PROJECTS_ROOT` env var). Spawn, watch, and interact with several `claude` subprocesses in parallel from one browser tab.

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
cd ~/project/code-conductor
npm install            # express, ws
npm start              # http://127.0.0.1:8787
npm test               # integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs opt-in real-claude smoke
```

**Startup check.** Server probes `claude --version` (3s timeout) and credentials (`~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`). Emits `claude OK — v…, authenticated via…` or a framed `WARNING` block per issue. Server starts either way. Implemented in `src/health.js`.

**Root `CLAUDE.md` reconcile.** On boot (in `start()`, after migrations) the server mirrors the bundled canonical workspace-conventions (`assets/cc-projects-CLAUDE.md`) into `<PROJECTS_ROOT>/CLAUDE.md` via `src/rootClaudeMd.js` and logs the outcome. Strictly **non-fatal** — a reconcile failure is warned and boot continues (unlike a migration, which aborts). The automatic cases are create / up-to-date / silent-update / keep; a both-changed **conflict** is left untouched for you to resolve in **⚙ Settings → Workspace conventions**.

**Voice dictation (optional).** Easiest path: open **⚙ Settings → Transcribe** and Install a model from the UI (runs the script server-side, streams the log, sets the model active). Or run `bin/install-whisper.sh` manually — it `pkg install`s ffmpeg + build tools, clones+builds whisper.cpp under `<projectsRoot>/.code-conductor/whisper.cpp/` (the central store), and downloads the `ggml-small.en-q5_1.bin` model (~182 MB); override the model with `WHISPER_MODEL_NAME=<name>`. Either way the composer's mic affordance appears once whisper is available. Override paths via `WHISPER_CLI` / `WHISPER_MODEL` / `FFMPEG_BIN` (and `INSTALL_ROOT`, which defaults to the central store and honours `PROJECTS_ROOT`) env vars.

**Text-to-speech (optional).** Same shape, inverted: open **⚙ Settings → TTS** and Install a voice from the UI (runs the script server-side, streams the log, sets the voice active). Or run `bin/install-piper.sh` manually — it `pkg install`s `onnxruntime python-onnxruntime espeak clang`, builds a Piper venv under `<projectsRoot>/.code-conductor/piper/` (the central store; incl. a natively-compiled `espeakbridge.so` patched for Termux espeak-ng 1.52.0), and downloads a voice (`en_US-lessac-medium` by default; override with `PIPER_VOICE_NAME=<name>`). Either way the conversation's 🔊 buttons appear once Piper is available. Override paths via `PIPER_PYTHON` / `PIPER_VENV` / `PIPER_VOICE` / `PIPER_SYNTH_SCRIPT` (and `INSTALL_ROOT`, which defaults to the central store and honours `PROJECTS_ROOT`) env vars.

**Install on Android.** Chrome → ⋮ → **Install app** / **Add to home screen**. Uses Web App Manifest (`public/manifest.webmanifest`) + SVG icon + Service Worker for standalone-mode launch.

**Visual debug.** Playwright + Termux Chromium harness in `debug/`, which is a thin wrapper over the **sibling repo** — clone `termux-playwright-harness` to the parent directory of code-conductor and `npm install` once. Not wired into the main test suite.

## Features

- **Projects & workspaces** — sidebar project list with git-status pills; workspaces nest projects under collapsible headers; project create/delete with cascade.
- **Worktrees** — isolated git worktrees per spawn; two-step land-back: sync (FF or agent-driven rebase) then no-ff merge into parent.
- **Sessions & instances** — unified live + historical session list; conducted sessions (MCP-spawned, durable marker); quick-spawn ↯ picker; temp sessions with promote; rewind & fork; crash recovery; session anchor (`#session=<sid>`).
- **Spawn options** — mode (`plan` / `ask` / `code`), effort, thinking, model family (Haiku 200k / Sonnet & Opus 1M), temp session, debug capture.
- **Live conversation** — streaming markdown, TTS read-aloud (Piper, per-sentence), thinking blocks, tool diffs, plan-mode approval cards, AskUserQuestion cards, ask-mode permission cards.
- **UI elements** — task panel, context-usage chip (live, colour-graded), rate-limit chip (live bucket/utilization/reset-time, left side of bottom bar; shows OVERAGE badge when `isUsingOverage`), voice dictation (whisper.cpp — tap empty-composer mic or hold Send to append), settings page (models + auto-stop-on-overage toggle, transcribe, TTS, workspace conventions), OS notifications via Service Worker.
- **Conduct mode** — `🎼 Conduct` spawns a conductor temp session in `.conduct` project, pre-loaded with `CONDUCT.md` role prompt, orchestrates workers via MCP.
- **MCP interface** — 20+ tools (`mcp__code-conductor__*`) auto-registered at spawn: read, create, workspaces, spawn/drive (incl. `promote_session` to keep a temp worker), plan handling, worktrees. MCP `spawn_instance` defaults to temp:true but keeps mode at plan.

See [docs/features.md](docs/features.md) for the exhaustive feature and UI-element catalog.

## Key defaults

- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load — typically `~/cc-projects/` if you cloned into the conventional location). Override with `PROJECTS_ROOT=<abs-path>`. The whole orchestrator (project list, central store at `<root>/.code-conductor/`, the hidden `.conduct` project) lives under this dir; `~/project/` is the docs shorthand for it.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- New instance: `plan` mode, `high` effort, `adaptive` thinking, no model flag. `InstanceManager.create()` is policy-light — mode never depends on `temp`. The UI/REST temp checkbox ⇒ `bypassPermissions` mapping is applied at the `POST /api/instances` route. **MCP `spawn_instance`** defaults to `temp:true` but mode still defaults to `plan` (conducted-worker safety contract, since `create()` doesn't couple them) — explicit `temp:false`/`mode` still win.
- Sidebar one-click resume: `bypassPermissions` mode (continuing real work), same effort/thinking defaults. Crash-respawn preserves whatever mode was running.
- Resume without an explicit `model` recovers the model the session was last run with by reading the most-recent `assistant.message.model` from the jsonl — otherwise `claude --resume` falls back to the account default (often Opus) and silently flips a Sonnet/Haiku session. The recovered (bare) id is run through `canonicalizeModel` so the family's fixed window is re-applied (Sonnet → `[1m]`); the window is never persisted, and nothing of ours is written into Claude's jsonl for it. Explicit `model` on the POST still wins (also canonicalized).
- Ring buffer: 500 events / instance.
- Control-request timeout: 5 s. Kill grace: stdin closed → 2 s → SIGTERM → 5 s → SIGKILL.

## Known limitations
- **Opus 4.7/4.8 thinking is redacted** — no readable content (4.7 sends only `signature_delta`; 4.8 sends empty `thinking_delta`s). Both render as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **AskUserQuestion answered via next prompt** — PreToolUse hook denies; tool_result is `is_error:true`; answer is fed in as a normal user prompt. Functionally fine, but the original tool_result is still an error for diagnostics.
- **`--effort` / `--thinking` are spawn-time only** — switching mid-session needs respawn + resume. Only `mode` is live-switchable.
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — auto-registered MCP lets any session call `spawn_instance`; children inherit the auto-registration, no depth guard. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — via `wait:true` or (preferred, per `CONDUCT.md`) `wait:false` + `subscribe_to_idle`.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.

## Documentation

- [docs/features.md](docs/features.md) — exhaustive feature and UI-element catalog (projects, worktrees, sessions, spawn options, conversation, UI, conduct mode, MCP)
- [docs/protocol.md](docs/protocol.md) — subprocess protocol (CLI flags + hooks), WebSocket protocol, REST endpoints
- [docs/architecture.md](docs/architecture.md) — stack, component layout, instance lifecycle, on-disk state, migrations, testing
