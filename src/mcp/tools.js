// MCP tool registry. Each entry is { name, description, inputSchema,
// handler }. Schemas are inline JSON-Schema objects (shallow-validated
// by ../mcp/server.js). Handlers live in ./handlers.js and reach into
// the orchestrator's existing modules — no business logic here.

import * as h from './handlers.js';

const VALID_MODES = ['plan', 'ask', 'bypassPermissions'];
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING = ['adaptive', 'enabled', 'disabled'];

export function buildTools() {
  return [
    {
      name: 'list_projects',
      description:
        'List every project under ~/project/, with each project\'s git status, worktrees, ' +
        'live instance ids, and a session-count summary.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listProjects,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_instances',
      description:
        'List every live or recently-exited orchestrator instance. Each entry carries ' +
        '{id, project, sessionId, status, mode, effort, thinking, model, pid, worktree, temp, conducted, debug}. ' +
        '`conducted:true` marks a session spawned via this `spawn_instance` tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listInstances,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_sessions',
      description:
        'List persisted Claude sessions for a project, or for a specific worktree inside it. ' +
        'Returns [{sessionId, firstPrompt, title, conducted, archived, mtime, size}] newest-first. ' +
        '`conducted:true` marks a session spawned via the `spawn_instance` tool (orchestrator-driven). ' +
        '`archived:true` marks a session that was killed and archived rather than deleted — its ' +
        'transcript is retained and it is resumable, but hidden from the normal active list. ' +
        'All sessions are returned regardless of these flags — they are grouping flags, not filters.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name under ~/project/.' },
          worktree: { type: 'string', description: 'Optional worktree name (the sibling dir, e.g. "demo_worktree_abc123").' },
        },
        required: ['project'],
      },
      handler: h.listSessions,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'locate_session',
      description:
        'Find which project (and optionally which worktree) owns a given sessionId, by ' +
        'probing the conventional ~/.claude/projects/<encoded-cwd>/<sid>.jsonl path against ' +
        'every known project + worktree. Returns {project, worktree: string|null}. ' +
        'Errors with "session not found" when nothing matches.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session UUID to locate.' },
        },
        required: ['sessionId'],
      },
      handler: h.locateSession,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_worktrees',
      description:
        'List orchestrator-owned git worktrees for a project. Each entry includes ' +
        '{worktree, branch, baseBranch, baseSha, parentPath, createdAt}.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      handler: h.listWorktrees,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_transcript',
      description:
        'Return the instance UI-event stream. DISK-BACKED & ring-first: events are served from the ' +
        'in-memory ring, and when sinceSeq points into a range the ring has already evicted (below ' +
        'trimmedBefore) the dropped range is transparently served from the on-disk session transcript — ' +
        'ring eviction is invisible to you. Events carry _seq; poll incrementally by passing the returned ' +
        '`nextAfter` back as the next sinceSeq (forward paging, oldest-first). Returns {id, status, ' +
        'sessionId, events, lastSeq, trimmedBefore, hasMore, nextAfter}. Event kinds: text_delta, tool_use, ' +
        'tool_result, turn_end, etc. — same shape as the WebSocket snapshot. (Caveat: a single turn larger ' +
        'than the ring cap can leave a mid-turn gap; for prose mid-long-turn use get_recent_messages.)',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id.' },
          sinceSeq: { type: 'integer', default: -1, description: 'Return events with _seq > sinceSeq (forward, oldest-first). Default -1 → newest page. Pass the previous call\'s nextAfter to poll incrementally.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: 'Max events returned per call (clamped to [1, 500]). Use nextAfter + hasMore to page.' },
        },
        required: ['id'],
      },
      handler: h.getTranscript,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'spawn_instance',
      description:
        'Spawn a new Claude subprocess inside a project (optionally inside a new or existing git worktree of it). ' +
        'Returns the instance summary. Pass createWorktree:true to create a fresh worktree off HEAD, or ' +
        'worktree:"<name>" to attach to an existing one (createWorktree wins if both are given). ' +
        'Defaults to temp:true (disposable worker) but mode still defaults to plan ' +
        '(NOT bypassPermissions) so workers plan before acting — promote with promote_session to keep one. ' +
        'CAUTION: an instance with the code-conductor MCP registered can in turn spawn ' +
        'further instances — guard against runaway recursion by keeping child agents in plan mode.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          mode: { type: 'string', enum: VALID_MODES, description: 'plan / ask / bypassPermissions. Defaults to plan, independent of temp (resume defaults to bypassPermissions).' },
          effort: { type: 'string', enum: VALID_EFFORTS },
          thinking: { type: 'string', enum: VALID_THINKING },
          model: {
            type: 'string',
            description:
              'Family alias (opus / sonnet / haiku / fable) — resolves to the version configured in ' +
              'Settings → Models, including the Sonnet 1M/200k context-window preference. ' +
              'A full model id (e.g. claude-sonnet-4-6) is also accepted as a pass-through. ' +
              'Empty/omitted uses the account default. ' +
              'Disabled families are still resolved when passed explicitly.',
          },
          resume: { type: 'string', description: 'Optional sessionId to resume (vs. spawning a fresh session).' },
          worktree: {
            type: 'string',
            description: 'Name of an existing worktree to spawn into. To create a fresh one instead, use createWorktree:true.',
          },
          createWorktree: {
            type: 'boolean',
            description: 'If true, create a fresh worktree off the project\'s HEAD and spawn into it. Takes precedence over worktree.',
          },
          temp: { type: 'boolean', default: true, description: 'If true, the session jsonl is removed on subprocess exit. Defaults to true for MCP spawns; pass false to keep the session (or promote_session later).' },
          debug: { type: 'boolean', description: 'If true, raw CLI traffic is mirrored to .code-conductor/debug/<id>/.' },
        },
        required: ['project'],
      },
      handler: h.spawnInstance,
    },
    {
      name: 'send_prompt',
      description:
        'Send a user turn to a running instance. Defaults to wait:false (returns immediately). ' +
        'Pass wait:true to block until the turn ends and return the turn_end event inline. ' +
        'A mid-turn send_prompt is delivered live into the running turn (not queued), so it can steer a worker in flight.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          wait: { type: 'boolean', default: false, description: 'Block until turn_end. Default false.' },
          waitTimeoutMs: { type: 'integer', default: 600000, description: 'Per-call wait cap (default 600000 = 10 min).' },
        },
        required: ['id', 'text'],
      },
      handler: h.sendPrompt,
    },
    {
      name: 'wait_for_idle',
      description:
        'Block until an instance returns to status idle, exited, or crashed. Returns the resolved ' +
        'status. Useful between send_prompt({wait:false}) and get_transcript.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeoutMs: { type: 'integer', default: 600000, description: 'Default 600000 (10 min) — matches send_prompt\'s wait cap.' },
        },
        required: ['id'],
      },
      handler: h.waitForIdle,
    },
    {
      name: 'set_mode',
      description:
        'Switch a running instance\'s permission mode at runtime via control_request. ' +
        'plan / ask / bypassPermissions.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          mode: { type: 'string', enum: VALID_MODES },
        },
        required: ['id', 'mode'],
      },
      handler: h.setMode,
      annotations: { idempotentHint: true },
    },
    {
      name: 'approve_plan',
      description:
        'Approve a worker\'s plan: flips the instance to bypassPermissions and sends the canonical approval ' +
        'prompt as a normal user turn. Mirrors the UI\'s Approve & Implement button — use this rather than ' +
        'driving set_mode + send_prompt by hand. Optional `feedback` is appended to the approval message.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id of the worker whose plan you\'re approving.' },
          feedback: { type: 'string', description: 'Optional additional notes appended to the approval message.' },
        },
        required: ['id'],
      },
      handler: h.approvePlan,
    },
    {
      name: 'reject_plan',
      description:
        'Reject a worker\'s plan and ask for refinement. The instance stays in plan mode; the worker will ' +
        'produce a revised plan in its next turn. `feedback` is recommended — without it the worker has no ' +
        'guidance for what to change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id of the worker whose plan you\'re rejecting.' },
          feedback: { type: 'string', description: 'What you want the worker to change. Strongly recommended.' },
        },
        required: ['id'],
      },
      handler: h.rejectPlan,
    },
    {
      name: 'set_auto_approve_plan',
      description:
        'Toggle the per-instance auto-approve-plan flag. While enabled, the next plan_request emitted by the ' +
        'worker auto-fires setMode(bypassPermissions) + the approval prompt server-side — no further calls ' +
        'needed. Useful for spawning multiple workers and letting them roll forward without per-plan ' +
        'intervention.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'enabled'],
      },
      handler: h.setAutoApprovePlan,
      annotations: { idempotentHint: true },
    },
    {
      name: 'subscribe_to_idle',
      description:
        'Register a one-shot callback: when the target instance next emits turn_end, the orchestrator ' +
        'injects a short stub user prompt into the *calling* instance pointing at get_recent_messages. ' +
        'Use this right after send_prompt({wait:false}) so you can hand control back to the user but still ' +
        'be re-woken when the worker finishes. The subscription is consumed on fire — call again to watch ' +
        'further turns. Caller identity is taken from the MCP URL (?caller=<id>), so this only works for ' +
        'orchestrator-spawned instances. ' +
        'Optional timeoutMs watchdog: if the worker has not hit turn_end within that many milliseconds, ' +
        'the subscription fires early with a timeout-flagged stub that says the worker did NOT finish, ' +
        'so the conductor can distinguish a hung or crashed worker from a completed one. Whichever fires ' +
        'first (turn_end or timeout) consumes the subscription and cancels the other. ' +
        'Omitting timeoutMs preserves the original behaviour (no timer, fire only on turn_end).',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Instance id of the worker to watch for turn_end.' },
          timeoutMs: {
            type: 'number',
            minimum: 1,
            description:
              'Optional watchdog: fire the subscription after this many ms even if turn_end has not ' +
              'arrived. Must be a positive finite number; ignored otherwise. The stub injected on ' +
              'timeout is clearly labelled as a timeout (not a completion) so the conductor can ' +
              'distinguish a timed-out worker from a finished one.',
          },
        },
        required: ['targetId'],
      },
      handler: h.subscribeToIdle,
    },
    {
      name: 'unsubscribe_from_idle',
      description:
        'Cancel a pending subscribe_to_idle registration. Idempotent — returns removed:false if no ' +
        'subscription was active for this caller/target pair.',
      inputSchema: {
        type: 'object',
        properties: { targetId: { type: 'string' } },
        required: ['targetId'],
      },
      handler: h.unsubscribeFromIdle,
      annotations: { idempotentHint: true },
    },
    {
      name: 'interrupt_turn',
      description: 'Stop the current turn of a running instance. Default (soft) injects a hidden steering message asking the model to stop work and end its turn gracefully. Pass force:true for a hard control_request abort that severs the turn and discards partial work.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          force: { type: 'boolean', default: false, description: 'true = hard abort; omitted/false = soft graceful stop' },
        },
        required: ['id'],
      },
      handler: h.interruptTurn,
    },
    {
      name: 'kill_instance',
      description: 'Terminate an instance subprocess and remove it from the manager.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: h.killInstance,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    {
      name: 'respawn_instance',
      description:
        'Respawn an exited/crashed instance against its last sessionId (--resume). The in-memory ' +
        'event ring is preserved across the respawn.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: h.respawnInstance,
    },
    {
      name: 'promote_session',
      description:
        'Promote a temp session to a persistent one: flips temp=false and writes last-prompt + ' +
        'permission-mode so `claude --resume` finds it (emits a status update). Errors if the ' +
        'instance id is unknown or the instance is not temp.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Instance id of the temp session to keep.' } },
        required: ['id'],
      },
      handler: h.promoteSession,
    },
    {
      name: 'create_worktree',
      description:
        'Create a fresh git worktree off the project\'s current HEAD without spawning an instance. ' +
        'Use spawn_instance({worktree:<name>}) afterwards to attach an agent to it.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      handler: h.createWorktree,
    },
    {
      name: 'delete_worktree',
      description:
        'Remove a worktree (git deregister + branch delete + dir sweep). Refuses if a live instance ' +
        'is attached or the working tree is dirty unless force:true.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['project', 'worktree'],
      },
      handler: h.deleteWorktree,
      annotations: { destructiveHint: true },
    },
    {
      name: 'sync_worktree',
      description:
        'Bring a worktree up to date with its base branch — server-side fast-forward when possible; ' +
        'otherwise attempts an automatic git rebase and only sends a rebase prompt to the worktree\'s ' +
        'live agent when conflicts block the rebase. Caller passes the worktree\'s attached instance id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Instance id attached to the worktree.' } },
        required: ['id'],
      },
      handler: h.syncWorktree,
    },
    {
      name: 'merge_worktree',
      description:
        'Merge a worktree\'s branch into its parent repo with a real merge commit (--no-ff). ' +
        'Refuses with a friendly reason if the worktree hasn\'t been synced first. ' +
        'Pass either {id} or {project, worktree} — the latter form lets you ' +
        'merge a worktree whose instance has already been killed.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Live or dead instance attached to the worktree.' },
          project: { type: 'string', description: 'Parent project — required if id is omitted.' },
          worktree: { type: 'string', description: 'Worktree dir name — required if id is omitted.' },
        },
      },
      handler: h.mergeWorktree,
      annotations: { destructiveHint: true },
    },
    {
      name: 'list_workspaces',
      description:
        'List every workspace — both registered (in the central store\'s workspaces.json) ' +
        'and derived (referenced by any project\'s `workspace` field). Returns ' +
        '[{name, projectCount}] sorted alphabetically. Empty workspaces appear with projectCount 0.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listWorkspaces,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_workspace',
      description:
        'Register a workspace name so it appears in the sidebar even before any project joins it. ' +
        'Idempotent — calling on an existing name is a no-op (added:false). Workspace names allow ' +
        'spaces, slashes, dots, hyphens, underscores (1–40 chars, no control chars).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
        required: ['name'],
      },
      handler: h.createWorkspace,
      annotations: { idempotentHint: true },
    },
    {
      name: 'delete_workspace',
      description:
        'Remove a workspace from the registry and clear the `workspace` field on every project ' +
        'that currently points at it. The projects themselves are untouched; they fall back to ' +
        'unassigned. Returns {removed, name, clearedProjects: string[]}.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: h.deleteWorkspace,
      annotations: { idempotentHint: true },
    },
    {
      name: 'rename_workspace',
      description:
        'Atomically rename a workspace: rewrites every member project\'s `workspace` field and ' +
        'swaps the entry in the registry. No-op (renamed:false) when old and new names match. ' +
        'Returns {renamed, name, movedProjects: string[]}.',
      inputSchema: {
        type: 'object',
        properties: {
          oldName: { type: 'string' },
          newName: { type: 'string' },
        },
        required: ['oldName', 'newName'],
      },
      handler: h.renameWorkspace,
      annotations: { idempotentHint: true },
    },
    {
      name: 'set_project_workspace',
      description:
        'Assign a project to a workspace, or clear the assignment with workspace:null (or ""). ' +
        'Non-null values are auto-registered so a freshly-named workspace appears in ' +
        'list_workspaces immediately. Refuses the hidden `.conduct` project.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          workspace: {
            type: ['string', 'null'],
            description: 'Target workspace name, or null/empty-string to clear the assignment.',
          },
        },
        required: ['project'],
      },
      handler: h.setProjectWorkspace,
      annotations: { idempotentHint: true },
    },
    {
      name: 'create_project',
      description:
        'Create a new empty project under ~/project/<name>. Seeds CLAUDE.md with @../CLAUDE.md ' +
        'so workspace-wide conventions are inherited. Optionally runs `git init` in the new dir.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$', description: 'Project name. Must match ^[a-zA-Z0-9._-]+$.' },
          gitInit: { type: 'boolean', default: false, description: 'If true, run `git init` in the new project dir. Default false.' },
        },
        required: ['name'],
      },
      handler: h.createProject,
    },
    {
      name: 'get_recent_messages',
      description:
        'Return the most recent assistant message(s) from an instance. Each message has: ' +
        '`text` (full joined prose), `hasToolUse` (boolean), `msgId`, and optionally `blocks`, `plan`, `questions`. ' +
        '`blocks` is present only when non-text blocks exist and contains only `tool_use` and ' +
        '`thinking` entries — text content is fully represented by `text` and is not duplicated ' +
        'in `blocks`; ExitPlanMode and AskUserQuestion tool_use blocks are likewise not duplicated ' +
        'in `blocks[]` when their content is represented by `plan` / `questions`. ' +
        '`plan` (string) is present when the turn called ExitPlanMode with an inline plan. ' +
        '`questions` (array) is present when the turn called AskUserQuestion. ' +
        'By default, messages are returned when they have text, a plan, or questions — ' +
        'tool-call-only messages with none of those are excluded. Set `includeToolCalls` to true to ' +
        'include every assistant message regardless. Thinking blocks are excluded by default; ' +
        'set `includeThinking` to true to include them in `blocks[]`. `count` applies to the filtered set. ' +
        'DISK-BACKED & ring-first: served from the in-memory ring on the hot path; if the ring\'s retained ' +
        'tail can\'t satisfy the requested recent TEXT messages (tool-event volume evicted them) it transparently ' +
        'reads back into the on-disk session transcript — so ring eviction never yields a false-empty result. ' +
        'OUTPUT: a compact-JSON metadata block (content[0]) {id, messages:[{index, msgId, hasToolUse, textChars, ' +
        'textTruncated, plan?, questions?, blocks?}], source:"ring"|"disk", omittedToolOnly:int, retained:{firstSeq, ' +
        'lastSeq, trimmed}, hint?} oldest-first, PLUS one raw, un-escaped text block per message (content[k+1] is the ' +
        'prose for messages[k]; empty for plan/question-only turns). `omittedToolOnly` counts recent tool-call-only ' +
        'messages excluded by the default filter (the agent is active even when messages[] is empty); `hint` explains ' +
        'a short/empty result. Large message text is capped (textTruncated); blocks[].input is capped inline ' +
        '(inputTruncated). Default count 1, max 50.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id.' },
          count: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: 'Number of recent messages to return (from the filtered set). Default 1, clamped to [1, 50].' },
          includeToolCalls: { type: 'boolean', default: false, description: 'When true, include tool-call-only messages (no text blocks) in the result. Default false.' },
          includeThinking: { type: 'boolean', default: false, description: 'When true, include thinking blocks in blocks[]. Default false.' },
        },
        required: ['id'],
      },
      handler: h.getRecentMessages,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'project_status',
      description:
        'Read-only introspection for a project (or one of its worktrees): top-level file ' +
        'listing, git branch + HEAD subject, uncommitted lines (`git status --porcelain`), ' +
        'recent commits (`git log`), and — for worktrees — mergeStatus (ahead/behind) plus a ' +
        'diff-stat against the base branch. Useful for reviewing what an agent did without ' +
        'leaving MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string', description: 'Optional worktree name to scope into.' },
          logLimit: { type: 'integer', default: 20, description: 'Number of recent commits to include. Default 20. 0 disables.' },
        },
        required: ['project'],
      },
      handler: h.projectStatus,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_worktree_diff',
      description:
        'Return the unified diff of <baseRef>...HEAD in a worktree. baseRef defaults to the worktree\'s recorded ' +
        'baseBranch (the branch it was created from); contextLines (0-50, default 3) sets hunk context. Three modes ' +
        'keep this usable at any size: (1) summary:true returns a structured per-file stat ' +
        '{totals, files:[{path,status,oldPath?,additions,deletions,binary}]} instead of a diff — always small, never ' +
        'truncated, single JSON block. (2) paths:[...] scopes the diff (or summary) to specific file paths. (3) the diff is ' +
        'paginated by LINE INDEX: each call returns at most ~200 KB of whole lines starting at offset (0-based line index, ' +
        'default 0). In diff mode the OUTPUT is a compact-JSON metadata block (content[0]) {project, worktree, baseRef, ' +
        'head:<sha>, contextLines, offset, truncated, nextOffset, totalLines, totalBytes, includedFiles?, omittedFiles?} PLUS ' +
        'a separate raw, un-escaped diff text block (content[1]); when truncated, re-call with offset:nextOffset until ' +
        'truncated:false. Mid-file pages re-emit the file/hunk headers so each page parses standalone, and a truncated ' +
        'page lists includedFiles/omittedFiles. Never silently cuts. Complements project_status.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string' },
          baseRef: { type: 'string', description: 'Optional ref to diff against. Defaults to the worktree\'s baseBranch.' },
          contextLines: { type: 'integer', minimum: 0, maximum: 50, default: 3, description: 'Lines of context around each hunk (0-50, default 3).' },
          summary: { type: 'boolean', default: false, description: 'Return a per-file stat (totals + files[]) instead of a diff. Always small; never truncated.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff (or summary) to these file paths.' },
          offset: { type: 'integer', minimum: 0, default: 0, description: '0-based line index into the diff to start this page at (default 0). Use nextOffset from the previous call to paginate.' },
        },
        required: ['project', 'worktree'],
      },
      handler: h.getWorktreeDiff,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'read_file',
      description:
        'Read a file from a project or worktree by its project-relative path. Path-traversal ' +
        'guarded. OUTPUT: a compact-JSON metadata block (content[0]) {path, size, truncated, encoding, lineCount, ' +
        'lineCountExact, startLine?, endLine?} PLUS a separate raw, un-escaped text block (content[1]) carrying the ' +
        'file body. `lineCountExact` is false when the fast byte-capped read may have a partial final line. Supports ' +
        '`offset` (1-based start line, default 1) and `limit` (max lines, default: to EOF) for range reads. Set ' +
        '`lineNumbers:true` to prefix each line with a right-aligned number and tab (cat -n style, absolute to the ' +
        'full file). Metadata includes `startLine`/`endLine` when a range is requested. Binary files come back as a ' +
        'base64 body with encoding:"base64" — line params are ignored for binary. Content is byte-capped at maxBytes ' +
        '(default 256 KB); the `truncated` flag tells you when that happened.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string', description: 'Optional worktree name to scope into.' },
          relativePath: { type: 'string', description: 'Path relative to the project / worktree root.' },
          maxBytes: { type: 'integer', minimum: 1, default: 262144, description: 'Cap on bytes returned. Default 262144 (256 KB). For text with line params, applied as a final byte-cap on the assembled slice.' },
          lineNumbers: { type: 'boolean', default: false, description: 'When true, prefix each line with a right-aligned line number and tab (cat -n style). Numbers are absolute to the full file. Ignored for binary files. Default false.' },
          offset: { type: 'integer', minimum: 1, default: 1, description: '1-based line number to start at (default 1). Ignored for binary files.' },
          limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return (default: to end of file). Ignored for binary files.' },
        },
        required: ['project', 'relativePath'],
      },
      handler: h.readFile,
      annotations: { readOnlyHint: true },
    },
  ];
}
