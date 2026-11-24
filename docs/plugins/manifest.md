# Plugin system: the manifest

## Manifest — `conductor.plugin.json` at the plugin project root

```jsonc
{
  "id": "code-hub",             // REQUIRED ^[a-z][a-z0-9-]*$ ≤40 chars, unique across all projects
  "name": "Code Hub",           // REQUIRED display name
  "version": "0.3.0",           // REQUIRED informational
  "pluginApi": 1,               // REQUIRED int; conductor supports [1], anything else ⇒ state "incompatible"
  "backend": {                  // OPTIONAL (manifest-only/library plugins omit)
    "start": "npm start",       // bash -lc, cwd = active checkout, $PORT injected
    "healthPath": "/api/health",// optional readiness probe + on-demand liveness probe
    "readyWhen": "listening"    // optional regex over this run's stdout/stderr (the backend log file) (precedence: readyWhen → healthPath → TCP)
  },
  "frontend": {                 // OPTIONAL, requires backend
    "path": "/",                // default "/"
    "navLabel": "Hub",          // default = name
    "keepAlive": false,         // default false; true ⇒ the page keeps running after the user leaves the view — see "Frontend keep-alive"
    "icon": "square-kanban"     // optional; one of PLUGIN_ICONS (shared/pluginIcons.ts); absent ⇒ generic plug
  },
  "mcp": {                      // OPTIONAL, requires backend
    "endpoint": "/api/mcp",     // single POST endpoint on the child
    "scope": "project",         // TOLERATED AND DROPPED — accepted only because code-hub's shipped
                                //   manifest declares it; the value is read nowhere, not normalized,
                                //   and not enum-checked.
    "timeoutMs": 30000,         // per-call cap, clamped to `MCP_TIMEOUT_CAP` (`src/plugins/manifest.ts`)
    "tools": [{ "name": "...", "description": "...", "inputSchema": { "type": "object", ... },
                "outputSchema": { "type": "object", ... },  // outputSchema OPTIONAL — required for the tool to
                                //   exist in JSON format; see "Typed plugin tools (both formats)"
                "audience": "conductor" }]  // OPTIONAL: "all" (default) | "conductor" | "worker" — see "Tool audience"
  },
  "conventions": [              // OPTIONAL, NO backend required — project conventions
    { "slug": "visual-verification",           // ^[a-z][a-z0-9-]*$ ≤40, unique in this array
      "name": "Visual UX verification",        // REQUIRED
      "description": "verify UX via the harness", // REQUIRED
      "scope": "project",                      // REQUIRED enum — "project" or "conductor" accepted ("workspace" planned; see below)
      "file": "conventions/visual-verification.md", // OPTIONAL CLAUDE.md fragment: relative .md path, no leading '/' or '..'
      "scaffold": {             // OPTIONAL facet — a one-time project-setup directive
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
  "playbooks": [                // OPTIONAL, NO backend required — playbook graphs
    { "slug": "release",                     // ^[a-z][a-z0-9-]*$ ≤40, unique in this array; MUST equal the body's own `id`
      "file": "playbooks/release.json" }     // REQUIRED: relative .json path, no leading '/' or '..'
                                             //   (no name/description here — the body owns them)
  ],
  "claudePlugin": "claude",     // OPTIONAL string, NO backend required — Claude Code plugin root
                                // (relative path, no leading '/' or '..'; "." = the cc plugin root itself)
  "runCode": {                  // OPTIONAL object, NO backend required — names a run_code program calls as
                                // `cc.<ns>.<name>(args)`, served by one ES module (see `runCode` below)
    "module": "run-code/index.mjs",  // REQUIRED: relative path, no leading '/' or '..', ending .mjs or .js; must exist at manifest load
    "members": [                // REQUIRED, non-empty; each entry is exactly these four keys
      { "name": "connect",      // REQUIRED: ^[A-Za-z_][A-Za-z0-9_]*$, not "then", unique, not one of THIS plugin's mcp.tools names
        "description": "…",     // REQUIRED non-empty string
        "inputSchema": { "type": "object", "properties": {} },  // REQUIRED, the mcp tool inputSchema rules
        "outputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }  // OPTIONAL, the mcp tool outputSchema rules
    ]
  },
  "menuItems": [                // OPTIONAL, REQUIRES `frontend` — buttons in the sidebar's project / worktree ⋮ menus
    { "label": "Board",         // REQUIRED: non-empty after trim, ≤ MENU_LABEL_MAX chars
      "scope": "project",       // REQUIRED: "project" | "worktree" (MENU_ITEM_SCOPES)
      "path": "/board" }        // REQUIRED: '/'-led path inside the frontend, ≤ MENU_PATH_MAX chars
  ]
}
```

`conventions` is an **active pluginApi:1 capability** (an additive extension of v1, not a version bump — an existing manifest without it stays valid).
It works with **no backend**, so a contributions-only plugin is `{id,name,version,pluginApi,conventions}`: it validates, enables, contributes, and is **never started** (its Settings row shows only Disable + contribution badges; `POST .../start` refuses 400).
Entries join the project **Conventions** catalog namespaced `<plugin-id>/<slug>` (visible in the new-project dialog + `list_project_conventions`).
Each entry carries a CLAUDE.md **`file`** fragment (applied inline to a project's CLAUDE.md at creation — the applied copy survives plugin disable/uninstall) and/or a **`scaffold`** facet (a one-time setup directive via exactly one of `text` | `file`; built-in conventions are fragment-only; a custom project convention takes a scaffold in Settings); **at least one of `file`/`scaffold` is required**.
A scaffold-bearing entry surfaces `hasScaffold:true` in `list_project_conventions`.
Bodies for `file` refs (fragment and scaffold) are resolved against the active checkout; a **missing/stale `file` at manifest load makes the plugin `invalid`** (fail loud).
Only **enabled + `ok`** plugins contribute — a disabled/crashed plugin never surfaces its conventions.
**A fragment `file` may carry a skill part:** a `<!-- cc:skill <description> -->` line splits it into the inline fragment (above) and a Claude Code skill body (below) — the grammar of the built-in fragments ([components/playbooks.md → Convention skill parts](../components/playbooks.md#convention-skill-parts)), with no explicit name (the skill is named by the plugin-local slug).
It is delivered as `cc-<scope>-<plugin-id>:<slug>` wherever the inline part is in force, and only there.
The marker is **validated at manifest load** (a malformed one, a second one, an empty description or body, or an explicit name makes the plugin `invalid`).
Unlike `claudePlugin`, it is **delivered even when the plugin's project is on a remote system**: `PLUGIN_DIR_LOCAL_ONLY` exists because a remote directory cannot be a `--plugin-dir`, whereas a skill part is text cc already reads through the project's System and writes to a local generated root.

**`roles` (active pluginApi:1 capability, no backend).**
A plugin can contribute **roles** — a role is a *named model-binding indirection* (parity with the built-in roles in `ROLES`: it carries only a `slug`, a display `name`, and a `binding`, **no** persona/system-prompt).
Each entry's `binding` is a tier reference `{kind:"tier",tier}` (a known capability tier) or `{backend:"claude",model}` (a known Claude version id) — it may name **only** the identity `claude` backend, since every other registry row is user-local (its rows and models exist only in that user's settings).
**Back-compat:** the pre-registry shape `{kind:"claude",model}` is still **accepted and translated** to `{backend:"claude",model}` on read, so an existing manifest needs no edit; `{kind:"<anything else>",model}` is refused exactly as before.
See [models.md](../models.md).
Entries join the merged role list namespaced **`<plugin-id>/<slug>`** and are resolvable anywhere built-in roles are: MCP `spawn_instance`'s `model` arg, and **user-rebindable** in **Settings → Models → Roles** (a "via `<plugin>`" badge; the manifest binding is the **default** — a per-role **override** is persisted under `models.roleBackend` keyed by the namespaced id and takes precedence at spawn, beating the manifest binding; re-selecting the manifest's tier/model in the picker reverts it).
Roles are **not deletable** (plugin-manifest-controlled).
The manifest binding is **live-derived from enabled + `ok` plugins** (never persisted) via `pluginHost.roles()` — a **synchronous** accessor, unlike `conventions()`, because a binding has no fragment file to resolve — so **disabling or removing the plugin drops its roles automatically** (no purge — a stored override is retained and re-applies on re-enable, and an override to a since-removed model silently falls back to the manifest binding at spawn).
A binding that names a since-removed tier/model makes the plugin `invalid` at manifest load (fail loud).
Additive, no migration: an existing manifest without `roles` stays valid.

**`playbooks` (active pluginApi:1 capability, no backend).** A plugin can contribute **playbook graphs** — the same stage-graph definitions as the built-ins and the `<store>/playbooks/` overlay ([protocol/playbooks.md](../protocol/playbooks.md#playbooks)), governed by the same gate, event log and read tools. A plugin may read the event log file itself; its record format is [event-log.md](../event-log.md).
- **Shape:** `playbooks: [{slug, file}]` and nothing else per entry (`unknown key 'playbooks[i].x'` otherwise). `slug` is a slug, unique in the array (`duplicate playbook slug 'x'` → `invalid`). `file` follows the convention-`file` path rules with a **`.json`** extension (`'playbooks[i].file' must end with '.json'`).
- **Id:** listed as **`<plugin-id>/<slug>`** (`list_playbooks` entries carry `plugin: "<plugin-id>"`). The body's own `id` must equal the **bare** slug — a mismatch is rejected as `id '<x>' does not match its manifest slug '<slug>'`.
- **The `/` invariant:** built-in and overlay ids are slugs, which cannot contain `/`, so a plugin playbook can never collide with (or be shadowed by) one, and plugin ids are unique across plugins (registry `conflict` state). The same `/` is how an id is attributed to its plugin once that plugin is gone (`pluginIdOfPlaybook`, `src/playbooks.ts`).
- **Read at manifest load**, through the project's System, and held on the manifest (`readManifest`, `src/plugins/manifest.ts`). A missing file makes the plugin **`invalid`** (`playbooks '<slug>' file '<file>' not found`; any other read failure → `… unreadable: <msg>`).
- **Graph validated by the shared loader** (`loadPlaybooks`, `src/playbooks.ts`), not at manifest load: bad JSON or a bad graph rejects **only that playbook**, reported in `list_playbooks` → `errors` keyed by the namespaced id; the plugin stays `ok` and its other contributions keep working. A throwing plugin host costs only plugin playbooks, reported as one `{id:"plugins"}` error.
- **Freshness equals roles':** a body refreshes only when the plugin's held manifest is replaced. **Rescan**, **Library Update** and a server restart re-read the *discovered* checkout (the main clone, or the worktree fallback when main has no manifest). A **backend start** (`doStart`) re-reads the *active version's* checkout. **An active-version switch re-reads nothing on its own**: `setActiveVersion` validates the target manifest and discards it, so it refreshes only when it restarts a backend that was `ready`/`starting`. A stopped, crashed or failed backend, or a backendless plugin, keeps its bodies until the next Rescan or start. **Enable does not re-read.**
- **Live-derived from enabled + `ok` plugins** via `pluginHost.playbooks()` — **async, and awaits discovery**, so a governed call or resume at boot cannot see an empty set.
- **Disable/removal drops the playbook** under the existing drift rule: a worker bound to it is refused `PLAYBOOK_UNKNOWN` (governed calls under `enforce`; `warn` proceeds) and on `spawn_instance({resume})`; the targeted `playbook_state` meets the same refusal under `enforce`, and elsewhere (under `warn`, or for an ungoverned caller) reports `playbookMissing` with a `reason`. Every such reason names the owning plugin and, without asserting a cause it cannot see, routes the reader to `list_playbooks` → `errors`: a `plugins` entry means the plugin host is unavailable, an entry under the playbook's id means an invalid body, and with neither the plugin is disabled (re-enable restores it), removed, no longer declares it, or its manifest is invalid as a whole — e.g. a playbook file deleted before a Rescan, or a bad role binding; the plugin stays enabled but `invalid`, the errors are on its Settings → Plugins row (`GET /api/plugins` → `errors`), and enable refuses 409 until it is fixed (`missingPlaybookCause`, `src/playbooks.ts`). The binding in the event log is untouched, so **re-enabling restores governance on the same session with no repair**. Disable is never blocked.
- **Preferred playbook:** a plugin playbook can be chosen in Settings → Conventions → Conductor only while loaded; the choice is **retained through a disable** and applies again on re-enable (`defaultPlaybookMissing` in the Settings payload meanwhile).
- **Model pins:** a stage `pin` naming a role is resolved only at spawn. Pinning the plugin's own role works; pinning another plugin's role while that plugin is disabled leaves the playbook listed, and the spawn fails with `spawn_instance`'s `unknown model '<role>'` error.
- The conductor's role doc lists plugin playbooks from its next spawn/resume (Known limitations → "Already-running sessions are not reached"); the MCP tools see them on the next call.
- **Authoring overlay playbooks from a plugin** (a GUI editor) is a different path from contributing them: see [Authoring playbooks from a plugin](runtime.md#authoring-playbooks-from-a-plugin).

**`runCode` (active pluginApi:1 capability, no backend).** OPTIONAL `{module, members}` — named members of the plugin's own namespace that a `run_code` program calls as `cc.<ns>.<name>(args)`, for results an MCP tool cannot return (a connected page, a client). One ES module backs all of them. To a script author a member is indistinguishable from a plugin tool: the same `cc.<ns>.<name>(args)` and `cc.call('<id>__<name>', args)` spellings, the same `describe_tools` entry, the same `ARGS_INVALID` / `TOOL_UNKNOWN` refusals.

- **Member entry** — exactly `name`, `description`, `inputSchema`, `outputSchema`. `description` and `inputSchema` are required; `outputSchema` is optional, as for an mcp tool, and obeys the same rules (the strict output subset, root `type: "object"`). `description` is where a plugin whose members return interactive objects names its skill and gives an example. Arguments are one object, as for a tool: a plugin that wants an `import` member declares `import` taking `{name}`. cc reserves no namespace member name.
- **Manifest errors** (each makes the plugin `invalid`): `'runCode' must be an object`; `unknown key 'runCode.<k>'` / `'runCode.members[i].<k>'` (a manifest carrying `runCodeModule` is `unknown key 'runCodeModule'`); `'runCode.module' is required (relative path)`, `… must be a non-empty relative path`, `… must be a relative path with no '..' segment`, `… must end with '.mjs' or '.js'`; `runCode.module '<rel>' not found` (existence is checked at load, so point it at a tracked source file, not a build output); `'runCode.members' is required (non-empty array)`; `'runCode.members[i].name' is required and must match ^[A-Za-z_][A-Za-z0-9_]*$ (not 'then' or an Object.prototype property name)`; `duplicate runCode member '<n>'`; `'runCode.members[i].name' '<n>' is also an mcp tool of this plugin`; `'runCode.members[i].description' is required (non-empty string)`; `'runCode.members[i].inputSchema' is required (object)` plus each `checkSchemaSubset` error; each `checkOutputSchema` error under `'runCode.members[i].outputSchema'`.
- **A collision is refused, never shadowed**, so `<id>__<name>` has one meaning and the module reaches every tool of its own plugin through `ctx.cc.<ns>.<tool>` (or `ctx.cc.call('<id>__<tool>', args)`, the only spelling for a plugin whose id is a reserved `cc` method such as `call`, which reaches its members through `cc.call` too).
- **Resolution.** The child's `cc.call` is the one dispatcher: a `<id>__<m>` the run's `CC_RUN_MEMBERS` snapshot lists runs the member path, any other name POSTs the REST alias. `precheck` and `describe_tools` read the same declarations.
- **Not the tool gate.** A call into a tool goes through cc's `runTool` (argument validation, prefix resolution, playbook policy, audience, event log). A member call does not: it runs inside the program's own process after the lookup, so it is not playbook-gated, audience-checked or event-logged. Only `inputSchema` is enforced, by the program-side `validateArgs`; what the member does next is the plugin's own code and trust (see "Identity is advisory" below).
- **Module and factory.** The module's default export is `(ctx) => object | Promise<object>` (a function result is `PLUGIN_LOAD_FAILED`; a member is the object's property of that name, own or inherited, and must be a function, so a class instance's methods work with `this` = that instance; a declared name that is not a function is `PLUGIN_LOAD_FAILED`; names every object inherits (`Object.prototype`'s, such as `toString`) are refused at manifest load; a declared name the object does not implement but inherits from a built-in it extends (a `Map`'s `get`) resolves to that built-in, which is the plugin's own bug), `ctx = {pluginId, baseUrl, caller: {sessionId, project}, cc}` (`baseUrl` is the plugin's proxy origin `<cc>/plugins/<id>`, or `null` without a backend). A member call is `Reflect.apply(obj[name], obj, [args])`: its value, and its own throws and rejections, pass through unchanged (a member's own `code` reaches the program as a plugin tool's does). A factory must not call its own members through `ctx.cc`: the promise cycle would hang the run until the timeout; call the tools instead, or call the functions directly.
- **Lazy, once per run per namespace.** The first call into a namespace does the lookup (`GET run-modules/<id>`), validates the arguments, then `import()`s the module and runs the factory. Lookup and load are each memoized per namespace, so a load failure fails every member of that namespace for the run; argument failures are per call. A program that never calls a member never touches the module.
- **Arguments are validated, returns are not.** `inputSchema` (a `pattern` that does not compile makes the manifest `invalid`, for tools too: `'<path>.pattern' is not a valid regular expression: …`) is enforced on every call before the module loads (`validateArgs`, `src/mcp/argValidation.ts`, the same check a tool gets: `ARGS_INVALID` 400), because agents rely on a member's schema being enforced as a tool's is, and an unenforced one drifts silently from the code. `outputSchema` is description only: cc **never validates a member's return value against it**, because a member may return live objects (a connected page, a client) that cc must not inspect, serialize or touch. `describe_tools` renders it through the code path a tool's `outputSchema` takes, so the `full` signature is `Promise<…>` over the declared shape, and `Promise<unknown>` without one.
- **What a program sees.**

| `code` | `status` | When |
|---|---|---|
| `ARGS_INVALID` | 400 | the arguments fail the member's `inputSchema`; nothing loaded |
| `TOOL_UNKNOWN` | 404 | the plugin no longer provides the member (disabled, `invalid`, `incompatible`, or the member undeclared after the run started); `reason` is `unknown tool: <id>__<m> — <host reason>` |
| `TOOL_UNAVAILABLE` | 409 | the plugin's project is on another system, or its checkout cannot be located; `reason` says which |
| `PLUGIN_LOAD_FAILED` | 500 | `import()` threw (syntax error, missing dependency, top-level throw), the default export is not a function, the factory threw, rejected or returned a non-object, or the loaded object has no function at the called name. `reason` is `<plugin id>: <error name>: <message>`; `cause` is the original error |
| the member's own error | as thrown | passed through |
| `RUN_TOKEN_INVALID` | 403 | the lookup route was called without a live run token for this session (guards the route; a program cannot trigger it) |

- **Not an MCP tool.** Members are absent from `tools/list` and the REST listing and are listed only by the in-script `describe_tools`. A JSON-RPC or REST call to `<id>__<m>` from outside a run is `TOOL_UNKNOWN` with a reason saying it is callable only from inside a run_code program, as the `describe_tools` spelling of the call (`cc.<ns>.<m>(args)`, or `cc.call('<id>__<m>', args)` when the plugin id is a reserved method).
- **Dependencies** resolve from the module's own location: the plugin's active checkout `node_modules`, then ancestor directories, never cc's install. Install them in the **active** checkout (a worktree with no `node_modules` falls through to ancestors).
- **Identity is advisory; trust is the program's.** The module runs in the calling program's own process with its full authority (the run token, `fetch`, the `cc` object); it is not isolated, which is the same trust as any plugin code. A module's direct request to its backend carries whatever identity the module puts on it, and the backend cannot verify it (`/mcp` has no auth and loopback ports are reachable by any local process — [Tool audience](tools.md#tool-audience)). A backend that wants cc-attributed identity takes the call through its MCP tool via `ctx.cc`.
- **Environment.** The child inherits cc's `process.env` unscrubbed, like the plugin's backend. A module reads its context from `ctx`, never from env.
- **Large or binary output.** There is no image channel: return a **file path** the agent opens with Read, written outside the caller's checkout under the plugin's data dir. A plan-mode child cannot write files, so a member that must work there sends the bytes to its backend, which writes them under `$CONDUCTOR_PLUGIN_DATA_DIR` and returns the path.
- **Plan mode.** Modules load (reads are granted) and the network stays open; writes are denied ([code-mode.md → Plan mode](../code-mode.md#plan-mode)). A module using Playwright's `connectOverCDP` must pass `artifactsDir`, or it fails in plan mode because `mkdtemp` is denied.
- **Local-only.** The module is read from the **active checkout** of an **enabled + `ok`** plugin (`pluginHost.runCodeModule` / `runCodeMembers`, `src/plugins/contributions.ts`); backend state does not matter. A remote caller is refused `SCRIPT_UNAVAILABLE_REMOTE` before any child spawns, and a plugin whose project is on a non-`local` system is `TOOL_UNAVAILABLE` with its row carrying `RUN_CODE_LOCAL_ONLY`.
- Additive, no `pluginApi` bump; a cc that predates the key rejects it as `unknown key`.

**`claudePlugin` (active pluginApi:1 capability, no backend).**
OPTIONAL string — a path **relative to the cc plugin root** pointing at a **Claude Code plugin root** (a dir directly containing `.claude-plugin/plugin.json`; skills resolve at `<root>/skills/<name>/SKILL.md`).
`"claude"`, `"adapters/x"`, or `"."` (the cc plugin root itself) — the author picks the dir.
**Shape-validated at manifest load** (relative, no leading `/`, no `..`, not absolute; a bad shape marks the plugin `invalid`).
At **every** claude launch — interactive sessions and MCP-spawned workers alike — each **enabled + `ok`** plugin declaring `claudePlugin` contributes one repeatable **`--plugin-dir <resolved-root>`** flag (session-local; `src/instances.ts` `Instance.spawn()`, resolved via `pluginHost.claudePluginDirs()`).
**Existence is validated at launch/resolve time, not load:** if `{resolved}/.claude-plugin/plugin.json` is missing/unreadable the flag is **dropped with a loud `console.warn`** (never silently, and the session still launches) — it does **not** invalidate the plugin.
Absent field → no flag.
**A plugin whose PROJECT is on a non-`local` system contributes no flag at all** (`PLUGIN_DIR_LOCAL_ONLY`): `--plugin-dir` takes an absolute LOCAL directory, and passing the remote path through would load whatever sits at that path on cc's own machine into every session.
**Plugin roots follow cc's built-in root** (`--plugin-dir <cc>/claude-plugin` comes first — [features/mcp.md → Core skills](../features/mcp.md#core-skills)).
**A same-name collision is unhandled:** a plugin root whose `.claude-plugin/plugin.json` `name` equals the built-in root's (`code-conductor`) is passed through alongside it, and how the CLI resolves two same-named roots is unmeasured.
Additive, no migration.
Resolved+frozen per session at create (mirrors the MCP-config wiring), so a plugin enabled mid-session is picked up on the next spawn, not a bare respawn.
Kept a **string** for now; the single accessor `claudePluginPaths(manifest)` (`src/plugins/manifest.ts`) makes widening to `string | string[]` a non-breaking change.
A contributed hook or MCP server identifies the session it runs in through `CC_SESSION_ID` / `CC_SESSION_KIND` and reaches cc at `CONDUCTOR_URL` (a `.mcp.json` can name `"url": "${CONDUCTOR_URL}/mcp/${CC_SESSION_ID}"`): see [mcp-applications.md → Resolve your own session](../mcp-applications.md#resolve-your-own-session).

**`menuItems` (row ⋮ buttons, needs `frontend`).** A plugin with a frontend can put buttons in the sidebar's project and worktree ⋮ menus. A click only navigates to the plugin's own frontend: no plugin code runs in the host and the click makes no backend call of its own.
- **Shape:** `menuItems: [{label, scope, path}]` and nothing else per entry (`unknown key 'menuItems[i].x'` otherwise); a non-empty array of at most `MENU_ITEMS_MAX` entries (all constants exported from `src/plugins/manifest.ts`).

| Field | Rule |
|---|---|
| `label` | string, non-empty after `trim()`, at most `MENU_LABEL_MAX` characters after trim; stored trimmed, rendered as plain text |
| `scope` | exactly one of `MENU_ITEM_SCOPES`: `project` (the project row's ⋮) or `worktree` (the worktree row's ⋮) |
| `path` | at most `MENU_PATH_MAX` characters; starts with `/` and uses only RFC 3986 path characters, so no `%`, `?`, `#`, `\`, whitespace or control character; no `//`; no `.` or `..` segment |

- **Invalid:** any bad entry, or `menuItems` without `frontend`, puts the whole plugin in `invalid` (`'menuItems' requires 'frontend'`); entries are never dropped one by one.
- **Row field:** `GET /api/plugins` rows carry `menuItems` (`[]` when none).
- **Placement:** enabled plugins with a frontend (the app switcher's catalog, `catalogStore`) contribute, in both sidebar lenses (the Conductors lens on rows that carry a ⋮). Between the existing items and the separator before Delete… / Remove worktree…: plugins with exactly one item in the menu's scope come first as flat entries behind one separator, each with the plugin's icon and a trailing tag, `pluginShortName` (`web/src/features/views/pluginMenu.ts`: `appLabel` minus a leading `Code `, else the whole label), which is the item's accessible description, not its name; plugins with more than one item follow, one separator-led group each, labelled with `appLabel` (its `navLabel`, else its `name`), their items with icons and no tag. Catalog order within each list, manifest order for items. No contributing plugin leaves the menu as it was.
- **Click:** when a plugin shows beside the session (split, rail or a split too narrow to fit) the target opens in the dock, replacing a different docked plugin as a plugin link does (`showLinkInDock`, `web/src/features/views/dock.ts`); otherwise it opens the plugin's full view (`openPlugin`, which replaces the history entry when already inside a plugin view). Loading the frame is the switcher's status / lazy-start path.
- **Scope delivery:** the page receives the row in its **query string**: `ccProject` (the project name) and, for a worktree item, `ccWorktree` (the `worktreeName`; absent for a project item), form-urlencoded. Read them with `new URLSearchParams(location.search)` on load and on `popstate`. The first load arrives through the frame `src`, an already-open page through cc's `navigate` message (a `popstate`); the values survive a reload and Expand / Dock to side. They are independent of the bridge's `ccBridge.session`, which stays the active session. **Treat both as untrusted text** a user or agent chose: render them as text only, never as markup and never into `src`, `href` or `style`, even though cc's current name rules restrict their charset.

```jsonc
"menuItems": [{ "label": "Board", "scope": "project", "path": "/board" }, { "label": "Diff", "scope": "worktree", "path": "/diff" }]
```
```js
const q = new URLSearchParams(location.search);
const project = q.get('ccProject');
const worktree = q.get('ccWorktree'); // null for a project item
```

**Frontend icon (`frontend.icon`).** OPTIONAL; one of `PLUGIN_ICONS` (`shared/pluginIcons.ts`, lucide kebab names; the web maps them in `web/src/features/views/PluginIcon.tsx`). Any other value (an unlisted name, a non-string, `""`) pushes `'frontend.icon' must be one of: <PLUGIN_ICONS joined by ", ">` and marks the plugin `invalid`. It rides the row as **`icon`** (`null` unless the entry is `ok` and declares one, as for `menuItems`) and is shown on the plugin's app-switcher entry and its row ⋮ entries; absent ⇒ `PlugIcon`.

**Frontend keep-alive (`frontend.keepAlive`).** OPTIONAL boolean, default `false`; any other type (`"true"`, `1`, `null`) pushes `'frontend.keepAlive' must be a boolean` and marks the plugin `invalid`. It rides the row as **`frontendKeepAlive`** (a store-only row, whose manifest is `null`, reads `false`); `pluginFrames` (`web/src/features/views/plugins.ts`) reads it off the `GET /api/plugins/:id/status` it already makes before every first load.

- **Without it** the plugin loads into the one shared frame (`iframe[data-plugin-frame="shared"]`): leaving the view or switching to a keep-alive plugin removes the frame, and switching to another plain plugin replaces it with a fresh one; either way the page ends.
- **With it** the plugin gets its **own resident frame** (`iframe[data-plugin-frame="resident"][data-plugin-id=<id>]`), created on first show — an unvisited keep-alive plugin costs nothing. Every exit (hash leaving `#plugin/`, a Settings / session / other-view supersede, the switcher's Conductor entry, and on desktop opening a non-session view while a plugin is docked in split) only hides it with the section; a switch to another plugin hides it too. It is never moved in the DOM, which would reload it.
- **Re-entry** reveals the same page: no `POST /start`, no `src` change. At subpath `/` — what the switcher writes — or at the frame's own tracked route, the frame keeps its route, no `navigate` is posted, and the hash is `replaceState`d to `#plugin/<id><its route>` (in the desktop dock's split, the dock's saved subpath takes that route instead and the URL stays on the session); only a subpath that is neither is sent as a bridge `navigate`. A hidden frame's `route` messages update its tracked route but never the URL.
- **Eviction** (the frame is removed, ending its page — media tracks, sockets, timers) happens in two cases:
  - the row stops passing `keepsResident` in `web/src/features/views/plugins.ts`: disabled, keep-alive dropped, a state outside its allowlist (`stopped`, `invalid`, …), or the status route answering 404. Checked in the background on every re-entry (the reveal never waits on it) and by `reconcile()` after every Settings → Plugins action (`PluginView.tsx` on `pluginsChangedSignal`). Only a 404 evicts on a failed read: a network error, a 5xx, or a 200 whose body does not parse keeps the frame.
  - a Settings → Plugins action in this tab put new code under the plugin — one of `EVICTING_ACTIONS` in `web/src/features/views/plugins.ts`: **Restart**, **Update** (every plugin in the updated project) and a **version switch**. `web/src/features/settings/PluginsSection.tsx` reports the action as `notifyPluginsChanged({action, ids})` (`web/src/features/settings/pluginsSignal.ts`), which `web/src/features/views/PluginView.tsx` passes to `reconcile(change)` unchanged.

  After `reconcile()` evicts a frame, the plugin loads the plain way (auto-start, error overlay + Retry) at once only when the frame was on screen and the eviction is the second case: the view reloads in place at the subpath the frame was on. A frame evicted for its row (the first case) is not started again, even on screen; the next entry loads it. The re-entry check runs as the user enters, so it loads the plugin the plain way at once.
- **Kept:** a backend crash and the lazy restart the page's own proxied requests trigger leave the page up — it must cope with its backend coming back (compliance checklist).
- **Visible in the host UI:** the app switcher labels a plugin whose frame is resident `<navLabel> (running)` (`RESIDENT_SUFFIX` in `web/src/features/views/plugins.ts`, appended by `web/src/features/views/AppSwitcher.tsx`), from first show until eviction.
- **Measured** by `keepAliveFlow` in `web/e2e/plugin-host.shared.ts`, run on the desktop and phone projects by `web/e2e/plugin-host.spec.ts` and on the android project by `web/e2e/plugin-host.android.spec.ts` (Chromium with Playwright's default launch flags plus `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`; one visible top-level tab). With the plugin view hidden and taking no space, behind Settings and behind Conductor, a hidden keep-alive page's timers, WebSocket messages and microphone (track `live`, `AudioContext` `running` with its clock advancing, non-zero samples) are polled until they have moved on; each return shows the same page load; the switcher marks the plugin while resident; and a plugin without `keepAlive` reloads on the same round trip. Playwright's default flags include `--disable-background-timer-throttling`, `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`, so the measurement says nothing about Chrome's default throttling policy. Not measured: a backgrounded tab (the whole page hidden) and mobile Chrome.
- **Security.** The capability is not widened: a plugin frontend is a same-origin, unsandboxed iframe that can already script `window.parent`, and code it plants there already outlives the frame's removal. What is widened, for opted-in plugins only, is how long a page runs **openly** after the user leaves — including a **microphone left open with no plugin UI on screen**; the switcher label and the browser's own recording indicator are the cues. Accepted under the operator-installed, trusted-plugin stance.
- **Limitations.**
  - Nothing pushes plugin state to the browser, so a Stop / Disable / Rescan made from another tab or over REST reaches a hidden frame only at its next re-entry or the next Settings → Plugins action in this tab. A Restart, Update or version switch made anywhere but this tab's Settings → Plugins does not evict at all: its row reads like a lazy restart's.
  - Uninstalling (deleting the plugin's project) evicts only after the next Rescan, since the row does not change until then.
  - A cc server restart keeps the frames: plugin backends run detached, and the restart re-adopts a live, answering one as `ready` (`adoptRunning` in `src/plugins/registry.ts`). A child that cannot be adopted comes back `stopped`, which evicts its frame at the next check. A page reload — the self-update path included — drops every frame.
  - No count cap beyond the opt-in set: at most one frame per enabled keep-alive plugin shown in this tab. A leaking page is cleared by Stop, Disable or a reload.

**Convention `scope` (required, explicit).** Every `conventions` entry MUST carry a `scope` — there is no silent default. The accepted enum is **`"project"`** (routes into the project-Conventions catalog described above) and **`"conductor"`** (routes into the Conductor-Conventions catalog — see the ⚠️ note below). `"workspace"` is **planned** and recognised-but-rejected at manifest load with a specific error (`scope "workspace" not yet supported (only "project", "conductor" are currently accepted)`); any other value gets the standard invalid-enum error and marks the plugin `invalid`. Expansion is **additive with no migration**: move a scope from planned→supported in `SUPPORTED_CONVENTION_SCOPES` (`src/plugins/manifest.ts`) and wire that scope's group (from the scope-keyed object `pluginHost.conventions()` returns) into its catalog's provider (`workspaceConventions`/`conductorConventions` already exist, built on `fragmentCatalog.ts`). No stored data changes shape.

> ⚠️ **Conductor-scope conventions modify the orchestrator itself.** A `scope:"conductor"` convention injects a fragment into the conductor's **own** operating rules (the composed conductor role prompt) — i.e. a plugin can shape how the orchestrator delegates, reviews, and merges across **every** project, not just a single one. It joins the Conductor-Conventions catalog namespaced `<plugin-id>/<slug>` and is **on by default while the plugin is enabled** (minus any the user unchecks — a remembered off-switch), composed into the conductor's system prompt on the next spawn/context-refresh; disabling the plugin drops it. That is a deliberately powerful, trust-loaded capability — consistent with "plugins are trusted own code", but far beyond a per-project convention, so treat enabling a plugin that ships conductor-scope conventions as granting it orchestrator-wide reach.

**Scaffold delivery (conductor-directive, no persistence).** At project creation the picked conventions that carry a `scaffold` facet have their directive texts composed **in selection order** into one framed orchestrator-guidance block (`Project "<name>" was created with these setup steps…`) that `create_project` (MCP) / `POST /api/projects` (REST) **RETURN** under a `scaffold` field (empty/omitted when none). Nothing is persisted and nothing touches the spawn path. The conductor folds the returned `scaffold` into its **first** `send_prompt` to the project's first worker (see `create_project`'s description); the UI shows it read-only in the create confirmation. The scaffold facet has **no `scope` field** by design: it fires at *project creation*, so it is inherently project-scoped — workspaces and the conductor aren't "created", so there is no scaffold trigger for them. *(Future work: persist a lightweight pending-scaffold the conductor can pick up for UI-created projects.)*

Unknown top-level keys are rejected, and so are unknown keys in an `mcp.tools[]` entry. A tool `audience` outside `TOOL_AUDIENCES` (`src/mcp/toolAudience.ts`) makes the plugin `invalid`. Every `inputSchema` must stay inside the conductor's `validateArgs` subset — a **flat** `type:"object"` schema (per-property `type`/`enum`/`minLength`/`maxLength`/`pattern`/`minimum`/`maximum`/`items.type`; boolean `additionalProperties` accepted and ignored). `$ref`/`oneOf`/`anyOf`/`allOf`/`not` and nested object `properties` are rejected at manifest load, so an unvalidatable schema can never register. An optional `outputSchema` must stay inside the strict output subset (`checkSchema` in `src/mcp/jsonSchemaSubset.ts`) with a root `type: "object"` — see [Typed plugin tools](tools.md#typed-plugin-tools-both-formats); outside it, the manifest is invalid. Invalid ⇒ state `invalid`, listed with errors, never startable.

Child env:

- `$PORT` — conductor-allocated; default your own port when absent so the plugin stays standalone-runnable.
- `CONDUCTOR_PLUGIN_ID`.
- **stdout and stderr** are one append-mode file, `<PROJECTS_ROOT>/.code-conductor/plugins/logs/<id>/backend.log` (`backendLogPaths`, `src/plugins/backendLog.ts`), never a pipe: a backend that outlives the cc that started it keeps a valid stdout/stderr, and its output survives restarts. `readyWhen` is matched against this run's output in that file. Details: [runtime.md → Backend output and exit history](runtime.md#backend-output-and-exit-history).
- `CONDUCTOR_URL` — `http://127.0.0.1:<conductor-port>`.
- `CONDUCTOR_MCP_URL` — `$CONDUCTOR_URL/mcp`: cc's MCP server, anonymous, JSON by default — call any core tool by JSON-RPC or the REST alias (`POST $CONDUCTOR_MCP_URL/tools/<name>`); contract in [mcp-applications.md](../mcp-applications.md). Set together with `CONDUCTOR_URL`; never inherited from the conductor's own env.
- `PROJECTS_ROOT` — the conductor's *resolved* projects root, injected explicitly, so it carries the default even when the conductor's own env never set the var.
- `CONDUCTOR_PROJECT_DIR` — the conductor's own running checkout dir, holding its `server.ts`/`package.json`; may be outside `PROJECTS_ROOT`.
- `CONDUCTOR_PLUGIN_DATA_DIR` — the plugin's own data dir, `<PROJECTS_ROOT>/.code-conductor/plugins/data/<id>` (`pluginDataDir`, `src/plugins/store.ts`).
  - `<id>` is the manifest `id`, not the repo or project dir name.
  - The value is absolute, belongs to this plugin alone, and is the same at every start while the projects root and the `id` are unchanged; changing the `id` changes the dir.
  - cc never creates, reads, writes, moves or deletes it (not on stop, disable, update or uninstall), so it and its parent may not exist: create it with the mode you need, e.g. `fs.mkdir(dir, {recursive: true, mode: 0o700})`.
  - Moving any legacy data in is the plugin's job.
  - Library `postClone`/`postPull` hooks do not receive it (they are not backend starts).

No fixed-port option in v1.

**Discovery rules.** The manifest is read from each project's main checkout **through that project's System** (`readManifest(system, dir)`) — a manifest and its fragment files are files in a project tree, and a bare local read against a remote project's path does not no-op, it reads cc's OWN file at that path and registers a plugin that is not there. A project whose System cannot be reached contributes no plugin and is warned about, never silently read locally — and when the store holds an **enabled** plugin record for that project, the catalog is additionally flagged **degraded**, because the manifest was never read and cc therefore cannot vouch for the absence of that plugin's conventions. The flag is computed live against the store (never latched into a stored boolean), so it clears at the next **Rescan** — or the moment that plugin is disabled. When the main checkout has **no manifest file at all**, the project's worktrees (sorted by name) are checked and the first **valid** manifest wins — so a plugin whose manifest exists only in an unmerged worktree (first-time plugin-ification) can bootstrap. Rows carry `manifestSource: {type:"main"} | {type:"worktree", name}`; enabling a worktree-sourced plugin defaults `activeVersion` to that worktree. A present-but-invalid main manifest keeps its `invalid` state (never masked by a worktree), and `POST /api/plugins/:id/version {type:"main"}` is refused with 400 while the main checkout lacks a valid matching manifest.

**A project mutation reaches the contributions immediately; discovery still needs a Rescan.** `conventions()` and `claudePluginDirs()` resolve each contributing plugin's placement LIVE, per call (`resolvePlacement`, `src/plugins/registry.ts`), so changing a project's target (`setProjectRemote`), deleting it, or re-pointing its system's provider command changes what those two return on the very next call — no rescan. A cached fragment body is served only under the exact state it was read under — the placement, the provider generation, and the host's own invalidation epoch — so bytes from one machine can never be served for another. That is enforced by labelling each cached body individually rather than tracking one label for the cache: a scan reads over a duration, not at an instant, so a gesture landing mid-scan would otherwise leave that scan's own later reads unaccounted for. See [components/plugin-host.md](../components/plugin-host.md#srcplugins) → `contributions.ts` for the invariant and the two interleaves that ruled out the simpler shapes. What a mutation does NOT do is change the discovery catalog (`byId`): in a running server only `POST /api/plugins/rescan` and the Library's install/update rebuild it, so the plugin's ROW keeps its pre-mutation `state`/`system` until then, and a NEW plugin project (created, adopted, or one whose manifest first appears in a worktree) is undiscovered — and therefore un-enableable — until a Rescan.

Placement outcomes, at COMPOSE time (each entry's placement resolved live, per call):

| Situation | `conventions()` | Why |
|---|---|---|
| Target changed and the tree is not on the new target | slug absent, `degraded:false` | the far side ANSWERED by name — a refusal, not "I cannot tell" |
| Project unregistered (`deleteProject`, all three branches) | slug absent, `degraded:false` | cc's own store dir (`projectStoreDir(name)`) and the registering artefact are both gone — removed on every delete branch, and an `rm -rf` of a checkout removes neither |
| Checkout vanished while cc still holds store state for the project | slug absent, `degraded:true` | gone or unmounted — for an in-root project the directory IS the registration, so this genuinely cannot be told apart |
| System unreachable, or worktree metadata unreadable | slug absent, `degraded:true` | a box being briefly down must freeze a committed `CONVENTIONS.md`, not rewrite it without the fragment |
| `orchStoreRoot()` itself absent | `degraded:true` | the guard that stops a vanished store root reading as "every project is unregistered" |

And at DISCOVERY-SCAN time, for a project the scan itself could not resolve through its System (so it is absent from the catalog entirely, not merely unplaceable):

| Situation | `conventions()` | Why |
|---|---|---|
| Unreachable at the last discovery **scan**, and the store holds an **enabled** record for a plugin in that project | slug absent, `degraded:true` **until the next Rescan** | the manifest was never read, so cc cannot tell whether that plugin contributes conventions — it flags on the enabled record alone, deliberately over-flagging rather than risking a rewrite |
| Unreachable at the last discovery **scan**, with no enabled record for that project | `degraded:false` | a project the store holds no **enabled** record for contributes nothing to `conventions()` in the first place, so its ABSENCE FROM A SCAN cannot drop a line from a committed `CONVENTIONS.md`. (A *disabled* plugin's body may still be sitting in one — but the next regenerate removes it because it is disabled, which is by design, and not because a scan could not see it.) |

The scan-time policy is therefore a **strict superset** of the compose-time one, and deliberately so. Of the five filters the compose path applies before it degrades, four (`discoveryState`, the id, the manifest, a non-empty `conventions` list) come out of the manifest — the exact file the scan never got to read, because the project did not resolve through its System — leaving only "is there an enabled record" answerable at scan time. Over-flagging costs a freeze the next Rescan clears; under-flagging rewrites a committed file.
