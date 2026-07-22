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
        'live session ids, and a session-count summary.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listProjects,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_instances',
      description:
        'List every live or recently-exited orchestrator worker. Each entry carries ' +
        '{project, sessionId, status, mode, effort, thinking, model, pid, worktree, temp, conducted, debug, hasIdleSubscriber}. ' +
        'sessionId is the stable handle for every worker-addressing tool. ' +
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
        'Archived sessions (killed and retained but hidden from the active list) are excluded by default. ' +
        'Pass `includeArchived:true` to include them; they will have `archived:true` in the result.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name under ~/project/.' },
          worktree: { type: 'string', description: 'Optional worktree name (the sibling dir, e.g. "demo_worktree_abc123").' },
          includeArchived: { type: 'boolean', description: 'Include archived sessions in the result (default false).' },
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
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          sinceSeq: { type: 'integer', default: -1, description: 'Return events with _seq > sinceSeq (forward, oldest-first). Default -1 → newest page. Pass the previous call\'s nextAfter to poll incrementally.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: 'Max events returned per call (clamped to [1, 500]). Use nextAfter + hasMore to page.' },
        },
        required: ['sessionId'],
      },
      handler: h.getTranscript,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'spawn_instance',
      description:
        'Spawn a new Claude subprocess inside a project (optionally inside a new or existing git worktree of it). ' +
        'Returns the worker summary — capture the returned `sessionId`, the stable handle every other ' +
        'worker-addressing tool takes. Pass createWorktree:true to create a fresh worktree off HEAD, or ' +
        'worktree:"<name>" to attach to an existing one (createWorktree wins if both are given). ' +
        'Defaults to temp:true (disposable worker) but mode still defaults to plan ' +
        '(NOT bypassPermissions) so workers plan before acting — promote with promote_session to keep one. ' +
        'project is required for a fresh spawn, but optional when resume is given: if worktree is also ' +
        'omitted, the session\'s recorded project + worktree are recovered automatically so ' +
        'spawn_instance({resume:sessionId}) alone re-attaches the right cwd/branch and its prior history. ' +
        'CAUTION: an instance with the code-conductor MCP registered can in turn spawn ' +
        'further instances — guard against runaway recursion by keeping child agents in plan mode.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Required for a fresh spawn. Optional when resume is given — recovered from the session\'s recorded location if worktree is also omitted.' },
          mode: { type: 'string', enum: VALID_MODES, description: 'plan / ask / bypassPermissions. Defaults to plan, independent of temp (resume defaults to bypassPermissions).' },
          effort: { type: 'string', enum: VALID_EFFORTS },
          thinking: { type: 'string', enum: VALID_THINKING },
          model: {
            type: 'string',
            description:
              'A capability tier (fast / balanced / powerful / frontier — the primary vocabulary), a role, ' +
              'or a specific model id to pin one exact model. Empty/omitted uses the account default.',
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
        required: [],
      },
      handler: h.spawnInstance,
    },
    {
      name: 'send_prompt',
      description:
        'Send a user turn to a running instance. Defaults to wait:false (returns immediately). ' +
        'Pass wait:true to block until the turn ends and return the turn_end event inline. ' +
        'A mid-turn send_prompt is delivered live into the running turn (not queued), so it can steer a worker in flight. ' +
        'Also auto-subscribes to the worker\'s idle callback by default (dispatch-and-wake) — see `subscribe`. ' +
        'Skipped automatically when wait:true, since the turn already resolves inline.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          text: { type: 'string' },
          wait: { type: 'boolean', default: false, description: 'Block until turn_end. Default false.' },
          waitTimeoutMs: { type: 'integer', default: 600000, description: 'Per-call wait cap (default 600000 = 10 min).' },
          subscribe: {
            type: 'boolean', default: true,
            description: "Also register a one-shot idle callback (dispatch-and-wake) so you're re-woken on the worker's next turn_end. Default true. Pass false for mid-turn steers / fire-and-forget. Ignored (never subscribes) when wait:true.",
          },
          subscribeTimeoutMs: {
            type: 'integer',
            description: 'Watchdog: wake with a non-completion "did NOT finish" stub if the worker+subagents-done state is never reached (hang/crash). Defaults to 30 min (ORCH_SUBSCRIBE_TIMEOUT_MS) when omitted; an explicit value overrides. Same semantics as subscribe_to_idle timeoutMs.',
          },
        },
        required: ['sessionId', 'text'],
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
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          timeoutMs: { type: 'integer', default: 600000, description: 'Default 600000 (10 min) — matches send_prompt\'s wait cap.' },
        },
        required: ['sessionId'],
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
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          mode: { type: 'string', enum: VALID_MODES },
        },
        required: ['sessionId', 'mode'],
      },
      handler: h.setMode,
      annotations: { idempotentHint: true },
    },
    {
      name: 'approve_plan',
      description:
        'Approve a worker\'s plan: flips the instance to bypassPermissions and sends the canonical approval ' +
        'prompt as a normal user turn. Mirrors the UI\'s Approve & Implement button — use this rather than ' +
        'driving set_mode + send_prompt by hand. Optional `feedback` is appended to the approval message. ' +
        'Also auto-subscribes to the worker\'s idle callback by default (dispatch-and-wake) — see `subscribe`.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId of the worker whose plan you\'re approving.' },
          feedback: { type: 'string', description: 'Optional additional notes appended to the approval message.' },
          subscribe: {
            type: 'boolean', default: true,
            description: "Also register a one-shot idle callback (dispatch-and-wake) so you're re-woken on the worker's next turn_end. Default true.",
          },
          subscribeTimeoutMs: {
            type: 'integer',
            description: 'Watchdog: wake with a non-completion "did NOT finish" stub if the worker+subagents-done state is never reached (hang/crash). Defaults to 30 min (ORCH_SUBSCRIBE_TIMEOUT_MS) when omitted; an explicit value overrides. Same semantics as subscribe_to_idle timeoutMs.',
          },
        },
        required: ['sessionId'],
      },
      handler: h.approvePlan,
    },
    {
      name: 'reject_plan',
      description:
        'Reject a worker\'s plan and ask for refinement. The instance stays in plan mode; the worker will ' +
        'produce a revised plan in its next turn. `feedback` is recommended — without it the worker has no ' +
        'guidance for what to change. Also auto-subscribes to the worker\'s idle callback by default ' +
        '(dispatch-and-wake) — see `subscribe`.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId of the worker whose plan you\'re rejecting.' },
          feedback: { type: 'string', description: 'What you want the worker to change. Strongly recommended.' },
          subscribe: {
            type: 'boolean', default: true,
            description: "Also register a one-shot idle callback (dispatch-and-wake) so you're re-woken on the worker's next turn_end. Default true.",
          },
          subscribeTimeoutMs: {
            type: 'integer',
            description: 'Watchdog: wake with a non-completion "did NOT finish" stub if the worker+subagents-done state is never reached (hang/crash). Defaults to 30 min (ORCH_SUBSCRIBE_TIMEOUT_MS) when omitted; an explicit value overrides. Same semantics as subscribe_to_idle timeoutMs.',
          },
        },
        required: ['sessionId'],
      },
      handler: h.rejectPlan,
    },
    {
      name: 'answer_question',
      description:
        'Answer a worker\'s AskUserQuestion with a STRUCTURED answer — the byte-identical analog of the UI ' +
        'question card, so the worker can\'t tell a UI answer from an MCP one. Use this rather than a free-text ' +
        'send_prompt when a wake shows a `questions` field. `answers` is aligned by index to those questions ' +
        '(in order); each entry is { option } for single-choice, { options: [...] } for multiSelect, ' +
        '{ text } for a custom typed answer, or {} to skip — with an optional `note` on option/options. ' +
        'Also auto-subscribes to the worker\'s idle callback by default (dispatch-and-wake) — see `subscribe`.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId whose question you\'re answering.' },
          answers: {
            type: 'array',
            description: 'One entry per pending question, in the order returned by get_recent_messages\' `questions` field.',
            items: {
              type: 'object',
              properties: {
                option: { type: 'string', description: 'Chosen option label (single-choice question).' },
                options: { type: 'array', items: { type: 'string' }, description: 'Chosen option labels (multiSelect question).' },
                text: { type: 'string', description: 'Custom free-text answer (overrides option/options).' },
                note: { type: 'string', description: 'Optional note appended to an option/options answer.' },
              },
            },
          },
          subscribe: {
            type: 'boolean', default: true,
            description: "Also register a one-shot idle callback (dispatch-and-wake) so you're re-woken on the worker's next turn_end. Default true.",
          },
          subscribeTimeoutMs: {
            type: 'integer',
            description: 'Watchdog: wake with a non-completion "did NOT finish" stub if the worker+subagents-done state is never reached (hang/crash). Defaults to 30 min (ORCH_SUBSCRIBE_TIMEOUT_MS) when omitted; an explicit value overrides. Same semantics as subscribe_to_idle timeoutMs.',
          },
        },
        required: ['sessionId', 'answers'],
      },
      handler: h.answerQuestion,
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
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          enabled: { type: 'boolean' },
        },
        required: ['sessionId', 'enabled'],
      },
      handler: h.setAutoApprovePlan,
      annotations: { idempotentHint: true },
    },
    {
      name: 'subscribe_to_idle',
      description:
        'Register a one-shot callback: when the target instance next ends a turn WITH no live background ' +
        'subagents (its own backgrounded Agent-tool calls all finished), the orchestrator injects a short ' +
        'stub user prompt into the *calling* instance pointing at get_recent_messages. The wake thus means ' +
        'the worker AND all its subagents are done — a turn_end while a subagent is still running defers the ' +
        'wake until the follow-up turn_end after that subagent completes. ' +
        'Use this right after send_prompt({wait:false}) so you can hand control back to the user but still ' +
        'be re-woken when the worker finishes. The subscription is consumed on fire — call again to watch ' +
        'further turns. Caller identity is taken from the MCP URL (?caller=<sessionId>), so this only works for ' +
        'orchestrator-spawned instances. ' +
        'A timeoutMs watchdog is ALWAYS armed (default 30 min, ORCH_SUBSCRIBE_TIMEOUT_MS; an explicit value ' +
        'overrides): if the agent+subagents-done state is not reached in time, the subscription fires with a ' +
        'timeout-flagged stub that says the worker did NOT finish, so a hung/crashed worker (or a stuck ' +
        'subagent) still wakes you. Whichever fires first (completion or timeout) consumes the subscription ' +
        'and cancels the other.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId to watch for turn_end.' },
          timeoutMs: {
            type: 'number',
            minimum: 1,
            description:
              'Watchdog override: fire the subscription after this many ms even if the agent+subagents-done ' +
              'state has not been reached. Must be a positive finite number; omitted/invalid falls back to ' +
              'the 30-min default (ORCH_SUBSCRIBE_TIMEOUT_MS). The stub injected on timeout is clearly ' +
              'labelled as a timeout (not a completion) so the conductor can distinguish a timed-out worker ' +
              'from a finished one.',
          },
        },
        required: ['sessionId'],
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
        properties: { sessionId: { type: 'string', description: 'Worker sessionId.' } },
        required: ['sessionId'],
      },
      handler: h.unsubscribeFromIdle,
      annotations: { idempotentHint: true },
    },
    {
      name: 'renew_session',
      description:
        'Renew your OWN session. Hand off a self-authored summary; code-conductor then clears your ' +
        'accumulated context in place — SAME session process, fresh conversation (a managed /clear, not a ' +
        'restart) — and seeds the cleared session with your summary (plus a server-generated block of live ' +
        'instance/subscription state, see below) as its first turn. ' +
        'When to use: after landing and cleaning up a job, when history about finished work is dead weight ' +
        'taxing every future turn — renew at lifecycle seams, not because context is "full". ' +
        'The clear happens when your CURRENT turn ends: after calling this, end your turn WITHOUT starting new ' +
        'work — anything you do after this call is discarded by the clear. Your summary (plus the appended ' +
        'mechanical state block) is the ONLY thing carried across, so write everything the fresh session needs. ' +
        'Caller identity is taken from the MCP URL: this always acts on the calling session and only works for ' +
        'a code-conductor-managed instance. It stays valid across repeated renewal, so a long-lived session ' +
        'can renew more than once.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            minLength: 1,
            description:
              'The handoff summary, seeded as the first user turn of the cleared session (the server appends ' +
              'a mechanical state block after it — do not re-enumerate live instances yourself, carry intent ' +
              'and meaning instead). Structure it in three sections: ' +
              '(1) Live work roster — per still-running worker: sessionId, project/worktree, task, state, ' +
              'agreed sentinel, next action. ' +
              '(2) Completed work index — one line per landed job: outcome + pointers to where details live ' +
              '(merge sha, worktree name, worker sessionId — transcripts and diffs remain recoverable from ' +
              'these). ' +
              '(3) User context — stated preferences, decisions made, pending promises. ' +
              'Write it as a note to your future self: everything not captured here is lost when the context ' +
              'clears.',
          },
        },
        required: ['summary'],
      },
      handler: h.renewSession,
    },
    {
      name: 'interrupt_turn',
      description: 'Stop the current turn of a running instance. Default (soft) injects a hidden steering message asking the model to stop work and end its turn gracefully. Pass force:true for a hard control_request abort that severs the turn and discards partial work.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          force: { type: 'boolean', default: false, description: 'true = hard abort; omitted/false = soft graceful stop' },
        },
        required: ['sessionId'],
      },
      handler: h.interruptTurn,
    },
    {
      name: 'kill_instance',
      description: 'Terminate a running worker subprocess and remove it from the manager. ' +
        'LIVE-only: addresses the worker by sessionId and only acts on a running instance.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Worker sessionId.' } },
        required: ['sessionId'],
      },
      handler: h.killInstance,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    {
      name: 'respawn_instance',
      description:
        'Respawn an exited/crashed worker against its sessionId (--resume). The in-memory ' +
        'event ring is preserved across the respawn. Requires an in-memory instance for the ' +
        'session (a recently-exited one); to bring back a session with no in-memory instance ' +
        'use spawn_instance({resume:sessionId}).',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Worker sessionId.' } },
        required: ['sessionId'],
      },
      handler: h.respawnInstance,
    },
    {
      name: 'promote_session',
      description:
        'Promote a temp session to a persistent one: flips temp=false and writes last-prompt + ' +
        'permission-mode so `claude --resume` finds it (emits a status update). Refuses if the ' +
        'session is unknown / not live, and errors if the session is not temp.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Worker sessionId of the temp session to keep.' } },
        required: ['sessionId'],
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
        'is attached or the working tree is dirty unless force:true (which kills any attached instance first).',
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
        'live agent when conflicts block the rebase. Caller passes the worktree\'s attached worker sessionId.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Worker sessionId attached to the worktree.' } },
        required: ['sessionId'],
      },
      handler: h.syncWorktree,
    },
    {
      name: 'merge_worktree',
      description:
        'Merge a worktree\'s branch into its parent repo with a real merge commit (--no-ff), then ' +
        'fast-forwards the worktree\'s own branch onto that merge commit so the same worktree stays ' +
        'mergeable again later. Refuses with a friendly reason if the worktree hasn\'t been synced ' +
        'first (WORKTREE_BEHIND), the parent is on the wrong branch or dirty (BASE_BRANCH_MISMATCH / ' +
        'PARENT_DIRTY), the worktree\'s own tree has uncommitted or untracked changes that would not ' +
        'land (WORKTREE_DIRTY — pass allowDirty:true to merge anyway), or the branch has no commits ' +
        'to merge (NOTHING_TO_MERGE). Pass either {sessionId} (live worker) or {project, worktree} — ' +
        'the latter form lets you merge a worktree whose worker has already been killed.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Live worker sessionId attached to the worktree.' },
          project: { type: 'string', description: 'Parent project — required if sessionId is omitted.' },
          worktree: { type: 'string', description: 'Worktree dir name — required if sessionId is omitted.' },
          allowDirty: { type: 'boolean', description: 'Merge even though the worktree has uncommitted/untracked changes (they will not be included in the merge commit).' },
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
        'so workspace-wide conventions are inherited. Optionally runs `git init` in the new dir. ' +
        'Project conventions can be attached by passing their slugs — call list_project_conventions to ' +
        'discover available slugs. Each carries a CLAUDE.md fragment (appended inline) and/or a one-time ' +
        'scaffold directive: a picked convention flagged hasScaffold:true composes a setup directive that is ' +
        'RETURNED as this tool\'s `scaffold` field (empty when none), which YOU fold into your FIRST send_prompt ' +
        'to the project\'s first worker (it is never auto-sent).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$', description: 'Project name. Must match ^[a-zA-Z0-9._-]+$.' },
          gitInit: { type: 'boolean', default: false, description: 'If true, run `git init` in the new project dir. Default false.' },
          conventions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Slugs of project conventions to attach — call list_project_conventions to discover available slugs. Each appends its CLAUDE.md fragment (if any) and, when hasScaffold:true, contributes to the returned `scaffold` directive.',
          },
        },
        required: ['name'],
      },
      handler: h.createProject,
    },
    {
      name: 'list_project_conventions',
      description:
        'List the available project conventions (slug, name, description, builtin, hasScaffold) that can be ' +
        'passed to create_project\'s `conventions` param. Built-in seeds have builtin:true and are read-only; ' +
        'custom conventions (builtin:false) are managed via the Settings → Conventions → Project panel; ' +
        'enabled-plugin conventions have namespaced <plugin-id>/<slug> slugs. hasScaffold:true means picking it ' +
        'also triggers a one-time setup directive returned as create_project\'s `scaffold` field.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listProjectConventions,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_conductor_modules',
      description:
        'List the conductor convention modules (slug, name, description, builtin, enabled) composed into ' +
        '.conduct/CONDUCT.md. Built-in seeds have builtin:true; custom modules (builtin:false) and the ' +
        'enabled selection are managed via the Settings → Conductor conventions panel. The always-on core ' +
        'is not listed here.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listConductorModules,
      annotations: { readOnlyHint: true },
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
        'OUTPUT: a compact-JSON metadata block (content[0]) {sessionId, messages:[{index, msgId, hasToolUse, textChars, ' +
        'textTruncated, plan?, questions?, blocks?}], source:"ring"|"disk", omittedToolOnly:int, retained:{firstSeq, ' +
        'lastSeq, trimmed}, hint?} oldest-first, PLUS one raw, un-escaped text block per message (content[k+1] is the ' +
        'prose for messages[k], empty for a plan/question-only turn — UNLESS more than one message is returned, in ' +
        'which case each body is prefixed with "--- message i/N · msgId · textChars chars ---", and a text-less ' +
        'message\'s body is then just that line). `omittedToolOnly` counts recent tool-call-only ' +
        'messages excluded by the default filter (the agent is active even when messages[] is empty); `hint` explains ' +
        'a short/empty result. Large message text is capped (textTruncated); blocks[].input is capped inline ' +
        '(inputTruncated). Default count 1, max 50. ' +
        'DEFAULT-CALL BONDING: on the default call only (no `count` passed), if the last message is plain prose ' +
        'the selection is bonded back to the turn\'s `plan`/`questions` message and spans from it through the end ' +
        'of that turn — so a turn whose trailing prose spans several messages still surfaces the plan/questions ' +
        'together with all of it. The walk-back is scoped to the current turn (a plan from an earlier turn is never ' +
        'pulled in), and a message that already carries its own `plan`/`questions` is returned alone. Passing an ' +
        'explicit `count` (including `count:1`) disables this and returns exactly that many messages, literally.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          count: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: 'Number of recent messages to return (from the filtered set). Default 1, clamped to [1, 50].' },
          includeToolCalls: { type: 'boolean', default: false, description: 'When true, include tool-call-only messages (no text blocks) in the result. Default false.' },
          includeThinking: { type: 'boolean', default: false, description: 'When true, include thinking blocks in blocks[]. Default false.' },
        },
        required: ['sessionId'],
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
      name: 'project_diff',
      description:
        'Return the unified diff of <baseRef>...HEAD in a worktree, PLUS the working tree\'s uncommitted state. ' +
        'baseRef defaults to the worktree\'s recorded baseBranch (the branch it was created from); contextLines ' +
        '(0-50, default 3) sets hunk context. Three modes keep this usable at any size: (1) summary:true returns a ' +
        'structured per-file stat {totals, files:[{path,status,oldPath?,additions,deletions,binary}]} instead of a ' +
        'diff — always small, never truncated, single JSON block. (2) paths:[...] scopes the diff (or summary) to ' +
        'specific file paths. (3) the diff is paginated by LINE INDEX: each call returns at most ~200 KB of whole ' +
        'lines starting at offset (0-based line index, default 0). In diff mode the OUTPUT is a compact-JSON metadata ' +
        'block (content[0]) {project, worktree, baseRef, head:<sha>, contextLines, offset, truncated, nextOffset, ' +
        'totalLines, totalBytes, hasUncommittedChanges:bool, untracked:[paths], ahead, includedFiles?, omittedFiles?} ' +
        'PLUS a separate raw, un-escaped diff text block (content[1]); when truncated, re-call with offset:nextOffset ' +
        'until truncated:false. Mid-file pages re-emit the file/hunk headers so each page parses standalone, and a ' +
        'truncated page lists includedFiles/omittedFiles. Never silently cuts. Staged + unstaged changes vs HEAD ' +
        '(git diff HEAD) are always appended after the committed diff behind a `@@@ uncommitted working tree changes ' +
        '(git diff HEAD) @@@` separator whenever any exist (absent on a clean tree); untracked files never-git-added ' +
        'are always listed in `untracked`. summary:true likewise always includes `ahead` and an ' +
        '`uncommitted:{totals, files, untracked}` section. `ahead` is the commit count baseRef..HEAD — ahead:0 plus ' +
        'hasUncommittedChanges:true is the signal that nothing will land if you merge_worktree right now. ' +
        'Complements project_status.',
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
      handler: h.projectDiff,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'project_bash',
      description:
        'Read-only inspection only: run non-mutating commands (rg/grep/find, git log/diff, wc, jq, ' +
        '…); anything that writes files, installs dependencies, commits, or starts long-lived ' +
        'processes belongs in a spawned worker instead. Run a bash command inside a project or ' +
        'worktree directory, using the exact same shell environment claude\'s own built-in Bash ' +
        'tool uses — the rg/find/grep shims and shell functions/aliases from the captured shell ' +
        'snapshot (cached per claude version). Mirrors project/worktree for cwd scoping plus the ' +
        'meaningful subset of the built-in Bash tool (command/description/timeout). Replaces ' +
        'grep/glob — use rg/grep/find through this tool for search. OUTPUT: a compact-JSON ' +
        'metadata block (content[0]) {project, worktree, cwd, exitCode, durationMs, truncated?, ' +
        'timedOut?, error?} PLUS a separate raw, un-escaped text block (content[1]) carrying the ' +
        'combined stdout+stderr output, in arrival order. A non-zero exitCode is a normal result, ' +
        'not a tool error. truncated:true means retained output was capped at ~200 KB — the command ' +
        'still ran to completion; assume later output beyond the cap was lost, not that the process ' +
        'was killed. timeout is milliseconds (default 120000, max 600000 — larger values are ' +
        'clamped); on timeout (the only hard kill) the whole process group is killed, exitCode is ' +
        'null, and timedOut:true. stdin is not connected — an interactive command hangs until ' +
        'timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          project:  { type: 'string' },
          worktree: { type: 'string', description: 'Optional worktree name to scope into.' },
          command:  { type: 'string', description: 'The bash command to run.' },
          description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words. Unused server-side; accepted for schema parity with the built-in Bash tool.' },
          timeout:  { type: 'integer', minimum: 1, default: 120000, description: 'Timeout in milliseconds (max 600000). Values above 600000 are clamped.' },
        },
        required: ['project', 'command'],
      },
      handler: h.bashProject,
      // No readOnlyHint: doctrine-only — arbitrary bash isn't sandboxed, so a client shouldn't auto-approve it.
    },
    {
      name: 'project_read',
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
      handler: h.projectRead,
      annotations: { readOnlyHint: true },
    },
  ];
}
