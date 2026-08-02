# Mutation harness — code-conductor

Project-local config for the shared [`code-mutant`](../../../code-mutant/) runner, so a reviewer can
mutation-prove coverage claims via `/code-mutant:prove`. This directory is **committed project
state**: `config.json` is the harness, `.mutation/` (gitignored) is the reviewer's scratch space.

The runner is a sibling project, not a dependency. Command syntax below is `mutate.mjs`'s own —
`node ../code-mutant/mutate.mjs --help` is authoritative if this drifts.

---

## Read these first

### 1. `--copy` FAILS THE BASELINE GATE here — never pass it

`/code-mutant:prove` step 6 says "prefer `--copy`". **That does not apply here.** This is not a soft
preference and not a degraded-verdict tradeoff: in copy mode the **baseline gate fails**, so *zero*
mutants run and no verdict is interpretable. Measured, `baseline --copy` → `1948/1/13 (p/f/s)`,
`baseline FAILED`, process **exit 2**. Reproduce in one command:
`node ../code-mutant/mutate.mjs baseline --copy`.

Use the configured default (`in-place`), or `--in-place` explicitly to override the habit. Why a copy
breaks:

- **A copy is not a git repository.** `code-mutant`'s `copyTree` excludes the top-level `.git` entry.
  In a code-conductor worktree `.git` is a *pointer file*, so the copy has no git linkage at all —
  `git rev-parse` inside it fails outright. The concrete casualty is
  `tests/plugins-supervisor.test.mjs::git HEAD is recorded when cwd is a repo, null otherwise`, which
  reads the repo's own HEAD and gets `null` — that single failure is what fails the baseline.
- **Copy mode also defeats the store-isolation backstop.** `tests/safeStoreRoot.mjs` derives
  `REAL_STORE_DIR` **source-relative** (`<repo>/../.code-conductor`). Copy mode relocates the tree to
  `os.tmpdir()/code-mutant-run-*`, so that constant becomes `/tmp/.../.code-conductor` and
  `assertStoreIsolated` starts asserting against a path that is not the production store — a
  tautology. No data is at risk either way (`tests/run.mjs` pins `PROJECTS_ROOT` /
  `CLAUDE_PROJECTS_ROOT` to a fresh `mkdtemp` before any test file forks, and children inherit it),
  but the guarantee is only genuinely exercised in-place.

In-place restore is byte-snapshot replay plus a byte-identity check and a whole-tree `git status`
comparison, and the suite leaves no residue in the tree, so `assertNoTrace` holds.

### 2. `expectFail` refs: a nested test needs its `describe >` path, not its leaf name

Two forms, depending on where the test sits:

| Test | Reference |
|---|---|
| top-level `test(...)` | `tests/<file>.test.mjs::<test name>` |
| inside a `describe(...)` | `tests/<file>.test.mjs::<describe name> > <test name>` |

The adapter reconstructs the full `describe > name` path from the spec reporter's inline block
(`parseInlineFailurePaths`) and matches `expectFail` against **that**. A leaf-only ref for a nested
test does not match, and the failure mode is a trap: the verdict is `IMPRECISE (extra-failures)` with
detail *"the mutant is too broad, rewrite it smaller"* — advice that sends you to rewrite a mutant
that was already correct. Measured, same mutation, only the ref differing:

```
leaf-only ref   → IMPRECISE  reason: extra-failures
  unexpectedFailures: ["tests/backend-registry.test.mjs::resolveBackendLaunch (template-driven launch resolution) > {model} substitutes INSIDE a token, so --model={model} works too"]
  missingFailures:    ["tests/backend-registry.test.mjs::{model} substitutes INSIDE a token, so --model={model} works too"]

full describe path → KILLED  (37 passed / 1 failed / 38 ran)
```

**Don't hand-construct an id — read it.** Run the mutation once via `probe --json` and copy the
string out of `results[0].failedTests`; that is the adapter's own id for the test and is what
`expectFail` is compared against. Note the describe name is reproduced verbatim, parentheses and all.

Three files in this suite use `describe`: `tests/backend-spawn.test.mjs`,
`tests/backend-registry.test.mjs`, `tests/mcp-inspect-tools.test.mjs`. Everything else is top-level.

### 3. `narrowTo: "names"` does NOT work here — leave narrowing at the default

The `node-test` adapter declares `canNameFilter: true` and substitutes
`--test-name-pattern '<regex>' 'tests/foo.test.mjs'`. But `tests/run.mjs` is **not** the
`node --test` CLI — it is a programmatic runner that treats *every* argument as a file path
(`process.argv.slice(2)`, each `path.resolve`d against cwd). The flag and the pattern are resolved as
filenames, so the scope runs the wrong files.

It degrades safely — the mutant reads `IMPRECISE` or `ERROR`, never a false `KILLED` or `SURVIVED` —
but it burns a review round on a non-finding. **Omit `narrowTo` from every mutant** and let it stay
at file granularity, which is the policy default anyway.

### 4. Env-gated opt-in tests are outside mutation proof — a survivor there is uninformative

**The rule, which outlives any list below:** any test the suite skips because an opt-in env flag is
unset is invisible to every mutation run here. `baselineCommand` is plain `npm test`, which sets no
opt-in flag at all. Mutate code that only such a test exercises and you get `SURVIVED`; the one honest
reading is *"covered solely by an opt-in test this harness does not enable"*, **never** *"no test
covers this."* Filing the latter is a false finding against an implementer who did nothing wrong.

**Snapshot of the gates present today** — a starting point to re-derive, not a fact to trust; flags get
added and removed:

| Env flag | Skips | Surface left unproven |
|---|---|---|
| `RUN_REAL_CLAUDE` | 7 | real spawn + stream-json parsing, Bash tool call, AskUserQuestion, ask-mode PreToolUse hook (`smoke.real` 4); pruned-session resume + read-before-edit re-arm (`prune.real` 1); shell-env bundle restoring rg/find (`claudeShellEnv` 1); real `renew_session` sessionId rotation (`renew-session` 1) |
| `RUN_REAL_OLLAMA` | 1 | `ollama launch claude … --version` forwarding claude's stdout/exit code (`claudeShellEnv`) |
| `RUN_PLAYWRIGHT` | 3 | real-browser UI behaviour, one test each — main-bar reset (`main-bar-reset-browser`), plugin app-switcher landing (`plugin-switch-browser`), plugin version-select width (`plugin-version-select-width`) |
| `RUN_TTS_INSTALL_TESTS` | 2 | Piper voice install flow and its 409-while-running guard (`settings-tts`). **Note the name:** the file reads this flag into a local const called `RUN_INSTALL`; `RUN_INSTALL` is not an env var. |

7+1+3+2 = **13, the entire skip count** in the baseline's `1949/0/13`. There is no residual
"unrelated" remainder that is safe to mutate against — every skip in this suite is an env-flag opt-in
gate. Enabling any of them needs something a review environment does not have (the real
`claude`/`ollama` binary plus auth plus network; a Chromium install via the `code-playwright` sibling;
a network voice download), so treat the whole set as **out of scope for mutation proof** and report
such a claim as unprovable-by-this-harness rather than mutating it.

**Re-derive it when the gates change:**

```bash
# the env flags that gate tests today
grep -rhoE "process\.env\.(RUN|SKIP)[A-Z_]+" tests/*.test.mjs | sort -u
# every test skipped in a full run — 13 lines today, matching `ℹ skipped`
npm test 2>&1 | grep '^﹣'
# attribute skips to one file
npm test -- tests/<file>.test.mjs 2>&1 | grep -E '^﹣|^ℹ skipped'
```

Two traps in re-deriving this, both of which produced a wrong count while writing it:

- **Grep the `﹣` glyph, not `# SKIP`.** The spec reporter appends `# SKIP` only for a boolean
  `skip: true`; a `skip: '<reason>'` prints `# <reason>` instead (e.g.
  `# set RUN_TTS_INSTALL_TESTS=1 to run`). Grepping `# SKIP` silently drops those and reports 11 of 13.
- **Don't grep `skip:` in the sources.** The gates use three different mechanisms
  (`test.skip.bind(test)`, `{ skip: <const holding the reason> }`, and an inline
  `{ skip: process.env.X !== '1' }`); only the last is findable that way.

Also beware that a *host-capability* skip is a different thing from an env-flag gate and moves between
hosts, so any count you take is host-specific: `mcp-inspect-tools`'s zsh-flavoured `project_bash`
block skips only where `zsh` is absent. It contributes 0 here (zsh 5.9 present), which is why the
13 above is exactly the four env flags.

**The `scope-empty` guard does not save you.** `ran` counts skipped tests, so a scope narrowed to
`tests/smoke.real.test.mjs` reports `ran 4 / skipped 4 / failed 0` — a *green* narrow baseline — and
the mutant then reads `SURVIVED` rather than `ERROR (scope-empty)`. Verified by running that file
directly.

---

## Running it

From the repo root or any `code-conductor_worktree_*` (both are direct children of the projects
root, so the relative path resolves from either; the absolute
`/workspaces/cc-projects/code-mutant/mutate.mjs` is the fallback):

```bash
# 1. Gates. Nothing below is trustworthy until this is green AND the canary reads KILLED.
node ../code-mutant/mutate.mjs baseline

# 2. Diff hunks no catalog mutant covers yet. It lists; you target.
node ../code-mutant/mutate.mjs candidates --base main

# 3. Run the catalog you authored at .mutation/mutants.json
node ../code-mutant/mutate.mjs run --all
node ../code-mutant/mutate.mjs run --id <id> --id <id>

# Explore one mutation without a catalog entry (clean-tree gate only warns here).
# Add --json and read results[0].failedTests to learn a test's real id — see §2.
node ../code-mutant/mutate.mjs probe \
  --file src/instances.js --anchor "some exact text" --replace "false" \
  --expect-fail 'tests/instances.test.mjs::a top-level test name'

# Add --json to any of the above for the machine report.
```

`baseline` needs a **clean tree** (`git status --porcelain` empty) — mutation runs against committed
state. Don't reach for `--allow-dirty` to get past that; every verdict from such a run is labelled
non-reproducible.

## What to expect

| | |
|---|---|
| Full suite (`baselineCommand`) | ~36 s, 1962 tests (1949 pass / 13 skipped / 0 fail) on a 16-core host |
| `baseline` total | ~75 s — the canary run is a second full-suite pass |
| A file-narrowed mutant | ~0.1–4.5 s across the files timed — `resume-manifest` 0.13 s, `health` 0.53 s, `mcp-inspect-tools` 1.28 s, `instances` 2.91 s, `overage-action` **4.31 s**. Files that wait on drains/timeouts sit at the top end; this is a sample, not a swept bound. |
| Test reference format | repo-relative, and **`describe >` path–sensitive** — see [§2](#2-expectfail-refs-a-nested-test-needs-its-describe--path-not-its-leaf-name) |

Narrowing is the difference between the full-suite row and the narrowed row above, so always give
every mutant an `expectFail`.

Runtimes scale with core count: `tests/run.mjs` runs files at `min(4, cores/2)` concurrency
(`TEST_CONCURRENCY` overrides). On a low-core host (Termux) expect multiples of the above — which is
what `timeoutMs` below is sized for.

## Config

| Field | Value | Why |
|---|---|---|
| `baselineCommand` | `npm test` | The project's real entry point (`package.json` script, README quick start). Using the script rather than its expansion keeps `NODE_OPTIONS=--max-old-space-size=512` defined in one place. |
| `testCommand` | `npm test -- {tests}` | `npm test -- <files>` forwards positionals to `tests/run.mjs`, which accepts a list of file paths. The adapter substitutes space-joined single-quoted repo-relative paths. |
| `runner` | `node-test` | `tests/run.mjs` is bespoke but pipes through `new spec()` from `node:test/reporters` — the same reporter the adapter is pinned to. Counters (`ℹ tests/pass/fail/skipped`) land on stdout; the `✖ failing tests:` block carries `test at <repo-relative path>`, because the spec reporter emits `relative(process.cwd(), file)` and the runner resolves its args against the same cwd. A full green run trips none of the adapter's `compileError` probes. Proven here by the `baseline` canary gate. |
| `isolation` | `in-place` | See §1 above — `--copy` fails the baseline gate outright. Also: the suite boots real express+ws servers on ephemeral ports and forks child processes. |
| `timeoutMs` | `300000` | Applies to **every** measured command, the full-suite baseline included. 36 s on 16 cores, but a slow/Termux host is far slower and a baseline `TIMEOUT` is a gate failure that blocks the whole review. It's a cap, not a wait; `tests/run.mjs` has its own 60 s per-file ceiling, so a hung mutant still surfaces well inside it. |
| `baseBranch` | `main` | The real integration branch. Unset, `run`'s empty-diff-vs-base gate reports `not-established` and checks nothing — a branch with no committed work would read as a clean sweep. |

Defaults left alone: `preserve` (in-place copies nothing, and `node_modules` is already a symlink to
the primary checkout), `jobs` (clamped to 1 in-place regardless), `setup`/`teardown` (nothing to
build or reset).

There is no `parse.mjs`: the shipped `node-test` adapter parses this suite's output correctly, and a
custom parser would have to reimplement its canary injection for no parsing gain.

## Artifact lifetime

- `harness/mutation/` — committed. The *how* persists.
- `.mutation/mutants.json` and `.mutation/results/` — gitignored, reviewer-owned, one review loop.
  Never commit a catalog: anchors are coupled to exact source text, so a committed one rots into
  stale-anchor `ERROR`s on invariants nobody is reviewing. The durable artifact is the *test*.

`run` and `probe` **hard-stop (exit 4)** if `.mutation/` is not gitignored. It is, via `.gitignore`
→ `.mutation/`; verify with `git check-ignore -q .mutation/results/probe.json` (that exact probe
path — a directory-only pattern reports "not ignored" while the directory doesn't exist yet).
