# Plugin system: plugin MCP tools and compliance

## Plugin MCP forwarding — child wire contract (pinned)

The conductor POSTs `{tool, arguments, caller:{sessionId, project}, format}` (JSON) to the manifest `mcp.endpoint`; `format` is `"text"` or `"json"` — the format the MCP caller asked for (the REST alias always sends `"json"`; agents' own MCP config sends `"text"`). A plugin that ignores `format` keeps working in text. The child returns **HTTP 200 for EVERY well-formed tool invocation** with a success body (below) or `{error: "<message>", code?, details?}` — unknown tool, bad arguments and tool-level failures are all `200 + {error}`. A **non-200 means a transport-level failure only** (malformed envelope, plugin bug) and surfaces to the MCP client as an HTTP-coded error; `200 + {error}` surfaces as a tool error carrying `code` when one is sent, else `TOOL_ERROR`, plus its `details` object when one is sent (rules in [Typed plugin tools](#typed-plugin-tools-both-formats) → 6). A tool whose manifest declares no `outputSchema` is **text-only**: absent from JSON format and the REST alias. Calls are aborted at `mcp.timeoutMs`. Tool names are namespaced `<plugin-id>__<tool>`; argument validation against the declared `inputSchema` happens in the conductor **before** any forward. Visibility: see [Tool audience](#tool-audience); a disabled plugin's tools are absent, so calling one refuses as an unknown tool.

**Raw-text results (opt-in, additive).** On a tool with no `outputSchema`, a success body may return `{text, meta?}` **instead of** `{result}`; a typed tool's only text-format success shape is `{text, meta?}` (see [Typed plugin tools](#typed-plugin-tools-both-formats)). The rendering below is the same for both kinds of tool. `text` is one string **or** a list of strings; each becomes a **raw, UNESCAPED** `content[]` block (text format). With a non-null `meta`, a compact-JSON block holding `meta` comes first, then one raw block per `text` entry. With `meta` omitted or `null`, a **single string** `text` is the whole result: exactly one raw block, no metadata block (the shape of cc's own rendered read tools). A **list** with no `meta` still gets a leading `null` block — send `meta` with a list, or send one string. Use it for anything a human or LLM reads as prose — a wiki page, a diff, file contents — where `{result}`'s `JSON.stringify` would escape every newline. `{result}` remains correct for structured data; a body with no `text` key behaves exactly as before.

Two edges, both deliberate:

- **`text` wins over `result`.** Sending both is a contract violation; it degrades to the `text` path rather than throwing, and `result` is ignored.
- **`meta` without `text` is silently dropped.** With no `text` key the body falls through to the `result` path, which never reads `meta`. This is the design's only lossy case — `meta` is meaningful *only* alongside `text`. To emit metadata with no body, send `{meta, text: []}` (or `text: null`), which yields the meta block and zero text blocks.

`text: null` → zero text blocks. A non-string (`text: 42`) is stringified, not rejected — nothing on this path throws.

## Tool audience

Core tools carry the same field on their registry entry (`src/mcp/tools.ts`) and are decided by the same table below. A tool entry may declare `audience` (values and default owned by `TOOL_AUDIENCES` in `src/mcp/toolAudience.ts`; omitted ⇒ `all`). Which sessions are offered the tool follows from who is calling (`callerKindOf`, `src/mcp/server.ts`; the check is `audienceAdmits`):

| Caller | Kind | Offered |
|---|---|---|
| a `.conduct` session — a top-level conductor or a section lead | conductor | `all` and `conductor` tools |
| any other live session, conducted or hand-spawned | worker | `all` and `worker` tools |
| no `/mcp/<sessionId>` segment (plugin backends on `CONDUCTOR_MCP_URL`, REST-alias scripts, an externally attached client) | anonymous | every tool |

- **Hidden:** a tool outside the caller's audience is absent from `tools/list` (both formats), `GET /mcp/<sessionId>/tools` and `describe_tools`.
- **Refused:** calling it anyway is `TOOL_UNAVAILABLE_TO_CALLER` — JSON-RPC `-32602`, REST `403`, and in `run_code` a refusal of the whole program from the pre-check (a computed `cc.call` gets the `403` as a `ConductorError` at runtime). The child is never contacted.
- **Bridge race guard:** the handler re-reads the active checkout's manifest, so a plugin update that narrows a tool's audience between composition and forward refuses the call (a tool error, `isError:true` / REST `200`).
- A session's kind never changes during its life, so the CLI's spawn-time snapshot of `tools/list` stays correct.
- **Audience steers which tools a managed session is offered; it is not an access-control boundary — `/mcp` has no auth, and an anonymous caller, or anyone calling as a session's public id, can reach any tool. Enforce real authorization in the plugin backend (its request carries `caller.sessionId`).**
- The manifest's `mcp.scope` is still tolerated and read nowhere.

## Typed plugin tools (both formats)

**JSON visibility.** A tool is served in JSON format (`/mcp?format=json`, the REST alias, `run_code` scripts) **only if** its manifest entry declares an `outputSchema`. A tool without one is text-only: it is absent from the JSON `tools/list` and from `GET /mcp/tools`, and a JSON call to it is refused `TOOL_UNAVAILABLE_IN_FORMAT` (JSON-RPC error `-32602`, REST `404`) **without contacting the child**. A tool whose manifest stops declaring its `outputSchema` between the tool set's composition and the forward is refused by the bridge instead, as a tool error with the same code (JSON-RPC `result` with `isError:true`, REST `200` + the refusal object); the tool is never forwarded. Text format lists and calls every tool.

1. **The request.** Every forward carries `format: "text" | "json"`. Build only the view asked for.
2. **Reply shapes — exactly one per format, no combined bodies.**

   | Request `format` | Tool | Success body | Becomes |
   |---|---|---|---|
   | `json` | typed | `{structured: {…}}` and no other key | `structuredContent` (+ one text block of its JSON); the REST body is the object itself |
   | `text` | typed | `{text, meta?}` and no other key | raw text blocks, as in [Raw-text results](#plugin-mcp-forwarding--child-wire-contract-pinned) |
   | `text` | untyped | `{result}` or `{text, meta?}` (legacy; `text` wins) | as above |

   A `structured` whose object has `ok: false` (and passes its schema) reads as a refusal, as for core tools — so, like any refusal, its echoed strings take `JSON_ECHO_CAP`; prefer an error refusal (rule 6).
3. **Schema rules.** `outputSchema` uses only the vocabulary `checkSchema` (`src/mcp/jsonSchemaSubset.ts`) accepts: `type` (a string or a union list), `properties`, `required`, `additionalProperties` (boolean or schema), `items`, `enum`, `const`, `anyOf`, `description`. The root is `type: "object"` (one string). **Every** object schema, nested ones included, states `additionalProperties`. Anything else — `$ref`, `oneOf`, `allOf`, `not`, `pattern`, `minimum`, `format`, … — makes the manifest invalid at load.
4. **Runtime validation.** cc validates every `structured` against the declared schema before answering (it advertises that schema in the JSON `tools/list` and in `GET /mcp/tools`). These replies are refused `PLUGIN_REPLY_INVALID` (a tool error carrying `statusCode: 500`, logged by cc; the reason names the plugin and tool):
   - json: any key besides `structured` (`result`, `text`, `meta`, …); a `structured` that is not a JSON object; a `structured` that fails the schema (the reason quotes the first validation errors with their `$.path`);
   - text, typed tool: no `text`, or any key besides `text`/`meta`;
   - text, untyped tool: any body carrying `structured`;
   - any format: an `{error}` whose `code` is present but malformed;
   - any format: an `{error}` whose `details` is present but not a JSON object (an array, string, number, boolean or `null`).
5. **Never truncate in json.** `{structured}` carries the complete result: no caps, no elision, no `…truncated` markers, no default limit that trims data. Size bounding — row caps, body caps, tail limits, summarising — belongs to the `{text}` view only. Explicit caller arguments (`limit`, `offset`, …) are honoured in json too, because that is the caller's choice; an omitted `limit` means everything. cc applies no ceiling of its own to a `structured` reply ([docs/mcp-applications.md](../mcp-applications.md) → JSON-format ceilings).
6. **Errors.** `{error: "<message>", code?: "<CODE>", details?: {…}}` in either format, from typed and untyped tools alike. Any other key is dropped.
   - `code` must match `^[A-Z][A-Z0-9_]*$` (`PLUGIN_ERROR_CODE_RE`, `src/plugins/mcpBridge.ts`); reusing cc's own codes (`NOT_FOUND`, `CONFLICT`, …) is allowed. With no `code`, the error is `TOOL_ERROR`.
   - `details` is an optional free-form JSON object for the refusal's machine-readable extras — e.g. `retry_after_ms`, `available_actions`, a session id. A non-object `details` is `PLUGIN_REPLY_INVALID` (rule 4).
   - JSON callers (JSON-RPC `structuredContent`, the REST body) get `{ok:false, code, reason, details?}`. `details` is passed through untouched and never cut; `reason` still takes `JSON_ECHO_CAP`, and `truncated:true` speaks for `reason` only.
   - Text callers get the prose line, then the error block `{error, code?, details?}`. That block is still bounded by the text response budget (`MCP_RESULT_CHAR_BUDGET`), which can cut strings inside `details`.
   - With no `details`, every channel's output is unchanged.
7. **One description.** A tool has one format-neutral `description`: describe the data, not its rendering.
8. **Example.** Manifest tool:

   ```json
   { "name": "list_items", "description": "The items on the board, optionally only those in one column.",
     "inputSchema": { "type": "object", "properties": { "column": { "type": "string" } } },
     "outputSchema": { "type": "object", "additionalProperties": false, "required": ["items"],
       "properties": { "items": { "type": "array", "items": { "type": "object", "additionalProperties": false,
         "required": ["id", "title"], "properties": { "id": { "type": "string" }, "title": { "type": "string" } } } } } } }
   ```

   Child handler (Node):

   ```js
   app.post('/api/mcp', express.json(), (req, res) => {
     const { tool, arguments: args, format } = req.body;
     if (tool !== 'list_items') return res.json({ error: `unknown tool ${tool}`, code: 'TOOL_UNKNOWN' });
     const column = args.column;
     if (column && !board.has(column)) return res.json({ error: `no column '${column}'`, code: 'NOT_FOUND' });
     if (board.busy()) return res.json({ error: 'the board is reindexing', code: 'BUSY', details: { retry_after_ms: 1500 } });
     const items = board.items(column); // the complete list — never capped for json
     if (format === 'json') return res.json({ structured: { items } });
     return res.json({ text: items.map(i => `${i.id}  ${i.title}`).join('\n') });
   });
   ```

   A JSON call answers `structuredContent: {items:[{id, title}, …]}` plus one text block holding that JSON; a text call answers one raw block of lines.

## Plugin-compliance checklist

1. `conductor.plugin.json` at the repo root (schema above); keep `id` stable.
2. Respect `$PORT` when set; default your own port so the app stays standalone-runnable.
3. Base-path compliance: reachable under `X-Forwarded-Prefix` — relative asset URLs (or honor the prefix), root-relative redirects only (they get rewritten); host URLs in the `../../` form (a root-absolute `/pluginBridge.js` is rewritten only under a base path).
4. `<script src="../../pluginBridge.js"></script>` (blocking, first in `<head>`) and `<link rel="stylesheet" href="../../pluginTheme.css">` in the frontend (base-safe forms; [docs/plugin-ui.md](../plugin-ui.md) → Host URLs), and routing that survives the bridge's history contract: `pushState` is demoted to `replaceState`, and a hash change adds a joint history entry (the bridge reports routes for you; [docs/plugin-ui.md](../plugin-ui.md) → Routing).
5. A `healthPath` endpoint (any HTTP response counts as alive).
6. Optional MCP endpoint following the 200-always contract above, tools declared in the manifest with flat input schemas; declare `audience` on a tool only one side (conductor or worker) should be offered. Read the request's `format`. A tool that should exist in JSON format (scripts, the REST alias) declares an `outputSchema` and answers `{structured}` in json and `{text, meta?}` in text — see [Typed plugin tools](#typed-plugin-tools-both-formats). An untyped tool is text-only: return `{result}` for structured data or `{text, meta?}` for prose/diff/file content that should reach the caller un-escaped (omit `meta` and send one string to get exactly one block; `text` wins if both are sent; `meta` alone, without `text`, is dropped). Failures are `{error, code?, details?}` ([Typed plugin tools](#typed-plugin-tools-both-formats) → 6).
7. Expect to be killed at any time (Doze) and restarted lazily — persist state under `$CONDUCTOR_PLUGIN_DATA_DIR` (see Child env above), never in the projects root; start fast.
8. A `frontend.keepAlive` page stays up while its backend crashes and is lazily restarted under it — reconnect rather than assume the backend it loaded against. (An explicit Restart, Update or version switch from Settings → Plugins evicts the page; the next entry loads it afresh.)
9. If a convention's fragment depends on something its `scaffold` facet sets up, **word the fragment to degrade gracefully** when the scaffold step wasn't run — the picked convention may land in a project where the setup directive was never carried out (e.g. "if a project-local harness wrapper exists, use it to visually verify UX changes; otherwise see the shared harness to create one").
10. A UI follows the host contract in [docs/plugin-ui.md](../plugin-ui.md): relative URLs, cc's theme followed live, cc's session width followed through `--cc-session-width` if the page caps its width, servable after the Library entry's `postClone`/`postPull` hook has run. Stack, build tool and tests are the plugin's own.
11. A `runCode` module has its dependencies installed in the **active** checkout (a worktree with no `node_modules` resolves from ancestor directories), and hands large or binary output back as a **file path**: have the backend write the bytes under `$CONDUCTOR_PLUGIN_DATA_DIR` and return the path, since a plan-mode child cannot write files.
12. A member that returns interactive objects ships a skill for them and names it in the member's `description`; `outputSchema` is documentation only and is never checked against what the member returns.
