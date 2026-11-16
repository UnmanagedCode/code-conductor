// The conductor read nudge: a conductor-only PreToolUse hook that counts the
// conductor's own project_read/project_bash calls since its last delegation and,
// when the run reaches a threshold, hands the model one short in-band reminder
// pointing at the role doc's "does this read change a gate decision I own?"
// rule. It never denies or alters a call.
//
// The single source for everything the nudge is made of: the tool lists, the
// settings matcher, the thresholds and the wording. Wired by src/settings.ts
// (the hook entry), src/hookBroker.ts (the answer) and src/instances.ts (the
// per-instance counter + its reset at every exit from `turn`). The user sees
// the nudge as an ordinary hook context (src/hookContext.ts), live and on
// replay.

import { TOOL_NAME_PREFIX } from './playbooks.ts';

// Each extends the run.
const COUNTED_TOOLS = ['project_read', 'project_bash'].map(t => TOOL_NAME_PREFIX + t);
// Each starts a new run.
const DELEGATION_TOOLS = ['spawn_instance', 'send_prompt'].map(t => TOOL_NAME_PREFIX + t);

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ANCHORED: the CLI tests a matcher outside `^[a-zA-Z0-9_|]+$` as
// `new RegExp(m).test(toolName)`, so an unanchored alternation would also
// match any tool whose name merely contains one of these.
export const READ_NUDGE_MATCHER = `^(${[...COUNTED_TOOLS, ...DELEGATION_TOOLS].map(escapeRegex).join('|')})$`;

// A nudge fires when the run length equals one of these — never between or past.
const READ_NUDGE_THRESHOLDS: readonly number[] = [8, 16];

// Quoted from conventions/conductor/core.md; a test fails if that text goes.
export const READ_NUDGE_RULE = 'does this read change a gate decision I own?';

const bare = (names: string[], sep: string): string => names.map(n => n.slice(TOOL_NAME_PREFIX.length)).join(sep);
const COUNT_SLOT = '{count}';
const READ_NUDGE_TEMPLATE =
  `code-conductor: ${COUNT_SLOT} ${bare(COUNTED_TOOLS, '/')} calls in a row this turn with no `
  + `${bare(DELEGATION_TOOLS, ' or ')}. `
  + `Before the next read, apply "${READ_NUDGE_RULE}" from your Conductor role doc.`;

export function readNudgeText(count: number): string {
  return READ_NUDGE_TEMPLATE.replace(COUNT_SLOT, String(count));
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
