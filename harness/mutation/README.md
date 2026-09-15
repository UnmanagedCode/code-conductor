# Mutation harness — code-conductor

Project-local config for the shared [`code-mutant`](../../../code-mutant/) runner, so a reviewer can
mutation-prove coverage claims via `/code-mutant:prove`. `config.json` is committed project state;
`.mutation/` is the reviewer's gitignored scratch space. Command syntax below is `mutate.mjs`'s own —
`node ../code-mutant/mutate.mjs --help` is authoritative if this drifts.

**Open [RATIONALE.md](RATIONALE.md) only when you need the *why***: it holds the reasoning behind
`config.json`'s values, the measured case against copy mode and `--jobs`, and the recipe for
re-deriving the env-gate list when the flags change. Reach for it if you are about to change
`config.json`, disagree with one of the three rules below, or suspect a verdict is a harness
artefact rather than a coverage finding. You do not need it to run a pass.

## Run a pass

Runs from the repo root or any `code-conductor_worktree_*` — both are direct children of the
projects root, so the relative path resolves from either. The `code-mutant` runner is expected as a
SIBLING CHECKOUT of the projects root; where that root lives is environment-specific and is not
recorded here.

**Never pass `--copy`: this project runs `in-place`, and a copy cannot be trusted here.**

```bash
# 1. Gates. Nothing below is trustworthy until this is green AND the canary reads KILLED.
node ../code-mutant/mutate.mjs baseline

# 2. Diff hunks no catalog mutant covers yet. It lists; you target.
node ../code-mutant/mutate.mjs candidates --base main

# 3. Run the catalog you authored at .mutation/mutants.json
node ../code-mutant/mutate.mjs run --all
node ../code-mutant/mutate.mjs run --id <id> --id <id>

# Explore one mutation without a catalog entry (clean-tree gate only warns here).
# No real id yet? Add --learn --json and read results[0].failedTests — never hand-construct one.
node ../code-mutant/mutate.mjs probe \
  --file src/instances.ts --anchor "some exact text" --replace "false" \
  --expect-fail 'tests/instances.test.mjs::a top-level test name'

# Add --json to any of the above for the machine report.
```

`baseline` needs a **clean tree** (`git status --porcelain` empty) — mutation runs against committed
state.

## Three project-specific rules

1. **A test id is its full `describe > name` path, not its leaf name.** Top-level tests are
   `tests/<file>.test.mjs::<test name>`; a test inside a `describe(...)` is
   `tests/<file>.test.mjs::<describe name> > <test name>`, with the describe name reproduced
   verbatim, parentheses and all. **Never hand-construct an id** — take it from the observed set of
   the `--learn` pass. A leaf-only ref for a nested test does not fail loudly; it reads
   `IMPRECISE (extra-failures)` and advises you to rewrite a mutant that was already correct. To
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

## Declared non-behavioural mutants — waive, do not file

A mutant listed here **legitimately SURVIVES**. Each is a construct whose removal changes no
answer the suite (or any caller) can observe *under the stated condition*; they are declared by the
implementer at the time the construct lands, so anyone re-running mutants waives them instead of
re-discovering and re-filing them every round. State the waiver — and its condition — in the
round's report; do not silently drop it.

**No construct currently carries a declared waiver.** When one is added, give it a row here with
its condition, in the shape RATIONALE.md §5.1d uses.

And the standing one, which is not a construct but a test: **`A16`'s sha256 latch
(`tests/fuse-lifecycle.test.mjs`) is a deliberate-edit disclosure, not coverage.** A C mutant whose
only failing test is `A16` is **unattributed** — re-run it narrower rather than recording `KILLED`.
RATIONALE.md §5.1c has the measurement and the scoping recipe.

And its counterpart on the other side: **a mutation run cannot see the real gate's arms at all.**
It mutates source and re-runs the DEFAULT suite, where the four `tests/fuse-*.real.test.mjs` files'
arms self-skip — and an arm that never executes contributes neither a pass nor a kill. So a C mutant
reported as a survivor is a survivor *of the default suite*, not of the FUSE coverage as a whole.
Running the gate once before merge is the only thing that reads those arms:
`RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs` — measured 21.7 s of wall for the
family on a quiet 16-core box, the four files running concurrently.

## What to expect

- `baseline` is **two full-suite passes** (baseline + canary). On a 16-core host a full suite pass is
  ~1 min, so budget ~2 min; a low-core host (Termux) is a multiple of that. It is not hung —
  `timeoutMs` in `config.json` is sized for the slow case.
- A file-narrowed mutant is seconds, not minutes. **Always give every mutant an `expectFail`**: that
  is what buys the narrowing.

## Artifacts

- `harness/mutation/` — committed. The *how* persists.
- `.mutation/mutants.json` and `.mutation/results/` — gitignored, reviewer-owned, one review loop.
  **Never commit a catalog:** anchors are coupled to exact source text, so a committed one rots into
  stale-anchor `ERROR`s on invariants nobody is reviewing. The durable artifact is the *test*.

`run` and `probe` **hard-stop (exit 4)** if `.mutation/` is not gitignored. It is, via `.gitignore` →
`.mutation/`; verify with `git check-ignore -q .mutation/results/probe.json` — that exact probe path,
because a directory-only pattern reports "not ignored" while the directory doesn't exist yet.
