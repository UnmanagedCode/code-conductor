// Shared structural contract for the Instance / InstanceManager shapes.
//
// Type-only module — zero runtime exports. The collaborator modules that
// receive an instance/manager as an injected parameter (routes, mcp/handlers,
// plugins/registry, resumeRestart, overageResume, sessionRenew, idleSubscriptions,
// usageOverageMonitor, wsHub, mcp/server, server.js) import these types via
// `import type`, which `verbatimModuleSyntax` fully erases — so this file adds
// no runtime import edge and can never create a cycle, even though several of
// its consumers convert before src/instances.ts exists (instances.ts imports
// nearly everything, so it converts last).
//
// src/instances.ts is statically checked against this contract (its classes
// `implements` these interfaces), so the Instance/InstanceManager shapes have
// exactly ONE home — a member added here without a matching implementation, or
// implemented with an incompatible type, is a compile error at the class, not
// a silent drift across per-consumer copies.

import type { UiEvent } from './parser.ts';
import type { TaskRecord } from './taskReconstruct.ts';
import type { WorktreeMeta } from './worktrees.ts';

export interface InstanceSummary {
  id: string;
  project: string;
  status: string;
  sessionId: string | null;
  mode: string;
  autoApprovePlan?: boolean;
  interrupting?: boolean;
  [key: string]: unknown;
}

export interface InstanceLike {
  readonly id: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly backend: string;
  readonly callerInstanceId: string | null;
  readonly cwd: string;
  readonly _userEchoCount: number;
  readonly proc: unknown;
  // Overage auto-resume state — mutated by OverageResumeController (and the
  // status handler in instances.ts), so these are deliberately non-readonly.
  autoResumeAt: number | null;
  autoStoppedForOverage: boolean;
  _overageWasStopped: boolean;
  _overageHandled: boolean;
  _overageResetsAt: number | null;
  _overageQueue: unknown[];
  readonly activeAgentTaskCount: number;
  readonly taskNotificationPending: boolean;
  readonly project: string;
  readonly status: string;
  readonly mode: string;
  readonly autoApprovePlan: boolean;
  readonly interrupting: boolean;
  readonly liveThinkingTokens: number | null;
  readonly lastContextUsage: unknown;
  readonly ring: { trimmedBefore: number; nextSeq: number };
  snapshotTail(): UiEvent[];
  ringSnapshot(): Array<UiEvent & { _seq: number }>;
  reconstructActiveTasks(beforeSeq: number): Promise<TaskRecord[]>;
  consumePrefill(): string | null;
  clearContext(): void;
  carryMarkersAcrossRenewal(oldSid: string | null): Promise<void>;
  summary(): InstanceSummary;
  _emitUi(ev: UiEvent): void;
  prompt(text: string, attachments?: unknown[], opts?: { annotateIfMidTurn?: boolean; internal?: boolean }): Promise<unknown>;
  setMode(mode: string): Promise<unknown>;
  setModel(model: string, backend?: unknown): Promise<unknown>;
  interrupt(opts?: { force?: boolean }): Promise<unknown>;
  kill(opts?: { graceMs?: number }): Promise<unknown>;
  setAutoApprovePlan(enabled: boolean): void;
  resolveHookCallback(toolUseId: unknown, allow: boolean): boolean;
  // MCP handler surface (src/mcp/handlers.ts): the worktree the session is
  // attached to (or null), temp→normal promotion, and the EventEmitter 'event'
  // channel (UI events) alongside 'status'.
  readonly worktree: WorktreeMeta | null;
  promoteToNormal(): Promise<InstanceSummary>;
  on(event: 'event', cb: (ev: UiEvent | null) => void): void;
  off(event: 'event', cb: (ev: UiEvent | null) => void): void;
  // Resume-restart reads/writes (src/resumeRestart.ts). `firstPrompt` is the
  // session's first-prompt line, read + written on the restored instance.
  readonly conducted: boolean;
  readonly temp: boolean;
  firstPrompt: string | null;
  setTitle(title: string): void;
  windDown(text: string): void;
  emit(event: 'status', summary: InstanceSummary): void;
  on(event: 'status', cb: (s: InstanceSummary) => void): void;
  off(event: 'status', cb: (s: InstanceSummary) => void): void;
}

export interface InstanceManagerLike {
  byId: ReadonlyMap<string, InstanceLike>;
  get(id: string): InstanceLike | undefined;
  anyForSession(sessionId: string): InstanceLike | undefined;
  callerSessionId(handle: string | null): string | null;
  emit(event: 'status', summary: InstanceSummary): void;
  _overageResumeMode: boolean;
  _overageResetsAt: number | null;
  _maybeReleaseOverageLock(): void;
  liveOwnedBy(conductorId: string): Array<{
    sessionId: string | null;
    project: string;
    worktree: string | null;
    status: string;
  }>;
  idleSubscriptionsOf(instanceId: string): string[];
  shouldSuppressTurnNotification(instanceId: string): boolean;
  on(event: 'event', cb: (arg: { id: string; ev: UiEvent | null }) => void): void;
  on(event: 'status', cb: (summary: InstanceSummary) => void): void;
  on(event: 'list_changed' | 'subscription_changed', cb: () => void): void;
  on(event: 'snapshot_reset', cb: (snap: { id: string }) => void): void;
  // Resume-restart surface (src/resumeRestart.ts).
  conductedWorkersOf(conductorId: string): Array<{ project: string; sessionId: string; worktreeName: string | null }>;
  isIdleCaller(instanceId: string): boolean;
  shutdownForResumeSync(): void;
  create(input: {
    project: string;
    resume?: string;
    mode?: string | null;
    effort?: string | null;
    tier?: string;
    role?: string;
    thinking?: string | null;
    model?: string | null;
    contextWindowTokens?: number | null;
    backend?: string | null;
    worktree?: string | boolean | null;
    temp?: boolean;
    conducted?: boolean;
    debug?: boolean;
    autoApprovePlan?: boolean;
    callerInstanceId?: string | null;
    prefill?: string;
  }): Promise<InstanceLike>;
  _inUsageWindowFlow(inst: InstanceLike): boolean;
  _armRestoredAutoResume(inst: InstanceLike, fireAtMs: number): void;
  // MCP handler surface (src/mcp/handlers.ts).
  sessionIdsForProject(project: string): string[];
  list(): Array<InstanceSummary & { hasIdleSubscriber: boolean }>;
  liveForSession(sessionId: string): InstanceLike | undefined;
  remove(id: string): Promise<unknown>;
  respawn(id: string): Promise<InstanceLike>;
  subscribeIdle(callerSessionId: string, targetSessionId: string, timeoutMs?: number): { already: boolean };
  unsubscribeIdle(callerSessionId: string, targetSessionId: string): { removed: boolean };
  armSessionRenew(instanceId: string, opts: { summary: string }): void;
  idsForWorktree(project: string, worktreeName: string): string[];
}
