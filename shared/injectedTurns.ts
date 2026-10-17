// The fixed leads of every server-authored text that reaches a session as a
// user turn. A leaf module: the builders (sessionRenew.ts, resumeRestart.ts,
// overageResume.ts, worktrees.ts) compose their output FROM these constants,
// and shared/promptOrigin.ts recognises that output BY them (src/awaitingUser.ts
// through it), so a builder cannot change its opening without its recogniser
// seeing the same bytes. Importing nothing keeps both sides free of an import
// cycle through src/instances.ts. Lives in shared/ with the modules the web UI
// shares with the server; DOM-free so the server imports it directly.

// The opening sentence of buildRenewRequest (renew_session turn A).
export const RENEW_REQUEST_LEAD: string =
  'Your conductor is asking you to renew your context now (renew_session).';

// The shared trunk of both restart notices: RESUME_TEXT continues it with
// ` — pick up…`, buildWorkersResumeText with `, and you should resume…`.
export const RESTART_NOTICE_TRUNK: string =
  '✅ CodeConductor has restarted successfully. You may resume activity now';

// The opening of RESTART_ABORTED_TEXT: a resume restart whose preparation failed
// after the drain wound turns down, so nothing was restarted.
export const RESTART_ABORTED_LEAD: string =
  '⚠️ CodeConductor\'s restart was aborted — nothing was restarted.';

// Prompt delivered by the overage auto-resume timer to a still-alive session
// once the rate-limit window has reset (onOverage: 'stop-resume').
export const AUTO_RESUME_TEXT: string =
  'The rate-limit window has reset. Please continue where you left off.';

// Softened preamble for a queued-only session (idle/new — never stopped
// mid-work), so it doesn't get told to "continue where you left off".
export const QUEUED_ONLY_RESUME_TEXT: string =
  'The rate-limit window has reset. Delivering the messages you queued while paused:';

// Preamble for a session the overage stop found ALREADY IDLE — e.g. a conductor
// parked awaiting a worker's wake. Nothing of its own was interrupted, so
// AUTO_RESUME_TEXT's "continue where you left off" would be false; and it queued
// nothing, so QUEUED_ONLY_RESUME_TEXT's promise of queued messages would be too.
// Its conductor clauses still ride along: an idle-parked conductor may have had a
// wake severed or workers stopped un-armed, and each clause says so when it did.
export const IDLE_PARKED_RESUME_TEXT: string =
  'The rate-limit window has reset. You were idle when the overage stop fired, so none '
  + 'of your own work was interrupted.';

// The lead of the section an overage resume appends when it carries the
// messages the user queued while paused — what makes that resume a real turn.
export const QUEUED_SECTION_LEAD: string = 'While paused you queued';

// The opening line of buildRebasePrompt (the sync-worktree rebase brief).
export const REBASE_PROMPT_LEAD: string = 'You are running in an isolated git worktree.';
