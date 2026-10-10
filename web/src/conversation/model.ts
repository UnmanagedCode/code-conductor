// The conversation as data. Consumes the server's parser-style UI events
// (kind: text_delta, tool_use, user_echo, …) and maintains a tree of plain
// nodes that React renders (./Conversation.tsx). No DOM here, so every
// sequencing rule — dedupe by `_seq`, one assistant envelope per streak of
// calls, the machinery run folded into an action group, sub-agent nesting,
// parked child events, compaction, segment provenance, the lazy-history splice —
// lives in one testable place.
//
// Mutation model: nodes are mutable; every change bumps the node's `rev` and its
// ancestors', and schedules one notification. Components memoize on `rev`.

import { parseWakeCallback } from '../../../public/wakeCallback.ts';
import { parseRenewSeed } from '../../../public/renewSeed.ts';
import { parseForwardFrame, splitForwardedMessages } from '../../../public/forwardFrame.ts';
import { promptOrigin } from '../../../public/promptOrigin.ts';
import { parseCanonicalUserQuestionAnswers } from '../../../public/userQuestionAnswers.ts';
import type { UiEvent } from '@/state/types';

// ── Node types ───────────────────────────────────────────────────────────

type Base = { id: string; rev: number; parent: ParentRef };
type ParentRef = NodeT | ConversationModel | null;

export type TextNode = Base & { type: 'text'; buffer: string; finalized: boolean };
export type ThinkingNode = Base & { type: 'thinking'; buffer: string; finalized: boolean; redacted: boolean; tokens: number };
export type ResultNode = Base & {
  type: 'result';
  toolUseId: string | null;
  content: unknown;
  isError: boolean;
  yielded: boolean;
  agentUsage: { tokens: number; toolUses: number | null } | null;
};
export type ToolStatus = 'streaming' | 'running' | 'done' | 'errored' | 'handed to user' | 'incomplete';
export type ToolNode = Base & {
  type: 'tool';
  name: string;
  toolUseId: string | null;
  partialJson: string;
  input: Record<string, any> | null;
  status: ToolStatus;
  startedAt: number | null;
  elapsedMs: number | null;
  agentUsage: { tokens: number; toolUses: number | null } | null;
  result: ResultNode | null;
  sub: ConversationModel | null;
};
export type CallUsageNode = Base & { type: 'call_usage'; ev: UiEvent };
export type GroupChild = ThinkingNode | ToolNode | ResultNode | CallUsageNode;
export type GroupNode = Base & { type: 'group'; children: GroupChild[]; open: boolean; userToggled: boolean };
export type AssistantChild = TextNode | GroupNode | CallUsageNode;
export type AssistantNode = Base & {
  type: 'assistant';
  children: AssistantChild[];
  view: 'rendered' | 'raw';
  planText: string | null;
  /** The open action group, while the machinery run continues. */
  openGroup: GroupNode | null;
};
export type UserVariant = 'plain' | 'wake' | 'renew' | 'forward' | 'answer';
export type UserNode = Base & {
  type: 'user';
  variant: UserVariant;
  /** The raw event text (what rewind/fork send back). */
  rawText: string;
  /** The user-text body shown below any folded part ('' when none). */
  displayText: string;
  transcribed: boolean;
  skill: { name: string; text: string } | null;
  wake: { summary: string; body: string | null } | null;
  renew: { text: string } | null;
  forward: { payload: string; count: number } | null;
  answer: { questions: any[]; answers: any[] | null } | null;
  attachments: any[];
  userIndex: number | null;
  segmentId: string | null;
  origin: string;
};
export type SystemNode = Base & { type: 'system'; ev: UiEvent };
export type TurnEndNode = Base & { type: 'turn_end'; ev: UiEvent };
export type PlanNode = Base & {
  type: 'plan';
  ev: UiEvent;
  autoApproved: boolean;
  submitted: false | 'approve' | 'reject';
  failedReason: string | null;
};
export type AnswerState =
  | { kind: 'none' }
  | { kind: 'option'; label: string; note?: string }
  | { kind: 'multi'; labels: string[]; note?: string }
  | { kind: 'custom'; text: string };
export type QuestionNode = Base & {
  type: 'question';
  toolUseId: string;
  questions: any[];
  answers: AnswerState[];
  drafts: string[];
  submitted: boolean;
  answered: boolean;
  failedReason: string | null;
};
export type TaskCompletionNode = Base & { type: 'task_completion'; tasks: { id: string; subject: string }[] };
export type QueuedNode = Base & { type: 'queued'; ev: UiEvent; delivered: boolean };
export type CompactionNode = Base & {
  type: 'compaction';
  state: 'running' | 'done' | 'failed';
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  error: string | null;
  summary: string | null;
};
export type DividerNode = Base & { type: 'divider'; kind: 'gap' | 'seam' | 'replayed'; segmentId?: string | null; count?: number };

export type RootItem =
  | UserNode | AssistantNode | SystemNode | TurnEndNode | PlanNode | QuestionNode
  | TaskCompletionNode | QueuedNode | CompactionNode | DividerNode;
export type NodeT = RootItem | AssistantChild | GroupChild;

// ── Rules shared with the old renderer ───────────────────────────────────

// System annotations that END the machinery run (interrupt, process death).
const RUN_ENDING_SYSTEM_SUBTYPES = new Set(['soft_interrupted', 'exit']);
// Content that ends the window in which a compaction's own command output is absorbed.
const COMPACTION_WINDOW_ENDERS = new Set(['text_delta', 'thinking_start', 'tool_use_start', 'tool_result', 'turn_end']);
const TRANSCRIBED_PREFIX = '<transcribed>\n';

const SHOWN_SYSTEM_SUBTYPES = new Set([
  'init', 'stderr', 'exit', 'spawn_error', 'crashed',
  'permission_denied', 'history_load_error', 'auto_stop_overage',
  'auto_resume', 'auto_resume_skipped', 'soft_interrupted', 'drain_abort',
  'model_changed', 'model_switch_failed', 'cache_miss', 'playbook_warn', 'renew_error', 'read_nudge',
]);

/** Which system events the conversation shows; the rest is per-turn noise. */
export function shouldRenderSystem(ev: UiEvent): boolean {
  const sub = ev.subtype;
  if (sub === 'rate_limit_event') {
    const status = ev.data?.rate_limit_info?.status;
    return !!status && status !== 'allowed';
  }
  if (sub === 'status') return false;
  if (sub === 'task_progress' || sub === 'task_started' || sub === 'task_updated') return false;
  if (sub === 'task_notification') return ev.data?.notified === true;
  return SHOWN_SYSTEM_SUBTYPES.has(sub);
}

export const isCompactCommandText = (t: string) => /^<command-name>\/compact<\/command-name>/.test(t);
export const isLocalCommandStdoutText = (t: string) => /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(t.trim());

/** Which user-bubble actions an instance in `status` takes. Rewind needs idle; fork works mid-turn. */
export function userActionsForStatus(status: string | null | undefined) {
  return { rewind: status === 'idle', fork: status === 'idle' || status === 'turn' };
}

function answersToLock(questions: any[], text: string): AnswerState[] {
  return parseCanonicalUserQuestionAnswers(questions, text) ?? questions.map(() => ({ kind: 'none' as const }));
}

let nextId = 1;
const newId = () => `n${nextId++}`;

// ── The model ────────────────────────────────────────────────────────────

export type ModelOptions = {
  isSub?: boolean;
  /** The tool node hosting this sub-conversation. */
  host?: ToolNode | null;
  /** The top-level model (notifications go through it). */
  root?: ConversationModel | null;
  /** Backing segment of the first rendered event (a lazy page's `pageSegment`). */
  segmentId?: string | null;
  /** For a batch rendered off the live model: reads the live current segment. */
  currentSegmentGetter?: (() => string | null) | null;
  answeredQuestions?: Map<string, string> | null;
  questionNodes?: Map<string, QuestionNode> | null;
  /** Fired when an outer assistant text block finalizes (TTS auto-speak). */
  onAssistantText?: ((node: TextNode) => void) | null;
};

export class ConversationModel {
  items: RootItem[] = [];
  rev = 0;
  readonly isSub: boolean;
  readonly host: ToolNode | null;
  readonly root: ConversationModel;
  segmentId: string | null;
  currentSegmentId: string | null = null;
  /** The current segment a lazy page reported, used until the live view learns its own. */
  private pageCurrentSegmentId: string | null = null;
  private currentSegmentGetter: (() => string | null) | null;
  onAssistantText: ((node: TextNode) => void) | null;

  questionNodes: Map<string, QuestionNode>;
  planNodes = new Map<string, PlanNode>();
  answeredQuestions: Map<string, string>;
  private blocksByKey = new Map<string, TextNode | ThinkingNode | ToolNode>();
  toolBlocks = new Map<string, ToolNode>();
  private seenSeq = new Set<number>();
  private messageWraps = new Map<string, AssistantNode>();
  private reconcileCounts = new Map<string, number>();
  private subConvs = new Map<string, ConversationModel>();
  private activeWrap: AssistantNode | null = null;
  private activeThinkingKey: string | null = null;
  /** First assistant wrap before any segment-closer: the merge target for a page spliced above. */
  leadingAssistantWrap: AssistantNode | null = null;
  private sawSegmentCloser = false;
  /** Live sub-agent events whose parent Agent block isn't rendered yet. */
  orphanChildEvents = new Map<string, UiEvent[]>();
  private pendingCompaction: CompactionNode | null = null;
  private compaction: CompactionNode | null = null;

  // Notification (top-level model only).
  private listeners = new Set<() => void>();
  private holds = 0;
  private dirty = false;
  private scheduled = false;

  constructor(opts: ModelOptions = {}) {
    this.isSub = !!opts.isSub;
    this.host = opts.host ?? null;
    this.root = opts.root ?? this;
    this.segmentId = opts.segmentId ?? null;
    this.currentSegmentGetter = opts.currentSegmentGetter ?? null;
    this.answeredQuestions = opts.answeredQuestions ?? new Map();
    this.questionNodes = opts.questionNodes ?? new Map();
    this.onAssistantText = opts.onAssistantText ?? null;
  }

  // ── Subscription ──────────────────────────────────────────────────────

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getRev = () => this.rev;

  /** Run fn with notifications held until it returns (one render for a replay). */
  batch<T>(fn: () => T): T {
    const r = this.root;
    r.holds++;
    try {
      return fn();
    } finally {
      if (--r.holds === 0 && r.dirty) r.flush();
    }
  }

  private changed() {
    const r = this.root;
    r.rev++;
    r.dirty = true;
    if (r.holds > 0 || r.scheduled) return;
    r.scheduled = true;
    queueMicrotask(() => {
      r.scheduled = false;
      if (r.holds === 0 && r.dirty) r.flush();
    });
  }

  private flush() {
    this.dirty = false;
    for (const fn of this.listeners) fn();
  }

  /** Bump a node and every ancestor up to the model (and through a sub-model's host). */
  touch(node: NodeT | null) {
    let n: ParentRef = node;
    while (n) {
      if (n instanceof ConversationModel) {
        n.rev++;
        n = n.host;
        continue;
      }
      n.rev++;
      n = n.parent;
    }
    this.changed();
  }

  private make<T extends NodeT>(fields: Omit<T, 'id' | 'rev' | 'parent'>, parent: ParentRef): T {
    return { id: newId(), rev: 0, parent, ...fields } as T;
  }

  private pushRoot(item: RootItem) {
    item.parent = this;
    this.items.push(item);
    this.rev++;
    this.touch(null);
    if (this.host) this.touch(this.host);
  }

  // ── Public API ────────────────────────────────────────────────────────

  clear() {
    this.items = [];
    this.blocksByKey.clear();
    this.toolBlocks.clear();
    this.seenSeq.clear();
    this.messageWraps.clear();
    this.reconcileCounts.clear();
    this.subConvs.clear();
    this.questionNodes.clear();
    this.answeredQuestions.clear();
    this.planNodes.clear();
    this.activeWrap = null;
    this.activeThinkingKey = null;
    this.leadingAssistantWrap = null;
    this.sawSegmentCloser = false;
    this.orphanChildEvents.clear();
    this.pendingCompaction = null;
    this.compaction = null;
    this.segmentId = null;
    this.currentSegmentId = null;
    this.pageCurrentSegmentId = null;
    this.rev++;
    this.changed();
  }

  setCurrentSegment(id: string | null) {
    this.currentSegmentId = id ?? null;
    this.rev++;
    this.changed();
  }

  currentSegment(): string | null {
    return this.currentSegmentGetter ? this.currentSegmentGetter() : this.currentSegmentId ?? this.pageCurrentSegmentId;
  }

  applyEvents(events: UiEvent[]) {
    this.batch(() => { for (const ev of events) this.apply(ev); });
  }

  apply(ev: UiEvent) {
    if (ev._seq != null) {
      if (this.seenSeq.has(ev._seq)) return;
      this.seenSeq.add(ev._seq);
    }
    if (ev.parentToolUseId) {
      if (this.routeChildEvent(ev)) return;
      if (!this.isSub && !this.toolBlocks.has(ev.parentToolUseId)) {
        this.parkChildEvent(ev);
        return;
      }
    }
    this.renderEvent(ev);
  }

  /** For a static batch (a lazy page): settle every block still streaming. */
  finalizeDanglingBlocks() {
    for (const b of this.blocksByKey.values()) {
      if (b.type === 'text' || b.type === 'thinking') this.finalizeNode(b);
    }
    for (const t of this.toolBlocks.values()) {
      if (t.status === 'streaming' || t.status === 'running') {
        t.status = 'incomplete';
        this.touch(t);
      }
    }
    this.closeAllActionGroups();
    for (const sub of this.subConvs.values()) sub.finalizeDanglingBlocks();
  }

  // Card state transitions driven by the UI.
  questionPick(node: QuestionNode, idx: number, label: string) {
    if (node.submitted) return;
    const q = node.questions[idx];
    const current = node.answers[idx];
    const draft = node.drafts[idx];
    let labels: string[];
    if (q.multiSelect) {
      labels = current.kind === 'multi' ? [...current.labels] : [];
      const at = labels.indexOf(label);
      if (at >= 0) labels.splice(at, 1);
      else labels.push(label);
    } else {
      labels = current.kind === 'option' && current.label === label ? [] : [label];
    }
    if (labels.length === 0) node.answers[idx] = draft.length > 0 ? { kind: 'custom', text: draft } : { kind: 'none' };
    else if (q.multiSelect) node.answers[idx] = draft.length > 0 ? { kind: 'multi', labels, note: draft } : { kind: 'multi', labels };
    else node.answers[idx] = draft.length > 0 ? { kind: 'option', label: labels[0], note: draft } : { kind: 'option', label: labels[0] };
    this.touch(node);
  }

  questionDraft(node: QuestionNode, idx: number, text: string) {
    if (node.submitted) return;
    node.drafts[idx] = text;
    const current = node.answers[idx];
    if (current.kind === 'option' || current.kind === 'multi') {
      const next = { ...current } as AnswerState & { note?: string };
      if (text.length > 0) next.note = text;
      else delete next.note;
      node.answers[idx] = next;
    } else {
      node.answers[idx] = text.length === 0 ? { kind: 'none' } : { kind: 'custom', text };
    }
    this.touch(node);
  }

  static questionReady(node: QuestionNode): boolean {
    return node.answers.length > 0 && node.answers.every((a) => (a.kind === 'none' ? false : a.kind === 'custom' ? a.text.trim().length > 0 : true));
  }

  questionSubmitted(node: QuestionNode) {
    node.submitted = true;
    node.failedReason = null;
    this.touch(node);
  }

  questionSendFailed(toolUseId: string, reason: string) {
    const node = this.questionNodes.get(toolUseId);
    if (!node || !node.submitted || node.answered) return;
    node.submitted = false;
    node.failedReason = reason;
    this.touch(node);
  }

  planSubmitted(node: PlanNode, decision: 'approve' | 'reject') {
    node.submitted = decision;
    node.failedReason = null;
    this.touch(node);
  }

  planSendFailed(toolUseId: string, reason: string) {
    const node = this.planNodes.get(toolUseId);
    if (!node || !node.submitted || node.autoApproved) return;
    node.submitted = false;
    node.failedReason = reason;
    this.touch(node);
  }

  setGroupOpen(node: GroupNode, open: boolean) {
    node.open = open;
    node.userToggled = true;
    this.touch(node);
  }

  setAssistantView(node: AssistantNode, view: 'rendered' | 'raw') {
    node.view = view;
    this.touch(node);
  }

  /** Text a whole assistant bubble copies: its text blocks, then the plan it closed. */
  static assistantCopyText(node: AssistantNode): string {
    const parts = node.children.filter((c): c is TextNode => c.type === 'text').map((t) => t.buffer).filter((t) => t.trim() !== '');
    if (node.planText) parts.push(node.planText);
    return parts.join('\n\n');
  }

  // ── Routing ───────────────────────────────────────────────────────────

  private routeChildEvent(ev: UiEvent): boolean {
    const parent = this.toolBlocks.get(ev.parentToolUseId);
    if (!parent || parent.name !== 'Agent') {
      for (const sub of this.subConvs.values()) if (sub.routeChildEvent(ev)) return true;
      return false;
    }
    let sub = this.subConvs.get(ev.parentToolUseId);
    if (!sub) {
      sub = new ConversationModel({ isSub: true, host: parent, root: this.root, onAssistantText: null });
      this.subConvs.set(ev.parentToolUseId, sub);
      parent.sub = sub;
      this.touch(parent);
    }
    sub.apply(ev);
    return true;
  }

  private parkChildEvent(ev: UiEvent) {
    let parked = this.orphanChildEvents.get(ev.parentToolUseId);
    if (!parked) {
      parked = [];
      this.orphanChildEvents.set(ev.parentToolUseId, parked);
    }
    parked.push(ev);
    if (parked.length > 500) parked.shift();
  }

  /** Register a tool block a lazy page rendered and replay its parked children in arrival order. */
  adoptToolBlock(toolUseId: string, block: ToolNode) {
    if (!toolUseId || !block || this.toolBlocks.has(toolUseId)) return;
    this.toolBlocks.set(toolUseId, block);
    const parked = this.orphanChildEvents.get(toolUseId);
    this.orphanChildEvents.delete(toolUseId);
    if (!parked) return;
    this.batch(() => {
      for (const ev of parked) if (!this.routeChildEvent(ev)) this.renderEvent(ev);
    });
  }

  private renderEvent(ev: UiEvent) {
    if (ev.kind === 'user_question') return this.renderUserQuestion(ev);
    if (ev.kind === 'plan_request') return this.renderPlanRequest(ev);
    if (ev.kind === 'call_usage') return this.renderCallUsage(ev);
    if (COMPACTION_WINDOW_ENDERS.has(ev.kind)) this.compaction = null;
    switch (ev.kind) {
      case 'compaction': return this.renderCompaction(ev);
      case 'user_echo':
        this.lockAnsweredCard(ev);
        return this.renderUserEcho(ev);
      case 'text_delta': return this.appendStreaming(ev, 'text', ev.text ?? '');
      case 'text_end': return this.finalizeBlock(ev);
      case 'thinking_start': return this.renderThinkingStart(ev);
      case 'thinking_delta': return this.appendStreaming(ev, 'thinking', ev.text ?? '');
      case 'thinking_end': return this.finalizeBlock(ev);
      case 'thinking_redacted': return this.renderThinkingRedacted(ev);
      case 'tool_use_start': return this.renderToolStart(ev);
      case 'tool_use_input_delta': return this.renderToolInputDelta(ev);
      case 'tool_use': return this.renderToolFinal(ev);
      case 'tool_result': return this.renderToolResult(ev);
      case 'task_completion':
        return this.pushRoot(this.make<TaskCompletionNode>({ type: 'task_completion', tasks: ev.tasks ?? [] }, this));
      case 'history_gap': return this.renderHistoryGap();
      case 'segment_seam': return this.renderSegmentSeam(ev);
      case 'overage_message_queued':
        return this.pushRoot(this.make<QueuedNode>({ type: 'queued', ev, delivered: false }, this));
      case 'system': return this.renderSystemEvent(ev);
      case 'turn_end':
        this.failPendingCompaction(null);
        this.closeAllActionGroups();
        return this.pushRoot(this.make<TurnEndNode>({ type: 'turn_end', ev }, this));
      case 'assistant_message':
        // Outer turns are driven by stream deltas; sub-agent turns arrive only as envelopes.
        if (this.isSub) this.reconcileAssistantMessage(ev);
        return;
      case 'raw':
        return this.pushRoot(this.make<SystemNode>({ type: 'system', ev: { kind: 'system', subtype: 'raw', data: { line: ev.line } } }, this));
      default:
        return;
    }
  }

  private renderSystemEvent(ev: UiEvent) {
    if (ev.subtype === 'thinking_tokens') {
      const n = ev.data?.estimated_tokens ?? 0;
      const block = this.activeThinkingKey ? this.blocksByKey.get(this.activeThinkingKey) : null;
      if (block?.type === 'thinking' && !block.redacted) {
        block.tokens = n;
        this.touch(block);
      }
      return;
    }
    if (ev.subtype === 'history_replayed') {
      this.pushRoot(this.make<DividerNode>({ type: 'divider', kind: 'replayed', count: ev.data?.count ?? 0 }, this));
      this.closeAssistantSegment();
      return;
    }
    if (RUN_ENDING_SYSTEM_SUBTYPES.has(ev.subtype)) this.closeAllActionGroups();
    if (ev.subtype === 'exit' || ev.subtype === 'crashed') this.failPendingCompaction(null);
    if (this.renderCompactionStatus(ev)) return;
    if (ev.subtype === 'auto_resume') {
      for (const it of this.items) {
        if (it.type === 'queued' && !it.delivered) {
          it.delivered = true;
          this.touch(it);
        }
      }
    }
    if (!shouldRenderSystem(ev)) return;
    this.pushRoot(this.make<SystemNode>({ type: 'system', ev }, this));
  }

  // ── Assistant envelopes and action groups ─────────────────────────────

  private ensureMessageWrap(msgId: string | null | undefined): AssistantNode {
    const key = msgId || '__floating__';
    const existing = this.messageWraps.get(key);
    if (existing) return existing;
    if (this.activeWrap) {
      this.messageWraps.set(key, this.activeWrap);
      return this.activeWrap;
    }
    const w = this.make<AssistantNode>({ type: 'assistant', children: [], view: 'rendered', planText: null, openGroup: null }, this);
    this.pushRoot(w);
    this.messageWraps.set(key, w);
    this.activeWrap = w;
    if (!this.sawSegmentCloser && !this.leadingAssistantWrap) this.leadingAssistantWrap = w;
    return w;
  }

  private appendToWrap(wrap: AssistantNode, node: AssistantChild | GroupChild, grouped: boolean) {
    if (!grouped) {
      this.closeGroup(wrap);
      node.parent = wrap;
      wrap.children.push(node as AssistantChild);
      this.touch(wrap);
      return;
    }
    let g = wrap.openGroup;
    if (!g || !wrap.children.includes(g)) {
      g = this.make<GroupNode>({ type: 'group', children: [], open: true, userToggled: false }, wrap);
      wrap.children.push(g);
      wrap.openGroup = g;
    }
    node.parent = g;
    g.children.push(node as GroupChild);
    this.touch(g);
  }

  private closeGroup(wrap: AssistantNode | null | undefined) {
    const g = wrap?.openGroup;
    if (!wrap || !g) return;
    if (!g.userToggled) g.open = false;
    wrap.openGroup = null;
    this.touch(g);
  }

  private closeAllActionGroups() {
    for (const w of new Set(this.messageWraps.values())) this.closeGroup(w);
    for (const sub of this.subConvs.values()) sub.closeAllActionGroups();
  }

  private closeAssistantSegment() {
    this.closeAllActionGroups();
    this.activeWrap = null;
    this.sawSegmentCloser = true;
  }

  private appendStreaming(ev: UiEvent, type: 'text' | 'thinking', delta: string) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:${type}`;
    let block = this.blocksByKey.get(key) as TextNode | ThinkingNode | undefined;
    if (!block) {
      block = type === 'text'
        ? this.make<TextNode>({ type: 'text', buffer: '', finalized: false }, null)
        : this.make<ThinkingNode>({ type: 'thinking', buffer: '', finalized: false, redacted: false, tokens: 0 }, null);
      this.blocksByKey.set(key, block);
      const wrap = this.ensureMessageWrap(ev.msgId);
      this.appendToWrap(wrap, block, type !== 'text');
    }
    block.buffer += delta;
    this.touch(block);
  }

  private finalizeNode(block: TextNode | ThinkingNode) {
    if (block.finalized) return false;
    if (block.type === 'text' && !block.buffer.trim()) return false;
    if (block.type === 'thinking' && block.redacted) return false;
    block.finalized = true;
    this.touch(block);
    return true;
  }

  private finalizeBlock(ev: UiEvent) {
    const t = ev.kind === 'text_end' ? 'text' : 'thinking';
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:${t}`;
    const block = this.blocksByKey.get(key) as TextNode | ThinkingNode | undefined;
    if (block) this.finalizeNode(block);
    if (t === 'thinking') this.activeThinkingKey = null;
    if (t === 'text' && !this.isSub && block?.type === 'text' && block.buffer) this.onAssistantText?.(block);
  }

  private renderThinkingStart(ev: UiEvent) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:thinking`;
    if (this.blocksByKey.has(key)) return;
    const block = this.make<ThinkingNode>({ type: 'thinking', buffer: '', finalized: false, redacted: false, tokens: 0 }, null);
    this.blocksByKey.set(key, block);
    this.appendToWrap(this.ensureMessageWrap(ev.msgId), block, true);
    this.activeThinkingKey = key;
  }

  private renderThinkingRedacted(ev: UiEvent) {
    const key = `${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:thinking`;
    let block = this.blocksByKey.get(key) as ThinkingNode | undefined;
    if (!block) {
      block = this.make<ThinkingNode>({ type: 'thinking', buffer: '', finalized: false, redacted: false, tokens: 0 }, null);
      this.blocksByKey.set(key, block);
      this.appendToWrap(this.ensureMessageWrap(ev.msgId), block, true);
    }
    if (ev.estimatedTokens != null) block.tokens = ev.estimatedTokens;
    block.redacted = true;
    this.touch(block);
  }

  private renderToolStart(ev: UiEvent) {
    if (ev.toolUseId) {
      if (this.toolBlocks.has(ev.toolUseId)) return;
    } else if (this.blocksByKey.has(`${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:tool`)) {
      return;
    }
    const block = this.make<ToolNode>({
      type: 'tool', name: ev.name ?? 'tool', toolUseId: ev.toolUseId ?? null, partialJson: '', input: null,
      status: 'streaming', startedAt: null, elapsedMs: null, agentUsage: null, result: null, sub: null,
    }, null);
    this.blocksByKey.set(`${ev.msgId ?? '?'}:${ev.blockIdx ?? 0}:tool`, block);
    if (ev.toolUseId) this.toolBlocks.set(ev.toolUseId, block);
    this.appendToWrap(this.ensureMessageWrap(ev.msgId), block, true);
  }

  private renderToolInputDelta(ev: UiEvent) {
    const block = this.toolBlocks.get(ev.toolUseId);
    if (!block) return;
    block.partialJson += ev.partialJson ?? '';
    try {
      const parsed = JSON.parse(block.partialJson);
      if (parsed && typeof parsed === 'object') block.input = parsed;
    } catch { /* not complete yet */ }
    this.touch(block);
  }

  private renderToolFinal(ev: UiEvent) {
    let block = this.toolBlocks.get(ev.toolUseId);
    if (!block) {
      this.renderToolStart(ev);
      block = this.toolBlocks.get(ev.toolUseId);
    }
    if (!block) return;
    if (ev.name) block.name = ev.name;
    block.input = ev.input ?? {};
    // A result can land before the final tool_use on replay; keep its terminal state.
    if (!block.result) {
      block.status = 'running';
      block.startedAt = ev.startedAt ?? Date.now();
    }
    this.touch(block);
  }

  private renderToolResult(ev: UiEvent) {
    const block = this.toolBlocks.get(ev.toolUseId);
    const agentUsage = Number.isFinite(ev.agentTokens)
      ? { tokens: ev.agentTokens, toolUses: Number.isFinite(ev.agentToolUses) ? ev.agentToolUses : null }
      : null;
    const result = this.make<ResultNode>({
      type: 'result', toolUseId: ev.toolUseId ?? null, content: ev.content, isError: !!ev.isError, yielded: !!ev.yielded, agentUsage,
    }, null);
    if (block) {
      result.parent = block;
      block.result = result;
      if (block.startedAt) {
        const end = ev.finishedAt ?? Date.now();
        const s = Math.floor((end - block.startedAt) / 1000);
        block.elapsedMs = s > 0 ? s * 1000 : null;
      }
      block.status = result.yielded ? 'handed to user' : result.isError ? 'errored' : 'done';
      block.agentUsage = agentUsage;
      this.touch(block);
    } else {
      this.appendToWrap(this.ensureMessageWrap(null), result, true);
    }
  }

  private reconcileAssistantMessage(ev: UiEvent) {
    const msgId = ev.msgId;
    const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const base = this.reconcileCounts.get(msgId) ?? 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      const idx = base + i;
      if (b.type === 'tool_use') {
        if (b.id && this.toolBlocks.has(b.id)) continue;
        this.renderToolStart({ kind: 'tool_use_start', msgId, blockIdx: idx, toolUseId: b.id, name: b.name });
        this.renderToolFinal({ kind: 'tool_use', msgId, blockIdx: idx, toolUseId: b.id, name: b.name, input: b.input ?? {} });
      } else if (b.type === 'text') {
        if (this.blocksByKey.has(`${msgId ?? '?'}:${idx}:text`)) continue;
        this.appendStreaming({ kind: 'text_delta', msgId, blockIdx: idx }, 'text', b.text ?? '');
        this.finalizeBlock({ kind: 'text_end', msgId, blockIdx: idx });
      } else if (b.type === 'thinking') {
        if (this.blocksByKey.has(`${msgId ?? '?'}:${idx}:thinking`)) continue;
        const txt = b.thinking ?? b.text ?? '';
        this.renderThinkingStart({ kind: 'thinking_start', msgId, blockIdx: idx });
        if (txt) this.appendStreaming({ kind: 'thinking_delta', msgId, blockIdx: idx }, 'thinking', txt);
        else this.renderThinkingRedacted({ kind: 'thinking_redacted', msgId, blockIdx: idx });
        this.finalizeBlock({ kind: 'thinking_end', msgId, blockIdx: idx });
      }
    }
    this.reconcileCounts.set(msgId, base + blocks.length);
  }

  private renderCallUsage(ev: UiEvent) {
    const wrap = this.messageWraps.get(ev.msgId);
    if (!wrap) return;
    const node = this.make<CallUsageNode>({ type: 'call_usage', ev }, null);
    const g = wrap.openGroup;
    if (g && wrap.children.includes(g)) {
      node.parent = g;
      g.children.push(node);
      this.touch(g);
    } else {
      node.parent = wrap;
      wrap.children.push(node);
      this.touch(wrap);
    }
  }

  // ── Cards ─────────────────────────────────────────────────────────────

  private renderPlanRequest(ev: UiEvent) {
    if (this.planNodes.has(ev.toolUseId)) return;
    const node = this.make<PlanNode>({ type: 'plan', ev, autoApproved: !!ev.autoApproved, submitted: false, failedReason: null }, this);
    this.planNodes.set(ev.toolUseId, node);
    this.pushRoot(node);
    const w = this.activeWrap;
    if (w && typeof ev.plan === 'string' && ev.plan.trim()) {
      w.planText = ev.plan;
      this.touch(w);
    }
    this.closeAssistantSegment();
  }

  private renderUserQuestion(ev: UiEvent) {
    if (this.questionNodes.has(ev.toolUseId)) return;
    const questions = Array.isArray(ev.questions) ? ev.questions : [];
    const node = this.make<QuestionNode>({
      type: 'question', toolUseId: ev.toolUseId, questions,
      answers: questions.map(() => ({ kind: 'none' as const })),
      drafts: questions.map(() => ''),
      submitted: false, answered: false, failedReason: null,
    }, this);
    this.questionNodes.set(ev.toolUseId, node);
    const answered = this.answeredQuestions.get(ev.toolUseId);
    if (answered !== undefined) this.lockQuestion(node, answersToLock(questions, answered));
    this.pushRoot(node);
    this.closeAssistantSegment();
  }

  private lockQuestion(node: QuestionNode, answers: AnswerState[] | null) {
    if (!node.submitted && Array.isArray(answers)) {
      node.answers = answers;
      node.drafts = node.questions.map((_, i) => {
        const a = answers[i];
        if (a?.kind === 'custom') return a.text;
        return a?.kind === 'option' || a?.kind === 'multi' ? (a.note ?? '') : '';
      });
    }
    node.submitted = true;
    node.answered = true;
    node.failedReason = null;
    this.touch(node);
  }

  private lockAnsweredCard(ev: UiEvent) {
    const toolUseId = ev.questionAnswer?.toolUseId;
    if (!toolUseId) return;
    this.answeredQuestions.set(toolUseId, ev.text ?? '');
    const q = this.questionNodes.get(toolUseId);
    if (q) this.lockQuestion(q, answersToLock(q.questions, ev.text ?? ''));
  }

  // ── User echoes ───────────────────────────────────────────────────────

  private renderUserEcho(ev: UiEvent) {
    const compaction = this.compaction;
    let compactionBelow: CompactionNode | null = null;
    const evText: string = ev.text ?? '';
    if (ev.compactSummary) {
      if (!compaction) {
        this.compaction = this.appendCompaction();
        this.fillCompaction(this.compaction, {});
      }
      this.compaction!.summary = evText;
      this.touch(this.compaction);
      return;
    }
    if (compaction && isLocalCommandStdoutText(evText)) {
      this.compaction = null;
      return;
    }
    if (compaction && isCompactCommandText(evText)) {
      if (this.items[this.items.length - 1] === compaction) compactionBelow = compaction;
    } else {
      this.compaction = null;
    }

    let text = evText;
    const skill = ev.skillLoad ? { name: ev.skillLoad.skill ?? 'skill', text } : null;
    const wakeParsed = skill ? null : parseWakeCallback(text);
    const wake = wakeParsed ? { summary: wakeParsed.summary, body: wakeParsed.body ?? null } : null;
    const renew = skill || wake ? null : parseRenewSeed(text) ? { text } : null;
    const fwd = skill || wake || renew ? null : parseForwardFrame(text);
    const forward = fwd ? { payload: fwd.payload, count: splitForwardedMessages(fwd.payload).length } : null;
    if (fwd) text = fwd.instruction;
    const qa = skill || wake || renew || forward ? null : ev.questionAnswer ?? null;
    const transcribed = !skill && !wake && !renew && !forward && text.startsWith(TRANSCRIBED_PREFIX);
    if (transcribed) text = text.slice(TRANSCRIBED_PREFIX.length);

    const answer = qa
      ? { questions: Array.isArray(qa.questions) ? qa.questions : [], answers: parseCanonicalUserQuestionAnswers(Array.isArray(qa.questions) ? qa.questions : [], text) }
      : null;
    const hasUserText = !!answer || (!skill && !wake && !renew && text.length > 0);
    const variant: UserVariant = wake ? 'wake' : renew ? 'renew' : forward ? 'forward' : answer ? 'answer' : 'plain';

    const node = this.make<UserNode>({
      type: 'user', variant, rawText: evText,
      displayText: !skill && !wake && !renew ? text : '',
      transcribed, skill, wake, renew, forward, answer,
      attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
      userIndex: Number.isInteger(ev.userIndex) ? ev.userIndex : null,
      segmentId: this.segmentId,
      origin: this.isSub ? 'synthetic' : hasUserText ? promptOrigin(ev as any) : 'synthetic',
    }, this);
    this.pushRoot(node);
    if (compactionBelow) {
      this.items.splice(this.items.indexOf(compactionBelow), 1);
      this.items.push(compactionBelow);
    }
    this.closeAssistantSegment();
  }

  // ── Compaction ────────────────────────────────────────────────────────

  private appendCompaction(): CompactionNode {
    this.closeAssistantSegment();
    const node = this.make<CompactionNode>({
      type: 'compaction', state: 'running', trigger: null, preTokens: null, postTokens: null, error: null, summary: null,
    }, this);
    this.pushRoot(node);
    return node;
  }

  private fillCompaction(node: CompactionNode, ev: { trigger?: string | null; preTokens?: number | null; postTokens?: number | null }) {
    node.state = 'done';
    node.trigger = ev.trigger ?? null;
    node.preTokens = ev.preTokens ?? null;
    node.postTokens = ev.postTokens ?? null;
    this.touch(node);
  }

  private renderCompaction(ev: UiEvent) {
    const node = this.pendingCompaction ?? this.appendCompaction();
    this.pendingCompaction = null;
    this.fillCompaction(node, ev as any);
    this.compaction = node;
  }

  private renderCompactionStatus(ev: UiEvent): boolean {
    const d = ev.data ?? {};
    if (ev.subtype === 'status') {
      if (d.status === 'compacting') {
        if (!this.pendingCompaction) this.compaction = this.pendingCompaction = this.appendCompaction();
        return true;
      }
      if (d.status == null && d.compact_result === 'failed') {
        this.failPendingCompaction(d.compact_error);
        return true;
      }
      return false;
    }
    return !!this.pendingCompaction && (ev.subtype === 'init' || ev.subtype === 'model_changed');
  }

  private failPendingCompaction(error: string | null) {
    const node = this.pendingCompaction;
    if (!node) return;
    node.state = 'failed';
    node.error = error ?? null;
    this.touch(node);
    this.pendingCompaction = null;
    if (this.compaction === node) this.compaction = null;
  }

  // ── Dividers ──────────────────────────────────────────────────────────

  private renderHistoryGap() {
    const last = this.items[this.items.length - 1];
    if (!(last?.type === 'divider' && last.kind === 'gap')) {
      this.pushRoot(this.make<DividerNode>({ type: 'divider', kind: 'gap' }, this));
    }
    this.closeAssistantSegment();
  }

  private renderSegmentSeam(ev: UiEvent) {
    this.pushRoot(this.make<DividerNode>({ type: 'divider', kind: 'seam', segmentId: ev.segmentId ?? null }, this));
    this.closeAssistantSegment();
    this.segmentId = ev.segmentId ?? null;
  }

  // ── Lazy history ──────────────────────────────────────────────────────

  /** Render a page of older events into a detached model sharing this one's card registries. */
  renderPage(events: UiEvent[], pageSegment: string | null, fallbackCurrent: string | null): ConversationModel {
    if (fallbackCurrent != null) this.pageCurrentSegmentId = fallbackCurrent;
    const page = new ConversationModel({
      segmentId: pageSegment,
      currentSegmentGetter: () => this.currentSegmentId ?? fallbackCurrent,
      answeredQuestions: this.answeredQuestions,
      questionNodes: this.questionNodes,
    });
    page.applyEvents(events);
    page.finalizeDanglingBlocks();
    return page;
  }

  /**
   * Splice a page above everything rendered. `oldestLeadingWrap` is the
   * current top chunk's leading assistant envelope; a page ending mid-turn
   * merges its trailing envelope into it. Returns the new top chunk's leading
   * envelope.
   */
  prependPage(page: ConversationModel, oldestLeadingWrap: AssistantNode | null): AssistantNode | null {
    let merged = false;
    const incoming = page.items;
    // Rehome the page's root items.
    for (const it of incoming) it.parent = this;
    // A renewal seam already shown (the live tail started on it) is replaced by the page's copy.
    for (const seam of incoming) {
      if (seam.type !== 'divider' || seam.kind !== 'seam') continue;
      this.items = this.items.filter((o) => !(o.type === 'divider' && o.kind === 'seam' && o.segmentId === seam.segmentId));
    }
    // One evicted-content seam marked from both sides is one divider.
    const pageTail = incoming[incoming.length - 1];
    const liveHead = this.items[0];
    let pageItems = incoming;
    if (pageTail?.type === 'divider' && pageTail.kind === 'gap' && liveHead?.type === 'divider' && liveHead.kind === 'gap') {
      pageItems = incoming.slice(0, -1);
    }
    const trailing = page.activeWrap;
    if (trailing && oldestLeadingWrap && trailing !== oldestLeadingWrap) {
      const seamAdjacent = pageItems[pageItems.length - 1] === trailing && this.items[0] === oldestLeadingWrap;
      const upperLast = trailing.children[trailing.children.length - 1];
      const lowerFirst = oldestLeadingWrap.children[0];
      for (const c of trailing.children) c.parent = oldestLeadingWrap;
      if (seamAdjacent && upperLast?.type === 'group' && lowerFirst?.type === 'group') {
        // One run cut by the page boundary: the older half goes to the front of the live group.
        for (const c of upperLast.children) c.parent = lowerFirst;
        lowerFirst.children = [...upperLast.children, ...lowerFirst.children];
        oldestLeadingWrap.children = [...trailing.children.slice(0, -1), ...oldestLeadingWrap.children];
      } else {
        oldestLeadingWrap.children = [...trailing.children, ...oldestLeadingWrap.children];
      }
      if (!oldestLeadingWrap.planText && trailing.planText) oldestLeadingWrap.planText = trailing.planText;
      pageItems = pageItems.filter((i) => i !== trailing);
      merged = true;
      this.touch(oldestLeadingWrap);
    }
    this.items = [...pageItems, ...this.items];
    for (const [pid, block] of page.toolBlocks) {
      if (this.orphanChildEvents.has(pid)) this.adoptToolBlock(pid, block);
    }
    this.rev++;
    this.changed();
    return merged && page.leadingAssistantWrap === trailing ? oldestLeadingWrap : page.leadingAssistantWrap ?? null;
  }
}
