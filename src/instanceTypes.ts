// Shared structural contract for the Instance / InstanceManager shapes.
//
// Type-only module — zero runtime exports. The collaborator modules that
// receive an instance/manager as an injected parameter (routes, mcp/handlers,
// plugins/registry, resumeRestart, overageResume, sessionRenew, idleSubscriptions,
// usageOverageMonitor, mcp/server, server.js) import these types via
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

export interface InstanceLike {
  readonly id: string;
  readonly sessionId: string | null;
  readonly proc: unknown;
  readonly _overageQueue?: unknown[];
  readonly activeAgentTaskCount: number;
  readonly taskNotificationPending: boolean;
  clearContext(): void;
  carryMarkersAcrossRenewal(oldSid: string | null): Promise<void>;
  prompt(text: string, attachments?: unknown[], opts?: { annotateIfMidTurn?: boolean; internal?: boolean }): Promise<unknown>;
}

export interface InstanceManagerLike {
  byId: ReadonlyMap<string, InstanceLike>;
  liveOwnedBy(conductorId: string): Array<{
    sessionId: string | null;
    project: string;
    worktree: string | null;
    status: string;
  }>;
  idleSubscriptionsOf(instanceId: string): string[];
}
