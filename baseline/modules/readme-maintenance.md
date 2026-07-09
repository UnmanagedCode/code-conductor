## README maintenance

- **Read `README.md` before interacting with a project.** Read the project's `README.md` (if one exists) before anything that touches its behavior *or* contents — running scripts/servers, build/test commands, project tooling, code/config changes, **or exploring the codebase** (reading sources, grepping, globbing, listing dirs beyond the repo root). Pure git actions (`status`, `log`, `diff`, `add`, `commit`, branch inspection) are fine without it.
- **Create a `README.md` when the project has a meaningful purpose** (more than a one-off scratchpad). Write it at the project root, covering **both**:
  - a **functional description** (what the project does, who it's for, how to use it, the user-facing surface), and
  - a **technical description** (stack, architecture, key components, how to run / test / extend, important defaults, known limitations).
  Keep it scannable: a short top-level summary, then sections. A diagram or directory tree helps if the layout isn't obvious.
- **Update `README.md` in the same turn — before committing — when a change warrants it:** a new/removed feature, a new command, a changed flag default, a new endpoint, a different setup step, a new known limitation. Skip for refactors, internal bug fixes, test-only changes, or anything that doesn't alter what's documented.
- **Keep functional and technical sections in sync.** When you change one half (e.g. add a flag), check whether the other half needs updating too (e.g. the architecture section that lists defaults).
- **Be precise and compact.** Short, fact-dense sentences over prose. Name exact paths, commands, flags, regexes, constants, and refusal codes. Skip rationale unless the *why* is non-obvious. Bullets and tables beat prose for enumerable facts (endpoints, message types, defaults).
