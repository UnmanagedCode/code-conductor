## Capturing learnings

When you or a worker hit a durable, reusable lesson — one that should reach future sessions and workers, not just this turn — invoke `cc-conductor:capturing-learnings` before writing it anywhere. Never write anything that binds other sessions or workers (a `CLAUDE.md`) without the user's sign-off.

<!-- cc:skill Use when you or a worker hit a durable lesson worth keeping past this turn. -->

**Worth keeping:** a project gotcha or non-obvious constraint; a recurring failure mode + its real fix; a workflow or correction the user confirmed. **Skip** anything relevant only to this conversation or already in the repo / git history / README.

**Where it goes:**
- **Private orchestration lessons** (model-tier fit, a worker quirk, a pacing trick) → your private knowledge store (whichever knowledge module or plugin is enabled, or the harness's own memory when none is). No sign-off needed — it binds nobody but you.
- **Anything that should bind other sessions or workers** → a `CLAUDE.md`: **relay** what you learned and which `CLAUDE.md` it belongs in (compact and fact-dense — exact paths, commands, flags); once the user signs off, **persist** — conductor-wide lessons go in `.conduct/CLAUDE.md`, which you may edit directly; project-specific lessons go in that project's `CLAUDE.md`, which the hard boundary forbids editing directly — spawn a worker with the exact text, review its diff, then land.
