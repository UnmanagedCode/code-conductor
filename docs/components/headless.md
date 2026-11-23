# Components: the projects-root lock and headless mode

The single-writer lock on a projects root and the headless entry point.

## The projects-root lock
`src/rootLock.ts`. At most one cc server runs on a projects root. `start()` (`server.ts`) calls `acquireRootLock({storeDir, platform})` **first**, before `measureBootCommit`, `runMigrations` and every sweep, and releases it if the rest of the boot throws. So a refused server never consumes the holder's `pending-resume.json` / `pending-archive.json`, never runs the session-tmp `rm -rf` or the FUSE sweep, and never adopts or prunes plugins.

- **Refusal.** `RootLockHeldError` (`code: 'ROOT_LOCK_HELD'`, `holderPid`, `lockPath`), message `another code-conductor server (pid <N>) holds the projects root <root> (<lockDir>/<gen>.json); refusing to start`; or `RootLockUnreadableError` (`code: 'ROOT_LOCK_UNREADABLE'`, `lockPath`) when the top record cannot be parsed, message `the projects-root lock record <lockDir>/<gen>.json cannot be read; if no code-conductor server is running on <root>, delete it and start again`. The `server.ts` entry prints either to stderr and exits **`ROOT_LOCK_HELD_EXIT` (7)**; any other boot failure still exits 1. The refusal is immediate: a contender never waits for a live holder.
- **Event-log writer.** `RootLock.writerCheck()` is the event log's write lease (`createServer` wires it into the playbook gate): `null` while the lock is held, not released, its generation the highest, its record still its own and `handoverTo` null — otherwise the reason. The log checks it in the same synchronous step as each append, so from the moment a restart offers the handover no row of the old server lands; the replacement folds the file only after it holds the lock ([event-log.md → The writer](../event-log.md#the-writer)).
- **Scope: one kernel.** It protects servers on the same kernel: the host and its containers, and Docker Desktop containers among themselves (one VM kernel). It does **not** protect a root shared across machines (NFS), or between a macOS host process and a Docker Desktop container — a socket file may not connect across that share, so a live holder can read as dead. Keeping those runs apart is the caller's job.

**Layout** — `<store>/server-lock/` (`ROOT_LOCK_DIRNAME`):

| Entry | What |
|---|---|
| `<gen>.json` | A record per generation, `gen` a positive integer (`/^[1-9]\d*\.json$/`). The highest one present is the lock. Created exclusively by `prepareLockFileSync(…).publish()` (`src/storeLock.ts`, the create `withLock` uses too — see Creating a lockfile); rewritten whole for an offer (`<gen>.json.offer-<token8>` + rename, EPERM/EBUSY retried on Windows — a suffix the sweep never matches). |
| `<gen>.json.tmp-<hex>` | A record staged for publishing (hard-link mode only); never a generation. The publish removes it either way; a successful acquire **sweeps** every one in the lock dir (exactly this shape, `STAGED_GEN_FILE`), so one left by a killed creator does not stay. A live creator whose staged record is swept gets `ENOENT` from its publish, looks again, meets the new holder and is refused. |
| `.cc-link-probe-<hex>`, `….link` | `storeLock`'s hard-link capability probe (`LINK_PROBE_PREFIX`); removed by the probe, swept like the above. A probe whose file is swept mid-probe retries. |
| `<token8>.sock` | A holder's listening socket for a `store` endpoint. `token8` = first 8 hex chars of sha256 of the holder's token. |

**Record (v1):** `{v: 1, pid, token, sock, handoverTo}`.
- `pid` — for messages only. It is never checked.
- `token` — `mintLockToken()` (`src/storeLock.ts`): pid, time and counter **plus 8 CSPRNG bytes**, since pid/time/counter repeat across pid namespaces (every container's node can be pid 1). Release is token-checked (`releaseLockSync`).
- `sock` — `{kind:'store', name}` (relative to the lock dir; `.`/`..` make the record unparseable), `{kind:'tmp', path}` or `{kind:'pipe', name}`.
- `handoverTo` — the offer a restart replacement presents to take the next generation over this live holder; `null` otherwise.

**Creating a lockfile** (`src/storeLock.ts`, shared by the root lock and `withLock`). The mode is probed once per directory — keyed by its realpath, cached for the process, and logged once: a temp file in the dir is `linkSync`ed to a second unique temp name (so `EEXIST` cannot occur), then both are removed.

| Probe outcome | Mode | Create |
|---|---|---|
| link succeeds | **link** | write a uniquely named staging file, `linkSync` it to the lock path (`EEXIST` → taken), remove the staging file. A reader never sees a created-but-unwritten lockfile, however long the creator is starved. |
| a code in `NO_LINKS` (`src/storeLock.ts`; FAT/exFAT, Android shared storage; Android/Termux app storage, where `link()` is denied with `EACCES`) — and `EXDEV`, with an extra warning | **in place** | `openSync(path, 'wx')` + `writeSync` + `closeSync` (`EEXIST` → taken; a failed write removes what it created). Never a rename. A reader can see the file empty for a moment, and **a crash between the create and the write leaves an empty lockfile that must be deleted by hand** — for the projects-root lock, an empty top record refuses every boot with `ROOT_LOCK_UNREADABLE` (`RootLockUnreadableError`) until it is deleted; an empty session-store `….lock` fails store writes after the bounded retries. `EACCES` counts only from the probe's link step; the probe's write has already succeeded by then. |
| any other code — or the probe's own write failing (any code, `EACCES` included) | — | propagates with the same `code`, rethrown naming the directory (`storeLock: cannot create lockfiles in <dir>: …`, the original as `cause`); nothing is cached, the next create probes again. A probe whose source file vanished (`ENOENT`, swept mid-probe) retries instead. |

Both readers are safe with the in-place window without agreeing on a mode: `withLock` never reclaims a record without a pid (it waits it out), and the root lock treats an unparseable **top** record as held, on every filesystem (an unparseable record below the top is collected — see Acquire).

**`withLock`'s files** (`src/storeLock.ts`; beside each locked data file, e.g. `<store>/sessions.json`):

| File | What |
|---|---|
| `<data>.lock` | `{pid, ts, token}`. Reclaimed only when `pid` is dead; a record without a pid (an in-place create caught mid-write) is waited out, never stolen — past `ORCH_STORE_LOCK_RETRY_MAX` retries the acquire throws `storeLock: could not acquire …`, so an empty lockfile a crash left (in-place mode, killed between the create and the write) fails every write until it is deleted. Release is token-checked. |
| `<data>.lock.tmp-<hex>` | A lockfile staged for publishing (link mode). **Not swept**: a live waiter's staged file could be one. A creator killed between staging and publishing leaves it behind. |
| `.cc-link-probe-<hex>`, `….link` | The create-mode probe's temp files (`LINK_PROBE_PREFIX`). **Not swept** here: a probe killed mid-probe leaves them behind. |
| `<data>.lock.reclaim` | The dead-owner reclaim marker, created with the same create. Only its holder may unlink `<data>.lock`, and only while that still holds exactly the record judged dead — so two waiters on one dead owner can never delete each other's fresh lock. A marker whose own `pid` is dead is cleared (only while unchanged); two waiters clearing one such stale marker at the same instant can both reclaim, which needs a reclaimer to die inside a few synchronous calls and is not closed. A live marker is respected (the waiter backs off, bounded by `ORCH_STORE_LOCK_RETRY_MAX`). **An empty marker** — in-place mode, a reclaimer killed between its create and its write — has no pid, so it is never cleared: like an empty `<data>.lock`, it blocks every reclaim (and so `withLock`, once its owner is dead) until it is deleted. |

**Why no pid liveness.** A record's pid means nothing to a reader in another pid namespace (two containers on one bind-mounted store, a host and a container): it reads as absent (→ "dead") or as the reader's own pid, and either would steal a live lock. `withLock`'s pid-liveness reclaim (`isProcessAlive`) stays as it is — its holders are this host's own short critical sections.

**Endpoint** — `Platform.rootLockEndpoint(lockDir, token8, {storeUsable})` picks where the holder listens; `Platform.socketConnectPath(lockDir, sock)` gives the address THIS process listens or connects at (`{path, release}`; `release` closes a borrowed directory fd).

| Host | Endpoint |
|---|---|
| win32 | `pipe`: `\\.\pipe\cc-root-<sha256(realpath lockDir)[:16]>-<token8>` — machine-global, a vanished listener answers `ENOENT`. |
| POSIX, `<lockDir>/<token8>.sock` ≤ `SOCK_PATH_MAX` (103) bytes (`src/platform/rootLockAddress.ts`) | `store`, at that path. |
| POSIX, longer, `/proc/self/fd` exists (Linux, Android) | `store`, reached as `/proc/self/fd/<dirfd>/<token8>.sock` through an fd on the lock dir that the holder keeps open. Each reader resolves `name` against its OWN lock-dir path, so a container mounting the store elsewhere still finds it. |
| POSIX, longer, no `/proc` (macOS) | `tmp`: `<os.tmpdir()>/cc-root-<sha16>-<token8>.sock`. |
| A store that refuses a socket (listen fails with anything but `EADDRINUSE`: FAT, some FUSE mounts) | falls back to `tmp`, with one warning that a server in another container on this root will not see this one. |

**Listening.** The holder probes its own address; if something answers (a token that collided with a live holder's), the path is "taken". Otherwise it removes the leftover file at that path, probes again (answering → "taken"), and listens with `readableAll`/`writableAll` (a contender running as another uid can still probe); `EADDRINUSE` from the bind is "taken" too. A "taken" path mints a fresh token and tries again (`TOKEN_ATTEMPTS`, then it throws). **What holds:** a file is unlinked only after a probe found nothing answering on it, and a listener that binds after the unlink makes the path "taken" (by the second probe or by the bind). **What does not:** a listener that binds between the first probe and the unlink loses its file. Only two holders whose tokens share a sha256 prefix (`token8`) can meet on a path, and tokens carry 8 random bytes. The server is unref'd and destroys every accepted connection.

**Probe** — `probeHolder(rec, lockDir, platform)`: one `net.connect`, bounded by `PROBE_TIMEOUT_MS`.

| Outcome | Verdict |
|---|---|
| connected | alive |
| `ECONNREFUSED`, `ENOENT` | dead |
| timeout, `EAGAIN` (full backlog), `EACCES`, `ENOTSUP`, any other error | alive |

The kernel completes a unix-socket connect into the listen backlog without the holder's event loop running, so a holder starved for minutes (Termux) still probes alive; nothing is evicted on age. When the holder dies by any means, `SIGKILL` and a host reboot included, nothing listens on the recorded socket and the next probe reads dead at once — no exit handler is needed, and the lock never consults time.

**An unparseable top record** (empty, malformed, a `.`/`..` socket name) is treated as **held**: `RootLockUnreadableError`, exit 7, the record left in place. In in-place mode it can be a live holder's record between its create and its write, and superseding it would make two holders. In link mode it can only be corruption, but the rule is the same on every filesystem, so two processes never need to agree on a mode. **The cost:** a corrupted record — or, in in-place mode, one left empty by a crash — blocks every boot on that root until a person deletes it.

**Acquire** — `acquireRootLock({storeDir, platform, env, log, mintToken, hooks})` (`mintToken`, `hooks.beforePublish` and `hooks.beforeListen` are test seams):
1. `mkdir -p` the lock dir. Read and delete `env.CC_ROOT_LOCK_HANDOVER` (`ROOT_LOCK_HANDOVER_ENV`), so it never reaches a CLI or plugin env.
2. Mint a token and **listen first** (Listening above), so any record naming us is probe-able from the moment it exists.
3. Up to `ACQUIRE_ATTEMPTS` passes:
   - Read the top generation's record. Unparseable → close our listener, throw `RootLockUnreadableError`. It probes **alive** → close our listener, throw `RootLockHeldError` — **unless it offers its successor to us** (`handover` set and `rec.handoverTo === handover`). The offer only skips this refusal; nothing is rewritten into a lock.
   - Prepare `<top+1>.json` and publish it (`EEXIST` → next pass, which meets whoever published it; `ENOENT` — our staged record was swept by a new holder — likewise). **Confirm** it is still the highest; if not, unlink ours and take another pass (which probes the higher one alive and refuses).
   - **Collect**: for every `<g>.json` below ours whose socket does **not** answer, or that is unparseable (below the confirmed top it can at most be a contender's mid-create record, which backs off at its confirm), unlink it and its socket file. One that answers stays — a contender between its publish and its confirm, or a restarting parent waiting to exit; each removes its own.
   - **Sweep** the lock dir's staged records and link-probe files.
4. Install a `process.on('exit')` handler running `releaseSync()`.

Every holder, a restart's replacement included, takes the lock by an exclusive publish and a confirm. A contender that judged a generation dead and was then preempted can only lose that publish to whoever took the next generation, and meets it alive on its next pass — so there is never a second holder, and a dead generation is never resurrected.

**`RootLock`** — `{dir, gen, token, offerHandover(next), awaitAdoption({timeoutMs, signal}), releaseSync()}`. `awaitAdoption` resolves true once a higher generation exists or our record no longer carries our token. `releaseSync()` (the exit handler; boot failures, `start()` included; the restart parent) unlinks `<gen>.json` only while it still carries our token, closes the listener and removes our own socket file. A signal death skips it; the probe self-heals.

**Restart handover** (`spawnReplacementAndExit`, `src/restart.ts`; `RelaunchOptions.rootLock` → `runRestart({rootLock})` → `spawnAndExit({log, rootLock})`):
1. `next = mintLockToken()`; `offerHandover(next)` writes `handoverTo: next` into our record **before** the spawn. If the offer throws or finds the record no longer ours, the lock is **released** instead (`releaseSync`) and the child is spawned without an offer and boots like any server — the relaunch is already committed, and one gap beats a process serving nothing.
2. Spawn with `CC_ROOT_LOCK_HANDOVER=next` in the child's env only. A spawn that throws → `releaseSync()` (which drops the offer too) and keep the process — its networking is already down, so the next server started takes the root.
3. `awaitAdoption({timeoutMs: CC_ROOT_LOCK_HANDOVER_WAIT_MS, signal})` polls every `ADOPTION_POLL_MS` until the child has published the next generation, the child exits, or the wait runs out; meanwhile our lock socket keeps answering (the HTTP server is already closed). A failure reading the record is logged and treated as "not adopted".
4. `exit(0)`, never sooner than 50 ms after the spawn; the exit handler removes our own, now lower, record.

| Point in the restart | The top record | A third server sees |
|---|---|---|
| offer written, child booting | the parent's, listening | alive → refused |
| child published `<gen+1>` | the child's, listening before it existed | alive → refused |
| the child died before publishing; the parent's wait ran out and it exited cleanly | none — the parent's exit handler removed its record | an empty lock dir → publishes generation 1 |
| the parent died by a signal while offering (no exit handler ran) | the parent's, closed, still offering | dead → publishes `<gen+1>`. A child presenting the offer may race it: exactly one holder results, and the other meets it alive and is refused |

**Supervised variant** (`exitToSupervisor`): no offer, no spawn, no adoption wait — `releaseSync()` then `exit(75)`; the supervisor relaunches the server, which acquires the lock like any boot (generation 1 again). Two servers never hold the root at once, but between the old server's exit and the replacement's `acquireRootLock` (module load, about a second) a *third* server on the same root (a host `npm start`) can take it; the replacement is then refused with exit 7 and the container ends loudly (restart policy).

The replacement reads `pending-resume.json` / `pending-archive.json` only after it holds the lock (`acquireRootLock` runs first in `start()`), so a resume restart carries over exactly as without the lock.

## Headless mode
`src/headless/`. `server.ts`'s entry block hands any argv carrying a headless flag to `headlessMain` (`src/headless/entry.ts`); every other argv boots the ordinary server. User-facing behavior: [features/conduct.md](../features/conduct.md) → Headless mode; the result object, exit codes and output formats: [protocol/headless.md](../protocol/headless.md) → Headless run result, Output formats.

| Module | Owns |
|---|---|
| `args.ts` | `parseHeadlessArgs(argv)` → `none` \| `headless {source, mode, format, includeWorkers}` \| `view {session}` \| `usage {message, format}` (pure; a usage result's `format` is the requested `--output-format` when valid, else `json`); `readHeadlessPrompt(source, {readFile, stdin})`; `HEADLESS_SYNOPSIS`. |
| `entry.ts` | `headlessMain(args, {start})`: stdout routing, the prompt read, boot, the stream, the runner, the one result write and `process.exit`. `headlessUiLines(host, port, nets)` — the stderr URL lines. |
| `view.ts` | `viewMain(args, {start})` — the `--view` process; `resolveViewSession({requested, readLastRun, loadIndex})` → the public id or a refusal message; `VIEW_NO_LAUNCH`, the refusal every `create()` of a replay answers. |
| `lastRun.ts` | `recordHeadlessRun(sessionId)` / `readHeadlessRun()` / `headlessLastRunFile()` — the `headless-last-run.json` marker the live run writes and the replay reads. |
| `runner.ts` | `runHeadless({instances, prompt, mode, clock, signals, expose, onRoot})` → `HeadlessResult`. `onRoot(root)` runs synchronously once the root is spawned, before its first prompt. |
| `result.ts` | `EXIT_CODES`, `signalExitCode`, `HeadlessResult`, `bareResult`, `formatResult` (the `json` bytes), `OUTPUT_FORMATS`, `renderResult(r, format)` → `{stdout, stderr}` — the one source of the result's output. |
| `stream.ts` | `createHeadlessStream({instances, includeWorkers, sink, onFail, capBytes})` → `{setRoot, close}` — the `stream-json` lines; `labelLine(line, labels)` (pure); `STREAM_STDOUT_CAP_BYTES`. |
| `fragment.ts` | `HEADLESS_FRAGMENT` (prepended to the root's first prompt) and `HEADLESS_QUESTION_ANSWER` (the canned answer). |

**Entry order** (`headlessMain`):
1. Capture the real `process.stdout.write`, then point `process.stdout.write` at stderr — every `console.log` (the boot-commit line, the store line, the listening banner) goes to stderr. No cc child inherits fd 1: the restart is refused and plugin backends use `stdio: pipe`. A `process.stdout` `'error'` handler (`onStdoutError`) goes on in every mode — on a live pipe it never fires. `exitOnce(code)` is the only `process.exit` call, and runs at most once.
2. **The catch-all**: `uncaughtException` and `unhandledRejection` handlers, plus a `try` around the rest, all routed to one `fail(e)` that writes a result through the captured stdout — `signal` (128 + n) once a signal was seen, else `conductor_error` once the runner started, else `boot_failed` — and exits with its code. Once the root exists the result carries its session facts from the runner's handle (`RunHandle.facts()`: `sessionId`, `text`, `durationMs`; `costUsd` stays null), and `fail` first calls `RunHandle.detach()` so the runner stops listening; before the spawn every fact is null (`bareResult`). Only the first result written counts, and writing it removes the entry's own `SIGINT`/`SIGTERM` listeners: node suppresses a signal's default action while any listener exists, so a signal after the result kills the process even if the stdout write never completes. Early `SIGINT`/`SIGTERM` handlers go on here too: until the runner takes over, a signal writes a `signal` object with no root; a recorder notes the first signal for `fail`.
3. A usage error, or a prompt that cannot be read (a missing file, a stdin that errors) or is empty: stderr message + `HEADLESS_SYNOPSIS`, the `usage_error` result in the requested format, exit 2. Nothing booted — no lock, no migrations. `--prompt-file -` first prints `headless: reading the prompt from stdin` to stderr.
4. `start({...entryStartOptions(env), buildWeb: false, syncDeps: false, headless: true})`. `RootLockHeldError` / `RootLockUnreadableError` → `root_held`; any other throw → `boot_failed`. `start()` forwards `headless` into `createServer({relaunch: {flags, rootLock, headless}})`, where `POST /api/admin/restart` refuses with `409 RESTART_DISABLED_HEADLESS` ahead of `withMaintenanceLock` (`src/routes/admin.ts`).
5. The listening banner and `headlessUiLines` to stderr; the early signal handlers off; under `stream-json`, `createHeadlessStream` on `boot.instances` (sink: the captured write, `buffered` = `process.stdout.writableLength`; `onFail` → `RunHandle.fail`); `runHeadless` with `onRoot` → `stream.setRoot`.
6. `finish(r)`: the stream closed, `renderResult(r, format)` — its stderr line, if any, to stderr — and its stdout through the captured write; `exitOnce(exitCode)` in the write's callback, which also fires (with an error) on a closed or destroyed stdout; on an error it first writes `headless: the result was not delivered: stdout closed (<code>)` to stderr, then calls `exitOnce(exitCode)`. Writes are ordered, so every streamed line is flushed before the result.
7. **A closed stdout** (`onStdoutError`, EPIPE or any write error) never throws and never reaches the catch-all: the stream closes; once a result is written, `exitOnce(that result's code)`; with the runner exposed, a stderr line and `RunHandle.fail('stdout closed (<code>): …')` — the run ends `conductor_error`, and its own result write then exits through the callback; before the runner, `finish` with `conductor_error` or `boot_failed`. No `instances.shutdown()`: workers end as in a normal shutdown, when their CLIs see stdin EOF; the root-lock exit handler releases the lock.

**One spawn implementation.** `newConductorSpawnBody(mode)` (`shared/newConductor.ts`) is the body New conductor posts (`web/src/features/dialogs/conduct.ts`, always `code`); its project literal is `CONDUCT_PROJECT_NAME`'s value, pinned equal by `tests/spawn-request.test.mjs`. `spawnFromBody(instances, body)` (`src/spawnRequest.ts`) is the whole of `POST /api/instances` — the pristine, `persistent` (non-boolean → 400) and `playbookEnforcement` refusals, the Settings → Models row a model-less spawn runs on (`takeSpawnRow`), then `create()` — and the runner spawns its root through it with `newConductorSpawnBody(mode)` plus `autoApprovePlan: true` in plan mode. `autoApprovePlan` is set only on that one `create()`; MCP `spawn_instance` never passes it.

**The runner** (`runHeadless`):
- Spawns the root, then `promptOrQueueSteer(HEADLESS_FRAGMENT + '\n\n' + prompt, [], {author: 'human'})` — the composer's own path.
- Listens to the manager's `status` and `subscription_changed`. On the root's own `status`: `exited`/`crashed` → `conductor_error` (with `exitCauseFor`'s code, signal and stderr tail). A **tool** ask (`awaitingUserSource === 'tool'`) whose `liveAsks` passed the last one answered: a question gets `HEADLESS_QUESTION_ANSWER`, a plan gets `setMode('bypassPermissions')` when in plan mode and then `buildApprovePrompt(undefined)` — the plan the server-side auto-approve rule (`Instance._planAutoApproves`) did not take. Only the root is watched: conducted sessions never carry `awaitingUser`, and their asks reach their owners as wakes.
- **Completion**: on every event, `instances.isTreeQuiescent(root.id)`. True starts a timer of `IDLE_DRAIN_SETTLE_MS` (`src/idleSubscriptions.ts`, env `ORCH_IDLE_DRAIN_SETTLE_MS` — the hub's own "no turn is coming" window); false cancels it; when it fires and the predicate still holds, the run is `completed`, or `conductor_error` if the root's `lastTurnError`.
- **Handle** (`expose`, called synchronously before the spawn): `facts()` — null until the root exists, then its `sessionId`, last text and `durationMs` so far; `signalCostRead()` — the first signal's cost read, null before a signal; `detach()`; `fail(error)` — ends the run `conductor_error` with that error (the stream's cap or failure, a closed stdout), a no-op once the run is ending.
- **Signals** (`signals`, default `process`): the first `SIGINT`/`SIGTERM` starts a cost read and runs `root.interrupt({force: true})` raced against `INTERRUPT_WAIT_MS`, then resolves `signal` with `128 + n` and a fresh cost read; a second, or one landing while the run is already ending, resolves at once with the first signal's cost read if it has finished, else `costUsd` null.
- **Failures** inside the runner's own async paths (`failRun`) still resolve: `signal` if one was seen, else `conductor_error`.
- **Result**: `text` is the last message with text of `reconstructMessages(root.ringSnapshot(), false)` (`src/mcp/messageReconstruction.ts`); `costUsd` is `await flushCostWrites()` (`src/costTracking.ts`, the tail of the append chain) then `getSessionStats(sessionId).rolled.cost_usd` — best-effort: a failed read gives null and logs `headless: reading the run's cost failed` to stderr, once per run however many reads fail; `durationMs` is `clock.now()` at the result minus at the start.

**The stdout tap.** `Instance.spawn()`'s stdout reader emits `stdout_line` with the raw line on every line, after `_debugLog` and **before** `_handleStdoutLine` — so a streamed line goes out before anything its parse triggers, such as the turn end that completes the run — late lines past the launch's exit latch included. `InstanceManager._doCreateResolved` attaches its relay beside `'event'`, before the first `launch()`, so the Instance always has a listener and every line costs one emit and one relay call, the ordinary server's included. The relay builds the `{instance, line}` payload and emits the manager's `stdout_line` only while the manager has a listener (the ordinary server never has one). The emit is unguarded; the stream guarantees it cannot break the parse: `onLine`'s whole body runs in a `try/catch`, and both failure paths — a throw (`the headless stream failed: …`) and the cap — stop the stream (every listener off, `pending` cleared) and call `onFail` once, from a `queueMicrotask`, never inside the Instance's handler.
- **Root first:** lines arriving before `setRoot` queue in `pending`; `setRoot` replays them through the membership test, in order.
- **Membership:** root-only compares `instance.id` (the same Instance across respawn, renewal and late lines). `--include-workers` asks `InstanceManager.inRunTree(rootId, inst)` — the id, then the root attribution read off the instance object, then `runTreeIds(rootId)`, the tree `isTreeQuiescent` walks. An admitted id stays admitted for the run; a rejected id is cached and not walked again until a manager `status` or `subscription_changed` (the two listeners exist only with `--include-workers`). A walk is O(tree × `byId`) `ownersOf` calls, so a busy non-member costs about one walk per turn edge, not one per line.
- **Cap:** after each write, `sink.buffered() > capBytes` (`STREAM_STDOUT_CAP_BYTES`) stops the stream and fails the run with the lag message. The CLIs are never paused: pausing would starve `Instance._controlRequest`'s timeout.

**The completion predicate** — `InstanceManager.isTreeQuiescent(rootId)`, reading only existing wake state:
- False unless the root is in `byId` with a `proc`, `status === 'idle'`, `liveTurnEnds >= 1`, and `awaitingUserSource !== 'tool'`.
- **The tree** (`runTreeIds(rootId)`, shared with the stream's `inRunTree`): the root, every conducted instance in `byId` whose `rootSessionId` (the durable root attribution `rootSessionOf` fixes at create, inherited down every conducted spawn) is the root's `sessionId`, and every id `IdleSubscriptionHub.ownedTreeOf` reaches from any of those — a BFS over `ownersOf` (spawn ∪ dispatch ownership) with a visited set, since ownership can be mutual; the root itself is never in it. The attribution is what keeps a grandchild in the tree after its section lead left `byId` (a normal lead's exit, a `remove`) and took its ownership edges with it.
- For each: skip a dead one (`isDeadStatus` and not `relaunching`); every other must be `idle`, not `isIdleCaller` (armed, held, in-flight or deferred wakes), not `targetDefers` (`activeAgentTaskCount` / `taskNotificationPending` / `rotationPending` / `steerPending`), and not in `_jobWaiters()`.

**Tests**: `tests/headless-args.test.mjs` (the parser, `--view` and `--session` included), `tests/headless-view-select.test.mjs` (the marker and `resolveViewSession`), `tests/replay-create-refusal.test.mjs` (`refuseCreates`), `tests/replay-plugin-boot.test.mjs` (a replay boot's plugin skip), `tests/headless-view.test.mjs` (a real `--view` process over a finished run), `tests/client-focus.test.mjs` (`shared/focus.ts`), `tests/view-only-server.test.mjs` (health's `focus`, a replay server's 409), `web/src/appFocus.test.tsx` and `web/src/app/focusOpen.test.ts` (the client), `tests/headless-output.test.mjs` (`renderResult` per format), `tests/headless-stream.test.mjs` (the stream on a fake manager, and the real tap on `bootServer` with in-process children), `tests/headless-completion.test.mjs` (the predicate and `ownedTreeOf`, on plain-object fakes in a real manager), `tests/headless-runner.test.mjs` (the runner on `bootServer` with gated fake-CLI scenarios — `scenario-headless-root-gated.json` opens a root turn that never ends on its own, so every timing decision is the test's), `tests/headless-entry.test.mjs` and `tests/headless-e2e.test.mjs` (real `node server.ts`), `tests/spawn-request.test.mjs`, `tests/docker-headless-script.test.mjs` (`docker/headless.sh` and `make headless` with a stub `DOCKER_COMPOSE`).

### Replay (--view)
`server.ts`'s entry block hands `kind: 'view'` to `viewMain` (`src/headless/view.ts`) with `start({...entryStartOptions(env), buildWeb: false, syncDeps: false, headless: true, replay: true, viewOnly: true})`. A `usage` result (`--view --prompt x`) still goes to `headlessMain`. User-facing behavior: [features/conduct.md](../features/conduct.md) → Headless mode.

**Focus cell.** `startHolding` makes one `HealthFocus` (`shared/focus.ts`) for every headless-family boot, hands it to `createServer({focus})` → `buildRoutes` → `mountAdmin`, which adds `focus: {sessionId}` to `GET /health`, and returns it from `start()` as `HeadlessBoot.focus`. A live run's `onRoot` sets `focus.sessionId` and calls `recordHeadlessRun`; a replay sets it once it has picked.

**Entry order** (`viewMain`):
1. Redirect `console.log` to stderr, keep the real stdout write; `finish(r)` writes one `json` result and exits in the write callback.
2. `SIGINT` / `SIGTERM` at any time → `stopped` (exit 0, `sessionId` the chosen id or null). `uncaughtException` / `unhandledRejection` → `boot_failed`.
3. `start()`: `RootLockHeldError` / `RootLockUnreadableError` → `root_held`; any other throw → `boot_failed`.
4. `resolveViewSession`: `--session` resolved through `resolveOwner` over `loadSessions()`, else the marker's `sessionId` resolved the same way. A refusal (unknown id, no marker, a marker naming a gone session, an unreadable marker) is written to stderr and finishes `no_session` (exit 4).
5. Set the focus cell, print the banner, `headless: viewing session <id> (view-only)` and `headlessUiLines`, then serve until a signal.

**No session starts.** `new Instance( appears only in `InstanceManager._doCreateResolved` and `Instance.launch` is the only caller of `spawn()`, so a manager built with `refuseCreates` (`createServer` passes `VIEW_NO_LAUNCH` under `replay`) rejects every `create()` first, before the resume guards, with `statusCode` 409 and the refusal's `code` (`errorBody`, `src/routes/errors.ts`, carries it to REST). Under `replay`, `startHolding` also skips the plugin host's `init()` + `autoStartAll()`, `_usageMonitor.start()` and `checkClaudeReadiness`; the resume restore is already skipped for every `headless` boot. This guarantees no session CLI only: no route is refused beyond `create()`, so a raw REST call can still run a non-session CLI or write the store (session summary and ask, `claude-auth/status`, `settings/claude-update`, `/api/exec`, the terminal, tts); the replay UI cannot issue them (view-only, Settings unreachable).

### Provisioning a projects root
cc seeds nothing into a fresh root beyond what any first boot creates (the store and `.conduct/`). A headless run on a fresh root therefore runs with default settings, built-in conventions, no plugins and no projects. What a root holds, and how to carry it over from an existing one (paths relative to the root; the store is `.code-conductor/`, laid out under On-disk state):

| Copy or recreate | What |
|---|---|
| `.code-conductor/settings.json` | Settings → Models (tiers, roles, backends, custom models), Voice, Systems, debug, overage. Copy it. |
| `.code-conductor/conventions/` | The conductor, workspace and project convention stores (off-switches + custom rules). Copy it. |
| `.code-conductor/playbooks/` | User-authored playbooks. Copy it. |
| `.plugins/<name>/` + `.code-conductor/plugins/registry.json` | Library plugin installs and which are enabled. The registry names plugins by **project**, and a project is a record, so after copying register each `.plugins/<name>` as a project (`POST /api/projects/external`, `adopt_project`) — or reinstall them from the Plugin Library. |
| `.code-conductor/projects/<name>/project.json` | Project records. Register the projects the run should see with `adopt_project` / `POST /api/projects/external` rather than copying records, which carry absolute paths. |
| `.code-conductor/sessions.json`, `.worktrees/`, `.conduct/`, `server-lock/`, `session-tmp/`, `convention-skills/`, `costs.jsonl` | Per-root runtime state, recreated by cc. Don't copy. |

Booting the root once as an ordinary server (`PROJECTS_ROOT=<root> PORT=<free port> npm start`) and configuring it in the UI is the other way; stop it before a headless run, which the root lock otherwise refuses.
