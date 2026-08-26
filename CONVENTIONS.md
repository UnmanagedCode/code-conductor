<!-- cc:conventions design-guidelines,testing-guidelines,documentation-guidelines,migration-guidelines -->

# Workspace conventions

These instructions apply to every project code-conductor manages. They are regenerated into the `CONVENTIONS.md` you are reading: edit them in **Settings → Conventions → Workspace**, never in this file, which is overwritten.

## Git hygiene

- **Ensure the repo exists.** If the project dir has no `.git` entry (in a worktree it's a file, not a directory), run `git init` before the first commit.
- **Ensure a git identity is configured.** Before the first commit in a project, check `git config user.name` and `git config user.email` (which falls back from local to global). If either is empty, ask the user for the missing value(s) with `AskUserQuestion` and then set them via `git config --global user.name "…"` and `git config --global user.email "…"`. Never invent or guess a name/email, and do not commit until both are set.
- **Commit after every prompt that changes files.** When a turn finishes, if the working tree has changes (`git status` shows anything), stage them and create a commit. Use a concise message: a one-line subject naming what changed, followed by a short summary of *why* the change was made. Reference the user's prompt if it helps clarify intent.
- **Skip the commit when nothing changed.** If the turn was purely conversational (questions, explanations, planning) and produced no file modifications, do not create an empty commit.
- **Maintain `.gitignore`.** When a turn produces files that should not be tracked (dependency directories like `node_modules/`, build outputs, caches, logs, editor temp files, secrets/`.env`, OS metadata like `.DS_Store`), create or extend the project's `.gitignore` before committing. Add the minimum patterns needed for what currently exists — don't pre-populate generic templates. Verify the patterns actually match by inspecting `git status` before staging.
- **Do not push.** Never push to any remote unless the user explicitly asks.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly requests it.

## README maintenance

- **Read `README.md` before interacting with a project.** Read the project's `README.md` (if one exists) before anything that touches its behavior *or* contents — running scripts/servers, build/test commands, project tooling, code/config changes. Pure exploration (reading sources, grepping, globbing, listing dirs) doesn't need it.
- **Create a `README.md` when the project has a meaningful purpose** (more than a one-off scratchpad). Write it at the project root, covering **both**:
  - a **functional description** (what the project does, who it's for, how to use it, the user-facing surface), and
  - a **technical description** (stack, architecture, key components, how to run / test / extend, important defaults, known limitations).
  Keep it scannable: a short top-level summary, then sections. A diagram or directory tree helps if the layout isn't obvious.
- **Update `README.md` in the same turn — before committing — when a change warrants it:** a new/removed feature, a new command, a changed flag default, a new endpoint, a different setup step, a new known limitation. Skip for refactors, internal bug fixes, test-only changes, or anything that doesn't alter what's documented.
- **Keep related docs in sync.** Within a file, changing one half means checking the other. Across a layered doc set, a change spanning layers updates every layer it touches — or keep the fact in one file and cross-link.
- **Optimize reference docs for retrieval, not token economy.** An omitted fact costs the reader more than an included one — they re-derive it. Be complete on the facts a reader needs: short, fact-dense bullets and tables over dense paragraphs; one fact findable at a glance. Name exact paths, commands, flags, regexes, constants, and refusal codes; skip rationale unless the *why* is non-obvious.
- **Reference code-defined values, don't restate them.** In a doc or comment, name the constant, schema, or code that owns a value, count, or list — "the supported modes", not "three modes". Where a reader must act on the value, state it anchored to its source.
- **Split a doc before its section sprawls.** When a subsystem fits no single host doc, or its section outgrows its host — larger than the rest of that file, or past a screenful — promote it to its own `docs/<subsystem>.md` and link it from the routing list.

## System-prompt docs

This file, each project's `CLAUDE.md`, everything they import, and the conductor role doc (`.conduct/CONVENTIONS.md`) load into the system prompt of every session — each sentence is a recurring per-session cost. When writing or editing any of them:

- **Test every claim: would the agent act differently — or read a tool result differently — because it knows this?** If behavior is identical without the sentence, it's color, not instruction: cut it (e.g., implementation detail the agent never acts on).
- **Rationale only where it steers a judgment call.** Absolute rules get no *why*.
- **Each instruction once, in its single best home** — cross-reference rather than restate.
- **Push what nothing volunteers.** Cut a fact some channel delivers unasked at point of use — a tool schema, an error or refusal, a pre-resolved field, a doc the reader is already opening. Keep one whose only channel is the reader thinking to ask, including a fact guarding an action they'd otherwise never attempt.

## Opening URLs

- **Render URLs as tappable buttons.** When the user would benefit from visiting a URL (docs, an auth flow, a generated preview, a search result, a created PR, etc.), present it as a markdown link with a leading `▶` glyph and a short action label — e.g. `[▶ Open Google](https://google.com)` — rather than dropping a bare URL into prose or writing "you can visit …". Never try to open a URL yourself; in environments without direct browser access (such as Termux, where `am start`/`termux-open-url` are blocked while backgrounded), a presented markdown link is the only reliable path to the user's browser.
- **Use sparingly.** One or two per turn, only when the user actually needs to navigate. Don't button-ify every URL you mention in passing — keep those as plain inline links so the buttons stay meaningful.

# Project conventions

## Design guidelines
- YAGNI — build only what a current, concrete requirement needs; no speculative abstractions, config knobs, or extension points "for later." If code isn't exercised by a real caller or test, delete it rather than keep it "just in case."
- One responsibility per module — when a module takes on a second concern, extract it as a composed collaborator behind a stable interface; no god-modules.
- Single source of truth — shared catalogs, config, and constants live in one authoritative place and are read from there; never duplicate them (a startup fallback is fine — it's a fallback, not a second source).
- Keep wiring thin — entry/bootstrap code builds state and calls each feature's init once; feature logic lives in its own module, not the entry point.
- Share one implementation across surfaces — when the same logic backs multiple interfaces (e.g. an HTTP API and a CLI/MCP tool), write it once and import it from both; never reimplement per surface.
- Depend on stable interfaces, not internals — collaborators talk through narrow, documented surfaces so either side can change independently.
- Fail loudly, not silently — surface errors with context; reserve fallbacks for genuine, logged degradations.

## Testing guidelines
- Prefer automated tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- Tests must be deterministic and fast: no long real sleeps, no live network, no wall-clock dependence. Use short timeouts and fake/injected clocks, and assert on the killed/cancelled outcome rather than waiting out a delay.
- Isolate state: each test sets up and tears down its own fixtures (fresh temp dirs, no shared globals) so tests pass in any order.
- For expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. `RUN_REAL_X=1`).
- Use the language's built-in test runner unless the project already uses another framework; avoid adding dependencies.
- When presenting an implementation plan, include an "Integration tests" section listing the actual test files, what they cover, and the run command — not a "Manual verification" section.
- Run tests as the last implementation step and report pass/fail; don't ask the user to verify by hand.

## Documentation guidelines
Layer docs; on any behavior change, update the most specific file(s) — not just the README.
- `docs/features.md` — user-facing features, UI, new tools.
- `docs/protocol.md` — interface contracts: endpoints, message types, protocol flags, wire formats.
- `docs/architecture.md` — internals: components, lifecycle, on-disk state, migrations, test patterns.
- `README.md` — overview, quick start, key defaults, known limitations; add a one-line note here only when a change adds a new top-level subsystem.
This overrides the workspace README-maintenance update rule here: README changes only for new top-level subsystems; new commands/flags/endpoints go to the matching `docs/*.md`.

## Migration guidelines
- When a persisted data or config format changes, write a one-shot, idempotent migration that runs at startup and upgrades old state in place — don't scatter format checks through application code.
- Application code assumes the current format only: no read-time dual-shape parsing, no legacy key aliases, no "back-compat" defaults.
- Migrations must self-check "already applied" and no-op if so; never destroy data you can't reconstruct — move it aside instead of deleting it.
- APIs with no external consumers owe no stability guarantee — change the API and its callers together instead of keeping an old shape alive "just in case."
- Exception: tolerate read-time variance only for formats owned by external tools you can't migrate (e.g. a third-party CLI's session files); everything you own gets migrated, not shimmed.
