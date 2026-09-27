// The session-mode vocabulary. The mode each session last ran under is
// recorded on its record in the unified session store (src/sessionStore.ts →
// getSessionMode / setSessionMode), because `spawn_instance({resume})` has to
// come back up in the mode the session was actually in — the CLI jsonl's
// `permission-mode` marker is not an input to it.
//
// A session with no recorded mode resolves through effectiveResumeMode() to
// DEFAULT_RESUME_MODE.

// Two user-facing modes, both the CLI's own values:
//   - `plan`              — read-only planning
//   - `bypassPermissions` — full power, no gating
// The CLI's `default`/`acceptEdits` modes are unusable in stream-json
// --print (no SDK canUseTool callback), so we don't expose them.
export const MODES = ['plan', 'bypassPermissions'] as const;

// Start fresh instances in read-only plan mode by default. The user can pick
// `code` (= bypassPermissions) in the new-instance dialog, or
// approve a plan to flip the running instance to bypassPermissions
// mid-session. A **resume** with no recorded mode falls back to
// `bypassPermissions` instead — a resume is almost always continuing real work
// rather than re-planning, so plan mode would be the wrong starting point.
export const DEFAULT_MODE = 'plan';
export const DEFAULT_RESUME_MODE = 'bypassPermissions';

// What a resume will ACTUALLY come up as. Every surface that reports or acts on
// a session's resume mode goes through this, so the renderer's flag, the role
// doc's claim and _doCreate's default can't drift apart: an unrecorded session
// resumes hot, and must be reported that way.
export function effectiveResumeMode(recorded: string | null | undefined): string {
  return typeof recorded === 'string' && recorded ? recorded : DEFAULT_RESUME_MODE;
}

// True when resuming in this mode gives the worker ungated tool use.
export function resumesHot(mode: string): boolean {
  return mode === 'bypassPermissions';
}
