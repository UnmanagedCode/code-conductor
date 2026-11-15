# Protocol: the headless run result

## Headless run result
A headless run (`node server.ts --prompt …`, [features/conduct.md](../features/conduct.md) → Headless mode) writes **exactly one JSON object, on one line, to stdout** — on every outcome, usage errors and unexpected failures included — and exits with its `exitCode`. Everything else the process prints goes to stderr. Built by `formatResult` (`src/headless/result.ts`).

```json
{"reason":"completed","exitCode":0,"sessionId":"…","text":"…","costUsd":0.0123,"durationMs":84211,"error":null}
```

| Field | Type | Meaning |
|---|---|---|
| `reason` | string | `completed` \| `conductor_error` \| `signal` \| `usage_error` \| `root_held` \| `boot_failed` |
| `exitCode` | number | The process's exit code (table below). |
| `sessionId` | string \| null | The root conductor's public session id; null when the root was never spawned. |
| `text` | string \| null | The root's last top-level assistant text (the last message with text in its event ring); null when it has none. |
| `costUsd` | number \| null | `getSessionStats(sessionId).rolled.cost_usd` (`src/costTracking.ts`) after the pending cost appends flush: the root plus its spawned tree, claude-backend turns only. Null when the root was never spawned, when the read fails (logged to stderr), and in a result written by the entry's catch-all for an unexpected failure. On a second signal: the cost as read when the first signal arrived if that read has finished, else null. |
| `durationMs` | number \| null | From the root's spawn to the result; null when the root was never spawned. |
| `error` | string \| null | Why, for every reason but `completed`: the usage message, the lock refusal (naming the holder pid, or the unreadable record), the boot error, the root's exit or failed step, the signal. |

Exit codes — `EXIT_CODES` and `signalExitCode` (`src/headless/result.ts`):

| Code | `reason` |
|---|---|
| 0 | `completed` |
| 1 | `boot_failed` — any boot failure but the lock's (the ordinary server's "failed to start" code) |
| 2 | `usage_error` — nothing booted, no lock taken |
| 3 | `conductor_error` — the root exited, crashed, failed to spawn or take its prompt, or its last turn ended in an error |
| 7 | `root_held` — `RootLockHeldError` or `RootLockUnreadableError` (`ROOT_LOCK_HELD_EXIT`, the ordinary server's refusal code too) |
| 128 + n | `signal` — `SIGINT` 130, `SIGTERM` 143 |

`make headless` (docker) collapses every failure to make's own exit 2; `docker/headless.sh` passes the code through ([docker/README.md](../../docker/README.md) → Headless runs).
