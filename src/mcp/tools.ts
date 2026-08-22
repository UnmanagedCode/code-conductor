// MCP tool registry. Each entry is { name, description, inputSchema,
// handler }. Schemas are inline JSON-Schema objects (shallow-validated
// by ../mcp/server.ts). Handlers live in ./handlers.ts and reach into
// the orchestrator's existing modules — no business logic here.

import * as h from './handlers.ts';
import { EFFORT_LEVELS, DEFAULT_EFFORT } from '../effortLevels.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';

import { MODES as VALID_MODES } from '../sessionModes.ts';
// The heartbeat window's single source: its default IS the schema ceiling, so
// `idleTimeoutMs`/`timeoutMs` can only ever shorten it.
import { DEFAULT_SUBSCRIBE_TIMEOUT_MS } from '../idleSubscriptions.ts';
// The summary structure has ONE home (src/sessionRenew.ts) — the request prompt a
// conductor-triggered renewal sends carries the same text.
import { RENEW_SUMMARY_TEMPLATE } from '../sessionRenew.ts';

const VALID_THINKING = ['adaptive', 'enabled', 'disabled'];

// The per-call context the MCP server injects next to the args (mcp/server.ts).
interface ToolCtx {
  instances?: InstanceManagerLike | null;
  callerId?: string | null;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}

// A registered tool. `handler` is declared as a METHOD (not an arrow property)
// so its parameters are checked bivariantly: each handler in handlers.ts narrows
// its own argument shape (e.g. `{project: string}`), and the registry can only
// promise the schema-validated `args` the server passes. `args: unknown` is the
// honest boundary — an interface arg (SpawnArgs) has no implicit index signature
// to satisfy `Record<string, unknown>`. Runtime validation is the tool's
// JSON-Schema inputSchema (validateArgs in mcp/server.ts), not this type — the
// same boundary mcpBridge.ts draws with `(args: unknown, …)`.
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: unknown, ctx: ToolCtx): Promise<unknown>;
  annotations?: ToolAnnotations;
}

export function buildTools(): Tool[] {
  return [
    {
      name: 'list_projects',
      description:
        'List every project under the projects root as PLAIN TEXT (this tool returns no JSON). ' +
        'One block per project: its absolute path, workspace when set, session counts, a ' +
        'live-worker count, and each worktree with branch, base, ahead/behind and its path. ' +
        'list_sessions names those workers; this tool only counts them.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listProjects,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_sessions',
      description:
        'Every live orchestrator worker and every stopped session it could resume, as PLAIN TEXT ' +
        '(this tool returns no JSON), grouped by the directory the sessions live in: each ' +
        'project\'s main checkout first, then its worktrees. A group header carries its branch, ' +
        'ahead/behind, and `live N · inactive N · archived N`. ' +
        'Each LIVE worker summary is ' +
        '{project, cwd, sessionId, status, displayStatus, activeAgentTasks, mode, effort, thinking, ' +
        'backend, model, contextWindowTokens, pid, worktree, temp, conducted, debug, ' +
        'firstPrompt, title, lastRotatedAt, rotationReason, segmentCount, createdAt, ' +
        'lastResponseAt, queuedCount, autoResumeAt, ' +
        'overageActive, overageResetsAt, awaitingWake, playbook, stage}. ' +
        'Live rows lead their group, marked LIVE; inactive sessions follow as one line each — ' +
        'sessionId, last-activity, playbook/stage, flags, title — newest first. Last-activity is the ' +
        'timestamp on the session\'s own last record, so it is when that session actually ran. ' +
        'Their sessionIds still resume. ' +
        'sessionId is the stable handle for every worker-addressing tool. ' +
        '`playbook`/`stage` say where the session sits in its playbook graph, or null when it is not ' +
        'playbook-tracked; playbook_state gives the full run picture. ' +
        '`conducted:true` marks a session spawned via this `spawn_instance` tool. ' +
        '`displayStatus` reads `running` while an idle worker still has background subagents — ' +
        'read it, not `status`, to decide whether work is actually finished. ' +
        '`contextWindowTokens` is the model\'s context capacity in tokens, or null when unknown. ' +
        '`lastResponseAt` separates a long-silent worker from one producing output moments ago. ' +
        '`rotationReason` says whether the session\'s context was last reset by its own ' +
        '`renew_session` or by a prune, and `lastRotatedAt` when — a quiet worker that just ' +
        'rotated has a fresh context, not a stalled one. `segmentCount` is how many times over. ' +
        '`worktree` is the worktree\'s full metadata object (or null); the rendering shows its name. ' +
        'The rendering omits pid / createdAt / contextWindowTokens, and shows ' +
        'temp / conducted / debug / overage / auto-resume / resumes-hot only when they deviate from ' +
        'their default — so anything on a `flags` line is news. ' +
        '**`resumes-hot` means resuming that session comes up in bypassPermissions** — either it was ' +
        'recorded in that mode, or it has no recorded mode and therefore falls back to it. ' +
        'Every other tool here returning a worker summary returns that shape as JSON, minus ' +
        '`awaitingWake`, `playbook` and `stage`.',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Restrict to this project AND its worktrees (`.conduct` is legal — it is '
              + 'where conductors run, though list_projects hides it). A name that is not a '
              + 'project soft-refuses PROJECT_UNKNOWN. '
              + 'Omit for everything, which costs a session scan of every project and worktree — '
              + 'pass it when you know the project.',
          },
          worktree: {
            type: 'string',
            description: 'Narrow to one worktree of `project` (the sibling dir, e.g. '
              + '"demo_worktree_abc123"). Requires `project`.',
          },
          includeArchived: {
            type: 'boolean',
            description: 'List archived sessions instead of collapsing them to a per-group '
              + '`+N archived` count (default false).',
          },
        },
        required: [],
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
        'List orchestrator-owned git worktrees for a project as PLAIN TEXT (this tool returns ' +
        'no JSON), oldest-first: the parent project and path as a header, then each worktree\'s ' +
        'name, branch, base branch@sha, creation time and absolute path. The name is the ' +
        '`worktree` argument every other worktree tool takes.',
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
        'in-memory ring, and when fromSeq points into a range the ring has already evicted (below ' +
        'trimmedBefore) the dropped range is transparently served from the on-disk session transcript — ' +
        'ring eviction is invisible to you. A RETIRED session (no running process) is served wholly from ' +
        'that transcript instead, reported as source:"disk" with status:"exited"; such a page contains no ' +
        'turn_end. Events carry _seq; poll ' +
        'incrementally by passing the returned `nextFrom` back as the next fromSeq (forward paging, ' +
        'oldest-first). Returns {status, sessionId, source, events, lastSeq, trimmedBefore, hasMore, ' +
        'nextFrom}. Event kinds: text_delta, tool_use, ' +
        'tool_result, turn_end, etc. — same shape as the WebSocket snapshot. (Caveat: an in-flight block is ' +
        'served once and then grows in place below nextFrom, so polling never shows it grow — for prose ' +
        'mid-turn use get_recent_messages.)',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          fromSeq: { type: 'integer', description: 'Omitted → newest page; n → events with _seq >= n (inclusive), so fromSeq: 0 reaches the very first event. Pass nextFrom back to poll.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: 'Max events returned per call (clamped to this property\'s minimum/maximum). Use nextFrom + hasMore to page.' },
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
        'The session is archived on subprocess exit (transcript retained and still resumable, just out of the ' +
        'default list_sessions view); mode still defaults to plan (NOT bypassPermissions) so workers plan before acting. ' +
        'project is required for a fresh spawn, but optional when resume is given: if worktree is also ' +
        'omitted, the session\'s recorded project + worktree are recovered automatically so ' +
        'spawn_instance({resume:sessionId}) alone re-attaches the right cwd/branch and its prior history. ' +
        'CAUTION: an instance with the code-conductor MCP registered can in turn spawn ' +
        'further instances — guard against runaway recursion by keeping child agents in plan mode. ' +
        'PLAYBOOKS: playbook / stage / provenance declare which workflow graph this worker joins and where. ' +
        'A spawn with no `provenance` starts a new run and requires playbook + stage; a refusal lists every ' +
        'playbook with its entry stages and the legal moves from there. Resuming a playbook-tracked session is ' +
        'NOT a new run — it inherits that session\'s recorded playbook + stage, so the bare form needs neither.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Required for a fresh spawn. Optional when resume is given — recovered from the session\'s recorded location if worktree is also omitted.' },
          mode: { type: 'string', enum: VALID_MODES, description: 'plan / ask / bypassPermissions. Defaults to plan. A `resume` instead inherits the session\'s recorded mode, or bypassPermissions when it has none — list_sessions\' `resumes-hot` flag marks which sessions those are. An explicit value always wins.' },
          effort: {
            type: 'string', enum: EFFORT_LEVELS,
            description:
              'Reasoning effort. Omit it to use the default effort of the tier or role you spawned on ' +
              `(set per row in Settings → Models; '${DEFAULT_EFFORT}' when that row has none, and for a resume, ` +
              'which has no tier/role). An explicit value here always wins. Spawn-time only.',
          },
          thinking: { type: 'string', enum: VALID_THINKING },
          model: {
            type: 'string',
            description:
              'A capability tier (fast / balanced / powerful / frontier — the primary vocabulary), a role, ' +
              'or a specific model id to pin one exact model. Omit it to use the default tier set in Settings → Models.',
          },
          resume: {
            type: 'string',
            description:
              'Optional sessionId to resume (vs. spawning a fresh session). Must be a FULL sessionId — unlike ' +
              'every other sessionId argument, this one is not prefix-resolved. When the session is ' +
              'playbook-tracked, its recorded playbook + stage are recovered too, alongside the project + ' +
              'worktree above: a resume re-attaches a worker where it already is, so it enters no stage and the ' +
              'entered-stage checks (`needs`, `pin`, spawnability, capacity) do not apply. A resume with no ' +
              '`model` comes back on the model it last ran.',
          },
          worktree: {
            type: 'string',
            description: 'Name of an existing worktree to spawn into. To create a fresh one instead, use createWorktree:true.',
          },
          createWorktree: {
            type: 'boolean',
            description: 'If true, create a fresh worktree off the project\'s HEAD and spawn into it. Takes precedence over worktree.',
          },
          baseWorktree: {
            type: 'string',
            description: 'Requires createWorktree:true (else refused). Same meaning as create_worktree\'s — see that tool\'s schema.',
          },
          name: {
            type: 'string',
            description: 'Requires createWorktree:true (else refused). Names the new WORKTREE, not the session — see create_worktree\'s schema.',
          },
          debug: { type: 'boolean', description: 'If true, raw CLI traffic is mirrored to .code-conductor/debug/<id>/.' },
          playbook: {
            type: 'string',
            description: 'Playbook id (list_playbooks / describe_playbook). REQUIRED on a run root — a spawn with no `provenance`. On a non-root spawn it is inherited from the workers named in `provenance`, and on a resume of a playbook-tracked session from that session\'s record; supplying a different one is refused PLAYBOOK_MISMATCH.',
          },
          stage: {
            type: 'string',
            description: 'The playbook stage this worker enters. It must declare spawn_instance in its tools map, else STAGE_NOT_SPAWNABLE — transition-only stages cannot be spawned into. The entered stage supplies both the permission and the entry conditions (`needs`, `pin`). On a resume of a playbook-tracked session it is inherited from that session\'s record instead (the worker enters no stage); supplying a different one is refused PLAYBOOK_MISMATCH.',
          },
          provenance: {
            type: 'object',
            description: '{"<stage>": "<sessionId>"} naming the workers that satisfy the entered stage\'s `needs`. Absent ⇒ this spawn starts a new run. sessionId prefixes are accepted, like everywhere else.',
          },
        },
        required: [],
      },
      handler: h.spawnInstance,
    },
    {
      name: 'send_prompt',
      description:
        'Send a user turn to a running instance. ' +
        'A mid-turn send_prompt steers a worker in flight rather than waiting out its turn. ' +
        'PLAYBOOKS: always carry `stage` — it is what makes send_prompt the default transition driver.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          text: { type: 'string' },
          idleTimeoutMs: {
            type: 'number',
            minimum: 1,
            maximum: DEFAULT_SUBSCRIBE_TIMEOUT_MS,
            description: 'Heartbeat override, in ms: while this session is mid-turn you are pinged this often with a non-completion "did NOT finish" stub (still running, not finished), until the turn ends. Defaults to — and is capped at — ORCH_SUBSCRIBE_TIMEOUT_MS, so this can only SHORTEN the window. Same semantics as set_idle_timeout timeoutMs.',
          },
          stage: {
            type: 'string',
            description: 'The playbook stage this prompt puts the worker in — always carry it. Equal to the worker\'s current stage ⇒ a self-edge (an ordinary follow-up prompt), always legal, and ledgered only where the playbook declares that self-loop. Different ⇒ a transition, checked against the playbook\'s edge set: TRANSITION_ILLEGAL if there is no such edge, or if the edge\'s `via` (describe_playbook) names a tool other than send_prompt, which must drive it instead.',
          },
          provenance: {
            type: 'object',
            description: '{"<stage>": "<sessionId>"} satisfying the DESTINATION stage\'s `needs` when `stage` names a transition. A stage\'s entry conditions apply however it is entered, by spawn or by transition, so a transition into a stage that declares `needs` must supply them here. Ignored on a self-edge (entering the stage you are already in re-checks nothing). sessionId prefixes are accepted.',
          },
          forward: {
            type: 'object',
            description: '{sessionId:"<worker sessionId>"} — inject that worker\'s recent output into this prompt verbatim, server-side: it reaches the worker unedited and never enters your context. The payload is a whole default get_recent_messages selection, framed as context-only — you cannot trim or reorder it. Your `text` is placed LAST, after the forwarded block, as the instruction. The source need not still be live; sessionId prefixes are accepted for a live source only.',
          },
        },
        required: ['sessionId', 'text'],
      },
      handler: h.sendPrompt,
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
        'driving set_mode + send_prompt by hand. Optional `feedback` is appended to the approval message.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId of the worker whose plan you\'re approving.' },
          feedback: { type: 'string', description: 'Optional additional notes appended to the approval message.' },
          idleTimeoutMs: {
            type: 'number',
            minimum: 1,
            maximum: DEFAULT_SUBSCRIBE_TIMEOUT_MS,
            description: 'Heartbeat override, in ms: while this session is mid-turn you are pinged this often with a non-completion "did NOT finish" stub (still running, not finished), until the turn ends. Defaults to — and is capped at — ORCH_SUBSCRIBE_TIMEOUT_MS, so this can only SHORTEN the window. Same semantics as set_idle_timeout timeoutMs.',
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
        'guidance for what to change.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId of the worker whose plan you\'re rejecting.' },
          feedback: { type: 'string', description: 'What you want the worker to change. Strongly recommended.' },
          idleTimeoutMs: {
            type: 'number',
            minimum: 1,
            maximum: DEFAULT_SUBSCRIBE_TIMEOUT_MS,
            description: 'Heartbeat override, in ms: while this session is mid-turn you are pinged this often with a non-completion "did NOT finish" stub (still running, not finished), until the turn ends. Defaults to — and is capped at — ORCH_SUBSCRIBE_TIMEOUT_MS, so this can only SHORTEN the window. Same semantics as set_idle_timeout timeoutMs.',
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
        'send_prompt when a get_recent_messages message has `questionCount` set (the questions themselves are ' +
        'rendered in that message\'s body, fenced with "--- questions ---" and 1-based numbered). `answers` is ' +
        'aligned by index to those SAME server-side pending questions — 0-based, so body question N is answers[N-1] ' +
        '— each entry is { option } for single-choice, { options: [...] } for multiSelect, ' +
        '{ text } for a custom typed answer, or {} to skip — with an optional `note` on option/options.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId whose question you\'re answering.' },
          answers: {
            type: 'array',
            description: 'One entry per pending question, 0-based array index aligned to the body\'s 1-based ' +
              '"--- questions ---" numbering (question 1 → answers[0], question 2 → answers[1], etc).',
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
          idleTimeoutMs: {
            type: 'number',
            minimum: 1,
            maximum: DEFAULT_SUBSCRIBE_TIMEOUT_MS,
            description: 'Heartbeat override, in ms: while this session is mid-turn you are pinged this often with a non-completion "did NOT finish" stub (still running, not finished), until the turn ends. Defaults to — and is capped at — ORCH_SUBSCRIBE_TIMEOUT_MS, so this can only SHORTEN the window. Same semantics as set_idle_timeout timeoutMs.',
          },
        },
        required: ['sessionId', 'answers'],
      },
      handler: h.answerQuestion,
    },
    {
      name: 'set_idle_timeout',
      description:
        'Shorten the HEARTBEAT window on one of your sessions. There is nothing to register: you are woken ' +
        'when a session you spawned or have ever prompted ends a turn, automatically and with no opt-out. ' +
        'While such a session is mid-turn you are also pinged every ORCH_SUBSCRIBE_TIMEOUT_MS with a stub ' +
        'labelled "did NOT finish" — meaning still running, not finished — and that ping repeats until the ' +
        'turn ends without ever consuming the real turn-end wake. This tool changes only how often that ping ' +
        'arrives. It re-arms a heartbeat that is already running, so mid-turn is its use case; `armed:true` ' +
        'in the result means the target was mid-turn and its live heartbeat was re-armed. The ceiling is the ' +
        'default, so this can only shorten. Caller identity is taken from the MCP URL (?caller=<sessionId>), ' +
        'so this only works for orchestrator-spawned instances.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          timeoutMs: {
            type: 'number',
            minimum: 1,
            maximum: DEFAULT_SUBSCRIBE_TIMEOUT_MS,
            description:
              'Heartbeat window in ms. Must be a positive finite number no greater than ' +
              'ORCH_SUBSCRIBE_TIMEOUT_MS (the default), which is why this can only shorten. The stub each ' +
              'ping injects is clearly labelled as a non-completion so it can never be mistaken for a ' +
              'finished worker.',
          },
        },
        required: ['sessionId', 'timeoutMs'],
      },
      handler: h.setIdleTimeout,
      annotations: { idempotentHint: true },
    },
    {
      name: 'renew_session',
      description:
        'Without `sessionId`: renew your OWN session. Hand off a self-authored summary; code-conductor then ' +
        'clears your accumulated context in place — SAME session process, fresh conversation (a managed ' +
        '/clear, not a restart) — and seeds the cleared session with your summary (plus a server-generated ' +
        'block of live instance/subscription state) as its first turn. ' +
        'With `sessionId`: ask THAT worker to renew itself the same way — it writes its own summary. ' +
        'When to use: after landing and cleaning up a job, when history about finished work is dead weight ' +
        'taxing every future turn — renew at lifecycle seams, not because context is "full". ' +
        'The clear happens when your CURRENT turn ends: after calling this on yourself, end your turn WITHOUT ' +
        'starting new work — anything you do after this call is discarded by the clear. Your summary (plus the ' +
        'appended mechanical state block) is the ONLY thing carried across, so write everything the fresh ' +
        'session needs. ' +
        'Caller identity is taken from the MCP URL, so this only works for a code-conductor-managed instance. ' +
        'It stays valid across repeated renewal, so a long-lived session can renew more than once.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Worker sessionId to ask for a renewal. Omit to renew your own session.',
          },
          summary: {
            type: 'string',
            minLength: 1,
            description:
              'The handoff summary, seeded as the first user turn of the cleared session (the server appends ' +
              'a mechanical state block after it — do not re-enumerate live instances yourself, carry intent ' +
              'and meaning instead). ' + RENEW_SUMMARY_TEMPLATE,
          },
          directive: {
            type: 'string',
            description: 'With `sessionId`: what that worker should be sure to capture in the summary it writes.',
          },
          followUp: {
            type: 'string',
            description: 'With `sessionId`: its next job, fenced into its reseed.',
          },
        },
      },
      handler: h.renewSession,
    },
    {
      name: 'prune_session',
      description:
        'Shrink a worker\'s context deterministically and at zero token cost: rewrite its transcript with ' +
        'old tool outputs, oversized tool inputs and thinking replaced by size stubs, then respawn that ' +
        'worker against the pruned copy. No LLM pass and no summary — where `renew_session` asks the worker ' +
        'to write its own handoff and starts a turn, this keeps the conversation itself and comes back IDLE ' +
        'with nothing seeded, so you send the next prompt. ' +
        'When to use: a worker that must keep its recent working state, where only its older payloads are ' +
        'dead weight; renew instead at a job seam, where a summary is all that needs to survive. ' +
        'The worker\'s own prompts and prose answers are never touched. ' +
        'One cost to weigh: a pruned file read re-arms the CLI\'s read-before-edit guard, so the worker may ' +
        'owe one re-Read before its next edit.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          keepLatestTurns: {
            type: 'integer', minimum: 0, default: 1,
            description: 'Newest turns left verbatim. 0 prunes every turn including the newest; '
              + 'more than the session has prunes nothing.',
          },
          pruneThinking: {
            type: 'boolean', default: true,
            description: 'Stub thinking in EVERY turn, not just the pruned ones — thinking staleness is '
              + 'categorical, not temporal.',
          },
          inputMode: {
            type: 'string', enum: ['truncate', 'minimal'], default: 'truncate',
            description: 'truncate: keep the first 500 chars of a long tool-input value. '
              + 'minimal: replace any value over 80 chars with a size marker.',
          },
        },
        required: ['sessionId'],
      },
      handler: h.pruneSession,
      annotations: { destructiveHint: true },
    },
    {
      name: 'interrupt_turn',
      description: 'Stop the current turn of a running instance. Default (soft) arms a deferred abort: it fires at the next output boundary — nothing mid-stream, every dispatched tool returned — so partial output and finished tool work are preserved. Returns interrupting:true meaning ARMED, not stopped, and the boundary wait is UNBOUNDED — a long-running tool call defers it indefinitely, which is why the soft tier leaves your wake armed and the heartbeat keeps pinging until the turn really ends. Pass force:true to abort immediately, discarding in-progress work: that also CLEARS your pending wake on the target and delivers none, since the turn_end it produces is one you caused rather than the worker finishing.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          force: { type: 'boolean', default: false, description: 'true = abort now; omitted/false = abort at the next output boundary' },
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
      name: 'create_worktree',
      description:
        'Create a fresh git worktree off the project\'s current HEAD without spawning an instance. ' +
        'Use spawn_instance({worktree:<name>}) afterwards to attach an agent to it.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          baseWorktree: {
            type: 'string',
            description:
              'Base the new worktree on this existing worktree of the project instead of the project\'s HEAD, ' +
              'so it syncs against and merges into that worktree — how a multi-task feature integrates as a unit ' +
              'before landing. Depth is capped at one: a worktree that is itself based on another is refused as a base.',
          },
          name: {
            type: 'string',
            description:
              'Name for the NEW worktree, slugified into its branch (code-conductor/<slug>) and directory. ' +
              'Omitted ⇒ a random short id. Worth setting for a worktree others will be based on, whose branch ' +
              'is read in git log long after it is created.',
          },
        },
        required: ['project'],
      },
      handler: h.createWorktree,
    },
    {
      name: 'delete_worktree',
      description:
        'Remove a worktree (git deregister + branch delete + dir sweep). Refuses if a live instance ' +
        'is attached, the working tree is dirty, or another worktree is based on this one ' +
        '(WORKTREE_HAS_DEPENDENTS, listing them — delete those first) — unless force:true, which kills any ' +
        'attached instance and, with dependents, deletes the branch they are based on.',
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
        'live agent when conflicts block the rebase. Caller passes the worktree\'s attached worker sessionId. ' +
        'Refuses WORKTREE_HAS_DEPENDENTS (listing them) while any worktree is based on this one, since every ' +
        'sync path rewrites the base they were created from — delete those worktrees first; killing their ' +
        'workers is not enough.',
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
        'land (WORKTREE_DIRTY — pass allowDirty:true to merge anyway), the branch has no commits ' +
        'to merge (NOTHING_TO_MERGE), or another worktree is based on this one ' +
        '(WORKTREE_HAS_DEPENDENTS, listing them — see sync_worktree). That last one is about the worktree ' +
        'being merged, never the one being merged INTO: merging a task into a feature succeeds while the ' +
        'feature still has other tasks based on it.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Parent project holding the worktree.' },
          worktree: { type: 'string', description: 'Worktree dir name (as returned by list_worktrees / the worker\'s `worktree.worktreeName`).' },
          allowDirty: { type: 'boolean', description: 'Merge even though the worktree has uncommitted/untracked changes (they will not be included in the merge commit).' },
        },
        required: ['project', 'worktree'],
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
        'Idempotent — calling on an existing name is a no-op (added:false). Workspace names use the ' +
        'same charset as project names (letters, digits, `.`, `_`, `-`), length and charset per the schema\'s minLength/maxLength/pattern, and cannot ' +
        'start with `.`.',
      inputSchema: {
        type: 'object',
        properties: {
          // minLength/maxLength are subsumed by the pattern but kept: they are
          // checked first, so a too-short/too-long name gets a length-specific
          // message instead of a bare pattern dump. The pattern is tested
          // against the UNTRIMMED argument, so " CC-Dev " is refused here,
          // whereas validateWorkspace's trim still accepts it via
          // set_project_workspace — deliberate, so this tool's stated rule is
          // literally true of what it accepts.
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 40,
            pattern: '^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,39}$',
            description: 'Workspace name. See minLength/maxLength/pattern on this property.',
          },
        },
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
        'so workspace-wide conventions are inherited. The new dir is initialized as a git repo (no commits). ' +
        'Project conventions can be attached by passing their slugs — call list_project_conventions to ' +
        'discover available slugs. Each carries a CLAUDE.md fragment (appended inline) and/or a one-time ' +
        'scaffold directive: a picked convention flagged hasScaffold:true composes a setup directive that is ' +
        'RETURNED as this tool\'s `scaffold` field (empty when none), which YOU fold into your FIRST send_prompt ' +
        'to the project\'s first worker (it is never auto-sent).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$', description: 'Project name. Must match ^[a-zA-Z0-9._-]+$.' },
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
      name: 'list_conductor_conventions',
      description:
        'List the conductor conventions (slug, name, description, builtin, enabled) composed into ' +
        "the conductor's system prompt. Built-in seeds have builtin:true; custom conventions (builtin:false) and the " +
        'enabled selection are managed via the Settings → Conductor conventions panel. The always-on core ' +
        'is not listed here.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listConductorConventions,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_playbooks',
      description:
        'List the available playbooks — the declarative workflow graphs a worker can be bound to. ' +
        'Returns {playbooks, errors}: each playbook is {id, name, description, entryStages, ' +
        'spawnableStages}, and `errors` is [{id, message}] for definitions REJECTED at load time — ' +
        'check it when a playbook you authored does not appear. `entryStages` are the stages a run may ' +
        'start in; `spawnableStages` are every stage a worker can be created directly in (the rest are ' +
        'transition-only). Built-ins ship in-repo; author your own as JSON under ' +
        '<projectsRoot>/.code-conductor/playbooks/. Call describe_playbook for a graph.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: h.listPlaybooks,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'describe_playbook',
      description:
        'The full graph of one playbook. Returns PLAIN TEXT (no JSON). ' +
        'Per stage, `needs` names WORKERS that must exist for the stage to be entered, each rendered ' +
        '`<stage>@<liveness> in <stages>`: the stage that worker must have PASSED THROUGH (and the key you ' +
        'pass its sessionId under), whether it must still be running (live / retired / any), and which ' +
        'stages it may be in NOW. `tools` maps a tool to allow / ' +
        'deny / pin {json} of enforced argument values — a `*` entry is the fallback for every ' +
        'tool the stage does not name, and with no `*` an unnamed tool is allowed — except ' +
        'spawn_instance, which fails closed: a stage must name it to be spawnable, and a `*` does not ' +
        'confer that. `workers` is the ' +
        'stage\'s capacity for live workers of one run: `one` refuses a second, `many` permits ' +
        'several live at once. Each stage also reports `spawnable`, the per-stage form of ' +
        'list_playbooks\' `spawnableStages`. On an edge, `via` is the tool that drives it and the ' +
        'ONLY tool that can. Refuses {ok:false, code:"PLAYBOOK_UNKNOWN", known:[…]} for an unknown id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Playbook id, as listed by list_playbooks.' } },
        required: ['id'],
      },
      handler: h.describePlaybook,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'playbook_state',
      description:
        'Where a run actually is, and what it may legally do next — the insight + backtrack surface. ' +
        'Two shapes, chosen by whether you pass sessionId. WITH sessionId: ' +
        '{tracked, worker, run, nextMoves, history, historyTruncated, enforcement}, where `worker` ' +
        'carries {stage, stageHistory, provenance, live, runRoot}, `run` is {root, members} (the connected ' +
        'component over `provenance` edges), `nextMoves` is every outgoing edge as ' +
        '{to, via, ok, code?, reason?} — each ANSWERED BY THE SAME CHECK THAT ENFORCES, so a move ' +
        'reported ok:false comes back with the exact code and reason you would get for attempting it — ' +
        'and `history` is the run\'s ledger events oldest-first (capped; see historyTruncated). ' +
        'Each move is evaluated as the BARE call, with no `provenance` supplied, so an edge into a stage ' +
        'that declares `needs` reads ok:false (NEEDS_UNSATISFIED) even when a satisfying worker exists ' +
        '— that is not "impossible", it is "pass the argument": the `reason` names exactly what to pass. ' +
        'WITHOUT sessionId: {tracked:false, runs, enforcement} — every run at once. ' +
        'An untracked worker is a normal {tracked:false} answer, not a refusal. ' +
        'Note the no-argument form names no worker, so it is never subject to a stage\'s tool policy: ' +
        'use it if a stage denies the targeted form.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Optional. Worker sessionId (a prefix is fine) to report one run. Omit for every run.',
          },
        },
        required: [],
      },
      handler: h.playbookState,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_recent_messages',
      description:
        'Return the most recent assistant message(s) from an instance. Each message has: ' +
        '`text` (full joined prose), `hasToolUse` (boolean), `msgId`, and optionally `blocks`, `hasPlan`, `planPath`, `questionCount`. ' +
        '`blocks` is present only when non-text blocks exist and contains only `tool_use` and ' +
        '`thinking` entries — text content is fully represented by `text` and is not duplicated ' +
        'in `blocks`; ExitPlanMode and AskUserQuestion tool_use blocks are likewise not duplicated ' +
        'in `blocks[]` when their content is represented in the message body (see OUTPUT). ' +
        '`hasPlan` (boolean) flags a turn that called ExitPlanMode; `planPath` (string) is the plan document\'s path when a ' +
        'file backs the plan — prefer handing that path on rather than copying the text, or ' +
        'send_prompt({forward}) relays the whole message verbatim; `questionCount` (int) ' +
        'flags a turn that called AskUserQuestion, with the number of questions — these are presence markers only, ' +
        'the actual plan text / question list (index-numbered, with options and multiSelect) is in the message body. ' +
        'By default, messages are returned when they have text, a plan, or questions — ' +
        'tool-call-only messages with none of those are excluded. Set `includeToolCalls` to true to ' +
        'include every assistant message regardless AND to emit tool inputs verbatim (see `blocks[].input` ' +
        'below). Thinking blocks are excluded by default; ' +
        'set `includeThinking` to true to include them in `blocks[]`. `count` applies to the filtered set. ' +
        'DISK-BACKED & ring-first: served from the in-memory ring on the hot path; if the ring\'s retained ' +
        'tail can\'t satisfy the requested recent TEXT messages (tool-event volume evicted them) it transparently ' +
        'reads back into the on-disk session transcript — so ring eviction never yields a false-empty result. ' +
        'A RETIRED session (no running process) is served wholly from that transcript, reported as ' +
        'source:"disk" with retained:{firstSeq:0, lastSeq:-1, trimmed:false}. ' +
        'OUTPUT: a compact-JSON metadata block (content[0]) {sessionId, messages:[{index, msgId, hasToolUse, textChars, ' +
        'textTruncated, hasPlan?, planPath?, questionCount?, blocks?}], source:"ring"|"disk", omittedToolOnly:int, retained:{firstSeq, ' +
        'lastSeq, trimmed}, hint?} oldest-first, PLUS one raw, un-escaped text block per message (content[k+1] is ' +
        'messages[k]\'s body: its prose (if any) plus a "--- plan ---" (or "--- plan · saved to <path> ---") or "--- questions ---" fenced section when the ' +
        'turn produced one, in the order those blocks actually occurred — UNLESS more than one message is returned, in ' +
        'which case each body is prefixed with "--- message i/N · msgId · textChars chars ---"). `omittedToolOnly` counts ' +
        'recent tool-call-only messages excluded by the default filter (on a LIVE session the agent is active even when ' +
        'messages[] is empty); `hint` explains a short/empty result. Large message text is capped (textTruncated); ' +
        '`blocks[].input` is a per-ARGUMENT descriptor — each argument up to a few hundred bytes ' +
        '(`TOOL_ARG_VALUE_CAP`) rides verbatim, so pointers like `file_path`, a command or a pattern ' +
        'survive, while a larger one is replaced by an `[omitted: …]` marker and the block carries ' +
        '`inputTruncated:true`. To read an omitted argument: `includeToolCalls:true`. Default count and max per the `count` schema. ' +
        'DEFAULT-CALL BONDING: on the default call only (no `count` passed), if the last message is plain prose ' +
        'the selection is bonded back to the turn\'s plan/questions message and spans from it through the end ' +
        'of that turn — so a turn whose trailing prose spans several messages still surfaces the plan/questions ' +
        'together with all of it. The walk-back is scoped to the current turn (a plan from an earlier turn is never ' +
        'pulled in), and a message that already carries its own plan/questions is returned alone. Passing an ' +
        'explicit `count` (including `count:1`) disables this and returns exactly that many messages, literally.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Worker sessionId.' },
          count: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: 'Number of recent messages to return (from the filtered set). clamped to the `count` schema\'s [minimum, maximum].' },
          includeToolCalls: { type: 'boolean', default: false, description: 'When true, include tool-call-only messages (no text blocks) AND emit tool inputs verbatim instead of as per-argument descriptors. Default false.' },
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
        'leaving MCP. Returns PLAIN TEXT (no JSON), in sections: header, FILES, DIRTY, ' +
        'DIFFSTAT, COMMITS. The dirty list is capped; its header reports both counts and says ' +
        'truncated when it hits the cap.',
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
        '(per the contextLines schema range/default) sets hunk context. The supported modes keep this usable at any size: (1) summary:true returns a ' +
        'structured per-file stat {totals, files:[{path,status,oldPath?,additions,deletions,binary}]} instead of a ' +
        'diff — always small, never truncated, single JSON block. (2) paths:[...] scopes the diff (or summary) to ' +
        'specific file paths. (3) the diff is paginated by LINE INDEX: each call returns at most `DIFF_BYTE_CAP` of whole ' +
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
          contextLines: { type: 'integer', minimum: 0, maximum: 50, default: 3, description: 'Lines of context around each hunk (per the schema range/default).' },
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
        'not a tool error. truncated:true means retained output was capped at the bash output cap (`BASH_OUTPUT_CAP`) — the command ' +
        'still ran to completion; assume later output beyond the cap was lost, not that the process ' +
        'was killed. timeout is milliseconds (default per the schema, clamped to the max enforced in `bashProject` — larger values are ' +
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
          timeout:  { type: 'integer', minimum: 1, default: 120000, description: 'Timeout in milliseconds; values above the max enforced in `bashProject` are clamped.' },
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
        '(default per the schema); the `truncated` flag tells you when that happened.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          worktree: { type: 'string', description: 'Optional worktree name to scope into.' },
          relativePath: { type: 'string', description: 'Path relative to the project / worktree root.' },
          maxBytes: { type: 'integer', minimum: 1, default: 262144, description: 'Cap on bytes returned (default per the schema). For text with line params, applied as a final byte-cap on the assembled slice.' },
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
