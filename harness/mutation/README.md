# Mutation harness — code-conductor

Project-local config for the shared [`code-mutant`](../../../code-mutant/) runner, so a reviewer can
mutation-prove coverage claims via `/code-mutant:prove`. This directory is **committed project
state**: `config.json` is the harness, `.mutation/` (gitignored) is the reviewer's scratch space.

The runner is a sibling project, not a dependency. Command syntax below is `mutate.mjs`'s own —
`node ../code-mutant/mutate.mjs --help` is authoritative if this drifts.

---

## Read these two first

### 1. Do NOT pass `--copy` on this project

`/code-mutant:prove` step 6 says "prefer `--copy`". **That does not apply here** — use the
configured default (`in-place`), or `--in-place` explicitly to override the habit. Two reasons:

- **A copy is not a git repository.** `code-mutant`'s `copyTree` excludes the top-level `.git`
  entry. In a code-conductor worktree `.git` is a *pointer file*, so the copy has no git linkage at
  all — and 11 test files shell out to `git`. This project *is* a git-orchestration app.
- **Copy mode silently defeats the store-isolation backstop.** `tests/safeStoreRoot.mjs` derives
  `REAL_STORE_DIR` **source-relative** (`<repo>/../.code-conductor`). Copy mode relocates the tree
  to `os.tmpdir()/code-mutant-run-*`, so that constant becomes `/tmp/.../.code-conductor` and
  `assertStoreIsolated` starts asserting against a path that is not the production store — a
  tautology. Nothing gets corrupted either way (`tests/run.mjs` pins `PROJECTS_ROOT` /
  `CLAUDE_PROJECTS_ROOT` to a fresh `mkdtemp` before any test file forks, and children inherit it),
  but the guarantee is only genuinely exercised in-place.

In-place restore is byte-snapshot replay plus a byte-identity check and a whole-tree `git status`
comparison, and the suite leaves no residue in the tree, so `assertNoTrace` holds.

### 2. `narrowTo: "names"` does NOT work here — leave narrowing at the default

The `node-test` adapter declares `canNameFilter: true` and substitutes
`--test-name-pattern '<regex>' 'tests/foo.test.mjs'`. But `tests/run.mjs` is **not** the
`node --test` CLI — it is a programmatic runner that treats *every* argument as a file path
(`process.argv.slice(2)`, each `path.resolve`d against cwd). The flag and the pattern are resolved as
filenames, so the scope runs the wrong files.

It degrades safely — the mutant reads `IMPRECISE` or `ERROR`, never a false `KILLED` or `SURVIVED` —
but it burns a review round on a non-finding. **Omit `narrowTo` from every mutant** and let it stay
at file granularity, which is the policy default anyway.

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

# Explore one mutation without a catalog entry (clean-tree gate only warns here)
node ../code-mutant/mutate.mjs probe \
  --file src/instances.js --anchor "some exact text" --replace "false" \
  --expect-fail 'tests/instances.test.mjs::the leaf test name'

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
| A file-narrowed mutant | ~0.5–3 s (`tests/health.test.mjs`: 9 tests, 0.5 s) |
| Test reference format | `tests/<name>.test.mjs::<leaf test name>`, repo-relative, exactly as the spec reporter prints it |

Narrowing is worth ~70× here, so always give every mutant an `expectFail`.

Runtimes scale with core count: `tests/run.mjs` runs files at `min(4, cores/2)` concurrency
(`TEST_CONCURRENCY` overrides). On a low-core host (Termux) expect multiples of the above — which is
what `timeoutMs` below is sized for.

## Config

| Field | Value | Why |
|---|---|---|
| `baselineCommand` | `npm test` | The project's real entry point (`package.json` script, README quick start). Using the script rather than its expansion keeps `NODE_OPTIONS=--max-old-space-size=512` defined in one place. |
| `testCommand` | `npm test -- {tests}` | `npm test -- <files>` forwards positionals to `tests/run.mjs`, which accepts a list of file paths. The adapter substitutes space-joined single-quoted repo-relative paths. |
| `runner` | `node-test` | `tests/run.mjs` is bespoke but pipes through `new spec()` from `node:test/reporters` — the same reporter the adapter is pinned to. Counters (`ℹ tests/pass/fail/skipped`) land on stdout; the `✖ failing tests:` block carries `test at <repo-relative path>`, because the spec reporter emits `relative(process.cwd(), file)` and the runner resolves its args against the same cwd. A full green run trips none of the adapter's `compileError` probes. Proven here by the `baseline` canary gate. |
| `isolation` | `in-place` | See "Do NOT pass `--copy`" above. Also: the suite boots real express+ws servers on ephemeral ports and forks child processes. |
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
