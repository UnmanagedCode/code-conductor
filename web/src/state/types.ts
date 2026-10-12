// Wire shapes the client reads. The server owns them (src/instanceTypes.ts,
// src/projects.ts); these name only the fields the UI uses and keep an index
// signature for everything else.

export type BackgroundJob = { id?: string; command?: string; description?: string; [k: string]: unknown };

export type Instance = {
  id: string;
  project: string;
  status: string;
  displayStatus?: string;
  sessionId: string | null;
  mode: string;
  model?: string | null;
  backend?: string | null;
  effort?: string | null;
  thinking?: string | null;
  tier?: string | null;
  role?: string | null;
  cwd?: string;
  worktree?: InstanceWorktree | null;
  temp?: boolean;
  conducted?: boolean;
  callerInstanceId?: string | null;
  ownerSessionId?: string | null;
  awaitingUser?: 'question' | 'plan' | null;
  awaitingUserSource?: 'tool' | 'text' | null;
  autoApprovePlan?: boolean;
  playbookEnforcement?: string;
  interrupting?: boolean;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  turnEndSeq?: number;
  viewedSeq?: number;
  liveTurnEnds?: number;
  lastTurnError?: boolean;
  liveAsks?: number;
  backgroundJobs?: BackgroundJob[];
  activeAgentTasks?: number;
  modelSwitch?: { from: string; to: string; fromBackend?: string; toBackend?: string } | null;
  modelSwitchFailure?: { from: string; to: string; fromBackend?: string; toBackend?: string; error: string } | null;
  firstPrompt?: string | null;
  title?: string | null;
  lastResponseAt?: number | null;
  createdAt?: number;
  debug?: boolean;
  debugDir?: string | null;
  playbook?: string | null;
  stage?: string | null;
  autoResumeAt?: number | null;
  queuedCount?: number;
  [k: string]: unknown;
};

/** `postWorktreeCreate` on a spawn's worktree (PostWorktreeHookResult, src/worktrees.ts). */
export type PostWorktreeHook = {
  ran: boolean;
  timedOut?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
  output?: string;
  [k: string]: unknown;
};

/** An instance's worktree, as the summary carries it (src/instances.ts). */
export type InstanceWorktree = {
  worktreeName: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  postWorktreeCreate: PostWorktreeHook | null;
};

export type Worktree = {
  worktreeName: string;
  branch?: string;
  baseBranch?: string;
  baseSha?: string;
  mergeStatus?: { ahead: number; behind: number } | null;
  path?: string;
  locked?: boolean;
  sessions?: { count: number; archivedCount?: number; lastActivity?: number };
  [k: string]: unknown;
};

export type Project = {
  name: string;
  path: string;
  workspace?: string | null;
  system: string;
  remoteId: string | null;
  sessionIds?: string[];
  systemUnreachable?: string | null;
  gitRefusal?: string | null;
  isGitRepo?: boolean;
  unbornHead?: boolean;
  worktrees: Worktree[];
  sessions?: { count: number; archivedCount: number; handCount: number; lastActivity: number };
  mergeStatus?: { ahead: number | null; behind: number | null; upstream: string | null };
  branch?: string | null;
  dirty?: number;
  [k: string]: unknown;
};

export type SessionRow = {
  sessionId: string;
  title?: string | null;
  firstPrompt?: string | null;
  lastActivity?: number;
  size?: number;
  awaitingUser?: 'question' | 'plan' | null;
  awaitingUserSource?: 'tool' | 'text' | null;
  [k: string]: unknown;
};

/** A UI event as the server's parser emits it (src/parser.ts). */
export type UiEvent = {
  kind: string;
  _seq?: number;
  [k: string]: any;
};
