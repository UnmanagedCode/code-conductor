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
    },
    {
      name: 'list_instances',
      description:
        'List every live or recently-exited orchestrator instance. Each entry carries ' +
        '{id, project, sessionId, status, mode, effort, thinking, model, pid, worktree, temp, debug}.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listInstances,
    },
    {
      name: 'list_sessions',
      description:
        'List persisted Claude sessions for a project, or for a specific worktree inside it. ' +
        'Returns [{sessionId, firstPrompt, mtime, size}] newest-first.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name under ~/project/.' },
          worktree: { type: 'string', description: 'Optional worktree name (the sibling dir, e.g. "demo_worktree_abc123").' },
        },
        required: ['project'],
      },
      handler: h.listSessions,
    },
    {
      name: 'locate_session',
      description:
        'Find which project (and optionally which worktree) owns a given sessionId, by ' +
        'probing the conventional ~/.claude/projects/<encoded-cwd>/<sid>.jsonl path against ' +
        'every known project + worktree. Returns {project, worktreeName: string|null}. ' +
        'Errors with "session not found" when nothing matches.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session UUID to locate.' },
        },
        required: ['sessionId'],
      },
      handler: h.locateSession,
    },
    {
      name: 'list_worktrees',
      description:
        'List orchestrator-owned git worktrees for a project. Each entry includes ' +
        '{worktreeName, branch, baseBranch, baseSha, parentPath, createdAt}.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      handler: h.listWorktrees,
    },
    {
      name: 'get_transcript',
      description:
        'Return the orchestrator UI-event ring for an instance. Each event carries _seq so ' +
        'you can poll incrementally with sinceSeq. Events include text_delta, tool_use, ' +
        'tool_result, turn_end, etc. — same shape as the WebSocket snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id.' },
          sinceSeq: { type: 'integer', description: 'Return only events with _seq > sinceSeq. Default -1 (all).' },
          limit: { type: 'integer', description: 'Cap on number of events returned. Default 200.' },
        },
        required: ['id'],
      },
      handler: h.getTranscript,
    },
    {
      name: 'spawn_instance',
      description:
        'Spawn a new Claude subprocess inside a project (optionally inside a new or existing git worktree of it). ' +
        'Returns the instance summary. CAUTION: an instance with the code-conductor MCP registered can in turn spawn ' +
        'further instances — guard against runaway recursion by defaulting child agents to plan mode.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          mode: { type: 'string', enum: VALID_MODES, description: 'plan / ask / bypassPermissions. Defaults to plan (or bypassPermissions when temp:true).' },
          effort: { type: 'string', enum: VALID_EFFORTS },
          thinking: { type: 'string', enum: VALID_THINKING },
          model: { type: 'string', description: 'e.g. claude-sonnet-4-6 / claude-opus-4-8 / claude-haiku-4-5. Empty/omitted uses account default.' },
          resume: { type: 'string', description: 'Optional sessionId to resume (vs. spawning a fresh session).' },
          worktree: {
            type: ['boolean', 'string'],
            description: 'true → create a fresh worktree off the project\'s HEAD. <name> → spawn into an existing worktree.',
          },
          temp: { type: 'boolean', description: 'If true, the session jsonl is removed on subprocess exit.' },
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
        'Pass wait:true to block until the turn ends and return the turn_end event inline.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          wait: { type: 'boolean', description: 'Block until turn_end. Default false.' },
          waitTimeoutMs: { type: 'integer', description: 'Per-call wait cap (default 600000 = 10 min).' },
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
          timeoutMs: { type: 'integer', description: 'Default 600000 (10 min) — matches send_prompt\'s wait cap.' },
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
          instanceId: { type: 'string', description: 'Instance id of the worker whose plan you\'re approving.' },
          feedback: { type: 'string', description: 'Optional additional notes appended to the approval message.' },
        },
        required: ['instanceId'],
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
          instanceId: { type: 'string', description: 'Instance id of the worker whose plan you\'re rejecting.' },
          feedback: { type: 'string', description: 'What you want the worker to change. Strongly recommended.' },
        },
        required: ['instanceId'],
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
          instanceId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['instanceId', 'enabled'],
      },
      handler: h.setAutoApprovePlan,
    },
    {
      name: 'subscribe_to_idle',
      description:
        'Register a one-shot callback: when the target instance next emits turn_end, the orchestrator ' +
        'injects a short stub user prompt into the *calling* instance pointing at get_recent_messages. ' +
        'Use this right after send_prompt({wait:false}) so you can hand control back to the user but still ' +
        'be re-woken when the worker finishes. The subscription is consumed on fire — call again to watch ' +
        'further turns. Caller identity is taken from the MCP URL (?caller=<id>), so this only works for ' +
        'orchestrator-spawned instances.',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Instance id of the worker to watch for turn_end.' },
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
    },
    {
      name: 'interrupt_turn',
      description: 'Abort the current turn of a running instance (control_request interrupt).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
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
          worktreeName: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['project', 'worktreeName'],
      },
      handler: h.deleteWorktree,
    },
    {
      name: 'sync_worktree',
      description:
        'Bring a worktree up to date with its base branch — server-side fast-forward when possible, ' +
        'otherwise sends a rebase prompt to the worktree\'s live agent. Caller passes the worktree\'s ' +
        'attached instance id.',
      inputSchema: {
        type: 'object',
        properties: { instanceId: { type: 'string' } },
        required: ['instanceId'],
      },
      handler: h.syncWorktree,
    },
    {
      name: 'merge_worktree',
      description:
        'Merge a worktree\'s branch into its parent repo with a real merge commit (--no-ff). ' +
        'Refuses with a friendly reason if the worktree hasn\'t been synced first. ' +
        'Pass either {instanceId} or {project, worktreeName} — the latter form lets you ' +
        'merge a worktree whose instance has already been killed.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: 'Live or dead instance attached to the worktree.' },
          project: { type: 'string', description: 'Parent project — required if instanceId is omitted.' },
          worktreeName: { type: 'string', description: 'Worktree dir name — required if instanceId is omitted.' },
        },
      },
      handler: h.mergeWorktree,
    },
    {
      name: 'list_workspaces',
      description:
        'List every workspace — both registered (in the central store\'s workspaces.json) ' +
        'and derived (referenced by any project\'s `workspace` field). Returns ' +
        '[{name, projectCount}] sorted alphabetically. Empty workspaces appear with projectCount 0.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listWorkspaces,
    },
    {
      name: 'create_workspace',
      description:
        'Register a workspace name so it appears in the sidebar even before any project joins it. ' +
        'Idempotent — calling on an existing name is a no-op (added:false). Workspace names allow ' +
        'spaces, slashes, dots, hyphens, underscores (1–40 chars, no control chars).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: h.createWorkspace,
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
    },
    {
      name: 'create_project',
      description:
        'Create a new empty project under ~/project/<name>. Seeds CLAUDE.md with @../CLAUDE.md ' +
        'so workspace-wide conventions are inherited. Optionally runs `git init` in the new dir.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name. Must match ^[a-zA-Z0-9._-]+$.' },
          gitInit: { type: 'boolean', description: 'If true, run `git init` in the new project dir. Default false.' },
        },
        required: ['name'],
      },
      handler: h.createProject,
    },
    {
      name: 'get_recent_messages',
      description:
        'Return the most recent assistant message(s) from an instance as joined strings plus ' +
        'structured blocks (text / tool_use / thinking). By default, only messages that contain ' +
        'actual text are returned — tool-call-only messages (no text blocks) are excluded. Set ' +
        '`includeToolCalls` to true to include every assistant message regardless. `count` ' +
        'applies to the filtered set: "count: 5" yields up to 5 messages with text. Returns a ' +
        '`messages[]` array, oldest-first (default 1, max 50). Empty messages[] if no matching ' +
        'content has arrived yet.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Instance id.' },
          count: { type: 'integer', description: 'Number of recent messages to return (from the filtered set). Default 1, clamped to [1, 50].' },
          includeToolCalls: { type: 'boolean', description: 'When true, include tool-call-only messages (no text blocks) in the result. Default false.' },
        },
        required: ['id'],
      },
      handler: h.getRecentMessages,
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
          logLimit: { type: 'integer', description: 'Number of recent commits to include. Default 20. 0 disables.' },
        },
        required: ['project'],
      },
      handler: h.projectStatus,
    },
    {
      name: 'get_worktree_diff',
      description:
        'Return the full unified diff of <baseRef>...HEAD in a worktree. baseRef defaults to the worktree\'s ' +
        'recorded baseBranch (the branch it was created from). Output is capped at ~200 KB — when truncated, ' +
        'follow up with read_file on specific files. Complements project_status, which only returns the diff ' +
        'stat.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktreeName: { type: 'string' },
          baseRef: { type: 'string', description: 'Optional ref to diff against. Defaults to the worktree\'s baseBranch.' },
          contextLines: { type: 'integer', description: 'Lines of context around each hunk (0-50, default 3).' },
        },
        required: ['project', 'worktreeName'],
      },
      handler: h.getWorktreeDiff,
    },
    {
      name: 'read_file',
      description:
        'Read a file from a project or worktree by its project-relative path. Path-traversal ' +
        'guarded. UTF-8 text returned inline; binary files come back base64-encoded. Truncated ' +
        'at maxBytes (default 256 KB) — the `truncated` flag tells you when that happened.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string', description: 'Optional worktree name to scope into.' },
          relativePath: { type: 'string', description: 'Path relative to the project / worktree root.' },
          maxBytes: { type: 'integer', description: 'Cap on bytes read. Default 262144 (256 KB).' },
        },
        required: ['project', 'relativePath'],
      },
      handler: h.readFile,
    },
  ];
}
