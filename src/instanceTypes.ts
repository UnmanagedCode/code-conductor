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
  readonly proc: unknown;
  readonly _overageQueue?: unknown[];
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
  reconstructActiveTasks(beforeSeq: number): Promise<TaskRecord[]>;
  consumePrefill(): string | null;
  clearContext(): void;
  carryMarkersAcrossRenewal(oldSid: string | null): Promise<void>;
  prompt(text: string, attachments?: unknown[], opts?: { annotateIfMidTurn?: boolean; internal?: boolean }): Promise<unknown>;
  setMode(mode: string): Promise<unknown>;
  setModel(model: string, backend?: unknown): Promise<unknown>;
  interrupt(opts?: { force?: boolean }): Promise<unknown>;
  kill(): Promise<unknown>;
  setAutoApprovePlan(enabled: boolean): void;
  resolveHookCallback(toolUseId: unknown, allow: boolean): boolean;
}

export interface InstanceManagerLike {
  byId: ReadonlyMap<string, InstanceLike>;
  get(id: string): InstanceLike | undefined;
  anyForSession(sessionId: string): InstanceLike | undefined;
  callerSessionId(handle: string | null): string | null;
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
}
