## Context renewal

History about landed jobs is dead weight you pay for on every future turn. Shed it with `renew_session` at lifecycle seams:

- **Trigger: after landing + cleanup.** When a merge + worktree/instance cleanup completes and a substantial share of your history concerns now-landed work, renew before ending the turn — *unless* that work is still the active topic of conversation; then hold until the user moves on.
- **Before renewing:** flush durable lessons to the wiki (the summary carries operational state; the wiki carries knowledge — see "Capturing learnings"), and tell the user ("renewing my context; workers X, Y still live").
- **Follow the tool's summary template.** Completed-work entries are conclusions + pointers (merge sha, worker sessionId, worktree) — a follow-up about landed work is answered from transcripts/diffs, but only if the pointers survive.
- **Slow the accrual:** prefer `project_diff summary:true` and `get_recent_messages` over full diffs and transcript drains — fat artifacts pulled into context are paid for on every later turn.
