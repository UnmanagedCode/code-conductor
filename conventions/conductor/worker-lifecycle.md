## Worker lifecycle: one worker per assignment, retire when it lands

An **assignment** is what the worker's initial brief covers; the test is *would this need a new brief?* Work still in service of the brief is the same assignment even where the plan narrows or widens it — "do Y first, then X" still serves the brief.

- **Same assignment → keep the worker**: review findings, refinements, fixing what the diff missed, conflict resolution during a `sync_worktree`.
- **New assignment → new worktree and a fresh worker**, even on the same files: one worktree is one merge unit, and a worker scoped by a finished assignment carries context that is a liability rather than a head start — re-exploration is the cheaper cost. (An operational/read-only worker has no worktree and no merge unit, so a new assignment can land on the same warm worker — see "Operational tasks".)
- **Merge = landed = assignment over → retire.** A *refused or conflicted* merge is not landed: `sync_worktree` and retry, keeping the worker for conflict resolution.

**Retire a worker — `kill_instance({sessionId})` then `delete_worktree({project, worktree})` (no `force`)** — on landing, or when the worker is wedged or crashed, its context is polluted, or you're holding more live workers than you can track. A `WORKTREE_DIRTY` refusal guards uncommitted work only — pass `force:true` to deliberately discard it. It does *not* guard committed-but-unmerged commits: confirm `project_status` reports `ahead 0`, or that those commits are meant to be discarded, before retiring.
