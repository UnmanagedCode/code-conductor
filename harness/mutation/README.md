# Mutation harness — code-conductor

Project-local config for the shared `code-mutant` plugin's runner, so a reviewer can
mutation-prove coverage claims via `/code-mutant:prove`. `config.json` is committed project state;
`.mutation/` is the reviewer's gitignored scratch space. Command syntax below is `mutate.mjs`'s own —
`node harness/mutation/run.mjs --help` is authoritative if this drifts.

**Open [RATIONALE.md](RATIONALE.md) only when you need the *why***: it holds the reasoning behind
`config.json`'s values, the measured case against copy mode and `--jobs`, and the recipe for
re-deriving the env-gate list when the flags change. Reach for it if you are about to change
`config.json`, disagree with one of the rules below, or suspect a verdict is a harness
artefact rather than a coverage finding. You do not need it to run a pass.

## Run a pass

Run from the repo root of the main checkout or of any worktree. `harness/mutation/run.mjs` resolves
`<projectsRoot>/.plugins/code-mutant/mutate.mjs` via `harness/pluginDir.mjs` (from
`$CC_PROJECTS_ROOT`, else derived from git) and passes arguments, cwd and the exit code through
unchanged. Install the plugin from Settings → Plugin Library if the wrapper reports it missing.

**Never pass `--copy`: this project runs `in-place`, and a copy cannot be trusted here.**

```bash
# 1. Gates. Nothing below is trustworthy until this is green AND the canary reads KILLED.
node harness/mutation/run.mjs baseline

# 2. Diff hunks no catalog mutant covers yet. It lists; you target.
node harness/mutation/run.mjs candidates --base main

# 3. Run the catalog you authored at .mutation/mutants.json
node harness/mutation/run.mjs run --all
node harness/mutation/run.mjs run --id <id> --id <id>

# Re-run after a catalog edit: re-measures only mutants whose measured fields changed
# (waivers and prose are free; reused verdicts are labelled fromJournal). It reuses nothing
# after a new commit or a change to config.json's measuring settings — those start a fresh
# journal. Make the final, authoritative run a resume too.
node harness/mutation/run.mjs run --all --resume

# Explore one mutation without a catalog entry (clean-tree gate only warns here).
# No real id yet? Add --learn --json and read results[0].failedTests — never hand-construct one.
node harness/mutation/run.mjs probe \
  --file src/instances.ts --anchor "some exact text" --replace "false" \
  --expect-fail 'tests/instances.test.mjs::a top-level test name'

# Add --json to any of the above for the machine report.
```

`baseline` needs a **clean tree** (`git status --porcelain` empty) — mutation runs against committed
state.

## Three suites

`config.json` runs `runner: "custom"`: `parse.mjs` binds `scoring.ts` (routing, commands, report
reduction) to code-mutant's shipped node-test and vitest adapters, and `suite.ts` is the test
command. A mutant is routed by the **test file** its refs name, never by the source it mutates:

| test file | runner | command `suite.ts` runs (cwd = repo root) |
|---|---|---|
| `tests/<name>.test.mjs` (top level only, as `tests/run.mjs` discovers) | node | `npm test --ignore-scripts -- <files>` |
| `web/src/**/*.test.ts(x)` (`web/vitest.config.ts` `include`) | Vitest | `npx vitest run --config web/vitest.config.ts --reporter=json …` |
| `web/e2e/**/*.spec.ts` | Playwright | `npx playwright test --config web/playwright.config.ts --project=<P> --reporter=json …` |

Any other file is refused (exit 2, nothing on stdout), and so is a requested file its runner did not
run — both read `ERROR` with a narrow baseline that "ran ZERO tests", never a verdict. Mixing suites
in one mutant's refs is fine: each runner gets its own files and the counts are summed.

**Test ids**, all repo-relative — take them from a `--learn` pass, never hand-construct one:

| runner | id | example |
|---|---|---|
| node | `<file>::<describe> > … > <test>` | `tests/sidebar.test.mjs::renders the dot` |
| Vitest | `<file>::<describe> > … > <test>` | `web/src/conversation/cards.test.tsx::cards > plan card > renders markdown` |
| Playwright | `<file>::<project> > <describe> > … > <test>` | `web/e2e/session.spec.ts::desktop > a prompt streams a reply with tool calls, prose and a turn footer` |

**Mutant commands never typecheck; the baseline does.** `baselineCommand` (`suite.ts --all`) runs
`npm run typecheck`, then the whole node suite, then the whole Vitest suite, and a typecheck failure
reads as a build break. A mutant's narrow command skips `pretest` (`--ignore-scripts`), so a mutant
that only breaks a type gets a behavioural verdict from the tests it names — an `x && false`-style
mutant no longer reads `ERROR (scope-empty)` through a pretest red.

**Playwright rows rebuild the bundle.** The suite's globalSetup runs the server's hash-gated
`ensureWebBuild()`: a mutant under `web/` or `public/` changes the source hash, so the scored run
rebuilds `web/dist`, and the restore makes the next run rebuild again. A mutant that breaks the build
fails globalSetup and reads `IMPRECISE (compile-error)`. Specs and fixtures are not build inputs, so
the canary injected into a spec costs no rebuild. Playwright rows need the browser revision
`@playwright/test` pins (`web/e2e/README.md`). `--all` runs no Playwright: a spec scores a mutant
only when a ref names it.

**Playwright rows: one project per run.** Every Playwright row of an invocation runs under
`CC_MUTATION_PW_PROJECT` (default `desktop`; an unknown name is refused). Without the pin a spec
shared by several projects would fail the canary, and a real kill, once per project. So:

- A spec the project does not run (`*.android.spec.ts` under `desktop` or `phone`; `legacy/**` or
  `live.spec.ts` under `phone` or `android`) is refused; `suite.ts` names the projects that run it.
- A test that skips itself outside its project reads *skipped* under the default, so a mutant
  touching only phone- or android-only behaviour reads `SURVIVED`. The honest reading is **"scored
  under desktop only"**, not "uncovered": re-run the whole invocation with
  `CC_MUTATION_PW_PROJECT=phone` (or `android`) to score it.
- The project is a measuring condition code-mutant's journal cannot see (`suite.ts` prints it in the
  stored output's `playwright project=<P>` header). **Never `--resume` across a change of
  `CC_MUTATION_PW_PROJECT`**; start a fresh run.

## Four project-specific rules

1. **A test id is its full `describe > name` path, not its leaf name.** Top-level tests are
   `tests/<file>.test.mjs::<test name>`; a test inside a `describe(...)` is
   `tests/<file>.test.mjs::<describe name> > <test name>`, with the describe name reproduced
   verbatim, parentheses and all. **Never hand-construct an id** — take every `file::name` id from
   the observed set of the `--learn` pass. A bare file path (`tests/<file>.test.mjs`, no `::`) is a
   scope, not an id: it is the sanctioned pre-learn `expectFail` seed (see "What to expect"). A
   leaf-only ref for a nested test does not fail loudly; it reads `IMPRECISE (extra-failures)` and
   advises you to rewrite a mutant that was already correct. To
   check which files nest tests under `describe`, run `rg -l '^describe\(' tests/*.test.mjs` —
   don't rely on a remembered list, it drifts.

   **AND THE ID IS THE TEST'S TITLE, SO RENAMING A TITLE SILENTLY INVALIDATES EVERY `expectFail`
   SET THAT NAMES IT.** It surfaces as `IMPRECISE`, never as a failure, so a stale ref reads as a
   *mutant* problem and invites rewriting a mutant that was already correct. This is a recurring
   trap on the FUSE-union epic specifically, because its driver cases carry long invariant
   sentences in their titles (`tests/fuse-union-policy.test.mjs`'s `CASES` table), and a change
   that only sharpens one wording re-anchors nothing: an inherited mutant whose referenced titles
   are renamed goes `IMPRECISE` on that alone — same killers, unchanged coverage. **On any round
   that touches a title in `CASES`,
   re-run `--learn` for the inherited mutants before reading a verdict**, and re-anchor from the
   observed set rather than editing the mutant.

2. **Omit `narrowTo` from every mutant.** `narrowTo: "names"` does not work against this suite and
   `validate` will not warn you. It degrades safely — `IMPRECISE` or `ERROR`, never a false `KILLED`
   or `SURVIVED` — but it burns a review round on a non-finding. File granularity is the policy
   default; leave it there.

3. **Env-gated opt-in tests are outside mutation proof.** Any test the suite skips because an opt-in
   env flag is unset is invisible to every run here — `baselineCommand` sets no opt-in flag. Mutate
   code only such a test exercises and you get `SURVIVED`; the one honest reading is *"covered
   solely by an opt-in test this harness does not enable"*, **never** *"no test covers this."*
   Filing the latter is a false finding against an implementer who did nothing wrong. The
   `scope-empty` guard does not catch this: `ran` counts skipped tests, so a scope of an
   all-skipped file reports a *green* narrow baseline and the mutant reads `SURVIVED`, not
   `ERROR (scope-empty)`. RATIONALE.md §5 lists today's gates and how to re-derive them.

4. **A build step the node suite needs belongs in `test` (or `tests/run.mjs`), never in `pretest`.**
   Every mutant command skips `pretest`, so a step there would leave mutants judged against stale
   output.

## Declared non-behavioural mutants — waive, do not file

A mutant listed here **legitimately SURVIVES**. Each is a construct whose removal changes no
answer the suite (or any caller) can observe *under the stated condition*; they are declared by the
implementer at the time the construct lands, so anyone re-running mutants waives them instead of
re-discovering and re-filing them every round. State the waiver — and its condition — in the
round's report; do not silently drop it.

**A row states the CONDITION under which the mutation is equivalent, not a past verdict.** When a
condition stops holding, the row's mutant becomes killable and the row goes.

| construct | mutation | why it is equivalent, and under what condition |
|---|---|---|
| `agBody` in `public/blocks.js` | its direct-children scan replaced by `groupNode.querySelector('.ag-body')` | **EQUIVALENT WHILE EVERY ACTION GROUP CARRIES ITS OWN `.ag-body` AS A DIRECT CHILD** — `createActionGroup` is the only producer of a group and always builds one. A direct child precedes every descendant in tree order, so `querySelector` returns this group's own body even when the group holds a sub-agent conversation with a group (and a body) of its own: no DOM a test can build tells the two forms apart. **If a group is ever built without a body of its own** — a second wrapper shape, or a body a merge removes — the forms diverge and this row goes. Do not write a test for it; there is none to write. |

And the standing one, which is not a construct but a test: **`A16`'s sha256 latch
(`tests/fuse-lifecycle.test.mjs`) is a deliberate-edit disclosure, not coverage.** A C mutant whose
only failing test is `A16` is **unattributed** — re-run it narrower rather than recording `KILLED`.
RATIONALE.md §5.1c has the measurement and the scoping recipe.

And its counterpart on the other side: **a mutation run cannot see the real gate's arms at all.**
It mutates source and re-runs the DEFAULT suite, where the four `tests/fuse-*.real.test.mjs` files'
arms self-skip — and an arm that never executes contributes neither a pass nor a kill. So a C mutant
reported as a survivor is a survivor *of the default suite*, not of the FUSE coverage as a whole.
Running the gate once before merge is the only thing that reads those arms:
`TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs` — measured
95.4-96.9 s of wall for the family on a quiet 16-core box, 0 kills in 10 consecutive runs. **The cap is
part of the invocation**: uncapped, the four files starve each other into the runner's 60 s per-test
timeout and a file is SIGKILLed at `FILE_KILL_MS`, measured 3 runs in 18. Setting the flag on a
WHOLE-SUITE run is the same hazard; `TEST_CONCURRENCY=4` is what has been tried there, but it has
measured green once and red once (`R14L`, the same starvation shape), so it carries no rate. `docs/architecture.md` →
"The FUSE-union chroot" carries every measurement.

## What to expect

- `baseline` is **two full passes** (baseline + canary) of `suite.ts --all`: typecheck, node suite,
  Vitest suite. On a 16-core host one pass is ~1.5 min (RATIONALE §1), so budget ~3 min; a low-core
  host (Termux) is a multiple of that. It is not hung —
  `timeoutMs` in `config.json` is sized for the slow case.
- A file-narrowed mutant is seconds, not minutes. **Always give every mutant an `expectFail`**: that
  is what buys the narrowing. Before the first `--learn`, the claimed killer's **file** alone
  (`tests/<file>.test.mjs`, no `::`) is a sufficient seed — it is read only as scope. Replace it
  with the observed ids from the learn pass before grading: a file-only ref in a graded run cannot
  match a failing test id.
- A mutant run's deadline derives from its narrow baseline, with a floor (`hang` in `config.json`).
  A mutant that breaks an awaited event can take tens of seconds to fail — that is not a hang.
  `TIMEOUT` means the run outlived the deadline in force: a real hang, or a correctly failing
  mutant whose chain of `waitFor` expiries is longer than that deadline. RATIONALE.md §7.1 lists
  the shapes; re-measure the second at whole-suite scope (`narrowCommand: "npm test"`).

## Artifacts

- `harness/mutation/` — committed. The *how* persists.
- `.mutation/mutants.json` and `.mutation/results/` — gitignored, reviewer-owned, one review loop.
  **Never commit a catalog:** anchors are coupled to exact source text, so a committed one rots into
  stale-anchor `ERROR`s on invariants nobody is reviewing. The durable artifact is the *test*.

`run` and `probe` **hard-stop (exit 4)** if `.mutation/` is not gitignored. It is, via `.gitignore` →
`.mutation/`; verify with `git check-ignore -q .mutation/results/probe.json` — that exact probe path,
because a directory-only pattern reports "not ignored" while the directory doesn't exist yet.
