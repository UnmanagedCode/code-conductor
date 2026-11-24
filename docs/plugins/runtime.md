# Plugin system: proxy, bridge and host services

## Reverse proxy — `/plugins/<id>/*`

- `/plugins/<id>/foo?q=1` → child `/foo?q=1` (prefix strip). Injected headers: `X-Forwarded-Prefix: <CC_BASE_PATH>/plugins/<id>` (no base: `/plugins/<id>`), `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`.
- `GET /plugins/<id>` → `301 <base>/plugins/<id>/` (query preserved). Child `Location:` headers starting with `/` get `<base>/plugins/<id>` re-added. `<base>` is `CC_BASE_PATH` (empty at root).
- cc's own security headers (`HOST_SECURITY_HEADERS`) are removed from proxied responses; the plugin's `Content-Security-Policy`, `X-Frame-Options` and `X-Content-Type-Options` pass through unchanged. A plugin's framing policy counts only if its `X-Frame-Options` is `DENY` or `SAMEORIGIN` (trimmed, case-insensitive) or its `Content-Security-Policy` has a `frame-ancestors` directive. Otherwise cc sets `X-Frame-Options: SAMEORIGIN`, replacing any unusable value the plugin sent, such as a blank one or the legacy `ALLOW-FROM …` that browsers ignore (`proxiedPluginHeaders`, `src/securityHeaders.ts`), so cc's same-origin frame loads the page and no other origin can. The proxy's own 301/404/502/503 responses carry cc's full policy.
- Bodies are never parsed: pure req→upstream→res streaming (SSE works), with or without a base path. Request headers, including `accept-encoding`, go upstream as the browser sent them. An upstream that errors or over-sends once its body is streaming has the client response destroyed, never ended mid-pipe. WebSocket upgrades are raw-socket piped with the original header order/casing replayed.
- A plugin WebSocket upgrade first passes cc's Origin check ([protocol/websocket.md](../protocol/websocket.md) → WebSocket protocol → Handshake: Origin check): a cross-origin browser upgrade is a raw `403` and never lazy-starts the child. An admitted upgrade reaches the child with the browser's `Origin` and `Host` unchanged.
- Requests to an enabled-but-stopped plugin wait through the lazy start (`READY_TIMEOUT_MS` in `src/plugins/supervisor.ts`). Unknown/disabled id → 404 JSON; `failed` → `503 {error, status:"failed", tail}`; crash-backoff window → `503 {error, status:"crashed", retryAfter, tail?}`; child unreachable mid-request → 502.

## Bridge protocol — `/pluginBridge.js`

Plugin frontends include `<script src="../../pluginBridge.js"></script>` as a blocking script, first in `<head>` (no `defer`: the theme and session-width syncs below then run before first paint; a deferred bridge still syncs, but only at deferred-script time) (`web/src/features/views/pluginBridge.js`, served by an explicit `GET /pluginBridge.js` route in `server.ts` whether or not the web UI is built; harmless 404 standalone, no-op when not iframed; the parent side is `pluginFrames` in `web/src/features/views/plugins.ts`). Under a base path the host URL must be relative (`../../pluginBridge.js` / `../../pluginTheme.css` from a page at the plugin root, one more `../` per directory level) or built from `X-Forwarded-Prefix`: a root-absolute `/pluginBridge.js` resolves to the host's root, so the page loses the bridge and theme there; root setups are unaffected ([plugin-ui.md](../plugin-ui.md) → host URLs). Envelope `{cc:1, type, ...}` over `postMessage`, same-origin both ways. Core messages (every page) plus the optional session-awareness messages (pages that use `window.ccBridge`):

| Direction | Type | Payload | Meaning |
|---|---|---|---|
| child → parent | `ready` | — | bridge alive (initial `route` follows); the parent answers with a `session` |
| child → parent | `route` | `{path}` | child-relative path (incl. search+hash), which **must begin with `/`** — the parent ignores a `route` whose path does not; parent mirrors it into `#plugin/<id><path>` via `replaceState` |
| parent → child | `navigate` | `{path}` | external navigation; bridge `replaceState`s `<prefix><path>` and dispatches a synthetic `popstate` |
| parent → child | `session` | `{session: {sessionId, project, worktree} \| null}` | the active session. `worktree` is the instance's `worktree.worktreeName` (the `worktreeName` key of `GET /api/projects/:name/worktrees`), `null` for the main checkout |
| child → parent | `openLink` | `{href}` | a plain click on a link whose http(s) host is cc's link host (`cc.internal`), whatever its `target`, or on a `target="_top"` / `_parent` link to cc's own path + search with a `#plugin/` hash; the bridge prevents it and reports the resolved `href`; the parent shows it in the dock or follows it as a fragment navigation |
| child → parent | `openSession` | `{id, sessionId}` | make a live session the selection, as a sidebar pick does |
| child → parent | `sendPrompt` | `{id, sessionId, text}` | deliver `text` to a live session as its composer's Send does, without selecting it |
| parent → child | `result` | `{id, ok, code?}` | the answer to one `openSession` / `sendPrompt`, posted to the calling frame only |

**Active session** = `activeInstance(appStore.get())` (`web/src/state/app.ts`): cc's one selection, in every layout; `null` when nothing is selected or the selected instance has no `sessionId` yet. The per-layout table is in [plugin-ui.md](../plugin-ui.md) → Session awareness.

**`session` is sent** to one frame on its `ready` (a reload in place sends a fresh `ready`), and to **every** frame — the shared frame and each resident frame, hidden ones included — whenever the active `(sessionId, project, worktree)` triple changes. An unchanged triple (an instance-list refresh, a status change) posts nothing.

**`openLink` rules:**
- Sent by the bridge itself, not part of `ccBridge`.
- Honoured only from the **shown** frame (same origin and `ev.source` as every message, and the frame is the current plugin's); a hidden resident frame's is ignored.
- `href` must pass `viewLinkHash` (`web/src/state/route.ts`), the check a transcript link gets; anything else (a message without a string `href` included) is ignored. The bridge prevents every plain click on a `cc.internal` link, so one cc rejects goes nowhere.
- The bridge reads the link host from `data-cc-link-host` on cc's `<html>` (below). Under an unreadable parent it catches no link.
- Outcome: `showLinkInDock` when the dock shows a plugin beside the session and the switcher lists the target; otherwise `location.hash = <the hash viewLinkHash returned>`, the navigation a `_top` link to cc's page makes.

**`openSession` / `sendPrompt` rules:**
- `id` must be a string; a call without one is ignored (nowhere to reply). Exactly one `result` per received call.
- The child accepts `session`, `result` and `navigate` only from `window.parent` (same origin and `ev.source`).
- Accepted from any known frame (shared or resident, hidden included): same origin, and `ev.source` is that frame's `contentWindow`. An unknown source gets no reply.
- Instance lookup by `sessionId`: the listed instances plus the pristine slot; a live instance (status not `exited`/`crashed`) wins over a dead one sharing the id; none → `GET /api/sessions/:sid/locate`.
- `openSession` on a live session calls `selectInstance(id, {userGesture: true})` — what a sidebar row pick does (split: the session column switches and the dock stays; full-screen / phone: leaves the plugin view for the session). A session that is not live is refused; nothing is resumed.
- `sendPrompt` goes through `web/src/features/composer/send.ts` (`promptSendable`, `sendPrompt`), the composer's own path: `text` is trimmed, `notePristineSent` runs, the `prompt` frame is sent with `{ack: true}`. The server treats it as typed text (`promptOrQueueSteer`: a steer when busy, queued under the overage lockout; a conducted worker's conductor wake fires on its turn end). It never changes the selection, the route, drafts or attachments.

| `code` | When |
|---|---|
| `INVALID_ARGUMENT` | `sessionId` is not a non-empty string, or (`sendPrompt`) `text` is not a string or is empty after `trim()` |
| `SESSION_UNKNOWN` | no instance carries the id and `locate` refuses it (`ApiError`) |
| `SESSION_NOT_LIVE` | the session exists but no live instance carries it (`exited`/`crashed`, or a `locate` hit, archived or not) |
| `SESSION_NOT_READY` | `sendPrompt` only: live, but the composer's Send would be disabled (status not `idle`/`turn`, a `modelSwitch` in flight, `overageStoppedUnarmed`) |
| `VIEW_ONLY` | `sendPrompt` only: cc runs under `CC_VIEW_ONLY`, so the `prompt` frame was refused client-side (`ViewOnlyError`); nothing was sent |
| `SEND_FAILED` | `sendPrompt` only: the acked `prompt` frame was rejected (server error ack, closed socket, the 10 s ack timeout in `shared/ws.ts`) |
| `LOOKUP_FAILED` | the `locate` read failed with a network error, or did not settle within 10 s |
| `HOST_ERROR` | an unexpected failure inside cc while carrying out the call |

`SESSION_UNKNOWN` and `SESSION_NOT_LIVE` reuse the MCP vocabulary of `src/mcp/handlers.ts`.

**Child API.** Outside an embed, or on a host without these messages, `window.ccBridge` is absent. Embedded it holds `session` (`undefined` until the first `session` message, then the payload or `null`), `onSession(fn)` → unsubscribe (`fn` runs on every `session` message, and at once when one has arrived), and `openSession(sessionId)` / `sendPrompt(sessionId, text)` → `Promise<{ok, code?}>`. A promise never rejects: it resolves with the host's `result`. The parent sends exactly one `result` per received call, and bounds the slow parts: the send ack and the `locate` read at 10 s each. A frame that navigates or reloads mid-call loses its reply, so a plugin that needs a deadline sets its own.

**Security.** `openSession` / `sendPrompt` let any plugin page, hidden keep-alive frames included, drive any session. That adds no reach: a plugin page is same-origin with cc and can already call cc's unauthenticated API and socket. It is why the content-rendering rules in [plugin-ui.md](../plugin-ui.md) Part 2 matter.

**REST metadata a plugin backend reads** alongside these messages (full shapes in [protocol.md](../protocol.md)): `GET /api/projects/:name/worktrees` per worktree — `worktreePath`, `branch`, `baseBranch`, `baseSha`, `baseWorktree` (the parent worktree's `worktreeName`; absent = forked from the main checkout), `parentPath` (the main checkout); `GET /api/projects` row `path` (the main checkout when a project has no worktrees); `GET /api/projects/:name/location` → `{name, system, remoteId, path}`, the placement lookup that runs no git, unlike `GET /api/projects` ([protocol/rest.md](../protocol/rest.md#rest-endpoints) REST endpoints); `GET /api/instances` — `{sessionId, project, status, cwd, displayLabel, worktree: {worktreeName, branch, baseBranch, baseSha} | null}` per instance, `worktree: null` = the main checkout; `displayLabel` is the label to show a person for the session, never empty — the one cc's sidebar shows, except for an untitled session after a rotation, a rewind to its first prompt, or an over-long first record, where the sidebar reads the transcript's own first prompt instead (protocol/ws-events.md → `summary().pristine` / `title` / `displayLabel`). **Live = `status` not `exited`/`crashed`**: the `sessionIds` lists on the worktrees and projects rows are *not* liveness-filtered (they include retained exited persistent instances), so use `GET /api/instances` for "live". To run a command on a project's System (git, a temp file, anything with stdin or env), use [`POST /api/exec`](#host-exec--post-apiexec); to open an interactive terminal there, [`GET /api/terminal`](#host-terminal--get-apiterminal-websocket).

Inside the iframe the bridge patches `history.pushState` → `replaceState`, so a plugin visit adds exactly one joint-history entry (hardware Back lands on the session, with the plugin as the rail where Collapse shows, else on Conductor). Multi-page plugins bypass this and pollute history.

**Theme sync** (not a message): the bridge reads the parent's `<html>` directly and mirrors cc's resolved theme onto the page's own `<html>` — the `dark` class, plus `data-cc-theme="light"|"dark"`, which is present only while cc owns the theme. It applies it synchronously when the script executes and again on every change through a `MutationObserver` on the parent `<html>`'s `class`, hidden frames included. cc's `<html>` carries `.dark` exactly when its resolved theme is dark (`web/index.html`'s pre-paint script, then `web/src/app/theme.ts`, which also follows `prefers-color-scheme` under "system"). A parent whose `document` cannot be read (cross-origin: `SecurityError`) leaves the page's theme alone; standalone or outside a `/plugins/<id>/` mount the bridge does nothing at all.

**Session width sync** (not a message): the bridge mirrors cc's committed session-column width onto the page's own `<html>` as the custom property `--cc-session-width`: `<n>px` while Full is off, `none` while it is on (`sessionWidthCss`, `web/src/app/sessionWidthScale.ts`), and `none` whatever the setting while the page is in the side pane. cc publishes it as `data-cc-session-width` on its own `<html>` (`startPluginSessionWidth`, `web/src/features/views/pluginSessionWidth.ts`, started from `main.tsx`) from two inputs, the setting (`sessionWidthStore`) and the plugin column's mode (`dockModeStore`, `web/src/features/views/dock.ts`):

| Column mode | Published |
|---|---|
| `split`, `rail` (the side pane) | `none` |
| `full` (the full view, or a split too narrow to fit, shown over the session) | `sessionWidthCss(setting)` |
| `hidden` | the value of the last non-hidden mode (`full`'s before any plugin has shown), still following the setting if that was `full` |

Every frame lives in the one plugin column, so one value serves them all. The bridge copies the attribute when the script executes and again on every change through a `MutationObserver`, hidden frames included. Only the committed setting is published: a handle drag updates plugins on release, not during it. Unset under an unreadable parent, standalone, or outside a `/plugins/<id>/` mount, and while the attribute is absent. Use it as `max-width: var(--cc-session-width, <fallback>)`. A plugin never reads cc's storage.

**Link host** (not a message): cc publishes `CC_LINK_HOST` (`cc.internal`, `web/src/state/route.ts`) as `data-cc-link-host` on its own `<html>` (`startPluginLinkHost`, `web/src/features/views/pluginLinkHost.ts`, started from `main.tsx`). The bridge reads it from the parent at click time to recognise a `cc.internal` link (`openLink` above); it has no copy of the name. Nothing is mirrored into the plugin page.

## Host exec — `POST /api/exec`

A plugin backend runs a command on a project's System, or on a System addressed directly, with `fetch("$CONDUCTOR_URL/api/exec", {method: 'POST', body: JSON})`. No helper library and no MCP tool. Implemented in `src/hostExec.ts`, `src/routes/exec.ts`, composed by `buildRoutes`. There is no allow-list, path scoping or caller check — same trust model as the rest of cc's API.

**Target — exactly one form:**

| Form | Fields | Resolution |
|---|---|---|
| A | `project`, `worktree?` | `resolveProjectCwd` (`src/worktrees.ts`): cwd = the project's tree, or the worktree's; system = the project's |
| B | `system`, `remoteId?`, `cwd` | `systemById` (`src/systems/registry.ts`). `cwd` required and absolute. `remoteId` `''`/absent/`null` = the provider's default target. `system: 'local'` allowed; `remoteId` with `local` is refused |

**Request fields** (JSON; an unknown key is refused, so a typo like `input` for `stdin` fails loudly):

| Field | Rule |
|---|---|
| `argv` *or* `shell` | exactly one. `argv`: non-empty array of strings, no NUL, `argv[0]` non-empty — run directly. `shell`: non-empty string, no NUL — run through the target's shell — `bash -lc` locally and in the reference provider; a provider may use `sh -c` ([systems-protocol.md](../systems-protocol.md) §5, `shell`), so write POSIX sh |
| `env?` | object; names match `ENV_NAME_RE` (`src/systems/execWrap.ts`), values strings without NUL. **Overlays** the target's default environment (`{...defaultEnv, ...env}`); never replaces it. In shell form it is applied after the login profile, so a profile cannot override it |
| `stdin?` / `stdinB64?` | at most one. `stdin`: UTF-8 text. `stdinB64`: strict base64 bytes. Absent = a closed stdin (EOF) |
| `encoding?` | `'utf8'` (default) or `'base64'` — `stdout`/`stderr` returned base64 of the raw bytes |
| `timeoutMs?` | positive integer ≤ `EXEC_MAX_TIMEOUT_MS`; default `EXEC_DEFAULT_TIMEOUT_MS` (both in `src/hostExec.ts`) |
| `maxOutputBytes?` | positive integer ≤ `EXEC_MAX_OUTPUT_BYTES`; default `EXEC_DEFAULT_OUTPUT_BYTES`. Total across both streams |

Request body limit: `EXEC_BODY_LIMIT` (route-local parser, ahead of the router-wide 1mb one); over it is express's own 413 `{error}` with no code.

**Response 200** — the command ran, whatever its exit code: `{exitCode, stdout, stderr, encoding, durationMs, system, remoteId, cwd, descendantsMaySurvive?: true}`. `system`/`remoteId`/`cwd` echo the resolved target (`remoteId` is always `null` for `local`).

**Refusals** — every body is `{error, code, …}`:

| Status | `code` | When | Extra fields |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | any shape rule above, both or neither target form, both `argv` and `shell` | |
| 400 | `CWD_NOT_ABSOLUTE` | form B with a relative `cwd` | |
| 404 | `PROJECT_UNKNOWN` | unknown project | |
| 404 | `WORKTREE_UNKNOWN` | unknown worktree of that project | |
| 501 | `SYSTEMS_UNAVAILABLE` | a non-local system on a platform with `remoteSystems` off — form B is refused before any provider launches | |
| 501 | `SYSTEM_NOT_REGISTERED` / `SYSTEM_NO_PROVIDER` / `SYSTEM_NO_REMOTES` | from resolution | |
| 502 | `SYSTEM_UNREACHABLE` / `REMOTE_NOT_FOUND` | from resolution, or **during** the command (provider died, staging write unanswered; an unknown remote) | |
| 422 | `EXEC_SPAWN_FAILED` | the command never started: missing binary, bad cwd, `EACCES`, unopenable staged stdin (`ESTDIN`) | `errno` (or `null`) |
| 422 | `EXEC_OUTPUT_TOO_LARGE` | output passed `maxOutputBytes`; the command was killed | `limitBytes` |
| 504 | `EXEC_TIMEOUT` | `timeoutMs` passed; the command was killed | partial `stdout`/`stderr` (in `encoding`), `encoding`, `durationMs`, `descendantsMaySurvive?`, `abandonedAfterMs?` (cc gave up on a provider that never reported the exit) |

**Output is buffered whole, behind a fence.** No streaming, no paging: re-running a command for page two is neither idempotent nor free, and stream framing would tax every small call. Past `maxOutputBytes` the command is killed and the answer is `EXEC_OUTPUT_TOO_LARGE` — never a clipped 200.

**Kill semantics.** `timeoutMs` bounds the command only. Locally the whole process group is SIGTERMed, then SIGKILLed after the kill grace. On a provider the provider enforces it — group-wide when it advertises `processGroupSignal`, otherwise only the direct child, flagged `descendantsMaySurvive` — and cc abandons at `timeoutMs + EXEC_TIMEOUT_SLACK_MS` (`src/systems/providerSystem.ts`). A client that disconnects before the response kills the command the same way. Locally, once the direct child has exited the runner stops waiting for stdio that a descendant still holds open after `STDIO_DRAIN_MAX_MS` (`src/groupedCommand.ts`); the runner then, on POSIX, signals the command's process group (a background child that stayed in it is stopped; on Windows nothing is) and the in-process `ExecResult` carries `outputMayBeIncomplete` (a local-only field no provider sets) and is not a timeout. `/api/exec` does not report that field.

**How stdin and `env` reach a provider System** (no wire change; detail in [systems-protocol.md](../systems-protocol.md) §7): stdin is written to `/tmp/cc-stdin-<32 hex>` on the target (`writeFile`, exclusive, mode 0600), and a `/bin/sh` wrapper opens it onto fd 0 and deletes it **before** the command starts; `env` rides as `env(1)` assignments (argv form) or `export` lines (shell form), never as a frame `env`. Locally stdin is a pipe and `env` a merge (argv) or the same `export` lines (shell).

**Target-side temp files** — there is no utimes or temp-dir primitive; run them through this route (e.g. the code-review plugin's private index):

```bash
d=$(mktemp -d)                         # shell: create; read the path from stdout
cp .git/index "$d/index"               # argv ['cp', …] or shell
touch -m -d @1700000000 "$d/index"     # set an mtime (seconds since the epoch)
rm -rf -- "$d"                         # clean up
```

**Known limitations.**
- A staged stdin file leaks when the provider dies between the staging write and the wrapper's `rm`. cc then tries to remove it (best-effort, not awaited) and logs `exec: could not remove staged stdin <path> on system <id>: …` when that fails; the file stays under `/tmp/cc-stdin-*` on the target.
- On a provider System, a call with stdin or `env` reports a missing or non-executable `argv[0]` through the wrapper's pre-check, which follows execvp as local spawn does: a bare name runs the first executable regular file on PATH, is `EACCES` when PATH holds only non-executable entries of that name (a file without the execute bit, a directory), and `ENOENT` when it holds none; a path is `ENOENT` when absent and `EACCES` when a directory or not executable. It agrees with a local spawn for `ENOENT` and `EACCES` only — any other reason a binary cannot start surfaces as the command's own failure — and even there with one exception: a PATH directory the caller may not search (mode 0000, another user's home) is reported `ENOENT` where local spawn says `EACCES`, since the wrapper cannot see into it.

## Host terminal — `GET /api/terminal` (WebSocket)

A plugin backend opens a terminal — a program under a pseudo-terminal, bytes both ways — on a project's System, or on a System addressed directly, by dialling a WebSocket to `$CONDUCTOR_URL/api/terminal`. Local and remote targets take the same path, `System.openTerminal` ([components/systems.md](../components/systems.md#terminals--systemopenterminal-srcsystemsterminalts-srcsystemsptyhostts-srcsystemsptyhelperpy) → Terminals). Implemented in `src/hostTerminal.ts`, dispatched from the upgrade handler in `server.ts`; the target forms and their resolution are `src/hostTarget.ts`, shared with [Host exec](#host-exec--post-apiexec). cc is the byte pipe only: the plugin owns sessions, scrollback and reattach, and a terminal dies with cc.

**Handshake:** `GET /api/terminal?spec=<URL-encoded JSON object>` with WebSocket upgrade headers. A plain GET without an upgrade is express's 404. The spec rides the URL, so its size limit is node's header limit (`--max-http-header-size`); over it node answers 431. **The request line may be logged** by anything in front of cc — a code-hub share, a tunnel, a reverse proxy — so `env` must not carry secrets; hand a secret to the program another way (a file it reads, or over the terminal's own input).

**`spec` keys** (an unknown key is refused; there is no `shell`):

| Key | Rule |
|---|---|
| target | exactly one form, as on [Host exec](#host-exec--post-apiexec): `project`, `worktree?` — or `system`, `remoteId?`, `cwd` |
| `argv?` | non-empty array of strings, no NUL, `argv[0]` non-empty. Absent = the target user's login shell |
| `env?` | an overlay with Host exec's rules. It reaches the **program only**, never a process hosting the terminal ([systems-protocol.md](../systems-protocol.md) §5, `pty.envOverlay`) |
| `cols`, `rows` | integers in `1..PTY_DIM_MAX` (`src/systems/protocol.ts`), required |
| `term?` | matches `TERM_RE` (`src/systems/terminal.ts`); default `TERMINAL_DEFAULT_TERM` (`src/hostTerminal.ts`) |

**Every refusal comes before the upgrade.** cc opens the terminal *before* completing the handshake, so a refusal is an HTTP answer — `<status>`, `Content-Type: application/json`, body `{error, code, …}` — then the socket is closed. Node's `ws` client surfaces it as `unexpected-response`.

| Status | `code` | When | Extra fields |
|---|---|---|---|
| 403 | `ORIGIN_REFUSED` | the request carries an `Origin` header, whatever its value — checked first, before the spec is read. An `Origin` that fails cc's global upgrade guard ([protocol/websocket.md](../protocol/websocket.md) → Handshake: Origin check) — `null`, cross-origin — is refused 403 by that guard first, with no body | |
| 400 | `INVALID_ARGUMENT` | no `spec`, not JSON, not an object, an unknown key, any shape rule above, both or neither target form | |
| 400 | `CWD_NOT_ABSOLUTE` | form B with a relative `cwd` | |
| 404 | `PROJECT_UNKNOWN` / `WORKTREE_UNKNOWN` | from resolution | |
| 501 | `SYSTEMS_UNAVAILABLE` | a non-local system on a platform with `remoteSystems` off — form B is refused before any provider launches | |
| 501 | `SYSTEM_NOT_REGISTERED` / `SYSTEM_NO_PROVIDER` / `SYSTEM_NO_REMOTES` | from resolution | |
| 501 | `SYSTEM_NO_PTY` / `PTY_UNAVAILABLE` | the provider lacks the `pty` capability / cc's own host has no pty helper (Windows, or no python3) | |
| 429 | `TERMINAL_LIMIT` | `MAX_TERMINALS_PER_SYSTEM` (`src/systems/terminal.ts`) already open on that system — per host for `local`, per provider pipe otherwise | |
| 502 | `SYSTEM_UNREACHABLE` | the provider died or never started the terminal (`ETRANSPORT` / `ETIMEDOUT`) | |
| 502 | `REMOTE_NOT_FOUND` | the provider does not know the target (`ENOREMOTE`) | |
| 422 | `TERMINAL_SPAWN_FAILED` | the target answered and the program did not start: missing program or cwd, `EACCES`, no terminal (`EPTY`) | `errno` — the protocol code |
| 500 | — | a cc bug; logged with `console.error` | |

**After the 101:**

- **Binary messages** carry raw terminal bytes both ways. A UTF-8 sequence may be split across two messages. `^C` is binary `0x03`.
- **Client → cc text** is control only: `{"type":"resize","cols":N,"rows":N}`.
- **cc → client text** is exactly one message, the last: `{"type":"exit","code":N|null,"signal":"SIG…"|null}` (`code` null when a signal ended the program) or `{"type":"failed","code":"<SystemErrorCode>","error":"…"}`.

| Close | Meaning |
|---|---|
| 1000 | the program exited; the `exit` message precedes it |
| 1011 | the terminal was lost (`failed`, e.g. the provider died, `ETRANSPORT`); the `failed` message precedes it |
| 1008 | the client broke the protocol — a text message that is not a valid `resize`. The reason names it; the program is killed |
| 1009 | a message over `TERMINAL_WS_MAX_MESSAGE_BYTES` (`src/hostTerminal.ts`), enforced by `ws`. Chunk large pastes |
| any, from the client | the client closing or erroring closes the terminal: hang-up, then SIGKILL of what is left of its session's process groups |

**Backpressure, both ways — nothing is dropped.**
- **cc → client.** Bytes handed to the socket and not yet written are counted; at `TERMINAL_WS_HIGH_WATER_BYTES` cc pauses the terminal, so a client that stops reading stops the program on its next write; at 0 it resumes.
- **Client → cc.** When the terminal reports its input backed up (`Terminal.write` returns false — the program is not reading) cc stops reading the socket, and resumes on `onDrain`. A client that keeps sending sees its own send buffer grow.
- **A client that stops reading output also freezes its own keyboard.** While the terminal is paused, the input it holds is not reported written, so once about `TERMINAL_WRITE_HIGH_WATER_BYTES` of input is buffered cc stops reading the socket too. Reading again resumes both.
- Held in cc per terminal: about `TERMINAL_WRITE_HIGH_WATER_BYTES` (`src/systems/terminal.ts`) plus one message plus one socket read inbound, and `TERMINAL_WS_HIGH_WATER_BYTES` plus one chunk outbound.
- No keepalive or ping.

**Security.** The trust model is Host exec's: no caller check. The fences are the loopback bind (`HOST`, default `127.0.0.1`; `CONDUCTOR_URL` is loopback) and the refusal of **any** `Origin`: a browser always sends one on a WebSocket handshake, so no page reaches this endpoint — same-origin cc pages and plugin iframes included, which the global upgrade guard alone would admit — while a plugin backend, a non-browser client, sends none. A page cannot reach it through `/plugins/<id>/…` either: the proxy dials the plugin's port, not cc's. **Behind a code-hub share of cc** (authproxy, tunnel, Funnel, LAN) the proxy gates every upgrade on its own cookie or Basic auth and replays the headers unchanged, `Origin` included: a browser behind the share is refused by the Origin rule, and a non-browser client holding the share's credentials reaches this endpoint — exactly as it already reaches `POST /api/exec`, so it adds no reach. A LAN share with auth off exposes both equally.

## Theme stylesheet — `/pluginTheme.css`

- **Content:** the `@font-face` rules of cc's installed `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` packages, a `/* cc:tokens */` marker line, then the palette tokens — the `:root` and `.dark` custom properties (plus `.dark`'s `color-scheme: dark`) that cc's own UI uses. **Unlayered**, so it wins over a plugin's `@layer base` fallback whatever the source order.
- **Source:** `web/src/themeTokens.css`, which cc's `web/src/index.css` imports. `src/pluginTheme.ts` (`composePluginTheme`) composes the sheet from that file and the packages' `index.css` on every request: `200 text/css; charset=utf-8`, `Cache-Control: no-cache`. It answers whether or not the web UI is built. Any failure to compose it — an unreadable source, or a font package whose `index.css` has no `url(./files/…)` to rewrite, rather than a sheet without fonts — is logged (`console.error`) and answered **503** `text/plain` `host theme unavailable`, with no detail on the page.
- **Fonts:** the packages' `url(./files/<file>)` references are rewritten to the sheet-relative `url(pluginTheme/fonts/<pkg>/<file>)` (resolving to `GET /pluginTheme/fonts/<pkg>/<file>` under whatever prefix serves the sheet), where `<pkg>` is a key of `FONT_PACKAGES` (`src/pluginTheme.ts`) and `<file>` matches `^[a-z0-9-]+\.woff2$`; served from that package's `files/` directory as `font/woff2`. Anything else is a 404. Same origin as the plugin page, so a plugin backend whose CSP has `default-src 'none'` needs `font-src 'self'` (and `style-src 'self'` for the sheet itself) or the browser blocks the fonts silently.
- **Guard:** `tests/plugin-theme.test.mjs` fails when a token served differs from cc's effective value (an override in `index.css`'s own `:root`/`.dark`, a dropped `@import`), when a token `index.css`'s `@theme inline` maps is not served, when a served font URL does not resolve, and when the `@theme inline` block in `docs/plugin-ui.md`'s reference setup differs from `index.css`'s.

## Authoring playbooks from a plugin

A plugin that lets users edit playbooks (rather than ship them) works against the **user overlay**, not its manifest. cc core serves read + validate only — [`/api/playbooks`](../protocol/playbooks.md#rest--apiplaybooks) at `$CONDUCTOR_URL/api/playbooks`; the plugin does the writing.

- **Create / edit** = write `$PROJECTS_ROOT/.code-conductor/playbooks/<id>.json` (`orchStoreRoot()/playbooks`; the dotfolder is `ORCH_STORE_DIRNAME`, `src/storeRoot.ts`), creating the directory if missing. The body's `id` must equal `<id>`.
- **Delete** = remove that file.
- **Validate first:** `POST /api/playbooks/validate` with the draft; write only on `{ok:true}`.
- **Collisions:** check `GET /api/playbooks` → `takenIds` — a `builtin` id overrides the shipped definition (legal; warn), a `user` id overwrites that file, a `reserved` id is **silently ignored** by the loader (refuse it).
- **Pickup:** the next `loadPlaybooks` call reads the file — bodies are read per call, no restart. The conductor's role doc picks it up from its next spawn/resume.
- **Live runs drift:** editing an id live workers are bound to changes their graph under them (`GET /api/playbooks/:id` → `liveWorkers`; protocol/playbooks.md → Playbooks → Known limitations).
- **Plugin-contributed playbooks are read-only** here (`editable:false`): edit them in the contributing plugin's manifest files.

## Auto-start

- **Flag:** `autoStart` on the plugin's `registry.json` record (`setAutoStart` in `src/plugins/store.ts`); default `false`. Set with `POST /api/plugins/:id/autostart` or the Settings → Plugins **Auto-start** switch.
- **Applies to** enabled, `local`, backend-bearing plugins only — the same refusals as the route. A disabled plugin never auto-starts; disable keeps the flag, and re-enable (including a Library install's enable) restores it.
- **Boot only.** Setting the flag starts nothing, clearing it stops nothing. At boot, `server.ts` runs `pluginHost.autoStartAll()` (`src/plugins/registry.ts`) after `init()` (so after adoption), fire-and-forget — boot does not wait on it.
- **Targets:** every record with `autoStart` and `enabled` whose backend is neither `ready` nor `starting`. A child adopted from `runtime.json` is `ready`, so it is left running, never restarted or duplicated.
- **Each start goes through `start()`** — the Start button's path — all in parallel.
- **A failure blocks nothing:** it shows on the row as `crashed` + **Crash output** (a refusal such as an undiscovered plugin shows only in the log), plus one server log line `plugins: auto-start of '<id>' failed: <error>`. `autoStartAll()` returns `{started, failed:[{id, error}]}` and never rejects except through init.
- **Not a crash supervisor:** a backend that dies later is not restarted; the lazy start on its next proxied request or MCP call still applies.

## Backend output and exit history

A backend's output and the way each run ended are kept by cc, not by the process that started the backend, so both survive a cc restart.

**Files** (cc-owned, under `<PROJECTS_ROOT>/.code-conductor/plugins/`; the plugin-owned `data/<id>/` is never touched):

| Path | Holds |
|---|---|
| `logs/<id>/backend.log` | stdout+stderr of the current run, one append-mode file |
| `logs/<id>/backend.prev.log` | the previous run's file (one generation) |
| `exits.json` | `{<id>: ExitRecord[]}`, newest first, `EXIT_HISTORY` per id (`src/plugins/store.ts`); independent of `runtime.json`, so a later start overwriting the runtime record loses nothing |

- **No pipe.** cc opens `backend.log` (`O_APPEND`) and passes it as the child's fds 1 and 2, then closes its own copy. A backend adopted after a cc restart therefore keeps writing the same file; a direct `process.stdout.write` cannot die on a dead pipe.
- **Rotation:** once per `start()` (not per EADDRINUSE retry), `backend.log` becomes `backend.prev.log`, overwriting the older one. A child stopped by cc but still in its SIGTERM grace when the next start rotates writes its last lines into `backend.prev.log` (the descriptor follows the file).
- **Trimming while running:** a log over `LOG_MAX_BYTES` is cut to its newest `LOG_KEEP_BYTES` behind a `[cc <time>: log trimmed, <n> bytes dropped]` line, on a **passive touch** only: the `ensureStarted` fast path (at most once per minute per plugin) and `status()`. There is no timer. The trim works on one open descriptor (never creating a missing file), so a restart rotating the log mid-trim cannot make it touch the new run's file; a child write racing the trim's rewrite can be lost.
- **Limits:** a long-running backend's log can grow without bound between starts while nothing touches it (no proxied request, MCP call or status probe), and by whatever it writes between touches. A backend started by a cc that predates the log file keeps the pipes it was given until it is restarted once from Settings → Plugins; until then its output is lost after a cc restart and it can die on EPIPE.
- **Reading:** `GET /api/plugins/:id/log` ([rest.md](rest.md)); `readyWhen` and `crashTail` are read from the same file.

**Exit records** (`ExitRecord`, `how`):

| `how` | Meaning | `code` / `signal` | `at` |
|---|---|---|---|
| `exit` | a child cc spawned, from its `exit` event (EADDRINUSE retries and stopped children included) | exact | the exit time |
| `gone` | a backend cc did **not** spawn (adopted) found dead | always `null`: cc is not its parent and cannot read its status | when cc noticed |
| `stopped` | cc stopped an adopted backend (no exit event follows) | `null` | when cc stopped it |

`stopRequested` is true when cc asked for the exit (Stop, Restart, Disable, a version switch). For `gone`, the death lies in `(lastAliveAt ?? startedAt, at]`; the reason is normally in `backend.log` (the dying process's last output), which also becomes `crashTail`.

**What detects an adopted backend's death** (the passive touches; each records the death it finds, and adoption, `status()` and the `ensureStarted` fast path also bump in-memory `lastAliveAt` when they find the pid alive — the proxy's upstream-failure hook only records):

- the boot adopt pass: a recorded pid already dead is recorded as `gone` with `lastAliveAt: null` and the row's `crashTail` is the log's last lines (a live record that is merely not adoptable, such as disabled, undiscovered or not answering, is cleared unrecorded);
- `status()` and the proxy's upstream-failure hook;
- the `ensureStarted` fast path, i.e. every proxied request and MCP call: one `kill(pid, 0)`; a dead pid is recorded and the call gets the same `503 crashed` a dead upstream gets.

An idle adopted backend's death is therefore recorded only at the next touch or boot, and `at` can be long after the death. A recycled pid reads alive, so a death can be missed until the next health or port probe or boot.
