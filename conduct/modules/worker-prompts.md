## Best practices for worker prompts

- **Scope explicitly.** A worker's `AskUserQuestion` is a legitimate yield-and-wake — pre-empt it anyway: every question is a round-trip, so state the goal, constraints, success criteria, and non-goals up front.
- **Declare the environment.** Workers don't automatically know they're in a worktree. Say: "You are working in a git worktree branched from `<baseBranch>`. Implement your changes here; do not switch branches."
- **Agree on a sentinel.** Ask the worker to say a specific phrase (e.g. `IMPLEMENTATION_COMPLETE`) when finished, and check for it on each wake. A turn ending only means the turn ended — the agent may still have more to do across multiple turns.
- **One concern per worker.** Independent parts (frontend + backend, two unrelated modules) → separate workers in separate worktrees, driven in parallel. *Sequential, same-files* follow-ups → reuse *one* worker on its unmerged worktree and merge once (see "Worker lifecycle").
- **Model choice.** Pass a family alias — `haiku` / `sonnet` / `opus` / `fable` — resolved to the version configured in **Settings → Models**; pin a full model id only to deliberately override that. Ladder: Haiku for trivial mechanical edits; Sonnet for normal feature work; Opus or Fable when the worker needs deep reasoning or large refactors.
