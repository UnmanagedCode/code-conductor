## Canonical workflow

### Single worker

For a typical "implement feature X in project Y":

1. **Recon** — `list_projects()`; `project_status({project: 'Y'})`; `project_read` as needed.
2. **Spawn in plan mode, fresh worktree** — `spawn_instance({project: 'Y', mode: 'plan', createWorktree: true, model: 'balanced'})`; capture the returned `sessionId`.
3. **Brief** — `send_prompt({sessionId, text: "<scoped goal + constraints + completion sentinel>"})`, end your turn.
4. **[Wake] Read the plan** — from the folded wake output (it includes the plan/`AskUserQuestion` block with its trailing prose); `get_recent_messages({sessionId})` only for more or an un-folded wake.
5. **Decide** — **Approve**: `approve_plan({sessionId})` (optional `feedback`) → resubscribe + end turn. **Revise**: `reject_plan({sessionId, feedback})` → resubscribe + end turn, loop to step 4. **Answer a question**: on a `questions` wake, `answer_question({sessionId, answers})` → resubscribe + end turn. **Abandon**: `unsubscribe_from_idle({sessionId})`; `kill_instance({sessionId})`; `delete_worktree(...)`.
6. **[Wake] Implementation done** — confirm the sentinel from the folded wake output; if mid-multi-turn, resubscribe + end turn.
7. **Review** — `project_status({project: 'Y', worktree: '<wtName>'})` for the summary, `project_diff(...)` for the full diff, `project_read(...)` for specifics — immediate calls, no subscribe.
8. **Land** — merge when the user needs the change on base or the feature is complete, not as a default end-of-turn move: `sync_worktree({sessionId})` (a rebase prompt sent to the worker is a worker turn — subscribe + end turn, resume on wake; fast-forwarded / already-in-sync — continue straight on) and `merge_worktree({sessionId})`.
9. **Continue or retire** — see Worker lifecycle: strongly-related follow-up remains → keep the worker and worktree, brief it, merge again later; thread of work done (or worker wedged/polluted) → `kill_instance({sessionId})` then `delete_worktree({project, worktree})` (no `force`); refused or conflicted merge → keep the worker, `sync_worktree`, retry.

### N independent tasks (parallel)

Several independent tasks — or one that splits into independent sub-tasks (different projects, modules, concerns) — are **never serialised across turns and never blocked on**. You can emit several tool calls in one turn; fan turn-starting calls across *distinct* sessionIds — a session runs one turn at a time, so an extra prompt to a busy session steers its in-flight turn rather than starting a new one. The flow is Single-worker fanned out:

- **Batched turns** — one recon turn, then one spawn turn (N `spawn_instance`, each `mode:'plan'` + own fresh worktree; capture the sessionIds), then one brief turn (N `send_prompt`, each auto-subscribing), and end the turn. Optionally arm `set_auto_approve_plan({sessionId, enabled:true})` per worker if you trust this batch's planning.
- **One wake per worker** — wakes arrive one at a time; **track which worker sessionIds are still outstanding**, tick them off per wake, and handle each exactly as Single-worker steps 4–9, resubscribing while a worker has turns left. **Auto-approve caveat:** an armed worker's *plan* turn fires your one-shot subscription **before** it rolls into implementation — check the sentinel on that first wake and just resubscribe if it isn't done.
- **Land calls can be fanned** across sessionIds in one turn; a rebase prompt sent by `sync_worktree` is a worker turn (subscribe + end). If a worker already exited, merge via `merge_worktree({project, worktree})`, then `delete_worktree({project, worktree})` (no `force`) once that thread of work is done.

If a worker errors or stalls, handle just that sessionId on its wake; the rest are unaffected.

### Choosing the execution mode

- **Plan + manual approval** (default for new work): worker drafts → you read → `approve_plan` / `reject_plan`. Slowest, safest.
- **Plan + auto-approve** (`set_auto_approve_plan({enabled: true})`): for when you've validated the worker is sane on similar tasks.
- **Code from the start**: only for trivially scoped tasks with nothing to plan ("rename `foo` to `bar` across the repo").
