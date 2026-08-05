# Models & backends

How a spawn caller's `tier` / `role` becomes a concrete `{backend, model}` pair, and
how the **backend registry** turns "which command runs `claude`" into user-managed
data. Wire contracts live in [protocol.md](protocol.md#rest-endpoints); component
internals in [architecture.md](architecture.md#component-layout).

## Backends

A **backend** is a launch recipe. `template` is the command that replaces `claude`
on the argv, with `{model}` standing in for the model id; an **empty template runs
`claude` directly**. `resolveBackendLaunch()` in `src/claudeLauncher.ts` is the
single place a template is consumed — it whitespace-splits the template,
substitutes `{model}` **inside each token** (so `--model={model}` works as well as
`--model {model}`), takes token 0 as the command and the rest as the argv prefix,
then the caller appends the SAME claude args uniformly. Three callers share it:
`Instance.spawn()`, `generateSummary()` (`src/summarize.ts`), `generateBundle()`
(`src/claudeShellEnv.ts`).

Record: `{ id, label, template, env: [{key,value}], managed }`, persisted as
`models.backends`.

| Field | Notes |
|---|---|
| `id` | `^[a-z][a-z0-9-]*$`, ≤40 chars, unique (incl. against managed ids). The value stored in `Instance.backend`, tier/role bindings, the session sidecar, and the resume manifest. |
| `label` | Display name. Required. |
| `template` | **Required on a USER row** (400 if blank — see below). Blank on the managed `claude` row ⇒ identity. Any non-blank template refuses to launch without a resolved model, **unconditionally** — a template that never names `{model}` is no exception, because the model still rides in the forwarded claude args and drives the context-window env. |
| `env` | Key/value pairs injected into the child's env at spawn. Keys match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `managed` | Derived, never stored: true for the two built-ins below. |

### The managed backends

`MANAGED_BACKENDS` in `src/modelVersions.ts` is authoritative for their
`id`/`label`/`template`/`env`/`managed` — `getBackends()` re-asserts all of it from
code (managed rows are fully code-authoritative; nothing on them is stored),
appending either row if the store lacks it. So a built-in template can't drift,
`claude` always exists, and a fresh install needs no seeding.

| id | label | template |
|---|---|---|
| `claude` | Claude | *(empty — `claude`)* |
| `ollama` | Ollama | `ollama launch claude --model {model} --yes --` |

Authoritative set: `MANAGED_BACKENDS` in `src/modelVersions.ts`.

`ollama launch` sets the Anthropic endpoint + auth internally and **re-injects
`--model` into the child**, so the caller-forwarded `--model` later in the args is a
matching no-op; `--yes` bypasses the non-agent-capable confirmation (else a piped
spawn hangs); the trailing `--` terminates its own flags. Localhost only — a managed
row's `env` is read-only, so point it elsewhere by setting `OLLAMA_HOST` in the
orchestrator's process environment (inherited by the child at spawn).

Managed rows are fully **read-only** (label/template/env edits → 400) and can
**never be removed** (400); their `env` is code-authoritative (empty). `claude` is
additionally never offered as a custom model's backend — its models are the Claude
version catalog, not user rows.

**A USER row must declare a template** (400 otherwise). A blank one would be a
bare-`claude` alias: it runs the real CLI against the real Anthropic account, yet
every rule below treats it as a substitution backend — no overage protection, no
`cost_usd`, and a forced `CLAUDE_CODE_MAX_CONTEXT_TOKENS` on a genuine Claude
session. The managed `claude` row already provides identity behaviour, so the alias
would add nothing but that hazard.

### Identity vs substitution backends

Every rule that could have been keyed on one provider is instead keyed on
`backend !== 'claude'` — i.e. "is this a **substitution** backend?". Keyed that way
on purpose: a user-defined backend behaves exactly like the built-in `ollama` row.

The classification is by **row identity, not by what the template resolves to**. A
non-empty template can still end up running bare `claude` (`template: 'claude'`, or a
wrapper that just exec's it) and such a row keeps every consequence below — no
overage protection, no `cost_usd`, cc-managed context env. That's a deliberate
user-error path, not a supported way to alias the identity backend; bind the managed
`claude` row for that. (A *blank* template on a user row is refused outright, above.)

The consequences of being a substitution backend:

- **cc-managed context env** — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` +
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` are set to the model's native window on every
  **session** spawn (`Instance.spawn`), **never** for plain `claude`, and never
  exposed in the Backends UI. Applied *after* the row's `env`, so they win over a
  same-named pair. Scoped to sessions: the one-shot spawners (`summarize.ts`,
  `claudeShellEnv.ts`) set neither — they run a single short prompt with no
  conversation to compact. See [protocol.md](protocol.md#subprocess-protocol) for why
  both are needed.
- **The CLI's model report is ignored entirely** — `_trackModel` never adopts it
  for a substitution backend that has a configured model, whatever it says. The
  inner CLI records `message.model` lossily (the `:tag` variant suffix *and* any
  terminal `[…]` build tag dropped) and may report an unrelated id altogether;
  `this.model` is the registry KEY for these backends, so adopting any of that
  breaks the next resume's `--model <key>`, drops the context env vars, and writes
  a foreign id + capacity into `session-backends.json`. Suppressing only the
  *lossy* shapes left exactly that hole. Unconditional is correct rather than
  merely safe: live model changes are already refused here (below), so the
  configured id is authoritative by construction. The guard is keyed on
  `backend !== 'claude'`, never on one backend id — narrowing it to
  `=== 'ollama'` reintroduces the bug for every user-defined backend.
- **Live "Change model" is refused** — the endpoint is fixed at launch, so any
  switch with a non-`claude` backend on either side (including
  substitution↔substitution) is rejected `409 BACKEND_LOCKED`.
- **`launch_failed`** is emitted when the subprocess dies on its own (binary
  missing, daemon gone, cloud-auth 401) — see [protocol.md](protocol.md#websocket-protocol).
- **No `cost_usd`** is persisted for its turns (`src/costTracking.ts`): the CLI's
  `total_cost_usd` is Anthropic list pricing applied to someone else's model. The
  *absence* of `cost_usd` is the canonical "tokens not countable" marker the cost
  dashboard reads.
- **Own usage-window domain** — `usageDomainOfBackend()` maps `claude` to the
  monitored `anthropic` domain and every other backend to `backend:<its id>`. The
  namespace is load-bearing: ids are user-chosen, so an un-namespaced map would let a
  row named `anthropic` land in the monitored domain and be auto-stopped against a
  window it never touches. Only `anthropic` has a monitor, so a tree with no Claude
  agent is exempt from the overage stop/resume flow. Adding a monitor later is one
  `Set` entry (`src/usageWindowDomains.ts`).
- **The session sidecar records it** — `<store>/session-backends.json` maps
  `sid → {backend, model, contextWindowTokens?}`. Two things the CLI jsonl can't
  carry: which backend ran the session, and the model id in full. Absence of a record
  means plain `claude`; a `null` model means backend-known/model-unknown (resume falls
  back to the jsonl and the next mark self-heals it). `contextWindowTokens` is a
  fallback used only when the model's custom-model row has since been deleted. If the recorded backend has since been REMOVED from the
  registry, resume is refused `422 BACKEND_GONE` (below).

There is deliberately **no** per-backend health check and **no** per-backend model
catalog. A bad backend or model simply fails at spawn and surfaces as
`launch_failed`.

### Missing backends are refused, never downgraded

Falling back to `claude` when a backend id can't be resolved would launch the real
CLI against the real Anthropic account with a **foreign model id** — an opaque
failure, billed. So every path refuses instead. These are four independent doors on
purpose: each closes a distinct route, and none subsumes another.

| Door | Where | Refusal |
|---|---|---|
| Create with an **explicit** unknown backend (`POST /api/instances`, restart replay) | `_doCreate`, `src/instances.ts` | `422 BACKEND_GONE` |
| Resume whose **sidecar** backend was removed since | `_doCreate`, same guard | `422 BACKEND_GONE` |
| Spawn/respawn after the row was removed **under a tracked instance** | `Instance.spawn()`, `src/instances.ts` | throws, instance → `crashed` (visible), instead of taking `resolveBackendLaunch`'s identity branch |
| **Removing** a row that anything still references | `removeBackend()`, `src/appSettings.ts` | `409` — see [Settings → Backends](#settings--backends) |

## Custom models

`models.customModels: [{ label, model, backend, contextWindow }]` — the models
selectable for a substitution backend.

- `model` (the backend's own model id) **is the identity**: re-adding it updates the
  row in place, and a given model id belongs to exactly one backend.
- `backend` must name a substitution backend (never `claude`).
- `contextWindow` is **required** and must be a positive number of raw tokens
  (stored `Math.round`ed). It
  drives the context-usage bar and both cc-managed env vars at spawn, so a wrong
  value silently truncates or over-fills the window. Resolved by
  `contextWindowForModel()` (`src/appSettings.ts`) — an **exact** match on the
  model id, which is the registry key. There is no client-side mirror: the server
  ships the resolved number as `contextWindowTokens`.

### The curated Ollama cloud catalog

`src/ollamaCloudModels.ts` ships a read-only catalog of Ollama cloud coding models, each with its
native `contextWindow` — bindable with no "Add" step. **Scoped to the built-in
`ollama` backend only**: `isKnownBackendModel(backend, model)` accepts a preset just
for that row, and the picker renders the optgroup only there. A user-defined backend
has no curated catalog. `OLLAMA_CLOUD_TIER_DEFAULTS` (a per-tier UI pre-selection only — see the module for which tiers carry one) applies when a tier switches
to the `ollama` row — `DEFAULT_TIER_BACKEND` stays all-Claude.

## Capability tiers & roles

**Tiers** — `CAPABILITY_TIERS` (the tier list in `src/modelVersions.ts`) is the primary spawn vocabulary. Each binds to `{backend, model}` under
`models.tierBackend`. Defaults (`DEFAULT_TIER_BACKEND`) are all-Claude; see the module for the per-tier mapping.

**Roles** are a parallel bindable layer under `models.roleBackend`. A role binding is
**either** a tier reference `{kind:'tier', tier}` — follow whatever that tier points
at — **or** a concrete `{backend, model}`. The two are told apart by
`kind === 'tier'`; a tier reference names no backend, so it keeps `kind`.

- **Built-in**: `ROLES` (the seed role list in `src/modelVersions.ts`), both defaulting to the `powerful`
  tier. The Conduct button spawns via the Conductor role.
- **User-custom**: `models.customRoles: [name]`, name-only (the name is the
  display), matching `^[A-Za-z][A-Za-z0-9-]*$` (≤40) and case-insensitively disjoint
  from tiers, built-in roles, family aliases, and other custom/plugin roles. Created
  bound to `powerful`.
- **Plugin-owned**: live-derived from enabled plugins, namespaced
  `<plugin-id>/<slug>`, never persisted. A manifest binding may only be a tier
  reference or `{backend:'claude', model}` — every other backend is **user-local**
  (its rows exist only in this user's settings). A **user override** of a plugin role
  *may* name any backend and is persisted under `models.roleBackend` keyed by the
  namespaced id, beating the manifest at spawn. See [plugins.md](plugins.md).

**Dead-binding revert.** A valid binding is returned **verbatim** — never silently
rewritten. Only an invalid one (unknown Claude version, a since-removed model, an
unknown backend) falls back: `getTierBackend` to the tier's default Claude backend,
`getRoleBinding` to the role default (a custom role to the default spawn tier).
`resolveRoleBackend` delegates a tier reference to `getTierBackend`, so a
role → tier → dead-model chain reverts correctly, and re-guards a plugin *manifest*
Claude id (which nothing else re-validates) against a retired catalog version.

### Default effort

A **second axis** on the same rows: which model a spawn runs *on* is the binding
above; how hard it *reasons* is the effort. The two vocabularies stay disjoint —
`low`/`medium`/`high`/`xhigh`/`max` (`EFFORT_LEVELS`, `src/effortLevels.ts`) never
name a tier, and no tier word is an effort level.

| Key | Shape | Default |
|---|---|---|
| `models.tierEffort` | `{<tier>: <level>}` | `DEFAULT_EFFORT` (`high`) |
| `models.roleEffort` | `{<role>: 'inherit' \| <level>}` | `inherit` |

`inherit` means *follow the bound tier* — mirroring how `resolveRoleBackend`
delegates a tier reference to `getTierBackend`, so a role has one inheritance story
for both axes. A role bound to a concrete `{backend, model}` has no tier to follow,
so its `inherit` resolves to `DEFAULT_EFFORT`. `inherit` is a role-only sentinel: a
tier has nothing to inherit from, so `setTierEffort` refuses it (400). Invalid
stored values revert on read, like the bindings.

**`resolveSpawnEffort({effort, tier, role})` (`src/appSettings.ts`) is the single
resolution point** — the effort counterpart of `resolveBackendLaunch`. Precedence:

1. an explicit `effort` (MCP `spawn_instance`, the spawn dialog's Advanced options,
   the `POST /api/instances` body) — **validated here**, so an invalid explicit
   value throws `400 invalid effort` instead of silently decaying to a default;
2. `role` → `resolveRoleEffort(role)` (explicit level, else the inherited one);
3. `tier` → `getTierEffort(tier)`;
4. `DEFAULT_EFFORT`.

Role before tier: a spawn resolves its model through one or the other, never both,
but a caller passing both gets the more specific. An unknown tier/role name falls
*through* rather than refusing — unlike a missing backend there is no billing
hazard, only a level.

`InstanceManager._doCreate` is the only caller: `tier`/`role` reach it from
`mcp/handlers.ts` `spawnInstance` (which already knows which one it resolved the
model through) and from the `POST /api/instances` body. Neither name is stored on
the `Instance` — `this.effort` holds the resolved level.

**What each relaunch path does** — only the first ever consults a tier/role default,
so a changed default moves *new spawns*, never anything already running:

| Path | Effort |
|---|---|
| Fresh spawn (dialog / Conduct / `spawn_instance` with a tier or role) | resolved through the chain above |
| Resume via `_doCreate` with no tier/role — sidebar one-click, anchor auto-resume, `spawn_instance({resume})` | step 4, `DEFAULT_EFFORT`: a resume recovers its model from the jsonl/sidecar, not from a binding, so there is no row to inherit from |
| Restart manifest (`src/resumeRestart.ts`) | step 1 — it carries the recorded `effort` explicitly, so the session comes back at the exact level it was running at |
| `POST /api/instances/:id/fork` | step 1 — `create({… effort: inst.effort …})`, so the fork inherits the source session's level (it *does* re-enter `_doCreate`, unlike the row below) |
| `Instance.launch({resume})` — `respawn_instance`, `POST /instances/:id/respawn`, crash-respawn, rewind, prune | reuses the live `this.effort`; these never re-enter `_doCreate`, so nothing is re-resolved |

The client **never** resolves this chain. The `/api/settings/models` payload ships
`tierEffort` (effective, always concrete), `efforts` (the level catalog),
`defaultEffort` (`DEFAULT_EFFORT`, so a client fallback lands on the level the server
would resolve rather than the first level in the catalog), and
`roleEffort: {<role>: {effort, inheritsTo}}`, where `inheritsTo` is what `inherit`
resolves to right now — computed server-side purely so the UI can render the
`Inherit (<level>)` label. The caller-facing statement of the chain lives in the
MCP `spawn_instance` `effort` schema description.

## Context windows

Every model has exactly **one** native context window. There is no per-spawn
window choice and no routing selector.

**Claude models** declare theirs in the `src/modelVersions.ts` catalog as
`contextWindow` (raw tokens), plus an optional `launchTag` — the suffix the CLI
needs to actually reach that capacity. A model carries `launchTag` only where its
native window is a separate build with a distinct id; everything else launches
bare. The catalog is authoritative for which model is which, so those values are
not restated here.

**Substitution-backend models** declare theirs on their custom-model row
(`contextWindow`, required) or carry it in the curated Ollama preset catalog.

### Resolution

`resolveContextWindowTokens({backend, model})` in `src/appSettings.ts` is the
single place capacity is resolved: it dispatches on `backend` to either
`claudeContextWindowTokens()` (catalog) or `contextWindowForModel()` (registry).
`Instance.create()` calls it once and stores the number as
`contextWindowTokens`, which then feeds every consumer — the substitution
backend's `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`summary()`, the MCP projection, the header ctx chip, forks, and the resume
manifest. **Unknown capacity is `null` and renders as `ctx —`** — never a
fabricated default.

A binding is exactly `{backend, model}`. Sidecar and manifest records carry
`contextWindowTokens` as a **fallback only**, used when the model's custom-model
row was deleted since the session last ran; live registry resolution wins
whenever it succeeds.

### Canonicalization is gated on `backend`

`canonicalizeModel(modelId, backend)` applies the launch tag. `backend` is a
**required positional**, and that gate is the only reason this is a no-op for a
substitution model — *not* `familyOf()` returning null:

- `backend === 'claude'` → strip any terminal tag, re-apply the catalog
  `launchTag`. This is also what re-tags the bare id recovered from a jsonl on a
  cold resume, so each model comes back at its own native window.
- any other backend → the id is returned **byte-exact**. A substitution model id
  is an opaque registry key that may legitimately end in `[1m]` or look
  Claude-shaped; every registry lookup matches it exactly, so normalizing it
  silently drops the context env vars and breaks `{model}` substitution.

Omitting the argument yields `undefined !== 'claude'` → verbatim, i.e. it fails
toward preserving the caller's id rather than mangling it.

## Settings → Backends

Panel (`#settings-backends`): one card per registry row showing label, id, template
(blank shows `claude`), its env pairs, and the custom models bound to it. Managed
rows carry a **built in** badge, show their template and env read-only, and have no
Remove. One shared add/edit form (id + label + template + an env textarea, one
`KEY=VALUE` per line) — for user rows only.

Removing a backend **never cascades**. The DELETE is refused **409** — message
surfaced in the panel's status line — while *either* of two things still references
the row:

- **any custom model is bound to it** (message names those model ids) — remove the
  models first;
- **any tracked instance is on it** (message names those session ids) — **archive or
  delete** those sessions first. `liveBackendUsage()` (`src/instances.ts`) counts
  every instance in `byId`, *including exited ones*: an exited instance is still
  respawnable (crash-respawn, overage auto-resume, rewind), and it is exactly that
  later relaunch that would hit the real `claude`. So **killing is not enough** — the
  kill button leaves a non-temp instance in `byId` and the 409 repeats; only the
  session archive/delete paths call `instances.remove()`.

Once nothing references it, any tier/role left pointing at one of its models reverts
through the normal dead-binding path.

## Settings → Models

One row per tier, rendered **Frontier → Powerful → Balanced → Fast**, each with a
**backend select** driven by the registry (a user-added row appears here with no code
change), a **model select scoped to the chosen backend**, and a **default-effort
select**, plus a per-tier **enable checkbox** and **default radio** (default falls
back to the first enabled tier in order balanced → fast → powerful → frontier). The
two binding selects come from one shared `buildBackendPicker` and the effort select
from `buildEffortPicker` — both reused by the Roles rows.

- **`claude`** → the Claude version list, one option per version. Each model has a
  single native context window, so there is no window sub-choice.
- **any other backend** → a curated optgroup (built-in `ollama` row only) + a
  **"My Models"** optgroup filtered to that backend; `(add a model below)` when it has
  none.

**Custom models** fieldset: label + backend select + model id + **required** context
tokens. **Roles** fieldset: one select per role listing every tier plus `Custom`
(which reveals the shared backend/model pickers), a **default-effort select** whose
first option reads `Inherit (<level>)` — the payload's `inheritsTo`, so a row is
never opaque about what it will run at — a name-only add form for custom roles, an
`×` remove on user rows, and a `via <plugin>` badge on plugin rows. A plugin role's
effort is user-settable like its binding, persisted under `models.roleEffort` by the
namespaced id.

Every mutation is a single POST that returns the full refreshed state, re-rendered
immediately — no restart. Endpoints: [protocol.md](protocol.md#rest-endpoints).
