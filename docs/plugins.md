> See also: [README](../README.md)

## Plugin system

### Manifest — `conductor.plugin.json` at the plugin project root

```jsonc
{
  "id": "code-hub",             // REQUIRED ^[a-z][a-z0-9-]*$ ≤40 chars, unique across the projects root
  "name": "Code Hub",           // REQUIRED display name
  "version": "0.3.0",           // REQUIRED informational
  "pluginApi": 1,               // REQUIRED int; conductor supports [1], anything else ⇒ state "incompatible"
  "backend": {                  // OPTIONAL (manifest-only/library plugins omit)
    "start": "npm start",       // bash -lc, cwd = active checkout, $PORT injected
    "healthPath": "/api/health",// optional readiness probe + on-demand liveness probe
    "readyWhen": "listening"    // optional stdout/stderr regex (precedence: readyWhen → healthPath → TCP)
  },
  "frontend": {                 // OPTIONAL, requires backend
    "path": "/",                // default "/"
    "navLabel": "Hub"           // default = name
  },
  "mcp": {                      // OPTIONAL, requires backend
    "endpoint": "/api/mcp",     // single POST endpoint on the child
    "scope": "project",         // accepted ("project" | "global") but INERT — tools are always globally visible
    "timeoutMs": 30000,         // per-call cap, clamped to `MCP_TIMEOUT_CAP` (`src/plugins/manifest.ts`)
    "tools": [{ "name": "...", "description": "...", "inputSchema": { "type": "object", ... } }]
  },
  "conventions": [              // OPTIONAL, NO backend required — project conventions
    { "slug": "visual-verification",           // ^[a-z][a-z0-9-]*$ ≤40, unique in this array
      "name": "Visual UX verification",        // REQUIRED
      "description": "verify UX via the harness", // REQUIRED
      "scope": "project",                      // REQUIRED enum — "project" or "conductor" accepted ("workspace" planned; see below)
      "file": "conventions/visual-verification.md", // OPTIONAL CLAUDE.md fragment: relative .md path, no leading '/' or '..'
      "scaffold": {             // OPTIONAL facet (plugin-only) — a one-time project-setup directive
        "file": "scaffold/harness.md" }        // EXACTLY ONE of "text" | "file" (same path rules as conventions.file)
      // "scaffold": { "text": "Build a project-local harness wrapper ..." }  // inline form
      // At least one of "file" | "scaffold" is REQUIRED.
    }
  ],
  "roles": [                    // OPTIONAL, NO backend required — plugin-owned roles
    { "slug": "release-captain",             // ^[a-z][a-z0-9-]*$ ≤40, unique in this array
      "name": "Release Captain",             // REQUIRED display label
      "binding": { "kind": "tier", "tier": "powerful" } }  // REQUIRED: {kind:'tier',tier} | {backend:'claude',model}
                                             //   (legacy {kind:'claude',model} still accepted)
  ],
  "claudePlugin": "claude"      // OPTIONAL string, NO backend required — Claude Code plugin root
                                // (relative path, no leading '/' or '..'; "." = the cc plugin root itself)
  // "settings": reserved, validated-but-inert in v1
}
```

`conventions` is an **active pluginApi:1 capability** (an additive extension of v1, not a version bump — an existing manifest without it stays valid). It works with **no backend**, so a contributions-only plugin is `{id,name,version,pluginApi,conventions}`: it validates, enables, contributes, and is **never started** (its Settings row shows only Disable + contribution badges; `POST .../start` refuses 400). Entries join the project **Conventions** catalog namespaced `<plugin-id>/<slug>` (visible in the new-project dialog + `list_project_conventions`). Each entry carries a CLAUDE.md **`file`** fragment (applied inline to a project's CLAUDE.md at creation — the applied copy survives plugin disable/uninstall) and/or a **`scaffold`** facet (a one-time setup directive via exactly one of `text` | `file`; **plugin-only** — builtin/custom conventions are fragment-only); **at least one of `file`/`scaffold` is required**. A scaffold-bearing entry surfaces `hasScaffold:true` in `list_project_conventions`. Bodies for `file` refs (fragment and scaffold) are resolved against the active checkout; a **missing/stale `file` at manifest load makes the plugin `invalid`** (fail loud). Only **enabled + `ok`** plugins contribute — a disabled/crashed plugin never surfaces its conventions.

**`roles` (active pluginApi:1 capability, no backend).** A plugin can contribute **roles** — a role is a *named model-binding indirection* (parity with the built-in roles in `ROLES`: it carries only a `slug`, a display `name`, and a `binding`, **no** persona/system-prompt). Each entry's `binding` is a tier reference `{kind:"tier",tier}` (a known capability tier) or `{backend:"claude",model}` (a known Claude version id) — it may name **only** the identity `claude` backend, since every other registry row is user-local (its rows and models exist only in that user's settings). **Back-compat:** the pre-registry shape `{kind:"claude",model}` is still **accepted and translated** to `{backend:"claude",model}` on read, so an existing manifest needs no edit; `{kind:"<anything else>",model}` is refused exactly as before. See [models.md](models.md). Entries join the merged role list namespaced **`<plugin-id>/<slug>`** and are resolvable anywhere built-in roles are: MCP `spawn_instance`'s `model` arg, and **user-rebindable** in **Settings → Models → Roles** (a "via `<plugin>`" badge; the manifest binding is the **default** — a per-role **override** is persisted under `models.roleBackend` keyed by the namespaced id and takes precedence at spawn, beating the manifest binding; re-selecting the manifest's tier/model in the picker reverts it). Roles are **not deletable** (plugin-manifest-controlled). The manifest binding is **live-derived from enabled + `ok` plugins** (never persisted) via `pluginHost.roles()` — a **synchronous** accessor, unlike `conventions()`, because a binding has no fragment file to resolve — so **disabling or removing the plugin drops its roles automatically** (no purge — a stored override is retained and re-applies on re-enable, and an override to a since-removed model silently falls back to the manifest binding at spawn). A binding that names a since-removed tier/model makes the plugin `invalid` at manifest load (fail loud). Additive, no migration: an existing manifest without `roles` stays valid.

**`claudePlugin` (active pluginApi:1 capability, no backend).** OPTIONAL string — a path **relative to the cc plugin root** pointing at a **Claude Code plugin root** (a dir directly containing `.claude-plugin/plugin.json`; skills resolve at `<root>/skills/<name>/SKILL.md`). `"claude"`, `"adapters/x"`, or `"."` (the cc plugin root itself) — the author picks the dir. **Shape-validated at manifest load** (relative, no leading `/`, no `..`, not absolute; a bad shape marks the plugin `invalid`). At **every** claude launch — interactive sessions and MCP-spawned workers alike — each **enabled + `ok`** plugin declaring `claudePlugin` contributes one repeatable **`--plugin-dir <resolved-root>`** flag (session-local; `src/instances.ts` `Instance.spawn()`, resolved via `pluginHost.claudePluginDirs()`). **Existence is validated at launch/resolve time, not load:** if `{resolved}/.claude-plugin/plugin.json` is missing/unreadable the flag is **dropped with a loud `console.warn`** (never silently, and the session still launches) — it does **not** invalidate the plugin. Absent field → no flag. Additive, no migration. Resolved+frozen per session at create (mirrors the MCP-config wiring), so a plugin enabled mid-session is picked up on the next spawn, not a bare respawn. Kept a **string** for now; the single accessor `claudePluginPaths(manifest)` (`src/plugins/manifest.ts`) makes widening to `string | string[]` a non-breaking change.

**Convention `scope` (required, explicit).** Every `conventions` entry MUST carry a `scope` — there is no silent default. The accepted enum is **`"project"`** (routes into the project-Conventions catalog described above) and **`"conductor"`** (routes into the Conductor-Conventions catalog — see the ⚠️ note below). `"workspace"` is **planned** and recognised-but-rejected at manifest load with a specific error (`scope "workspace" not yet supported (accepted: "project", "conductor")`); any other value gets the standard invalid-enum error and marks the plugin `invalid`. Expansion is **additive with no migration**: move a scope from planned→supported in `SUPPORTED_CONVENTION_SCOPES` (`src/plugins/manifest.ts`) and wire that scope's group (from the scope-keyed object `pluginHost.conventions()` returns) into its catalog's provider (`workspaceConventions`/`conductorConventions` already exist, built on `fragmentCatalog.ts`). No stored data changes shape.

> ⚠️ **Conductor-scope conventions modify the orchestrator itself.** A `scope:"conductor"` convention injects a fragment into the conductor's **own** operating rules (the composed conductor role prompt) — i.e. a plugin can shape how the orchestrator delegates, reviews, and merges across **every** project, not just a single one. It joins the Conductor-Conventions catalog namespaced `<plugin-id>/<slug>` and is **on by default while the plugin is enabled** (minus any the user unchecks — a remembered off-switch), composed into the conductor's system prompt on the next spawn/context-refresh; disabling the plugin drops it. That is a deliberately powerful, trust-loaded capability — consistent with "plugins are trusted own code", but far beyond a per-project convention, so treat enabling a plugin that ships conductor-scope conventions as granting it orchestrator-wide reach.

**Scaffold delivery (conductor-directive, no persistence).** At project creation the picked conventions that carry a `scaffold` facet have their directive texts composed **in selection order** into one framed orchestrator-guidance block (`Project "<name>" was created with these setup steps…`) that `create_project` (MCP) / `POST /api/projects` (REST) **RETURN** under a `scaffold` field (empty/omitted when none). Nothing is persisted and nothing touches the spawn path. The conductor folds the returned `scaffold` into its **first** `send_prompt` to the project's first worker (see `conventions/conductor/core.md`); the UI shows it read-only in the create confirmation. The scaffold facet has **no `scope` field** by design: it fires at *project creation*, so it is inherently project-scoped — workspaces and the conductor aren't "created", so there is no scaffold trigger for them. *(Future work: persist a lightweight pending-scaffold the conductor can pick up for UI-created projects.)*

Unknown top-level keys are rejected. Every `inputSchema` must stay inside the conductor's `validateArgs` subset — a **flat** `type:"object"` schema (per-property `type`/`enum`/`minLength`/`maxLength`/`pattern`/`minimum`/`maximum`/`items.type`; boolean `additionalProperties` accepted and ignored). `$ref`/`oneOf`/`anyOf`/`allOf`/`not` and nested object `properties` are rejected at manifest load, so an unvalidatable schema can never register. Invalid ⇒ state `invalid`, listed with errors, never startable.

Child env: `$PORT` (conductor-allocated; default your own port when absent so the plugin stays standalone-runnable), `CONDUCTOR_PLUGIN_ID`, `CONDUCTOR_URL` (`http://127.0.0.1:<conductor-port>`), `PROJECTS_ROOT` (the conductor's *resolved* projects root — injected explicitly, so it carries the default even when the conductor's own env never set the var), `CONDUCTOR_PROJECT_DIR` (the conductor's own running checkout dir, holding its `server.ts`/`package.json` — may be outside `PROJECTS_ROOT`). No fixed-port option in v1.

**Discovery rules.** The manifest is read from each project's main checkout. When the main checkout has **no manifest file at all**, the project's worktrees (sorted by name) are checked and the first **valid** manifest wins — so a plugin whose manifest exists only in an unmerged worktree (first-time plugin-ification) can bootstrap. Rows carry `manifestSource: {type:"main"} | {type:"worktree", name}`; enabling a worktree-sourced plugin defaults `activeVersion` to that worktree. A present-but-invalid main manifest keeps its `invalid` state (never masked by a worktree), and `POST /api/plugins/:id/version {type:"main"}` is refused with 400 while the main checkout lacks a valid matching manifest.

### Reverse proxy — `/plugins/<id>/*`

- `/plugins/<id>/foo?q=1` → child `/foo?q=1` (prefix strip). Injected headers: `X-Forwarded-Prefix: /plugins/<id>`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`.
- `GET /plugins/<id>` → `301 /plugins/<id>/` (query preserved). Child `Location:` headers starting with `/` get the prefix re-added — the only header rewrite.
- Bodies are never parsed — pure req→upstream→res streaming (SSE works). WebSocket upgrades are raw-socket piped with the original header order/casing replayed.
- Requests to an enabled-but-stopped plugin wait through the lazy start (`READY_TIMEOUT_MS` in `src/plugins/supervisor.ts`). Unknown/disabled id → 404 JSON; `failed` → `503 {error, status:"failed", tail}`; crash-backoff window → `503 {error, status:"crashed", retryAfter, tail?}`; child unreachable mid-request → 502.

### Bridge protocol — `/pluginBridge.js`

Plugin frontends include `<script src="/pluginBridge.js" defer></script>` (served by the conductor; harmless 404 standalone, no-op when not iframed). Envelope `{cc:1, type, ...}` over `postMessage`, same-origin both ways. Exactly three messages:

| Direction | Type | Payload | Meaning |
|---|---|---|---|
| child → parent | `ready` | — | bridge alive (initial `route` follows) |
| child → parent | `route` | `{path}` | child-relative path (incl. search+hash); parent mirrors it into `#plugin/<id><path>` via `replaceState` |
| parent → child | `navigate` | `{path}` | external navigation; bridge `replaceState`s `<prefix><path>` and dispatches a synthetic `popstate` |

Inside the iframe the bridge patches `history.pushState` → `replaceState`, so a plugin visit adds exactly one joint-history entry (hardware Back exits to the conductor). Multi-page plugins bypass this and pollute history.

### REST — `/api/plugins`

| Method + path | Meaning |
|---|---|
| `GET /api/plugins` | merged discovery+registry+runtime rows: `{id, name, project, version, state, enabled, activeVersion, manifestSource, hasBackend, hasFrontend, navLabel, frontendPath, hasMcp, conventions:[{slug,name,description,hasScaffold}], roles:[{slug,name}], port, pid, startedAt, gitHead, stale, errors, crashTail}` (convention slugs namespaced `<plugin-id>/<slug>`; `hasScaffold` flags a convention carrying a one-time scaffold directive). A backendless (contributions-only) enabled plugin has `state:"enabled"` (never `"stopped"`). `stale` is true only while `state:"ready"` and the active checkout's current HEAD differs from `gitHead` (the sha the child was started at); a non-git checkout or an unreadable HEAD is never stale. |
| `POST /api/plugins/rescan` | re-scan the projects root (auto-assigns any unassigned discovered plugin project to workspace `CC-Dev`); drops the registry's cached fragment bodies (`invalidateFragmentBodies()` — a `git pull`/checkout swap on disk otherwise keeps serving old text for the process lifetime) and regenerates every referencing project's `CONVENTIONS.md`; returns the list |
| `POST /api/plugins/:id/enable` | record + enable; the plugin's `conductor`-scope conventions become on-by-default (minus remembered off-switches) and flow into the conductor's composed prompt on its next spawn/resume (no regeneration step); drops the cached fragment bodies (a fragment can be edited while its plugin sits disabled — enable is the user's own recovery gesture for exactly that) and regenerates every referencing project's `CONVENTIONS.md`; recovery path out of `failed` (workspace auto-assign to `CC-Dev` happens on discovery, not enable specifically — see `rescan` above) |
| `POST /api/plugins/:id/disable` | stop the child + disable; the plugin's conventions leave the catalog automatically, so they simply drop from the conductor's next composed prompt; regenerates every referencing project's `CONVENTIONS.md` (a disabled plugin's slugs are now unresolvable, so this is a no-op skip — see limitation 2 below). The user's off-switches (`pluginOff`) persist for a future re-enable |
| `POST /api/plugins/:id/start` | explicit start (clears crash history); 502 + `tail` on start failure |
| `POST /api/plugins/:id/stop` | SIGTERM the process group (SIGKILL after `GRACE_MS` in `src/plugins/supervisor.ts`) |
| `POST /api/plugins/:id/restart` | stop + start the running child in place (picks up new code from the active checkout); drops the cached fragment bodies and regenerates every referencing project's `CONVENTIONS.md`; 409 if not running |
| `GET /api/plugins/:id/status` | row + live probe (flips a silently-dead child to `crashed`) |
| `POST /api/plugins/:id/version` | `{type:"main"}` \| `{type:"worktree", name}`; validates the target checkout (400 keeps previous state), restarts if running; drops the cached fragment bodies and regenerates every referencing project's `CONVENTIONS.md` either way (even when stopped, so an active-version switch on a backendless plugin still refreshes) |
| `GET /api/plugins/library` | Plugin Library catalog: `{id, name, description, repo, installed, installedAs, updateAvailable, behind}[]` — `installed` is true when the repo's derived target directory already exists under `projectsRoot()`. For each installed entry, a bounded (8s) best-effort `git fetch` runs first (never blocks the list on failure/timeout/no-remote/auth), then `updateAvailable`/`behind` come from comparing HEAD against its upstream (`getProjectUpstreamStatus`, `src/worktrees.ts`); `behind` is `null` and `updateAvailable` is `false` when not installed, not a git repo, detached HEAD, or no upstream configured. |
| `POST /api/plugins/library/:id/install` | clone the entry's `repo` into `<projectsRoot>/<name>` (name derived from the URL), rescan (drops cached fragment bodies), **enable the freshly-discovered plugin by default** (start-neutral — no process launched; an invalid/conflicting manifest is left disabled), run `postClone` if set, then regenerate every referencing project's `CONVENTIONS.md`. **Streaming response** — see below. |
| `POST /api/plugins/library/:id/update` | the real sequence: `git pull --ff-only` in `<projectsRoot>/<name>` → rescan (drops cached fragment bodies) → run `postPull` if set → resolve which of the plugin's children are actually running (`ready`/`starting`) **first** → if none are running, nothing to restart, regardless of `postPull`'s outcome; if some are running and `postPull` ran and failed, the restart is **skipped entirely** (a broken `postPull` means the checkout is half-built, and restarting into it would trade a healthy child serving old code for one that crash-loops serving no code at all — the child is left exactly as it was); otherwise **auto-restart every running child of this plugin** → regenerate every referencing project's `CONVENTIONS.md`. The result gains `restarted: {ids, ok, error} | {skipped:"postPull-failed"} | null` (`null` when nothing was running, checked before the skip so it's never mislabeled as one) and the NDJSON `phase` set gains `"restart"` (one `"[restarted <id>]"` chunk per restarted child, or one `"[skipped restart: post-update command failed]"` chunk on a skip). **Streaming response** — see below. |

Errors: `{error}` JSON with 400/404/409/502/503 per the registry rules above.

**Known limitations.**
1. **Already-running sessions are not reached.** `--append-system-prompt-file` is read at spawn; `conductor-prompt.md` is re-materialized per launch. New convention text reaches a conductor on its **next spawn/resume**, and a worker's project `CLAUDE.md`/`CONVENTIONS.md` on its next session — never mid-turn.
2. **A project whose marker holds any unresolvable slug stays frozen** — `ensureProjectConventionsMd` (`src/projectClaudeMd.ts:96-101`) skips regenerating a project's whole `CONVENTIONS.md`, including its other, resolvable conventions, when *any* referenced slug can't be resolved (a disabled/removed plugin, a retired custom convention). Now logged per project (`CONVENTIONS.md left as-is for '<project>': unresolvable <slugs>`) via `{ log: console }` passed to `regenerateAllProjectConventions()` from every plugin route above, so the freeze is at least visible in the server log rather than silent. The freeze itself is unchanged and tracked separately.

**Install/update streaming response.** Both routes validate synchronously first (unknown id, bad URL scheme, name collision/already-installed for install; unknown id/not-installed for update) — a validation failure is a plain `{error}` JSON body with the usual 400/404/409 status, no different from any other route. Once validation passes, the response becomes `Content-Type: application/x-ndjson`, one JSON object per line, status always 200 from that point on (headers are already committed):
- `{"type":"chunk","phase":"clone"|"pull"|"hook"|"restart","text":"..."}` — live stdout/stderr text from the clone/pull or the postClone/postPull hook, as it arrives; `"restart"` chunks (`update` only) are one `"[restarted <id>]"` line per plugin backend the update auto-restarted.
- exactly one terminal `{"type":"result","ok":true,"result":{id,name,project,path,postClone|postPull,restarted?}}` on success, or `{"type":"result","ok":false,"error":"...","tail":"..."}` on a clone/pull failure (`postClone`/`postPull`/`restarted` failures are still a soft warning inside the `ok:true` `result`, same shape/semantics as before — see below) — a failed clone is also rolled back (partial dir removed) before this event is written. `restarted` is present only on `update`'s result: `{ids, ok, error} | {skipped:"postPull-failed"} | null` — `null` when the plugin had no running backend to restart (this check runs before the skip decision, so a failed `postPull` on a plugin that was never running is still `null`, never the skip shape); `ok:false` (with `error`, and `ids` holding whatever restarted before the failure) means the pull/postPull already succeeded and landed on disk, only the restart itself failed — the caller should manually **Restart**; `{skipped:"postPull-failed"}` means a running backend was found but its restart was never attempted — a failed `postPull` already left the checkout half-built, so that running backend is left untouched, still serving pre-pull code, until the user fixes `postPull` and retries **Update** (or hits **Restart** once they trust the checkout).

#### Plugin Library — drop-in manifest, `<orchStoreRoot()>/plugins/library/*.json`

One JSON object per file (any filename ending `.json`), registering an installable plugin entry:

```jsonc
{
  "id": "my-plugin",             // REQUIRED, unique catalog key — overrides a built-in entry with the same id
  "name": "My Plugin",           // REQUIRED display name
  "description": "optional",     // OPTIONAL
  "repo": "https://github.com/org/my-plugin", // REQUIRED clone URL — scheme must be http:, https:, or git:
  "postClone": "bash install.sh", // OPTIONAL shell command, run via `bash -lc`, cwd = the cloned project dir
  "postPull": "bash install.sh"   // OPTIONAL shell command, run via `bash -lc` after a successful Update pull
}
```

A set of built-in library entries is always present (see `src/plugins/library.ts`), even with no library dir. Malformed JSON or a file missing `id`/`name`/`repo` is skipped with a `console.warn` — never fatal to the list. The install target project name is the URL's last path segment with a trailing `.git` stripped (e.g. `.../org/my-plugin(.git)` → `my-plugin`), validated the same way as any other project name.

**`postClone`/`postPull` execution.** Run bounded (via `POST_HOOK_TIMEOUT_MS`) via a detached process group so a command that spawns children of its own (`npm install`, a browser-binary downloader) can be fully killed on timeout, not just its direct child; output is captured (bounded via `HOOK_OUTPUT_CAP`, with a tail surfaced in the response). This is a code-execution surface — acceptable because built-in entries are trusted and drop-in files come from trusted local tooling (the same trust stance that already applies to a plugin's own manifest `backend.start`). **Asymmetric failure handling is intentional:** a failed `git clone`/`git pull` is a hard failure (the request rejects; a failed clone is also rolled back) because the underlying operation itself didn't succeed, whereas a failed `postClone`/`postPull` is reported as a **soft warning on an otherwise-successful response** — the clone/pull already succeeded and is already discoverable, only the convenience command failed. The documented retry path for a failed `postClone` is hitting **Update** (which reruns `postPull`) rather than reinstalling — `code-playwright` sets both fields to the identical command specifically so Update is a true retry.

### Plugin MCP forwarding — child wire contract (pinned)

The conductor POSTs `{tool, arguments, caller:{sessionId, project}}` (JSON) to the manifest `mcp.endpoint`. The child returns **HTTP 200 for EVERY well-formed tool invocation** with body `{result: <any JSON>}` or `{error: "<message>"}` — unknown tool, bad arguments and tool-level failures are all `200 + {error}`. A **non-200 means a transport-level failure only** (malformed envelope, plugin bug) and surfaces to the MCP client as an HTTP-coded error; `200 + {error}` surfaces as a plain tool error. Calls are aborted at `mcp.timeoutMs`. Tool names are namespaced `<plugin-id>__<tool>`; argument validation against the declared `inputSchema` happens in the conductor **before** any forward. Visibility: every enabled plugin's tools are offered to **every** MCP caller — the conductor UI and workers in any project (`scope` is inert); a disabled plugin's tools are absent, so calling one refuses as an unknown tool.

**Raw-text results (opt-in, additive).** A success body may return `{text, meta?}` **instead of** `{result}`. `text` is one string **or** a list of strings; each becomes a **raw, UNESCAPED** `content[]` block, appended after a compact-JSON block holding `meta` (`null` when omitted). Use it for anything a human or LLM reads as prose — a wiki page, a diff, file contents — where `{result}`'s `JSON.stringify` would escape every newline. `{result}` remains correct for structured data; a body with no `text` key behaves exactly as before.

Two edges, both deliberate:

- **`text` wins over `result`.** Sending both is a contract violation; it degrades to the `text` path rather than throwing, and `result` is ignored.
- **`meta` without `text` is silently dropped.** With no `text` key the body falls through to the `result` path, which never reads `meta`. This is the design's only lossy case — `meta` is meaningful *only* alongside `text`. To emit metadata with no body, send `{meta, text: []}` (or `text: null`), which yields the meta block and zero text blocks.

`text: null` → zero text blocks. A non-string (`text: 42`) is stringified, not rejected — nothing on this path throws.

### Plugin-compliance checklist

1. `conductor.plugin.json` at the repo root (schema above); keep `id` stable.
2. Respect `$PORT` when set; default your own port so the app stays standalone-runnable.
3. Base-path compliance: reachable under `X-Forwarded-Prefix` — relative asset URLs (or honor the prefix), root-relative redirects only (they get rewritten).
4. `<script src="/pluginBridge.js" defer></script>` in the frontend + SPA routing via pushState/replaceState (the bridge reports routes for you).
5. A `healthPath` endpoint (any HTTP response counts as alive).
6. Optional MCP endpoint following the 200-always contract above, tools declared in the manifest with flat schemas. Return `{result}` for structured data; return `{text, meta?}` when the tool's output is prose/diff/file content that should reach the caller un-escaped (`text` wins if both are sent; `meta` alone, without `text`, is dropped).
7. Expect to be killed at any time (Doze) and restarted lazily — persist state, start fast.
8. If a convention's fragment depends on something its `scaffold` facet sets up, **word the fragment to degrade gracefully** when the scaffold step wasn't run — the picked convention may land in a project where the setup directive was never carried out (e.g. "if a project-local harness wrapper exists, use it to visually verify UX changes; otherwise see the shared harness to create one").
