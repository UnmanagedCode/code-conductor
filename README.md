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

## Features

### Projects & workspaces
- **Project list** — sidebar shows every dir under `~/project/`. `+ New project` creates a dir with `CLAUDE.md` containing `@../CLAUDE.md`. Worktree-owned dirs are hidden from the list (filtered against a Set built from the central store).
- **Delete project** — `×` per row, typed-name confirm; cascades through instances + worktrees then `rm -rf`s the project. `~/.claude/projects/<encoded>/` jsonls are left intact (still resumable by the standalone CLI).
- **Workspaces** — `≡` hamburger menu hosts `+ New workspace`; nest projects under collapsible `<details>` headers, one workspace per project, empty workspaces persist. Edit (rename / re-pick members / delete) via the ✎ button on each header. Workspaces default-collapsed; expand state persists in `localStorage` (`code-conductor:workspaces-expanded`). Stored server-side at `~/project/.code-conductor/projects/<name>/project.json`; the workspace set is the union of `~/project/.code-conductor/workspaces.json` and any referenced names. Workspace names use the same `^[a-zA-Z0-9._-]+$` regex as project names.
- **Git status pill** —
  - **Project rows**: amber `↑N ↓M` against the currently-checked-out branch's *configured upstream* (e.g. `origin/<branch>`), using cached refs only (no `git fetch`). No pill when in sync / detached / upstream-less.
  - **Worktree rows**: same shape but compares the worktree branch to its captured *parent base branch* (may be a local branch, not a remote). `↑N` = ahead and FF-able, `↓M` = behind and FF-able, `↑N ↓M` = diverged → rebase needed before merge.

### Worktrees
- **Isolated environments** — "Run in isolated git worktree" checkbox in the new-instance dialog runs `git worktree add ../<project>_worktree_<short-id> -b code-conductor/<short-id> <currentSha>` and spawns the agent with `cwd` set to the worktree. The orchestrator captures `{baseBranch, baseSha, branch}` at creation so you can spawn off any branch and land back later. Worktrees survive instance death — re-spawn into the same worktree from the sidebar.
- **Two-step rebase-back**:
  - **Sync** — already in sync → no-op; purely behind & clean → server-side `git merge --ff-only <baseBranch>`; diverged or behind-but-dirty → orchestrator sends the agent a templated rebase prompt (it runs `git rebase` itself, asks the user via `AskUserQuestion` on non-trivial conflicts, replies `REBASE_DONE`). Orchestrator never rebases directly.
  - **Merge** — `git merge --no-ff --no-edit <worktreeBranch>` on the parent. Always produces a merge commit (default msg `Merge branch 'code-conductor/<id>'`) so each contribution stays visible in `git log --graph` and is revertible as one commit. Refuses inline (not as a 500) if the worktree is behind the parent, the parent is on a different branch than `baseBranch`, or the parent tree is dirty.
- **Delete** — refused if there's a live instance or uncommitted work, with a `force=1` override.

### Sessions & instances
- **Unified view** — Sessions list per project (and per worktree) shows live + historical. Header: `Sessions (N) · K live · last <ago>`. Click to focus live instance, or resume stopped one (`POST /api/instances` with `--resume <sid>`). Synthetic `(new session)` row for spawned-but-no-jsonl-yet instances.
- **Quick-spawn ↯** — `↯` button next to `+` on every project row pops a 3-button Haiku/Sonnet/Opus picker; one tap spawns a **temp session** in `code` mode at the project root, no dialog. A **Code / Plan & Approve** segmented toggle below the model row picks the spawn variant: `Code` (default) → `bypassPermissions`; `Plan & Approve` → `plan` mode with auto-approve pre-armed so the first `ExitPlanMode` auto-approves and rolls into `bypassPermissions` without a second click. Resets to `Code` each open (no persistence). Temp sessions render inside the regular Sessions subnode, pinned below a dim `— temp —` separator with a warm preview colour (`.session-row.temp`). Their on-disk jsonl is filtered out of `listSessions`/`summarizeSessions` server-side while the temp instance is live, so clicking a temp row always hits the live instance (no 409 against `--resume`) and the row vanishes the moment the temp exits + its jsonl is wiped. Each temp row has an always-visible `↑` button (no hover gate, mobile-tappable) that **promotes** the session via `POST /api/instances/:id/promote` — flips `temp:false`, writes the resume-picker metadata, broadcasts the status change, and the row migrates above the separator into the normal list.
- **Unread indicator** — small accent pill next to a row when its instance finishes a turn while you're viewing a different session (per-instance, persisted in `localStorage` key `code-conductor:unread`).
- **Delete session** — hover-revealed `×`, single confirm; on 409 the client auto-retries with `?force=1` (kills the live instance) without a second prompt.
- **Rename session** — `⋮` menu's `✎ Rename session` opens a prompt to set a custom human-readable label (≤100 chars, empty clears) that overrides the first-prompt preview in the sidebar and prepends an italic chip to the active header. Stored in `~/project/.code-conductor/session-titles.json` keyed by `sessionId`; auto-cleaned when the session jsonl is deleted or a temp session exits. Survives rewind (same `sessionId`); fork starts un-titled.
- **Rewind & fork** — every user message bubble has `↶` (rewind in place, same `sessionId`) and `⑂` (fork to a new `sessionId`) on hover. Both atomically rewrite the jsonl, preserve the dropped prompt in the composer, and 409 during a running turn.
  - Rewinding **to the first user message** is special-cased: prefix is empty, so the orchestrator deletes the jsonl entirely and respawns with `--session-id <sid>` (not `--resume`, which the CLI rejects on zero-line files).
  - **Temp sessions cannot be rewound or forked** — the on-exit cleanup races the rewrite.
  - UI-only — no MCP equivalent yet.
- **Crash recovery** — subprocess death → `crashed`; Resume respawns with `--resume <sid>`, preserving the in-memory event ring + conversation.
- **Session anchor** — `#session=<sid>` URL hash; on reload, auto-resumes by locating the jsonl on disk (worktree-aware) via `GET /api/sessions/:sid/locate`. `--resume` spawn costs zero API tokens until the next prompt. Stale anchors are silently cleared.

### Spawn options
- **Mode** — `plan` (read-only, propose then `ExitPlanMode`), `ask` (every destructive tool gates through Allow/Deny card), `code` (full power, CLI's `bypassPermissions`). CLI's `default` / `acceptEdits` are not exposed: in `stream-json --print` (no SDK `canUseTool` callback) they auto-deny tool calls and the only recovery is forcing the model to regenerate the entire tool input.
- **Effort** — `low` / `medium` / `high` (default) / `xhigh` / `max`.
- **Thinking** — `adaptive` (default) / `enabled` / `disabled`.
- **Model** — empty (account default) or pick a family (Haiku / Sonnet / Opus). Each family runs at a single fixed context window: **Haiku 200k, Sonnet & Opus 1M** (Sonnet gets the CLI-native `[1m]` suffix; Opus is 1M bare; Haiku has no 1M build). No per-spawn window choice. The concrete version each family resolves to is configurable in **⚙ Settings → Models** (defaults `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-haiku-4-5`). The window is re-derived from the family on resume (`canonicalizeModel` in `src/modelVersions.js`), so nothing about it is persisted.
- **Temp session** — deletes the jsonl + sibling `subagents/` dir on exit, drops itself from the sidebar's Sessions list on exit/crash (no ghost row to clean up by hand), and skips `last-prompt`/`permission-mode` metadata appends during the run; mode defaults to `code`; header shows a `TEMP` pill.
- **Debug mode** — mirrors raw CLI traffic (`claude-stdin.jsonl`, `claude-stdout.jsonl`, `claude-stderr.log`, `meta.json`) to `~/project/.code-conductor/projects/<p>/[worktrees/<wt>/]debug/<instance-id>/`. Append-mode, survives session end. Header shows a `DEBUG` pill.

### Live conversation
- **Text** — streams as text-node deltas; on `text_end` re-renders through `public/markdown.js` (headings, lists, code, **bold**, *italic*, links, autolinked bare `http(s)://…` URLs, `![alt](src)` images). Link schemes restricted to `http(s)/relative/fragment/mailto`; image `src` to `http(s)/file://`/absolute path; no `innerHTML`; raw HTML in source rendered as literal text.
- **Text-to-speech (read aloud)** — the inverse of voice dictation: finalized assistant text blocks get a trailing `🔊` button (tap to hear it), and a global **auto-speak** toggle reads each reply as it lands. Runs **server-side Piper** (local neural TTS) — no network, no API key. Synthesis is **streamed per sentence**: `POST /api/tts` returns a sequence of `[4-byte LE length][WAV]` frames (one per sentence) flushed as Piper yields them; the client (`public/tts.js`) decodes each with the Web Audio API and schedules them back-to-back, so the first sentence starts playing (~0.3s) while the rest synthesize. The 🔊 button only appears once `bin/install-piper.sh` has run (`GET /api/tts/status` gates it; Settings → TTS installs/flips it at runtime). Auto-speak only fires after the user has interacted at least once (browsers block audio without a prior gesture); a 🔊 tap always works. Sub-agent text isn't auto-spoken.
- **Thinking** — collapsible block; redacted thinking renders as a non-expandable `thinking (redacted)` line (no disclosure caret). Opus 4.7 emits only a `signature_delta`; Opus 4.8 streams empty `thinking_delta`s (`""`) — the parser drops the empties so both collapse to the same redacted line.
- **Tool use** — collapsed by default with smart one-line summary (`🔧 Bash · ls -la · done`). Edit/Write/NotebookEdit render as syntax-coloured unified diffs (green/red gutters, ±counts, sticky file-path); Write shows a numbered preview. Other tools: raw-JSON input in its own collapsed `↪ tool_input` block.
- **Tool result** — truncated at 4 KB with "show full". `image` content blocks (e.g. `Read` on a `.png`/`.jpg`) render as inline `<img>` thumbnails alongside the text — base64 sources become `data:` URLs, `url` sources only pass through for `http(s)`/`file://`, `image/svg+xml` is refused (XSS). Auto-expanded when an image is present. Tap any conversation image to open it full-size in an in-page lightbox (`public/lightbox.js`) — works for `data:`/`file://` sources that Chrome on Android refuses to open as a top-level navigation. Opens fit-to-screen; tap the image to toggle 1:1 full native resolution (backdrop scrolls to pan), tap again to fit; tap backdrop or press Esc to close.
- **Sub-agent drill-down** — `Task` tool calls nest a mini-conversation (dashed border, `↳ sub-agent` label) inside the parent tool block, routed by `parentToolUseId`.
- **Plan mode card** — green-bordered card "Plan ready for approval". Body comes from `input.plan`, or — when the model wrote the plan to `~/.claude/plans/*.md` first and called `ExitPlanMode` with empty input — the most-recent such file. **Approve** sends `"I approve the plan. Please proceed with the implementation."` (+ feedback if provided) and flips the instance to `code` (`bypassPermissions`). **Reject** keeps plan mode active and sends `"I'd like to revise the plan. Refinement notes:\n<feedback>"`. **📋 Auto-approve plans** toggle sits inline immediately left of the mode dropdown and is only visible while the instance is in `plan` mode (one-click, mid-turn friendly); per-instance, server-side state (mirrored down through `snapshot`/`status` WS frames so every tab agrees), cleared on server restart. When on, the orchestrator fires the same setMode+approval-prompt the moment a `plan_request` lands — works regardless of whether any tab is subscribed / focused / minimized. Green-tinted background when on, outlined when off.
- **AskUserQuestion card** — blue card; multi-question tab strip across the top. Same input field flips role: **Other:** before any option picked (overrides), **Add a note (optional)** after a pick. Typed text persists across pick/unpick. **Send all answers** enables once every question is answered and queues if instance is busy (flushes on next `status=idle`).
- **Ask-mode card** — purple-bordered, with tool name + summary + full diff/Write preview. **Allow** → `permissionDecision:"allow"` resolves the held-open HTTP hook response; CLI proceeds with the original `tool_use_id` (no model regeneration). **Deny** → inverse. `permission_resolved` flips the card to ✓/✗ across tabs.
- **System notes** — kept: `init`, `stderr`, `exit`, `permission_denied`, `compacting`, `spawn_error`, `crashed`, `history_load_error`, non-allowed `rate_limit_event`. Filtered: per-turn `status:"requesting"`, `rate_limit_event:"allowed"`, hook lifecycle pings, task progress.
- **Turn footer** — duration, cost, tokens.

### UI elements
- **Task panel** — strip above composer mirroring `TaskCreate`/`TaskUpdate`. Groups into batches: while at least one task is pending/in-progress, the whole batch (including its ✓s) stays. Panel hides only when *all* batches are fully completed; a new task post-batch drops the historical ✓s and starts fresh.
- **Footer status bar** — thin row pinned between task panel and composer. **Left**: pulsing green dot + animated `Claude is working…` ellipsis while the active instance is in `turn` status (respects `prefers-reduced-motion` — stays visible but stops animating). **Right**: ctx chip. Collapses when no instance is selected.
- **Context-usage chip** — `ctx N% · 245k/1M` pinned right of the footer. `N%` = latest `message_start`'s `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` over the model's context window. Updates **live mid-turn** (each agent-loop step fires a `message_start`). Colour-graded green/amber/red at 50%/80%; tap for session totals (turns, duration, cost, uncached input, output, cache reads + hit ratio, cache creation). Window sizes hardcoded per family (suffix-stripped before lookup): Haiku → 200k, Opus & Sonnet → 1M.
- **Composer** — Enter sends, Shift+Enter newlines. Placeholder reflects state ("turn running — your message will queue", "click Resume", etc.). Queueable during running turns. Attachments via `+` button, paste, or drag-and-drop (10 MB cap each). Saved to `~/project/.code-conductor/projects/<p>/[worktrees/<wt>/]attachments/<timestamp>-<name>` and referenced via `` Attached file: `<abs-path>` `` text blocks — no inline base64, Claude `Read`s on demand. Project/worktree dirs stay clean (no `.gitignore` needed). User-bubble thumbnails: live echoes paint from in-memory base64, replays fetch via `GET /api/instances/:id/attachments/<filename>`.
- **Voice dictation** — no separate mic button; dictation is folded into the **Send** button (WhatsApp-style). When the composer is **empty** and whisper is installed, the Send button becomes a mic (neutral styling): **press-and-hold to record** (red pulse), **release to stop and transcribe**. While the transcription POST is in flight the button shows an amber spinning icon, then the resulting text is inserted at the textarea caret (space-joined so back-to-back words don't run together). Dictated text stays plain in the composer; when you **send** a message that included any dictation, it's prepended with a `<transcribed>` tag so the receiving instance knows it contains speech-to-text that may have transcription errors. The instant the composer has text or a valid attachment, the button reverts to the blue **Send** (tap or Enter to send) — so dictation is only available from an empty composer (you can't dictate to append onto existing text). When whisper isn't installed, an empty composer just shows a disabled Send, exactly as before. Recording uses Pointer Events (`pointerdown`/`up`/`cancel`/`leave`) so a quick release that beats the mic-permission grant still stops cleanly. Runs whisper.cpp **locally on the server** — no network, no API key, no telemetry. The mic affordance only appears once `bin/install-whisper.sh` has been run (~210 MB: 30 MB binary + ~182 MB `small.en-q5_1` model; `GET /api/transcribe/status` gates it, and the Settings page can flip it at runtime). Recording uses the browser's `MediaRecorder` (webm/opus); the server converts via ffmpeg → 16 kHz mono WAV before calling `whisper-cli`.
- **Settings page** — `⚙ Settings` in the sidebar `≡` burger menu (which now lists, top-down, `+ New workspace`, `+ New project`, `⚙ Settings`) opens a full-page view inside `#main`, hash-routed at `#settings` (survives reload; closing restores the previously-active session anchor). Built as a group-nav + content scaffold for future groups. **Transcribe group**: shows whisper availability + the active model, a curated model picker (`tiny.en-q5_1` → `large-v3-q5_0`, with size labels and per-model installed/active badges), and an **Install** button. Picking an already-installed model switches the active model instantly (persisted server-side, takes effect immediately — no restart); picking a not-installed one offers Install, which runs `bin/install-whisper.sh` server-side and streams its log (polled). On a clean install the chosen model is set active and the composer's mic affordance re-reveals without a reload. **TTS group**: shows Piper availability + active voice, an auto-speak toggle, a playback-rate slider (0.5–2.0×), a curated voice picker (`en_US-lessac-medium` and friends, with installed/active badges), and an **Install** button that runs `bin/install-piper.sh` server-side and streams its log (polled) — exactly like the Transcribe group; a clean install sets the chosen voice active and reveals the 🔊 buttons without a reload. **Models group**: one picker per Claude family (Sonnet / Opus / Haiku) selecting the concrete model *version* (e.g. `claude-sonnet-4-6` vs `claude-sonnet-4-5`) used by the three spawn pickers (quick-spawn ↯, Conduct, new-session dialog). Persisted server-side (`settings.json` `models` namespace), takes effect immediately — no restart. Each family runs at a single fixed context window (Haiku 200k, Sonnet & Opus 1M) — no per-spawn window choice; `public/models.js`'s `resolveSpawnModel(family)` applies the family's canonical suffix at click time (Sonnet → `[1m]`). `public/settings.js` (+ `public/models.js` client cache/resolver).
- **Controls** — 📋 auto-approve-plans toggle (plan mode only), mode dropdown (live `control_request set_permission_mode`), **Resume** when exited/crashed. Context-aware **⏸ Interrupt** (turn running) / **🛑 Terminate** (otherwise, with confirm) lives in the ⋮ menu alongside 🐛 Debug.
- **Notifications** — 🔔/🔕 toggle in sidebar header (global, not per-instance). Pings OS when any instance finishes while tab is hidden (errors notify even when visible). On page reload the bell auto-enables if Notification permission was previously granted. Dispatched via Service Worker (`public/sw.js`) because mobile Chrome refuses page-level `new Notification(...)`. `notificationclick` focuses the existing tab. When ≥ 2 per-instance pings (tag `instance:<id>`) are live in the tray, an extra summary notification (tag `cc-summary`) is added: title `"N turns complete"`, body `"projA, projB, projC[ …+M more]"` (≤ 3 project names). Summary auto-clears when the tab regains focus, along with every per-instance ping. SW-only path — desktop page-level fallback skips summarization (the host OS already groups differently).
- **Restart server button** — `⟲` at sidebar bottom. POSTs `/api/admin/restart` (202 immediate, spawns a detached child, exits). Frontend waits 800 ms (let the old socket release), polls `GET /api/projects` with `cache:'no-store'` until 200, then `location.reload()` so HTML/CSS/JS get re-fetched. Anchor-auto-resume kicks in post-reload. Temp-session cleanup is two-layer: (1) before the parent exits, `InstanceManager.shutdownTempSync()` SIGKILLs every live temp claude (SIGTERM would let it flush a final line that re-creates the `O_APPEND|O_CREAT`'d jsonl), blocks synchronously until each pid is reaped, and deletes their jsonl + `subagents/` dir twice for belt-and-braces. (2) `scheduleRestart` writes `<store>/pending-temp-cleanup.json` listing every temp `{cwd, sessionId}` so the next boot's `sweepPendingTempCleanup` re-deletes anything orphaned subagent processes recreated after our exit. The manifest is unlinked on each successful sweep.

### Conduct mode
- **`🎼 Conduct` button** at the top of the sidebar (where `+ New project` used to live; that moved into the `≡` burger menu next to `+ New workspace`). Tap → model picker dialog (Haiku / Sonnet / Opus — one fixed window each) with a Code/Plan & Approve toggle. One pick spawns a **temp** Claude session in the hidden `.conduct` project, pre-configured to orchestrate other sessions via MCP.
- **`.conduct` project** lazy-created on first dialog open (`POST /api/projects/.conduct/ensure`). Lives at `~/project/.conduct/`. `CLAUDE.md` contains a single in-project `@CONDUCT.md` import; `CONDUCT.md` itself is a symlink in `.conduct/` pointing at the repo's `CONDUCT.md` (the conductor role prompt-engineering, committed to source control). Claude Code only resolves `@-import` paths inside the project root — external paths need a UI approval that never fires in `-p` / headless mode (how every conductor session is spawned) and silently no-op, so the symlink keeps the import in-project while still tracking the committed file. The workspace-wide `@../CLAUDE.md` is omitted on purpose: Claude Code's ancestor walk-up already pulls in `cc-projects/CLAUDE.md`. The dir is filtered out of `listProjects()` by the existing dot-prefix rule, so it never appears in the sidebar; the sidebar synthesises a `🎼 Conduct` row only while a live conductor instance exists. Reserved name: `POST /api/projects {name:".conduct"}`, `DELETE /api/projects/.conduct`, and `PUT /api/projects/.conduct/workspace` all return 400.
- **Workflow** (full details in `CONDUCT.md`): conductor uses MCP to `spawn_instance({mode:'plan', worktree:true})`, reviews via `get_recent_messages` / `get_worktree_diff`, lands via `approve_plan` → `sync_worktree` → `merge_worktree` → `kill_instance` + `delete_worktree`.

### MCP interface
Mounted at `POST /mcp` (Streamable HTTP, JSON-RPC 2.0); tools exposed as `mcp__code-conductor__*`. Auto-registered on every spawn via `--mcp-config` (opt out with `ORCH_DISABLE_MCP_AUTOREGISTER=1`). No auth — localhost-only.

- **Read:** `list_projects`, `list_workspaces`, `list_instances`, `list_sessions`, `list_worktrees`, `locate_session`, `get_transcript`, `get_recent_messages` (optional `count` → last N messages, default 1, max 50; `includeToolCalls` → include tool-call-only messages; `includeThinking` → include thinking blocks in `blocks[]`), `project_status`, `read_file` (path-traversal guarded), `get_worktree_diff` (full unified diff of `<base>...HEAD`, capped at ~200 KB).
- **Create:** `create_project` (`{name, gitInit?}`).
- **Workspaces:** `create_workspace` (`{name}` — register), `delete_workspace` (`{name}` — removes registry entry + clears member assignments), `rename_workspace` (`{oldName, newName}` — atomic), `set_project_workspace` (`{project, workspace}` — assign or clear with `null`/`""`; refuses `.conduct`; auto-registers a new workspace name).
- **Spawn/drive:** `spawn_instance`, `send_prompt` (optional `wait:true`, 10 min cap), `wait_for_idle`, `subscribe_to_idle` / `unsubscribe_from_idle` (one-shot async callback — when target hits `turn_end` the orchestrator injects a stub user prompt into the *caller* via `Instance.prompt()`, naming the worker and pointing at `get_recent_messages`; caller identity is read from `?caller=<id>` on the per-instance MCP URL), `set_mode`, `interrupt_turn`, `kill_instance`, `respawn_instance`.
- **Plan handling (Conduct-mode verbs):** `approve_plan` (`{instanceId, feedback?}` — flips to bypassPermissions + sends canonical approval prompt), `reject_plan` (`{instanceId, feedback?}` — stays in plan mode, asks for refinement), `set_auto_approve_plan` (`{instanceId, enabled}` — flip the per-instance auto-approve flag). All three share the same approval/rejection text as the UI's Approve & Implement / Reject buttons via `src/planApproval.js`.
- **Worktrees:** `create_worktree`, `delete_worktree`, `sync_worktree`, `merge_worktree` (takes `instanceId` or `{project, worktreeName}` — the latter works after the instance is gone).

## Quick start

```bash
cd ~/project/code-conductor
npm install            # express, ws
npm start              # http://127.0.0.1:8787
npm test               # integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs opt-in real-claude smoke
```

**Startup check.** Server probes `claude --version` (3s timeout) and credentials (`~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`). Emits `claude OK — v…, authenticated via…` or a framed `WARNING` block per issue. Server starts either way. Implemented in `src/health.js`.

**Voice dictation (optional).** Easiest path: open **⚙ Settings → Transcribe** and Install a model from the UI (runs the script server-side, streams the log, sets the model active). Or run `bin/install-whisper.sh` manually — it `pkg install`s ffmpeg + build tools, clones+builds whisper.cpp under `<projectsRoot>/.code-conductor/whisper.cpp/` (the central store), and downloads the `ggml-small.en-q5_1.bin` model (~182 MB); override the model with `WHISPER_MODEL_NAME=<name>`. Either way the composer's mic affordance appears once whisper is available. Override paths via `WHISPER_CLI` / `WHISPER_MODEL` / `FFMPEG_BIN` (and `INSTALL_ROOT`, which defaults to the central store and honours `PROJECTS_ROOT`) env vars.

**Text-to-speech (optional).** Same shape, inverted: open **⚙ Settings → TTS** and Install a voice from the UI (runs the script server-side, streams the log, sets the voice active). Or run `bin/install-piper.sh` manually — it `pkg install`s `onnxruntime python-onnxruntime espeak clang`, builds a Piper venv under `<projectsRoot>/.code-conductor/piper/` (the central store; incl. a natively-compiled `espeakbridge.so` patched for Termux espeak-ng 1.52.0), and downloads a voice (`en_US-lessac-medium` by default; override with `PIPER_VOICE_NAME=<name>`). Either way the conversation's 🔊 buttons appear once Piper is available. Override paths via `PIPER_PYTHON` / `PIPER_VENV` / `PIPER_VOICE` / `PIPER_SYNTH_SCRIPT` (and `INSTALL_ROOT`, which defaults to the central store and honours `PROJECTS_ROOT`) env vars.

**Install on Android.** Chrome → ⋮ → **Install app** / **Add to home screen**. Uses Web App Manifest (`public/manifest.webmanifest`) + SVG icon + Service Worker for standalone-mode launch.

**Visual debug.** Playwright + Termux Chromium harness in `debug/`, which is a thin wrapper over the **sibling repo** — clone `termux-playwright-harness` to the parent directory of code-conductor and `npm install` once. Not wired into the main test suite.

## Technical

### Stack
- Node 22+ (`node:test`, top-level await, `crypto.randomUUID`).
- `express` (REST + static) + `ws` (WebSocket).
- Vanilla HTML/CSS/JS in `public/`, no build step.
- `happy-dom` (dev-only) for DOM-backed rendering tests.
- No DB — projects in `~/project/`, sessions in `~/.claude/projects/<encoded-cwd>/*.jsonl`.

### Subprocess protocol
```bash
claude -p \
  --input-format=stream-json --output-format=stream-json \
  --verbose --include-partial-messages --include-hook-events \
  --allow-dangerously-skip-permissions \
  --permission-mode <plan|bypassPermissions> --effort <effort> --thinking <thinking> \
  --settings '{"hooks":{"PreToolUse":[…]}}' \
  --mcp-config '{"mcpServers":{"code-conductor":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}' \
  [--model <name>] \
  --session-id <fresh-uuid> | --resume <existing-uuid>
```

`--allow-dangerously-skip-permissions` is **always** passed at spawn — even for `plan`-mode instances — because without it the CLI rejects any later runtime `set_permission_mode bypassPermissions` (i.e. the plan-approve flow). The flag only *permits* the switch; it doesn't activate bypass on its own.

Two `PreToolUse` hooks via inline `--settings` JSON:
1. **AskUserQuestion|ExitPlanMode** — `command` hook, static deny with reason "Awaiting user input via the orchestrator UI". The CLI auto-errors both tools in stream-json `--print` mode anyway (no SDK `canUseTool` callback to satisfy); the deny just gives them a friendlier reason. The model receives an `is_error: true` tool_result, ends the turn naturally, and the orchestrator drives the conversation forward via the next user prompt (plus, for plan approval, a `setMode(bypassPermissions)` control_request first).
2. **Edit|Write|NotebookEdit|Bash** — `http` hook → `POST /api/instances/<id>/hook-callback`, **660 s** CLI-side timeout. Orchestrator auto-allows when the mode isn't `ask`; in `ask` mode holds the response open up to **540 s** (deliberately under 660 s — an HTTP timeout would make the CLI treat the hook as a non-blocking error and proceed, the opposite of intent). `ask` is orchestrator-tracked only and maps to `bypassPermissions` at the CLI level; the hook callback inspects orchestrator-side mode to gate.

Inbound: `user` (text or `[{type:"text", text:"..."}, …]` blocks; attachments use `` Attached file: `<rel-path>` ``), `control_request` (`set_permission_mode` / `interrupt`), `keep_alive`.

Outbound: `system` + `subtype:"init"` (bundled with first turn's response, not at startup; carries `session_id`, `model`, `tools`, `permissionMode`), `stream_event` (live SSE deltas — primary feed), `assistant` (final reconciled per-turn message — used for replay only), `user` (`tool_result` blocks), `result` (turn-end with `duration_ms`, `usage`, `total_cost_usd`, `stop_reason`, `is_error`), `hook_event`, `control_response`.

### Component layout
- **server.js** — Express + ws boot, mounts routes, binds `127.0.0.1:8787`.
- **src/instances.js** — Instance class, InstanceManager, ring buffer (500 events), control_request round-trip, mode validation.
- **src/hookBroker.js** — Per-instance broker for the PreToolUse http hook, pending-response map keyed by `tool_use_id`, 540 s timeout.
- **src/settings.js** — Builds the inline `--settings` JSON. Pure values → JSON string; no Instance state.
- **src/transcript.js** — Replays `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` into UI-event shape on resume; best-effort `last-prompt`/`permission-mode` appends; exports `isPureUserPromptLine`.
- **src/sessionEdit.js** — Atomic destructive jsonl edits: `truncateSessionAtUserMessage` (tmp → fsync → rename, appends fresh metadata at the new leaf), `forkSessionAtUserMessage` (copies prefix into a new `<sid>.jsonl` with `sessionId` rewritten on every line). Both return `droppedText` for composer prefill.
- **src/parser.js** — stream-json line → UI event normalization. Delta merging by `(msgId, blockIdx)`, `thinking_redacted` emission, `parentToolUseId` routing, structured `user_question` / `plan_request` events.
- **src/projects.js** — FS ops on `~/project/`, cwd encoding for `~/.claude/projects/`, CLAUDE.md seeding.
- **src/conduct.js** — `ensureConductProject()` lazy-creates `~/project/.conduct/` and seeds its `CLAUDE.md` with `@../CLAUDE.md` + absolute path to `CONDUCT.md` (resolved from `import.meta.url`). Idempotent; `wx` flag preserves user customisation.
- **src/planApproval.js** — `buildApprovePrompt(feedback)` / `buildRejectPrompt(feedback)`. Source-of-truth for the magic strings the UI's Approve & Implement / Reject buttons, the server-side auto-approve, and the MCP `approve_plan` / `reject_plan` tools all send to the worker.
- **src/routes.js** — Thin REST shell; hosts hook-callback, attachment streaming, `/admin/restart`, worktree sync/merge.
- **src/restart.js** — `scheduleRestart()`: close WSS + http, spawn detached child with same argv/env/cwd, exit. Child's listen-with-retry handles `EADDRINUSE`.
- **src/worktrees.js** — `createWorktree` captures `{baseBranch, baseSha, branch}` + writes `worktree.json` into the central store, then `git worktree add` off the captured SHA. `syncWorktree` picks no-op / FF / rebase-prompt-sent. `mergeWorktreeIntoParent` runs `git merge --no-ff --no-edit` with safety checks.
- **src/attachments.js** — `saveAttachment(project, worktreeName, {name, dataBase64})` → central-store path + abs `promptPath`. `isImageType()` classifies for image vs path-reference text blocks.
- **src/transcribe.js** — `isAvailable()` (both binaries on disk?) and `transcribe(audioBuf)`. Spawns `ffmpeg -ac 1 -ar 16000 -f wav` → `whisper-cli -m <model> -f <wav> -of <prefix> --output-txt --no-prints`, reads the `.txt` sidecar, removes the tmpdir. Active-model resolution: `WHISPER_MODEL` env (explicit path) → the model chosen in Settings (`settings.json`) → built-in default. Install root from `INSTALL_ROOT` (defaults to the central store `<projectsRoot>/.code-conductor/`), mirroring `bin/install-whisper.sh`; binary from `WHISPER_CLI`, ffmpeg from `FFMPEG_BIN`.
- **src/appSettings.js** — read/write `<store>/settings.json` (cached, atomic writes). `getTranscribeModel()` / `setTranscribeModel(name)`, `getModelVersion(family)` / `setModelVersion(family, id)`; namespaced (`transcribe`, `models`) for future groups.
- **src/whisperModels.js** — curated model catalog (`WHISPER_MODELS`, `DEFAULT_MODEL`), single source of truth for the picker + the install/switch allow-list (`isKnownModel`, `modelFileName`).
- **src/modelVersions.js** — curated per-family Claude model-version catalog (`MODEL_FAMILIES` sonnet/opus/haiku, `DEFAULT_VERSIONS`), single source of truth for the Settings → Models picker + the switch allow-list (`isKnownFamily`, `isKnownVersion`, `defaultVersion`). Also owns context-window policy: `familyOf(id)` + `canonicalizeModel(id)` pin each family to its one fixed window (Sonnet → `[1m]`, Opus/Haiku bare), applied server-side at spawn/resume; `public/models.js` mirrors it client-side.
- **src/whisperInstall.js** — process-wide install runner singleton over `bin/install-whisper.sh` (`start`/`status`/`isRunning`); bounded in-memory log, sets the active model on clean exit. Script path overridable via `WHISPER_INSTALL_SCRIPT` (test injection).
- **src/tts.js** — `isAvailable()` (piper venv python + active voice `.onnx`/`.onnx.json` on disk?) and `synthesize(text, {voice, rate})`. Spawns the venv python running `bin/piper-synth.py` (overridable via `PIPER_SYNTH_SCRIPT`), which loads the voice once and streams one self-contained WAV per sentence (`[4-byte LE length][WAV]` framing) to stdout — returned as a child process so the route pipes it straight to the HTTP response. Voice resolution: `PIPER_VOICE` env → Settings choice (`settings.json`) → built-in default; python from `PIPER_PYTHON`/`PIPER_VENV`; install root from `INSTALL_ROOT` (defaults to the central store `<projectsRoot>/.code-conductor/`). `rate` maps to Piper's `length_scale` (inverse of speed).
- **bin/piper-synth.py** — the streaming synthesizer `tts.js` drives: reads text on stdin, iterates `PiperVoice.synthesize()` (one `AudioChunk` per sentence), wraps each chunk's PCM in a WAV via the stdlib `wave` module, and writes length-prefixed frames to stdout, flushing per sentence.
- **src/ttsModels.js** — curated Piper voice catalog (`TTS_VOICES`, `DEFAULT_VOICE`), single source of truth for the picker + the install/switch allow-list (`isKnownVoice`, `voiceFileName`). Each entry carries its HF `rhasspy/piper-voices` subdir so the installer needn't parse names.
- **src/ttsInstall.js** — process-wide install runner singleton over `bin/install-piper.sh` (`start`/`status`/`isRunning`); bounded in-memory log, sets the active voice on clean exit. Script path overridable via `PIPER_INSTALL_SCRIPT` (test injection).
- **src/wsHub.js** — Per-socket subscriptions, snapshot replay, fan-out, `prompt/mode/interrupt/kill/hook_decision/auto_approve_plan` over WS, `turn_notification` broadcast to all clients.
- **src/mcp/** — `server.js` (JSON-RPC 2.0 over Streamable HTTP), `tools.js` (static registry), `handlers.js` (thin shells over InstanceManager + projects + worktrees).
- **public/** — `index.html`, `styles.css`, `app.js` (bootstrap + reactive store + WS wiring), `ws.js` (reconnecting + ack-based), `sidebar.js` (Project ▸ Sessions ▸ Worktrees subnodes), `conversation.js` (sticky-scroll, idempotent by `_seq`, routes by `parentToolUseId`), `blocks.js` (per-tool summaries + body renderers), `diff.js` (Myers' line-diff), `markdown.js` (safe Markdown → DOM, `textContent` only), `settings.js` (full-page `#settings` view + Transcribe & Models groups), `models.js` (per-family model-version cache + `resolveSpawnModel(family, ctx)` the three spawn pickers call), `tts.js` (Piper playback: POSTs `/api/tts`, decodes the framed-WAV stream via Web Audio, schedules sentences gaplessly; holds availability/enabled/rate + first-gesture state), `notifications.js`, `tasks.js`, `usage.js`, `anchor.js`, `composer.js`, `sw.js`.
- **tests/** — `node:test` suite (see Testing below).
- **debug/** — Opt-in Playwright + Termux-Chromium harness (sibling-repo dep).
- **migrations/** — Idempotent on-disk migrations; see "Migrations" below.

### WebSocket protocol

**Client → server:**
| `t` | Fields |
|---|---|
| `subscribe` | `id`, optional `reqId` (triggers `snapshot` + live `event`s) |
| `unsubscribe` | `id` |
| `prompt` | `id`, `text`, optional `attachments` (`[{name, mediaType, dataBase64}]`) |
| `mode` | `id`, `mode` (`plan` / `ask` / `bypassPermissions`; `ask` → CLI `bypassPermissions`) |
| `interrupt` | `id` |
| `kill` | `id` |
| `hook_decision` | `id`, `toolUseId`, `allow` (resolves ask-mode hook with original `tool_use_id`) |
| `auto_approve_plan` | `id`, `enabled` (server-side flag; while on, an incoming `plan_request` in plan mode auto-fires `setMode(bypassPermissions)` + the approval prompt) |

**Server → client:**
| `t` | Fields |
|---|---|
| `snapshot` | `id`, `status`, `mode`, `sessionId`, `project`, `autoApprovePlan`, `events[]` |
| `reset_snapshot` | Same shape; sent after rewind so subscribers clear DOM first |
| `event` | `id`, `ev` (monotonic `_seq` for idempotent merge) |
| `status` | `id`, `status` (`spawning|idle|turn|exited|crashed`), `sessionId`, `mode`, `autoApprovePlan` |
| `ack` | `reqId`, `ok`, `error?` |
| `hello` | sent on connect |
| `error` | `message` (server-side parse rejection; not tied to a `reqId`) |
| `turn_notification` | `id`, `project`, `isError`, `stopReason`, `cost` — **broadcast to all clients** (not just per-instance subscribers) so background tabs can ping OS notifications |
| `instances` / `projects` | Hints to re-fetch (no payload); broadcast on every instance create/remove/status flip — `projects` covers the case where a CLI just flushed a session jsonl |

**UI event kinds (`ev.kind`):** `text_delta`, `text_end`, `thinking_start/delta/end/redacted`, `tool_use_start/input_delta/use`, `tool_result`, `user_echo`, `system` (subtypes incl. `init`, `history_replayed`), `hook`, `turn_end`, `assistant_message`, `control_response`, `user_question` (`toolUseId`, `questions[]`), `plan_request` (`toolUseId`, `plan`, `planPath`, optional `autoApproved`), `permission_request` (`toolUseId`, `toolName`, `toolInput`), `permission_resolved` (`toolUseId`, `allow`), `raw`. Each carries `parentToolUseId` (or `null`) — non-null routes into a nested sub-Conversation.

### REST endpoints
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List with workspace, git status, sessions, worktrees. |
| `POST` | `/api/projects` | Create (validates `^[a-zA-Z0-9._-]+$`, seeds `CLAUDE.md`). |
| `DELETE` | `/api/projects/:name` | Cascade: kill instances → remove worktrees → `rm -rf`. Sessions persist under `~/.claude/projects/`. |
| `PUT` | `/api/projects/:name/workspace` | `{workspace}` — assigns/clears; auto-registers new names. |
| `GET` | `/api/workspaces` | Union of registry + referenced names. |
| `POST` | `/api/workspaces` | `{name}` — 201 new / 200 idempotent. Same regex. |
| `PUT` | `/api/workspaces/:name` | `{name: newName}` — atomic rename across all members. |
| `DELETE` | `/api/workspaces/:name` | Removes the entry **and** clears `workspace` on every member (projects stay). |
| `GET` | `/api/projects/:name/sessions` | Session metadata list. |
| `GET` | `/api/sessions/:sid/locate` | `{project, worktreeName}`; drives anchor auto-resume. 404 if not found. |
| `PUT` | `/api/sessions/:sid/title` | `{title}` — set custom session label (≤100 chars; empty/whitespace clears). Returns `{ok, sessionId, title, maxLength}`. Broadcasts `projects` hint + pushes updated summary to any live instance with this `sessionId`. |
| `POST` | `/api/instances` | Spawn. Returns summary. |
| `GET` | `/api/instances` | List live. |
| `POST` | `/api/instances/:id/respawn` | Uses `--resume lastSessionId`. |
| `POST` | `/api/instances/:id/rewind` | `{userMessageIndex}` — atomic truncate + respawn (same `sessionId`). 409 during turn, 400 on temp / out-of-range. Returns `droppedText`. |
| `POST` | `/api/instances/:id/fork` | `{userMessageIndex}` — copies prefix to new `sessionId`, original is byte-identical, spawns fresh instance. 400 on temp / OOR. |
| `DELETE` | `/api/instances/:id` | SIGTERM + remove. |
| `POST` | `/api/instances/:id/promote` | Promote a live temp session to a normal one: flips `instance.temp = false`, writes `last-prompt` + `permission-mode` so `claude --resume`'s picker can find it, emits `status` so the sidebar moves the row above the `— temp —` separator. 400 if not temp, 404 unknown id. |
| `POST` | `/api/instances/:id/debug` | Flip debug capture **ON** for a running instance (idempotent — `alreadyOn:true`). **No "off" endpoint** — kill the instance to stop. |
| `POST` | `/api/instances/:id/sync` | Returns `action: already-in-sync | fast-forwarded | rebase-prompt-sent`. FF runs server-side; rebase sends templated prompt to the live agent. 400 if no worktree; `ok:false, reason:"…not running…"` if instance is dead. |
| `POST` | `/api/instances/:id/merge` | Parent-side merge. Refusals return 200 with `ok:false, reason` so the UI can render inline. |
| `GET` | `/api/projects/:name/worktrees` | List with metadata. |
| `GET` | `/api/projects/:name/worktrees/:wt/sessions` | Worktree-scoped session list. |
| `DELETE` | `/api/projects/:name/worktrees/:wt[?force=1]` | 409 on live instance / dirt; `force=1` kills + ignores. |
| `DELETE` | `/api/projects/:name/sessions/:sid[?force=1]` | Delete persisted jsonl; 409 if attached. |
| `DELETE` | `/api/projects/:name/worktrees/:wt/sessions/:sid[?force=1]` | Same, worktree-scoped. |
| `GET` | `/api/instances/:id/attachments/:filename` | Streams from the central-store attachments dir (path-traversal guarded). |
| `POST` | `/api/instances/:id/hook-callback` | PreToolUse http hook target; always 200 with `permissionDecision`. |
| `POST` | `/api/admin/restart` | Self-respawn (202 immediate, detached child, exit). |
| `GET` | `/api/transcribe/status` | `{available: boolean}` — true when both `WHISPER_CLI` and `WHISPER_MODEL` exist on disk. Drives the composer's mic-button visibility. |
| `POST` | `/api/transcribe` | Body: raw audio bytes (any `audio/*` content-type, ≤ 25 MB). Returns `{text}`. 400 on empty body, 503 when whisper isn't installed. Route-scoped `express.raw` parser so the global 1 MB JSON limit doesn't apply. |
| `GET` | `/api/settings/transcribe` | `{available, activeModel, models:[{name,label,sizeLabel,installed}], install}` — curated whisper model catalog + per-model on-disk state + active model + install status. |
| `POST` | `/api/settings/transcribe/model` | `{model}` — set the active model. 400 if unknown or not installed. Returns the refreshed state. Persisted to `settings.json`; effective immediately. |
| `POST` | `/api/settings/transcribe/install` | `{model}` — start `bin/install-whisper.sh` for that model (one at a time). 200 `{started}`, 409 `{running}` if busy, 400 on unknown model. On clean exit the model is set active. |
| `GET` | `/api/settings/transcribe/install/status` | `{running, model, exitCode, log}` — polled by the Settings page to stream install progress. |
| `GET` | `/api/settings/models` | `{families:[{family,label,default,versions:[{id,label}]}], active:{sonnet,opus,haiku}}` — curated per-family version catalog + active version per family (catalog default when unset). |
| `POST` | `/api/settings/models` | `{family, version}` — set a family's active version. 400 if unknown family or version not in that family's catalog. Returns refreshed state. Persisted to `settings.json`; effective immediately. |
| `GET` | `/api/tts/status` | `{available: boolean}` — true when the piper venv python + the active voice's `.onnx`/`.onnx.json` exist on disk. Drives the conversation's 🔊-button visibility. |
| `POST` | `/api/tts` | Body: raw assistant text (`text/*`, route-scoped `express.text`, ≤ 256 KB). Streams `application/octet-stream` = a sequence of `[4-byte LE length][WAV]` frames, one per sentence, flushed as Piper synthesizes. 400 on empty body, 503 when piper isn't installed. Killing the response (client disconnect) stops synthesis. |
| `GET` | `/api/settings/tts` | `{available, activeVoice, voices:[{name,label,sizeLabel,hfDir,installed}], install, enabled, rate}` — curated Piper voice catalog + per-voice on-disk state + active voice + auto-speak/rate prefs + install status. |
| `POST` | `/api/settings/tts/voice` | `{voice}` — set the active voice. 400 if unknown or not installed. Returns refreshed state. Persisted to `settings.json`; effective immediately. |
| `POST` | `/api/settings/tts/prefs` | `{enabled?, rate?}` — persist the auto-speak toggle and/or playback rate (rate clamped 0.5–2.0). Returns refreshed state. |
| `POST` | `/api/settings/tts/install` | `{voice}` — start `bin/install-piper.sh` for that voice (one at a time). 200 `{started}`, 409 `{running}` if busy, 400 on unknown voice. On clean exit the voice is set active. |
| `GET` | `/api/settings/tts/install/status` | `{running, voice, exitCode, log}` — polled by the Settings page to stream install progress. |

### Instance lifecycle
```
create → spawning → idle ←─ turn ─→ turn_end ─┐
            ↓        ↓                          ↓
        load-hist  prompt                  exited / crashed
        fails                                   │
                                                ▼ respawn --resume <sid>
                                            (back to spawning)
```

On **resume**: `loadHistory(sessionId)` runs before flipping to `idle` — replays jsonl into UI events and emits a `system/history_replayed` divider. On **turn end** or **mode change**: append `{"type":"last-prompt", …}` + `{"type":"permission-mode", …}` lines so `claude --resume`'s interactive picker can discover the session.

### Defaults
- **Projects root**: parent directory of the code-conductor repo (resolved from `import.meta.url` at module load — typically `~/cc-projects/` if you cloned into the conventional location). Override with `PROJECTS_ROOT=<abs-path>`. The whole orchestrator (project list, central store at `<root>/.code-conductor/`, the hidden `.conduct` project) lives under this dir; `~/project/` is the docs shorthand for it.
- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT`).
- New instance: `plan` mode, `high` effort, `adaptive` thinking, no model flag. Temp checkbox flips mode default to `bypassPermissions`.
- Sidebar one-click resume: `bypassPermissions` mode (continuing real work), same effort/thinking defaults. Crash-respawn preserves whatever mode was running.
- Resume without an explicit `model` recovers the model the session was last run with by reading the most-recent `assistant.message.model` from the jsonl — otherwise `claude --resume` falls back to the account default (often Opus) and silently flips a Sonnet/Haiku session. The recovered (bare) id is run through `canonicalizeModel` so the family's fixed window is re-applied (Sonnet → `[1m]`); the window is never persisted, and nothing of ours is written into Claude's jsonl for it. Explicit `model` on the POST still wins (also canonicalized).
- Ring buffer: 500 events / instance.
- Control-request timeout: 5 s. Kill grace: stdin closed → 2 s → SIGTERM → 5 s → SIGKILL.

### On-disk state
All orchestrator-owned state in a single workspace-wide dotfolder at `~/project/.code-conductor/`:
```
~/project/                                  # projectsRoot()
├── .code-conductor/                        # central store
│   ├── workspaces.json                     # registry of known workspace names
│   ├── session-titles.json                 # {sessionId: customLabel} sidecar
│   ├── settings.json                        # app settings, e.g. {transcribe:{model}, models:{sonnet,opus,haiku}, tts:{enabled,voice,rate}}
│   ├── whisper.cpp/                          # voice-dictation build + models (optional, INSTALL_ROOT)
│   ├── piper/                                # TTS venv + voices (optional, INSTALL_ROOT)
│   └── projects/<project>/
│       ├── project.json                    # {workspace: "<name>"}
│       ├── attachments/<timestamp>-<name>
│       ├── debug/<instance-id>/            # raw CLI capture
│       └── worktrees/<project>_worktree_<id>/
│           ├── worktree.json               # {baseBranch, baseSha, branch, parentPath, …}
│           ├── attachments/
│           └── debug/<instance-id>/
├── <project>/                              # normal project — nothing of ours inside
└── <project>_worktree_<id>/                # worktree dir — nothing of ours inside
```
Project + worktree dirs stay clean — no per-project `.gitignore` plumbing needed.

### Migrations
`migrations/` holds idempotent migration scripts run automatically on boot (entrypoint `migrations/index.mjs`). Each self-checks "already applied?" and is a fast no-op in steady state; a script that throws **aborts the boot**. See [`migrations/migrations.md`](./migrations/migrations.md) for the listing and conventions for adding new ones.

### Testing
All tests via `node tests/run.mjs` (programmatic node:test runner — Termux's glibc-runner wrapper hoists leading `--flags` into `NODE_OPTIONS` and refuses `--test`).

Test **files run in parallel** (node:test `isolation:'process'` — one child process per file). The suite is isolation-safe: `bootServer` binds an ephemeral port (`listen(0)`) and `mkdtemp`s a unique home per server, so files never contend over ports or paths. Concurrency defaults to `min(4, cores/2)` — capped low on purpose because each file boots its own express+ws and spawns fake-claude subprocesses, so oversubscribing (e.g. one runner per core) is *slower* and risks tripping the timing-sensitive waits (control-request 5s, `waitFor` 4s). Override with `TEST_CONCURRENCY=<n>` (`1` = fully serial). Measured ~79s serial → ~29s at the default on an 8-core device.

Default suite uses **fake-claude** (`tests/fake-claude.mjs`) via `CLAUDE_BIN`: silent until first stdin message, auto-acks `control_request`s, emits canned events from `FAKE_CLAUDE_SCENARIO`, matches `control_response`s so scenarios can branch on allow/deny. `FAKE_CLAUDE_ARGV_DUMP=<path>` captures launch argv.

Opt-in real-claude smoke (`smoke.real.test.mjs`, `RUN_REAL_CLAUDE=1`): spawns the actual CLI, asserts `system/init` + ≥1 `text_delta` + non-error `turn_end`. Cleans the session jsonl on exit.

## Known limitations
- **Opus 4.7/4.8 thinking is redacted** — no readable content (4.7 sends only `signature_delta`; 4.8 sends empty `thinking_delta`s). Both render as `thinking (redacted)`. Pick `claude-sonnet-4-6` for the full stream.
- **AskUserQuestion answered via next prompt** — PreToolUse hook denies; tool_result is `is_error:true`; answer is fed in as a normal user prompt. Functionally fine, but the original tool_result is still an error for diagnostics.
- **`--effort` / `--thinking` are spawn-time only** — switching mid-session needs respawn + resume. Only `mode` is live-switchable.
- **No auth** — bound to 127.0.0.1; anyone with shell access can drive it.
- **Best-effort metadata writes** — crash between turn-end and metadata append may omit the `last-prompt` line and hide the session from `claude --resume`'s picker. Transcript itself is intact.
- **Claude-spawning-Claude recursion** — auto-registered MCP lets any session call `spawn_instance`; children inherit the auto-registration, no depth guard. Mitigations: (1) `ORCH_DISABLE_MCP_AUTOREGISTER=1`, (2) keep child default mode `plan`, (3) observe each worker step before it proceeds — via `wait:true` or (preferred, per `CONDUCT.md`) `wait:false` + `subscribe_to_idle`.
- **Notifications need permission** — desktop browsers need API grant; mobile Chrome needs the Service Worker; iOS Safari needs PWA install.
