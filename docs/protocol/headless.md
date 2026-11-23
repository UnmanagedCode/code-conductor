# Protocol: the headless run's output

## Headless run result
A headless run (`node server.ts --prompt …`, [features/conduct.md](../features/conduct.md) → Headless mode) ends with one result, on every outcome — usage errors and unexpected failures included — and exits with its `exitCode`. Everything else the process prints goes to stderr. Under `--output-format json` (the default) stdout carries **exactly one JSON object, on one line**, built by `formatResult` (`src/headless/result.ts`). `text` prints only the result's text; `stream-json` prints the live CLI lines and then the result as a `cc_result` line ([Output formats](#output-formats)). The exit codes are the same in every format.

```json
{"reason":"completed","exitCode":0,"sessionId":"…","text":"…","costUsd":0.0123,"durationMs":84211,"error":null}
```

| Field | Type | Meaning |
|---|---|---|
| `reason` | string | `completed` \| `conductor_error` \| `signal` \| `usage_error` \| `root_held` \| `boot_failed`; a `--view` replay also `stopped` \| `no_session` |
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
| 4 | `no_session` — `--view` only: no session to show |
| 7 | `root_held` — `RootLockHeldError` or `RootLockUnreadableError` (`ROOT_LOCK_HELD_EXIT`, the ordinary server's refusal code too) |
| 128 + n | `signal` — `SIGINT` 130, `SIGTERM` 143 |

`stopped` (`--view` only) is a replay's normal end on `SIGINT` / `SIGTERM` and exits 0 ([Replay result](#replay-result)).

## Replay result
`node server.ts --view` ([features/conduct.md](../features/conduct.md) → Headless mode) writes the same one-line object, always in `json`, on every outcome, and takes the exit codes above. `stopped` carries the shown `sessionId` (null when the signal came before one was picked) and null `text`, `costUsd`, `durationMs` and `error`. `no_session` carries the refusal as `error`. `usage_error`, `root_held` and `boot_failed` are as in a run. Its stderr names the session (`headless: viewing session <id> (view-only)`).

`make headless` (docker) collapses every failure to make's own exit 2; `docker/headless.sh` passes the code through ([docker/README.md](../../docker/README.md) → Headless runs).

## Output formats
`--output-format` picks what stdout carries; `renderResult` (`src/headless/result.ts`) renders the result, `OUTPUT_FORMATS` lists the values.

| Format | Stdout | Stderr extra |
|---|---|---|
| `json` (default) | The one result object above, byte for byte. | — |
| `text` | The result's `text` and a newline; nothing at all when `text` is null. | `headless: <reason>: <error>` when `error` is non-null. |
| `stream-json` | The root CLI's stdout lines as they arrive, then one `cc_result` line. | — |

**`stream-json`** (`src/headless/stream.ts`)
- **The lines:** the root conductor CLI's raw stdout lines, verbatim — byte for byte, whatever they hold, non-JSON included — each followed by `\n`. Whole lines only: the CLI's line splitting (Node `readline`) takes `\n`, `\r\n` and a lone `\r` as line ends, so no streamed line holds a CR or LF.
- **Across launches:** the same root's lines keep streaming across a `/clear` renewal (a new `system/init` with a new CLI `session_id`), a respawn, a model switch, a rewind or a prune, and a line the old launch delivers after the new one started. Order is per launch; lines of two overlapping launches interleave in arrival order.
- **The final line:** `{"type":"cc_result",…}` — `type` first, then the result's fields in the table's order, with the same values. Marked `cc_result`, not `result`, because the CLI writes its own `type:"result"` line at every turn end. It carries no `cc_*` labels; its `sessionId` names the root. Nothing is written after it.
- **Early failures** (usage, lock, boot) write only the `cc_result` line.
- **Consumers ignore unknown `type`s**: the CLI's own line types are not cc's to fix.

**`--include-workers`** (only with `stream-json`) streams every session in the run's tree, each line labelled.
- **Membership:** the tree `InstanceManager.isTreeQuiescent` judges (`runTreeIds`, `inRunTree`): the root, every conducted session attributed to the root at create (`rootSessionId`, so a grandchild whose section lead has left still counts), and everything those own transitively. A session admitted once streams for the rest of the run, even after it leaves the tree. A session found outside is re-checked on its next line after any manager `status` or `subscription_changed` event (a dispatch from a tree member brings one in before its turn's lines).
- **Labels** — read from the instance when the line arrives, never from the line. Every key in the table is always present; a missing value is JSON `null`, never an absent key.

| Field | Value |
|---|---|
| `cc_session_id` | The session's cc public id — stable when the CLI's `session_id` rotates on `/clear`. |
| `cc_parent_session_id` | The public id of the conductor that spawned or resumed it, or `null`. |
| `cc_root_session_id` | The run root's public id. |
| `cc_role` | `conductor` for a `.conduct` session — the root and section leads — else `worker`. |
| `cc_project` | The session's project. |
| `cc_worktree` | Its worktree's name, or `null`. |

- **Insertion** (`labelLine`): a line `JSON.parse` reads as a plain object keeps its own bytes up to its closing `}` (number formatting and big integers survive); trailing JSON whitespace is dropped and the labels are appended as its last keys — no leading comma for `{}`. A CLI key of the same name comes earlier, so cc's wins under JSON's last-wins rule.
- **Anything else** — not JSON, or an array, string, number, boolean or `null` — becomes `{"type":"cc_raw","line":"<the original text>",<labels>}`.

**Backpressure and a closed stdout**
- **The CLIs are never paused.** Node buffers what the consumer hasn't read yet; below the cap, a slow consumer does not affect the run.
- **Past `STREAM_STDOUT_CAP_BYTES`** (`src/headless/stream.ts`) unflushed bytes, streaming stops — no later line is written — and the run ends `conductor_error`, its error naming the lag. The `cc_result` line is still written, but may itself wait in the buffer: the process exits once it is flushed, so a consumer that never reads keeps the process alive until a signal (which, after the result, kills it).
- **A closed stdout (EPIPE, or any write error):** mid-run, the run ends `conductor_error` (exit 3) with nothing more written; while the result is being written, the process exits with that result's code. No `cc_result` line is delivered either way; stderr says `headless: the result was not delivered: stdout closed (<code>)`.
- `json` and `text` are unchanged on a live pipe.
