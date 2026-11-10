// Tool-result nudges: a short reminder an MCP handler hands the CALLING session
// alongside one tool result — delivered not in the result but as the
// `additionalContext` of that call's PostToolUse hook, which the CLI places
// inside the tool result as a system reminder the model reads as addressed to it.
//
// The handler queues the text under the call's toolUseId (the CLI sends it as
// `params._meta["claudecode/toolUseId"]` on `tools/call`, and the same value
// as the PostToolUse envelope's `tool_use_id`); the hook takes it. The CLI
// posts PostToolUse only after it has the result, so the queue always wins.
//
// The single source for the meta key, the nudge tools and their settings
// matcher, and the per-instance pending store. Wired by src/mcp/server.ts (the
// id onto the handler ctx), src/mcp/handlers.ts (the queue), src/settings.ts
// (the hook entry), src/hookBroker.ts (the answer) and src/instances.ts (the
// store + its clear at every exit from `turn`).

import { TOOL_NAME_PREFIX } from './playbooks.ts';
import { escapeRegex } from './conductorReadNudge.ts';

export const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';

// The toolUseId a `tools/call` params object carries, or null.
export function toolUseIdOf(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return null;
  const id = (meta as Record<string, unknown>)[TOOL_USE_ID_META_KEY];
  return typeof id === 'string' && id !== '' ? id : null;
}

// The tools whose handlers queue a nudge.
export const TOOL_RESULT_NUDGE_TOOLS: readonly string[] = ['spawn_instance', 'delete_worktree'].map(t => TOOL_NAME_PREFIX + t);

// ANCHORED, as READ_NUDGE_MATCHER is: the CLI tests a matcher outside
// `^[a-zA-Z0-9_|]+$` as an unanchored regex.
export const TOOL_RESULT_NUDGE_MATCHER = `^(${TOOL_RESULT_NUDGE_TOOLS.map(escapeRegex).join('|')})$`;

export function isToolResultNudgeTool(toolName: string): boolean {
  return TOOL_RESULT_NUDGE_TOOLS.includes(toolName);
}

// One per Instance, in memory only.
export class PendingToolNudges {
  private readonly _pending = new Map<string, Set<string>>();

  // The same text under the same id is kept once.
  queue(toolUseId: string, text: string): void {
    let texts = this._pending.get(toolUseId);
    if (!texts) this._pending.set(toolUseId, texts = new Set());
    texts.add(text);
  }

  // Everything queued under the id, joined by a blank line, or null. One-shot.
  take(toolUseId: string): string | null {
    const texts = this._pending.get(toolUseId);
    this._pending.delete(toolUseId);
    return texts ? [...texts].join('\n\n') : null;
  }

  clear(): void {
    this._pending.clear();
  }
}
