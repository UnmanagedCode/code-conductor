// The UI event stream's one type: what the server emits (src/parser.ts,
// src/transcript.ts, src/instances.ts and the history pagers) and what the web
// client consumes (web/src/conversation/model.ts and the header trackers).
// Erased at build time — no runtime code lives here.
//
// Each field is typed as its producer emits it and its consumers rely on it;
// where a producer only holds an `unknown` CLI value, it asserts the type once,
// at construction. `system` subtypes are an open set (the parser passes any CLI
// system frame through), so `SystemData` is one interface naming every field a
// consumer reads rather than a per-subtype union.

import type { Usage, RateLimitInfo } from './usage.ts';
import type { Question } from './userQuestionAnswers.ts';

interface UiEventBase {
  // The wrapping stream-json envelope's parent_tool_use_id, tagged by the
  // parser; events the server builds itself carry none.
  parentToolUseId?: string | null;
  // The ring/archive sequence number; absent on seq-less events.
  _seq?: number;
}

// A user_echo attachment. Both producers set the first four fields; the prompt
// path adds the media type and the inlined bytes.
export interface UserEchoAttachment {
  kind: 'image' | 'file';
  name: string;
  path: string;
  filename: string;
  mediaType?: string;
  dataBase64?: string;
}

// One content block of an assistant_message's message, as the CLI sends it.
export interface AssistantContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
}

// The CLI's assistant envelope message, passed through whole.
export interface AssistantWireMessage {
  id?: string;
  model?: string;
  usage?: Usage;
  content?: AssistantContentBlock[];
}

// A `system` event's payload: a CLI system frame passed through whole, or the
// object a server-built subtype carries.
export interface SystemData {
  // CLI frames
  session_id?: string;
  model?: string;
  permissionMode?: string;
  status?: string | null;
  compact_result?: string;
  compact_error?: string | null;
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  rate_limit_info?: RateLimitInfo;
  isUsingOverage?: boolean;
  resets_at?: number;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> };
  request_id?: string;
  task_id?: string | null;
  task_type?: string;
  is_backgrounded?: boolean;
  tool_use_id?: string;
  patch?: { status?: string };
  tasks?: unknown[];
  // Server-built subtypes
  line?: string;
  message?: string;
  code?: number | string | null;
  signal?: string | null;
  stderr?: string | null;
  from?: string;
  to?: string;
  fromBackend?: string;
  toBackend?: string;
  restart?: boolean;
  switchId?: string;
  cancelled?: boolean;
  error?: string;
  sessionId?: string;
  forwardSessionId?: string;
  count?: number;
  text?: string;
  tool?: string;
  reason?: string;
  stage?: string;
  cacheRead?: number;
  cacheCreation?: number;
  prevPrefix?: number;
  evicted?: number;
  ok?: boolean;
  comesUpIdle?: boolean;
  pending?: number;
  resume?: boolean;
  resetsAt?: number | null;
  output_file?: string;
  name?: string | null;
  exitCode?: number | null;
  summary?: string;
  notified?: boolean;
}

// A task in a task_completion batch: the fields its bubble shows. The client's
// TaskTracker list and the server's reconstructed records both carry more.
export interface CompletedTask { id: string; subject: string }

interface BlockAddress { msgId: string | null; blockIdx: number }

interface MessageStartEvent extends UiEventBase {
  kind: 'message_start';
  msgId: string | null;
  usage: Usage | null;
  model?: string | null;
  replayed?: true;
}
interface ContextUsageEvent extends UiEventBase { kind: 'context_usage'; msgId: string | null; usage: Usage }
interface CallUsageEvent extends UiEventBase {
  kind: 'call_usage';
  msgId: string | null;
  outputTokens: number;
  thinkingTokens: number | null;
  promptTokens?: number | null;
  growthTokens?: number | null;
}
interface TextDeltaEvent extends UiEventBase, BlockAddress { kind: 'text_delta'; text: string }
interface TextEndEvent extends UiEventBase, BlockAddress { kind: 'text_end' }
interface ThinkingStartEvent extends UiEventBase, BlockAddress { kind: 'thinking_start' }
// `narration` is set on every delta of a narration block (src/narration.ts),
// live and on replay; the block's thinking_start / thinking_end carry nothing.
interface ThinkingDeltaEvent extends UiEventBase, BlockAddress { kind: 'thinking_delta'; text: string; narration?: true }
interface ThinkingEndEvent extends UiEventBase, BlockAddress { kind: 'thinking_end' }
interface ThinkingRedactedEvent extends UiEventBase, BlockAddress { kind: 'thinking_redacted'; estimatedTokens?: number }
interface ToolUseStartEvent extends UiEventBase, BlockAddress {
  kind: 'tool_use_start';
  toolUseId: string | null;
  name: string | null;
}
interface ToolUseInputDeltaEvent extends UiEventBase, BlockAddress {
  kind: 'tool_use_input_delta';
  toolUseId: string | null;
  partialJson: string;
}
interface ToolUseEvent extends UiEventBase, BlockAddress {
  kind: 'tool_use';
  toolUseId: string | null;
  name: string | null;
  input: Record<string, unknown>;
  startedAt?: number;
}
interface UserQuestionEvent extends UiEventBase { kind: 'user_question'; toolUseId: string | null; questions: Question[] }
interface PlanRequestEvent extends UiEventBase {
  kind: 'plan_request';
  toolUseId: string | null;
  plan: string | null;
  planPath: string | null;
  autoApproved?: true;
}
interface ToolResultEvent extends UiEventBase {
  kind: 'tool_result';
  toolUseId: string | null;
  content: unknown;
  isError: boolean;
  yielded?: true;
  finishedAt: number;
  agentTokens?: number;
  agentToolUses?: number | null;
}
interface UserEchoEvent extends UiEventBase {
  kind: 'user_echo';
  text: string;
  attachments?: UserEchoAttachment[];
  skillLoad?: { skill: string | null };
  cliInjected?: true;
  compactSummary?: true;
  questionAnswer?: { toolUseId: string | null; questions: Question[] };
  userIndex?: number;
}
interface CompactionEvent extends UiEventBase {
  kind: 'compaction';
  trigger: 'auto' | 'manual' | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
}
interface HookEvent extends UiEventBase { kind: 'hook'; event: unknown; data: unknown }
// `blockIdx` is the message-level index of `message.content[0]`: the CLI sends
// one message as one envelope or as one envelope per block, and the parser
// counts the blocks of every envelope it saw for the message, so the index holds
// even when the ring has since dropped an earlier envelope.
interface AssistantMessageEvent extends UiEventBase { kind: 'assistant_message'; msgId: string | null; blockIdx: number; message: AssistantWireMessage }
interface TurnEndEvent extends UiEventBase {
  kind: 'turn_end';
  subtype: string;
  stopReason: string | null;
  durationMs: number | null;
  durationApiMs: number | null;
  durationApiMsDelta: number | null;
  cost: number | null;
  costDelta: number | null;
  usage: Usage | null;
  isError: boolean;
  // Stamped by Instance on the live path.
  cacheMiss?: boolean;
  firstReqCacheRead?: number;
  firstReqCacheCreation?: number;
  firstReqEvicted?: number;
  contextTokens?: number | null;
  contextGrowthTokens?: number | null;
  contextWindowTokens?: number | null;
}
/**
 * Replay only: an unprompted turn starts here, delivering a background task's notification. Built
 * from the delivered `<task-notification>` user line; the live stream has `turn_end` instead.
 */
interface TurnBoundaryEvent extends UiEventBase { kind: 'turn_boundary'; toolUseId: string | null; status: string | null }
interface ControlResponseEvent extends UiEventBase {
  kind: 'control_response';
  requestId: unknown;
  ok: boolean;
  response: unknown;
  error: unknown;
}
interface RawEvent extends UiEventBase { kind: 'raw'; line: string }
interface OverageMessageQueuedEvent extends UiEventBase {
  kind: 'overage_message_queued';
  data: { text: string; attachmentCount: number; ts: number; queuedCount: number };
}
interface SegmentSeamEvent extends UiEventBase { kind: 'segment_seam'; segmentId: string | null }
interface HistoryGapEvent extends UiEventBase { kind: 'history_gap' }
interface TaskCompletionEvent extends UiEventBase { kind: 'task_completion'; tasks: CompletedTask[] }
interface SystemEvent extends UiEventBase {
  kind: 'system';
  subtype: string;
  data?: SystemData;
  toolUseId?: string | null;
  replayed?: true;
}

export type UiEvent =
  | MessageStartEvent | ContextUsageEvent | CallUsageEvent
  | TextDeltaEvent | TextEndEvent
  | ThinkingStartEvent | ThinkingDeltaEvent | ThinkingEndEvent | ThinkingRedactedEvent
  | ToolUseStartEvent | ToolUseInputDeltaEvent | ToolUseEvent
  | UserQuestionEvent | PlanRequestEvent | ToolResultEvent | UserEchoEvent
  | CompactionEvent | HookEvent | AssistantMessageEvent | TurnEndEvent | TurnBoundaryEvent | ControlResponseEvent
  | RawEvent | OverageMessageQueuedEvent | SegmentSeamEvent | HistoryGapEvent | TaskCompletionEvent
  | SystemEvent;

// One member of the union, by kind.
export type UiEventOf<K extends UiEvent['kind']> = Extract<UiEvent, { kind: K }>;
