# claude-orch-app

A local webapp for orchestrating multiple Claude Code CLI instances across the projects in `~/project/`. Spawn, watch, and interact with several `claude` subprocesses in parallel from a single browser tab.

Designed to run on a Termux phone (single user, localhost-only), but works on any host with Node 22+ and the `claude` CLI on `$PATH`.

```
                  ┌─────────────────┐
                  │  browser tab    │
                  │  (vanilla JS)   │
                  └────────┬────────┘
                       HTTP + WS (:8787)
                  ┌────────┴────────┐
                  │  Node server    │
                  │  express + ws   │
                  └────────┬────────┘
            ┌──────────────┼──────────────┐
            │              │              │
    ┌───────┴─────┐ ┌──────┴──────┐ ┌─────┴───────┐
    │ claude -p   │ │ claude -p   │ │ claude -p   │
    │ (project A) │ │ (project B) │ │ (project C) │
    └─────────────┘ └─────────────┘ └─────────────┘
        stream-json stdin/stdout per instance
```

## Functional overview

### What it does

- **Project list** — sidebar shows every directory under `~/project/`. A `+ New project` button creates a directory and drops a `CLAUDE.md` that imports the workspace-wide one at `~/project/CLAUDE.md`.
- **Spawn instances** — for any project, click `+` to launch a fresh Claude instance, or pick a prior session from the resume dropdown. The new-instance dialog lets you choose:
  - **Mode** — permission mode: `default` / `acceptEdits` / `bypassPermissions` / `plan`.
  - **Effort** — `low` / `medium` / `high` (default) / `xhigh` / `max`.
  - **Thinking** — `adaptive` (default, model decides) / `enabled` / `disabled`.
  - **Model** — empty for account default, or pick `claude-sonnet-4-6` / `claude-opus-4-7` / `claude-haiku-4-5`.
- **Live conversation view** — streams the assistant's response as it arrives. Renders:
  - **Text** — plain markdown-ish prose, deltas merged in place.
  - **Thinking** — collapsible block. Shows full content from Sonnet/Haiku, or `(thinking redacted by model)` placeholder for Opus 4.7 (which only emits a signature).
  - **Tool use** — collapsible block with a smart one-line summary like `🔧 Bash · ls -la · done`. Per-tool summary picks the most useful argument (command for Bash, file_path for Edit/Read/Write, pattern for Glob/Grep, url for WebFetch, etc.).
  - **Tool result** — truncated at 4 KB with a "show full" button, attached under its matching tool_use.
  - **Turn end** — small footer line with duration / cost / tokens.
- **Composer** — textarea at the bottom. Enter sends, Shift+Enter inserts a newline. The placeholder explains the current state ("turn running — your message will queue", "click Resume", etc.). The text input stays focusable during a running turn so you can queue a follow-up.
- **Controls** — header bar has a mode dropdown (live switching via `control_request`), Interrupt, and Kill / Resume buttons.
- **Resume** — picking a prior session loads the persisted transcript from `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` and replays it into the conversation view before the live stream takes over. A `── N prior messages replayed ──` divider separates history from the new turn.
- **Crash recovery** — if a subprocess dies, status flips to `crashed`. The Resume button respawns the same Instance with `--resume <sid>`, preserving the in-memory event ring and conversation.
- **Concurrent instances** — multiple subprocesses run in parallel across projects. The sidebar shows status dots (idle / turn / spawning / crashed) per instance.

### CLAUDE.md conventions

Each project gets a one-line `CLAUDE.md`:

```
@../CLAUDE.md
```

…which imports the workspace-wide `~/project/CLAUDE.md`. That file currently encodes git hygiene rules — init a repo if missing, commit after every changeful turn with a concise subject + short *why* summary, maintain `.gitignore`, never push or bypass hooks.

## Quick start

```bash
cd ~/project/claude-orch-app
npm install            # express, ws
npm start              # http://127.0.0.1:8787
npm test               # run the integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs the opt-in real-claude smoke test
```

Open `http://127.0.0.1:8787` in a browser on the same device. Bound to localhost only — no auth.

## Technical detail

### Stack

- **Node 22+** (uses `node:test`, top-level await, `crypto.randomUUID`).
- **`express`** for the small REST surface and static asset serving.
- **`ws`** for a single `/ws` WebSocket multiplexed across all instance subscriptions.
- **Vanilla HTML/CSS/JS** in `public/` — no build step. Modules load via native `<script type="module">`.
- **No DB** — projects live as directories under `~/project/`, sessions live as `~/.claude/projects/<encoded-cwd>/*.jsonl`.

### Subprocess protocol

Each Instance spawns:

```bash
claude -p \
  --input-format=stream-json --output-format=stream-json \
  --verbose --include-partial-messages --include-hook-events \
  --permission-mode <mode> --effort <effort> --thinking <thinking> \
  [--model <name>] \
  --session-id <fresh-uuid> | --resume <existing-uuid>
```

The CLI then reads JSON lines on stdin and emits JSON lines on stdout. Inbound message types we send:

- `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}` — new user turn.
- `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}` — switch mode without restarting.
- `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}` — abort the current turn.
- `{"type":"keep_alive"}` — heartbeat.

Outbound message types we parse:

| `type` | Meaning |
|---|---|
| `system` + `subtype:"init"` | First-event-of-the-turn (note: only arrives bundled with the first turn's response, not at startup). Carries `session_id`, `model`, `tools`, `permissionMode`. |
| `stream_event` | SSE deltas from `--include-partial-messages` — `text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta`, plus the `message_start` / `content_block_start` / `content_block_stop` / `message_stop` framing. The primary live-rendering feed. |
| `assistant` | Final reconciled assistant message for each turn. Used for replay; deltas already drove the live UI. |
| `user` | Inbound `tool_result` blocks from tool execution. |
| `result` | Turn-end marker with `duration_ms`, `usage`, `total_cost_usd`, `stop_reason`, `is_error`. |
| `hook_event` | Lifecycle hooks (PreToolUse, PostToolUse, etc.) — rendered as small dimmed lines. |
| `control_response` | Our reply to control_requests we issued. |

### Component layout

```
claude-orch-app/
├── server.js                 Express + ws boot, mounts routes, binds 127.0.0.1:8787
├── package.json              "type": "module"; deps: express, ws
├── CLAUDE.md                 @../CLAUDE.md
├── src/
│   ├── instances.js          Instance class + InstanceManager. Subprocess lifecycle,
│   │                         ring buffer (last 500 UI events), control_request
│   │                         round-trip, history replay, session-metadata write.
│   ├── parser.js             stream-json line → UI event normalization. Merges
│   │                         deltas by (msgId, blockIdx); emits thinking_redacted
│   │                         when a thinking block closes with only signature_delta.
│   ├── projects.js           FS ops on ~/project; cwd encoding for ~/.claude/projects;
│   │                         seeds CLAUDE.md on new projects.
│   ├── routes.js             REST handlers; thin shell over instances + projects.
│   └── wsHub.js              Per-socket subscriptions; snapshot replay; fan-out;
│                             prompt/mode/interrupt/kill via WS.
├── public/
│   ├── index.html            Shell layout + new-project / new-instance dialogs.
│   ├── styles.css            Mobile-friendly dark theme.
│   ├── app.js                Bootstraps; reactive store; reconnect on WS open.
│   ├── ws.js                 Reconnecting WebSocket client with ack-based requests.
│   ├── sidebar.js            Project ▸ instance list with status dots.
│   ├── conversation.js       Ordered message list; sticky-scroll; idempotent by _seq.
│   ├── blocks.js             Renderers for text/thinking/tool_use/tool_result;
│   │                         describeToolInput() for collapsed summaries.
│   └── composer.js           Textarea (Enter→send / Shift+Enter→newline).
└── tests/
    ├── run.mjs               Programmatic node:test runner (the Termux node wrapper
    │                         hoists leading --flags into NODE_OPTIONS, which forbids
    │                         --test, so we invoke run() directly).
    ├── fake-claude.mjs       Scenario-driven stand-in for the real CLI. Reads stdin
    │                         JSON lines, emits canned events from a FAKE_CLAUDE_SCENARIO
    │                         file, auto-acks control_requests. Mirrors real claude's
    │                         "silent until first prompt" behavior.
    ├── helpers.mjs           bootServer() sets ephemeral PROJECTS_ROOT/CLAUDE_PROJECTS_ROOT
    │                         + CLAUDE_BIN (or skips for useRealClaude:true).
    ├── fixtures/             Scenario JSONs and a sample session.jsonl.
    ├── parser.test.mjs       Pure-function tests over Parser.handleLine().
    ├── projects.test.mjs     REST: create/list/sessions; CLAUDE.md seed.
    ├── instances.test.mjs    Lifecycle: spawn → idle, prompt → turn_end, setMode
    │                         round-trip, interrupt, crash + respawn, history
    │                         replay, last-prompt metadata write, single user_echo.
    ├── ws.test.mjs           Subscribe + snapshot + live fan-out; reconnect dedup;
    │                         two-instance concurrency; mode/interrupt over WS.
    ├── static.test.mjs       Static asset serving + DOM-free module import.
    ├── blocks.test.mjs       describeToolInput() per-tool summaries.
    └── smoke.real.test.mjs   Opt-in real-claude end-to-end (RUN_REAL_CLAUDE=1).
```

### WebSocket protocol

One persistent connection at `ws://127.0.0.1:8787/ws`, multiplexed across instances by `id`.

**Client → server**

| `t` | Fields | Purpose |
|---|---|---|
| `subscribe` | `id`, optional `reqId` | Subscribe to live events for an instance. Triggers a `snapshot` message followed by live `event`s. |
| `unsubscribe` | `id` | Stop receiving events. |
| `prompt` | `id`, `text` | Send a user message. |
| `mode` | `id`, `mode` | Switch permission mode via `control_request set_permission_mode`. |
| `interrupt` | `id` | Abort current turn via `control_request interrupt`. |
| `kill` | `id` | SIGTERM the subprocess. |

**Server → client**

| `t` | Fields | Purpose |
|---|---|---|
| `snapshot` | `id`, `status`, `mode`, `sessionId`, `project`, `events[]` | Sent on subscribe; events carry `_seq` for dedup. |
| `event` | `id`, `ev` | Live UI event. See "UI event kinds" below. |
| `status` | `id`, `status`, `sessionId`, `mode` | Status transition (`spawning|idle|turn|exited|crashed`). |
| `ack` | `reqId`, `ok`, `error?` | Reply to a client request that included `reqId`. |
| `instances` / `projects` | — | Hint to re-fetch REST list (no payload). |

**UI event kinds** (`ev.kind`)

`text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `thinking_redacted`, `tool_use_start`, `tool_use_input_delta`, `tool_use`, `tool_result`, `user_echo`, `system` (with `subtype`), `hook`, `turn_end`, `assistant_message`, `control_response`, `raw`. Each event in the ring has a monotonic `_seq` so snapshot + live merge is idempotent.

### REST endpoints

| Method | Path | Body / Returns |
|---|---|---|
| `GET` | `/api/projects` | `[{name, path, instanceIds[]}]` |
| `POST` | `/api/projects` | `{name}` → `{name, path}`. Validates `^[a-zA-Z0-9._-]+$`. Writes `CLAUDE.md` with `@../CLAUDE.md`. |
| `GET` | `/api/projects/:name/sessions` | `[{sessionId, firstPrompt, mtime, size}]` |
| `POST` | `/api/instances` | `{project, mode?, effort?, thinking?, model?, resume?}` → instance summary |
| `GET` | `/api/instances` | `[{id, project, sessionId, status, mode, effort, thinking, model, pid}]` |
| `POST` | `/api/instances/:id/respawn` | `{id, sessionId}` — uses `--resume lastSessionId` |
| `DELETE` | `/api/instances/:id` | `{ok: true}` — SIGTERM + remove |

### Instance lifecycle

```
       create
         │
         ▼
   ┌──────────┐    proc alive + stdin    ┌──────┐    prompt sent    ┌──────┐
   │ spawning │ ───────────────────────► │ idle │ ────────────────► │ turn │
   └──────────┘                          └──┬───┘ ◄──── turn_end ───┴──────┘
         │                                  │
         │ load-history fails               │ subprocess exits
         ▼                                  ▼
                                       ┌───────────┐
                                       │ crashed / │
                                       │  exited   │
                                       └─────┬─────┘
                                             │ respawn  --resume <sid>
                                             ▼
                                          (back to spawning)
```

When **resuming**, the spawn awaits `loadHistory(sessionId)` before flipping to `idle`. That reads the persisted `*.jsonl`, replays each user/assistant line as UI events into the ring buffer, and emits a `system/history_replayed` marker so the UI can render a divider.

When a **turn ends** or the **mode changes**, two metadata lines are appended to the session jsonl so `claude --resume` from the shell can discover the session in its interactive picker:

```json
{"type":"last-prompt","leafUuid":"<uuid>","sessionId":"<sid>"}
{"type":"permission-mode","permissionMode":"<mode>","sessionId":"<sid>"}
```

### Defaults

- Bind: `127.0.0.1:8787` (override with `HOST` / `PORT` env vars).
- New instance: `--permission-mode default` (UI defaults the dialog to `bypassPermissions`), `--effort high`, `--thinking adaptive`, no `--model` flag (uses account default).
- Ring buffer: 500 events per instance.
- Control-request timeout: 5 s.
- Kill grace: stdin closed → 2 s → SIGTERM → 5 s → SIGKILL.

### Testing

All tests run via `node tests/run.mjs` (programmatic node:test runner, because the Termux glibc-runner wrapper for node hoists leading `--flags` into `NODE_OPTIONS` and `--test` isn't allowed there).

The default suite uses a **fake-claude** subprocess (`tests/fake-claude.mjs`) injected via `CLAUDE_BIN`. The fake mirrors real claude's behavior: silent on startup until the first stdin message arrives, auto-acks control_requests, and emits scenario JSON from `FAKE_CLAUDE_SCENARIO`. `FAKE_CLAUDE_ARGV_DUMP=<path>` captures the launch argv so tests can assert what flags the orchestrator passes.

The opt-in real-claude smoke (`tests/smoke.real.test.mjs`, gated by `RUN_REAL_CLAUDE=1`) spawns the actual CLI, sends a one-word prompt, and asserts that `system/init`, at least one `text_delta`, and a non-error `turn_end` all arrive. Cleans its session jsonl on exit.

### Known limitations

- **Opus 4.7 thinking is redacted.** The model emits a thinking block but only a `signature_delta`, never the content. The UI shows a `(thinking redacted by model)` placeholder for those blocks. Pick `claude-sonnet-4-6` from the model dropdown if you want to see the thinking stream.
- **`--effort` and `--thinking` are spawn-time only.** Switching them mid-session would require respawn + resume. Mode is the only knob that's live-switchable (via `control_request set_permission_mode`).
- **No auth.** Bound to 127.0.0.1 — anyone with shell access on the device can drive it.
- **Best-effort metadata writes.** If the orchestrator crashes between a turn ending and the metadata append, the session jsonl may lack the `last-prompt` line and won't show up in `claude --resume`'s picker. The transcript is still intact and resumable by `claude --resume <sid>`.
