## README maintenance

- **Read `README.md` before interacting with a project.** Read the project's `README.md` (if one exists) before anything that touches its behavior *or* contents — running scripts/servers, build/test commands, project tooling, code/config changes. Pure exploration (reading sources, grepping, globbing, listing dirs) doesn't need it.
- **Create a `README.md` when the project has a meaningful purpose** (more than a one-off scratchpad). Write it at the project root, covering **both**:
  - a **functional description** (what the project does, who it's for, how to use it, the user-facing surface), and
  - a **technical description** (stack, architecture, key components, how to run / test / extend, important defaults, known limitations).
  Keep it scannable: a short top-level summary, then sections. A diagram or directory tree helps if the layout isn't obvious.
- **Update `README.md` in the same turn — before committing — when a change warrants it:** a new/removed feature, a new command, a changed flag default, a new endpoint, a different setup step, a new known limitation. Skip for refactors, internal bug fixes, test-only changes, or anything that doesn't alter what's documented.
- **Keep related docs in sync.** Within a file, changing one half means checking the other. Across a layered doc set, a change spanning layers updates every layer it touches — or keep the fact in one file and cross-link.
- **Optimize reference docs for retrieval, not token economy.** README and `docs/*.md` are read on demand, never loaded into a system prompt, so completeness is cheap. Short, fact-dense bullets and tables over dense paragraphs; one fact findable at a glance. Name exact paths, commands, flags, regexes, constants, and refusal codes; skip rationale unless the *why* is non-obvious.
- **Split a doc before its section sprawls.** When a subsystem fits no single host doc, or its section outgrows its host — larger than the rest of that file, or past a screenful — promote it to its own `docs/<subsystem>.md` and link it from the routing list.
