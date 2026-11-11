# Code mode — `run_code`

One core MCP tool, `run_code`, runs an agent-written JavaScript function body in a Node child process. The child's `cc` object calls back into cc **as the calling session**, so every call it makes into cc's tools goes through the same `runTool` gate (argument validation, prefix resolution, playbook policy, event log) as a direct call. The agent chains or batches calls, filters or aggregates the results, and returns only the digest.

Code: `src/codeMode/` (`runCode.ts` the tool, `runtime.ts` + `runtimeApi.ts` the child, `describeTools.ts`, `tsSignature.ts` + `typeModel.ts`, `precheck.ts`, `runs.ts`, `progressPump.ts`, `limits.ts`), `src/mcp/callStream.ts` (the SSE writer) and the run channel in `src/mcp/server.ts`. The skill that teaches when to use it is `code-conductor:scripting` ([features.md → Core skills](features.md#core-skills)). Tests: `tests/run-code*.test.mjs` (plugin-provided names: `tests/run-code-modules.test.mjs`, `tests/plugins-run-code-module.test.mjs`), `tests/code-mode-*.test.mjs`.

## Tool

| Input | Type | Meaning |
|---|---|---|
| `code` | string, required | the body of an async function with `cc` in scope; its `return` value is the result |
| `description` | string | a short label for the run, shown as the transcript card's summary in place of the code; the run never reads it |
| `timeoutMs` | integer | wall-clock limit; default `RUN_CODE_DEFAULT_TIMEOUT_MS`, clamped (never refused) to `RUN_CODE_MAX_TIMEOUT_MS` by `clampRunCodeTimeoutMs` |

| Output field | Meaning |
|---|---|
| `result` | the return value as JSON text; `null` when nothing was returned or the run errored |
| `logs` | the program's stdout and stderr, interleaved |
| `exitCode` | the process's; `null` on timeout, cancel or spawn error |
| `timedOut` | the process group was killed at the limit |
| `truncated` | `result` was cut at `RUN_RESULT_CAP`; it then ends `… [result cut at N of M chars — return less]` |
| `resultChars` | present only when `truncated`: the full length |
| `logsTruncated` | present only when `logs` may be incomplete: cut at `RUN_LOGS_CAP`, or a background process the program started held the output open after the program exited (`ExecResult.outputMayBeIncomplete`; the process is stopped on POSIX unless it detached) so output it wrote later was not read |
| `durationMs` | wall time |
| `error` | `{name, message, code?, status?}`: what the program threw or why the run ended; `message` is cut at `RUN_ERROR_MESSAGE_CAP` |

- **JSON format:** all of the above are fields of `structuredContent`. **Text format:** content block 0 is the compact-JSON metadata (every field except `result` and `logs`), block 1 is `result` raw (empty when `null`), block 2 is `logs` raw.
- An uncaught throw is **not** a failed call: the call answers normally and `error` carries the throw. `error.name` is `ConductorError` for a refused or faulted `cc` call, `SyntaxError` for a program that does not parse, `TypeError` for a return value that is not JSON-serializable, `NoResult` when the process ended before the function returned (including a program whose event loop emptied while it awaited something that can never settle), `SpawnError` when the child could not start, `Cancelled` (`code: RUN_CANCELLED`) when the caller went away.
- The schema is `OUTPUT_SCHEMAS.run_code` (`src/mcp/outputSchemas.ts`). Its description states the limits as built from `limits.ts`, and ends with the core method names the host serves (`capableTools`, `src/mcp/tools.ts`).
- A run is not read-only: `run_code` carries no `readOnlyHint`.

## The script API

| Spelling | Calls |
|---|---|
| `await cc.<tool>(args)` | the core tool `<tool>` |
| `await cc.<ns>.<tool>(args)` | the plugin name `<id>__<tool>`; `<ns>` is the plugin id with `-` written `_` (an id is a slug with no `_`, so the mapping is exact) |
| `await cc['<id>']['<tool>'](args)` | the same, spelled with the id as is |
| `await cc.call(name, args)` | any wire name, computed or not: `cc.call('code-kanban__list_cards', {})`. The only route to a plugin whose id is a reserved method name |
| `await cc.describe_tools(args)` | [`describe_tools`](#describe_tools), unwrapped to its array |

- **Reserved names** (`RESERVED_METHODS`, `src/codeMode/runtimeApi.ts`): `call`, `describe_tools`, `then`. `then` and symbol keys read as `undefined`, so `await cc.x` is never a thenable.
- Every call into a tool is `POST <run url>/tools/<name>` on the REST alias, as the session. It returns the tool's JSON result.
- **`ConductorError`** (`name`, `message` = `<code>: <reason>`, `code`, `reason`, `status`, `details?`) is thrown when the HTTP status is ≥ 400 or the body is `{ok:false}`. `status` 200 is the **tool's own refusal** (`PLAYBOOK_UNKNOWN`, `TOOL_DENIED_IN_STAGE`, `SESSION_UNKNOWN`, a plugin's code, …); 400 and up is a fault in the call (`TOOL_UNKNOWN` 404, `TOOL_UNAVAILABLE_IN_FORMAT` 404 for an untyped plugin tool, `TOOL_UNAVAILABLE_TO_CALLER` 403 for a tool outside the session's audience, `TOOL_UNAVAILABLE` 409, `PLUGIN_LOAD_FAILED` 500, `ARGS_INVALID` 400). Answers that read like failures but are results are returned: a non-zero `exitCode`, `sync_worktree`'s `action`.
- Node built-ins load by dynamic import of a `node:` specifier. The working directory is the session's own checkout. A program's own `import()` resolves bare specifiers from cc's install (the location of `src/codeMode/runtime.ts`) and relative ones from `src/codeMode/`, never from the cwd: use `node:` specifiers or absolute paths. A plugin's own module imports resolve from the plugin's checkout instead.
- Some plugin names exist only inside a program: they are absent from `tools/list` and the REST listing, `describe_tools` lists them like any tool, and a call from outside a program is `TOOL_UNKNOWN`. Such a call runs inside the program, not through the tool gate. A plugin may also be unavailable on this machine (`TOOL_UNAVAILABLE` 409) or fail to load (`PLUGIN_LOAD_FAILED` 500). The mechanism is [plugins.md → `runCode`](plugins.md).
- `run_code` called from inside a program is refused [`SCRIPT_NESTED`](#refusals).
- A program's calls get no tool-result nudge (`SELF_TITLE_NUDGE`, `LANDING_RENEW_NUDGE`): those ride the calling tool's PostToolUse hook, keyed by the CLI's toolUseId, which a REST-alias call does not carry ([protocol.md](protocol.md) → Tool-result nudges).
- A program cannot wait for a worker: `spawn_instance` and `send_prompt` return at once, and the worker's turn end wakes the session as usual.

## `describe_tools`

An in-script tool only: it is composed into a request that carries a run token (`describeToolsTool`), so it is in neither `tools/list` nor `GET /mcp/<sid>/tools`, and a call without a token is `TOOL_UNKNOWN`. Its source is the request's own live composition (`ctx.tools`, `ctx.textOnlyTools`, and the plugin names only a program can call, `ctx.runCodeMembers`, appended after the tools), so a plugin tool that appears between two calls is in the second, and a tool outside the session's audience is absent; it hides itself and `run_code`.

| Input | Meaning |
|---|---|
| `query` | every whitespace-separated word must occur in the wire name + description, case-insensitive |
| `names` | keep these: wire names or method paths |
| `namespace` | a plugin namespace, `code_kanban` or `code-kanban` |
| `detail` | `names`, `summary` (default) or `full` |

Output `{tools: Entry[]}` in registry order (the script's `cc.describe_tools()` unwraps it):

| Entry field | Detail | Meaning |
|---|---|---|
| `method` | all | the script path: `cc.<tool>`, `cc.<ns>.<tool>`, `cc['<id>']['<tool>']` when the tool part is not an identifier, or `cc.call('<wire>', args)` when the namespace is a reserved method name |
| `name` | all | the wire name |
| `namespace` | all | the underscore spelling, `null` for a core tool |
| `scriptable` | all | `false` for a plugin tool with no `outputSchema`: listed, but a call throws `TOOL_UNAVAILABLE_IN_FORMAT` |
| `description` | `summary`, `full` | the first sentence (cut at `SUMMARY_CAP`), or the whole description |
| `signature` | `full` | the TypeScript declaration |

## TypeScript signatures

`renderSignature` (`src/codeMode/tsSignature.ts`) renders from a per-tool type model (`buildToolModel`, `src/codeMode/typeModel.ts`): a doc comment, `declare function <name>(args: <Tool>Args): Promise<<Tool>Result>;` (`args?:` when nothing is required), then every named type in model order. A plugin tool's type names carry its namespace.

| Schema | TypeScript |
|---|---|
| string / integer / number / boolean / null | `string` / `number` / `number` / `boolean` / `null` |
| no `type` | `unknown` |
| `const`, `enum` | the literal(s), JSON-spelled |
| array | `T[]`, `(A \| B)[]` for a union item |
| object with `properties` | a named `interface`; a non-identifier key is quoted |
| object with `additionalProperties` | `Record<string, T>` |
| `anyOf`, a `type` array | `A \| B` |
| a described property | `/** description */`, plus `@default v` when it has one |
| no `outputSchema` | `Promise<unknown>` |

- The vocabulary is closed: the typing keywords of `src/mcp/jsonSchemaSubset.ts` plus `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `default` on input. Another keyword throws, naming the tool and the schema path.
- `describe_tools` catches that **per tool**: the entry's `signature` becomes `declare function <name>(args?: unknown): Promise<unknown>; // signature unavailable: <reason>` and the server logs the reason.

## Pre-check

Before anything spawns, `literalPaths` scans the program (comments, strings and template literals blanked) for literal `cc.<tool>(` and `cc.<ns>.<tool>(` call sites and `checkPaths` looks each up in the live registry, text-only plugin tools included. One unknown path refuses the **whole** program, so a typo cannot stop it half-way through side effects.

- It errs only toward not refusing: the bracket form, computed names, a call chained deeper than `cc.a.b(`, anything inside a `${…}` substitution and regular-expression literals (where a `/` could be a regex or a division it is read as a regex, and when that reading finds no closing `/` before a quote or the end of the line the rest of the line is not checked) are not checked and are left to the runtime: an unknown name gets `TOOL_UNKNOWN`, and an out-of-audience tool gets the audience refusal described below. A program that binds its own `cc` (a declaration, parameter, destructuring or assignment) is not pre-checked at all.
- A literal path naming a tool outside the session's audience refuses the whole program `TOOL_UNAVAILABLE_TO_CALLER`; a computed call gets it at runtime as a `403` `ConductorError`.
- A core path is known when a core tool of that name (or a reserved method) exists. For `cc.a.b(`: skipped when `a` is a core tool or reserved, else `<a with _→->__<b>` must be a registered plugin tool.
- `unknown[].suggestions` holds up to three nearest names (edit distance or substring), as method paths.

## Refusals

Soft refusals (`{ok:false, code, reason}`; in JSON format `isError`, over REST HTTP 200):

| Code | When |
|---|---|
| `TOOL_UNKNOWN` | the pre-check failed; `unknown: [{path, suggestions}]` names each; nothing ran |
| `TOOL_UNAVAILABLE_TO_CALLER` | the pre-check found a call to a tool not offered to this session; `unavailable: [path]` names each; nothing ran |
| `SCRIPT_NESTED` | `run_code` was called from a run (a call carrying a run token). It guards accidental recursion, not a trust boundary: a hand-rolled request without the header is not detected |
| `SCRIPT_UNAVAILABLE_REMOTE` | the session's project lives on another System; the child runs on cc's own machine |

An anonymous caller (`/mcp`, no session) is a thrown `TOOL_ERROR`: the tool runs as a session.

## Bounds

All in `src/codeMode/limits.ts`.

| Constant | Bounds |
|---|---|
| `RUN_CODE_DEFAULT_TIMEOUT_MS`, `RUN_CODE_MAX_TIMEOUT_MS` | the run's wall clock; at the limit the whole process group is signalled (SIGTERM, then SIGKILL after the grace period). The call returns once the direct child has exited and its stdio has drained for a short grace (`STDIO_DRAIN_GRACE_MS`, `src/groupedCommand.ts`): a detached descendant holding the pipes does not hold the call or the token open. The grace waits out a stalled event loop and re-arms while output keeps arriving, but never past `STDIO_DRAIN_MAX_MS` after the child's exit (or the timeout, if sooner); giving up on unended streams (grace expiry or the ceiling) destroys them, on POSIX sends the command's process group the same SIGTERM → SIGKILL a timeout does (a background child that stayed in the group is stopped; a detached one survives; on Windows nothing is stopped), resolves with the child's exit code (not `timedOut`) and flags `logsTruncated` |
| `RUN_RESULT_CAP`, `RUN_LOGS_CAP`, `RUN_ERROR_MESSAGE_CAP`, `RUN_ERROR_FIELD_CAP` | the result text, the retained logs (bytes, head-kept), an error message, an error's `name` and `code`. cc re-applies them to whatever a run delivers (`capOutcome`, `src/codeMode/runs.ts`), so a program posting its own outcome cannot exceed them |
| `RUN_RESULT_BODY_LIMIT_BYTES` | the largest `/run-result` body accepted (`413` past it), in place of `MCP_REQUEST_BODY_LIMIT` |
| `RUN_RESULT_MAX_CHARS`, `RUN_META_HEADROOM` | the result as cut at cc's boundary (the cap plus its marker), and the room left for the rest of the metadata. The result, the logs and the four error-field caps — the error's fields counted on their JSON-escaped width, since they ride in the metadata block — plus the headroom stay inside `MCP_RESULT_CHAR_BUDGET` (`src/mcp/content.ts`), so `boundResult` never fires for `run_code`. The caps apply in JSON format too |
| `CC_MCP_SERVER_TIMEOUT_MS` | the per-server `timeout` in the `--mcp-config` entry cc writes for every worker (`buildMcpConfigJSON`, `src/settings.ts`): `RUN_CODE_MAX_TIMEOUT_MS` plus `RUN_CODE_TIMEOUT_GRACE_MS` |
| `PROGRESS_HEARTBEAT_MS`, `PROGRESS_MIN_INTERVAL_MS`, `PROGRESS_LINE_CAP` | progress cadence, below |

- **Why the server timeout exists.** Claude Code aborts an HTTP MCP request whose response headers have not arrived within the per-server `timeout` (60 s when none is set) and treats it as a hard wall-clock limit per call. cc's entry sets it above the longest call cc holds open, so cc's own timeout always fires first and answers `timedOut`. It also covers `project_bash` past 60 s.
- **Backgrounding is opt-in.** By default a `run_code` call holds its caller's turn until it returns, is cancelled or times out. With the **MCP auto-background** toggle on (Settings → Models, off by default), cc launches workers with `CLAUDE_AUTO_BACKGROUND_TASKS` and a threshold: a `run_code` call still running at the threshold is moved to the background, the worker's turn ends, and the worker is re-invoked when the call finishes. The conductor's own calls are never backgrounded. Details and known limitations: the **MCP auto-background** card under Settings page → Models in [features.md](features.md).

## Plan mode

A session whose `mode` is `plan` when the run starts gets a child under the Node permission model (`childArgv`, `src/codeMode/runCode.ts`): `--permission --allow-fs-read=*`, plus `--allow-net` when the running Node knows that flag (a Node that does not know it does not gate the network, so the child's network is open on every Node). No write, child-process, worker, addon or WASI grant. Its calls back into cc still work (they are gated as the plan-mode session). A mode change mid-run does not re-flag the child.

## Progress and cancellation

A **single, non-batch** `tools/call` whose `Accept` includes `text/event-stream` may answer as an SSE stream (`createCallStream`, `src/mcp/callStream.ts`); every other request answers one `application/json` as before.

- The stream opens lazily, on the handler's first `ctx.progress`; `run_code` calls it at start, so headers flush at once.
- A notification is written only when the request carried `params._meta.progressToken` (string or number): `event: message` / `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{progressToken, progress, message}}`. Without a token the stream carries just the response.
- The final JSON-RPC response is the last `event: message`, then the stream ends. It passes through the same serializers and result bounds as a plain response.
- **Cadence** (`startProgressPump`, `src/codeMode/progressPump.ts`): once at start (`started`), every `PROGRESS_HEARTBEAT_MS` of silence, and on new log output at most every `PROGRESS_MIN_INTERVAL_MS` with a trailing emit so the latest line is never lost. `progress` is elapsed ms, strictly increasing, with no `total`; `message` is `<m>m<s>s`, plus ` · <last non-empty log line>` cut at `PROGRESS_LINE_CAP`.
- **Cancellation** aborts one per-call signal that reaches `System.exec`, which signals the child's process group: (1) `notifications/cancelled {requestId}`, POSTed to the same `/mcp/<sid>` by the same session (a cancel from another session touches nothing); (2) the connection closing before the response finished (also on the REST alias). A cancelled run answers `error {name:'Cancelled', code:'RUN_CANCELLED'}` if the socket is still open.
- `GET /mcp` stays `405`: server messages ride only on a POSTed `tools/call`'s own response.
- Test seam: `buildMcpRouter({codeModeTiming})` / `bootServer({codeModeTiming})` set the cadence.

## The run channel (internal)

Between the child and cc; not an application API.

| Piece | Contract |
|---|---|
| Env overlay | `CC_RUN_URL` = `<origin>/mcp/<callerId>` (the origin from the request's own socket, `ctx.selfUrl`), `CC_RUN_TOKEN` |
| Code in | the program is written to the child's stdin |
| Token | minted per run (`RunRegistry.open`), revoked when the process settles (`close`); a grandchild that outlives the run cannot call afterwards |
| `x-cc-run-token` (`RUN_TOKEN_HEADER`) | on every call and on the result delivery. A token that is unknown, spent, or belongs to another session is `403` `RUN_TOKEN_INVALID`. A valid one sets `ctx.run` (so `run_code` refuses `SCRIPT_NESTED`) and composes `describe_tools` in |
| `POST /mcp/<sid>/run-result` | body `{result: string \| null, resultChars: integer, truncated: boolean, error?: {name, message, code?, status?}}`; `204` accepted; `403` `RUN_TOKEN_INVALID`; `400` `ARGS_INVALID` for another shape; `409` `RUN_RESULT_DELIVERED` — the first delivery wins |
| `CC_RUN_MEMBERS` | `{"<plugin id>": ["<name>", …]}` as JSON: the plugin-provided names this run's pre-check saw, so the child routes them synchronously. Names only; absent = none; malformed = child exits 2 |
| `GET /mcp/<sid>/run-modules/<id>` | the child's lookup for a namespace, once per run on its first call into it; requires the token (`403` `RUN_TOKEN_INVALID` without a live one for this session). `200` `{id, path, baseUrl, caller: {sessionId, project}, members: [{name, inputSchema}]}`; `404` `TOOL_UNKNOWN` (plugin provides none now); `409` `TOOL_UNAVAILABLE`. `path` is absolute, in the plugin's active checkout |

The result goes over this channel rather than stdout because the logs are head-capped: a result printed last would be lost behind long logs. After the result is posted the child drains its streams and exits (`1` when it carries an `error`), so leftover timers cannot print after it.

## Samples

Replayed by `tests/mcp-applications-doc-samples.test.mjs` as a live session: each `run-code`-style block is POSTed as `{code}` to `/mcp/<sessionId>/tools/run_code`, and the matching `…-result` block must equal the response's `result` exactly.

A digest in one call:

<!-- doc-sample: run-code -->
```js
const { workspaces } = await cc.list_workspaces();
return { workspaces: workspaces.length };
```

<!-- doc-sample: run-code-result -->
```json
{"workspaces":0}
```

Looking tools up by name:

<!-- doc-sample: describe-names -->
```js
return (await cc.describe_tools({ names: ['list_projects', 'list_workspaces'], detail: 'names' })).map(t => t.method);
```

<!-- doc-sample: describe-names-result -->
```json
["cc.list_projects","cc.list_workspaces"]
```
