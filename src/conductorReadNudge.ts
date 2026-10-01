// The conductor read nudge: a conductor-only PreToolUse hook that counts the
// conductor's own project_read/project_bash calls since its last delegation and,
// when the run reaches a threshold, hands the model one short in-band reminder
// pointing at the role doc's "does this read change a gate decision I own?"
// rule. It never denies or alters a call.
//
// The single source for everything the nudge is made of: the tool lists, the
// settings matcher, the thresholds, the wording, the UI event shape, and the
// replay recognizer that rebuilds that event from the session jsonl. Wired by
// src/settings.ts (the hook entry), src/hookBroker.ts (the answer),
// src/instances.ts (the per-instance counter + its reset at every exit from
// `turn`) and src/transcript.ts (replay).

import { TOOL_NAME_PREFIX } from './playbooks.ts';
import type { UiEvent } from './parser.ts';

// Each extends the run.
const COUNTED_TOOLS = ['project_read', 'project_bash'].map(t => TOOL_NAME_PREFIX + t);
// Each starts a new run.
const DELEGATION_TOOLS = ['spawn_instance', 'send_prompt'].map(t => TOOL_NAME_PREFIX + t);

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ANCHORED: the CLI tests a matcher outside `^[a-zA-Z0-9_|]+$` as
// `new RegExp(m).test(toolName)`, so an unanchored alternation would also
// match any tool whose name merely contains one of these.
export const READ_NUDGE_MATCHER = `^(${[...COUNTED_TOOLS, ...DELEGATION_TOOLS].map(escapeRegex).join('|')})$`;

// A nudge fires when the run length equals one of these — never between or past.
export const READ_NUDGE_THRESHOLDS: readonly number[] = [8, 16];

// Quoted from conventions/conductor/core.md; a test fails if that text goes.
export const READ_NUDGE_RULE = 'does this read change a gate decision I own?';

const bare = (names: string[], sep: string): string => names.map(n => n.slice(TOOL_NAME_PREFIX.length)).join(sep);
const COUNT_SLOT = '{count}';
export const READ_NUDGE_TEMPLATE =
  `code-conductor: ${COUNT_SLOT} ${bare(COUNTED_TOOLS, '/')} calls in a row this turn with no `
  + `${bare(DELEGATION_TOOLS, ' or ')}. `
  + `Before the next read, apply "${READ_NUDGE_RULE}" from your Conductor role doc.`;

const [TEMPLATE_HEAD, TEMPLATE_TAIL] = READ_NUDGE_TEMPLATE.split(COUNT_SLOT);
const PARSE_RE = new RegExp(`^${escapeRegex(TEMPLATE_HEAD)}(\\d+)${escapeRegex(TEMPLATE_TAIL)}$`);

export function readNudgeText(count: number): string {
  return READ_NUDGE_TEMPLATE.replace(COUNT_SLOT, String(count));
}

// The count a nudge text carries, or null when `text` is not one.
export function parseReadNudgeText(text: string): number | null {
  const m = PARSE_RE.exec(text);
  return m ? Number(m[1]) : null;
}

export interface ReadNudge {
  count: number;
  toolName: string;
  toolUseId: string;
  text: string;
}

// One per conductor Instance, in memory only.
export class ConductorReadNudge {
  private _run = 0;

  watches(toolName: string): boolean {
    return COUNTED_TOOLS.includes(toolName) || DELEGATION_TOOLS.includes(toolName);
  }

  // The nudge this call earns, or null.
  observe(toolName: string): { count: number; text: string } | null {
    if (DELEGATION_TOOLS.includes(toolName)) {
      this._run = 0;
      return null;
    }
    if (!COUNTED_TOOLS.includes(toolName)) return null;
    this._run += 1;
    return READ_NUDGE_THRESHOLDS.includes(this._run) ? { count: this._run, text: readNudgeText(this._run) } : null;
  }

  reset(): void {
    this._run = 0;
  }
}

// THE constructor of the `system`/`read_nudge` event, for the live path and
// replay alike. The literal `kind`/`subtype` pair is read by the replay
// tripwire in tests/archive-correlated-cut.test.mjs.
export function readNudgeEvent({ count, toolName, toolUseId, text }: ReadNudge): UiEvent {
  return { kind: 'system', subtype: 'read_nudge', toolUseId, data: { count, tool: toolName, text } };
}

// The jsonl attachment the CLI writes for a PreToolUse `additionalContext`.
export interface HookContextAttachment {
  type?: unknown;
  hookEvent?: unknown;
  hookName?: unknown;
  toolUseID?: unknown;
  content?: unknown;
}

// Rebuilds the read_nudge event from its persisted attachment; null for any
// other attachment (a user's own hook, a redirect note).
export function readNudgeEventFromAttachment(att: HookContextAttachment | null | undefined): UiEvent | null {
  if (!att || att.type !== 'hook_additional_context' || att.hookEvent !== 'PreToolUse') return null;
  if (typeof att.toolUseID !== 'string' || typeof att.hookName !== 'string') return null;
  if (!att.hookName.startsWith('PreToolUse:')) return null;
  const toolName = att.hookName.slice('PreToolUse:'.length);
  if (!COUNTED_TOOLS.includes(toolName)) return null;
  if (!Array.isArray(att.content)) return null;
  for (const text of att.content) {
    if (typeof text !== 'string') continue;
    const count = parseReadNudgeText(text);
    if (count != null) return readNudgeEvent({ count, toolName, toolUseId: att.toolUseID, text });
  }
  return null;
}
