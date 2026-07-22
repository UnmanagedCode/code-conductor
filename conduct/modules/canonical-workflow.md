## Canonical workflow

The conductor runs this loop without doing its code work itself — see the conductor role in `core.md`.

### Single worker

For a typical "implement feature X in project Y":

1. **Recon — ground only, don't explore.** `list_projects()` and `project_status({project: 'Y'})` (branch / dirty sanity). Do **not** read project code to understand or scope the change — that's the plan worker's job. If the target project or scope is unclear, ask (per Intent disambiguation), don't read source to decide.
2. **Spawn in plan mode, fresh worktree** — `spawn_instance({project: 'Y', mode: 'plan', createWorktree: true, model: '<tier>'})`, choosing the tier for the task (Worker prompts' model ladder); capture the returned `sessionId` **and worktree name** (the reviewer attaches to it at step 7).
3. **Brief** — `send_prompt({sessionId, text: "<scoped goal + constraints + completion sentinel>"})`, end your turn.
4. **[Wake] Read the plan** — from the folded wake output; `get_recent_messages({sessionId})` only for more or an un-folded wake.
5. **Decide** — **Approve**: `approve_plan({sessionId})` (optional `feedback`) → end turn. **Revise**: `reject_plan({sessionId, feedback})` → end turn, loop to step 4. **Answer a question**: on a question wake, `answer_question({sessionId, answers})` → end turn. **Abandon**: `kill_instance({sessionId})`; `delete_worktree(...)`.
6. **[Wake] Implementation done** — confirm the sentinel from the folded wake output before proceeding to review.
7. **Spawn an adversarial reviewer** — `spawn_instance({project: 'Y', worktree: '<wtName>', mode: 'bypassPermissions', model: 'reviewer'})`, attached to the implementer's worktree. It reads freely with no approval prompts; brief it to review **strictly and adversarially** — hunt correctness bugs, missed requirements, regressions, and convention violations, defaulting to skepticism rather than approval — to report findings as prose, and to **inspect only: never modify, stage, or commit** (read-only is on the brief, not the mode). Verdict sentinel: `REVIEW_CLEAN` only when it genuinely finds nothing blocking, else a findings list. End turn. **The pair shares one worktree — never let both be mid-turn at once** (prompt one, wake, then the other).
8. **[Wake] Review → refine loop — you arbitrate every round.** Read the reviewer's findings and decide: worth fixing → relay them to the *implementer* to refine (`send_prompt`, end turn); on its refined wake, send the **same** reviewer back to re-review (end turn), and loop. Not worth fixing, or `REVIEW_CLEAN` → go to Land. No fixed round cap — you make the refine-vs-land call each round from the reviewer's verdict (a `project_diff` spot-check is fair to break a standoff); escalate to the human only on a judgment call you can't resolve.
9. **Land — sync freely, gate merge + delete on sign-off.** `sync_worktree({sessionId: <implementer>})` is fine on your own (always the implementer's id — the reviewer didn't author the changes and shouldn't resolve conflicts); dispatch-and-wake if it prompts a rebase. But for a **user-initiated** task, do **not** `merge_worktree` or `delete_worktree` unprompted — present the reviewed, ready-to-land state (a `project_status` here also catches a stray reviewer write — implementers commit their work, so the tree should be clean) and wait for the user's explicit sign-off. Merge/delete without sign-off only for work the conductor itself initiated (e.g. an internal sub-task).
10. **[After sign-off] Continue or retire** — `merge_worktree({sessionId})`, then per Worker lifecycle. The deltas this loop adds: a kept pair keeps **both** the implementer and its reviewer for the next round; retiring means `kill_instance` **both** before `delete_worktree({project, worktree})`.

### N independent tasks (parallel)

Several independent tasks — or one that splits into independent sub-tasks (different projects, modules, concerns) — are **never serialised across turns and never blocked on**. You can emit several tool calls in one turn; fan turn-starting calls across *distinct* sessionIds (a send to a busy session steers its running turn — see `send_prompt`). **Exception: never prompt both members of an implementer+reviewer pair in the same turn — they share one worktree (step 7).** The flow is Single-worker fanned out — each task runs its own implementer + reviewer pair, so track twice the sessionIds:

- **Batched turns** — one recon turn (ground-only, per step 1), then one spawn turn (N `spawn_instance`, each `mode:'plan'` + own fresh worktree; capture sessionIds + worktree names), then one brief turn (N `send_prompt`, each auto-subscribing), and end the turn.
- **One wake per worker** — wakes arrive one at a time; **track which sessionIds are still outstanding** (implementers *and* reviewers), tick them off per wake, and handle each exactly as Single-worker steps 4–10.
- **Land calls can be fanned** across sessionIds in one turn — each still waits for the user's sign-off per step 9. If a worker already exited, merge via `merge_worktree({project, worktree})`, then `delete_worktree({project, worktree})` (no `force`) once that thread of work is done.

If a worker errors or stalls, handle just that sessionId on its wake; the rest are unaffected.

### Choosing the execution mode

- **Plan + manual approval** (default for new work): worker drafts → you read → `approve_plan` / `reject_plan`. Slowest, safest.
- **Code from the start**: only for trivially scoped tasks with nothing to plan ("rename `foo` to `bar` across the repo").

The review → refine loop (steps 7–8) runs regardless of the execution mode chosen; skip it only for a change trivial enough to land unreviewed.
