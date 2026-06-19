> See also: [README](../README.md)

## Stack
- Node 22+ (`node:test`, top-level await, `crypto.randomUUID`).
- `express` (REST + static) + `ws` (WebSocket).
- Vanilla HTML/CSS/JS in `public/`, no build step.
- `happy-dom` (dev-only) for DOM-backed rendering tests.
- No DB — projects in `~/project/`, sessions in `~/.claude/projects/<encoded-cwd>/*.jsonl`.

## Component layout
- **server.js** — Express + ws boot, mounts routes, binds `127.0.0.1:8787`. Sets `process.title = 'code-conductor'` on entry so `pkill -f code-conductor` targets it precisely and `pkill -f server.js` misses it. Launched via `conductor.sh` (`npm start`).
- **src/instances.js** — Instance class, InstanceManager, capped event ring (`EventLog`: drop-oldest at `ORCH_EVENT_RING_CAP`, default 2000; `_seq` stamped at push and never renumbered; `trimmedBefore` = first retained `_seq`; trim snaps the surviving head to an outer `user_echo` turn boundary; `snapshotTail()` serves the ≤`ORCH_SNAPSHOT_TAIL` (default 500) trailing slice for WS subscribe), absolute `userIndex` stamping on outer user_echoes (the rewind/fork anchor — immune to trimming), control_request round-trip, mode validation.
- **src/idleSubscriptions.js** — `IdleSubscriptionHub`, the idle-subscription graph extracted from `InstanceManager` as a composed collaborator (`subscribe`/`unsubscribe`/`onTurnEnd`/`deliver`/`purge`/`snapshot`/`hasSubscriber`/`isCaller`). Owns the `targetSessionId → Map<callerSessionId,{timerId}>` map; one-shot consume-on-fire + optional `timeoutMs` watchdog + the `turn_end` wake-stub text. Cross-instance lookups (`idsForSession`/`byId`/`liveForSession`) + `subscription_changed` emission route back through the manager. The manager keeps delegating `subscribeIdle`/`unsubscribeIdle`/`hasIdleSubscriber`/`isIdleCaller`/`_purgeIdleFor`/`_deliverIdleCallback`/`_idleSubscriberSnapshot` methods + a live-map `_idleSubscribers` getter.
- **src/overageResume.js** — `OverageResumeController`, the overage auto-resume timer machine extracted from `InstanceManager` as a composed collaborator (`arm`/`run`/`fireNow`/`cancel`/`clearAll`). Owns the `sessionId → Timeout` map and `AUTO_RESUME_TEXT` (re-exported from `instances.js` for back-compat); the per-Instance overage flags (`autoResumeAt`/`autoStoppedForOverage`/`_overageHandled`/`_overageResetsAt`) stay on the Instance. `resetsAt`-based scheduling, in-memory only, `auto_resume_skipped` logging, never kills/respawns. The manager keeps delegating `_armAutoResume`/`_runAutoResume`/`_fireAutoResumeNow`/`_cancelAutoResume` methods + a live-map `_autoResumeTimers` getter.

  Backend collaborator topology (composition + the one shared service layer):
  ```
  InstanceManager
    ├─ composes  IdleSubscriptionHub       (idleSubscriptions.js)
    └─ composes  OverageResumeController    (overageResume.js)

  worktrees.js   runGit · getWorktreeDiff · sync/merge · assertValidBaseRef · commits
    ├─ used by   routes.js          (REST surface)
    └─ used by   mcp/handlers.js     (MCP surface)
                   └─ large-output shaping → mcp/{content, diffPaging, messageReconstruction}.js
  ```
- **src/hookBroker.js** — Per-instance broker for the PreToolUse http hook, pending-response map keyed by `tool_use_id`, 540 s timeout.
- **src/settings.js** — Builds the inline `--settings` JSON. Pure values → JSON string; no Instance state.
- **src/transcript.js** — Replays `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` into UI-event shape on resume; best-effort `last-prompt`/`permission-mode` appends; exports `isPureUserPromptLine`.
- **src/eventArchive.js** — `pageInstanceEvents(inst, {before|after, limit})` behind `GET /api/instances/:id/events`: retained events come from the ring; evicted ones are reconstructed by replaying the jsonl (`loadPersistedTranscript`) into a dense archive seq space (0..H-1, clamped strictly below `trimmedBefore`), cut at the ring head's stamped `userIndex` so ring + archive never overlap (mid-turn head ⇒ gap, never duplication). Backward pages return an opaque `nextBefore` cursor that jumps the numeric gap between the two seq spaces; window starts snap to turn boundaries.
- **src/sessionEdit.js** — Atomic destructive jsonl edits: `truncateSessionAtUserMessage` (tmp → fsync → rename, appends fresh metadata at the new leaf), `forkSessionAtUserMessage` (copies prefix into a new `<sid>.jsonl` with `sessionId` rewritten on every line). Both return `droppedText` for composer prefill.
- **src/parser.js** — stream-json line → UI event normalization. Delta merging by `(msgId, blockIdx)`, `thinking_redacted` emission, `parentToolUseId` routing, structured `user_question` / `plan_request` events.
- **src/projects.js** — FS ops on `~/project/`, cwd encoding for `~/.claude/projects/`, CLAUDE.md seeding.
- **src/conductedSessions.js** — sidecar store (`<store>/conducted-sessions.json`) of sessionIds spawned via MCP `spawn_instance` (the worker agents an orchestrator conducts). `loadAll()`/`isConducted(sid)`/`markConducted(sid)`/`unmarkConducted(sid)`, atomic write + serialised write-chain, mirroring `sessionTitles.js`. The durable half of the conducted axis.
- **session sidecar stores** — sibling `<store>` JSON sidecars sharing the same atomic-write + advisory-lock shape as `conductedSessions.js`: `sessionTitles.js` (`{sessionId: customLabel}` — `getTitle`/`setTitle`/`deleteTitle`), `archivedSessions.js` (archived-sid set — `isArchived`/`markArchived`/`unmarkArchived`), `tempSessions.js` (durable temp-session markers that survive SIGKILL so a temp stays resumable across the resume-after-restart path). `storeLock.js` provides the cross-process advisory lock (`withLock()`, `O_EXCL` create + stale detection) they serialise on; `tempCleanup.js` writes/sweeps `<store>/pending-temp-cleanup.json` to GC temp jsonl orphaned after exit.
- **src/conduct.js** — `ensureConductProject()` lazy-creates `~/project/.conduct/` and seeds its `CLAUDE.md` with `@../CLAUDE.md` + absolute path to `CONDUCT.md` (resolved from `import.meta.url`). Idempotent; `wx` flag preserves user customisation.
- **src/planApproval.js** — `buildApprovePrompt(feedback)` / `buildRejectPrompt(feedback)`. Source-of-truth for the magic strings the UI's Approve & Implement / Reject buttons, the server-side auto-approve, and the MCP `approve_plan` / `reject_plan` tools all send to the worker.
- **src/routes.js** — Thin REST shell; hosts hook-callback, attachment streaming, `/admin/restart`, worktree sync/merge.
- **src/restart.js** — `scheduleRestart()`: close WSS + http, temp-wipe, spawn detached child with same argv/env/cwd, exit. Child's listen-with-retry handles `EADDRINUSE`. `spawnReplacementAndExit()` is the shared detached-spawn-then-exit tail (also used by the resume path).
- **src/resumeManifest.js** — read/write/clear the **Resume after restart** manifest at `<store>/pending-resume.json` (mirrors `tempCleanup.js`). `writeResumeManifest(entries)` (sync, mkdir's the store), `readResumeManifest()` → `{instances:[]}` (empty on absent/corrupt; removes a corrupt file), `clearResumeManifest()`.
- **src/resumeRestart.js** — the graceful resume path. `drainAndScheduleRestart()` (old process): wind down mid-turn instances (`Instance.windDown`), `waitAllIdle` with `RESUME_DRAIN_GRACE_MS`=60 s force-then-proceed, **then** tear down networking, `writeResumeManifest` (NO temp wipe), `shutdownForResumeSync`, `spawnReplacementAndExit`. Split out as `drainToManifest()` (steps 1–6, no exit) for testability. `restoreFromResumeManifest()` (new process, on boot): read+unlink manifest, three-group split (conductor / conducted worker / other), staggered `--resume` respawns (`RESUME_STAGGER_MS`=1.5 s), per-instance resume-notification prompt (conductor variant embeds the injected worker list via `buildConductorResumeText`). Owns all wind-down/resume message texts.
- **src/worktrees.js** — `createWorktree` captures `{baseBranch, baseSha, branch}` + writes `worktree.json` into the central store, then `git worktree add` off the captured SHA. `syncWorktree` picks no-op / FF / rebase-prompt-sent. `mergeWorktreeIntoParent` runs `git merge --no-ff --no-edit` with safety checks. Also the diff/history surface: `parseUnifiedDiff` (private, raw `git diff/show` → per-file structured hunks, 200 KB `DIFF_BYTE_CAP`), `getWorktreeDiff` (`<base>...HEAD`), `getProjectCommits` (`git log` on HEAD, default 100 / max 500), and `getCommitDiff` (`git show <sha>` — sha guarded `^[0-9a-fA-F]{4,40}$`, same response shape as `getWorktreeDiff` so the client renderer is shared).
- **src/attachments.js** — `saveAttachment(project, worktreeName, {name, dataBase64})` → central-store path + abs `promptPath`. `isImageType()` classifies for image vs path-reference text blocks.
- **src/transcribe.js** — `isAvailable()` (both binaries on disk?) and `transcribe(audioBuf)`. Spawns `ffmpeg -ac 1 -ar 16000 -f wav` → `whisper-cli -m <model> -f <wav> -of <prefix> --output-txt --no-prints`, reads the `.txt` sidecar, removes the tmpdir. Active-model resolution: `WHISPER_MODEL` env (explicit path) → the model chosen in Settings (`settings.json`) → built-in default. Install root from `INSTALL_ROOT` (defaults to the central store `<projectsRoot>/.code-conductor/`), mirroring `bin/install-whisper.sh`; binary from `WHISPER_CLI`, ffmpeg from `FFMPEG_BIN`.
- **src/appSettings.js** — read/write `<store>/settings.json` (cached, atomic writes). `getTranscribeModel()` / `setTranscribeModel(name)`, `getModelVersion(family)` / `setModelVersion(family, id)`; namespaced (`transcribe`, `models`) for future groups.
- **src/whisperModels.js** — curated model catalog (`WHISPER_MODELS`, `DEFAULT_MODEL`), single source of truth for the picker + the install/switch allow-list (`isKnownModel`, `modelFileName`).
- **src/modelVersions.js** — curated per-family Claude model-version catalog (`MODEL_FAMILIES` fable/opus/sonnet/haiku, `DEFAULT_VERSIONS`), single source of truth for the Settings → Models picker + the switch allow-list (`isKnownFamily`, `isKnownVersion`, `defaultVersion`). Also owns context-window policy: `familyOf(id)` + `canonicalizeModel(id)` pin each family to its one fixed window (Sonnet → `[1m]`; Fable 5/Opus/Haiku bare), applied server-side at spawn/resume; `public/models.js` mirrors it client-side.
- **src/installRunner.js** — `makeInstallRunner(config)`, the shared factory behind `whisperInstall.js` + `ttsInstall.js`. Owns all the install-runner mechanics once: a process-wide single-run lock, a bounded in-memory log ring for progress polling, and persist-the-active-item on clean exit (`code 0`). Per-feature differences (script path + env var, allow-list `validate`, `persist` setter, nouns) are injected as config; returns the `{start, status, isRunning, _reset}` surface both modules re-export.
- **src/whisperInstall.js** — whisper-specific config + re-exports over `installRunner.js` (`bin/install-whisper.sh`, `WHISPER_INSTALL_SCRIPT` override, `isKnownModel` allow-list, `setTranscribeModel` persist). Sets the active model on clean exit.
- **src/tts.js** — `isAvailable()` (piper venv python + active voice `.onnx`/`.onnx.json` on disk?) and `synthesize(text, {voice, rate})`. Spawns the venv python running `bin/piper-synth.py` (overridable via `PIPER_SYNTH_SCRIPT`), which loads the voice once and streams one self-contained WAV per sentence (`[4-byte LE length][WAV]` framing) to stdout — returned as a child process so the route pipes it straight to the HTTP response. Voice resolution: `PIPER_VOICE` env → Settings choice (`settings.json`) → built-in default; python from `PIPER_PYTHON`/`PIPER_VENV`; install root from `INSTALL_ROOT` (defaults to the central store `<projectsRoot>/.code-conductor/`). `rate` maps to Piper's `length_scale` (inverse of speed).
- **bin/piper-synth.py** — the streaming synthesizer `tts.js` drives: reads text on stdin, iterates `PiperVoice.synthesize()` (one `AudioChunk` per sentence), wraps each chunk's PCM in a WAV via the stdlib `wave` module, and writes length-prefixed frames to stdout, flushing per sentence.
- **src/ttsModels.js** — curated Piper voice catalog (`TTS_VOICES`, `DEFAULT_VOICE`), single source of truth for the picker + the install/switch allow-list (`isKnownVoice`, `voiceFileName`). Each entry carries its HF `rhasspy/piper-voices` subdir so the installer needn't parse names.
- **src/ttsInstall.js** — TTS-specific config + re-exports over `installRunner.js` (`bin/install-piper.sh`, `PIPER_INSTALL_SCRIPT` override, `isKnownVoice` allow-list, `setTtsVoice` persist). Sets the active voice on clean exit.
- **src/rootClaudeMd.js** — owner of the projects-root `CLAUDE.md`. Bundles the canonical text (`assets/cc-projects-CLAUDE.md`), persists a `baseline` (last-applied canonical) in the central store, and runs a sha256 three-way reconcile on boot (`create` / `up-to-date` / `silent-update` / `keep` / `conflict`) mirroring TCC's `scripts/lib.sh::sync_workspace_claudemd`. Exports `classify` (pure), `seedBaselineIfNeeded` (migrates the legacy TCC baseline `~/.cache/code-conductor-bootstrap/CLAUDE.md.installed` when present, else seeds from vendor), `reconcile`, `getStatus`, `getDiff` (in-module LCS unified diff — no shelling), `resolve(keep|overwrite)`. Path overrides: `CC_VENDOR_CLAUDEMD` (vendor fixture), `TCC_LEGACY_BASELINE` (legacy baseline) — both test injection.
- **src/wsHub.js** — Per-socket subscriptions, tail-only snapshot on subscribe (`snapshotTail()` + `tailStartSeq`/`trimmedBefore` frame metadata), fan-out, `prompt/mode/interrupt/kill/hook_decision/auto_approve_plan` over WS, `turn_notification` broadcast to all clients.
- **src/accountUsage.js** — `getAccountUsage()`: fetches account-level usage from the Anthropic OAuth endpoint (token read from `~/.claude/.credentials.json`), 60 s cache (10 s after a failed fetch), returns `null` on any error (never throws, never exposes the token). Backs `GET /api/usage`.
- **src/costTracking.js** — per-turn cost persistence. `initCostTracking(instances)` subscribes to instance events and appends one JSONL row per `turn_end` to `<store>/costs.jsonl` (append-only). `getCostSummary()` reads it back into the `{total_usd, row_count, by_project[], by_model[], daily_trend[]}` aggregate behind `GET /api/costs/summary`; `costsPath()` exposes the file path.
- **src/projectsCache.js** — short-TTL (default 2 s) cache of per-project git facts with in-flight coalescing, to cut the `GET /api/projects` fan-out load. `getOrCompute()`/`invalidate()`/`invalidateAll()`.
- **src/health.js** — boot readiness probe (`checkClaudeReadiness`/`formatReadiness`): `claude --version` (3 s timeout) + credential check; returns the framed warning banner server.js prints to stderr. Non-fatal.
- **src/mcp/** — `server.js` (JSON-RPC 2.0 over Streamable HTTP), `tools.js` (static registry), `handlers.js` (thin shells over InstanceManager + projects + worktrees — never duplicate business logic, never self-HTTP). The handler shell delegates its bulky-output shaping to three siblings so the documented MCP output shapes stay identical: `content.js` (`textPayload()` — builds the raw, un-escaped body blocks for text-payload tools), `diffPaging.js` (`parseNumstat`/`parseNameStatus`/`indexDiffLines`/`paginateDiff` — the pure `get_worktree_diff` byte-bounded pagination/summary engine), `messageReconstruction.js` (`reconstructMessages`/`mergeRecentWithDisk`/`capText`/`capBlockInput` + `MSG_TEXT_CAP` — `get_recent_messages` assembly and ring↔disk merge).
- **public/** — `index.html`, `styles.css`, and ~34 ES modules (no build step). `app.js` (975 lines) is **bootstrap + reactive `state` + wiring only**: it builds `state`/the DOM map, calls each module's `installX({…getters,…callbacks})` factory once, holds the returned handles, and wires the WS router **last**. Feature logic lives in the modules, which read live state through injected getters (`getActiveId: () => state.activeId`) rather than touching globals (see Conventions → frontend module pattern). Topology:
  ```
  app.js   bootstrap + reactive `state` + DOM map; wires everything, owns no feature logic
    │  installX({ getters, callbacks }) — each module installed once at init
    ├─ dialogs ......... newProjectDialog · workspaceDialog · spawnDialog
    ├─ flows/actions ... restartFlow · sessionActions · lazyHistory (controller)
    ├─ header .......... header (active-instance chips + usage popover)
    ├─ hash views ...... settings · review · commits · costs   (via hashView scaffold)
    └─ wsRouter ........ installed LAST; routes `bus` events into the modules below
         shared leaf modules (imported where needed, not app-wired):
         conversation · blocks · diff · markdown · models · usage · tts · tts-queue ·
         md-to-speech · sidebar · composer · tasks · subagents · notifications ·
         anchor · dismissable · lightbox · external-links · ws
  ```
  - **Wiring hub & WS** — `app.js`; `ws.js` (reconnecting + ack-based `bus`); `wsRouter.js` (`installWsRouter({…})` — the bus data/routing handlers `snapshot`/`reset_snapshot`/`event`/`turn_notification`/`status`/`instances`/`projects`, window `popstate`, and the first-connect anchor-restore/auto-resume; installed after `installRestart` so restart's `open` listener registers first).
  - **Dialogs** — `newProjectDialog.js` (`installNewProjectDialog` — name→path preview + create), `workspaceDialog.js` (`installWorkspaceDialog` → `{openNew, openEdit}`), `spawnDialog.js` (`installSpawnDialog` → `{openSpawnDialog,…}` — new-session + Conduct dialogs + the three model pickers).
  - **Flows & session actions** — `restartFlow.js` (`installRestart` — restart / Resume-after-restart flow + poll-and-reload), `sessionActions.js` (`installSessionActions` — promote / resume / rewind / fork / delete-session / delete-project / remove-worktree handlers + `consumePendingPrefill` composer prefill), `lazyHistory.js` (`installLazyHistoryController` — scroll-up `/events` paging via `renderEventBatch` through a fresh detached `Conversation` + `prependBatch` viewport-preserving splice).
  - **Active-instance header** — `header.js` (`installHeader({…}) → {update}` — chip row + primary controls + combined ctx/rate-limit chip and its usage popover).
  - **Hash-routed full-page views** — `hashView.js` (`installHashView` — hash-route + escape/teardown scaffold shared by the next four), `settings.js` (`#settings` — Transcribe / TTS / Models / Archived / Workspace-conventions groups), `review.js` (`#review` diff renderer, `open({title,url,onBack})` — shared by the worktree `±` and per-commit diffs), `commits.js` (`#commits` history list + client-side branch/merge graph; rows delegate to `review.open`), `costs.js` (`installCosts` — `#costs` cost dashboard; fetches `GET /api/costs/summary`).
  - **Conversation rendering** — `conversation.js` (sticky-scroll, idempotent by `_seq`, routes by `parentToolUseId`, rewind/fork anchored on server-stamped `userIndex`), `blocks.js` (per-tool summaries + body renderers), `diff.js` (Myers' line-diff), `markdown.js` (safe Markdown → DOM, `textContent` only), `lightbox.js` (`installLightbox` — tap-to-zoom image overlay), `subagents.js` (`SubagentPanel` — conductor sub-agent strip), `tasks.js` (`TaskTracker`/`TaskPanel`).
  - **Voice / TTS** — `tts.js` (Piper playback: POSTs `/api/tts`, decodes the framed-WAV stream via Web Audio, holds availability/enabled/rate + first-gesture state), `tts-queue.js` (`TtsQueue` — gapless per-sentence FIFO), `md-to-speech.js` (`mdToSpeech` — strips markdown before synthesis).
  - **Models & usage** — `models.js` (client mirror of the server model catalog; `resolveSpawnModel(family, ctx)` the three spawn pickers call — fed by `src/modelVersions.js` via `/api/settings/models`), `usage.js` (`UsageTracker` / `RateLimitTracker`).
  - **Sidebar, composer & misc** — `sidebar.js` (Project ▸ Sessions ▸ Worktrees subnodes), `composer.js` (Enter / Shift+Enter, attachments, hold-to-dictate), `notifications.js` (Service-Worker OS pings), `anchor.js` (`#session=<sid>` helpers), `dismissable.js` (`makeDismissable` — click-outside/Esc factory), `external-links.js` (`installExternalLinkOpener` — Android `target=_blank` workaround), `sw.js` (Service Worker).
- **tests/** — `node:test` suite (see Testing below).
- **debug/** — Opt-in Playwright + Termux-Chromium harness (sibling-repo dep).
- **migrations/** — Idempotent on-disk migrations; see "Migrations" below.

## Conventions

Load-bearing rules this codebase follows — keep new work inside them so the project stays manageable as it grows.

1. **Frontend: `installX({…})` modules; `app.js` is wiring-only.** Feature logic lives in a `public/` module exposing an `installX({…getters,…callbacks})` factory (or a class for a stateful widget). `app.js` only builds `state`/the DOM map, calls each `installX` once, holds the returned handles, and wires `wsRouter` last. Modules read live state through injected getters (`getActiveId: () => state.activeId`) — they never reach into globals. Don't grow `app.js` with feature logic; add a module and wire it.
2. **No god-modules — extract composed collaborators.** When a module takes on a second responsibility, lift it into a collaborator the owner *composes*, keeping the public surface stable via delegation. Cf. `InstanceManager` → `IdleSubscriptionHub` + `OverageResumeController`; `mcp/handlers.js` → `diffPaging` + `messageReconstruction` + `content`; whisper/tts install → the `makeInstallRunner` factory.
3. **One service layer for REST + MCP — don't reimplement per surface.** Git / worktree / diff / session logic lives once in `src/worktrees.js` (+ siblings) and is imported by **both** `src/routes.js` and `src/mcp/handlers.js` (shared: `isGitRepo`, `mergeWorktreeIntoParent`, `syncWorktree`, `getWorktree`, `getWorktreeMergeStatus`, `buildRebasePrompt`, `removeWorktree`, …). A new git/worktree op goes in the service layer and is called from both surfaces — never duplicated.
4. **Single-source-of-truth catalogs, shipped to the client — never client literals.** Curated catalogs (`modelVersions.js`, `whisperModels.js`, `ttsModels.js`) own the authoritative list + allow-list + policy server-side; the client *fetches* them (`/api/settings/models` → `public/models.js`) instead of hardcoding the canonical set. (`public/models.js` keeps a `DEFAULT_VERSIONS` first-paint fallback — a fallback, not a second source of truth.)
5. **Cross-surface magic strings get one owner module.** A canonical string shared across surfaces lives in a single module. Cf. `planApproval.js` — the approve/reject prompts shared by the UI buttons, the server-side auto-approve, and the MCP `approve_plan`/`reject_plan` tools; `SOFT_INTERRUPT_MARKER` in `parser.js`.

## Instance lifecycle
```
create → spawning → idle ←─ turn ─→ turn_end ─┐
            ↓        ↓                          ↓
        load-hist  prompt                  exited / crashed
        fails                                   │
                                                ▼ respawn --resume <sid>
                                            (back to spawning)
```

On **resume**: `loadHistory(sessionId)` runs before flipping to `idle` — replays jsonl into UI events and emits a `system/history_replayed` divider. A history longer than the ring cap trims during the replay itself; the evicted prefix stays reachable via `GET /api/instances/:id/events`. On **turn end** or **mode change**: append `{"type":"last-prompt", …}` + `{"type":"permission-mode", …}` lines so `claude --resume`'s interactive picker can discover the session.

## On-disk state
All orchestrator-owned state in a single workspace-wide dotfolder at `~/project/.code-conductor/`:
```
~/project/                                  # projectsRoot()
├── .code-conductor/                        # central store
│   ├── workspaces.json                     # registry of known workspace names
│   ├── session-titles.json                 # {sessionId: customLabel} sidecar
│   ├── conducted-sessions.json             # {sessions:[sid,…]} — durable conducted-session markers
│   ├── pending-resume.json                  # transient — "Resume after restart" manifest; written on drain, read+unlinked on boot
│   ├── pending-temp-cleanup.json            # transient — temp-cleanup manifest (normal restart); swept+unlinked on boot
│   ├── settings.json                        # app settings, e.g. {transcribe:{model}, models:{fable,sonnet,opus,haiku,fable5Enabled,defaultFamily,onOverage,sonnetContextWindow,conductorCompactWindow}, tts:{enabled,voice,rate}}
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
