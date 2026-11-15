# Protocol: playbooks

## Playbooks

A **playbook** is a JSON graph of **stages** a worker is bound to. The conductor declares its intent on the calls that create or move workers; the server verifies the move against the graph and records the call in the event log ([event-log.md](../event-log.md)). Definitions: built-ins in `playbooks/*.json`, user overlay in `<store>/playbooks/*.json`, and enabled plugins' `playbooks` (ids `<plugin-id>/<slug>` — manifest schema, freshness and disable semantics in [plugins/manifest.md](../plugins/manifest.md)). Schema, validator and the policy decision live in `src/playbooks.ts`; the conductor reads a graph via `describe_playbook` — it is deliberately **not** restated in prose here or in any prompt.

**Scope.** A stage governs two scopes of call, one key each:
- **`tools` — the conductor's calls that address a worker in the stage.** Applies only when the caller resolves to the conductor (`isConductorInstance`, `src/conduct.ts`) — a worker is not offered the tools it governs (core tool audience, see [Tool audience](mcp.md#mcp-tool-protocol)). The rest of this paragraph and the sections below through the read tools are about this scope.
- **`workerTools` — the bound session's OWN calls**, any tool name, checked live by the PreToolUse hook. See [Worker tools](#worker-tools-workertools).

Within the `tools` scope, a tool is **governable** iff its `inputSchema` declares a `sessionId` (plus `spawn_instance`, governed by the stage being *entered*). A tool declaring no `sessionId` names no worker for a policy to be read from, so it can never appear in a stage's `tools` map and is ungoverned; that gap is accepted. The membership of that class is computed from `buildTools()` by `governableToolNames()` and is deliberately not enumerated anywhere — a hand-maintained copy would drift.

**Subjects.** A governed call is checked once per worker it names, each against the tool describing what is done to *that* worker. `send_prompt`'s target is checked for `send_prompt` (plus its move); its `forward.sessionId` **source** is checked for **`get_recent_messages`** — the read a forward actually performs (`selectRecentMessages`, `src/mcp/handlers.ts`) — and for permission only: no move, no `needs`, no `pin`, since `stage`/`provenance` on that call belong to the target. So `forward` is **not** an exception to the governable-set rule above: it is an existing governable tool evaluated against a second subject, and a stage's `tools` map still names only tools that take a `sessionId`. The subject list matches, one for one, the places `dispatch()` prefix-resolves a handle it will then **check** (`sessionId`, each `provenance` value, `forward.sessionId`) — kept identical deliberately, since a handle policy cannot see is a handle policy cannot govern. The fourth resolution site, `spawn_instance`'s `resume`, is not a subject: `decideSpawn` reads it to find that worker's **existing** binding, not to check a second worker.

**New tool arguments.**

| Tool | Argument | Meaning |
|---|---|---|
| `spawn_instance` | `playbook` | Required on a **run root** (a spawn with no `provenance`); inherited from the `provenance` ancestors otherwise, and a conflicting value is `PLAYBOOK_MISMATCH`. |
| `spawn_instance` | `stage` | The stage to enter. It must declare `spawn_instance` (else `STAGE_NOT_SPAWNABLE`) — that tool is the one that **fails closed**, and a `"*"` wildcard confers no spawnability. |
| `spawn_instance` | `provenance` | `{"<stage>": "<sessionId>"}` — the workers satisfying the entered stage's `needs`. |
| `spawn_instance` | `resume` | Not a policy argument, but it **decides which rules apply**: resuming a playbook-tracked session inherits its recorded `playbook`+`stage` and is not a run root. See [Resuming a playbook-tracked worker](#resuming-a-playbook-tracked-worker). |
| `send_prompt` | `stage` | **Always** carried. Equal to the worker's current stage ⇒ a **self-edge**: always legal and never subject to the destination's `needs`; it moves nothing, so its `call` row carries no `move`, whether or not the playbook declares that self-loop (a declared self-loop is a no-op). Different ⇒ a transition checked against the edge set. |
| `send_prompt` | `provenance` | Satisfies the **destination** stage's `needs`, since a stage's entry conditions apply however it is entered. |
| `send_prompt` | `forward.sessionId` | The forward **source** — a second policy subject, checked for `get_recent_messages` against its own current stage (`FORWARD_DENIED_IN_STAGE`). Permission only; never checked for run membership — see Known limitations. |

**Optional `description`.** Every **stage** and every **transition** accepts an optional `description` string: conductor-facing intent — the conductor's *move* at that stage and what it expects back. Never a restatement of `tools`/`needs`/the graph, which are enforced and already returned by `describe_playbook`. Rejected at load (`readDescription`, `src/playbooks.ts`) if present and not a non-empty string; **no length limit** — the gate is editorial. Present iff authored: an unauthored description makes `describe_playbook` emit **no line at all** for it (no label, no `—`), so absence is legible in the text rather than signalled by an empty value. Authored text is rendered **verbatim** under a `description` label, indented one level deeper than the stage's own fields — never reflowed or truncated. The label and indent mark where the rendering ends and the author's text begins; they cannot disambiguate prose that is itself indented into a field column, which is contained editorially by the "never a restatement of the graph" rule above, not by the renderer. `list_playbooks` and the composed prompt's playbook listing (`playbookListing`, `src/conductorConventions.ts`) carry the **top-level** playbook description only. A transition `description` is reserved for the rare edge whose move is not already implied by the destination stage's `description` + `needs`. The built-ins are the templates to copy: **every** stage carries one, **no** transition does (pinned by `tests/playbook-schema.test.mjs`).

**The preferred-playbook convention.** Settings → Conventions → Conductor selects a **preferred playbook**, stored **globally** as the `defaultPlaybook` sibling key in `<store>/conventions/conductor.json` (the conductor is a singleton, and `composeCurrentConduct()` takes no instance argument — it runs before the instance exists). The selection is **tri-state** (`DefaultPlaybookSelection`, `src/conductorConventions.ts`), because never having chosen is not the same as having chosen nothing: **unset** — the key's *absence*, the only representation of that state — resolves to `DEFAULT_PLAYBOOK_ID` (`src/playbooks.ts`); `{"mode":"none"}` is the explicit opt-out that injects nothing; `{"mode":"playbook","id"}` names one. `resolveDefaultPlaybookId()` is the single home of the fallback. A project's convention selection follows the same never-chosen ≠ chosen-nothing rule (`ProjectConventionSelection`, `src/projectClaudeMd.ts`). Only the **write** is validated against the loaded definitions: a stored id that stops resolving (a disabled plugin's playbook, a deleted overlay file) is **retained**, renders nothing meanwhile, is reported as `defaultPlaybookMissing` in the Settings payload, and applies again once it loads. Migration 0028 converts the older `<id>|null` shape, mapping a legacy `null` to **unset** (nobody who predates the tri-state chose the opt-out). At compose time its definition is **rendered** into the role prompt by `renderPlaybookConvention` (`src/playbookConvention.ts`): a `## Preferred playbook — \`<id>\`` header, one bullet per stage carrying `**<stage>**` + a parenthesised, `; `-joined flag list (`many workers` when `workers:"many"`; `pins <arg>=<JSON>, …` from the stage's `spawn_instance` pin, in the `ARG_PIN_CONFLICT` reason's form) + the authored `description` **verbatim**, and a closing transition list with `via = on ?? send_prompt`. **Generated, never hand-authored** — that is what makes drift from the enforced graph impossible.

**What the section carries is decided by one rule: push into the system prompt exactly the facts with no channel that fires on its own; leave in the payload every fact a refusal or a pre-resolved field volunteers unasked.**
So rendered: the stage `description` (nothing volunteers it, and it is needed to compose a brief *before* any call — a bad brief yields a soft review, never a refusal), `workers:"many"` (no refusal until `STAGE_AT_CAPACITY` has already fired, and it shapes a fan-out decision made before any call), the stage's `spawn_instance` pin (`ARG_PIN_CONFLICT` fires only after the conductor has chosen the argument, and the "Model choice" convention has it choose `model` before any call), and the transitions (a shape error is expensive and non-local, unlike a refused call).
Deliberately **not** rendered: the rest of the `tools` policy (`TOOL_DENIED_IN_STAGE` ships it with `legalMoves`), `needs` (`NEEDS_UNSATISFIED` names what to pass), spawnability (`STAGE_NOT_SPAWNABLE`, plus `list_playbooks`' `spawnableStages` and the `spawnable yes|no` `describe_playbook` renders per stage), `entryStages` (a spawn is gated by `isSpawnable`, not by entry-stage membership), and the top-level description + a `describe_playbook` pointer (the available-playbooks listing sits directly above in the same prompt and carries both — an **order the composed-prompt test pins**).
Each omitted fact arrives at point of use and cannot go stale under a live worker, which a spawn-time snapshot can: definitions are not pinned to a run (see Known limitations).
Absent on the explicit `none`, when the selected id no longer resolves, or when the `playbooks` convention is off (the section rides that toggle, like the available-playbooks listing).
**Freshness:** every input to this section is read **per compose** — the built-in `playbooks/*.json` definitions (through `fragmentCatalog`'s `seedExt: '.json'` catalog, whose seed bodies are never memoised), the user overlay at `<store>/playbooks/*.json`, and the selection itself.
An edit to any of them reaches the next conductor spawned, with **no orchestrator restart**, exactly like a `conventions/*.md` edit.
The exception is a **plugin** playbook: its body is held on the plugin's manifest, read at manifest load, so an edit reaches the section only after that manifest is re-read — see the freshness bullet under `playbooks` in [plugins/manifest.md](../plugins/manifest.md).

#### Worker tools (`workerTools`)

A stage's `workerTools` governs the **bound session's own tool calls** — the worker's, its subagents' (they run in its CLI process and post to its hook URL; `agent_id` is ignored), and a section lead's own calls (it is a bound session in stage `section-lead`). It is separate from `tools`, which governs the conductor's calls on the worker. Enforced by the worker-tools PreToolUse entry (hooks list above, entry 4) → `POST /api/instances/:id/hook-callback?policy=worker-tools` → `PlaybookGate.checkWorkerTool` (`src/mcp/playbookGate.ts`) → `resolveWorkerTool` (`src/playbooks.ts`).

**Schema.** `"workerTools": {"<pattern>": "allow" | "deny", …}`; absent ⇒ `{}`, and an unlisted tool is allowed. Validated at load by `validateWorkerTools`; a malformed map rejects the **whole definition** (never loaded weaker than written), every message prefixed `stage '<name>':`.
- **Keys:** `WORKER_TOOL_PATTERN_RE` (`^[A-Za-z0-9_*-]+$`). `*` is the only wildcard and matches any run of characters (`__` included); there is no regex, and a permission-rule spelling such as `Bash(git:*)` is refused. Matching is against the **raw** tool name the CLI reports (`Edit`, `mcp__code-conductor__code-kanban__move_card`) — anchored at both ends, case-sensitive, never normalised (a bare `send_prompt` matches nothing; write `mcp__code-conductor__send_prompt`). A bare `"*"` is the fallback entry.
- **Values:** exactly `"allow"` or `"deny"`. No `pin`; an object value is refused with a message saying `workerTools` takes allow/deny only.
- **Exempt tools:** `WORKER_TOOLS_EXEMPT` (`src/playbooks.ts`) — `AskUserQuestion` and `ExitPlanMode` — are **always allowed**, so a worker can present a plan and ask a question in any stage. An explicit `"deny"` on an exempt tool's exact name is refused at load; a wildcard that covers one is accepted and the exemption wins.
- No check that a key names a real tool — the universe (plugin MCP tools, the CLI's built-ins per version) is not knowable at load. A typo denies nothing (Known limitations).

**Resolution** (`resolveWorkerTool`), first that applies:
1. An exempt tool → allow.
2. An **exact key** (no `*`) equal to the tool name.
3. The **longest** matching pattern other than the bare `"*"`. Equal-length matches that disagree → **deny**.
4. The `"*"` entry.
5. Allow.

`resolveWorkerTool` returns the deciding key, which the denial names (it may be `'*'`). `"allow"` means only that this policy has no objection: the hook answers `{}`, never an explicit allow.

Allow-list example — a read-only reviewer: `{"*": "deny", "Read": "allow", "Grep": "allow", "Glob": "allow"}` (`Edit` → denied by `'*'`; `Read` → allowed by `'Read'`). Specificity example: `{"mcp__code-conductor__code-kanban__*": "allow", "mcp__code-conductor__code-kanban__move*": "deny"}` denies `mcp__code-conductor__code-kanban__move_card` and allows `mcp__code-conductor__code-kanban__read_card`.

**Per call** (`checkWorkerTool({sessionId, parentSessionId, toolName})`; the route passes the URL's instance's `sessionId` and its `parentSessionId` — the recorded spawner, or the MCP caller that last resumed it):

| Case | Hook answer | Event log | UI |
|---|---|---|---|
| Unbound / untracked session | `{}` | nothing | nothing |
| Bound, resolves to allow | `{}` | nothing | nothing |
| Bound, resolves to deny, level `enforce` | `deny` + reason | one `call` row: `actor {type:'worker', sessionId}`, `subject` = the worker, `tool` = the raw name, `outcome:'refused'`, `refusal.code:'WORKER_TOOL_DENIED_IN_STAGE'` | nothing |
| Bound, resolves to deny, level `warn` | `{}` | the same row | a `system`/`playbook_warn` bubble (`data: {tool, code, reason, sessionId}`) in the live owner conductor's transcript, if there is one |
| Bound, but its playbook or stage is not loaded (definition drift) | `{}` | nothing | `console.warn` once per (session, playbook, stage) |
| The event log cannot be loaded, or anything else throws | `{}` | nothing | `console.warn` with the error |

- **Level:** the owner's live conductor instance's `playbookEnforcement`; else the owner's level folded from the log's `config` rows; else the Settings default (`getDefaultPlaybookEnforcement`, `src/conductorConventions.ts`) — which covers a bound worker with no recorded parent (a worker resumed from the sidebar by a human keeps its recorded parent, so its owner's level applies).
- **Reason** (`workerToolDeniedReason`): `cc playbook policy: stage '<stage>' of playbook '<playbook>' does not let its worker call <tool> (denied by workerTools entry '<key>'). Retrying is refused the same way. Do this step with a tool the stage allows, or report that it needs <tool> and stop.`
- **Liveness:** the binding (from the in-memory projection) and the definition (`loadPlaybooks()`) are read per call, so a `move` or an edit to the definition governs the worker's **next** tool call, with no relaunch.
- **Cost** (measured with `curl` against a running cc on one host): a hook-callback round trip for an unknown instance takes 0.5–1.0 ms, and `GET /api/playbooks` (a full `loadPlaybooks()` + tool-index load) takes 0.85–2.1 ms. So an unbound session pays under 1 ms per tool call (one Map lookup, no disk read) and a bound one about 2 ms; on `Edit`/`Write`/`Bash`, already hooked, the entries run in parallel.
- **Not rendered** into the conductor's role prompt (`renderPlaybookConvention`): the worker meets a denial at the point of use, and `describe_playbook` reports the map.

#### Resuming a playbook-tracked worker

**A resume is not a stage entry.** `spawn_instance({resume})` where the resumed sessionId is in the playbook projection inherits that session's recorded `playbook` + `stage` (`decideResume`, `src/playbooks.ts`) — alongside the project + worktree already recovered from the session record — so the **bare** `spawn_instance({resume:sessionId})` the `SESSION_NOT_LIVE` refusal names is sufficient, and needs neither argument. The worker is coming back to where it already is, so the entered-stage checks do not run: no `isSpawnable` (forced rather than chosen — it would refuse a worker that transitioned into a transition-only stage and then died), no `needs`, no capacity count. **`pin` is the one that splits.** Its **spawn-shape** keys — `createWorktree`, `baseWorktree`, `name`, `model`, `backend`, `title` (`SPAWN_SHAPE_PINS`, `src/playbooks.ts`) — are dropped, because each describes how to *create* a process (`title` names the session at birth; re-asserting it would undo a later rename) and a resume's subject already exists; injecting `createWorktree` is what hands a resumed session a fresh worktree, at a cwd that by construction holds none of its history. Every **other** pinned key still applies, filled or `ARG_PIN_CONFLICT`-refused exactly as on a spawn. That half is load-bearing, not tidiness: with no pinned `mode` and none supplied, `_doCreateResolved` falls back to `effectiveResumeMode(null)` = `DEFAULT_RESUME_MODE`, i.e. **`bypassPermissions`** (`src/sessionModes.ts`) — so skipping it would widen an adopted session inside a stage that asked for something narrower. The set enumerates what to **strip**, so a newly pinned key stays enforced by default. The same rule applies to an **adopted** resume (one the projection holds nothing for, declaring `playbook` + `stage`), so there is one rule rather than two. `patchedArgs` is the caller's **own args object** whenever the policy remainder is empty, which is the common case.

A supplied binding is therefore **checked, not applied** — match-or-refuse, the same rule and the same `PLAYBOOK_MISMATCH` code a non-root spawn uses for an inherited playbook. `playbook` and `stage` are compared **independently** (a matching playbook with a differing stage is still a conflict) and the refusal prints **both** the recorded pair and the supplied one, so one round-trip is enough to retry legally. A `provenance` map alongside a tracked resume is likewise `PLAYBOOK_MISMATCH`: a resume enters no stage, so it satisfies no `needs`.

The `session` `resume` row is written by the manager's launch stream; this call's own `call` row names the resumed session and never carries a `bind` — a bind would reset `stageHistory` and empty `provenance` (see [components/playbooks.md](../components/playbooks.md#playbooks)). Two cases still refuse: a resume of a session the projection holds **nothing** for is `PLAYBOOK_UNKNOWN` and must name `playbook` + `stage` like any run root (its reason names that case specifically), and a session whose recorded playbook is **no longer loaded** is `PLAYBOOK_UNKNOWN` for the same definition-drift reason a targeted call is. A recorded *stage* that no longer exists is not checked here (nothing on this path reads it); the next `send_prompt` reports `STAGE_UNKNOWN`.

`provenance` values are sessionIds and get the same **prefix resolution** as a top-level `sessionId` (schema-driven, so any tool declaring `provenance` is covered); an ambiguous one soft-refuses `SESSION_AMBIGUOUS` naming the `provenance.<stage>` entry.

**The policy step in `tools/call`.** One checkpoint in `dispatch()` (`src/mcp/server.ts`), **after** `validateArgs` and after every prefix-resolution pass, **before** `tool.handler`. Refusals use the established soft shape — `{ok:false, code, reason, legalMoves, playbookEnforcement:"enforce"}`, `isError:false`, never thrown — because there is no server→client notification channel, so a conductor's tool list is fetched once and a denied tool cannot be hidden; every refusal therefore carries the way forward. Codes: `PLAYBOOK_UNKNOWN`, `STAGE_UNKNOWN`, `STAGE_NOT_SPAWNABLE`, `TRANSITION_ILLEGAL`, `NEEDS_UNSATISFIED`, `NEEDS_WORKER_GONE`, `ARG_PIN_CONFLICT`, `TOOL_DENIED_IN_STAGE`, `STAGE_AT_CAPACITY`, `PLAYBOOK_MISMATCH`, `FORWARD_DENIED_IN_STAGE`. `STAGE_AT_CAPACITY`'s `reason` names the blocking sessionId and a working recovery (`kill_instance({sessionId})` for a worker that is actually still running, or a `workers:"many"` playbook). Capacity counts **live processes** (`InstanceManager.isSessionLive`, see [components/playbooks.md](../components/playbooks.md#playbooks)), not an event-log-side flag, so a slot held by a session the orchestrator no longer knows about (e.g. after a host reboot) reads free on the very next check — it can never wedge a run permanently, and there is no boot-time repair step for it to wait on.

Because a spawn's `bind` needs the new worker's sessionId — which does not exist until the handler has run — the checkpoint is **check-before / commit-after**: `check()` decides, and `commit(result)` or `fail(err)` records.
**Exactly one `call` row per governed call** that is refused (either level, any governable tool) or that runs as an interaction call or `spawn_instance`: `outcome` `refused` (written by `check()`; under `warn` the call proceeds with no further row), `failed` (an `ok:false` result, or a throw caught by the call core's catch in `runToolSteps` (`src/mcp/server.ts`, reached through `runTool` from both `dispatch` and the REST alias) before any result — `failure: {code?, reason}`, the reason from the result's `reason` or the error's message, capped at `FAILURE_REASON_MAX`), or `ok`.
A `failed` row carries no `move` and no `bind`: the move did not happen.
A governed read-only call that is not refused writes no row.
The commit reads the session off the **result**, not the arguments, and re-checks it there: a `spawn_instance` whose result names a session the projection **already holds** writes its `call` row **without** `bind` (`commitCall`, `src/mcp/playbookGate.ts`), decided **inside** the serialized append chain so two concurrent commits on one sessionId cannot both read "unbound" — the decision layer was handed an id it could not place, and a bind would reset that worker's `stage`, `stageHistory` and `provenance`.
A real stage move carries `move: {from, to, provenance?}`, re-checked inside the chain: it is written only while the worker still holds `from`, so a second call decided against the same stage writes its row without `move`.
A `send_prompt` row carries `forward` (the forward source's sessionId, resolved at the transport's prefix chokepoint like every other worker handle) whenever the call carried `forward`; the key is absent otherwise, and it reaches callers through `playbook_state`'s `history`.
Row shapes and ordering: [event-log.md](../event-log.md).

**Read tools.** `list_playbooks` (ids, names, descriptions, entry + spawnable stages, `plugin` naming the owner on a plugin-contributed playbook, plus `errors` for definitions rejected at load — JSON, because `errors` is structured data), `describe_playbook({id})` (the full graph, as **plain text** in the text format — see [Rendered read results](mcp-results.md#rendered-read-results)), `playbook_state({sessionId?})` (the run graph, legal next moves, and the run's history — its members' event-log `call` and `session` rows plus the caller's own `config` rows, in line order; `turn` and `wake` rows are not included; for a worker whose playbook is no longer loaded, `playbookMissing: "<id>"` plus a `reason` naming the cause — for a plugin playbook, the owning plugin and where to look to tell the possible causes apart — `list_playbooks` → `errors`, or the plugin's Settings → Plugins row when its manifest is invalid as a whole; a conductor at `enforce` gets the targeted call refused `PLAYBOOK_UNKNOWN` with the same cause instead, since the call names that worker). All three are read-only in the strong sense: on an install with no event log they answer with empty state and **create no file**. The REST routes ([REST — `/api/playbooks`](#rest--apiplaybooks)) serve the same payload builders as the first two (`playbookSummary` / `playbookDetail`, `src/playbooks.ts`).

`describe_playbook`'s layout is owned by `renderPlaybook` (`src/mcp/readRenderers.ts`). The worked example is the synthetic `GRAPH` in `tests/mcp-text-render.test.mjs`, whose expected rendering is asserted line by line and exercises every layout feature at once — a multi-member `needs.position` join, `tools (none)`, a `"*"` policy entry, edge-label padding, and verbatim indented description prose. Read it there rather than from a pasted sample: a renderer change fails that test, so it cannot drift the way a hand-pasted rendering of a hand-editable built-in silently did.

`playbook_state`'s `nextMoves` is answered by dry-running the same `decide()` that enforces, once per outgoing edge, so what it advertises and what the gate permits cannot diverge. Each move is evaluated as the **bare call**, with no `provenance` supplied, so an edge into a stage declaring `needs` reads `ok:false`/`NEEDS_UNSATISFIED` even when a satisfying worker exists — that is "pass the argument", not "impossible", and the `reason` names what to pass plus a census of the run: the workers that satisfy it right now (each judged by the same per-worker check the gate applies, so a named worker is one the gate accepts), or that none does — naming, for a `liveness:"live"` need, any worker that passed through the stage but has no running process. Provenance is never filled in from the census. A run-root spawn with no `provenance` has no run to count and gets no census. `playbook_state` declares a `sessionId`, so it is governable like any other targeted tool and a stage may deny it; the no-argument form names no worker, so it is never subject to a stage's policy and remains available.

**Enforcement level.** `playbookEnforcement: "warn" | "enforce"`, per conductor session. The level a new session **starts at** is the persisted `defaultPlaybookEnforcement` (Settings → Conductor conventions, same store and endpoint block as the preferred playbook above), falling back to `DEFAULT_PLAYBOOK_ENFORCEMENT` (`src/playbooks.ts`) — **`enforce`** — when nothing is persisted, so a fresh install refuses illegal moves until someone selects `warn`. `Manager._doCreate` reads it live, so a change lands on the next conductor spawn without a server restart and leaves running sessions alone. `warn` records the refusal, pushes a `system`/`playbook_warn` event to the **calling conductor's** event stream (below), and allows the call; `enforce` returns the refusal to the caller instead. **Neither level is inert** — both decide, patch args and write to the event log. An explicit value at create on `POST /api/instances` **wins over** the persisted default (the restart path carries a session its own recorded level, and inheriting a since-changed default would silently up/downgrade it). Flipped at runtime over the WebSocket (above) — a session-only override that never writes the persisted default — and carried across a graceful restart. A `pending-resume.json` from a build that still had the retired `off` level is normalized on read — to `warn`, always, regardless of the current shipped default — since resurrecting an unenforced session as enforced would be a silent upgrade (`normalizePlaybookEnforcement`). The **runtime authority is the instance field**; the event log's `config` rows are the audit trail: a **birth** (no `from`) when a conductor launches and the log holds no level for it, and a change (`from` = the level the log last recorded; the UI toggle's actor is `human`) on every `enforcement_changed` manager event, so whichever surface flips the toggle is recorded without knowing the log exists.

**Known limitations.**
- **Definition edits drift under live workers.** Definitions are deliberately not pinned to a run — no snapshot, no hash on the binding, and a load is never refused for invalidating a live run. A worker whose stage vanished under it gets `STAGE_UNKNOWN`, whose text says the definition changed rather than blaming the call. The same holds when a **plugin** providing the playbook is disabled or removed: the worker's governed calls (under `enforce`) and its resume are refused `PLAYBOOK_UNKNOWN` with a reason naming the plugin and pointing at `list_playbooks` → `errors` to tell a disabled plugin (re-enable restores it) from an unavailable plugin host or an invalid body, and at the plugin's Settings → Plugins row for a manifest invalid as a whole (still enabled, re-enable refused until fixed) (`missingPlaybookCause`, `src/playbooks.ts`); the binding is untouched, so re-enabling restores governance on the same session.
- **A worker spawned illegally under `warn` stays untracked.** The refusal is recorded but the call proceeds, and no binding is written — so flipping to `enforce` mid-run governs new spawns while that worker stays ungoverned (no subject in the projection). A *legal* `warn` spawn is bound normally and becomes governable on the flip.
- **`workerTools` is not a sandbox.** It denies tool **names**, not effects: with `Edit`/`Write` denied, `Bash` can still write files, and an MCP tool may reach the same effect another way. Deny `Bash` too, or use an allow-list (`"*": "deny"`), when that matters.
- **A worker-tools hook that cannot reach cc is non-blocking.** The entry is a plain `http` hook (the CLI's default non-blocking failure), so if cc is unreachable or the hook times out the call runs unchecked.
- **`workerTools` fails open** on definition drift (the bound playbook or stage is not loaded) and on an event log that cannot be loaded — both logged. Failing closed would deny every tool on every session, and the memoised load stays rejected until restart.
- **A typo in a `workerTools` key matches nothing**, so a misspelled `deny` denies nothing and a misspelled `allow` leaves the call to the next rule. There is no catalog of real tool names to check against.
- **`workerTools` under `warn` writes one row and one bubble per denied call**, so a worker repeatedly calling a denied tool fills the transcript with warnings.
- **A forward source is checked for permission, never for run membership.** A stage may forbid its worker's output being read out (`"get_recent_messages": "deny"`), and that denial covers `send_prompt({forward})` as well as a direct read. It is not scoped to a run: a conductor may forward from any tracked worker whose stage permits the read, including one in another run or another project. Deliberate — `freeform` declares no `needs`, so each of its workers is its own run root, and a same-run rule would refuse the fan-out-and-synthesise pattern that stage invites, recoverable only by declaring `provenance` at spawn time and never retroactively.

### REST — `/api/playbooks`

Read + validate only, served by `buildPlaybookApi` (`src/playbookApi.ts`, mounted at `/api/playbooks` from `src/routes.ts`). There is **no write or delete route**: an authoring plugin writes the user-overlay file itself — see [plugins/runtime.md → Authoring playbooks from a plugin](../plugins/runtime.md#authoring-playbooks-from-a-plugin). Playbook state is read only through the playbook gate (`tests/event-log-chokepoint.test.mjs`).

Shape conventions (all three routes):
- An optional key (`description` on a stage or a transition) is **absent** when unauthored — never `null` or `""`.
- The order of `playbooks` is not part of the contract.
- `takenIds.*`, `pinArgs` and `governableTools` are sorted ascending.

**`GET /api/playbooks`** → 200

```json
{
  "playbooks": [{ "id": "relay", "name": "…", "description": "…", "source": "builtin", "editable": false,
                  "entryStages": ["plan"], "spawnableStages": ["plan", "implement"] }],
  "errors": [{ "id": "broken", "message": "…" }],
  "governableTools": [{ "name": "send_prompt", "pinArgs": ["model", "text"] }],
  "takenIds": { "builtin": ["…"], "user": ["…"], "reserved": ["custom"] }
}
```

| Field | Meaning |
|---|---|
| `source` | `"builtin"` \| `"user"` \| `"plugin:<plugin-id>"` (`playbookSource`) — of the definition that **won**: a valid overlay file with a built-in's id overrides it and reports `"user"`; an invalid one leaves the built-in loaded (`"builtin"`) with its reasons in `errors` under that id. |
| `editable` | `true` iff `source === "user"`. |
| `entryStages` / `spawnableStages` | As `list_playbooks`; spawnable = `isSpawnable` (a `"*"` entry confers nothing). |
| `errors` | Exactly `list_playbooks`' `errors`. Ids: a bare slug, `<plugin-id>/<slug>`, or `plugins` when the plugin host is unavailable. |
| `governableTools` | One entry per `governableToolNames` (`governableToolCatalog`). `pinArgs` = the tool's `inputSchema` properties minus `PIN_FORBIDDEN_KEYS` — exactly the argument names the validator accepts inside `{pin:{…}}`. A pin on `"*"` is always refused. |
| `takenIds.builtin` | `SEED_PLAYBOOK_IDS`. Writing one **overrides** the shipped definition — legal; warn, don't block. |
| `takenIds.user` | Every `<id>.json` in the overlay (`userPlaybookIds`), **loaded or not** — an invalid file is absent from `playbooks` but its id is taken. |
| `takenIds.reserved` | `RESERVED_OVERLAY_ID` — the loader **silently skips** that file (it is the catalog's store file). Refuse these ids. |

Plugin ids are never in `takenIds`: they contain `/`, which an overlay id cannot. The editor catalog rides on the list rather than a route of its own because any literal `/api/playbooks/<word>` path would collide with a playbook of that id.

**`GET /api/playbooks/:id`** → 200. Plugin ids resolve both raw (`/api/playbooks/acme/release`) and encoded (`/api/playbooks/acme%2Frelease`).

```json
{
  "id": "acme/release", "name": "…", "description": "…", "source": "plugin:acme", "editable": false,
  "entryStages": ["plan"],
  "stages": { "plan": { "needs": [{ "stage": "research", "position": ["research"], "liveness": "live" }],
                        "workers": "one", "tools": { "spawn_instance": { "pin": { "model": "acme/captain" } } },
                        "workerTools": { "*": "deny", "Read": "allow" },
                        "spawnable": true, "description": "…" } },
  "transitions": [{ "from": "plan", "to": "ship", "via": "send_prompt", "description": "…" }],
  "liveWorkers": 0
}
```

- The graph is **post-validation** (`playbookDetail`, the payload `describe_playbook` renders): defaults applied (`needs[].position` → `[stage]`, `liveness` → `"live"`, `workers` → `"one"`, `workerTools` → `{}`); `tools` and `workerTools` hold only the declared entries ([Worker tools](#worker-tools-workertools)).
- `via` = the declared `on`, else `"send_prompt"`. Lossless: the validator refuses `on: "send_prompt"`, so `via: "send_prompt"` always means no `on`.
- `spawnable` = `isSpawnable(stage)`.
- `liveWorkers` = the length of the gate's `readLiveWorkers(id)` — workers bound to this id in its projection for which `isLive` holds — for warning about [definition drift](#playbooks) before an edit. `null` = unknown: no gate wired, or the projection read failed (logged with `console.warn`, still 200 — the same degrade as `GET /api/instances`' bindings).
- **404** `{error: "no playbook '<id>'", code: "PLAYBOOK_UNKNOWN"}` — an unknown id, an unknown plugin slug, or an overlay file that failed validation (its reasons are in the list's `errors`).

**`POST /api/playbooks/validate`** → 200. The body is the draft definition itself — the JSON that would be written to `<id>.json`. Never writes.

```json
{ "ok": false, "errors": [
  { "message": "stage 'plan': …", "stage": "plan", "transition": null },
  { "message": "transition plan->ship: …", "stage": null, "transition": { "from": "plan", "to": "ship" } },
  { "message": "name is required and must be a non-empty string", "stage": null, "transition": null }
] }
```

- Valid → exactly `{ok: true}`.
- `message` = `validatePlaybook(draft, draft.id, <tool index>)`'s errors, in emission order — the validator is the only rule set. The expected id is the draft's **own** `id`, so the filename-match check never fires; a missing or non-string id is reported once, as `invalid id '…'`.
- `stage` / `transition` come from `locateValidationError` (`src/playbooks.ts`), matched against the draft's **actual** stage names and edges (so `plan` never captures `plan-b`'s messages):
  - `stage` — a message starting `stage '<name>'` followed by `:` or a space. When several names match (`a` and `a' b` both head `stage 'a' b': …`), the **longest** wins.
  - `transition` — a message starting `transition <from>-><to>:`, or exactly `duplicate transition <from>-><to>`. When that text is printed by more than one distinct declared edge (`a`→`->b` and `a->`→`b`), `transition` is `null`.
  - both `null` — a playbook-level message, or a transition message not attributed to a declared edge (e.g. `transition from names unknown stage …`).
- No per-field path: the message text names the field.
- A request whose `Content-Type` is not `application/json` → **400** `{error, code: "BODY_NOT_JSON"}`, never validated.
- A non-object JSON body (e.g. `[]`) → `ok:false` with the validator's `must be a JSON object` error. An `application/json` body that does not parse → 400 from `express.json`.
- No collision check — apply `takenIds` client-side.
