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
- **Refusals** are `result.isError:true`, and their `structuredContent` matches `REFUSAL_SCHEMA` (`src/mcp/outputSchemas.ts`): `{ok:false, code, reason?, statusCode?, truncated?, …}`, plus the refusal's own fields (`sessionId`, `matches`, `legalMoves`, …). An `outputSchema` describes the **success** shape only.
- **Plugin tools** are untyped. A bridged plugin tool's result passes through as its own `content` blocks in both formats, with no `structuredContent`.

## Error channels

| `code` | Source | JSON-RPC (JSON format) | REST alias |
|---|---|---|---|
| a handler's or the gate's own code (`SESSION_UNKNOWN`, `SESSION_AMBIGUOUS`, `PLAYBOOK_UNKNOWN`, …) | soft refusal | `result`, `isError:true` | `200` + the refusal object |
| `REFUSED` | a handler refusal carrying no code: `sync_worktree` when the system refuses, the ahead/behind comparison fails, `git status` fails, or `merge --ff-only` fails | `result`, `isError:true` | `200` |
| a thrown error's `code`, else `codeForStatus` of its `statusCode` (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`), plus `statusCode` | thrown handler error | `result`, `isError:true` | `200` |
| `TOOL_ERROR` | thrown with neither a code nor a status (e.g. `describe_session` with an empty `sessionId`) | `result`, `isError:true` | `200` |
| `TOOL_UNKNOWN` | no such tool, including one the host platform's capabilities omit | error `-32602` | `404` |
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
- Every echoed string in a JSON refusal is cut at `JSON_ECHO_CAP`, and the refusal then carries `truncated:true`.

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
- **A bridged plugin tool:** `200` + its MCP result `{content, isError?}` unchanged.
- **Content type:** `content-type: application/json` is required, empty body included, and is checked before anything else.
- **No Origin or Host check.** `/mcp` has none either. The only cross-site barrier is that a browser's "simple" POST cannot send `application/json`, and the alias refuses anything else with `415` rather than ignoring the body.

**Listing:** `[{name, description, inputSchema, outputSchema}]`. The core tools come from the JSON registry (`buildTools('json')`, capability-filtered); the caller's plugin tools follow with `outputSchema: null`.

## Env vars

| Var | Set for | Value |
|---|---|---|
| `CONDUCTOR_MCP_URL` | a **local** worker (`Instance.spawn`) | `http://127.0.0.1:<port>/mcp/<its sessionId>`: the worker's own session, JSON by default |
| `CONDUCTOR_MCP_URL` | a plugin backend (`src/plugins/registry.ts`, beside `CONDUCTOR_URL`) | `<CONDUCTOR_URL>/mcp`: anonymous |

- A worker's var is **absent** under `ORCH_DISABLE_MCP_AUTOREGISTER=1`; a plugin's is set whenever cc has a port, that setting notwithstanding.
- **Absent** for a worker on a remote System: its Bash runs on the remote without cc's env, and cc's loopback URL does not reach cc from there.
- An inherited value (cc itself running as some cc's worker) is removed, never passed on: by `Instance.spawn` for workers and by the supervisor's `spawnChild` for plugins.

## JSON-format ceilings

JSON drops every context cap: the result budget and its `RESULT_OVER_BUDGET` backstop, the dirty, history, message, tool-argument, side-list and human-prompt caps, and the transcript page fit. The table of what applies per format is `TEXT_LIMITS` / `JSON_LIMITS` in `src/mcp/limits.ts`. These safety ceilings remain, and each is flagged when it cuts:

| Ceiling | Bounds | Flag |
|---|---|---|
| `JSON_READ_BODY_CAP` | `project_read`'s `maxBytes` (its schema maximum and default in JSON format) | `truncated`, `lineTruncated`; continue with `offset`/`limit` from `endLine` |
| `JSON_BASH_OUTPUT_CAP` | retained `project_bash` / `system_bash` output | `truncated`; not pageable |
| `JSON_DIFF_PAGE_BYTES` | one `project_diff` page | `truncated` + `nextOffset` (page on), `lineTruncated` |
| `JSON_ECHO_CAP` | each echoed string in a refusal, and a JSON-RPC error's `message` | `truncated` (refusals) |
| `URL_ECHO_CAP` (`src/mcp/server.ts`, both formats) | each URL fragment a URL-level fault echoes (a query key, a format value, a caller id, a route) | — |

Unchanged in both formats:
- the request body limit `MCP_REQUEST_BODY_LIMIT` (`src/mcp/server.ts`; over it → `PAYLOAD_TOO_LARGE`)
- `GIT_OUTPUT_LIMIT_BYTES` and `HOOK_OUTPUT_CAP` (`src/worktrees.ts`)
- `MAX_FILE_BYTES` (`src/systems/protocol.ts`)
- the bash timeouts (`clampBashTimeoutMs`)
- `get_transcript`'s `limit` and `get_recent_messages`' `count` (paging)
- `DISK_REPLAY_TAIL_CAP` (`src/mcp/messageReconstruction.ts`), which bounds how far back a disk read scans, not what it returns

## Limitations

- **Plugin tools are untyped.** They pass through, and the alias returns their MCP envelope.
- **A remote worker gets no `CONDUCTOR_MCP_URL`.**
- **No auth.** Any local process can call as any live session.
- **No streaming.** Every result is buffered whole; a JSON result can reach the ceilings above.

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

Python, standard library only. It reads `CONDUCTOR_MCP_URL` when cc set it, so the same script works in a worker, where it is the worker's own session URL, or in a plugin:

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
