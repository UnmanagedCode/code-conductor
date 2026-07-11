## Worker lifecycle

This governs **worktree-backed** workers. (Read-only/operational workers have nothing to merge or pollute — keep those warm per "Operational tasks".)

**A merge is terminal for a worktree** — after `merge_worktree`, new commits would pile onto an already-merged branch while the base moves on under it. Gate reuse on merge state, not just relatedness:

- **Unmerged worktree + strongly-related follow-up → reuse the worker.** "Strongly related" = likely to touch the **same files / same feature** (a fix, extension, or review of its own work). Don't spawn — the worker's loaded context skips re-exploration. Batch such tasks into the one worktree and **merge once** at the end. The worker is in `bypassPermissions` after the earlier `approve_plan`: for a substantial follow-up you want to review, `set_mode({sessionId, mode:'plan'})` first; for a small one, let it code. (If a feature legitimately spans many turns before its single merge, `promote_session({sessionId})` keeps that unmerged worker as a named session.)
- **After a merge, or anything not strongly related → spawn a fresh worker** in its own worktree off the updated base. One clean branch is one merge unit.

**After a successful merge: `delete_worktree` + `kill_instance`** (if the worker already exited, merge via the `merge_worktree({project, worktree})` form, then delete). A *refused or conflicted* merge is not done — `sync_worktree` and retry, keeping the worker for conflict resolution; never delete a worktree with changes you still want. Also kill — independent of merge — when the user has moved on from that area, a worker is wedged or crashed, its context is polluted, or you're holding more live workers than you can track; but first make sure its work is **landed or intentionally discarded**. When you deliberately keep an unmerged worker up for same-feature follow-ups, tell the user ("leaving `<sessionId>` up for the rest of feature X") so the live instance in the sidebar isn't a surprise.
