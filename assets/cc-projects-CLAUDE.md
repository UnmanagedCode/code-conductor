# Project workspace conventions

These instructions apply to every project under `~/cc-projects/`. They are imported into each project's local `CLAUDE.md` via `@../CLAUDE.md`.

## Git hygiene

- **Initialize the repo first.** At the start of working in a project, check whether the project directory is already a git repository (has a `.git/` directory). If not, run `git init` before doing anything else.
- **Ensure a git identity is configured.** Before the first commit in a project, check `git config user.name` and `git config user.email` (which falls back from local to global). If either is empty, ask the user for the missing value(s) with `AskUserQuestion` and then set them via `git config --global user.name "…"` and `git config --global user.email "…"`. Never invent or guess a name/email, and do not commit until both are set.
- **Commit after every prompt that changes files.** When a turn finishes, if the working tree has changes (`git status` shows anything), stage them and create a commit. Use a concise message: a one-line subject naming what changed, followed by a short summary of *why* the change was made. Reference the user's prompt if it helps clarify intent.
- **Skip the commit when nothing changed.** If the turn was purely conversational (questions, explanations, planning) and produced no file modifications, do not create an empty commit.
- **Maintain `.gitignore`.** When a turn produces files that should not be tracked (dependency directories like `node_modules/`, build outputs, caches, logs, editor temp files, secrets/`.env`, OS metadata like `.DS_Store`), create or extend the project's `.gitignore` before committing. Add the minimum patterns needed for what currently exists — don't pre-populate generic templates. Verify the patterns actually match by inspecting `git status` before staging.
- **Do not push.** Never push to any remote unless the user explicitly asks. These are local-only commits.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly requests it.

## README maintenance

- **Read `README.md` before interacting with a project.** You MUST read the project's `README.md` (if one exists) before doing anything that touches the project's behavior *or* its contents — running or starting scripts, binaries, servers, or services; invoking build/test commands; calling project tooling; making code/config changes; **or exploring the codebase** (reading source files, grepping, globbing, listing directories beyond the repo root). Pure git actions (`status`, `log`, `diff`, `add`, `commit`, branch inspection) are fine without it. The point is to load documented gotchas, defaults, and the project's purpose into context before you investigate or act, so exploration is framed by what the README already explains.
- **Create a `README.md` when the project has a meaningful purpose.** If the project is more than a one-off scratchpad — i.e. it has a real reason to exist, even just for the user themselves — write a `README.md` at the project root. It must cover **both**:
  - a **functional description** (what the project does, who it's for, how to use it, the user-facing surface), and
  - a **technical description** (stack, architecture, key components, how to run / test / extend, important defaults, known limitations).
  Keep it scannable: a short top-level summary, then sections. A diagram or directory tree helps if the layout isn't obvious.
- **Update `README.md` after a prompt when the change warrants it.** If a turn meaningfully changes user-facing behavior (a new feature or removed feature, a new command, a changed flag default, a new endpoint, a different setup step, a new known limitation), update the README in the same turn — before committing. Skip README updates for refactors, internal bug fixes, test-only changes, or other work that doesn't alter what's documented.
- **Keep functional and technical sections in sync.** When you change one half (e.g. add a flag), check whether the other half needs updating too (e.g. the architecture section that lists defaults).
- **Be precise and compact.** Prefer short, fact-dense sentences over narrative prose. Name exact paths, commands, flags, regexes, constants, and refusal codes when they exist — those are the load-bearing details a reader actually needs. Don't pad with rationale paragraphs unless the *why* is non-obvious; rules-of-thumb and re-explanations of what the code already shows are noise. Bullets and tables beat prose for enumerable facts (endpoints, message types, defaults). When tempted to write a paragraph, ask whether a one-line bullet plus a code snippet would carry the same information.

## Opening URLs

- **Render URLs as tappable buttons.** When the user would benefit from visiting a URL (docs, an auth flow, a generated preview, a search result, a created PR, etc.), present it as a markdown link with a leading `▶` glyph and a short action label — e.g. `[▶ Open Google](https://google.com)` — rather than dropping a bare URL into prose or writing "you can visit …". The CodeConductor frontend renders markdown links as `<a target="_blank">`, so a tap opens a new browser tab via a real user gesture (the only reliable way on Android — `am start` / `termux-open-url` from the orchestrator process are blocked when Termux is backgrounded).
- **Use sparingly.** One or two per turn, only when the user actually needs to navigate. Don't button-ify every URL you mention in passing — keep those as plain inline links so the buttons stay meaningful.
