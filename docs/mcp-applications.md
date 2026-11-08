# `/mcp` for applications

cc's MCP server is an application API as well as an agent toolbelt. A script, a plugin backend or a worker's own tooling calls the same tools a conductor does and gets **structured JSON** back. The tool catalog is in [features.md → MCP interface](features.md#mcp-interface); the agent-facing wire details (prefix resolution, the result budget, the rendered read results, playbooks) are in [protocol.md → MCP tool protocol](protocol.md#mcp-tool-protocol).

Router: `buildMcpRouter` in `src/mcp/server.ts`, mounted at `/mcp` by `server.ts`.

## URL contract

**Identity is the path, presentation is the query.**

| URL | Caller |
|---|---|
| `/mcp` | anonymous |
| `/mcp/<sessionId>` | the session `<sessionId>` |

- `<sessionId>` must be the **exact public sessionId of a live session** (`InstanceManager.liveCallerForPublicId`). The public id is pinned for a session's life, so it keeps resolving across a `/clear`, a `renew_session`, a `prune_session` and a cc restart that resumes the session.
- Anything else is refused `CALLER_UNKNOWN` **before dispatch** and never served anonymously. That includes an unknown id, a prefix, a backing/segment id (a rotated-away CLI session id), an instanceId, and a killed or retired session.
- Being the caller matters to the caller-dependent tools (`set_session_title`, `set_idle_timeout`, `renew_session`), to ownership (a `spawn_instance` or a dispatch from `/mcp/<sid>` makes `<sid>` the owner and wakes it), to playbook policy (a conductor caller is governed), and to plugin tools (the caller is forwarded).
- The only query parameter is `format`:

| `?format=` | Result |
|---|---|
| absent, `json` | JSON format (below) |
| `text` | the agent view: renderings and payload blocks fitted to one Claude Code MCP result; no `structuredContent` and no `outputSchema` |
| anything else | `FORMAT_INVALID` |

- Any other parameter, `?caller=` included, is refused `QUERY_PARAM_UNKNOWN`. `Accept` and `Content-Type` never choose the format.
- A URL-level fault (caller, format, query) refuses the **whole** request with one JSON-RPC error object at HTTP 200, `initialize` and `tools/list` included. Its `id` is the single request's id, or `null` for a batch or a notification.
- **No `initialize` is needed.** `tools/call` works on its own (the server is stateless).
- A worker's own `--mcp-config` names `/mcp/<its sessionId>?format=text` (`Instance.spawn`).

## Formats

Each core tool's **description** states its purpose once; the text format's result clause describes the text view (renderings, content blocks, context caps) and the JSON format's leaves the shape to the tool's **`outputSchema`**, which is the contract; a few parameter descriptions carry the same kind of per-format clause (`fmt` in `coreTools`, `src/mcp/tools.ts`).

How JSON format differs from text:
- `tools/list` adds an `outputSchema` per core tool (`OUTPUT_SCHEMAS`, `src/mcp/outputSchemas.ts`).
- `tools/list` descriptions carry the JSON result clause (no text layout, no context caps).
- `project_read`'s `maxBytes` input schema has a larger maximum and default (`JSON_READ_BODY_CAP`; the registries are `buildTools('text')` / `buildTools('json')`).
- `tools/call` returns `structuredContent`.
- The context caps do not apply; only the safety ceilings below do.
- Faults are JSON-RPC errors (`data:{ok:false, code, reason}`), not `isError` results.
- A JSON-RPC error's `message` is cut at `JSON_ECHO_CAP`, not the text format's echo cap.

## Result shape (JSON format)

- **Success:** `result.structuredContent` is the tool's object, valid against its `outputSchema`, and `result.content` is exactly one text block holding `JSON.stringify(structuredContent)`.
- **Bodies ride inside the object:**
  - `project_read`: `{…meta, body}`
  - `project_diff` diff mode: `{…meta, body}`
  - `project_bash` / `system_bash`: `{…meta, output}`
  - `get_recent_messages`: each `messages[i]` carries its body as `text`. There is no `--- message i/n ---` boundary line; the entry's `index`, `msgId` and `textChars` already say what it said.
- **The text-rendered tools** answer with their data. Each wraps it in a named key:

| Tool | Key |
|---|---|
| `list_projects` | `{projects}` |
| `list_sessions` | `{groups}` |
| `list_worktrees` | `{worktrees}` |
| `enumerate_remotes` | `{remotes}` |
| `list_workspaces` | `{workspaces}` (the text view stays a bare array) |

`describe_session`, `project_status` and `describe_playbook` answer with their object as it is.
- **Refusals** are `result.isError:true`, and their `structuredContent` matches `REFUSAL_SCHEMA` (`src/mcp/outputSchemas.ts`): `{ok:false, code, reason?, statusCode?, truncated?, details?, …}`, plus the refusal's own fields (`sessionId`, `matches`, `legalMoves`, …). `details` is a plugin refusal's own machine-readable object, passed through untouched ([docs/plugins.md](plugins.md#typed-plugin-tools-both-formats) → 6); no core refusal carries it. An `outputSchema` describes the **success** shape only.
- **Plugin tools** appear in JSON format only when their manifest declares an `outputSchema`, and then answer `structuredContent` like a core tool, validated by cc against that schema ([docs/plugins.md](plugins.md#typed-plugin-tools-both-formats)). A plugin tool with no `outputSchema` is text-only: absent from the JSON `tools/list`, and a JSON call to it is refused `TOOL_UNAVAILABLE_IN_FORMAT`.

## Error channels

| `code` | Source | JSON-RPC (JSON format) | REST alias |
|---|---|---|---|
| a handler's or the gate's own code (`SESSION_UNKNOWN`, `SESSION_AMBIGUOUS`, `PLAYBOOK_UNKNOWN`, …) | soft refusal | `result`, `isError:true` | `200` + the refusal object |
| `REFUSED` | a handler refusal carrying no code: `sync_worktree` when the system refuses, the ahead/behind comparison fails, `git status` fails, or `merge --ff-only` fails | `result`, `isError:true` | `200` |
| a thrown error's `code`, else `codeForStatus` of its `statusCode` (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`), plus `statusCode` | thrown handler error; a plugin tool's `{error, code, details}` carries the plugin's own `code` (no `statusCode`) and its `details` object | `result`, `isError:true` | `200` |
| `PLUGIN_REPLY_INVALID`, `statusCode:500` | a plugin child's reply breaks its format's shape: a json reply that is not `{structured}` alone, valid against the `outputSchema`; a text reply carrying `structured` (or, for a typed tool, anything but `{text, meta?}`); a malformed error `code`; a non-object error `details` | `result`, `isError:true` | `200` |
| `TOOL_ERROR` | thrown with neither a code nor a status (e.g. `describe_session` with an empty `sessionId`) | `result`, `isError:true` | `200` |
| `TOOL_UNKNOWN` | no such tool, including one the host platform's capabilities omit | error `-32602` | `404` |
| `TOOL_UNAVAILABLE_IN_FORMAT` | a plugin tool with no `outputSchema`, called in JSON format; the child is not contacted | error `-32602` | `404` |
| `TOOL_UNAVAILABLE_IN_FORMAT` | the bridge's race guard: the active manifest stops declaring its `outputSchema` between the tool set's composition and the forward; the tool is never forwarded | `result`, `isError:true` | `200` |
| `ARGS_INVALID` | `validateArgs` refused the arguments; on the alias also a body that is not a JSON object | error `-32602` | `400` |
| `CALLER_UNKNOWN` | the `/mcp/<sessionId>` segment | error `-32001` | `404` |
| `FORMAT_INVALID` | `?format=` | error `-32600` | `400` (the alias serves JSON only, so `text` is refused too) |
| `QUERY_PARAM_UNKNOWN` | any query parameter but `format` | error `-32600` | `400` |
| `PARSE_ERROR` | the body is not valid JSON | error `-32700`, HTTP `400` | `400` |
| `REQUEST_INVALID` | not a JSON-RPC 2.0 request | error `-32600` | — |
| `METHOD_UNKNOWN` | unknown JSON-RPC method | error `-32601` | — |
| `INTERNAL` | a cc fault outside any tool's own answer: a step before the handler threw (session-ref resolution, the playbook gate), a core tool returned a non-object, or any other failure in a route | error `-32603` (HTTP 200 inside dispatch, 500 from the router's error middleware) | `500` |
| `PAYLOAD_TOO_LARGE` | the body is over `MCP_REQUEST_BODY_LIMIT` | error `-32600`, HTTP `413` | `413` |
| `REQUEST_INVALID` (body) | a body `express.json` cannot read (charset, encoding, length) | error `-32600`, HTTP `400`/`415` (body-parser's own status) | `400`/`415` |
| `CONTENT_TYPE_UNSUPPORTED` | POST without `content-type: application/json` | — | `415` |
| `ROUTE_UNKNOWN` | any other `/mcp` path | HTTP `404` | HTTP `404` |

- JSON-RPC errors carry `data:{ok:false, code, reason}`.
- Every `runTool` failure is an outcome, never an escaped rejection, and every async route forwards a stray rejection to the router's error middleware (`buildMcpRouter`), so no `/mcp` request can take the server down or reach Express's HTML error page.
- URL-level faults (`CALLER_UNKNOWN`, `FORMAT_INVALID`, `QUERY_PARAM_UNKNOWN`) carry `data` in both formats.
- In text format the `-32600`, `-32601` and `-32603` replies `dispatch` emits (and the router error middleware's `-32603`) carry no `data`. The body-parser faults (`PARSE_ERROR`, `PAYLOAD_TOO_LARGE`, body `REQUEST_INVALID`) carry `data` in both formats, as the URL-level faults do: the body is refused before any format applies.
- In text format a tool fault is an `isError` result whose text is the reason, and a refusal or error is the text view described in protocol.md.
- Every echoed string in a JSON refusal is cut at `JSON_ECHO_CAP`, and the refusal then carries `truncated:true` — except a plugin refusal's `details`, which is never cut.

## REST alias

| Route | Meaning |
|---|---|
| `POST /mcp/tools/<name>` | call `<name>` anonymously; the JSON body is its arguments |
| `POST /mcp/<sessionId>/tools/<name>` | the same call, as `<sessionId>` |
| `GET /mcp/tools`, `GET /mcp/<sessionId>/tools` | the listing |

- Same core as `tools/call` (`runTool`): one argument validation, one playbook gate, one handler. The alias body for a call is byte-for-byte the `structuredContent` of the same `tools/call`, with the same caller attribution.
- **Success:** `200` + the `structuredContent` object itself, with no envelope.
- **Refusal or thrown error:** `200` + the refusal object.
- **Faults:** the statuses in the table above.
- **A bridged plugin tool:** a typed one (manifest `outputSchema`) answers like a core tool: `200` + its object; a tool-level failure is `200` + the refusal object, with the plugin's own `code` or `TOOL_ERROR`. An untyped one is `404` `TOOL_UNAVAILABLE_IN_FORMAT`; one whose manifest stops declaring its `outputSchema` between the tool set's composition and the forward is `200` + the refusal object with that code (the bridge's race guard).
- **Content type:** `content-type: application/json` is required, empty body included, and is checked before anything else.
- **No Origin or Host check.** `/mcp` has none either. The only cross-site barrier is that a browser's "simple" POST cannot send `application/json`, and the alias refuses anything else with `415` rather than ignoring the body.

**Listing:** `[{name, description, inputSchema, outputSchema}]`. The core tools come from the JSON registry (`capableTools('json', capabilities)` in `src/mcp/tools.ts`); the caller's typed plugin tools follow with their own `outputSchema`. Every listed tool has one; an untyped plugin tool is not listed.

## Chaining calls

An agent chains or batches calls with the `run_code` tool: one JavaScript program, one `cc` object, one digest back ([code-mode.md](code-mode.md)). An application makes its calls over this API directly: the JSON-RPC and REST forms above.

## Env vars

| Var | Set for | Value |
|---|---|---|
| `CONDUCTOR_MCP_URL` | a plugin backend (`src/plugins/registry.ts`, beside `CONDUCTOR_URL`) | `<CONDUCTOR_URL>/mcp`: anonymous |

- A plugin's value is set whenever cc has a port.
- A worker has no `CONDUCTOR_MCP_URL`: its programs call through `run_code`. An inherited value (cc itself running as some cc's worker) is removed, never passed on: by `Instance.launch` for workers and by the supervisor's `spawnChild` for plugins.

## JSON-format ceilings

JSON drops every context cap: the result budget and its `RESULT_OVER_BUDGET` backstop, the dirty, history, message, tool-argument, side-list and human-prompt caps, and the transcript page fit. The table of what applies per format is `TEXT_LIMITS` / `JSON_LIMITS` in `src/mcp/limits.ts`. These safety ceilings remain, and each is flagged when it cuts:

| Ceiling | Bounds | Flag |
|---|---|---|
| `JSON_READ_BODY_CAP` | `project_read`'s `maxBytes` (its schema maximum and default in JSON format) | `truncated`, `lineTruncated`; continue with `offset`/`limit` from `endLine` |
| `JSON_BASH_OUTPUT_CAP` | retained `project_bash` / `system_bash` output | `truncated`; not pageable |
| `JSON_DIFF_PAGE_BYTES` | one `project_diff` page | `truncated` + `nextOffset` (page on), `lineTruncated` |
| `JSON_ECHO_CAP` | each echoed string in a refusal, and a JSON-RPC error's `message` | `truncated` (refusals) |
| `URL_ECHO_CAP` (`src/mcp/server.ts`, both formats) | each URL fragment a URL-level fault echoes (a query key, a format value, a caller id, a route) | — |

**Plugin tools:** cc applies **no** ceiling to a typed plugin tool's `structured` reply — none of the safety ceilings above apply to it. The only bounds are the plugin's own `mcp.timeoutMs` and the V8 string-length ceiling, past which serializing fails loudly as `INTERNAL`, never as a cut. A plugin refusal's `reason` still takes `JSON_ECHO_CAP`; its `details` takes no ceiling. The plugin's side of this — never truncating in json — is in [docs/plugins.md](plugins.md#typed-plugin-tools-both-formats).

Unchanged in both formats:
- the request body limit `MCP_REQUEST_BODY_LIMIT` (`src/mcp/server.ts`; over it → `PAYLOAD_TOO_LARGE`)
- `GIT_OUTPUT_LIMIT_BYTES` and `HOOK_OUTPUT_CAP` (`src/worktrees.ts`)
- `MAX_FILE_BYTES` (`src/systems/protocol.ts`)
- the bash timeouts (`clampBashTimeoutMs`)
- `get_transcript`'s `limit` and `get_recent_messages`' `count` (paging)
- `DISK_REPLAY_TAIL_CAP` (`src/mcp/messageReconstruction.ts`), which bounds how far back a disk read scans, not what it returns

## Limitations

- **Untyped plugin tools are text-only.** A plugin tool without a manifest `outputSchema` is absent from JSON format and the REST alias.
- **No auth.** Any local process can call as any live session.
- **No streaming, except progress.** Every result is buffered whole and a JSON result can reach the ceilings above; the one exception is a single `tools/call` whose client accepts `text/event-stream`, which may stream progress notifications before its response ([code-mode.md → Progress and cancellation](code-mode.md#progress-and-cancellation)).

## Samples

These are replayed verbatim against a live server by `tests/mcp-applications-doc-samples.test.mjs` (in order, on a fresh store), so they are the server's real bytes.

JSON-RPC, anonymous, no `initialize`:

<!-- doc-sample: rpc-request -->
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_workspace","arguments":{"name":"demo"}}}
```

POSTed to `http://127.0.0.1:8787/mcp`, the reply:

<!-- doc-sample: rpc-response -->
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"added\":true,\"name\":\"demo\"}"}],"structuredContent":{"added":true,"name":"demo"}}}
```

The REST alias:

<!-- doc-sample: curl -->
```sh
curl -s -X POST http://127.0.0.1:8787/mcp/tools/list_workspaces -H 'content-type: application/json' -d '{}'
```

<!-- doc-sample: curl-response -->
```json
{"workspaces":[{"name":"demo","projectCount":0}]}
```

Python, standard library only. A plugin backend reads `CONDUCTOR_MCP_URL`, which cc sets for it:

<!-- doc-sample: python -->
```python
import json, os, urllib.request

url = os.environ.get('CONDUCTOR_MCP_URL', 'http://127.0.0.1:8787/mcp')
req = urllib.request.Request(url + '/tools/list_workspaces', data=b'{}',
                             headers={'content-type': 'application/json'})
with urllib.request.urlopen(req) as res:
    print(json.dumps(json.load(res), separators=(',', ':')))
```

<!-- doc-sample: python-output -->
```text
{"workspaces":[{"name":"demo","projectCount":0}]}
```
