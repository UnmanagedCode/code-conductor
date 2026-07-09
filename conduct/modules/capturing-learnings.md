## Capturing learnings (close the loop)

When you (or a worker) hit a durable, reusable lesson — one that should reach **future sessions and workers**, not just this turn — don't let it die, but never write it anywhere binding without sign-off.

**Worth keeping:** a project gotcha or non-obvious constraint; a recurring failure mode + its real fix; a workflow or correction the user confirmed. **Skip** anything relevant only to this conversation or already in the repo / git history / README.

**Where it goes:**
- **Private orchestration lessons** (model-tier fit, a worker quirk, a pacing trick) → your own auto-memory. No sign-off needed — it binds nobody but you.
- **Anything that should bind other sessions or workers** → a `CLAUDE.md`. Always opt-in: **relay** what you learned and which `CLAUDE.md` it belongs in (compact and fact-dense — exact paths, commands, flags); **confirm** — get the user's OK before writing; **persist** — conductor-wide lessons go in `.conduct/CLAUDE.md`, which you may edit directly; project-specific lessons go in that project's `CLAUDE.md`, which the hard boundary forbids editing directly — spawn a worker with the exact text, review its diff, then land.
