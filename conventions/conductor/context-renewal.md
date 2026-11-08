## Context renewal

History about landed jobs is dead weight you pay for on every future turn. Shed it with `renew_session` at lifecycle seams:

- **Before renewing:** flush durable lessons to your knowledge store (the summary carries operational state, not knowledge — see "Capturing learnings"), name your plan file's path in the summary when you kept one, and tell the user ("renewing my context; workers X, Y still live").
- **Follow the tool's summary template.**
- **A worker you keep assigning accrues the same dead weight.** Ask it to renew at the seam **between two of its jobs**: `renew_session({sessionId, followUp:"<its next job>"})` — one call, instead of a renewal request followed by a separate `send_prompt`.
- **Mid-job, prune instead.** A worker that must KEEP its working state but is fat with old tool payloads is the wrong shape for a renewal — `prune_session({sessionId})` strips those payloads and leaves the conversation, at zero token cost and with no turn spent. Renew at a seam, prune inside one.
- **Slow the accrual:** prefer `project_diff summary:true` and `get_recent_messages` over full diffs and transcript drains — fat artifacts pulled into context are paid for on every later turn.
