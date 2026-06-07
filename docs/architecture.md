> See also: [README](../README.md)

## Stack
- Node 22+ (`node:test`, top-level await, `crypto.randomUUID`).
- `express` (REST + static) + `ws` (WebSocket).
- Vanilla HTML/CSS/JS in `public/`, no build step.
- `happy-dom` (dev-only) for DOM-backed rendering tests.
- No DB — projects in `~/project/`, sessions in `~/.claude/projects/<encoded-cwd>/*.jsonl`.

## Component layout
- **server.js** — Express + ws boot, mounts routes, binds `127.0.0.1:8787`. Sets `process.title = 'code-conductor'` on entry so `pkill -f code-conductor` targets it precisely and `pkill -f server.js` misses it. Launched via `conductor.sh` (`npm start`).
- **src/instances.js** — Instance class, InstanceManager, ring buffer (500 events), control_request round-trip, mode validation.
- **src/hookBroker.js** — Per-instance broker for the PreToolUse http hook, pending-response map keyed by `tool_use_id`, 540 s timeout.
- **src/settings.js** — Builds the inline `--settings` JSON. Pure values → JSON string; no Instance state.
- **src/transcript.js** — Replays `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` into UI-event shape on resume; best-effort `last-prompt`/`permission-mode` appends; exports `isPureUserPromptLine`.
- **src/sessionEdit.js** — Atomic destructive jsonl edits: `truncateSessionAtUserMessage` (tmp → fsync → rename, appends fresh metadata at the new leaf), `forkSessionAtUserMessage` (copies prefix into a new `<sid>.jsonl` with `sessionId` rewritten on every line). Both return `droppedText` for composer prefill.
- **src/parser.js** — stream-json line → UI event normalization. Delta merging by `(msgId, blockIdx)`, `thinking_redacted` emission, `parentToolUseId` routing, structured `user_question` / `plan_request` events.
- **src/projects.js** — FS ops on `~/project/`, cwd encoding for `~/.claude/projects/`, CLAUDE.md seeding.
- **src/conductedSessions.js** — sidecar store (`<store>/conducted-sessions.json`) of sessionIds spawned via MCP `spawn_instance` (the worker agents an orchestrator conducts). `loadAll()`/`isConducted(sid)`/`markConducted(sid)`/`unmarkConducted(sid)`, atomic write + serialised write-chain, mirroring `sessionTitles.js`. The durable half of the conducted axis.
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
- **src/rootClaudeMd.js** — owner of the projects-root `CLAUDE.md`. Bundles the canonical text (`assets/cc-projects-CLAUDE.md`), persists a `baseline` (last-applied canonical) in the central store, and runs a sha256 three-way reconcile on boot (`create` / `up-to-date` / `silent-update` / `keep` / `conflict`) mirroring TCC's `scripts/lib.sh::sync_workspace_claudemd`. Exports `classify` (pure), `seedBaselineIfNeeded` (migrates the legacy TCC baseline `~/.cache/code-conductor-bootstrap/CLAUDE.md.installed` when present, else seeds from vendor), `reconcile`, `getStatus`, `getDiff` (in-module LCS unified diff — no shelling), `resolve(keep|overwrite)`. Path overrides: `CC_VENDOR_CLAUDEMD` (vendor fixture), `TCC_LEGACY_BASELINE` (legacy baseline) — both test injection.
- **src/wsHub.js** — Per-socket subscriptions, snapshot replay, fan-out, `prompt/mode/interrupt/kill/hook_decision/auto_approve_plan` over WS, `turn_notification` broadcast to all clients.
- **src/mcp/** — `server.js` (JSON-RPC 2.0 over Streamable HTTP), `tools.js` (static registry), `handlers.js` (thin shells over InstanceManager + projects + worktrees).
- **public/** — `index.html`, `styles.css`, `app.js` (bootstrap + reactive store + WS wiring), `ws.js` (reconnecting + ack-based), `sidebar.js` (Project ▸ Sessions ▸ Worktrees subnodes), `conversation.js` (sticky-scroll, idempotent by `_seq`, routes by `parentToolUseId`), `blocks.js` (per-tool summaries + body renderers), `diff.js` (Myers' line-diff), `markdown.js` (safe Markdown → DOM, `textContent` only), `settings.js` (full-page `#settings` view + Transcribe & Models groups), `models.js` (per-family model-version cache + `resolveSpawnModel(family, ctx)` the three spawn pickers call), `tts.js` (Piper playback: POSTs `/api/tts`, decodes the framed-WAV stream via Web Audio, schedules sentences gaplessly; holds availability/enabled/rate + first-gesture state), `notifications.js`, `tasks.js`, `usage.js`, `anchor.js`, `composer.js`, `sw.js`.
- **tests/** — `node:test` suite (see Testing below).
- **debug/** — Opt-in Playwright + Termux-Chromium harness (sibling-repo dep).
- **migrations/** — Idempotent on-disk migrations; see "Migrations" below.

## Instance lifecycle
```
create → spawning → idle ←─ turn ─→ turn_end ─┐
            ↓        ↓                          ↓
        load-hist  prompt                  exited / crashed
        fails                                   │
                                                ▼ respawn --resume <sid>
                                            (back to spawning)
```

On **resume**: `loadHistory(sessionId)` runs before flipping to `idle` — replays jsonl into UI events and emits a `system/history_replayed` divider. On **turn end** or **mode change**: append `{"type":"last-prompt", …}` + `{"type":"permission-mode", …}` lines so `claude --resume`'s interactive picker can discover the session.

## On-disk state
All orchestrator-owned state in a single workspace-wide dotfolder at `~/project/.code-conductor/`:
```
~/project/                                  # projectsRoot()
├── .code-conductor/                        # central store
│   ├── workspaces.json                     # registry of known workspace names
│   ├── session-titles.json                 # {sessionId: customLabel} sidecar
│   ├── conducted-sessions.json             # {sessions:[sid,…]} — durable conducted-session markers
│   ├── settings.json                        # app settings, e.g. {transcribe:{model}, models:{sonnet,opus,haiku}, tts:{enabled,voice,rate}}
│   ├── workspace-claudemd/                   # root CLAUDE.md ownership
│   │   ├── baseline.md                       # last-applied canonical (drives the reconcile)
│   │   └── state.json                        # {outcome, at} from the last reconcile/resolve
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

## Migrations
`migrations/` holds idempotent migration scripts run automatically on boot (entrypoint `migrations/index.mjs`). Each self-checks "already applied?" and is a fast no-op in steady state; a script that throws **aborts the boot**. See [`migrations/migrations.md`](../migrations/migrations.md) for the listing and conventions for adding new ones.

## Testing
All tests via `node tests/run.mjs` (programmatic node:test runner — Termux's glibc-runner wrapper hoists leading `--flags` into `NODE_OPTIONS` and refuses `--test`).

Test **files run in parallel** (node:test `isolation:'process'` — one child process per file). The suite is isolation-safe: `bootServer` binds an ephemeral port (`listen(0)`) and `mkdtemp`s a unique home per server, so files never contend over ports or paths. Concurrency defaults to `min(4, cores/2)` — capped low on purpose because each file boots its own express+ws and spawns fake-claude subprocesses, so oversubscribing (e.g. one runner per core) is *slower* and risks tripping the timing-sensitive waits (control-request 5s, `waitFor` 4s). Override with `TEST_CONCURRENCY=<n>` (`1` = fully serial). Measured ~79s serial → ~29s at the default on an 8-core device.

Default suite uses **fake-claude** (`tests/fake-claude.mjs`) via `CLAUDE_BIN`: silent until first stdin message, auto-acks `control_request`s, emits canned events from `FAKE_CLAUDE_SCENARIO`, matches `control_response`s so scenarios can branch on allow/deny. `FAKE_CLAUDE_ARGV_DUMP=<path>` captures launch argv.

Opt-in real-claude smoke (`smoke.real.test.mjs`, `RUN_REAL_CLAUDE=1`): spawns the actual CLI, asserts `system/init` + ≥1 `text_delta` + non-error `turn_end`. Cleans the session jsonl on exit.
