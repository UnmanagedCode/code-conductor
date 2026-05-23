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

- **Project list** — sidebar shows every directory under `~/project/`. A `+ New project` button creates a directory and drops a `CLAUDE.md` that imports the workspace-wide one at `~/project/CLAUDE.md`. Worktree-owned directories (those carrying a `.claude-orch-app/` dotfolder — or the legacy `.claude-orch-worktree.json` marker for worktrees created before the dotfolder reorg; see "Isolated worktrees" below) are hidden from the project list and surfaced under their parent project instead. The `×` next to each project row deletes the entire project (after a typed-name confirmation prompt) — cascades through every attached instance + worktree (kills + removes them) and then `rm -rf`s the project directory itself; `~/.claude/projects/<encoded>/` session jsonls are left in place since they may still be referenced by the standalone `claude` CLI.
- **Isolated worktrees** — for any project that's a git repo, the new-instance dialog has a "Run in isolated git worktree" checkbox. Ticking it triggers `git worktree add ../<project>_worktree_<short-id> -b claude-orch/<short-id> <currentSha>` against the parent repo and spawns the Claude instance with `cwd` pointing at that fresh worktree. The orchestrator captures **the parent's current branch + SHA at creation time** as the rebase-back target, so you can spawn an experiment off any branch (not just `main`) and have a defined place to land it later. Each project has a default-collapsed **"Worktrees (N)"** subnode in the sidebar; from there you can spawn / resume agents into existing worktrees or remove them (refused if there's a live instance or uncommitted work, with a `force=1` override). Worktrees show an amber pill next to the worktree id whenever their branch diverges from its base: `↑N` when there are commits ahead waiting to be fast-forwarded into the parent, `↓M` when the worktree is purely behind (Sync will fast-forward), or `↑N ↓M` when both — signalling that a rebase is needed before the FF can land cleanly. Worktrees survive instance death — the same worktree can host multiple sequential agent runs.
  - **Rebase back into the parent** — when the agent in a worktree has finished, two header buttons drive the merge-back as two distinct clicks:
    - **Sync** brings the worktree's branch up to date with its parent's base branch, picking the cheapest path. Already in sync → no-op. Purely behind with a clean tree → server-side `git merge --ff-only <baseBranch>` inside the worktree. Diverged, or purely behind but dirty → sends the agent a templated prompt asking it to commit any work, run `git rebase <baseBranch>`, ask the user (via `AskUserQuestion`) before non-trivial conflict resolutions, and reply with the line `REBASE_DONE` so you can click Merge next. The orchestrator never runs `git rebase` itself — leaving conflict-resolution decisions to a Claude instance + the human in the loop avoids silent wrong choices.
    - **Merge** runs `git merge --no-ff --no-edit <worktreeBranch>` on the parent repo — always creating a merge commit (even when a fast-forward would be possible) so each worktree's contribution stays visible as a branch in the parent's `git log --graph` and can be reverted as a single commit via `git revert -m 1 <mergeSha>`. The commit message is git's default (`Merge branch 'claude-orch/<id>'`). Refuses (with an inline reason rather than a server error) if the worktree is still behind the parent ("click Sync first" — conflicts are better resolved inside the worktree where the agent can help), the parent is on a different branch than the captured base, or has uncommitted changes.
- **Sessions are the canonical thing** — instances and persisted sessions are unified into a single "Sessions" list per project (and per worktree). Each row shows a status dot (live → idle/turn/spawning/crashed colour, otherwise a dim outlined `○`), a "time ago" stamp, and the session's first-prompt snippet — sorted newest-first. **Click a row**: if a live instance is attached → focus it; otherwise → resume it (`POST /api/instances` with `--resume <sid>`, into the matching cwd including worktree). Live instances whose `.jsonl` doesn't exist yet (just spawned, no first turn) appear as synthetic `(new session)` rows. The subnode header is `"Sessions (N) · K live · last <ago>"` and defaults to expanded; manual collapse sticks per-subnode.
- **Spawn a new session** — for any project, click `+` to launch a fresh Claude subprocess and a new sessionId. Worktrees get their own `+` button that spawns into the worktree. The new-session dialog lets you choose:
  - **Mode** — three options:
    - **`plan`** (default) — read-only planning. The CLI's plan mode denies destructive tools; the model proposes a plan and exits via `ExitPlanMode` so you can Approve / Reject.
    - **`ask`** — full power but every destructive tool (`Edit` / `Write` / `NotebookEdit` / `Bash`) goes through an interactive **Allow / Deny** card before it runs. Implemented via a `PreToolUse` HTTP hook registered through `--settings` at spawn — the hook POSTs the envelope back to the orchestrator, which holds the response open while the UI shows the card. The user's click resolves the response with `permissionDecision: "allow"` or `"deny"`, and the CLI then either runs the tool with the original `tool_use_id` (no regeneration of large `content` fields) or auto-denies it. Reads (`Read` / `Glob` / `Grep` / `WebFetch` / `WebSearch`) are not gated.
    - **`code`** — full power, no per-tool prompts. CLI's `bypassPermissions`.
    The CLI's `default` / `acceptEdits` modes are not exposed because in stream-json `--print` (no SDK `canUseTool` callback) they auto-deny tool calls and the only way to recover would be to make the model re-emit the entire tool input.
  - **Effort** — `low` / `medium` / `high` (default) / `xhigh` / `max`.
  - **Thinking** — `adaptive` (default, model decides) / `enabled` / `disabled`.
  - **Model** — empty for account default, or pick `claude-sonnet-4-6` / `claude-opus-4-7` / `claude-haiku-4-5`.
  - **Temp session** — checkbox. When ticked, the session's persisted jsonl (and any sibling `subagents/` dir) is deleted from `~/.claude/projects/<encoded-cwd>/` when the subprocess exits, and the orchestrator skips its `last-prompt` / `permission-mode` metadata appends during the run. The mode dropdown auto-flips to `code` (still re-pickable). The conversation header shows a small `TEMP` pill so it's obvious the session won't be saved. Worktrees are untouched — only the jsonl is cleaned up.
  - **Debug mode** — checkbox. When ticked, the orchestrator mirrors the raw CLI traffic to `<cwd>/.claude-orch-app/debug/<instance-id>/`: `claude-stdin.jsonl` (every JSON line we send to the CLI), `claude-stdout.jsonl` (every line the CLI emits, pre-parser), `claude-stderr.log` (anything on stderr), and `meta.json` (instance options, model, full CLI argv, spawn timestamp). Files are append-mode and stay on disk after the session ends, so they can be inspected or attached to a bug report verbatim. The header shows a `DEBUG` pill. Safe to share back to a maintainer — directory is under `.gitignore` so it won't accidentally land in a commit. Best-effort: if the dir can't be created (read-only filesystem, etc.) the spawn still proceeds with debug silently disabled.
- **Live conversation view** — streams the assistant's response as it arrives. Consecutive assistant activity (multiple tool calls, each technically its own CLI-level turn with its own `msgId`) is grouped into a single bordered "assistant" envelope with one role label, rather than minting a new box per action; the envelope closes when a real user action lands (user echo, structured-question card, plan-request card, permission-request card, or history-replay divider). The same grouping applies inside the sub-agent drill-down. Renders:
  - **Text** — streams in as plain text node deltas (no flicker, no per-delta DOM churn); on `text_end` the block re-renders through the shared `public/markdown.js` parser so headings, lists, fenced code, inline `code`, **bold**, *italic*, blockquotes, explicit `[text](url)` links, and bare `http(s)://…` URLs all become rendered DOM. URL autolinking trims trailing sentence punctuation, accepts URLs wrapped in `**…**`, and skips non-`http(s)` schemes (no `javascript:` anchors).
  - **Thinking** — collapsible block when the model streams thinking content (Sonnet/Haiku). When the model emits only a signature (Opus 4.7), renders as a single non-expandable `thinking (redacted)` line instead — no disclosure caret, since there's nothing to reveal.
  - **Tool use** — block is collapsed by default; the smart one-line summary like `🔧 Bash · ls -la · done` shows the command/key argument inline, and a custom disclosure caret rotates when you tap to expand. Per-tool summary picks the most useful argument (command for Bash, file_path for Edit/Read/Write, pattern for Glob/Grep, url for WebFetch, etc.). **Edit / Write / NotebookEdit** tool calls render as a syntax-coloured **unified diff** (green/red gutters, ±counts header, sticky file-path) once expanded; Write shows a numbered preview of the new file. For every other tool, the raw-JSON input is wrapped in its own default-collapsed `↪ tool_input` block (mirroring `↪ tool_result`), so expanding the outer block doesn't blast a multi-line JSON dump.
  - **Tool result** — truncated at 4 KB with a "show full" button, attached under its matching tool_use.
  - **Sub-agent drill-down** — when Claude uses the `Task` tool, the sub-agent's events stream into a nested mini-conversation rendered inside the outer tool block, with a dashed left border and `↳ sub-agent` label. Tap the Task tool to expand and inspect what the sub-agent did.
  - **Plan mode (`ExitPlanMode`)** — when the model finishes a plan and calls `ExitPlanMode`, a `PreToolUse` hook registered via `--settings` cleanly denies the tool with a "wait for the user" reason. The model receives that as an `is_error: true` tool_result and ends the turn naturally — no interrupt, no `[Request interrupted by user]` marker. The orchestrator renders a green-bordered card titled "Plan ready for approval". The plan body comes from `input.plan` directly, or — when the model wrote the plan to a file under `~/.claude/plans/*.md` first and called `ExitPlanMode` with empty input — the orchestrator reads the most-recent such file and shows its content. The body is rendered as **Markdown** (`public/markdown.js`) with headings, lists, fenced code blocks, inline code, bold/italic, blockquotes, links, and horizontal rules — no `innerHTML` is ever used, links must use safe schemes, and raw HTML in the source is shown as literal text. The card has Approve and Reject buttons plus an optional feedback textarea. **Approve** switches the instance to `code` mode (CLI's `bypassPermissions`) so the model can actually execute the tools the plan calls for, and sends `"I approve the plan. Please proceed with the implementation."` (plus your feedback if provided). **Reject** keeps plan mode active and sends `"I'd like to revise the plan. Refinement notes:\n<feedback>"` so the model can refine. The header ⋮ overflow menu also carries an **📋 Auto-approve plans: on / off** toggle (alongside Debug) — when on, subsequent `ExitPlanMode` calls render a non-interactive "auto-approved" card and fire the same approval flow without waiting for a click. Per-instance, session-local (cleared on full page reload).
  - **AskUserQuestion** — when the model invokes the `AskUserQuestion` tool, the same `PreToolUse` hook denies it cleanly. The model receives an `is_error: true` tool_result with the deny reason and ends the turn naturally — no interrupt, no marker. The orchestrator renders a blue card with the structured questions/options. **Multiple questions** render as a tab strip across the top; the active tab's pane shows its options. Each pane has the model's options as buttons plus a context-sensitive text field: before any option is picked it's the **Other:** field for a free-form custom answer (overrides any option pick), and once an option is picked the same field becomes **Add a note (optional)** that attaches to the answer as `Label — note`. Typed text persists across the role flip (picking and un-picking an option doesn't clear the input). A single **Send all answers** button at the bottom enables once every question has an answer and submits them as one consolidated prompt; if the instance somehow isn't idle yet, the answer is queued locally and flushed automatically on the next `status=idle` event.
  - **Ask mode (`permission_request`)** — in `ask` mode the CLI hits the orchestrator's `POST /api/instances/:id/hook-callback` before every `Edit` / `Write` / `NotebookEdit` / `Bash`. The orchestrator surfaces a `permission_request` UI event over WS; the frontend renders a purple-bordered card with the tool name, a one-line argument summary, and a full **diff / Write preview / NotebookEdit body** of what's about to run. **Allow** sends `{t:"hook_decision", id, toolUseId, allow:true}` over WS, which resolves the held-open HTTP response with `permissionDecision:"allow"` — the CLI proceeds with the same `tool_use_id`, no model regeneration. **Deny** does the inverse with `permissionDecision:"deny"`. A `permission_resolved` follow-up event flips the card to ✓ allowed / ✗ denied for any tab subscribed to the same instance. Server holds the response open for up to 540 s; on timeout the response resolves deny with reason "user did not respond in time".
  - **System notes** — most diagnostic events (per-turn `status:"requesting"`, `rate_limit_event:"allowed"`, hook lifecycle pings, task progress) are filtered out. The ones that remain (`init`, `stderr`, `exit`, `permission_denied`, `compacting`, `spawn_error`, `crashed`, `history_load_error`, non-allowed `rate_limit_event`) render as compact one-line notes inline where they actually occurred — no more shared "SYSTEM" box that silently extends itself across turns.
  - **Turn end** — small footer line with duration / cost / tokens.
- **Task panel** — a compact strip just above the composer that mirrors the agent's `TaskCreate` / `TaskUpdate` tool calls. Each row shows a marker (`○` pending, `▶` in progress, `✓` completed), the task subject (or the present-continuous `activeForm` while in progress — "Refactoring X"), and a `Tasks · K/N done` header. The panel is per-active-instance; switching sessions swaps in that session's tracker. It hides itself once **every** task is in `completed` state (or none exist). Tasks are grouped into **batches**: as long as at least one is still pending or in progress, the whole group (including its completed members) stays visible. When the model creates a *new* task after a previous batch finished, the historical ✓s are dropped and the panel comes back fresh — only the new in-flight batch is shown. Snapshot replay rebuilds the state deterministically, so reconnecting in the middle of a long task run shows the live progress, not an empty panel.
- **Footer status bar** — a thin always-visible row pinned at the bottom of the chat pane (between the task panel and the composer). The **right side** hosts the **ctx chip** (see below) so a filled `ctx N% · 245k/1M` readout doesn't wrap the header onto a third line on mobile. The **left side** is the **turn-in-progress indicator** — a pulsing green dot + animated `Claude is working…` ellipsis — visible only while the active instance's status is `turn`, hidden in `idle` / `spawning` / `crashed` / `exited`. Respects `prefers-reduced-motion` (working indicator stays visible but stops animating). The whole bar collapses when no instance is selected.
- **Composer** — textarea at the bottom. Enter sends, Shift+Enter inserts a newline. The placeholder explains the current state ("turn running — your message will queue", "click Resume", etc.). The text input stays focusable during a running turn so you can queue a follow-up. **Attachments**: a `+` button next to Send opens a file picker; you can also paste (handy for clipboard screenshots) or drag-and-drop files onto the composer. Each attachment shows as a chip with a thumbnail (images) or filename + size (other files); the `×` removes it. Files are capped at 10 MB each; sent on submit. Every attachment is saved to `<worktree>/.claude-orch-app/attachments/<timestamp>-<name>` and the user message gets a single `Attached file: \`<path>\`` text block per attachment — **no inline base64**. Claude views images (and reads other files) on demand via its `Read` tool, which means the bytes only cost tokens the turn the model actually looks at them, not every subsequent turn. The user's own message bubble still shows the thumbnail: live echoes paint from the in-memory base64, transcript replays fetch via `GET /api/instances/:id/attachments/<filename>`. The dotfolder is auto-added to the worktree's local `.git/info/exclude` so it doesn't surface as untracked clutter.
- **Context-usage chip** — a `ctx N% · 245k/1M` chip pinned to the right of the footer status bar (above the composer), always visible while an instance is selected. The `N%` is the latest agent-loop step's prompt size (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`) as a fraction of the model's context window, so it answers "how close are we to compaction?" at a glance. Updates **live mid-turn** — every `message_start` from the CLI's stream-json carries the cumulative input-side counts, and a long multi-tool turn fires one per loop step, so the chip ticks up as tool results stack into context rather than waiting for the final `result`. Colour-graded green / amber / red across 50% / 80% thresholds, muted `ctx —` until the first message_start lands. Tapping the chip toggles a popover with **session totals** — turn count, accumulated duration, total cost, uncached input tokens, output tokens, cache reads (with hit ratio), and cache creation tokens. The context-window-size lookup is hardcoded per model (`claude-opus-4-7[1m]` → 1M, everything else → 200k by default).
- **Controls** — header bar has a mode dropdown (live switching via `control_request`), a single context-aware stop button (labelled **Interrupt** while a turn is running, **Kill** otherwise — with a confirm prompt in the kill case), and a **Resume** button that takes its place when the instance has exited / crashed.
- **Browser notifications** — a 🔔/🔕 toggle pinned in the sidebar header (next to the `claude-orch` title) since the preference is global, not per-instance. Tapping it requests notification permission, then fires a desktop / Android notification whenever any instance's turn finishes while the tab is hidden (errors notify even when visible). On page reload the bell auto-enables itself if permission was already granted in a previous session. Notifications are dispatched through a tiny Service Worker (`public/sw.js`) because mobile Chrome refuses the page-level `new Notification(...)` constructor; tapping a ping focuses the existing tab via `notificationclick` in the SW. Works for background instances you aren't currently viewing — the orchestrator broadcasts a `turn_notification` to all connected WS clients regardless of which instance they're subscribed to.
- **Resume** — same Sessions subnode as above. Clicking a non-live row spawns an instance with `--resume <sessionId>` against the matching cwd. Resumes default to `code` mode (CLI `bypassPermissions`) rather than `plan`, on the assumption that a resume is continuing real work; effort/thinking use the orchestrator defaults. All three are adjustable from the header dropdown after the resume lands. The orchestrator refuses to resume into a session already attached to a running instance (`409 "session … already attached"`). On resume the persisted transcript from `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` is replayed into the conversation view before the live stream takes over, with a `── N prior messages replayed ──` divider separating history from the new turn.
- **Delete a session** — each session row has an `×` (revealed on hover) that deletes the persisted `*.jsonl` after a confirm. Refused with a `409` if a live instance is still attached; the dialog then offers to kill the instance and delete anyway (`?force=1`). The worktree-scoped variant deletes from the worktree's own encoded session dir, not the parent project's.
- **Crash recovery** — if a subprocess dies, status flips to `crashed`. The Resume button respawns the same Instance with `--resume <sid>`, preserving the in-memory event ring and conversation.
- **Session anchor in the URL** — selecting an instance sets `#session=<sessionId>` on the URL (via `history.replaceState`, so the back button isn't polluted with one entry per click). On the first WebSocket connect after page load, the bootstrap finds the live instance whose `sessionId` matches the anchor and selects it automatically. If no live instance owns the anchor (server restart, killed instance, etc.) the orchestrator looks the sessionId up on disk via `GET /api/sessions/:sid/locate` and auto-resumes it into the matching cwd — worktree-aware, so a worktree-owned session lands back in its worktree. A `--resume` spawn doesn't call the model until you send a prompt, so the auto-resume costs zero API tokens. The only failure mode is an anchor that names a session whose jsonl has since been deleted — in that case the stale anchor is silently cleared and the user lands on the empty placeholder, identical to a fresh visit. The sessionId is used (not the transient instance id) because it survives crash/respawn cycles.
- **Concurrent sessions** — multiple subprocesses run in parallel across projects + worktrees. The sidebar's Sessions subnodes show a status dot per row.
- **Restart server button** — a `⟲ Restart server` button pinned at the bottom of the sidebar self-respawns the orchestrator process. POSTs `/api/admin/restart`; the server immediately responds `202`, spawns a detached replacement (`process.execPath` + same argv/env/cwd), and exits. The new process retries the `listen` on `EADDRINUSE` while the kernel releases the old socket. After firing the POST the frontend waits 800 ms (to be sure the old server has actually exited), then polls `GET /api/projects` with `cache:'no-store'` until the new server answers `200`, then calls `location.reload()` — so any frontend-asset changes (HTML/CSS/JS) get re-fetched, not just the WebSocket reconnected against a still-cached page. After the reload, the anchor-auto-resume path (see "Session anchor in the URL" above) kicks in and the previously-active conversation is re-spawned with `--resume <sid>` into its original cwd, so the user lands back where they were rather than on the empty placeholder.

### CLAUDE.md conventions

Each project gets a one-line `CLAUDE.md`:

```
@../CLAUDE.md
```

…which imports the workspace-wide `~/project/CLAUDE.md`. That file currently encodes git hygiene rules — init a repo if missing, commit after every changeful turn with a concise subject + short *why* summary, maintain `.gitignore`, never push or bypass hooks.

### MCP interface

The orchestrator's verbs are also exposed as an [MCP](https://modelcontextprotocol.io/) server mounted on the same port at `POST /mcp` (Streamable HTTP, JSON-RPC 2.0). Any Claude session can drive the orchestrator directly — list / spawn / kill instances, send prompts to other live sessions, read their transcripts, create and merge worktrees, etc. Useful for letting one agent supervise or fan out work across several others.

**Auto-registered on every spawn** — no setup required. The orchestrator passes `--mcp-config '{"mcpServers":{"claude-orch":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}'` to every Claude subprocess, so the `mcp__claude-orch__*` tools are available immediately without a prior `claude mcp add` step. The server name is fixed at `claude-orch` because the tool-name prefix is bound to it. To opt out (e.g. to neutralise the Claude-spawning-Claude recursion footgun described in [Known limitations](#known-limitations)), set `ORCH_DISABLE_MCP_AUTOREGISTER=1` on the orchestrator's environment before `npm start`.

Available tools:

- **Read:** `list_projects`, `list_instances`, `list_sessions`, `list_worktrees`, `locate_session` (find which project / worktree owns a sessionId by probing on-disk jsonls), `get_transcript`, `get_last_message` (joined text of the most recent assistant message, plus structured blocks), `project_status` (branch, HEAD, dirty lines, recent commits, top-level files, and — for worktrees — mergeStatus + diffStat vs base), `read_file` (path-traversal-guarded read of a project- or worktree-relative file).
- **Create:** `create_project` (`{name, gitInit?}` — seeds `CLAUDE.md` with `@../CLAUDE.md`).
- **Spawn / drive:** `spawn_instance`, `send_prompt` (optional `wait:true` blocks until `turn_end`), `wait_for_idle` (default 10 min, matching `send_prompt`'s wait cap), `set_mode`, `interrupt_turn`, `kill_instance`, `respawn_instance`
- **Worktrees:** `create_worktree`, `delete_worktree`, `sync_worktree`, `merge_worktree` (takes either `instanceId` *or* `{project, worktreeName}` — the latter form works after the attached instance has been killed)

No auth — same localhost-only posture as the REST surface. See [Known limitations](#known-limitations) for the Claude-spawning-Claude recursion caveat.

## Quick start

```bash
cd ~/project/claude-orch-app
npm install            # express, ws
npm start              # http://127.0.0.1:8787
npm test               # run the integration suite (node:test)
RUN_REAL_CLAUDE=1 npm test   # also runs the opt-in real-claude smoke test
```

Open `http://127.0.0.1:8787` in a browser on the same device. Bound to localhost only — no auth.

For headless visual debugging via Playwright + Termux Chromium, see [`debug/README.md`](./debug/README.md). It's a separate, opt-in setup with its own `package.json`, not wired into the main test suite.

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
  --allow-dangerously-skip-permissions \
  --permission-mode <plan|bypassPermissions> --effort <effort> --thinking <thinking> \
  --settings '{"hooks":{"PreToolUse":[…]}}' \
  --mcp-config '{"mcpServers":{"claude-orch":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}' \
  [--model <name>] \
  --session-id <fresh-uuid> | --resume <existing-uuid>
```

`--allow-dangerously-skip-permissions` is passed at spawn even when the instance starts in `plan` mode — without it the CLI rejects any later runtime `set_permission_mode bypassPermissions` (the plan-approve flow) with *"session was not launched with --dangerously-skip-permissions"*. The flag only *permits* the switch; it doesn't activate bypass by itself.

`--settings` carries an inline JSON object (a single CLI string, no settings file on disk) that registers two `PreToolUse` hooks per instance:

1. **`AskUserQuestion|ExitPlanMode`** — a `command` hook running `printf` that returns a static deny with reason *"Awaiting user input via the orchestrator UI"*. Replaces the older auto-interrupt + marker-scrub plumbing: the model receives an `is_error: true` tool_result, emits a short "Waiting for your response." text block, and ends the turn naturally — no `control_request interrupt`, no `[Request interrupted by user]` marker.
2. **`Edit|Write|NotebookEdit|Bash`** — an `http` hook pointing at `http://127.0.0.1:<port>/api/instances/<id>/hook-callback` with a 660 s timeout. The orchestrator-side endpoint auto-allows when the instance is not in `ask` mode (so the hook is harmless in plan/code), or otherwise holds the response open and surfaces a `permission_request` UI event. A WS `hook_decision` from the user resolves the response with the matching `permissionDecision`. Server-side internal timeout is 540 s — safely under the CLI-side 660 s, because an HTTP timeout would make the CLI treat the hook as a non-blocking error and the tool would proceed (the opposite of what we want).

The orchestrator-tracked `ask` mode maps to `bypassPermissions` at the CLI level (the CLI itself doesn't know about ask). `setMode("ask")` issues `control_request set_permission_mode bypassPermissions` and tracks `ask` locally; the hook callback inspects the orchestrator's mode to decide whether to prompt or auto-allow.

The CLI then reads JSON lines on stdin and emits JSON lines on stdout. Inbound message types we send:

- `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}` — new user turn. `content` is either a plain string (text-only prompts) or an array of text blocks; attachment text blocks have the canonical form `Attached file: \`<rel-path>\`` (the parser uses this exact shape to extract attachment chips on replay).
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
│   │                         round-trip, mode validation (plan / ask /
│   │                         bypassPermissions). Delegates hook callbacks to
│   │                         hookBroker.js, `--settings` JSON to settings.js, and
│   │                         persisted-session replay + metadata appends to
│   │                         transcript.js.
│   ├── hookBroker.js         Per-instance broker for the PreToolUse http hook
│   │                         callback. Holds open hook HTTP responses in a pending
│   │                         map keyed by tool_use_id, applies the 540 s timeout,
│   │                         and reaches back into the Instance through two
│   │                         injected callbacks only (getMode + emit).
│   ├── settings.js           Builds the inline `--settings` JSON passed to every
│   │                         claude spawn — registers the static-deny PreToolUse
│   │                         hook on AskUserQuestion|ExitPlanMode and (optionally)
│   │                         the interactive http hook on Edit|Write|NotebookEdit|Bash.
│   │                         Pure values in, JSON string out — no Instance state.
│   ├── transcript.js         Persisted-session helpers. Replays
│   │                         `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` into the
│   │                         orchestrator's UI-event shape on resume, and
│   │                         best-effort appends the `last-prompt` +
│   │                         `permission-mode` metadata lines that
│   │                         `claude --resume`'s interactive picker reads.
│   ├── parser.js             stream-json line → UI event normalization. Merges
│   │                         deltas by (msgId, blockIdx); emits thinking_redacted
│   │                         when a thinking block closes with only signature_delta;
│   │                         attaches parentToolUseId so sub-agent events can be
│   │                         routed to nested views; emits structured user_question
│   │                         events for AskUserQuestion and plan_request events for
│   │                         ExitPlanMode.
│   ├── projects.js           FS ops on ~/project; cwd encoding for ~/.claude/projects;
│   │                         seeds CLAUDE.md on new projects.
│   ├── routes.js             REST handlers; thin shell over instances + projects.
│   │                         Hosts POST /instances/:id/hook-callback — the
│   │                         PreToolUse http hook endpoint the CLI calls into.
│   │                         GET /instances/:id/attachments/:filename streams
│   │                         saved attachments back to the UI for replay
│   │                         thumbnails (path-traversal guarded).
│   │                         POST /admin/restart triggers self-respawn via
│   │                         src/restart.js.
│   │                         Worktree surface: list/delete worktrees per project,
│   │                         POST sync + merge.
│   ├── restart.js            scheduleRestart(): closes the WSS + http server,
│   │                         spawns a detached node child with the same argv/
│   │                         env/cwd, and exits. The child's listen-with-retry
│   │                         loop in server.js handles the EADDRINUSE window
│   │                         while the kernel releases the old socket.
│   ├── worktrees.js          Git worktree operations. createWorktree captures
│   │                         {baseBranch, baseSha, branch} at HEAD, writes a
│   │                         .claude-orch-app/worktree.json marker so listProjects
│   │                         can filter the dir out, and runs `git worktree add`
│   │                         off the captured SHA. Also adds the dotfolder to the
│   │                         worktree's local .git/info/exclude so the orchestrator's
│   │                         own state doesn't pollute git status. Read path falls
│   │                         back to the legacy .claude-orch-worktree.json filename
│   │                         so worktrees from before the reorg keep working.
│   │                         syncWorktree picks the cheapest update path
│   │                         (no-op / FF inside worktree / "rebase
│   │                         required" → caller sends buildRebasePrompt
│   │                         to the agent). mergeWorktreeIntoParent runs
│   │                         `git merge --no-ff --no-edit` on the parent
│   │                         with safety checks (parent on baseBranch +
│   │                         clean tree) — always produces a merge commit
│   │                         so the worktree stays visible in history.
│   ├── mcp/                  MCP server mounted at /mcp. server.js handles the
│   │   ├── server.js         JSON-RPC 2.0 dispatch (initialize / tools/list /
│   │   ├── tools.js          tools/call) over Streamable HTTP. tools.js is the
│   │   └── handlers.js       static tool registry (schema + name + description);
│   │                         handlers.js implements them as thin shells over
│   │                         InstanceManager + projects.js + worktrees.js. No
│   │                         business logic duplicated here.
│   ├── attachments.js        Per-worktree attachment storage. saveAttachment(cwd,
│   │                         {name, dataBase64}) decodes the base64 payload into
│   │                         .claude-orch-app/attachments/<stamp>-<safe-name>
│   │                         and returns both abs + relative paths. isImageType()
│   │                         classifies images vs. non-images so prompt() can build
│   │                         a vision block (image) or a path-reference text block
│   │                         (non-image).
│   └── wsHub.js              Per-socket subscriptions; snapshot replay; fan-out;
│                             prompt/mode/interrupt/kill/hook_decision via WS;
│                             broadcasts turn_notification to every client on
│                             turn_end.
├── public/
│   ├── index.html            Shell layout + new-project / new-instance dialogs +
│   │                         🔔 notification toggle.
│   ├── styles.css            Mobile-friendly dark theme; diff/sub-agent/
│   │                         user-question/plan card styling.
│   ├── app.js                Bootstraps; reactive store; reconnect on WS open;
│   │                         wires notification toggle, user-question submissions,
│   │                         and plan-mode decisions back over WS.
│   ├── ws.js                 Reconnecting WebSocket client with ack-based requests.
│   ├── sidebar.js            Project ▸ Sessions subnode (unified live +
│   │                         historical) ▸ Worktrees subnode (each worktree
│   │                         has its own Sessions subnode). Sessions
│   │                         default-expanded; lazy-loaded on first expand;
│   │                         re-merged with live instances on every render
│   │                         so status dots stay fresh.
│   ├── conversation.js       Ordered message list; sticky-scroll; idempotent by _seq;
│   │                         routes events with parentToolUseId into nested
│   │                         sub-Conversations; dispatches user_question,
│   │                         plan_request, permission_request, and the
│   │                         permission_resolved follow-up to inline card renderers.
│   ├── blocks.js             Renderers for text/thinking/tool_use/tool_result/
│   │                         user-question/plan-request/permission-request;
│   │                         describeToolInput() for collapsed summaries; per-tool
│   │                         body renderers for Edit/Write/NotebookEdit using the
│   │                         diff module (reused inside the Allow/Deny card).
│   ├── diff.js               Pure-JS Myers' line-diff + diffStats().
│   ├── markdown.js           Tiny safe Markdown → DOM renderer (textContent only,
│   │                         no innerHTML). Used for plan bodies and for the
│   │                         `text_end` re-render of assistant text blocks; link
│   │                         schemes restricted to http(s)/relative/fragment/mailto.
│   ├── notifications.js      Notification API wrapper + pure shouldNotify()
│   │                         decision used by both runtime and tests.
│   ├── tasks.js              TaskTracker — observes the UI event stream for
│   │                         TaskCreate / TaskUpdate tool calls, binds the
│   │                         tool-allocated task IDs by reading the matching
│   │                         tool_result text, and drives the TaskPanel above
│   │                         the composer. Pure state; DOM rendering is separate.
│   ├── usage.js              Per-instance UsageTracker that consumes the UI
│   │                         event stream (system/init + turn_end) and
│   │                         exposes currentContextSize / currentFillPct
│   │                         plus a cum.* running total. Drives the
│   │                         `ctx N%` header chip and the session-totals
│   │                         popover. CONTEXT_WINDOWS table is hardcoded.
│   ├── anchor.js             URL-hash helpers (readSessionAnchor /
│   │                         writeSessionAnchor) so a refresh restores
│   │                         the active session by `#session=<sid>`.
│   └── composer.js           Textarea (Enter→send / Shift+Enter→newline) plus
│                              the `+` attach button, file picker, chip strip with
│                              image previews, paste + drag-and-drop handlers, and
│                              base64 encoding of each attachment for the WS payload.
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
    ├── hook-callback.test.mjs PreToolUse http hook endpoint: auto-allows in
    │                         non-ask modes; in ask mode emits permission_request
    │                         over WS and resolves on hook_decision allow/deny;
    │                         instance exit resolves pending callbacks deny.
    ├── worktrees.test.mjs    End-to-end worktree feature against a real `git`:
    │                         create / list / delete worktrees, listProjects
    │                         hides them, spawn-into-existing reuses metadata,
    │                         sync (already-in-sync / FF / rebase-prompt-sent /
    │                         instance-not-running) and merge (happy path +
    │                         "click Sync first" + parent-on-wrong-branch).
    ├── question.test.mjs     AskUserQuestion → user_question UI event end-to-end;
    │                         scenario emits the hook-deny tool_result + a normal
    │                         result/success and the orchestrator must NOT issue an
    │                         interrupt control_request.
    ├── plan.test.mjs         ExitPlanMode → plan_request enriched from ~/.claude/
    │                         plans/*.md; same hook-deny shape; no interrupt; the
    │                         plan-approve setMode → bypassPermissions WS path.
    ├── notifications.test.mjs Pure-unit shouldNotify() decision table.
    ├── diff.test.mjs         Myers' diff: identity, pure add/del, replacement,
    │                         empties, round-trip both sides, stats.
    ├── static.test.mjs       Static asset serving + DOM-free module import.
    ├── blocks.test.mjs       describeToolInput() per-tool summaries.
    ├── anchor.test.mjs       URL-hash readSessionAnchor / writeSessionAnchor.
    ├── attachments.test.mjs  saveAttachment() round-trip + isImageType()
    │                         classification + prompt-block assembly.
    ├── markdown.test.mjs     Markdown → DOM renderer: heading/list/code/inline
    │                         coverage plus link-scheme rejection (no
    │                         javascript:, no raw HTML passthrough).
    ├── sidebar.test.mjs      Sidebar renderer: project ▸ Sessions ▸ Worktrees
    │                         subnode wiring, status-dot merge, collapse state.
    ├── tasks.test.mjs        TaskTracker state machine: create/update batching,
    │                         tool_result id binding, completed-batch hiding.
    ├── usage.test.mjs        UsageTracker math + format helpers + DOM
    │                         assertions for the header chip class
    │                         transitions across the 50% / 80% thresholds.
    ├── rendering.test.mjs    happy-dom-backed DOM tests over the parser →
    │                         conversation rendering pipeline. Catches
    │                         user-visible regressions the parser tests miss
    │                         (e.g. "is the tool command actually visible?").
    ├── mcp.test.mjs          MCP server end-to-end via fetch /mcp:
    │                         initialize/tools-list handshake, unknown-method
    │                         error envelope, unknown-tool isError, list_projects,
    │                         spawn_instance → send_prompt(wait:true) →
    │                         get_transcript round-trip, wait_for_idle,
    │                         set_mode, kill_instance, argument validation,
    │                         create/list/delete_worktree against a real git
    │                         repo, merge_worktree "behind" refusal.
    ├── server-restart.test.mjs Live subprocess test for POST /api/admin/restart.
    │                         Spawns `node server.js`, hits the endpoint,
    │                         asserts the original PID exits cleanly and a
    │                         new PID is serving the same port.
    └── smoke.real.test.mjs   Opt-in real-claude end-to-end (RUN_REAL_CLAUDE=1) —
                              text reply, Bash tool call shape, AskUserQuestion
                              user_question event shape, and ask-mode Write
                              gated by the PreToolUse hook (proves Allow lets
                              the same tool_use_id proceed, no regeneration).

debug/                        Opt-in Playwright + Termux-Chromium harness for
├── README.md                 visual verification of UI changes. Separate
├── package.json              package.json (so playwright-core doesn't bleed
├── browser.mjs               into the main deps), bootServer() spawns the
└── snap.mjs                  orchestrator on a free ephemeral port with an
                              optional sandboxed PROJECTS_ROOT + fake-claude,
                              snap.mjs is a generic CLI screenshotter. See
                              debug/README.md for the full workflow.
```

### WebSocket protocol

One persistent connection at `ws://127.0.0.1:8787/ws`, multiplexed across instances by `id`.

**Client → server**

| `t` | Fields | Purpose |
|---|---|---|
| `subscribe` | `id`, optional `reqId` | Subscribe to live events for an instance. Triggers a `snapshot` message followed by live `event`s. |
| `unsubscribe` | `id` | Stop receiving events. |
| `prompt` | `id`, `text`, `attachments?` | Send a user message. `attachments` is an optional list of `{name, mediaType, dataBase64}` objects — each is saved to `<cwd>/.claude-orch-app/attachments/` and appended to the message as an `Attached file: \`<path>\`` text block. Claude views/reads them on demand via its `Read` tool. |
| `mode` | `id`, `mode` | Switch permission mode via `control_request set_permission_mode` (`plan` / `ask` / `bypassPermissions`; `ask` maps to `bypassPermissions` at the CLI level). |
| `interrupt` | `id` | Abort current turn via `control_request interrupt`. |
| `kill` | `id` | SIGTERM the subprocess. |
| `hook_decision` | `id`, `toolUseId`, `allow` | Resolves a pending ask-mode `PreToolUse` hook callback. Allow → CLI runs the tool with the original `tool_use_id`; deny → CLI auto-denies. |

**Server → client**

| `t` | Fields | Purpose |
|---|---|---|
| `snapshot` | `id`, `status`, `mode`, `sessionId`, `project`, `events[]` | Sent on subscribe; events carry `_seq` for dedup. |
| `event` | `id`, `ev` | Live UI event. See "UI event kinds" below. |
| `status` | `id`, `status`, `sessionId`, `mode` | Status transition (`spawning|idle|turn|exited|crashed`). |
| `ack` | `reqId`, `ok`, `error?` | Reply to a client request that included `reqId`. |
| `hello` | — | Sent immediately on connect; lets the client confirm the socket is live before issuing requests. |
| `error` | `message` | Server-side parse-time rejection (e.g. malformed JSON frame). Not tied to a `reqId` — unparseable frames have no `reqId` to ack against. |
| `turn_notification` | `id`, `project`, `isError`, `stopReason`, `cost` | Lean notification fan-out — broadcast to **every** connected client (not just per-instance subscribers) whenever a turn ends. Lets background-tab listeners ping the OS notification system for instances they aren't currently watching. |
| `instances` | — | Hint to re-fetch `/api/instances` (no payload). Broadcast on every instance create / remove / status flip. |

**UI event kinds** (`ev.kind`)

Every event carries a `parentToolUseId` (or `null`) — the conversation view routes non-null events into a nested mini-conversation under the matching outer tool block, enabling sub-agent drill-down for `Task`.

`text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `thinking_redacted`, `tool_use_start`, `tool_use_input_delta`, `tool_use`, `tool_result`, `user_echo`, `system` (with `subtype` — includes `history_replayed` marker), `hook`, `turn_end`, `assistant_message`, `control_response`, `user_question` (`toolUseId`, `questions[]`), `plan_request` (`toolUseId`, `plan`, `planPath`), `permission_request` (`toolUseId`, `toolName`, `toolInput`), `permission_resolved` (`toolUseId`, `allow`), `raw`. Each event in the ring has a monotonic `_seq` so snapshot + live merge is idempotent.

### REST endpoints

| Method | Path | Body / Returns |
|---|---|---|
| `GET` | `/api/projects` | `[{name, path, instanceIds[]}]` |
| `POST` | `/api/projects` | `{name}` → `{name, path}`. Validates `^[a-zA-Z0-9._-]+$`. Writes `CLAUDE.md` with `@../CLAUDE.md`. |
| `DELETE` | `/api/projects/:name` | `{ok:true, project, killedInstances}` — cascades: kill all attached instances → remove all worktrees → `rm -rf` the project dir. Sessions under `~/.claude/projects/` are left in place. |
| `GET` | `/api/projects/:name/sessions` | `[{sessionId, firstPrompt, mtime, size}]` |
| `GET` | `/api/sessions/:sessionId/locate` | `{project, worktreeName}` (`worktreeName` is `null` for project-root sessions). 404 if the jsonl isn't found under any known project / worktree cwd. 400 for malformed ids. Drives the frontend's auto-resume-from-URL-anchor flow. |
| `POST` | `/api/instances` | `{project, mode?, effort?, thinking?, model?, resume?, worktree?, temp?, debug?}` → instance summary (includes `temp: bool`). When `temp:true` and `mode` is omitted, defaults to `bypassPermissions`; on exit the session jsonl + sub-agent dir under `~/.claude/projects/<encoded-cwd>/` are removed and no `last-prompt`/`permission-mode` metadata is appended during the run. `debug:true` mirrors raw CLI traffic to `<cwd>/.claude-orch-app/debug/<instance-id>/`. |
| `GET` | `/api/instances` | `[{id, project, sessionId, status, mode, effort, thinking, model, pid}]` |
| `POST` | `/api/instances/:id/respawn` | `{id, sessionId}` — uses `--resume lastSessionId` |
| `DELETE` | `/api/instances/:id` | `{ok: true}` — SIGTERM + remove |
| `POST` | `/api/instances/:id/debug` | Flip debug capture ON for a running instance (idempotent — `alreadyOn:true` if it was already capturing). Returns `{ok:true, debug, debugDir, alreadyOn}`. No matching "off" endpoint: kill the instance to stop. 404 on unknown id. |
| `POST` | `/api/instances/:id/sync` | Brings the worktree up to date with its base branch. Returns `{ok:true, action:"already-in-sync"\|"fast-forwarded"\|"rebase-prompt-sent", ...}` or `{ok:false, reason}`. The FF case runs `git merge --ff-only <baseBranch>` inside the worktree server-side; the rebase case sends the templated rebase prompt to the worktree's live instance (refused with `{ok:false, reason:"…not running…"}` if the instance has been stopped). 400 if the instance has no worktree. |
| `POST` | `/api/instances/:id/merge` | Runs `git merge --no-ff --no-edit <worktreeBranch>` on the parent repo — always creates a merge commit (git's default message). Returns `{ok:true, newSha}` or `{ok:false, reason}` (refusals are returned 200 with `ok:false` so the UI can render the reason inline). If the worktree is still behind the parent, refuses with a "click Sync first" reason — conflict resolution belongs inside the worktree where the agent can help, not on the parent. |
| `GET` | `/api/projects/:name/worktrees` | `[{worktreeName, branch, baseBranch, baseSha, parentPath, createdAt, instanceIds}]` |
| `GET` | `/api/projects/:name/worktrees/:wt/sessions` | Same shape as the project-level session list, but scoped to the worktree's encoded cwd. |
| `DELETE` | `/api/projects/:name/worktrees/:wt[?force=1]` | Removes the worktree dir + branch. 409 if there's a running instance or uncommitted changes; `force=1` kills attached instances and ignores dirt. |
| `DELETE` | `/api/projects/:name/sessions/:sid[?force=1]` | Removes the persisted session jsonl. 409 if attached to a running instance; `force=1` kills the instance then deletes. |
| `DELETE` | `/api/projects/:name/worktrees/:wt/sessions/:sid[?force=1]` | Same, scoped to a worktree's own session dir. |
| `POST` | `/api/instances/:id/hook-callback` | PreToolUse http hook endpoint the CLI calls. Body = full hook envelope. Always responds 200 with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny"}}`. Auto-allows in non-ask modes; in ask mode the response stays open up to 540 s until a WS `hook_decision` arrives. |
| `GET` | `/api/instances/:id/attachments/:filename` | Streams a previously-saved attachment from the instance's `<cwd>/.claude-orch-app/attachments/`. Used by the frontend to paint user-bubble thumbnails on transcript replay (when the live `user_echo`'s `dataBase64` is gone). Rejects path traversal (400), missing files (404), unknown instances (404). |
| `POST` | `/api/admin/restart` | Self-respawn the orchestrator. Responds `202 {ok:true}` immediately, then spawns a detached child node process with the same argv/env/cwd and exits. The child retries `listen` on `EADDRINUSE` while the kernel releases the old socket. Drives the sidebar's `⟲ Restart server` button. |

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
- New instance: `--permission-mode plan` (the safer default — read-only; the user can pick `code` in the dialog or approve a plan mid-session to flip to `bypassPermissions`), `--effort high`, `--thinking adaptive`, no `--model` flag (uses account default). When the **Temp session** checkbox is ticked, the mode default flips to `bypassPermissions` instead.
- Resumed instance (sidebar one-click resume): `--permission-mode bypassPermissions` (i.e. `code`), same effort/thinking defaults as above. Crash-recovery respawn preserves whatever mode the instance was already running.
- Ring buffer: 500 events per instance.
- Control-request timeout: 5 s.
- Kill grace: stdin closed → 2 s → SIGTERM → 5 s → SIGKILL.

### Testing

All tests run via `node tests/run.mjs` (programmatic node:test runner, because the Termux glibc-runner wrapper for node hoists leading `--flags` into `NODE_OPTIONS` and `--test` isn't allowed there).

The default suite uses a **fake-claude** subprocess (`tests/fake-claude.mjs`) injected via `CLAUDE_BIN`. The fake mirrors real claude's behavior: silent on startup until the first stdin message arrives, auto-acks control_requests, and emits scenario JSON from `FAKE_CLAUDE_SCENARIO`. `FAKE_CLAUDE_ARGV_DUMP=<path>` captures the launch argv so tests can assert what flags the orchestrator passes.

The opt-in real-claude smoke (`tests/smoke.real.test.mjs`, gated by `RUN_REAL_CLAUDE=1`) spawns the actual CLI, sends a one-word prompt, and asserts that `system/init`, at least one `text_delta`, and a non-error `turn_end` all arrive. Cleans its session jsonl on exit.

### Known limitations

- **Opus 4.7 thinking is redacted.** The model emits a thinking block but only a `signature_delta`, never the content. The UI shows a single non-expandable `thinking (redacted)` line for those blocks (no disclosure caret, since there's nothing inside to reveal). Pick `claude-sonnet-4-6` from the model dropdown if you want to see the thinking stream.
- **AskUserQuestion is answered via the next prompt, not as a real tool result.** A `PreToolUse` hook (registered via `--settings`) denies the tool, the model receives an `is_error: true` tool_result with a "wait for the user" reason and ends the turn naturally. The orchestrator renders the structured options as buttons; the picked answer is fed in as a normal user prompt on the next turn. Functionally fine, but the original tool_result is still an `is_error` for diagnostic purposes.
- **`--effort` and `--thinking` are spawn-time only.** Switching them mid-session would require respawn + resume. Mode is the only knob that's live-switchable (via `control_request set_permission_mode`).
- **No auth.** Bound to 127.0.0.1 — anyone with shell access on the device can drive it.
- **Best-effort metadata writes.** If the orchestrator crashes between a turn ending and the metadata append, the session jsonl may lack the `last-prompt` line and won't show up in `claude --resume`'s picker. The transcript is still intact and resumable by `claude --resume <sid>`.
- **MCP: Claude-spawning-Claude recursion.** Because the orchestrator MCP is auto-registered into every spawn (see [MCP interface](#mcp-interface)), any session can call `spawn_instance` to launch further sessions — and those children inherit the same auto-registration, so they can spawn more in turn, ad infinitum if you set up an autonomous loop. There is no orchestrator-side depth guard. Recommended mitigations, in order of strength: (1) set `ORCH_DISABLE_MCP_AUTOREGISTER=1` on the orchestrator process — children spawned under that env never see the MCP at all; (2) spawn child agents in `plan` mode by default (they still see the MCP but can't `set_mode`/`send_prompt` to escalate themselves into deeper spawns without user approval); (3) prefer the `wait:true` MCP send-prompt path over fire-and-forget so a runaway fan-out blocks on its first child instead of racing.
- **Notifications need user permission.** The 🔔 toggle works on browsers that expose the Notification API. On mobile Chrome notifications require the Service Worker at `/sw.js` (registered automatically once permission is granted). iOS Safari requires installing the page as a PWA. The toggle reports the current permission state in its tooltip when unavailable.
