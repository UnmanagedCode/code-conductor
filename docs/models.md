# Models & backends

How a spawn caller's `tier` / `role` becomes a concrete `{backend, model}` pair, and
how the **backend registry** turns "which command runs `claude`" into user-managed
data. Wire contracts live in [protocol.md](protocol.md#rest-endpoints); component
internals in [architecture.md](architecture.md#component-layout).

## Backends

A **backend** is a launch recipe. `template` is the command that replaces `claude`
on the argv, with `{model}` standing in for the model id; an **empty template runs
`claude` directly**. `resolveBackendLaunch()` in `src/claudeLauncher.js` is the
single place a template is consumed — it whitespace-splits the template,
substitutes `{model}` **inside each token** (so `--model={model}` works as well as
`--model {model}`), takes token 0 as the command and the rest as the argv prefix,
then the caller appends the SAME claude args uniformly. Three callers share it:
`Instance.spawn()`, `generateSummary()` (`src/summarize.js`), `generateBundle()`
(`src/claudeShellEnv.js`).

Record: `{ id, label, template, env: [{key,value}], managed }`, persisted as
`models.backends`.

| Field | Notes |
|---|---|
| `id` | `^[a-z][a-z0-9-]*$`, ≤40 chars, unique (incl. against managed ids). The value stored in `Instance.backend`, tier/role bindings, the session sidecar, and the resume manifest. |
| `label` | Display name. Required. |
| `template` | Blank ⇒ identity (run `claude`). A template naming `{model}` refuses to launch without a model (`resolveBackendLaunch` throws). A template with **no** `{model}` is valid. |
| `env` | Key/value pairs injected into the child's env at spawn. Keys match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `managed` | Derived, never stored: true for the two built-ins below. |

### The two managed backends

`MANAGED_BACKENDS` in `src/modelVersions.js` is authoritative for their
`id`/`label`/`template`/`managed` — `getBackends()` takes only their **`env`** from
the store and re-asserts the rest, appending either row if the store lacks it. So a
built-in template can't drift, `claude` always exists, and a fresh install needs no
seeding.

| id | label | template |
|---|---|---|
| `claude` | Claude | *(empty — runs `claude` directly)* |
| `ollama` | Ollama | `ollama launch claude --model {model} --yes --` |

`ollama launch` sets the Anthropic endpoint + auth internally and **re-injects
`--model` into the child**, so the caller-forwarded `--model` later in the args is a
matching no-op; `--yes` bypasses the non-agent-capable confirmation (else a piped
spawn hangs); the trailing `--` terminates its own flags. Localhost only — point it
elsewhere with an `OLLAMA_HOST` env pair on the row.

Managed rows accept an **`env` edit only** (label/template edits → 400) and can
**never be removed** (400). `claude` is additionally never offered as a custom
model's backend — its models are the Claude version catalog, not user rows.

### Identity vs substitution backends

Every rule that could have been keyed on one provider is instead keyed on
`backend !== 'claude'` — i.e. "is this a **substitution** backend?". Keyed that way
on purpose: a user-defined backend behaves exactly like the built-in `ollama` row.
The consequences of being a substitution backend:

- **cc-managed context env** — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` +
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` are set to the model's native window. Implicit to
  every substitution backend, **never** applied to plain `claude`, and never exposed
  in the Backends UI. Applied *after* the row's `env`, so they win over a same-named
  pair. See [protocol.md](protocol.md#subprocess-protocol) for why both are needed.
- **Bare model reports are suppressed** — the inner CLI records `message.model`
  bare (tag dropped), so `_trackModel` ignores a report that tag-strips to the
  current model rather than treating it as an interactive switch. Without this,
  `this.model` would lose its tag and the next launch would use an unpullable
  tagless id.
- **Live "Change model" is refused** — the endpoint is fixed at launch, so any
  switch with a non-`claude` backend on either side (including
  substitution↔substitution) is rejected `409 BACKEND_LOCKED`.
- **`launch_failed`** is emitted when the subprocess dies on its own (binary
  missing, daemon gone, cloud-auth 401) — see [protocol.md](protocol.md#websocket-protocol).
- **No `cost_usd`** is persisted for its turns (`src/costTracking.js`): the CLI's
  `total_cost_usd` is Anthropic list pricing applied to someone else's model. The
  *absence* of `cost_usd` is the canonical "tokens not countable" marker the cost
  dashboard reads.
- **Own usage-window domain** — `usageDomainOfBackend()` maps `claude` to the
  monitored `anthropic` domain and every other backend to a domain named after
  itself. Only `anthropic` has a monitor, so a tree with no Claude agent is exempt
  from the overage stop/resume flow. Adding a monitor later is one `Set` entry
  (`src/usageWindowDomains.js`).
- **The session sidecar records it** — `<store>/session-backends.json` maps
  `sid → {backend, model}`. Two things the CLI jsonl can't carry: which backend ran
  the session, and the model TAG. Absence of a record means plain `claude`; a `null`
  model means backend-known/model-unknown (resume falls back to the jsonl and the
  next mark self-heals it).

There is deliberately **no** per-backend health check and **no** per-backend model
catalog. A bad backend or model simply fails at spawn and surfaces as
`launch_failed`.

## Custom models

`models.customModels: [{ label, model, backend, contextWindow }]` — the models
selectable for a substitution backend.

- `model` (the backend's own model id) **is the identity**: re-adding it updates the
  row in place, and a given model id belongs to exactly one backend.
- `backend` must name a substitution backend (never `claude`).
- `contextWindow` is **required** and must be a positive integer of raw tokens. It
  drives the context-usage bar and both cc-managed env vars at spawn, so a wrong
  value silently truncates or over-fills the window. Resolved by
  `contextWindowForModel()` (`src/appSettings.js`), mirrored client-side by
  `customContextWindowFor()` (`public/models.js`, which additionally matches the
  bare base name the CLI reports).

### The curated Ollama cloud catalog

`src/ollamaCloudModels.js` ships 7 read-only cloud coding models, each with its
native `contextWindow` — bindable with no "Add" step. **Scoped to the built-in
`ollama` backend only**: `isKnownBackendModel(backend, model)` accepts a preset just
for that row, and the picker renders the optgroup only there. A user-defined backend
has no curated catalog. `OLLAMA_CLOUD_TIER_DEFAULTS` (fast/balanced/powerful;
frontier intentionally absent) is a **UI pre-selection only** when a tier switches
to the `ollama` row — `DEFAULT_TIER_BACKEND` stays all-Claude.

## Capability tiers & roles

**Tiers** (`CAPABILITY_TIERS`: `fast`/`balanced`/`powerful`/`frontier`) are the
primary spawn vocabulary. Each binds to `{backend, model, window?}` under
`models.tierBackend`. Defaults (`DEFAULT_TIER_BACKEND`) are all Claude:
Fast→Haiku, Balanced→Sonnet 5, Powerful→Opus, Frontier→Fable 5.

**Roles** are a parallel bindable layer under `models.roleBackend`. A role binding is
**either** a tier reference `{kind:'tier', tier}` — follow whatever that tier points
at — **or** a concrete `{backend, model, window?}`. The two are told apart by
`kind === 'tier'`; a tier reference names no backend, so it keeps `kind`.

- **Built-in**: `ROLES` (`conductor`, `reviewer`), both defaulting to the `powerful`
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

## Claude context windows

One fixed window per family, applied by `canonicalizeModel()` in
`src/modelVersions.js` — the single source of truth, mirrored client-side in
`public/models.js`:

| Family | Window |
|---|---|
| Haiku | 200k (no 1M build) — bare id |
| Opus / Fable 5 | 1M (CLI default) — bare id |
| Sonnet 5 | 1M only (`fixedWindow` in the catalog) — always `[1m]` |
| Sonnet 4.x | user-selectable 200k (bare) or 1M (`[1m]`) |

A Sonnet 4.x choice rides as `window` **on that individual binding**
(`{backend:'claude', model, window}`) — there is no global preference, so picking one
binding's window never moves another's. `persistBinding` stores `window` only where
it's meaningful (a `claude` binding on a selectable-window Sonnet); everything else
would ignore it. The window rides on the spawn as `sonnetWindow` and in
`this.model`'s suffix, is carried across a graceful restart via the resume manifest,
and defaults to **1M on a bare cold resume** (larger window, never truncates).

`canonicalizeModel` is a **no-op for any non-Claude id** (`familyOf` returns null),
which is exactly what lets a tagged model survive resume untouched.

## Settings → Backends

Panel (`#settings-backends`): one card per registry row showing label, id, template
(or "runs `claude` directly"), its env pairs, and the custom models bound to it.
Managed rows carry a **built in** badge, show the template read-only, and have no
Remove. One shared add/edit form (id + label + template + an env textarea, one
`KEY=VALUE` per line).

Removing a backend **never cascades**: while any custom model still references it the
DELETE is refused **409** with a message naming those models, surfaced in the panel's
status line. Remove the models first. Once unreferenced, any tier/role left pointing
at one of its models reverts through the normal dead-binding path.

## Settings → Models

One row per tier, rendered **Frontier → Powerful → Balanced → Fast**, each with a
**backend select** driven by the registry (a user-added row appears here with no code
change) and a **model select scoped to the chosen backend**, plus a per-tier **enable
checkbox** and **default radio** (default falls back to the first enabled tier in
order balanced → fast → powerful → frontier). Both selects come from one shared
`buildBackendPicker`, reused by the Roles rows.

- **`claude`** → the Claude version list. Sonnet shows 5 entries: Sonnet 5 (1M only)
  plus Sonnet 4.6/4.5 each ×2 for their 200k/1M sub-choice.
- **any other backend** → a curated optgroup (built-in `ollama` row only) + a
  **"My Models"** optgroup filtered to that backend; `(add a model below)` when it has
  none.

**Custom models** fieldset: label + backend select + model id + **required** context
tokens. **Roles** fieldset: one select per role listing every tier plus `Custom`
(which reveals the shared backend/model pickers), a name-only add form for custom
roles, an `×` remove on user rows, and a `via <plugin>` badge on plugin rows.

Every mutation is a single POST that returns the full refreshed state, re-rendered
immediately — no restart. Endpoints: [protocol.md](protocol.md#rest-endpoints).
