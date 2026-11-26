# Component: the headless replay

`node server.ts --replay [--session <id>] [--ui full|view|interact]` — `replayMain` (`src/headless/replay.ts`). The headless run, its entry order and the focus cell: [headless.md](headless.md#headless-mode) → Headless mode. User-facing behavior: [features/conduct.md](../features/conduct.md) → Headless mode; the UI modes: [features/ui-modes.md](../features/ui-modes.md); the result object: [protocol/headless.md](../protocol/headless.md) → Replay result.

## Replay

`server.ts`'s entry block hands `kind: 'replay'` to `replayMain` with `start({...entryStartOptions(env), buildWeb: false, syncDeps: false, headless: true, uiMode: args.ui, launchless: args.ui === 'view'})`. A `usage` result (`--replay --prompt x`) goes to `headlessMain`. The default `--ui` is `view`.

**Entry order** (`replayMain`):
1. Redirect `console.log` to stderr, keep the real stdout write; `finish(r)` writes one `json` result, detaches the root watch and exits in the write callback.
2. `SIGINT` / `SIGTERM` at any time → `stopped` (exit 0, `sessionId` the chosen id or null); see the signal path under `interact` / `full` below. `uncaughtException` / `unhandledRejection` → `boot_failed`.
3. `start()`: `RootLockHeldError` / `RootLockUnreadableError` → `root_held`; any other throw → `boot_failed`.
4. `resolveReplaySession`: `--session` resolved through `resolveOwner` over `loadSessions()`, else the `headless-last-run.json` marker's `sessionId` resolved the same way. A refusal (unknown id, no marker, a marker naming a gone session, an unreadable marker) is written to stderr with `ENTRY_SYNOPSIS` and finishes `no_session` (exit 4).
5. Set the focus cell, print the banner, `headless: replaying session <id> (--ui <mode>)` and `headlessUiLines`; under `interact` / `full` start `watchReplayRoot`; then serve until a signal.

`createServer` splits two options: `uiMode` (what `GET /api/health` advertises) and `launchless` (this boot runs no CLI). Only a replay under `--ui view` is launchless.

## Replay under view

**No session starts.** `new Instance(` appears only in `InstanceManager._doCreateResolved` and `Instance.launch` is the only caller of `spawn()`, so a manager built with `refuseCreates` (`createServer` passes `REPLAY_NO_LAUNCH` under `launchless`) rejects every `create()` first, before the resume guards, with `statusCode` 409 and code `VIEW_REPLAY_NO_LAUNCH` (`errorBody`, `src/routes/errors.ts`, carries it to REST).

Under `launchless`, `startHolding` also skips the plugin host's `init()` + `autoStartAll()`, `_usageMonitor.start()` and `checkClaudeReadiness`; the resume restore is skipped for every `headless` boot. A plugin view the user opens still starts its backend lazily (`POST /api/plugins/:id/start`).

This guarantees no session CLI only: no spawn route is refused beyond `create()`, so a raw REST call can still run a non-session CLI or write the store (session summary and ask, `claude-auth/status`, `settings/claude-update`, `/api/exec`, the terminal, tts); the replay UI cannot issue them (the client refuses them, Settings is unreachable).

## Replay under interact and full

- **A working conductor.** Not launchless: `create()` is not refused, and the plugin autostart, usage monitor and readiness probe run as on an ordinary boot. The root can be resumed (the Ended pane's Resume: restore, then `POST /api/instances` with `resume`), spawn, merge and land. Under `interact` only the focused root's controls are live in the UI; under `full` everything is.
- **The ask policy.** `watchReplayRoot` (`src/headless/replayRoot.ts`) listens on the manager's `status`. For a summary whose `sessionId` is the replay's and whose `id` is that session's live instance (`liveForSession`), it feeds `rootAskAnswerer` (`src/headless/rootPolicy.ts`), one answerer per instance id, so a re-resume gets a fresh `liveAsks` count. Workers and other sessions are ignored. Nothing is sent on resume itself; the run fragment went with the run's first prompt. A failed answer logs `headless: answering the root conductor failed: …` (or the plan-approval message) to stderr.
- **The signal path.** The first `SIGINT` / `SIGTERM` reads `liveForSession(chosen)`; when it is mid-turn (`status === 'turn'`) it awaits `forceInterrupt(root)` — bounded by `INTERRUPT_WAIT_MS` — then finishes `stopped`, exit 0. Otherwise, and on a second signal during that wait, it finishes at once. Under `view` there is never a live root, so the same path is immediate.
- **Restart and shutdown** refuse (`RESTART_DISABLED_HEADLESS` / `SHUTDOWN_DISABLED_HEADLESS`) under every mode: `relaunch.headless` is set for every headless boot.

## The run's HOME

The Ended pane reads the session's transcript from the CLI's own config dir, and a resume launches the CLI on it, so a replay must run under the run's `HOME` / `CLAUDE_CONFIG_DIR`. That is the user's responsibility: cc does not check it, and a replay under another one finds no transcript.

**Tests**: `tests/headless-replay-select.test.mjs` (the marker and `resolveReplaySession`), `tests/replay-create-refusal.test.mjs` (`refuseCreates`), `tests/replay-plugin-boot.test.mjs` (the control autostart, an `interact` replay's autostart, and a launchless replay's explicit plugin start, counted as daemon spawns; the boot-time skip is pinned in `tests/web-build-wiring.test.mjs`), `tests/headless-replay-root.test.mjs` (`watchReplayRoot` on a fake manager), `tests/headless-replay.test.mjs` (a real launchless `--replay` over a finished run), `tests/ui-mode-replay-e2e.test.mjs` (a real `--replay` per `--ui`, through the real client modules: resume, spawn, the ask policy, refusals and the signal path).
