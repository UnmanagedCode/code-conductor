// The REST row types: what the server's Instance.summary(), InstanceManager.list(), the GET /projects listing
// and the session listing emit, and what the web client reads. Type-only; erased
// at build time, so it is safe on both sides of the wire (DOM-free).
//
// It is also the DOM-free home of the cross-runtime wire types that shared/tasks.ts
// re-exports (the task payloads).
//
// The rows carry no index signature: a field renamed here fails every reader that
// still uses the old name, on the server and in the web client alike.

export interface BackgroundJob {
  title: string;
  // cc's clock (epoch ms) when the job's id first appeared in a snapshot; the
  // frame itself carries no timestamp.
  startedAt: number;
}

// A worktree hook's report: `postWorktreeCreate` / `postWorktreeMerge`.
export interface WorktreeHookResult {
  ran: boolean;
  // Why the hook did not run, when a hook was found: `'disabled'` for the
  // event's kill-switch, `'STORE_HOOK_LOCAL_ONLY'` for a store-sourced script on
  // a non-local system (see runWorktreeHook).
  skipped?: 'disabled' | 'STORE_HOOK_LOCAL_ONLY';
  source?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  timedOut?: boolean;
  // The hook was killed on a system whose provider cannot signal a process
  // GROUP, so only `bash` itself was reached and whatever it started may still
  // be running. This hook is the exact case groupedCommand.ts's header
  // documents — a timed-out `npm ci` in a fresh worktree — and the caller has
  // to know the install may still be going before it uses the worktree.
  descendantsMaySurvive?: true;
  error?: boolean;
}

// A restart model switch: both models and both backends, equal backends for a
// same-backend switch. In memory only (the ledger entry carries the backends
// only when they differ).
export interface ModelSwitchState {
  from: string;
  to: string;
  fromBackend: string;
  toBackend: string;
}

export type ModelSwitchFailure = ModelSwitchState & { error: string };

// An instance's worktree, as the summary carries it.
export interface InstanceWorktree {
  worktreeName: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  postWorktreeCreate: WorktreeHookResult | null;
}

// One instance, as Instance.summary() emits it. A `type` alias (not an
// interface) so it stays assignable to a string-keyed record for consumers that
// project it by key.
export type InstanceSummary = {
  id: string;
  project: string;
  cwd: string;
  mode: string;
  effort: string | null;
  thinking: string;
  model: string | null;
  // Server-resolved context capacity (raw tokens) or null when unknown.
  contextWindowTokens: number | null;
  // The latest top-level call's prompt (contextReading), or null until a call
  // measures it.
  contextTokens: number | null;
  backend: string;
  sessionId: string | null;
  status: string;
  activeAgentTasks: number;
  // Overlays only the literal `'idle'` (idle with running agent tasks reads
  // `running`); `status` itself is never repurposed.
  displayStatus: string;
  // Running background Bash jobs.
  backgroundJobs: BackgroundJob[];
  pid: number | null;
  worktree: InstanceWorktree | null;
  persistent: boolean;
  // A New-conductor session with no prompt yet.
  pristine: boolean;
  conducted: boolean;
  callerInstanceId: string | null;
  // Spawn-tree links + the sticky ask. Both links are non-null only on a live
  // conducted row.
  rootSessionId: string | null;
  parentSessionId: string | null;
  awaitingUser: 'question' | 'plan' | null;
  awaitingUserSource: 'tool' | 'text' | null;
  debug: boolean;
  debugDir: string | null;
  firstPrompt: string | null;
  title: string | null;
  // The sidebar's label for the session, never empty (sessionLabel, shared/promptPreview.ts).
  displayLabel: string;
  // The session record's turn marks.
  turnEndSeq: number;
  viewedSeq: number;
  // Live-only, per Instance object (never hydrated): outer turn ends seen, not
  // counting a commanded-stop interrupted one; the latest counted one's is_error;
  // live null→ask transitions of awaitingUser. Read by shared/attention.ts.
  liveTurnEnds: number;
  lastTurnError: boolean;
  liveAsks: number;
  lastResponseAt: number | null;
  lastRotatedAt: number | null;
  rotationReason: string | null;
  segmentCount: number;
  createdAt: number;
  autoApprovePlan: boolean;
  playbookEnforcement: string;
  interrupting: boolean;
  autoResumeAt: number | null;
  queuedCount: number;
  overageActive: boolean;
  overageStoppedUnarmed: boolean;
  overageResetsAt: number | null;
  // A restart model switch in flight, and the last one's failure.
  modelSwitch: ModelSwitchState | null;
  modelSwitchFailure: ModelSwitchFailure | null;
};

// InstanceManager.list()'s row: the summary plus the two wake facts the manager joins on.
export type InstanceListRow = InstanceSummary & { awaitingWake: boolean; waitingOnJob: boolean };

// The playbook binding GET /instances joins onto each InstanceListRow (playbookBinding,
// src/playbookState.ts): null/null for an untracked worker or a failed projection read.
export interface PlaybookBinding {
  playbook: string | null;
  stage: string | null;
}

export interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  title: string | null;
  conducted: boolean;
  persistent: boolean;
  archived: boolean;
  // The record's turn marks (sessionStore.ts getTurnMarks), 0 when absent.
  turnEndSeq: number;
  viewedSeq: number;
  // Epoch ms of the timestamp on the session's last timestamped record — see
  // sessionActivity.ts for why this is not the transcript's mtime.
  lastActivity: number;
  size: number;
  // What `spawn_instance({resume})` would actually come up as — the recorded
  // mode, or DEFAULT_RESUME_MODE when there is none. Always the EFFECTIVE
  // value, never the raw record: a consumer that rendered "no record" as "not
  // hot" would tell a reader a hot resume is safe.
  resumeMode: string;
  // The sticky ask derived from the transcript (src/awaitingUserTranscript.ts).
  // Always null on a conducted or archived row unless the listing was asked to
  // derive that one row (`deriveAwaitingFor`). A disk row has no owner: that
  // exists only while a session is live.
  awaitingUser: 'question' | 'plan' | null;
  awaitingUserSource: 'tool' | 'text' | null;
}

// A project's convention selection. `unset` (never chosen) and `none` (chosen
// to have none) compose the same document; only the marker and the sidebar's
// flag tell them apart. `selected` slugs are in marker order, verbatim, and may
// repeat.
export type ProjectConventionSelection =
  | { mode: 'unset' }
  | { mode: 'none' }
  | { mode: 'selected'; slugs: string[] };

export interface ProjectInfo {
  name: string;
  path: string;
  workspace: string | null;
  // The System the tree lives on and WHICH TARGET of it — both from
  // placementOf(), so the `.conduct` pin holds here too. Plain strings, not the
  // System HANDLE: both REST and MCP spread this into a response body. `path`
  // is the tree's path ON that system; there is no second path field, which is
  // what makes an in-root and an out-of-root project indistinguishable here.
  system: string;
  remoteId: string | null;
  // Set only when the row's RECORD could not be parsed. The name is recoverable
  // from the store directory without reading the file, so the row is emitted
  // with an empty `path` and this reason rather than dropped — a silently
  // skipped row is the disappearing row the degraded-listing contract exists to
  // prevent.
  degraded?: string;
}

// A worktree's registration record; src/worktrees.ts documents its stored fields.
export interface WorktreeMeta {
  parentProject: string;
  parentPath: string;
  worktreeName: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  // Set only when this worktree was created off ANOTHER worktree of the same
  // project ("a feature branch"): the base worktree's worktreeName. Absent
  // means based on the project root — the canonical shape, not a legacy one.
  // `parentProject` stays the ROOT project name either way: listWorktrees
  // filters on it, so a derived worktree that recorded its base there would
  // disappear from every listing in the app.
  baseWorktree?: string;
  // The user's lock. Absent means unlocked — the canonical shape: unlocking
  // deletes the key, never writes `false`. Its writers are setWorktreeLock
  // (browser-only, set or clear) and createWorktree's `lock` option (set at
  // creation only); no agent can clear it. It refuses two things: merging this worktree
  // into its base (gate 0 of mergeWorktreeIntoParent, so every merge surface
  // inherits it) and an AGENT deleting it (the MCP deleteWorktree handler, even
  // under force). The human's delete paths and sync never read it. Read it only
  // through listWorktrees / getWorktree / requireWorktree: an instance's
  // `inst.worktree` is a snapshot taken at spawn and goes stale.
  locked?: true;
  createdAt: string;
}

export interface MergeStatus {
  ahead: number | null;
  behind: number | null;
}

export interface UpstreamStatus extends MergeStatus {
  upstream: string | null;
}

// A place's session summary, as summarizeSessions (src/projects.ts) computes it.
export interface SessionCounts {
  count: number;
  archivedCount: number;
  handCount: number;
  lastActivity: number;
}

// A worktree of a GET /projects row: its registration, its divergence from its base, its session summary.
export type WorktreeRow = WorktreeMeta & { mergeStatus: MergeStatus; sessions: SessionCounts };

// A row of GET /projects: the project record plus what the listing measures. docs/protocol/rest.md
// states each field's meaning.
export type ProjectRow = ProjectInfo & {
  sessionIds: string[];
  systemUnreachable: string | null;
  gitRefusal: string | null;
  isGitRepo?: boolean;
  unbornHead: boolean;
  worktrees: WorktreeRow[];
  sessions: SessionCounts;
  mergeStatus: UpstreamStatus;
  conventions?: (ProjectConventionSelection & { unresolved: string[] }) | { error: string };
};

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | (string & {});
export type Task = { subject: string; description: string; activeForm: string | null; status: TaskStatus };
export type ListedTask = Task & { id: string };

// GET /api/settings/self-update's `restart` (src/restartStatus.ts): whether the
// running server is behind its own checkout's HEAD. `boot` = the commit it
// started from, `head` = HEAD now; full shas. Only `needed` asks for a restart.
export type ServerRestartState =
  | { state: 'current'; boot: string }
  | { state: 'live'; boot: string; head: string }
  | { state: 'needed'; boot: string; head: string; reason: string }
  | { state: 'unknown'; reason: string };
