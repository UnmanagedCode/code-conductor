# Event log — on-disk format

The stable record format of `events.jsonl`: every governed conductor call, every session's lifecycle, conducted turns, wakes and enforcement changes, in one file. Plugins and tools may read the file directly; this doc is its contract. Enforcement, the playbook projection and the read tools are in [protocol.md → Playbooks](protocol.md#playbooks) and [architecture.md → Playbooks](architecture.md#playbooks).

- **Owner of the shapes:** the `EventRow` union in `src/eventLog.ts`. A field in a table below that disagrees with the union is a doc bug.
- **Location:** `eventLogFile()` → `<orchStoreRoot()>/events.jsonl`.
- **Encoding:** UTF-8 JSONL, one JSON object per line, append-only; lines are never rewritten. Rows from one write (e.g. a turn end and the exit that caused it) are appended in one call and are adjacent.
- **Version:** `v` = `EVENT_LOG_VERSION` (`src/eventLog.ts`).

## Envelope

Every row carries these keys, serialised first and in this order:

| Field | Meaning |
|---|---|
| `v` | Format version. |
| `ts` | ISO-8601 UTC timestamp, taken at the write. Rows of one write share it. |
| `kind` | `call` · `session` · `turn` · `wake` · `config` (below). |
| `actor` | Who caused the row: `{type:'conductor', sessionId?}`, `{type:'human'}` or `{type:'system'}`. |
| `subject` | The session the row is about — a **permanent public sessionId**, the id a session answers to across respawn, restart, renewal and prune. |

- **The one `subject` exception:** a `call` to `spawn_instance` that produced no session — a fresh spawn refused, or one whose handler failed — has no `subject`. A `spawn_instance({resume})` row's subject is the resumed session, whatever its outcome.
- Optional keys are **omitted** when unset, never `null` or `undefined`.
- No row carries prompt text. `failure.reason` is capped at `FAILURE_REASON_MAX` characters (`src/mcp/playbookGate.ts`) and taken only from a handler's `reason` or an error's message.
- There is no sequence number: **order is line order**.

## Actor

| `type` | When | `sessionId` |
|---|---|---|
| `conductor` | A `call` row (the MCP caller); a `session` `start`/`resume` from `spawn_instance`; a `session` `exit` from `kill_instance`; a `turn` `start` whose prompt had `author:'conductor'` | `call`: the caller. `session`: the MCP caller. `turn`: the worker's root conductor (`rootOwnerSessionId`). Absent only on migrated rows. |
| `human` | A `session` `start`/`resume` from `POST /api/instances` (new or `resume`), `POST /api/instances/:id/fork` or `POST /api/instances/:id/respawn`, and from a headless run; a `session` `exit` from the UI (`kill` over the WebSocket, `DELETE /api/instances/:id`, the project/worktree deletion routes); a `turn` `start` whose prompt had `author:'human'`; a `config` change from the UI toggle (`playbook_enforcement` over the WebSocket) | — |
| `system` | Everything else: crashes and spontaneous exits, restore after restart, prune/rewind/model-switch relaunches, unprompted turns and turns an orchestrator-injected (`internal`) prompt started (an idle-wake stub, the overage auto-resume), every `turn` `end`, every `wake`, every `config` birth | — |

A human steer mid-turn starts no turn and writes nothing. A UI interrupt writes nothing itself; the `turn` `end` records the stop. Who asked for a prune, rewind or model switch is not recorded on the `session` row (its `cause` says what happened); a conductor-initiated one also has its own `call` row.

## Kinds

| Kind | Fields (beyond the envelope) | Writer · trigger |
|---|---|---|
| `call` | `tool` (bare tool name), `outcome` (`ok` · `refused` · `failed`), `refusal?: {code, reason}` (on `refused`), `failure?: {code?, reason}` (on `failed`), `forward?` (send_prompt's forward source), `move?: {from, to, provenance?}`, `bind?: {playbook, stage, provenance?, project?, worktree?}` | The playbook gate (`check` / `commit` / `fail`, `src/mcp/playbookGate.ts`) · a governed tools/call by a conductor — see "Calls" below. `provenance` is `{stage: sessionId}`. |
| `session` | `event` (`start` · `resume` · `exit`), `cause?` | The manager's `session_launched` / `session_exited` (`src/mcp/sessionRecorder.ts`) · **every** session: each announced launch (`Instance.launch`, after its pre-spawn refusal checks) and each alive→dead edge (`Instance._setStatus`). |
| `turn` | `event` (`start` · `end`), `stopReason?` (on `end`: the CLI's `stop_reason`) | The manager's `turn_started` / `turn_ended` · conductors and conducted workers only. An `end` with no `stopReason` is synthesized for a death mid-turn. |
| `wake` | `recipient` (the woken conductor's sessionId), `heartbeat?: true` | The manager's `wake_delivered` · a wake stub reached a conductor; `subject` is the worker it reports on. `heartbeat: true` marks a "did NOT finish" timeout wake. |
| `config` | `key` (`enforcement`), `from?`, `to` | The manager's `session_launched` (a **birth**: no `from`) and `enforcement_changed` (`from` = the level the log last recorded) · a conductor's playbook-enforcement level. `to`/`from` are `PLAYBOOK_ENFORCEMENT_MODES` values (`src/playbooks.ts`), or a level a migrated row carried. |

**`session` causes:**

| `event` | `cause` |
|---|---|
| `start` | `fork` for a fork's new session; absent for a fresh spawn. |
| `resume` | `respawn` · `restore` (restart restore) · `prune` · `rewind` · `model-switch`; absent for a plain `create({resume})` (UI resume or `spawn_instance({resume})`). |
| `exit` | `exited` · `crashed`; `orphaned` on migrated rows only. |

## Calls

- **Exactly one `call` per governed call** that is refused, and per governed interaction call or `spawn_instance` that runs. "Governed" = a conductor (`.conduct`) caller and a tool in the governable set (tools declaring `sessionId`, plus `spawn_instance`). An **interaction tool** declares `sessionId` and is not `readOnlyHint` (`loadInteractionTools`, `src/playbooks.ts`).
  - `refused` — policy refused it, at either enforcement level (under `warn` the call proceeds and this row is its only row). Any governable tool, read-only ones included.
  - `failed` — the handler returned `ok:false` or threw. No `move`, no `bind`.
  - `ok` — the handler succeeded.
- **Calls with no row:** a governed read-only call that is not refused (`get_recent_messages`, `get_transcript`, `describe_session`, `playbook_state`); a call transport-refused before policy (bad arguments, an ambiguous prefix); a call by a non-conductor; an unrefused interaction call naming no `sessionId`.
- **`move`** is present only when the stage changed: `from !== to` always. A same-stage `send_prompt` — declared self-loop or not — has no `move`.
- **`bind`** is present on a `spawn_instance` that bound a session to a playbook stage, at either enforcement level, and only when the session was not already bound (a spawn whose result names an already-bound session writes its `call` without `bind`). A second `bind` for one session replaces its state.

## Semantics for a timeline reader

- **Playbook state** folds from `call` rows (`bind` replaces, `move` advances and merges `provenance`) and `config` rows (`to`). `stageHistory` is the sequence of stage **changes**: it never repeats a stage twice in a row, however many rounds a worker spent in it.
- **Lifecycle.** A rotation that kills and relaunches the process (prune, rewind, model switch) is an `exit` then a `resume` with that cause; an in-place rotation (renew, typed `/clear`) writes neither.
- **Ordering.**
  - A `kill_instance` `call` follows the `exit` its kill produced.
  - The `session` `resume` for a `spawn_instance({resume})` precedes that call's `call` row; a fresh spawn's `session` `start` precedes its `call`.
  - A conductor's `config` birth directly follows its first `session` row.
  - A synthesized `turn` `end` directly precedes the `exit` of the death that interrupted the turn.
  - A `wake` is written after the stub reaches the conductor.
- **Turns** are recorded for conductors and conducted workers only; a plain UI session's turns are not.

## Reader rules

- Order is line order; `ts` is informational.
- Ignore unknown fields.
- Skip a malformed or torn line, a non-object, another `v` and an unknown `kind` (`readEventLog` warns and continues).

## The writer

- One writer per projects root: the server holding the projects-root lock ([architecture.md → The projects-root lock](architecture.md#the-projects-root-lock)). Each append runs `RootLock.writerCheck()` and the write in one synchronous step; it fails once the lock is released, a newer server holds the root, the lock record is no longer this server's, or a restart handover has been offered.
- A refused write is **dropped**, never queued or retried: `console.error` once per blocked episode, a `console.warn` per dropped row, an `event_log_blocked` bubble in the transcript of the live conductor the first dropped row names (its actor, else its subject), and a `console.log` when writing resumes.
- A server built without the lock (`createServer` with no `relaunch.rootLock`) writes nothing, loudly; `createServer`'s `eventLogLease` option overrides the lease for tests.

## Stability

Additions (a kind, an optional field) are additive and keep `v`. Renaming or removing a kind or field bumps `v` and ships with a migration under `migrations/`.

## Known limits

- No `exit` and no closing `turn` `end` for a death this process never observed (a host reboot).
- Rows the old server observes after offering a restart handover (exits of the workers it tears down) are dropped and logged, never written.
- A `session` `start`/`resume` is written when a launch begins, after its pre-spawn refusal checks. A launch that fails afterwards (a failed FUSE mount, an immediate crash) leaves it followed by an `exit`.
- No `wake` row when the woken worker has left the registry with no recorded exit.
- **Migrated rows** (migration `0041-event-log`): their `call` rows carry `actor: {type:'conductor'}` with no `sessionId` unless the source row named the conductor; their `session`, `config` and `wake` rows are `system`; a same-stage round carries no `move`; there are no `turn` rows and no `session` `start` for sessions that began before the migration.
