// Hook context: the text a hook adds to the model's context
// (`hookSpecificOutput.additionalContext`), shown to the user as one
// `hook_context` UI event per context string. The single source for that
// event: its constructor and both recognizers.
//
// Live sources:
// - UserPromptSubmit: the CLI's `system`/`hook_response` frame, recognized by
//   hookContextFromResponse in src/parser.ts.
// - PreToolUse/PostToolUse: cc's own HookBroker (src/hookBroker.ts), which
//   emits through `onHookContext` after each answer carrying context. The
//   live frames carry no tool_use_id, so a non-cc tool hook's context is not
//   shown live; it appears on replay.
// Replay source: the session jsonl's `hook_additional_context` attachment,
// recognized by hookContextEventsFromAttachment in src/transcript.ts.

import { isRecord } from '../shared/basics.ts';
import type { UiEventOf } from '../shared/uiEvent.ts';

type HookContext = UiEventOf<'hook_context'>;
type HookContextEventName = HookContext['hookEvent'];

// The hook events whose context is shown. SessionStart and the rest stay hidden.
export const HOOK_CONTEXT_EVENTS: readonly HookContextEventName[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

const isHookContextEventName = (v: unknown): v is HookContextEventName =>
  typeof v === 'string' && (HOOK_CONTEXT_EVENTS as readonly string[]).includes(v);

// THE constructor of the event, for every live and replay site.
export function hookContextEvent({ hookEvent, toolUseId, toolName, text }: {
  hookEvent: HookContextEventName;
  toolUseId: string | null;
  toolName: string | null;
  text: string;
}): HookContext {
  return { kind: 'hook_context', hookEvent, toolUseId, toolName, text };
}

// The live UserPromptSubmit recognizer: the event a successful
// `hook_response` frame's output carries, or null. Total over any frame.
// A Pre/PostToolUse frame is null by design: the broker is their live source.
export function hookContextFromResponse(frame: Record<string, unknown> | null | undefined): HookContext | null {
  if (!frame || frame.subtype !== 'hook_response') return null;
  if (frame.hook_event !== 'UserPromptSubmit' || frame.outcome !== 'success') return null;
  if (typeof frame.output !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(frame.output); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const out = parsed.hookSpecificOutput;
  if (!isRecord(out)) return null;
  const text = out.additionalContext;
  if (typeof text !== 'string' || text === '') return null;
  return hookContextEvent({ hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text });
}

// The jsonl attachment the CLI writes for a hook's `additionalContext`.
export interface HookContextAttachment {
  type?: unknown;
  hookEvent?: unknown;
  hookName?: unknown;
  toolUseID?: unknown;
  content?: unknown;
}

// The replay recognizer: one event per non-empty string in `content`, or [].
// Total over any attachment. Pre/Post carry the call's `toolUseID` and the
// tool named after `"<hookEvent>:"` in `hookName`; UserPromptSubmit's
// `toolUseID` is a synthetic `hook-<uuid>` naming no call, so it is dropped.
export function hookContextEventsFromAttachment(att: HookContextAttachment | null | undefined): HookContext[] {
  if (!att || att.type !== 'hook_additional_context') return [];
  const hookEvent = att.hookEvent;
  if (!isHookContextEventName(hookEvent) || !Array.isArray(att.content)) return [];
  let toolUseId: string | null = null;
  let toolName: string | null = null;
  if (hookEvent !== 'UserPromptSubmit') {
    if (typeof att.toolUseID === 'string') toolUseId = att.toolUseID;
    const prefix = `${hookEvent}:`;
    if (typeof att.hookName === 'string' && att.hookName.startsWith(prefix)) toolName = att.hookName.slice(prefix.length) || null;
  }
  const events: HookContext[] = [];
  for (const text of att.content) {
    if (typeof text === 'string' && text !== '') events.push(hookContextEvent({ hookEvent, toolUseId, toolName, text }));
  }
  return events;
}
