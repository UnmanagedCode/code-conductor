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
  - **Mode** — only two modes are exposed: `code` (the CLI's `bypassPermissions` — full power, no per-tool prompts) and `plan` (read-only planning). The CLI's `default` / `acceptEdits` modes auto-deny tool calls in stream-json `--print` (no SDK `canUseTool` callback is registered), and the only way to recover would be to make the model re-emit the entire tool input — pointlessly expensive for anything with a large `content`. We force the choice up front.
  - **Effort** — `low` / `medium` / `high` (default) / `xhigh` / `max`.
  - **Thinking** — `adaptive` (default, model decides) / `enabled` / `disabled`.
  - **Model** — empty for account default, or pick `claude-sonnet-4-6` / `claude-opus-4-7` / `claude-haiku-4-5`.
- **Live conversation view** — streams the assistant's response as it arrives. Renders:
  - **Text** — plain markdown-ish prose, deltas merged in place.
  - **Thinking** — collapsible block. Shows full content from Sonnet/Haiku, or `(thinking redacted by model)` placeholder for Opus 4.7 (which only emits a signature).
  - **Tool use** — block is collapsed by default; the smart one-line summary like `🔧 Bash · ls -la · done` shows the command/key argument inline, and a custom disclosure caret rotates when you tap to expand. Per-tool summary picks the most useful argument (command for Bash, file_path for Edit/Read/Write, pattern for Glob/Grep, url for WebFetch, etc.). **Edit / Write / NotebookEdit** tool calls render as a syntax-coloured **unified diff** (green/red gutters, ±counts header, sticky file-path) once expanded; Write shows a numbered preview of the new file.
  - **Tool result** — truncated at 4 KB with a "show full" button, attached under its matching tool_use.
  - **Sub-agent drill-down** — when Claude uses the `Task` tool, the sub-agent's events stream into a nested mini-conversation rendered inside the outer tool block, with a dashed left border and `↳ sub-agent` label. Tap the Task tool to expand and inspect what the sub-agent did.
  - **Plan mode (`ExitPlanMode`)** — when the model finishes a plan and calls `ExitPlanMode` (the CLI auto-errors it in stream-json mode with `"Exit plan mode?"`), the orchestrator auto-interrupts the turn and renders a green-bordered card titled "Plan ready for approval". The plan body comes from `input.plan` directly, or — when the model wrote the plan to a file under `~/.claude/plans/*.md` first and called `ExitPlanMode` with empty input — the orchestrator reads the most-recent such file and shows its content. The body is rendered as **Markdown** (`public/markdown.js`) with headings, lists, fenced code blocks, inline code, bold/italic, blockquotes, links, and horizontal rules — no `innerHTML` is ever used, links must use safe schemes, and raw HTML in the source is shown as literal text. The card has Approve and Reject buttons plus an optional feedback textarea. **Approve** switches the instance to `code` mode (CLI's `bypassPermissions`) so the model can actually execute the tools the plan calls for, and sends `"I approve the plan. Please proceed with the implementation."` (plus your feedback if provided). **Reject** keeps plan mode active and sends `"I'd like to revise the plan. Refinement notes:\n<feedback>"` so the model can refine.
  - **Interrupt marker scrubbing** — the CLI inserts a trailing `[Request interrupted by user]` (or `…by user for tool use]`) assistant text block whenever a turn is interrupted. When the orchestrator triggered the interrupt itself as part of a flow (`AskUserQuestion`, `ExitPlanMode`), that marker is *stripped* from the conversation so the inline approval / question card stays the conversation's tail. When the user clicks the Interrupt button manually, the marker stays visible as confirmation. The parser tags the block (`isInterruptMarker: true` on the `text_end` event) and the `Instance` decides at emit time based on a `_autoInterruptedThisTurn` flag that's only set when the orchestrator fires the interrupt.
  - **AskUserQuestion** — when the model invokes the `AskUserQuestion` tool, the structured questions/options render as a blue card. The orchestrator immediately sends a `control_request interrupt` so the model can't follow the CLI's auto-error with a confused "the question was dismissed, want me to just ask in plain text?" text response — the question card becomes the conversation's blocking tail. **Multiple questions** render as a tab strip across the top; the active tab's pane shows its options. Each pane has the model's options as buttons plus an **Other:** text field for typing a custom answer (always available, overrides any option pick). A single **Send all answers** button at the bottom enables once every question has an answer and submits them as one consolidated prompt; if the instance somehow isn't idle yet, the answer is queued locally and flushed automatically on the next `status=idle` event.
  - **System notes** — most diagnostic events (per-turn `status:"requesting"`, `rate_limit_event:"allowed"`, hook lifecycle pings, task progress) are filtered out. The ones that remain (`init`, `stderr`, `exit`, `permission_denied`, `compacting`, `spawn_error`, `crashed`, `history_load_error`, non-allowed `rate_limit_event`) render as compact one-line notes inline where they actually occurred — no more shared "SYSTEM" box that silently extends itself across turns.
  - **Turn end** — small footer line with duration / cost / tokens.
- **Composer** — textarea at the bottom. Enter sends, Shift+Enter inserts a newline. The placeholder explains the current state ("turn running — your message will queue", "click Resume", etc.). The text input stays focusable during a running turn so you can queue a follow-up.
- **Controls** — header bar has a 🔔/🔕 notification toggle, a mode dropdown (live switching via `control_request`), Interrupt, and Kill / Resume buttons.
- **Browser notifications** — the 🔔 toggle requests notification permission, then fires a desktop / Android notification whenever any instance's turn finishes while the tab is hidden (errors notify even when visible). On page reload the bell auto-enables itself if permission was already granted in a previous session. Notifications are dispatched through a tiny Service Worker (`public/sw.js`) because mobile Chrome refuses the page-level `new Notification(...)` constructor; tapping a ping focuses the existing tab via `notificationclick` in the SW. Works for background instances you aren't currently viewing — the orchestrator broadcasts a `turn_notification` to all connected WS clients regardless of which instance they're subscribed to.
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
- **`happy-dom`** (dev-only) — used by `tests/rendering.test.mjs` to run the actual conversation renderer against simulated streams and assert what lands in the DOM.
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
- `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_permission_mode","mode":"plan"}}` — switch mode without restarting (e.g. flipping between `plan` and `bypassPermissions`).
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
│   │                         round-trip, history replay, session-metadata write,
│   │                         mode validation (plan / bypassPermissions only),
│   │                         auto-interrupt on user_question / plan_request.
│   ├── parser.js             stream-json line → UI event normalization. Merges
│   │                         deltas by (msgId, blockIdx); emits thinking_redacted
│   │                         when a thinking block closes with only signature_delta;
│   │                         attaches parentToolUseId so sub-agent events can be
│   │                         routed to nested views; emits structured user_question
│   │                         events for AskUserQuestion and plan_request events for
│   │                         ExitPlanMode; flags `[Request interrupted by user]`
│   │                         text blocks via isInterruptMarker for orchestrator-
│   │                         driven scrubbing.
│   ├── projects.js           FS ops on ~/project; cwd encoding for ~/.claude/projects;
│   │                         seeds CLAUDE.md on new projects.
│   ├── routes.js             REST handlers; thin shell over instances + projects.
│   └── wsHub.js              Per-socket subscriptions; snapshot replay; fan-out;
│                             prompt/mode/interrupt/kill via WS; broadcasts
│                             turn_notification to every client on turn_end.
├── public/
│   ├── index.html            Shell layout + new-project / new-instance dialogs +
│   │                         🔔 notification toggle.
│   ├── styles.css            Mobile-friendly dark theme; diff/sub-agent/
│   │                         user-question/plan card styling.
│   ├── app.js                Bootstraps; reactive store; reconnect on WS open;
│   │                         wires notification toggle, user-question submissions,
│   │                         and plan-mode decisions back over WS.
│   ├── ws.js                 Reconnecting WebSocket client with ack-based requests.
│   ├── sidebar.js            Project ▸ instance list with status dots.
│   ├── conversation.js       Ordered message list; sticky-scroll; idempotent by _seq;
│   │                         routes events with parentToolUseId into nested
│   │                         sub-Conversations; dispatches user_question and
│   │                         plan_request to inline card renderers; strips
│   │                         orchestrator-flagged interrupt-marker text blocks.
│   ├── blocks.js             Renderers for text/thinking/tool_use/tool_result/
│   │                         user-question/plan-request; describeToolInput() for
│   │                         collapsed summaries; per-tool body renderers for
│   │                         Edit/Write/NotebookEdit using the diff module.
│   ├── diff.js               Pure-JS Myers' line-diff + diffStats().
│   ├── notifications.js      Notification API wrapper + pure shouldNotify()
│   │                         decision used by both runtime and tests.
│   └── composer.js           Textarea (Enter→send / Shift+Enter→newline).
└── tests/
    ├── run.mjs               Programmatic node:test runner (the Termux node wrapper
    │                         hoists leading --flags into NODE_OPTIONS, which forbids
    │                         --test, so we invoke run() directly).
    ├── fake-claude.mjs       Scenario-driven stand-in for the real CLI. Reads stdin
    │                         JSON lines, emits canned events from a FAKE_CLAUDE_SCENARIO
    │                         file, auto-acks parent-issued control_requests, and
    │                         matches incoming control_response (with optional
    │                         request_id + behavior filter) so scenarios can branch
    │                         on the user's allow/deny choice. Mirrors real claude's
    │                         "silent until first prompt" behavior.
    ├── helpers.mjs           bootServer() sets ephemeral PROJECTS_ROOT/CLAUDE_PROJECTS_ROOT
    │                         + CLAUDE_BIN (or skips for useRealClaude:true).
    ├── fixtures/             Scenario JSONs and a sample session.jsonl.
    ├── parser.test.mjs       Pure-function tests over Parser.handleLine() — including
    │                         parentToolUseId propagation, thinking_redacted,
    │                         AskUserQuestion → user_question emission.
    ├── projects.test.mjs     REST: create/list/sessions; CLAUDE.md seed.
    ├── instances.test.mjs    Lifecycle: spawn → idle, prompt → turn_end, setMode
    │                         round-trip, interrupt, crash + respawn, history
    │                         replay, last-prompt metadata write, single user_echo.
    ├── ws.test.mjs           Subscribe + snapshot + live fan-out; reconnect dedup;
    │                         two-instance concurrency; mode/interrupt over WS;
    │                         turn_notification fan-out to non-subscribers.
    ├── question.test.mjs     AskUserQuestion → user_question UI event end-to-end +
    │                         the orchestrator's auto-interrupt is verified via the
    │                         scenario only completing on interrupt control_request.
    ├── plan.test.mjs         ExitPlanMode → plan_request enriched from ~/.claude/
    │                         plans/*.md → auto-interrupt → result(interrupted).
    ├── interrupt-marker.test.mjs  Confirms [Request interrupted by user] is stripped
    │                         only on auto-interrupt (AskUserQuestion / ExitPlanMode)
    │                         and stays visible when the user clicks Interrupt.
    ├── notifications.test.mjs Pure-unit shouldNotify() decision table.
    ├── diff.test.mjs         Myers' diff: identity, pure add/del, replacement,
    │                         empties, round-trip both sides, stats.
    ├── static.test.mjs       Static asset serving + DOM-free module import.
    ├── blocks.test.mjs       describeToolInput() per-tool summaries.
    ├── rendering.test.mjs    happy-dom-backed DOM tests over the parser →
    │                         conversation rendering pipeline. Catches
    │                         user-visible regressions the parser tests miss
    │                         (e.g. "is the tool command actually visible?").
    └── smoke.real.test.mjs   Opt-in real-claude end-to-end (RUN_REAL_CLAUDE=1) —
                              text reply, Bash tool call shape, AskUserQuestion
                              user_question event shape.
```

### WebSocket protocol

One persistent connection at `ws://127.0.0.1:8787/ws`, multiplexed across instances by `id`.

**Client → server**

| `t` | Fields | Purpose |
|---|---|---|
| `subscribe` | `id`, optional `reqId` | Subscribe to live events for an instance. Triggers a `snapshot` message followed by live `event`s. |
| `unsubscribe` | `id` | Stop receiving events. |
| `prompt` | `id`, `text` | Send a user message. |
| `mode` | `id`, `mode` | Switch permission mode via `control_request set_permission_mode` (only `plan` and `bypassPermissions` are accepted). |
| `interrupt` | `id` | Abort current turn via `control_request interrupt`. |
| `kill` | `id` | SIGTERM the subprocess. |

**Server → client**

| `t` | Fields | Purpose |
|---|---|---|
| `snapshot` | `id`, `status`, `mode`, `sessionId`, `project`, `events[]` | Sent on subscribe; events carry `_seq` for dedup. |
| `event` | `id`, `ev` | Live UI event. See "UI event kinds" below. |
| `status` | `id`, `status`, `sessionId`, `mode` | Status transition (`spawning|idle|turn|exited|crashed`). |
| `ack` | `reqId`, `ok`, `error?` | Reply to a client request that included `reqId`. |
| `turn_notification` | `id`, `project`, `isError`, `stopReason`, `cost` | Lean notification fan-out — broadcast to **every** connected client (not just per-instance subscribers) whenever a turn ends. Lets background-tab listeners ping the OS notification system for instances they aren't currently watching. |
| `instances` / `projects` | — | Hint to re-fetch REST list (no payload). |

**UI event kinds** (`ev.kind`)

Every event carries a `parentToolUseId` (or `null`) — the conversation view routes non-null events into a nested mini-conversation under the matching outer tool block, enabling sub-agent drill-down for `Task`.

`text_delta`, `text_end` (carries `isInterruptMarker:true` when the block content matches the CLI's interrupt-by-user marker), `text_strip` (rewritten from `text_end` by Instance when the orchestrator triggered the interrupt itself, so the marker disappears), `thinking_start`, `thinking_delta`, `thinking_end`, `thinking_redacted`, `tool_use_start`, `tool_use_input_delta`, `tool_use`, `tool_result`, `user_echo`, `system` (with `subtype` — includes `history_replayed` marker), `hook`, `turn_end`, `assistant_message`, `control_response`, `user_question` (`toolUseId`, `questions[]`), `plan_request` (`toolUseId`, `plan`, `planPath`), `raw`. Each event in the ring has a monotonic `_seq` so snapshot + live merge is idempotent.

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
- New instance: `--permission-mode bypassPermissions` (labelled `code` in the UI), `--effort high`, `--thinking adaptive`, no `--model` flag (uses account default).
- Ring buffer: 500 events per instance.
- Control-request timeout: 5 s.
- Kill grace: stdin closed → 2 s → SIGTERM → 5 s → SIGKILL.

### Testing

All tests run via `node tests/run.mjs` (programmatic node:test runner, because the Termux glibc-runner wrapper for node hoists leading `--flags` into `NODE_OPTIONS` and `--test` isn't allowed there).

The default suite uses a **fake-claude** subprocess (`tests/fake-claude.mjs`) injected via `CLAUDE_BIN`. The fake mirrors real claude's behavior: silent on startup until the first stdin message arrives, auto-acks control_requests, and emits scenario JSON from `FAKE_CLAUDE_SCENARIO`. `FAKE_CLAUDE_ARGV_DUMP=<path>` captures the launch argv so tests can assert what flags the orchestrator passes.

The opt-in real-claude smoke (`tests/smoke.real.test.mjs`, gated by `RUN_REAL_CLAUDE=1`) spawns the actual CLI, sends a one-word prompt, and asserts that `system/init`, at least one `text_delta`, and a non-error `turn_end` all arrive. Cleans its session jsonl on exit.

### Known limitations

- **Opus 4.7 thinking is redacted.** The model emits a thinking block but only a `signature_delta`, never the content. The UI shows a `(thinking redacted by model)` placeholder for those blocks. Pick `claude-sonnet-4-6` from the model dropdown if you want to see the thinking stream.
- **AskUserQuestion is answered via the next prompt, not as a real tool result.** In `stream-json --print` mode the CLI auto-errors the AskUserQuestion tool execution before the host can answer it (there's no SDK callback registered). The orchestrator works around this by (a) auto-interrupting the turn the moment the AskUserQuestion tool_use is parsed, so the option card is the conversation's tail and the model can't ramble below it, and (b) rendering the structured options as buttons and feeding the picked answer in as a normal user prompt on the next turn. Functionally fine, but the original tool_result is still an `is_error` and the interrupted turn ends with `stop_reason: "interrupted"`.
- **`--effort` and `--thinking` are spawn-time only.** Switching them mid-session would require respawn + resume. Mode is the only knob that's live-switchable (via `control_request set_permission_mode`).
- **No auth.** Bound to 127.0.0.1 — anyone with shell access on the device can drive it.
- **Best-effort metadata writes.** If the orchestrator crashes between a turn ending and the metadata append, the session jsonl may lack the `last-prompt` line and won't show up in `claude --resume`'s picker. The transcript is still intact and resumable by `claude --resume <sid>`.
- **Notifications need user permission.** The 🔔 toggle works on browsers that expose the Notification API. On mobile Chrome notifications require the Service Worker at `/sw.js` (registered automatically once permission is granted). iOS Safari requires installing the page as a PWA. The toggle reports the current permission state in its tooltip when unavailable.
