// Plan files the model wrote this session, and the rule for binding one to an
// ExitPlanMode. Shared by the live stdout path (src/instances.ts) and jsonl
// replay (src/transcript.ts) so the two can't drift.

import { readFileSync } from 'node:fs';
import type { UiEvent } from './parser.ts';

const PLAN_DIR_FRAGMENT = '/.claude/plans/';

// The path a tool_use wrote a plan file to, or null.
export function planFileFromToolUse(name: unknown, input: unknown): string | null {
  if (name !== 'Write') return null;
  const fp = (input as { file_path?: unknown } | null | undefined)?.file_path;
  if (typeof fp !== 'string') return null;
  if (!fp.includes(PLAN_DIR_FRAGMENT) || !fp.endsWith('.md')) return null;
  return fp;
}

// Branch 2: the path an ExitPlanMode input named outright, or null. Read at
// both plan_request construction points (live parse + jsonl replay) so a
// self-declared path is on the event before any tracker enrichment sees it.
export function planPathFromInput(input: Record<string, unknown> | null | undefined): string | null {
  if (typeof input?.planFilePath === 'string' && input.planFilePath) return input.planFilePath;
  if (typeof input?.planPath === 'string' && input.planPath) return input.planPath;
  return null;
}

export class PlanFileTracker {
  #last: string | null = null;
  #writtenThisTurn = false;

  // Latch a plan-file write and mark it as belonging to the current turn.
  noteToolUse(name: unknown, input: unknown): void {
    const fp = planFileFromToolUse(name, input);
    if (!fp) return;
    this.#last = fp;
    this.#writtenThisTurn = true;
  }

  // Clears ONLY the this-turn flag, never the remembered path. Dropping the
  // path at a turn boundary would reintroduce the original defect for a
  // reject → re-ExitPlanMode round that EDITS (rather than rewrites) the plan
  // file: branch 3 would go back to having no path at all.
  noteTurnBoundary(): void {
    this.#writtenThisTurn = false;
  }

  // Resume/respawn wipe — the replayed session must not inherit either.
  reset(): void {
    this.#last = null;
    this.#writtenThisTurn = false;
  }

  // Attach the plan file to a plan_request, in place.
  enrich(ev: UiEvent): void {
    if (ev.kind !== 'plan_request') return;
    if (ev.planPath) return;              // branch 2: the input named one; never override it
    if (!this.#last) return;
    if (ev.plan) {
      // Branch 1 — the model supplied the text, so nothing cross-checks the
      // path. Only a write in THIS turn binds the file to THIS plan.
      // `#last` is session-scoped and never cleared on consumption, so a
      // path from an earlier turn is an unverified guess — and
      // `~/.claude/plans/` accumulates files from unrelated runs, so a stale
      // path does not 404, it silently resolves to another task's plan. An
      // unverified path is worse than none; falling back to the inline text
      // is the correct answer, not a shortfall.
      if (this.#writtenThisTurn) ev.planPath = this.#last;
      return;
    }
    // Branch 3 — we present this file's contents AS the plan, so path and
    // text corroborate by construction: the text the reader sees came from
    // that very file. The session-scoped path is sound here, which is why
    // this arm needs no same-turn guard.
    ev.planPath = this.#last;
    try { ev.plan = readFileSync(this.#last, 'utf8'); }
    catch { /* best-effort — the path is still the deliverable */ }
  }
}
