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

**The wrapper holds one box-wide test slot per invocation** (every subcommand, `validate` and
`candidates` included), taking it before the runner starts so a queue wait never counts against
`timeoutMs` or the hang deadlines; the route commands inherit `CC_TEST_SLOT_HELD` and take none.
Always go through the wrapper: calling `mutate.mjs` directly skips the lease, and the node and Vitest
route commands (Playwright takes none) then each queue inside their own deadline. Slot rules: `docs/architecture.md` → Box-wide test slots.

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

## Three routes

`config.json` declares `routes` (code-mutant's routing): each names the test files it owns, its
runner and its commands. A mutant is routed by the **test file** its refs name, never by the source it
mutates, to the first route whose `tests` globs match. Commands run from the repo root.

| route | `tests` | runner | `testCommand` (`{tests}` = the scope's files) |
|---|---|---|---|
| `node` | `tests/*.test.mjs` (top level only, as `tests/run.mjs` discovers) | `node-test` | `node tests/run.mjs {tests}` |
| `vitest` | `web/src/**/*.test.ts`, `web/src/**/*.test.tsx` (`web/vitest.config.ts` `include`) | `vitest` | `npx vitest run --config web/vitest.config.ts --reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json" {tests}` |
| `playwright` (`optIn`) | `web/e2e/**/*.spec.ts` | `custom` (`parse.mjs`) | `npx playwright test --config web/playwright.config.ts --project="${CC_MUTATION_PW_PROJECT:-desktop}" --reporter=json {tests}`, report to `$CODE_MUTANT_REPORT_DIR/playwright.json` |

A ref no route owns is refused: the mutant reads `ERROR` (`plan-failed`) naming every route's
patterns. A scope file its route's runner did not report is refused too: when the runner reported other
files, the narrow baseline is non-green and the mutant reads `ERROR` (`scope-non-green`); when it
reported none, the narrow baseline "ran ZERO tests" and the mutant reads `ERROR` (`scope-empty`)
with the parser's diagnostic when the route's adapter supplies one (Vitest's missing-report diagnostic, Playwright's project-selection one). Never a verdict. Mixing routes in one mutant's refs
is fine: each route gets its own files and the counts are summed.

**Test ids**, all repo-relative — take them from a `--learn` pass, never hand-construct one:

| runner | id | example |
|---|---|---|
| node | `<file>::<describe> > … > <test>` | `tests/anchor.test.mjs::readSessionAnchor returns null when no hash is set` |
| Vitest | `<file>::<describe> > … > <test>` | `web/src/conversation/cards.test.tsx::cards > plan card > renders markdown` |
| Playwright | `<file>::<project> > <describe> > … > <test>` | `web/e2e/session.spec.ts::desktop > a prompt streams a reply with tool calls, prose and a turn footer` |

**Mutant commands never typecheck; the baseline does.** Each non-opt-in route's `baselineCommand`
typechecks its own half: `node` is `npm run typecheck:node >&2 && node tests/run.mjs`, `vitest` is
`npm run typecheck:web >&2 && …vitest run …`; no `testCommand` typechecks. A red half stops its
route's suite, so the baseline reads `route "<name>": the command ran ZERO tests` — run
`npm run typecheck` to see why. A mutant's command never typechecks, so a mutant that only breaks a
type gets a behavioural verdict from the tests it names — an `x && false`-style mutant never reads
`ERROR (scope-empty)` through a typecheck red.

**Playwright rows rebuild the bundle.** The suite's globalSetup runs the server's hash-gated
`ensureWebBuild()`: a mutant under `web/` or `shared/` changes the source hash, so the scored run
rebuilds `web/dist`, and the restore makes the next run rebuild again. A mutant that breaks the build
fails globalSetup and reads `IMPRECISE (compile-error)`. Specs and fixtures are not build inputs, so
the canary injected into a spec costs no rebuild. Playwright rows need the browser revision
`@playwright/test` pins (`web/e2e/README.md`). The `playwright` route is opt-in: the baseline and the
baseline-scope canary report it under `skippedRoutes` (`SKIPPED`), and a spec scores a mutant only
when a ref names it. Such a mutant gets its own narrow canary in its own spec.

**The Playwright canary is a test of `web/e2e/harness/fixtures.ts`'s `test`** (`canaryFor` in
`playwright.ts`), appended to the spec as `<project> > code_mutant_canary_fires`. Playwright checks a
file's root hooks against each test's own fixtures and gives each test type its own worker, so a
root `test.beforeAll(async ({ cc }) => …)` loads, and in a spec built on those fixtures the canary
runs last in the spec's worker — the root `beforeAll` runs once. Two consequences:

- A root hook that takes a fixture `fixtures.ts` does not define (a spec-local `test.extend`) fails
  the file's load once the canary is in it: the spec reads `canary-not-established`, never a verdict.
- A spec that takes `test` from `@playwright/test` (`sw-upgrade.spec.ts`) runs its canary
  in a worker of its own, which re-runs the spec's root hooks and boots a `cc` (Playwright's auto
  artifacts fixture reaches it through `baseURL`).

**Playwright rows: one project per run.** Every Playwright row of an invocation runs under
`CC_MUTATION_PW_PROJECT` (default `desktop`; Playwright refuses an unknown name and writes no report, which reads `ran: 0` with a diagnostic). Without the pin a spec
shared by several projects would fail the canary, and a real kill, once per project. So:

- A spec the project does not run (`*.android.spec.ts` under `desktop` or `phone`; `live.spec.ts`
  under `phone` or `android`) is refused: Playwright reports "No tests found", which the parser does not read as a compile break,
  so the mutant reads `ERROR` (`scope-empty`) with the detail `route "playwright": the command ran
  ZERO tests … Playwright found no test to run: a spec outside project <P>'s testMatch/testIgnore in
  web/playwright.config.ts is not selected; set CC_MUTATION_PW_PROJECT to a project that runs it`.
  (A spec beside others the project does run reads `scope-non-green` instead.)
- A test that skips itself outside its project reads *skipped* under the default, so a mutant
  touching only phone- or android-only behaviour reads `SURVIVED`. The honest reading is **"scored
  under desktop only"**, not "uncovered": re-run the whole invocation with
  `CC_MUTATION_PW_PROJECT=phone` (or `android`) to score it.
- The project is a measuring condition code-mutant's journal cannot see. **Never `--resume` across a
  change of `CC_MUTATION_PW_PROJECT`**; start a fresh run.

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

2. **No `narrowCommand`; `narrowTo: "names"` is downgraded to file granularity.** `config.json`
   has an opt-in route, and the custom `playwright` route cannot filter by test name, so the routed
   adapter cannot either: `narrowTo: "names"` is downgraded to file granularity for every mutant
   (node and Vitest included), and `validate` warns `narrow-downgraded`. Nothing is refused. A
   per-mutant `narrowCommand` is refused for every mutant, because a baseline-scope canary cannot
   attest a command a config with an opt-in route narrows by hand: the mutant reads `ERROR`
   (`canary-not-established`) and `validate` reports `opt-in-unattested`. Omit both; file
   granularity is the default.

3. **Env-gated opt-in tests are outside mutation proof.** Any test the suite skips because an opt-in
   env flag is unset is invisible to every run here — `baselineCommand` sets no opt-in flag. Mutate
   code only such a test exercises and you get `SURVIVED`; the one honest reading is *"covered
   solely by an opt-in test this harness does not enable"*, **never** *"no test covers this."*
   Filing the latter is a false finding against an implementer who did nothing wrong. The
   `scope-empty` guard does not catch this: `ran` counts skipped tests, so a scope of an
   all-skipped file reports a *green* narrow baseline and the mutant reads `SURVIVED`, not
   `ERROR (scope-empty)`. RATIONALE.md §5 lists today's gates and how to re-derive them.

4. **A build step the node suite needs belongs in `tests/run.mjs`, never in a `typecheck` script or the `npm test`
   gate (`tests/gate.mjs`).** A mutant's node row calls `tests/run.mjs` directly, so a step anywhere
   else would leave mutants judged against stale output.

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

- `baseline` is **three composite passes**: the baseline, then one canary per non-opt-in route
  (`node`, `vitest`); `playwright` is `SKIPPED`. The baseline runs `typecheck:node` and the node suite,
  then `typecheck:web` and the Vitest suite. RATIONALE §1 has the measured wall; a low-core host (Termux) is a multiple of
  it. It is not hung — `timeoutMs` in `config.json` is sized for the slow case.
- `--learn` with no refs falls back to the non-opt-in routes and never runs Playwright (a result
  where nothing failed reads `ERROR` `opt-in-not-run`); a Playwright spec enters only through a ref.
- A file-narrowed mutant is seconds, not minutes. **Always give every mutant an `expectFail`**: that
  is what buys the narrowing. Before the first `--learn`, the claimed killer's **file** alone
  (`tests/<file>.test.mjs`, no `::`) is a sufficient seed — it is read only as scope. Replace it
  with the observed ids from the learn pass before grading: a file-only ref in a graded run cannot
  match a failing test id.
- A mutant run's deadline derives from its narrow baseline, with a floor (`hang` in `config.json`).
  A mutant that breaks an awaited event can take tens of seconds to fail — that is not a hang.
  `TIMEOUT` means the run outlived the deadline in force: a real hang, or a correctly failing
  mutant whose chain of `waitFor` expiries is longer than that deadline. RATIONALE.md §7.1 lists
  the shapes; re-measure the second at whole-suite scope with `expectPass` listing every bare test file:
  `git ls-files ':(glob)tests/*.test.mjs' ':(glob)web/src/**/*.test.ts' ':(glob)web/src/**/*.test.tsx'`
  (the `:(glob)` magic keeps top-level `web/src/*.test.ts` files in). That scope runs
  the node and Vitest suites and no typecheck, and a survivor confirmed there is a survivor of the
  whole suite.

## Artifacts

- `harness/mutation/` — committed. The *how* persists.
- `.mutation/mutants.json` and `.mutation/results/` — gitignored, reviewer-owned, one review loop.
  **Never commit a catalog:** anchors are coupled to exact source text, so a committed one rots into
  stale-anchor `ERROR`s on invariants nobody is reviewing. The durable artifact is the *test*.

`run` and `probe` **hard-stop (exit 4)** if `.mutation/` is not gitignored. It is, via `.gitignore` →
`.mutation/`; verify with `git check-ignore -q .mutation/results/probe.json` — that exact probe path,
because a directory-only pattern reports "not ignored" while the directory doesn't exist yet.
