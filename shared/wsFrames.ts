// The server → client WebSocket frames, discriminated on `t`. Type-only
// (DOM-free): src/wsHub.ts builds each frame against its member, and the web
// client reads them through the typed `bus` in shared/ws.ts.
//
// Ordering: after a subscribe, no event, segment or reset_snapshot frame for the
// instance precedes its snapshot; those emitted while it is built follow it, in
// order. A status frame is not held. Older history (ring and earlier segments) is
// paged via GET /api/instances/:id/lineage-events.

import type { UiEvent } from './uiEvent.ts';
import type { Usage } from './usage.ts';
import type { ListedTask, ModelSwitchState, ModelSwitchFailure, ContextChip } from './wireRows.ts';

export interface SnapshotFrame {
  t: 'snapshot';
  id: string;
  project: string;
  status: string;
  mode: string;
  sessionId: string | null;
  autoApprovePlan: boolean;
  playbookEnforcement: string;
  interrupting: boolean;
  // The ring TAIL only (at most ORCH_SNAPSHOT_TAIL events).
  events: UiEvent[];
  // `tailStartSeq > 0` ⇒ older ring history exists.
  tailStartSeq: number;
  trimmedBefore: number;
  // The backing segment the tail starts in, and the one the instance runs under now.
  tailSegmentId: string | null;
  currentSegmentId: string | null;
  // In-flight task batch as of the tail start.
  tasksAtTailStart: ListedTask[];
  // Current context-size reading, so the client's UsageTracker seeds correctly.
  lastContextUsage: Usage | null;
  // Present once, on a fork's first snapshot ⇒ composer prefill; consumed once.
  droppedText?: string;
  // The session's pending context chip (src/contextChip.ts), null when none.
  chip: ContextChip | null;
}

export interface ResetSnapshotFrame {
  t: 'reset_snapshot';
  id: string;
  project: string;
  status: string;
  mode: string;
  sessionId: string | null;
  events: UiEvent[];
  // Present ⇒ rewind prefill.
  droppedText?: string;
}

// The argument of the manager's `snapshot_reset` event.
export type ResetSnapshotPayload = Omit<ResetSnapshotFrame, 't'>;

// Never a pull-only (replayed history) event.
export interface EventFrame {
  t: 'event';
  id: string;
  ev: UiEvent;
}

// Sent before every forwarded outer system/init.
export interface SegmentFrame {
  t: 'segment';
  id: string;
  currentSegmentId: string | null;
}

export interface StatusFrame {
  t: 'status';
  id: string;
  status: string;
  sessionId: string | null;
  mode: string;
  model: string | null;
  backend: string;
  autoApprovePlan: boolean;
  playbookEnforcement: string;
  interrupting: boolean;
  modelSwitch: ModelSwitchState | null;
  modelSwitchFailure: ModelSwitchFailure | null;
}

// The session's pending context chip changed: the new chip, or null once it is
// cleared or consumed.
export interface ChipFrame {
  t: 'chip';
  id: string;
  chip: ContextChip | null;
}

// Hint to re-fetch GET /api/instances.
export interface InstancesHintFrame { t: 'instances' }
// Hint to re-fetch GET /api/projects.
export interface ProjectsHintFrame { t: 'projects' }
export interface ResumeNoticesFrame { t: 'resume_notices' }
export interface HelloFrame { t: 'hello' }

export interface AckFrame {
  t: 'ack';
  reqId: string | null;
  ok: boolean;
  error?: string;
}

export interface ErrorFrame {
  t: 'error';
  message: string;
}

export type ServerFrame = SnapshotFrame | ResetSnapshotFrame | EventFrame | SegmentFrame | StatusFrame | ChipFrame
  | InstancesHintFrame | ProjectsHintFrame | ResumeNoticesFrame | HelloFrame | AckFrame | ErrorFrame;

export type ServerFrameOf<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;
