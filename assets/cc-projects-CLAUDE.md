# Project workspace conventions

These instructions apply to every project under the projects root. They are imported into each project's local `CLAUDE.md` via `@../CLAUDE.md`.

## Git hygiene

- **Initialize the repo first.** At the start of working in a project, check whether the project directory is already a git repository (has a `.git/` directory). If not, run `git init` before doing anything else.
- **Ensure a git identity is configured.** Before the first commit in a project, check `git config user.name` and `git config user.email` (which falls back from local to global). If either is empty, ask the user for the missing value(s) with `AskUserQuestion` and then set them via `git config --global user.name "…"` and `git config --global user.email "…"`. Never invent or guess a name/email, and do not commit until both are set.
- **Commit after every prompt that changes files.** When a turn finishes, if the working tree has changes (`git status` shows anything), stage them and create a commit. Use a concise message: a one-line subject naming what changed, followed by a short summary of *why* the change was made. Reference the user's prompt if it helps clarify intent.
- **Skip the commit when nothing changed.** If the turn was purely conversational (questions, explanations, planning) and produced no file modifications, do not create an empty commit.
- **Maintain `.gitignore`.** When a turn produces files that should not be tracked (dependency directories like `node_modules/`, build outputs, caches, logs, editor temp files, secrets/`.env`, OS metadata like `.DS_Store`), create or extend the project's `.gitignore` before committing. Add the minimum patterns needed for what currently exists — don't pre-populate generic templates. Verify the patterns actually match by inspecting `git status` before staging.
- **Do not push.** Never push to any remote unless the user explicitly asks.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly requests it.

## README maintenance

- **Read `README.md` before interacting with a project.** Read the project's `README.md` (if one exists) before anything that touches its behavior *or* contents — running scripts/servers, build/test commands, project tooling, code/config changes, **or exploring the codebase** (reading sources, grepping, globbing, listing dirs beyond the repo root). Pure git actions (`status`, `log`, `diff`, `add`, `commit`, branch inspection) are fine without it.
- **Create a `README.md` when the project has a meaningful purpose** (more than a one-off scratchpad). Write it at the project root, covering **both**:
  - a **functional description** (what the project does, who it's for, how to use it, the user-facing surface), and
  - a **technical description** (stack, architecture, key components, how to run / test / extend, important defaults, known limitations).
  Keep it scannable: a short top-level summary, then sections. A diagram or directory tree helps if the layout isn't obvious.
- **Update `README.md` in the same turn — before committing — when a change warrants it:** a new/removed feature, a new command, a changed flag default, a new endpoint, a different setup step, a new known limitation. Skip for refactors, internal bug fixes, test-only changes, or anything that doesn't alter what's documented.
- **Keep functional and technical sections in sync.** When you change one half (e.g. add a flag), check whether the other half needs updating too (e.g. the architecture section that lists defaults).
- **Be precise and compact.** Short, fact-dense sentences over prose. Name exact paths, commands, flags, regexes, constants, and refusal codes. Skip rationale unless the *why* is non-obvious. Bullets and tables beat prose for enumerable facts (endpoints, message types, defaults).

## System-prompt docs: instruction, not color

This file, each project's `CLAUDE.md`, and everything they import (e.g. `CONDUCT.md`) load into the system prompt of every session — each sentence is a recurring per-session cost. When writing or editing any of them:

- **Test every claim: would the agent act differently — or read a tool result differently — because it knows this?** If behavior is identical without the sentence, it's color, not instruction: cut it.
- **Rationale only where it steers a judgment call.** Absolute rules get no *why*.
- **Each instruction once, in its single best home** — cross-reference rather than restate.
- **Don't restate what arrives at point of use** — tool schemas, error messages, READMEs, on-demand playbooks and wiki pages already deliver that content when needed, and restated copies drift stale.

## Opening URLs

- **Render URLs as tappable buttons.** When the user would benefit from visiting a URL (docs, an auth flow, a generated preview, a search result, a created PR, etc.), present it as a markdown link with a leading `▶` glyph and a short action label — e.g. `[▶ Open Google](https://google.com)` — rather than dropping a bare URL into prose or writing "you can visit …". Never try to open a URL yourself (`am start`, `termux-open-url`) — those are blocked while Termux is backgrounded; a tapped markdown link is the only reliable way to open a browser here.
- **Use sparingly.** One or two per turn, only when the user actually needs to navigate. Don't button-ify every URL you mention in passing — keep those as plain inline links so the buttons stay meaningful.
