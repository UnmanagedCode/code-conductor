# Mutation harness — rationale

This file holds the *why* behind `harness/mutation/config.json` and the three rules in
[README.md](README.md): the reasoning, measured evidence, and re-derivation recipes an agent does
not need to run a pass. **README.md is the operational doc** — read that first for how to run this
harness; come here only when you need to change `config.json`, question one of its three rules, or
suspect a verdict is a harness artefact rather than a coverage finding.

Optimized for retrieval, not token economy: exact paths with line numbers, exact commands, exact
numbers with the conditions that produced them. Do not re-cite a number below without its
conditions.

---

### §1 Measurement conditions (state once, referenced by every number below)

- Host: `nproc` 16; 30.8 GiB RAM with ~16–17 GiB already in use by unrelated processes;
  ~5.8 GiB swap in use before any run and unmoved by every run; `/proc/loadavg` `3.71 4.19 4.42` at
  start — **the host was not idle**.
- `node` v24.18.0, `git` 2.55.0. `node_modules` is a symlink to the primary checkout
  (`/workspaces/cc-projects/code-conductor/node_modules`). Tree clean at every gate; 7.2 MB
  excluding `.git`/`node_modules`, 518 tracked files.
- Suite at measurement time: `npm test` exit 0, **2616 tests / 2603 pass / 0 fail / 13 skipped**,
  node's own `duration_ms 56777` — i.e. **~57 s**, not the ~41 s the old README claimed. The
  difference is host load, not a suite change. Re-run while writing this doc (2026-08-12, a
  differently-loaded host): `2616 / 2603 / 0 fail / 13 skipped` again, `duration_ms 54744` (~55 s) —
  same counts, different wall clock, which is exactly the point: the counts are the suite's,
  the wall clock is the host's. A reviewer's own re-run measured `duration_ms 55913` (~56 s),
  confirming the figure.
- Catalog under test: **10 mutants across 10 distinct source files** (deliberately, so Phase A pays
  10 distinct narrow baselines), 9 expected `KILLED` + 1 deliberate `SURVIVED`. Measured
  2026-08-12 on branch `code-conductor/mutation-copy-bench` (bench scripts and raw artifacts were
  not merged and may no longer exist — see §9).
- **Do not re-cite any number below without these conditions**, and specifically not for a catalog
  with a different files-to-mutants ratio; §6 explains why that ratio is the dominant variable.

### §2 Why `isolation: in-place`, correctly stated

Lead with the conclusion: **keep `in-place`; never pass `--copy`.**

**§2.1 What actually breaks, and how little of it.**
- `code-mutant/lib/workspace.mjs:46` — `copyTree`'s `excluded` set contains `.git`
  **unconditionally**, for a plain clone exactly as much as for a worktree. *The old README's
  reasoning — that a cc worktree's `.git` is a pointer file — was wrong.* The exclusion fires either
  way; the pointer file matters only to the shape of a fix (§9). Upstream says the same at
  `code-mutant/README.md` → "Isolation modes": "for a worktree and an ordinary clone alike".
- Blast radius, audited: **22 of 226 `tests/*.test.mjs` files name the `git` binary**, as of
  `acfad1d`:
  ```bash
  ls tests/*.test.mjs | wc -l                                # 226
  rg -l -e "'git'" -e '"git"' tests/*.test.mjs | wc -l        # 22
  ```
  **All 22 build their own throwaway repo and target it explicitly** (`git -C <tmpdir>`, or the
  explicit-`cwd` helper at `tests/list-sessions-grouping.test.mjs:40`) — verified: no git invocation
  in `tests/` runs against the checkout's own root.
- **Exactly one assertion needs the tree it runs in to be a repo:**
  `tests/plugins-supervisor.test.mjs:165` — `assert.match(rec.gitHead, /^[0-9a-f]{40}$/)`, reaching
  git via `src/plugins/supervisor.ts:215` `headSha()` (`git -C <cwd> rev-parse HEAD` at `:217`, null
  on any failure). Note the contrast that proves the audit: `tests/plugins-registry.test.mjs:154`
  asserts `gitHead === null` for a non-repo temp dir, and `tests/worktrees.test.mjs`'s `merge-base`
  (`:309`) / `symbolic-ref` (`:67`) / `git status --porcelain` calls all run against repos the test
  built.
- **No cc test compares against a specific real sha, a real branch name, a tag, or real history.**
  This is why nothing *fails* under copy mode once a repo exists — and why nothing would *notice*
  the fabrication in §2.2.
- History, so nobody re-inflates this: cc commit `0a94b4e` ("Drop the unverifiable '11 test files
  shell out to git' claim") already cut an unverifiable count as a grep artifact.

**§2.2 Copy mode runs green here — and that is the problem.**
- It is reachable with **no harness change beyond one `setup` hook** doing an idempotent `git init`
  in the copy. `code-mutant/lib/measure.mjs` runs `setup` with `cwd: workspace.root` before every
  measured command, so the first command in a copy creates the repo and later ones short-circuit on
  `git rev-parse --git-dir`; in-place it is a no-op because a worktree pointer file resolves fine:
  ```json
  "setup": "git rev-parse --git-dir >/dev/null 2>&1 || (git init -q -b main && git -c user.email=bench@local -c user.name=bench add -A && git -c user.email=bench@local -c user.name=bench commit -qm mutation-copy)"
  ```
- Result: `node ../code-mutant/mutate.mjs baseline --copy` → **exit 0**, all gates green —
  clean-tree passed, baseline **2603 passed / 0 failed / 13 skipped / 2616 ran** (*byte-identical to
  the in-place run*, which is the evidence no test silently skipped itself in the copy), canary
  `KILLED` via `tests/account-overage.test.mjs`, `noTrace` ok with `residue: []`. Copy cost is
  negligible: **62 ms** for one workspace (7.2 MB), 167 ms for four; `copyTree` uses
  `dereference: false`, so `node_modules` stays a shared symlink.
- Record the superseded observation as history: *before* the setup hook, `baseline --copy` failed the
  baseline gate with process exit 2 and zero mutants run — which is what the old README documented.
  The gate failure was real; "copy mode cannot run here" was not.
- **The three assertions that go green while measuring the wrong thing.** This is the actual reason
  to stay in-place:
  1. `tests/plugins-supervisor.test.mjs:165` matches on *shape* (40 hex chars), so it passes against
     the synthetic commit's sha `487dee682c4f9ac0ef1ddbff886c92317ea00521` — a sha that exists
     nowhere in cc's history (the real worktree HEAD at measurement was
     `dd01a42122dfd59a8766fdb33d63ebdd54d0e0b7`). The copy also claims branch `main` while the real
     worktree was on `code-conductor/mutation-copy-bench`. Green for the wrong reason.
  2. `tests/store-isolation.test.mjs` — asserts the resolved store is not inside `REAL_STORE_DIR` and
     that `assertStoreIsolated(REAL_STORE_DIR)` throws. Root cause of the inversion:
     `tests/safeStoreRoot.mjs:30` derives `repoRoot` from `import.meta.url`, so `REAL_STORE_DIR`
     (`:32`) is `/workspaces/cc-projects/.code-conductor` in the real tree but `/tmp/.code-conductor`
     in a copy. Both assertions then hold against a path nothing writes — and worse, in the copy
     `assertStoreIsolated` **would not trip on the genuine production store**. The backstop is
     *inverted while reading green*, including the run-level check at `tests/run.mjs:30`
     (`assertStoreIsolated(orchStoreRoot())`).
  3. `tests/safeStoreRoot.test.mjs:24` — `assertSafeTestRunRoot refuses a real, non-temp path`
     passes `repoRoot`, which **is** under `os.tmpdir()` in a copy. It still refuses, but via the
     wrong-shape-directory branch, not the not-a-temp-path branch its name claims.
- Correct the old README's temp-path detail while here: the relocation prefix is
  **`code-mutant-w0-`**, not `code-mutant-run-*` — `code-mutant/lib/workspace.mjs:106`
  (`code-mutant-${label}-`) with `code-mutant/lib/runner.mjs:135` passing ``label: `w${i}` ``.
- Close with the scope of the harm: **no data is ever at risk** — `tests/run.mjs:21-22` pins
  `PROJECTS_ROOT`/`CLAUDE_PROJECTS_ROOT` to a fresh `mkdtemp` before any test file forks and every
  child inherits it. What is lost is *guarantee*, not safety. **The cost of copy mode here is
  honesty, not time.**

### §3 Why a nested test's ref is its `describe >` path

Keep the mechanism and the measured trap; the *procedure* for obtaining an id now lives in
`code-mutant/skills/prove/SKILL.md` step 5, not here.
- The `node-test` adapter reconstructs the full `describe > name` path from the spec reporter's
  inline failure block (`parseInlineFailurePaths`) and matches `expectFail` against **that**.
- The measured trap, same mutation, only the ref differing — reproduced verbatim because it is the
  thing that makes the failure mode recognisable:
  ```
  leaf-only ref   → IMPRECISE  reason: extra-failures
    unexpectedFailures: ["tests/backend-registry.test.mjs::resolveBackendLaunch (template-driven launch resolution) > {model} substitutes INSIDE a token, so --model={model} works too"]
    missingFailures:    ["tests/backend-registry.test.mjs::{model} substitutes INSIDE a token, so --model={model} works too"]

  full describe path → KILLED  (37 passed / 1 failed / 38 ran)
  ```
  The `IMPRECISE` detail reads *"the mutant is too broad, rewrite it smaller"* — advice that sends
  you to rewrite a mutant that was already correct. That is why the README makes it a rule.
- How to obtain ids: `run --all --learn` (added upstream in `f032689`; `SKILL.md` step 5 directs it)
  reports each mutant's observed failing set without grading. Fallback for a single mutation:
  `probe --learn --json` and read `results[0].failedTests` — bare `probe --json` with no
  `--expect-fail` refuses outright in counted mode (`mutate.mjs:413`); `--learn` is what lifts that
  refusal. Evidence it works: in the §1 catalog, all ten
  `expectFail` ids were filled from an observed `--learn` pass and **all ten matched the adapter's
  ids verbatim**.
- **A miss this doc's own drafting caught:** the README (and this file, before this pass) used to
  name "three files that use `describe`" — `backend-spawn`, `backend-registry`, `mcp-inspect-tools`
  — with "everything else is top-level" as the implied consequence. Re-derived at `acfad1d`
  (`rg -l '^describe\(' tests/*.test.mjs`), the real count is **eight**: those three plus
  `mcp-instance-order`, `model-versions`, `session-backends`, `mcp-text-render`, `spawn-effort`. The
  list had gone stale silently — nothing re-checks an enumeration like that — and "everything else is
  top-level" is precisely the false reassurance rule 1 exists to prevent: it would have sent an agent
  hand-constructing a leaf-only id against one of the five missing files, straight into the
  `IMPRECISE (extra-failures)` trap above. The fix is to never enumerate the files at all — check
  with the `rg` command above, which cannot go stale because it *is* the definition — which is why
  README rule 1 does not name any files.

### §4 Why `narrowTo: "names"` does not work here

- The `node-test` adapter declares `canNameFilter = true`
  (`code-mutant/lib/adapters/node-test.mjs:19`) and substitutes
  `--test-name-pattern '<regex>' 'tests/foo.test.mjs'`.
- But `tests/run.mjs` is **not** the `node --test` CLI. It is a programmatic runner that treats
  *every* argument as a file path — `tests/run.mjs:55-57`: `process.argv.slice(2)`, each
  `path.resolve`d against cwd. The flag and the pattern are resolved as filenames, so the scope runs
  the wrong files.
- **`validate` will not warn.** Its `narrow-downgraded` warning
  (`code-mutant/lib/validate.mjs:138`, documented at `code-mutant/mutants.schema.md:172`) fires only
  when the adapter cannot name-filter. Here the adapter claims it can and the project silently
  cannot, so the pre-flight is clean and the rule has to be written down instead.
- It degrades safely (`IMPRECISE`/`ERROR`, never a false `KILLED`/`SURVIVED`) — the cost is a wasted
  review round, not a wrong verdict.

### §5 The env-gate list, and how to re-derive it

The *rule* — env-gated opt-in tests are outside mutation proof — is in the README. This section is
the data and the derivation.

**§5.1 Snapshot of the gates — as of `acfad1d`, a starting point to re-derive, not a fact to trust.**
Re-derived at card 2026-0355 (`grep -rhoE "process\.env\.(RUN|SKIP)[A-Z_]+" tests/*.test.mjs |
sort -u`) → **six**, not the four this table listed: `RUN_FUSE_LIFECYCLE` and `RUN_DOCKER_SYSTEM`
were added after the snapshot. `RUN_CLI_CONTRACT` is a **seventh** and the grep above misses it —
it is read in `tests/cliContractCase.mjs`, a shared helper rather than a `*.test.mjs`, so re-derive
with `grep -rhoE "process\.env\.(RUN|SKIP)[A-Z_]+" tests/` to see it.

| Env flag | Surface left unproven |
|---|---|
| `RUN_REAL_CLAUDE` | real spawn + stream-json parsing, Bash tool call, AskUserQuestion, ask-mode PreToolUse hook (`smoke.real` 4); pruned-session resume + read-before-edit re-arm (`prune.real` 1); shell-env bundle restoring rg/find (`claudeShellEnv` 1); real `renew_session` backing-id rotation with a pinned public id (`renew-session` 1) |
| `RUN_REAL_OLLAMA` | `ollama launch claude … --version` forwarding claude's stdout/exit code (`claudeShellEnv`) |
| `RUN_PLAYWRIGHT` | real-browser UI behaviour, one test each — main-bar reset (`main-bar-reset-browser`), plugin app-switcher landing (`plugin-switch-browser`), plugin version-select width (`plugin-version-select-width`) |
| `RUN_TTS_INSTALL_TESTS` | Piper voice install flow and its 409-while-running guard (`settings-tts`). **Note the name:** the file reads this flag into a local const called `RUN_INSTALL`; `RUN_INSTALL` is not an env var. |
| `RUN_FUSE_LIFECYCLE` | the FUSE-union chroot END TO END — real `sudo -n unshare`, a real mount, a real chroot, and a second process inside the namespace (`fuse-lifecycle.real`). Needs passwordless sudo, `/dev/fuse`, `fusectl` and a working `gcc` + `libfuse3-dev`. **NARROWED at card 2026-0355 by the policy split**: `policy.h` includes no libfuse header, so `tests/fuse-union-policy.test.mjs` now proves the tier resolution, the ancestor derivation, the synthetic node, the marking policy, the resolution cache, the frame codec and the refusal log deterministically (see the capability row below). What is left here, and is genuinely only observable here: that the libfuse op bodies CALL the policy (R3); `route()`'s host arm and its no-fallback rule (R2); that `mount --bind` succeeds onto a synthetic node (R3); the socket transport itself and that a dead cc is REPORTED as an error rather than wedging the mount (R6). **`-EIO` on a dead cc is NOT in that set** — the driver's `b12` drives it deterministically through the injected transport. **And two claims no arm covers at all**, recorded rather than assigned to one: that `fuse_get_context()->pid` is a TID in practice (S1 §6 Q1's measurement is real; the instrument that produced it was deleted by ledger row D2), and that the marking event fires on the CLI's own first read of its binary (no longer load-bearing — `bootstrap.sh` fires it deliberately). `src/systems/fuse/PROVENANCE.md` → "The policy split" carries the same two-kind split at the source. |
| `RUN_DOCKER_SYSTEM` | the docker-backed `System` provider against a real daemon (`systems-docker`). Needs a docker socket. |
| `RUN_CLI_CONTRACT` | the real-`claude` CLI-behaviour contract cases (`systems-cli-*.real`), read through `tests/cliContractCase.mjs`. Deliberately left UNSET by `npm run gate:systems` — see its header for the pricing. |

### §5.1c A16's sha256 latch BLANKET-KILLS EVERY C MUTANT — scope C mutants narrowly

`src/systems/fuse/union.c.sha256` pins the digests of `union.c` and `policy.h`, and
`tests/fuse-lifecycle.test.mjs`'s **A16** asserts them. That latch is a **deliberate-edit
disclosure**, not behavioural coverage — and it fires for *any* byte changed in either file.

**Consequence for a prover:** a C mutant run at whole-suite scope is killed by A16 whatever it
did, so its failure set is attribution-free and a KILLED verdict says nothing about whether the
behaviour is covered. Measured on card 2026-0355: `abandon_claim`'s two mutants were killed
**only** by A16, and the function had no behavioural coverage anywhere, real-mount arms included.

**How to run C mutants so the verdict means something:**
- Scope every C mutant to the tests that should catch it (`expectFail`/`expectPass`), never the
  whole suite — `{tests}` derives from the mutant's own refs (§5.1a), so a narrow scope excludes
  A16 automatically.
- If A16 is in the failure set, treat the mutant as **unattributed** and re-run it narrower
  rather than recording KILLED.
- The deterministic home for a C behaviour is `tests/fuse-union-policy.test.mjs` — it drives
  `tests/fixtures/union-policy-driver.c` against `policy.h` with no mount, and its cases do not
  read the sha pin. A behaviour reachable only from `union.c` op bodies has no such home; that
  is why `policy.h` exists and why logic keeps moving into it.


### §5.1d Measured equivalences in the FUSE policy — do not re-derive these

**These four were authored, run and PROVED equivalent rather than assumed.** Each reads A16-only
(§5.1c) *by necessity*: it changes `policy.h` or `union.c` bytes, so the latch fires, and no
behavioural test can fire because there is no behaviour to catch. A future prover re-authoring them
burns a round to reach the same verdict, so the reasoning is recorded here — in a committed file,
because `.mutation/` is gitignored and does not survive a merge. The catalog entries carry the same
text in their `waivedNote`; **if the two ever disagree, this file is the record and the catalog is
the scratch copy.**

| mutant | mutation | why it is equivalent |
|---|---|---|
| `m-388-ct-rule-order-swap` | swap the two rules inside `policy_caller_tier` | The rules discriminate on **disjoint tier values** (`t == T_FAIL` vs `t == T_PROJECT && …`), so at most one can fire for any input and neither can shadow the other. Order is not load-bearing **here** — which was ALSO true of the ordering in `route()` until card 2026-0398 deleted `policy_cwd_exempt` — that ordering carried the traversal bound and is gone with it, so the source-shape assertion that pinned it is gone too. **The rules are no longer disjoint in the same way either**: `policy_caller_tier` now re-resolves for `T_PROJECT` *or* `T_SYNTH` and then falls into the `T_FAIL` rule, so the two `if`s are SEQUENTIAL rather than exclusive and swapping them is no longer equivalent — a swap would stop the re-resolution's `fail` answers reaching the substitution. Re-file this mutant before re-running it. |
| ~~`m-388-hh-drop-negfd`~~ | ~~delete `if (policy_host_fd < 0) return 0;` from `policy_host_has`~~ | **SUBJECT DELETED BY CARD 2026-0398.** `policy_host_has` is replaced by `policy_host_absent`, whose negative-fd answer is the OPPOSITE (`return 1`, "no host at all") and is pinned DIRECTLY by `b48` rather than through an `EBADF` fallback — `fstatat` on a negative dirfd fails `EBADF`, which `policy_host_absent` classifies as *not* an absence errno and so answers 0, the wrong way. Deleting the guard is therefore **killable now**, and the equivalence does not carry over. |
| `m-388-hh-raw-path` | `fstatat(policy_host_fd, path, …)` instead of `policy_rel(path)` | **EQUIVALENT ONLY UNDER A STANDING CONDITION, and the condition is the durable fact here:** `bootstrap.sh` hard-codes `CC_UNION_HOST_ROOT=/` (`bootstrap.sh:151`), so the host fd is always on `/` and a raw absolute path names the same object `policy_rel(path)` does. **If the host root ever becomes non-`/`, `policy_rel` becomes load-bearing and this mutant stops being equivalent** — it would then answer for a path on the whole host filesystem instead of one relative to the host root. Re-derive the verdict at that point rather than carrying it forward. The *distinct* mutant that drops `policy_rel`'s `"/" → "."` root special-case (`m-388-rel-root-case`) is **not** equivalent and **is** killed, by `b33` and `b36` **Carried across card 2026-0398 unchanged**: the probe was renamed and its polarity inverted, but it still opens `policy_host_fd` through `policy_rel`, and `policy_floor_mask` now makes the same call — so the standing condition covers two call sites, not one. |
| ~~`m-388-route-drop-notmarked`~~ | ~~delete `!marked &&` at `route()`'s `policy_cwd_exempt` call site~~ | **SUBJECT DELETED BY CARD 2026-0398** — see [README.md](README.md) → "Declared non-behavioural mutants". The call site and the exemption are both gone. |

**Why not just mark them `waived` and move on?** Because two of them are equivalent *for a stated
reason that can expire* — the host-root spelling for `m-388-hh-raw-path`, the agreement of the two
mark reads for `m-388-route-drop-notmarked` — and a bare "waived" loses the condition. A waiver
whose condition is not written down becomes an unexamined assumption the next round inherits.

**§5.1b The CAPABILITY gate, which is a different animal from an env flag.**

`tests/fuse-union-policy.test.mjs` compiles `tests/fixtures/union-policy-driver.c` and skips when it
cannot. It is NOT env-gated — nothing opts into it — so it runs by default on any host with a
toolchain, and a prover reading a `SURVIVED` from a mutant in `policy.h` or `union.c` must
**check the toolchain before filing it**: a silently skipped C test is indistinguishable from a
passing one.

| gate | exact detection | what a skip means |
|---|---|---|
| C toolchain | `detectToolchain()` in `src/systems/fuse/build.ts` — `gcc --version`, then `pkg-config --cflags fuse3` and `pkg-config --libs fuse3` | the PRODUCT could not have built the daemon either. It is the same function `ensureUnionBinary()` builds through, deliberately: a second, more permissive probe would let the test skip where the product would have compiled |

Confirm it in one line before filing:

```bash
gcc --version >/dev/null && pkg-config --exists fuse3 && echo "toolchain present — a C SURVIVED is real"
```

The file prints `fuse-union-policy: SKIPPED — no toolchain: <reason>` on stderr when it skips, and
the reason is `detectToolchain()`'s own.

Enabling any of them needs something a review environment does not have (the real
`claude`/`ollama` binary plus auth plus network; a Chromium install via the `code-playwright`
sibling; a network voice download), so the whole set is out of scope for mutation proof — report
such a claim as unprovable-by-this-harness rather than mutating it.

**§5.1a What `{tests}` resolves to, and it is NOT derived from the mutated file** (measured at card
2026-0355, `code-mutant` `lib/narrow.mjs` + `lib/adapters/node-test.mjs`). The scope comes from the
MUTANT's own declared `expectFail` ∪ `expectPass` refs, mapped through the adapter's
`scopeOf(ref) = splitRef(ref).file` — so it is **language-agnostic about the source**: a mutant in a
`.c` or `.h` file scopes exactly as a `.ts` one does, to the test files the author named, at file
granularity. There is no source→test mapping anywhere in the harness, so no `.h` file needs one.

Two consequences worth knowing before filing a verdict:
- A mutant that declares **neither** `expectFail` nor `expectPass` does not map to "nothing" and
  does not map to the whole suite: in counted mode `planNarrowing` **throws**
  (`cannot narrow without at least one entry in expectFail or expectPass`). Only `learn` mode falls
  back to `baselineCommand`, i.e. the whole `npm test`.
- `harness/mutation/config.json` therefore has **no scope list to maintain**. `tests/run.mjs`
  auto-discovers `tests/*.test.mjs`, so a new test file is inside `baselineCommand` the moment it
  exists, and inside `{tests}` the moment a mutant names it.

**§5.2 The recipe.** The skip count is host- and gate-dependent — re-derive it, don't trust a fixed
number (13 at measurement time, per §1):
```bash
# the env flags that gate tests today
grep -rhoE "process\.env\.(RUN|SKIP)[A-Z_]+" tests/*.test.mjs | sort -u
# every test skipped in a full run — matches `ℹ skipped`
npm test 2>&1 | grep '^﹣'
# attribute skips to one file
npm test -- tests/<file>.test.mjs 2>&1 | grep -E '^﹣|^ℹ skipped'
```

**§5.3 The two traps that produced a wrong count, plus the host caveat.**
- Grep the `﹣` glyph, **not** `# SKIP` — the spec reporter appends `# SKIP` only for boolean
  `skip: true`; `skip: '<reason>'` prints `# <reason>` (e.g. `# set RUN_TTS_INSTALL_TESTS=1 to run`),
  so grepping `# SKIP` undercounts silently.
- **Don't grep `skip:` in the sources** — the gates use three mechanisms
  (`test.skip.bind(test)`, `{ skip: <const holding the reason> }`, inline
  `{ skip: process.env.X !== '1' }`) and only the last is findable that way.
- A **host-capability** skip is a different thing from an env-flag gate and moves between hosts, so
  any count is host-specific: `mcp-inspect-tools`'s zsh-flavoured `project_bash` block skips only
  where `zsh` is absent, contributing 0 on the measured host (zsh 5.9 present) — which is why the
  count there equals exactly the four env flags.

### §6 Runtime structure, and why `--jobs` cannot pay here

The measured case against the other half of copy mode. All figures under §1's conditions unless
marked otherwise.

- **In-place control: 142299 ms** (`run --all --in-place --json`, jobs clamped to 1); a second
  in-place pass landed at 141670 ms, so ~142 s is stable for this host and is the number any
  speedup must beat.
- Means over 9 interleaved copy runs (order 1,2,4,1,2,4,1,2,4 so load drift spreads across
  configurations), wall / sd / Phase-B mean:
  | config | wall mean | wall sd | Phase B mean |
  |---|---|---|---|
  | copy, jobs=1 | 136754 ms | 5473 ms | 10867 ms |
  | copy, jobs=2 | 133594 ms | 3757 ms | 6539 ms |
  | copy, jobs=4 | 130328 ms | 458 ms | 4175 ms |
- **`jobs=4` vs `jobs=1`: 4.7% faster** (130.3 s vs 136.8 s). Phase B alone compresses cleanly
  (10867 → 6539 → 4175 ms; 2.60× at jobs=4, not 4×, because the pool's wall is its longest chain and
  the items are uneven — one mutant is 2.4–2.7 s of the ~10.3 s total).
- **The ceiling is 7.95%.** Phase A is **92.1%** of a `jobs=1` run and none of it parallelises:
  ```
  baseline (full suite)   ~58 s   ── serial, always
  canary   (2nd full suite) ~58 s ── serial, always
  10 narrow baselines     ~10.7 s ── serial on the primary workspace
                          -------
  Phase A                 ~126 s  = 92.1 % of wall
  Phase B (the pool)      ~10.9 s =  7.9 % of wall
  ```
  Two full-suite passes are **85%** of the run on their own. `10867 / 136754` = 7.95% at
  jobs=∞.
- **The win is smaller than the noise.** The jobs=1 wall spread was 131.4–142.3 s — an 11 s range,
  larger than the entire 6.4 s mean saving. On wall clock the effect is ~1.2 sd; it is unambiguous
  only in the load-insensitive Phase-B column.
- **The structural reason, which generalises past this catalog:** Phase A's narrow baselines
  (10.7 s) and Phase B at jobs=1 (10.9 s) are **the same ten commands run twice** — once unmutated
  on the primary workspace, once mutated in the pool. `--jobs` parallelises only the second pass, so
  it can at best halve the narrow-scope work. **More mutants across more files makes this worse:**
  each new *file* adds a serial Phase-A baseline. (Inferred from `code-mutant/lib/runner.mjs:214-218`
  vs `:225`, plus the measured 10.7 s / 10.9 s near-equality.) The arithmetic would only change if
  Phase B came to dominate — many mutants concentrated in *few* files — which is not the practice
  this harness is built for (a handful of mutants spread across the files under review).
- Note the trap in the copy-vs-in-place gap: copy at jobs=1 (136.8 s) is 3.9% under the in-place
  control (142.3 s), but that is **not** attributable to isolation — one copy run's Phase A (131.1 s)
  matches in-place's (131.2 s) exactly, and the spread inside the jobs=1 triplet exceeds the gap.
  Copy mode is not intrinsically faster; it pays 62 ms of `cpSync` instead of ms of snapshot/restore.
- **Per-file narrow-scope sample** — a sample, not a swept bound; files that wait on drains/timeouts
  sit at the top end. The bench-branch figures this section used to carry named a file,
  `resume-manifest`, that never existed in this suite (no `tests/resume-manifest.test.mjs` ever
  existed — `git log --all -- '*resume-manifest*'` returns nothing); the smallest real file by this
  measure is `tests/manifest.test.mjs`. Re-measured directly (2026-08-12, `npm test -- tests/<file>.
  test.mjs`, reading the runner's own `duration_ms`, host per this section's live session rather
  than §1's bench snapshot): `manifest` 0.34 s, `health` 0.75 s, `mcp-inspect-tools` 2.96 s,
  `instances` 3.48 s, `overage-action` 4.53 s. Same shape as the original claim (sub-second to
  ~4–5 s across the suite); do not re-cite these five numbers either without re-measuring — this
  section's whole point is that the bench-branch figures cannot be trusted without their source.
- Runtimes scale with core count: `tests/run.mjs:45-51` runs files at `min(4, cores/2)` concurrency
  (`TEST_CONCURRENCY` overrides), and `tests/run.mjs:107` sets a 60 s per-file ceiling. Note the
  consequence for reading the jobs numbers: a single run is **already 4-way concurrent** on 16 cores,
  so `--jobs 4` means up to 16 concurrent test files plus their forked children and bound ports.

### §7 `config.json`, field by field

`harness/mutation/config.json` is six field lines of strict JSON with no comment syntax — which is
the structural reason this section exists rather than living beside the values.

| Field | Value | Why |
|---|---|---|
| `baselineCommand` | `npm test` | The project's real entry point (`package.json` script, README quick start). Using the script rather than its expansion keeps `NODE_OPTIONS=--max-old-space-size=512` defined in one place. |
| `testCommand` | `npm test -- {tests}` | `npm test -- <files>` forwards positionals to `tests/run.mjs`, which accepts a list of file paths. The adapter substitutes space-joined single-quoted repo-relative paths. |
| `runner` | `node-test` | `tests/run.mjs` is bespoke but pipes through `new spec()` from `node:test/reporters` — the same reporter the adapter is pinned to. Counters (`ℹ tests/pass/fail/skipped`) land on stdout; the `✖ failing tests:` block carries `test at <repo-relative path>`, because the spec reporter emits `relative(process.cwd(), file)` and the runner resolves its args against the same cwd. A full green run trips none of the adapter's `compileError` probes. Proven here by the `baseline` canary gate. |
| `isolation` | `in-place` | Full reasoning in §2 above. The conclusion is decided-and-deferred, not infeasible: copy mode *works* here with one `setup` hook and costs ~5% of wall clock at best (§6) — it is rejected on honesty (§2.2's three green-for-the-wrong-reason assertions) and on the ≤8% ceiling (§6), not on feasibility. Also: the suite boots real express+ws servers on ephemeral ports and forks child processes. |
| `timeoutMs` | `300000` | Sized for the slow case, not the ~57 s (§1) full-suite baseline this host measures — a low-core/Termux host is a multiple of that, and applies to **every** measured command including the full-suite baseline itself. A baseline `TIMEOUT` is a gate failure that blocks the whole review, so this is a cap sized against the worst realistic host, not a wait against the typical one. `tests/run.mjs` has its own 60 s per-file ceiling (§6), so a hung mutant surfaces well inside the 300 s cap. |
| `baseBranch` | `main` | The real integration branch. Unset, `run`'s empty-diff-vs-base gate reports `not-established` and checks nothing — a branch with no committed work would read as a clean sweep. |

Defaults left alone: `preserve` (in-place copies nothing, and `node_modules` is already a symlink to
the primary checkout), `jobs` (clamped to 1 in-place regardless — see §6 for why chasing it wouldn't
pay even if it weren't), `setup`/`teardown` (nothing to build or reset in-place).

There is no `parse.mjs`: the shipped `node-test` adapter parses this suite's output correctly, and a
custom parser would have to reimplement its canary injection for no parsing gain.

### §8 Safety: what 10 runs showed about parallelism

Worth keeping because it is the part that came out well and stops the next investigation re-running
it: across all 10 runs (9 copy at jobs 1/2/4 + the in-place control), **identical verdict sets and
byte-identical `failedTests` sets per mutant**; 9 `KILLED` + 1 `SURVIVED`, exit 1 everywhere; zero
`ERROR`, zero `IMPRECISE`, zero `TIMEOUT`; `workspace-occupied` / `workspace-residue` /
`mutation-not-intact` never fired; `noTrace.ok` true in all 10 with `residue: []` in all 9 copy runs
and byte-identical in-place `git status --porcelain` before/after; `reproducible` true in all 10.
Per-mutant `durationMs` was flat across job levels, i.e. no measurable contention penalty. So
code-mutant's worker-ordinal fix (`694953a`) holds here and the documented
false-`SURVIVED`/false-`IMPRECISE` history did not reproduce. **Caveat:** jobs=4 means 4 copies ×
4-way internal file concurrency = 16 test files at once plus forked children and bound ports; this
was a 16-core / 30 GiB host and the result should not be extrapolated to a smaller one (Termux
especially). One jobs=4 run spiked to 45 runnable threads and still finished correctly; nothing
wedged, hung, or thrashed.

### §9 The deferred fix, and how to re-measure

- **The fix is understood and deliberately not built:** in `code-mutant`, replace the `.git`-less
  copy with `git clone --local --no-checkout` into the workspace, overlay the working tree with the
  existing `copyTree`, and `git read-tree HEAD` so the index matches — roughly 275–365 lines in
  code-mutant. This is where a cc worktree's `.git` **pointer file** actually matters (a `--local`
  clone of a worktree needs the resolved gitdir), which is the only correct use of that fact. It
  would give a copy real history and a real HEAD, removing §2.2's honesty cost. It buys ≤8% of wall
  clock (§6), so it is deferred: the price of copy mode here is honesty and a trust obligation, not
  time.
- **Provenance and re-measurement.** The measurements in §1/§6/§8 came from
  `harness/mutation/bench/` on branch `code-conductor/mutation-copy-bench`
  (`RESULTS.md`, `bench.mjs`, `phases.mjs`, `sweep.sh`, `mutants.json`), **not merged and possibly
  discarded** — this file is the surviving record. To redo it: a 10-mutant catalog spread across 10
  distinct source files, `run --all` under `{--copy --jobs N | --in-place} --json` with N
  interleaved 1,2,4, wall clock from `process.hrtime` (note `/usr/bin/time` and `bc` are absent on
  this host), and phase boundaries taken from the runner's own stderr progress lines timestamped by
  the wrapper. `code-mutant` itself was not modified for any of it.
