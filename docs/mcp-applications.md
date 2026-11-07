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

**Listing:** `[{name, description, inputSchema, outputSchema}]`. The core tools come from the JSON registry (`capableTools('json', capabilities)` in `src/mcp/tools.ts`); the caller's plugin tools follow with `outputSchema: null`.

## Client libraries

cc generates a typed, zero-dependency client per language from its own tool registry. A script imports it from the directory cc names; there is no download or install step.

| | |
|---|---|
| Location | `$CONDUCTOR_MCP_CLIENT_DIR` = `<store>/mcp-client/` (`mcpClientDir()` in `src/projects.ts`) |
| Files | `conductor_client.py`, `conductor_client.mjs` (`MCP_CLIENT_FILES`, `src/mcp/client/files.ts`) |
| Written | at every boot, before the server listens (`writeMcpClientFiles`, called from `startHolding` in `server.ts`), temp file + rename; a failed write fails boot |
| Source | the running server's capability-filtered JSON registry (`capableTools('json', platform.capabilities)`): the tools a host does not serve have no method. Same registry → same bytes |
| Editing | don't: the files are overwritten at the next boot |
| Python | 3.11+ (`NotRequired`); stdlib `urllib` only. Importing on an older Python raises `ImportError` |
| Node | 18+ (global `fetch`); no dependencies. Importing where `fetch` is missing throws |
| Generator | `src/mcp/client/`: `typeModel.ts` (schema → types), `python.ts`, `node.ts`, `files.ts` |

**Import.**
- Python: `sys.path.insert(0, os.environ['CONDUCTOR_MCP_CLIENT_DIR'])`, then `from conductor_client import ConductorClient, ConductorError`.
- Node: `await import(pathToFileURL(path.join(process.env.CONDUCTOR_MCP_CLIENT_DIR, 'conductor_client.mjs')).href)`. The bare `` import(`${dir}/conductor_client.mjs`) `` works on POSIX only: on Windows a `C:\…` path is not an importable URL.

**API.**

| Member | Python | Node |
|---|---|---|
| constructor | `ConductorClient(url=None)` | `new ConductorClient(url?)` |
| URL | `url`, else `$CONDUCTOR_MCP_URL`, else `DEFAULT_URL` (`http://127.0.0.1:8787/mcp`, a constant — pass `url` for cc on another port); a trailing `/` is stripped. Calls are attributed to the session that URL names (anonymous for `/mcp`) | same |
| any tool | `call(name, args=None)` → the parsed body | `call(name, args = {})` → `Promise` of the parsed body |
| one method per core tool | `client.<tool>(*, <arg>=…)`: keyword-only, in schema property order | `client.<tool>({<arg>: …})`: one object; `args` may be omitted when nothing is required |
| argument names | the wire names verbatim (`sessionId=`); a Python keyword gets a `_` suffix (`system_transfer(from_=…, to=…)`) | the wire names verbatim |
| omitted vs `None`/`null` | an omitted argument is not sent; `None` is sent as `null` (`set_project_workspace(project=…, workspace=None)` clears) | an absent key is not sent; `null` is sent |
| return value | the tool's `structuredContent` (the REST alias body) | same |

Every method's docstring/JSDoc is the tool's description plus one line per argument (its description and `default`).

**Types.** Each method returns `<Tool>Result` (`Pascal(tool) + 'Result'`, e.g. `SyncWorktreeResult`), generated from the tool's `outputSchema`. Python types are `TypedDict`s (functional form, so a key like `from` works) with `NotRequired` for an optional key; Node types are JSDoc `@typedef`s with `[key]` for an optional key, checked by TypeScript's `checkJs`.

| Nested type | Name |
|---|---|
| property `key` of `Parent` | `Parent` + `Pascal(key)` |
| array item | `… + 'Item'` |
| map value | `… + 'Value'` |
| `anyOf` branch *i* (1-based) | `… + 'Variant' + i`; a union result is an alias, e.g. `SyncWorktreeResult = SyncWorktreeResultVariant1 \| …` |

`Pascal` splits on `_` and upper-cases each part's first character.

| Schema | Python | Node |
|---|---|---|
| `string` / `integer` / `number` / `boolean` / `null` | `str` / `int` / `float` / `bool` / `None` | `string` / `number` / `number` / `boolean` / `null` |
| `const v`, `enum [...]` | `Literal[...]` (consecutive literals merged), `null` as `\| None` | the literals, `(a\|b)` |
| `anyOf`, `type: [a, b]` | `A \| B` | `(A\|B)` |
| object with `properties` | a named `TypedDict` | a named `@typedef {Object}` |
| object with a schema `additionalProperties` | `dict[str, T]` | `Object<string, T>` |
| any other object (`open()`, a bare `object` input) | `dict[str, Any]` | `Object<string, *>` |
| array | `list[T]` | `Array<T>` |
| no type (`any()`) | `Any` | `*` |

The generator accepts only the schema vocabulary `src/mcp/outputSchemas.ts` declares, plus `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` and `default` on input schemas. Any other keyword throws `mcp client: unsupported schema keyword '<k>' at <tool>.<path>`, and so does a tool named `call` or `url` — both fail boot.

**Errors.** A call raises `ConductorError` when the HTTP status is ≥ 400 **or** the body is an object with `ok === false`; anything else is returned.

| `ConductorError` field | Meaning |
|---|---|
| `code` | the refusal's or fault's `code` ([Error channels](#error-channels)); `None`/`null` when the body is not JSON |
| `reason` | its `reason`; `'response is not JSON'` for a non-JSON body |
| `status` | the HTTP status: **`200` is a tool's own refusal** (`SESSION_UNKNOWN`, `PLAYBOOK_UNKNOWN`, `REFUSED`, …), `4xx`/`5xx` a protocol fault (`TOOL_UNKNOWN` 404, `ARGS_INVALID` 400, `CALLER_UNKNOWN` 404, `INTERNAL` 500, …) |
| `body` | the parsed body (the raw text when it was not JSON) |

- `str(e)` / `e.message` is `<code>: <reason> (HTTP <status>)`.
- No success schema has a top-level `ok:false`, so success shapes that read like failures are **returned**: `sync_worktree`'s `{ok:true, action:'commit-required' | 'rebase-conflict'}`, `renew_session`'s `{requested:true}`, `playbook_state`'s `{tracked:false}`, a non-zero `exitCode` from `project_bash` / `system_bash`.
- A transport failure is the runtime's own exception, unwrapped: Python `urllib.error.URLError`, Node `TypeError: fetch failed`.

**Plugin tools** have no method and no types: call them with `call('<plugin-id>__<tool>', {…})`. The alias passes their MCP envelope `{content, isError?}` through, so an `isError:true` result is **returned**, not raised — it carries no `code` to branch on.

## Env vars

| Var | Set for | Value |
|---|---|---|
| `CONDUCTOR_MCP_URL` | a **local** worker (`Instance.spawn`) | `http://127.0.0.1:<port>/mcp/<its sessionId>`: the worker's own session, JSON by default |
| `CONDUCTOR_MCP_URL` | a plugin backend (`src/plugins/registry.ts`, beside `CONDUCTOR_URL`) | `<CONDUCTOR_URL>/mcp`: anonymous |
| `CONDUCTOR_MCP_CLIENT_DIR` | a **local** worker, the conductor included (`Instance.spawn`) | the absolute `<store>/mcp-client/` ([Client libraries](#client-libraries)) |
| `CONDUCTOR_MCP_CLIENT_DIR` | a plugin backend (`src/plugins/registry.ts`) | the same directory |

- The two vars always travel together: each is set exactly where the other is.
- A worker's vars are **absent** under `ORCH_DISABLE_MCP_AUTOREGISTER=1`; a plugin's are set whenever cc has a port, that setting notwithstanding.
- **Absent** for a worker on a remote System: its Bash runs on the remote without cc's env, cannot read cc's store, and cc's loopback URL does not reach cc from there.
- An inherited value of either (cc itself running as some cc's worker) is removed, never passed on: by `Instance.spawn` for workers and by the supervisor's `spawnChild` for plugins.

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
- **A remote worker gets no `CONDUCTOR_MCP_URL` and no `CONDUCTOR_MCP_CLIENT_DIR`.**
- **The generated clients type core tools only.** A plugin tool is reachable through `call()`, untyped, and its `isError:true` result is returned rather than raised.
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

The generated Node client, run with `CONDUCTOR_MCP_URL` and `CONDUCTOR_MCP_CLIENT_DIR` set; a protocol fault raises with its HTTP status:

<!-- doc-sample: node-client -->
```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { ConductorClient, ConductorError } = await import(
  pathToFileURL(path.join(process.env.CONDUCTOR_MCP_CLIENT_DIR, 'conductor_client.mjs')).href);
const cc = new ConductorClient();
console.log(JSON.stringify(await cc.list_workspaces()));
try {
  await cc.call('no_such_tool', {});
} catch (e) {
  if (!(e instanceof ConductorError)) throw e;
  console.log(e.code, e.status);
}
```

<!-- doc-sample: node-client-output -->
```text
{"workspaces":[{"name":"demo","projectCount":0}]}
TOOL_UNKNOWN 404
```

The generated Python client; a tool's own refusal raises with `status` 200:

<!-- doc-sample: python-client -->
```python
import os, sys

sys.path.insert(0, os.environ['CONDUCTOR_MCP_CLIENT_DIR'])
from conductor_client import ConductorClient, ConductorError

cc = ConductorClient()
print(cc.create_workspace(name='scripts'))
try:
    cc.describe_playbook(id='no-such')
except ConductorError as e:
    print(e.code, e.status)
```

<!-- doc-sample: python-client-output -->
```text
{'added': True, 'name': 'scripts'}
PLAYBOOK_UNKNOWN 200
```
