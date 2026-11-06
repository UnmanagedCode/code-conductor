# Playbook ledger — on-disk format

The stable record format of `playbook-ledger.jsonl`. Plugins and tools may read the file directly; this doc is its contract. Enforcement, the projection and the read tools are in [protocol.md → Playbooks](protocol.md#playbooks) and [architecture.md → Playbooks](architecture.md#playbooks).

- **Owner of the shapes:** the `LedgerEvent` union in `src/playbookLedger.ts`. A field in a table below that disagrees with the union is a doc bug.
- **Location:** `ledgerFile()` → `<orchStoreRoot()>/playbook-ledger.jsonl`.
- **Encoding:** UTF-8 JSONL, one JSON object per line, append-only (`fs.appendFile`); lines are never rewritten.

## Common fields

| Field | Meaning |
|---|---|
| `seq` | Monotonic per file. Assigned by the ledger; the gate serializes appends through one chain, so no two rows share one. |
| `ts` | ISO-8601 UTC timestamp, taken at append. |
| `kind` | The record kind (below). |

Every `sessionId` / `conductorSessionId` / `forwardSessionId` is a **permanent public sessionId** — the id a worker answers to across respawn, restart, renewal and prune. Optional keys are **omitted**, never `null` or `undefined`; the one explicit `null` is `enforcement.from` on a birth.

## Kinds

**Stage kinds** (they fold into the projection, or are audit-only beside it):

| Kind | Fields | Writer · trigger |
|---|---|---|
| `spawn` | `sessionId`, `playbook`, `stage`, `provenance?` (`{stage: sessionId}`), `project?`, `worktree?` | `commitMove` spawn arm · a `spawn_instance` that binds a new session to a playbook stage. Written at either enforcement level. |
| `transition` | `sessionId`, `from`, `to`, `via` (the tool), `provenance?`, `forwardSessionId?` | `commitMove` transition arms · a legal stage move, or a self-loop the playbook declares (`from === to`). |
| `refusal` | `sessionId?`, `forwardSessionId?`, `tool`, `code`, `reason` | `check` · a call policy refused, recorded at both levels (under `warn` the call proceeds). |
| `enforcement` | `conductorSessionId`, `from` (`string \| null`), `to` | The manager `status` stream · a conductor's first observation (`from: null`, a birth) and every change of its level. `to` is a `PLAYBOOK_ENFORCEMENT_MODES` value (`src/playbooks.ts`). |

**Lifecycle kinds** — written for every conducted session, and for any session tracked by a `spawn` row:

| Kind | Fields | Writer · trigger |
|---|---|---|
| `retire` | `sessionId`, `reason` (`subprocess <status>`) | The manager `status` stream · once per alive→dead edge (`isDeadStatus` in `src/instances.ts`). A repeated dead status (`exited` then `crashed`) is the same death. |
| `resume` | `sessionId` | The manager `session_relaunched` event · every launch that re-enters an existing session and passes its pre-spawn refusal checks: `spawn_instance({resume})`, a UI resume, `respawn`, a restart restore, and the relaunch inside a prune, rewind or model switch. A fresh session writes none. |

**Activity kinds** (`ACTIVITY_KINDS`, `src/playbookLedger.ts`) — a conductor acting on a worker. They fold to no projection state and carry ids and a tool name only, never prompt text:

| Kind | Fields | Writer · trigger |
|---|---|---|
| `interaction` | `tool` (bare tool name), `sessionId`, `conductorSessionId`, `forwardSessionId?` | `commitMove` fall-through · a successful governed call by a conductor to an **interaction tool** (`loadInteractionTools`, `src/playbooks.ts`: tools declaring `sessionId` that are not `readOnlyHint`) that wrote no `transition`. |
| `wake` | `sessionId` (the worker reported on), `conductorSessionId`, `heartbeat?: true` | The manager `wake_delivered` event · a wake stub reached a conductor. `heartbeat: true` marks a "did NOT finish" timeout wake. |

## Semantics for a timeline reader

- **One call event per interaction call.** Each successful conductor call to an interaction tool ends in exactly one `transition` or `interaction`. A refused governed call writes only its `refusal` (under `enforce` no handler runs; under `warn` it proceeds). A handler that throws or soft-refuses (`ok:false`) writes nothing. `spawn_instance` never writes `interaction`: it writes `spawn`, `refusal`, or nothing in the bound-session case below.
- **Calls with no row.** A successful call to a read-only governed tool (`get_recent_messages`, `get_transcript`, `describe_session`, `playbook_state`) writes nothing, and neither does a `spawn_instance` whose result names a session the ledger already holds. Do not read the ledger as a complete log of governed calls.
- **Lifecycle edges.** `retire` follows a death; `resume` follows a re-entry. A rotation that kills and relaunches the process (prune, rewind, model switch) is a `retire` then a `resume`; an in-place rotation (renew, typed `/clear`) writes neither.
- **Ordering.**
  - A `kill_instance` `interaction` follows the `retire` its kill produced.
  - A `resume` for a `spawn_instance({resume})` precedes that call's result, so an adopted resume reads `resume` then `spawn`.
  - A `wake` is written after the stub reaches the conductor.
- **Scope.** Only conductor (`.conduct`) callers produce `interaction` and `wake`; a worker's own calls leave no row.

## Reader rules

- Ignore unknown `kind`s and unknown fields.
- Skip a malformed or torn line (`readEvents` warns and continues).
- Treat `seq` as the order; `ts` is informational.

## Stability

Additions (a kind, an optional field) are additive. Renaming or removing a kind or field ships with a migration under `migrations/`.

## Known limits

- No row for a death this process never observed (a host reboot).
- No `wake` row when the woken worker has left the registry with no recorded exit.
- A `resume` is written when a launch begins, after its pre-spawn refusal checks. A launch that fails afterwards (a failed FUSE mount, an immediate crash) leaves a `resume` followed by a `retire`.
