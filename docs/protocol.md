> See also: [README](../README.md)

## Subprocess protocol
```bash
claude -p \
  --input-format=stream-json --output-format=stream-json \
  --verbose --include-partial-messages --include-hook-events \
  --allow-dangerously-skip-permissions \
  --permission-mode <plan|bypassPermissions> --effort <effort> --thinking <thinking> \
  --settings '{"hooks":{"PreToolUse":[…]}}' \
  --mcp-config '{"mcpServers":{"code-conductor":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}' \
  [--model <name>] \
  --session-id <fresh-uuid> | --resume <existing-uuid>
```

`--allow-dangerously-skip-permissions` is **always** passed at spawn — even for `plan`-mode instances — because without it the CLI rejects any later runtime `set_permission_mode bypassPermissions` (i.e. the plan-approve flow). The flag only *permits* the switch; it doesn't activate bypass on its own.

Two `PreToolUse` hooks via inline `--settings` JSON:
1. **AskUserQuestion|ExitPlanMode** — `command` hook, static deny with reason "Awaiting user input via the orchestrator UI". The CLI auto-errors both tools in stream-json `--print` mode anyway (no SDK `canUseTool` callback to satisfy); the deny just gives them a friendlier reason. The model receives an `is_error: true` tool_result, ends the turn naturally, and the orchestrator drives the conversation forward via the next user prompt (plus, for plan approval, a `setMode(bypassPermissions)` control_request first).
2. **Edit|Write|NotebookEdit|Bash** — `http` hook → `POST /api/instances/<id>/hook-callback`, **660 s** CLI-side timeout. Orchestrator auto-allows when the mode isn't `ask`; in `ask` mode holds the response open up to **540 s** (deliberately under 660 s — an HTTP timeout would make the CLI treat the hook as a non-blocking error and proceed, the opposite of intent). `ask` is orchestrator-tracked only and maps to `bypassPermissions` at the CLI level; the hook callback inspects orchestrator-side mode to gate.

Inbound: `user` (text or `[{type:"text", text:"..."}, …]` blocks; attachments use `` Attached file: `<rel-path>` ``), `control_request` (`set_permission_mode` / `interrupt`), `keep_alive`. A `user` message written while a turn is running is **delivered mid-turn and interleaved into the live turn** (steering) — not queued until turn_end; the CLI persists such a mid-turn prompt as a `type:"attachment"` `queued_command` line (array `prompt`) rather than a `type:"user"` line.

**Two-tier interrupt.** SOFT (default) injects a hidden steering `user` message prefixed with `[[cc:soft-interrupt]]` (`SOFT_INTERRUPT_MARKER`) telling the model to stop all work and end its turn silently — graceful wind-down, partial work preserved. The marker is filtered everywhere it could surface (`parser._handleUser`, `transcript.replayPersistedLine`, `transcript.isPureUserPromptLine`) so it never renders a user bubble, never replays, and never shifts the rewind/fork index. FORCED (`force:true`) is the unchanged hard `control_request` `subtype:interrupt` abort (discards partial work). Both gated by `if (status !== 'turn') return`.

Outbound: `system` + `subtype:"init"` (bundled with first turn's response, not at startup; carries `session_id`, `model`, `tools`, `permissionMode`), `stream_event` (live SSE deltas — primary feed), `assistant` (final reconciled per-turn message — used for replay only), `user` (`tool_result` blocks), `result` (turn-end with `duration_ms`, `usage`, `total_cost_usd`, `stop_reason`, `is_error`), `hook_event`, `control_response`.

## WebSocket protocol

**Client → server:**
| `t` | Fields |
|---|---|
| `subscribe` | `id`, optional `reqId` (triggers `snapshot` + live `event`s) |
| `unsubscribe` | `id` |
| `prompt` | `id`, `text`, optional `attachments` (`[{name, mediaType, dataBase64}]`) |
| `mode` | `id`, `mode` (`plan` / `ask` / `bypassPermissions`; `ask` → CLI `bypassPermissions`) |
| `interrupt` | `id`, optional `force` (omitted/false ⇒ soft hidden-steer; `true` ⇒ hard `control_request` abort) |
| `kill` | `id` |
| `hook_decision` | `id`, `toolUseId`, `allow` (resolves ask-mode hook with original `tool_use_id`) |
| `auto_approve_plan` | `id`, `enabled` (server-side flag; while on, an incoming `plan_request` in plan mode auto-fires `setMode(bypassPermissions)` + the approval prompt) |

**Server → client:**
| `t` | Fields |
|---|---|
| `snapshot` | `id`, `status`, `mode`, `sessionId`, `project`, `autoApprovePlan`, `interrupting`, `events[]` (ring **tail** only — ≤ `ORCH_SNAPSHOT_TAIL`, default 500, window start snapped to a turn boundary), `tailStartSeq` (`_seq` of first tail event; `>0` ⇒ older history exists — page it via `GET /api/instances/:id/events?before=<seq>`), `trimmedBefore` (first `_seq` still in the in-memory ring) |
| `reset_snapshot` | Same shape minus the tail metadata (`events: []`); sent after rewind so subscribers clear DOM first |
| `event` | `id`, `ev` (monotonic `_seq` for idempotent merge) |
| `status` | `id`, `status` (`spawning|idle|turn|exited|crashed`), `sessionId`, `mode`, `autoApprovePlan`, `interrupting` (transient — `true` while a soft interrupt winds a turn down; auto-clears on exit from `turn`) |
| `ack` | `reqId`, `ok`, `error?` |
| `hello` | sent on connect |
| `error` | `message` (server-side parse rejection; not tied to a `reqId`) |
| `turn_notification` | `id`, `project`, `isError`, `stopReason`, `cost` — **broadcast to all clients** (not just per-instance subscribers) so background tabs can ping OS notifications |
| `instances` / `projects` | Hints to re-fetch (no payload); broadcast on every instance create/remove/status flip — `projects` covers the case where a CLI just flushed a session jsonl |

**UI event kinds (`ev.kind`):** `text_delta`, `text_end`, `thinking_start/delta/end/redacted`, `tool_use_start/input_delta/use`, `tool_result`, `user_echo` (outer echoes carry `userIndex` — the absolute 0-based ordinal among pure user-prompt jsonl lines; the rewind/fork anchor, immune to ring trimming), `system` (subtypes incl. `init`, `history_replayed`), `hook`, `turn_end`, `assistant_message`, `control_response`, `user_question` (`toolUseId`, `questions[]`), `plan_request` (`toolUseId`, `plan`, `planPath`, optional `autoApproved`), `permission_request` (`toolUseId`, `toolName`, `toolInput`), `permission_resolved` (`toolUseId`, `allow`), `raw`. Each carries `parentToolUseId` (or `null`) — non-null routes into a nested sub-Conversation.

## REST endpoints
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List with workspace, git status, sessions, worktrees. |
| `POST` | `/api/projects` | Create (validates `^[a-zA-Z0-9._-]+$`, seeds `CLAUDE.md`). |
| `DELETE` | `/api/projects/:name` | Cascade: kill instances → remove worktrees → `rm -rf`. Sessions persist under `~/.claude/projects/`. |
| `PUT` | `/api/projects/:name/workspace` | `{workspace}` — assigns/clears; auto-registers new names. |
| `GET` | `/api/workspaces` | Union of registry + referenced names. |
| `POST` | `/api/workspaces` | `{name}` — 201 new / 200 idempotent. Same regex. |
| `PUT` | `/api/workspaces/:name` | `{name: newName}` — atomic rename across all members. |
| `DELETE` | `/api/workspaces/:name` | Removes the entry **and** clears `workspace` on every member (projects stay). |
| `GET` | `/api/projects/:name/sessions` | Session metadata list. |
| `GET` | `/api/sessions/:sid/locate` | `{project, worktreeName}`; drives anchor auto-resume. 404 if not found. |
| `PUT` | `/api/sessions/:sid/title` | `{title}` — set custom session label (≤100 chars; empty/whitespace clears). Returns `{ok, sessionId, title, maxLength}`. Broadcasts `projects` hint + pushes updated summary to any live instance with this `sessionId`. |
| `POST` | `/api/instances` | Spawn. Returns summary. |
| `GET` | `/api/instances` | List live. |
| `POST` | `/api/instances/:id/respawn` | Uses `--resume lastSessionId`. |
| `GET` | `/api/instances/:id/events` | Paged event history, incl. events evicted from the capped ring (reconstructed by replaying the session jsonl). `before=<seq>` pages **backward** (up to `limit` events immediately preceding that seq, oldest-first — echo the response's `nextBefore` cursor to continue; wins over `after`); `after=<seq>` pages forward (`sinceSeq` semantics); neither ⇒ trailing page. `limit` clamped to `[1,500]`, default 200. Returns `{id, events, hasMore, nextBefore, trimmedBefore, lastSeq}`. Evicted/archived events get their own dense `_seq` space strictly below `trimmedBefore`, cut at a turn boundary so ring + archive never overlap (degenerate giant-turn case yields a gap, never duplication). 400 non-integer params, 404 unknown id. |
| `POST` | `/api/instances/:id/rewind` | `{userMessageIndex}` — atomic truncate + respawn (same `sessionId`). 409 during turn, 400 on temp / out-of-range. Returns `droppedText`. |
| `POST` | `/api/instances/:id/fork` | `{userMessageIndex}` — copies prefix to new `sessionId`, original is byte-identical, spawns fresh instance. 400 on temp / OOR. |
| `DELETE` | `/api/instances/:id` | SIGTERM + remove. |
| `POST` | `/api/instances/:id/promote` | Promote a live temp session to a normal one: flips `instance.temp = false`, writes `last-prompt` + `permission-mode` so `claude --resume`'s picker can find it, emits `status` so the sidebar moves the row above the `— temp —` separator. 400 if not temp, 404 unknown id. |
| `POST` | `/api/instances/:id/debug` | Flip debug capture **ON** for a running instance (idempotent — `alreadyOn:true`). **No "off" endpoint** — kill the instance to stop. |
| `POST` | `/api/instances/:id/sync` | Returns `action: already-in-sync | fast-forwarded | rebase-prompt-sent`. FF runs server-side; rebase sends templated prompt to the live agent. 400 if no worktree; `ok:false, reason:"…not running…"` if instance is dead. |
| `POST` | `/api/instances/:id/merge` | Parent-side merge. Refusals return 200 with `ok:false, reason` so the UI can render inline. |
| `GET` | `/api/projects/:name/worktrees` | List with metadata. |
| `GET` | `/api/projects/:name/worktrees/:wt/sessions` | Worktree-scoped session list. |
| `GET` | `/api/projects/:name/worktrees/:wt/diff[?baseRef=&context=]` | Structured unified diff of `<baseRef|baseBranch>...HEAD`. `{project, worktreeName, baseRef, files:[{path, oldPath, status, adds, dels, hunks:[{header, lines:[{type:add\|del\|ctx, content}]}]}], totalAdds, totalDels, truncated}`. `context` clamped 0–50 (default 3); raw diff capped at 200 KB → `truncated:true`. 404 unknown worktree. |
| `GET` | `/api/projects/:name/commits[?limit=]` | Commit log of the project's current branch (HEAD), newest first. `{project, branch, commits:[{sha, shortSha, subject, author, relativeDate, isoDate, parents}], truncated, limit}`. `parents` is the array of parent SHAs (`%P`): `[]` for the root, ≥2 for a merge — the frontend uses it to draw the branch/merge graph. `limit` clamped 1–500 (default 100); `truncated:true` when more exist. Non-git project → `{branch:null, commits:[]}`. 404 unknown project. |
| `GET` | `/api/projects/:name/commits/:sha/diff[?context=]` | Structured diff for the single commit `sha` (via `git show`; handles root commits). Same `files/totalAdds/totalDels/truncated` shape as the worktree diff (renderer-compatible), plus `{project, sha}`. `sha` guarded `^[0-9a-fA-F]{4,40}$` → 400 otherwise; unknown commit → 404. Merge commits yield a combined diff that isn't parsed → empty `files`. |
| `DELETE` | `/api/projects/:name/worktrees/:wt[?force=1]` | 409 on live instance / dirt; `force=1` kills + ignores. |
| `DELETE` | `/api/projects/:name/sessions/:sid[?force=1]` | Delete persisted jsonl; 409 if attached. |
| `DELETE` | `/api/projects/:name/worktrees/:wt/sessions/:sid[?force=1]` | Same, worktree-scoped. |
| `GET` | `/api/instances/:id/attachments/:filename` | Streams from the central-store attachments dir (path-traversal guarded). |
| `POST` | `/api/instances/:id/hook-callback` | PreToolUse http hook target; always 200 with `permissionDecision`. |
| `POST` | `/api/admin/restart` | Self-respawn (202 immediate, detached child, exit). Body `{resume:true}` ⇒ graceful **Resume after restart**: drain every live turn to idle (`src/resumeRestart.js`), carry sessions (incl. temps) over via `<store>/pending-resume.json`, and resurrect + notify them on boot. Omitted/false ⇒ normal hard restart (wipes temps). |
| `GET` | `/api/transcribe/status` | `{available: boolean}` — true when both `WHISPER_CLI` and `WHISPER_MODEL` exist on disk. Drives the composer's mic-button visibility. |
| `POST` | `/api/transcribe` | Body: raw audio bytes (any `audio/*` content-type, ≤ 25 MB). Returns `{text}`. 400 on empty body, 503 when whisper isn't installed. Route-scoped `express.raw` parser so the global 1 MB JSON limit doesn't apply. |
| `GET` | `/api/settings/transcribe` | `{available, activeModel, models:[{name,label,sizeLabel,installed}], install}` — curated whisper model catalog + per-model on-disk state + active model + install status. |
| `POST` | `/api/settings/transcribe/model` | `{model}` — set the active model. 400 if unknown or not installed. Returns the refreshed state. Persisted to `settings.json`; effective immediately. |
| `POST` | `/api/settings/transcribe/install` | `{model}` — start `bin/install-whisper.sh` for that model (one at a time). 200 `{started}`, 409 `{running}` if busy, 400 on unknown model. On clean exit the model is set active. |
| `GET` | `/api/settings/transcribe/install/status` | `{running, model, exitCode, log}` — polled by the Settings page to stream install progress. |
| `GET` | `/api/settings/models` | `{families:[{family,label,default,versions:[{id,label}]}], active:{fable,sonnet,opus,haiku}, enabledFamilies, defaultSpawnFamily}` — curated per-family version catalog + active version per family (catalog default when unset) + set of enabled families + configured default spawn family. |
| `POST` | `/api/settings/models` | `{family, version}` — set a family's active version. 400 if unknown family or version not in that family's catalog. Returns refreshed state. Persisted to `settings.json`; effective immediately. |
| `POST` | `/api/settings/models/prefs` | `{autoStopOnOverage?, conductorCompactWindow?, sonnetContextWindow?, familyEnabled?:{family,enabled}, defaultSpawnFamily?}` — update model prefs. Returns refreshed state. |
| `GET` | `/api/tts/status` | `{available: boolean}` — true when the piper venv python + the active voice's `.onnx`/`.onnx.json` exist on disk. Drives the conversation's 🔊-button visibility. |
| `POST` | `/api/tts` | Body: raw assistant text (`text/*`, route-scoped `express.text`, ≤ 256 KB). Streams `application/octet-stream` = a sequence of `[4-byte LE length][WAV]` frames, one per sentence, flushed as Piper synthesizes. 400 on empty body, 503 when piper isn't installed. Killing the response (client disconnect) stops synthesis. |
| `GET` | `/api/settings/tts` | `{available, activeVoice, voices:[{name,label,sizeLabel,hfDir,installed}], install, enabled, rate}` — curated Piper voice catalog + per-voice on-disk state + active voice + auto-speak/rate prefs + install status. |
| `POST` | `/api/settings/tts/voice` | `{voice}` — set the active voice. 400 if unknown or not installed. Returns refreshed state. Persisted to `settings.json`; effective immediately. |
| `POST` | `/api/settings/tts/prefs` | `{enabled?, rate?}` — persist the auto-speak toggle and/or playback rate (rate clamped 0.5–2.0). Returns refreshed state. |
| `POST` | `/api/settings/tts/install` | `{voice}` — start `bin/install-piper.sh` for that voice (one at a time). 200 `{started}`, 409 `{running}` if busy, 400 on unknown voice. On clean exit the voice is set active. |
| `GET` | `/api/settings/tts/install/status` | `{running, voice, exitCode, log}` — polled by the Settings page to stream install progress. |
| `GET` | `/api/settings/workspace-claudemd` | `{status, conflict, targetExists, targetPath, vendorPath, baselinePath}` — reconcile status of `<PROJECTS_ROOT>/CLAUDE.md` (`created`/`up-to-date`/`updated`/`kept`/`conflict`). |
| `GET` | `/api/settings/workspace-claudemd/diff` | `{diff}` — unified diff of the projects-root `CLAUDE.md` (your copy) vs the bundled canonical. Empty when identical. |
| `POST` | `/api/settings/workspace-claudemd/resolve` | `{action}` — `keep` (baseline := canonical, file unchanged) or `overwrite` (back up to `<target>.bak-<ts>`, copy canonical in, bump baseline). 400 on any other action. Returns refreshed status. |
