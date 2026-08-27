// Shared structural contract for the Instance / InstanceManager shapes.
//
// Type-only module — zero runtime exports. The collaborator modules that
// receive an instance/manager as an injected parameter (routes, mcp/handlers,
// plugins/registry, resumeRestart, overageResume, sessionRenew, idleSubscriptions,
// usageOverageMonitor, wsHub, mcp/server, server.ts) import these types via
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
import type { PlaybookEnforcement } from './playbooks.ts';
import type { Response } from 'express';

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

// InstanceManager.create()/_doCreate() input — the REST/MCP spawn surface, and
// the argument list Instance.forkAtUserMessage() hands back for its respawn.
// `tier`/`role` resolve the default effort only (never stored); `backend` is
// the registry id (explicit wins; a resume without one recovers the sidecar's).
export interface CreateInstanceInput {
  // Optional on the type only so `create(opts = {})` compiles; _doCreate
  // validates it (throws 400 'project required') and every caller passes it.
  project?: string;
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
  // Both apply only to `worktree: true` (creating a fresh worktree) and are
  // refused otherwise — see _doCreate. baseWorktree bases the new worktree on
  // another worktree of the project instead of its root; name is slugified into
  // the new worktree's branch + directory name.
  baseWorktree?: string;
  name?: string;
  temp?: boolean;
  conducted?: boolean;
  debug?: boolean;
  autoApprovePlan?: boolean;
  playbookEnforcement?: PlaybookEnforcement;
  callerInstanceId?: string | null;
  prefill?: string;
}

export interface InstanceLike {
  readonly id: string;
  // The PERMANENT public id (what summary() emits and every surface reports).
  readonly sessionId: string | null;
  // The CLI's rotating session_id — names the transcript file, feeds `--resume`.
  // Only transcript/launch consumers may read this; see src/instances.ts.
  readonly backingSessionId: string | null;
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
  // The overage stop found this session already idle — the third resume-preamble
  // selector (see overageResumeKind).
  _overageWasIdleParked: boolean;
  // Set for the duration of the auto-resume's own send, exempting exactly that turn
  // from the overage turn-start guard.
  _overageResumeFiring: boolean;
  // Two independent facts a stopped conductor's resume prompt carries (see
  // buildConductorResumePreamble): a pending idle callback was severed, and/or a
  // worker of its was stopped un-armed.
  _overageDroppedCallbacks: boolean;
  _overageUnarmedWorkers: boolean;
  // Set on a WORKER the stop left un-armed: it must not queue sends behind a resume
  // it will never get. `overageSendRefused` is the one test of that — prompt()
  // throws on it, the MCP handlers soft-refuse OVERAGE_STOPPED_UNARMED.
  _overageStoppedUnarmed: boolean;
  readonly overageSendRefused: boolean;
  _overageHandled: boolean;
  _overageResetsAt: number | null;
  _overageQueue: unknown[];
  readonly activeAgentTaskCount: number;
  readonly taskNotificationPending: boolean;
  // True when the current idle window contains non-task-lifecycle activity —
  // read by IdleSubscriptionHub to refuse arming an idle task-drain settle.
  readonly idleWindowDirty: boolean;
  readonly project: string;
  readonly status: string;
  readonly mode: string;
  readonly autoApprovePlan: boolean;
  readonly playbookEnforcement: PlaybookEnforcement;
  readonly interrupting: boolean;
  // The CURRENT/just-ended turn was force-aborted. Read by IdleSubscriptionHub on
  // every wake-consuming path so an owner hears "interrupted", not "finished", no
  // matter which path resolves the wake. See src/instances.ts.
  readonly turnForceAborted: boolean;
  // Read-and-clear of the above; the hub calls it at a turn start that no armed
  // wake survived into, i.e. when the qualifier can no longer describe anything.
  consumeTurnForceAborted(): boolean;
  readonly liveThinkingTokens: number | null;
  readonly lastContextUsage: unknown;
  readonly ring: { trimmedBefore: number; nextSeq: number };
  snapshotTail(): UiEvent[];
  ringSnapshot(): Array<UiEvent & { _seq: number }>;
  reconstructActiveTasks(beforeSeq: number): Promise<TaskRecord[]>;
  consumePrefill(): string | null;
  clearContext(): void;
  // Rotation window (a managed `/clear` renewal, or a prune). IdleSubscriptionHub
  // defers the armed wake while `rotationPending`, and the two mechanisms refuse
  // to interleave on it. See src/instances.ts for the comesUpIdle contract.
  readonly rotationPending: boolean;
  readonly rotationInFlight: 'renew' | 'prune' | null;
  // Wider than rotationPending: covers the reseed window the rotation flag
  // deliberately leaves open. Any destructive rewrite must check the union.
  readonly renewalPending: boolean;
  // A rewindToUserMessage/InstanceManager.respawn relaunch in flight — the
  // liveness-only sibling of rotationPending, deliberately outside the
  // renew/prune `_rotation` machinery (see src/instances.ts). Read by
  // InstanceManager.isSessionLive only.
  readonly relaunching: boolean;
  beginRotation(reason: 'renew' | 'prune'): void;
  endRotation(opts: { ok: boolean; comesUpIdle: boolean }): void;
  beginRenewal(): void;
  endRenewal(): void;
  signalRotationTurnLost(reason: 'renew' | 'prune'): void;
  carryMarkersAcrossRenewal(oldSid: string | null): Promise<void>;
  // Await this instance's durable session-lineage writes, rethrowing the first
  // failure since the last flush (see src/instances.ts). SessionRenewController
  // waits on this before reseeding a rotated session.
  flushLineage(): Promise<void>;
  // Re-kick the current rotation's durable lineage write (idempotent). Paired
  // with flushLineage for the bounded retry SessionRenewController runs when the
  // first flush failed.
  retryRotationWrite(): void;
  summary(): InstanceSummary;
  _emitUi(ev: UiEvent): void;
  prompt(text: string, attachments?: unknown[], opts?: { annotateIfMidTurn?: boolean; internal?: boolean; midTurnNote?: string }): Promise<unknown>;
  // False when this session's model cannot take a message injected into a running
  // turn; such a send is routed through queueSteerAfterStop instead (a block-edge
  // stop, then a fresh turn). `steerPending` is true while one is parked — read by
  // IdleSubscriptionHub's defer gate. See src/instances.ts.
  readonly acceptsMidTurnSteering: boolean;
  readonly steerPending: boolean;
  readonly needsPostStopSteer: boolean;
  queueSteerAfterStop(text: string, opts?: { attachments?: unknown[] }): Promise<void>;
  promptOrQueueSteer(text: string, attachments?: unknown[]): Promise<void>;
  setMode(mode: string): Promise<unknown>;
  setModel(model: string, backend?: unknown): Promise<unknown>;
  interrupt(opts?: { force?: boolean; deadlineMs?: number }): Promise<unknown>;
  kill(opts?: { graceMs?: number }): Promise<unknown>;
  setAutoApprovePlan(enabled: boolean): void;
  setPlaybookEnforcement(mode: PlaybookEnforcement): void;
  resolveHookCallback(toolUseId: unknown, allow: boolean): boolean;
  // Orchestrator surfaces beyond the core lifecycle: the worktree the session
  // is attached to (MCP handlers, src/mcp/handlers.ts), temp→normal promotion
  // (REST POST /api/instances/:id/promote, src/routes.ts), and the
  // EventEmitter 'event' channel (UI events) alongside 'status'.
  readonly worktree: WorktreeMeta | null;
  promoteToNormal(): Promise<InstanceSummary>;
  on(event: 'event', cb: (ev: UiEvent | null) => void): void;
  off(event: 'event', cb: (ev: UiEvent | null) => void): void;
  // Resume-restart reads/writes (src/resumeRestart.ts). `firstPrompt` is the
  // session's first-prompt line, read + written on the restored instance.
  readonly conducted: boolean;
  readonly temp: boolean;
  firstPrompt: string | null;
  // Accepts null (clears the title) — the routes title endpoint stores
  // `setSessionTitle(...)`'s result, which is null when the title is cleared.
  setTitle(title: string | null): void;
  // Route surface (src/routes.ts): the three destructive session rewrites,
  // debug mutation and the hook-callback envelope. `_mutating` is the guard
  // fork/rewind/prune claim synchronously; it stays on the contract for the
  // MCP-side interlock, which reads it directly (src/mcp/handlers.ts).
  readonly debug: boolean;
  readonly debugDir: string | null;
  _mutating: boolean;
  rewindToUserMessage(userMessageIndex: number): Promise<{ droppedText: string }>;
  // Fork at the Nth user prompt, leaving THIS session intact. Owns the whole
  // guard→claim→read→release sequence plus the derivation of its respawn
  // argument list; the caller only makes the create() call — see src/instances.ts.
  forkAtUserMessage(userMessageIndex: number): Promise<{
    newSessionId: string;
    droppedText: string;
    createArgs: CreateInstanceInput;
  }>;
  pruneSession(input?: { cutTurnIndex?: unknown; keepLatestTurns?: unknown; pruneThinking?: unknown; inputMode?: unknown }): Promise<Record<string, unknown>>;
  enableDebug(): { ok: boolean; alreadyOn?: boolean; debugDir?: string | null; reason?: string };
  handleHookCallback(envelope: unknown, res: Response): void;
  emit(event: 'status', summary: InstanceSummary): void;
  on(event: 'status', cb: (s: InstanceSummary) => void): void;
  off(event: 'status', cb: (s: InstanceSummary) => void): void;
}

export interface InstanceManagerLike {
  byId: ReadonlyMap<string, InstanceLike>;
  get(id: string): InstanceLike | undefined;
  // Both session lookups return null (not undefined) on a miss — the impl's
  // `find(...) ?? null` shape, pinned by tests.
  anyForSession(sessionId: string): InstanceLike | null;
  callerSessionId(handle: string | null): string | null;
  emit(event: 'status', summary: InstanceSummary): void;
  // IdleSubscriptionHub notifies watchers of graph changes; the server listens
  // for it to re-render the watcher count. Emitted with no payload shape beyond
  // the target id.
  emit(event: 'subscription_changed', arg: { targetId: string }): void;
  _overageResumeMode: boolean;
  _overageResetsAt: number | null;
  _maybeReleaseOverageLock(): void;
  liveOwnedBy(conductorId: string): Array<{
    sessionId: string | null;
    project: string;
    worktree: string | null;
    status: string;
  }>;
  ownedWakeTargetsOf(instanceId: string): string[];
  // A conductor-requested renewal expired unconsumed — the worker declined.
  // Recorded for the REQUESTING conductor's wake stub (`requestedBy` is its
  // sessionId), and called synchronously from SessionRenewController's turn_end
  // handling (src/idleSubscriptions.ts documents why synchronously).
  noteRenewalDeclined(targetInstanceId: string, requestedBy: string | null): void;
  shouldSuppressTurnNotification(instanceId: string): boolean;
  on(event: 'event', cb: (arg: { id: string; ev: UiEvent | null }) => void): void;
  on(event: 'status', cb: (summary: InstanceSummary) => void): void;
  on(event: 'list_changed' | 'subscription_changed', cb: () => void): void;
  on(event: 'snapshot_reset', cb: (snap: { id: string }) => void): void;
  // Resume-restart surface (src/resumeRestart.ts).
  conductedWorkersOf(conductorId: string): Array<{ project: string; sessionId: string; worktreeName: string | null }>;
  isIdleCaller(instanceId: string): boolean;
  shutdownForResumeSync(): void;
  create(input: CreateInstanceInput): Promise<InstanceLike>;
  _inUsageWindowFlow(inst: InstanceLike): boolean;
  _armRestoredAutoResume(inst: InstanceLike, fireAtMs: number): void;
  // MCP handler surface (src/mcp/handlers.ts).
  sessionIdsForProject(project: string): string[];
  liveCountForProject(project: string): number;
  // MCP transport surface (src/mcp/server.ts): the sessionId-prefix resolver.
  resolveSessionRef(input: string): { sessionId: string } | { ambiguous: string[]; tooShort: boolean } | null;
  list(): Array<InstanceSummary & { awaitingWake: boolean }>;
  liveForSession(sessionId: string): InstanceLike | null;
  // THE liveness authority for a public sessionId — see src/instances.ts. Every
  // consumer of worker liveness (playbook policy, MCP read surfaces) reads this,
  // never a ledger-side mirror.
  isSessionLive(sessionId: string): boolean;
  remove(id: string): Promise<unknown>;
  respawn(id: string): Promise<InstanceLike>;
  noteDispatch(callerSessionId: string, targetSessionId: string, timeoutMs?: number): void;
  setIdleTimeout(callerSessionId: string, targetSessionId: string, timeoutMs: number): { armed: boolean };
  disarmIdleSilently(callerSessionId: string, targetInstanceId: string): void;
  armSessionRenew(instanceId: string, opts: { summary: string; followUp?: string | null }): void;
  requestSessionRenew(instanceId: string, opts: { followUp?: string | null; requestedBy?: string | null }): { requested: boolean; rerequested: boolean };
  dropSessionRenewRequest(instanceId: string): void;
  idsForWorktree(project: string, worktreeName: string): string[];
  // Route surface (src/routes.ts).
  tempSessionIdsForCwd(cwd: string): Set<string>;
  liveBackingIdsForCwd(cwd: string): Set<string>;
  idsForSession(sessionId: string): string[];
  sessionIdsForWorktree(project: string, worktreeName: string): string[];
  removeAllForProject(projectName: string): Promise<number>;
  reevaluateOverageResumes(): void;
  syncOveragePolicy(): void;
  forceUsageTick(): Promise<unknown>;
  // Restart surface (src/restart.ts / resumeRestart.ts) — the restart routes
  // pass the manager to scheduleRestart/drainAndScheduleRestart as the
  // RestartManagerLike subset.
  shutdownTempSync(): void;
  tempCleanupSnapshot(): Array<{ cwd: string; sessionId: string }>;
  shutdown(): Promise<unknown>;
}
