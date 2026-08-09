# Plan-path handover — 2026-0074

> Destination: `plans/plan-path-handover.md` in worktree `code-conductor_worktree_7bf9b4`
> (branch `code-conductor/7bf9b4`, base `main@dccbd19`). Plan mode restricts writes to the
> harness plan file, so this content lands at the final path on approval.

## Context

A worker can leave plan mode three ways. The MCP read surface — `get_recent_messages` and the
folded idle wake that reuses it — only serves two of them.

`src/mcp/messageReconstruction.ts` derives everything it knows about a plan from the
`ExitPlanMode` **tool_use input** (`:229-237` on the delta path, `:271-279` on the reconciled
`assistant_message` path). When the worker wrote its plan to `~/.claude/plans/<name>.md` and
called `ExitPlanMode` with `{}`, that input is empty: no `plan`, no path. The block falls
through as an unhoisted raw tool_use, so `m.plan` is unset, `hasPlan` is absent, and
`hasPlanOrQuestions` is false — which also means `bondTrailingTurn` never bonds the plan
message to the turn's trailing prose. The conductor's wake carries the worker's closing
sentence and nothing else.

The server already knows the path. `src/instances.ts:1817-1835` tracks the last `Write` to
`/.claude/plans/*.md` in `_lastPlanFilePath` and, on a plan-less `plan_request`, stamps
`ev.planPath` and reads the file into `ev.plan`. That enrichment reaches the browser
(`public/blocks.js:838` renders `saved to <path>`) and stops there. The two mechanisms never
meet: `reconstructMessages` filters its event scan to `text_delta | text_end |
assistant_message | tool_use` (`:90-91`), so `plan_request` is invisible to it, and the
`input.planFilePath ?? input.planPath` fallback it reads instead is written by **nothing** in
the repo — `grep -rn planFilePath src/ public/ tests/` hits only those two lines. A second,
never-exercised derivation of a fact that already has an owner.

The consequence lands in the `split` playbook, whose `implement` stage tells the conductor to
hand a fresh implementer the approved plan itself, never a paraphrase. In this branch it can
do neither: no text, no path. It paraphrases (violating the instruction) or declares itself
blocked.

Intended outcome: **the conductor receives a path whenever a plan file demonstrably backs the
plan it is looking at, live and after ring eviction** — with prose as the correct answer, not a
compromise, when no such file exists.

---

## The corroboration asymmetry — read before touching the tracker

Branches 1 and 3 get different rules, and the difference is **not** tidiness debt. It is a
difference in the evidence each branch makes available:

- **Branch 3 (empty input).** The server reads the remembered file and presents its contents
  *as the plan*. Path and text are cross-checked by construction: the text the conductor sees
  came from that very file, so the path cannot be stale relative to what it is reading.
  Session-scoped lookup is sound here. **Keep it exactly as it is today.**
- **Branch 1 (inline text).** The model supplied the plan text directly. Nothing ties
  `_lastPlanFilePath` — which is only "the last plan file written *this session*", never
  cleared on consumption — to *this* `ExitPlanMode`. A path attached here is an unverified
  guess.

Why the guess is worse than no path: `~/.claude/plans/` accumulates 20+ files from unrelated
runs, so a stale path does not 404 — it **silently resolves to another task's plan**, and a
fresh implementer with no context cannot detect it is building the wrong thing. This exact
failure mode was found and fixed once already during the epic that landed at `2926f47`
(card 2026-0071); reintroducing it session-scoped is the same hazard through a different door.

So branch 1 gets a **same-turn guard**: a path is attached only when a plan file was written in
the same turn as the `ExitPlanMode`. That honours the path-preference in every case that
actually occurs — the plan-mode harness writes the file during the planning turn — and where
the guard does not fire, **falling back to text is correct, not a shortfall**: no file was
demonstrably written for *this* plan, so there is no path to prefer. Do not engineer around
that fallback.

**This asymmetry belongs in a code comment on the tracker**, in roughly the terms above.

---

## What the conductor receives after the change

| Branch | Worker's `ExitPlanMode` | `get_recent_messages` meta | Body segment |
|---|---|---|---|
| **1 — inline text** | `input.plan` non-empty | `hasPlan: true`; `planPath` **only if** a plan file was written this same turn | `--- plan · saved to <path> ---\n<inline text>`, or `--- plan ---\n<inline text>` when the guard does not fire |
| **2 — explicit path in input** | `input.planFilePath` / `input.planPath` set | `hasPlan: true`, `planPath: <that path>` | `--- plan · saved to <path> ---` + the plan text if any |
| **3 — empty input, file written** | `input` empty; `~/.claude/plans/*.md` written earlier this session | `hasPlan: true`, `planPath: <remembered path>` | `--- plan · saved to <path> ---\n<file contents>` (header alone if the file is unreadable) |

In all three the message is now plan-bearing, so `bondTrailingTurn` pulls it in alongside the
turn's trailing prose on a default call — which is what puts it in the folded idle wake.

Branch 1 with no same-turn write keeps today's byte-exact body (`--- plan ---\n…`). The header
gains its suffix **only** when a path exists, so no existing assertion in
`tests/mcp-recent-bond.test.mjs` / `mcp-recent-async-envelopes.test.mjs` / `mcp.test.mjs` moves.

---

## Mechanism decision: push the enrichment through

**Chosen: push `planPath` through to the MCP read surface. Rejected: a parallel fallback in
`messageReconstruction`.**

1. The parallel fallback already exists and already rotted. `input.planFilePath ?? input.planPath`
   (`messageReconstruction.ts:235`, `:277`) is a second derivation that nothing feeds; it has
   shipped dead. That is direct evidence about which shape survives here.
2. `plan_request` is where the fact is already resolved, once, from the one component that has
   the `Write` history. A second derivation would need its own copy of the plan-file tracking
   and its own same-turn guard — two implementations of the corroboration rule above, which is
   exactly the single-source rule in `CONVENTIONS.md`.
3. Pushing it through fixes the disk path for free: `mergeRecentWithDisk` reconstructs from
   replayed events, so once `transcript.ts` derives `planPath` on replay, the merge inherits it
   with no extra code.

**`transcript.ts:227` gets fixed, not documented.** The `Write` line that created the plan file
is in the same jsonl, ahead of the `ExitPlanMode` line, and `loadPersistedTranscript` already
threads a mutable `blockCursor` through its per-line loop — a plan-file tracker threads
identically. A path-based handover that evaporates after ring eviction looks like it works,
which is worse than the defect it replaces. Fixing it also repairs a UI regression nobody filed:
today a plan card loses its `saved to …` line after any reload/respawn.

---

## Slice 1 — one plan-file tracker, shared by live and replay

### New file: `src/planFile.ts`

Owns plan-file detection, the remembered path, the turn binding, and the enrichment rule. Live
and replay both drive it; neither reimplements it.

```ts
// Plan files the model wrote this session, and the rule for binding one to an
// ExitPlanMode. Shared by the live stdout path (src/instances.ts) and jsonl
// replay (src/transcript.ts) so the two can't drift.
const PLAN_DIR_FRAGMENT = '/.claude/plans/';

// The path a tool_use wrote a plan file to, or null.
export function planFileFromToolUse(name: unknown, input: unknown): string | null;

export class PlanFileTracker {
  noteToolUse(name: unknown, input: unknown): void;  // latches the path; marks it written-this-turn
  noteTurnBoundary(): void;                          // clears ONLY the this-turn flag, not the path
  reset(): void;                                     // clears both (resume/respawn wipe)
  enrich(ev: UiEvent): void;                         // mutates a plan_request in place
}
```

`enrich` — the whole rule, and the home for the asymmetry comment:

```ts
enrich(ev) {
  if (ev.kind !== 'plan_request') return;
  if (ev.planPath) return;              // branch 2: the input named one; never override it
  if (!this.#last) return;
  if (ev.plan) {
    // Branch 1 — the model supplied the text, so nothing cross-checks the path.
    // Only a write in THIS turn binds the file to THIS plan; see the
    // corroboration note. A stale path resolves to another run's plan rather
    // than 404ing, so an unverified one is worse than none.
    if (this.#writtenThisTurn) ev.planPath = this.#last;
    return;
  }
  // Branch 3 — we present this file's contents AS the plan, so path and text
  // corroborate by construction and the session-scoped path is sound.
  ev.planPath = this.#last;
  try { ev.plan = readFileSync(this.#last, 'utf8'); }
  catch { /* best-effort — the path is still the deliverable */ }
}
```

Note `noteTurnBoundary` deliberately clears only the flag. Dropping the path at a turn boundary
would reintroduce the original defect for a reject → re-`ExitPlanMode` round that edits (rather
than rewrites) the plan file.

### `src/parser.ts:357-363` and `src/transcript.ts:222-229`

Both build the `plan_request` from the tool input. Give both the branch-2 read that currently
sits (dead) in `messageReconstruction`:

```ts
planPath: typeof input.planFilePath === 'string' && input.planFilePath
  ? input.planFilePath
  : typeof input.planPath === 'string' && input.planPath ? input.planPath : null,
```

This *moves* that fallback to the enrichment point rather than duplicating it — the two
`messageReconstruction` copies are deleted in Slice 2.

### `src/instances.ts`

- `:446` / `:613` — replace the `_lastPlanFilePath: string | null` field with
  `_planFiles: PlanFileTracker`.
- `:1817-1835` — collapse the inline `Write`-sniffing and enrichment to
  `this._planFiles.noteToolUse(ev.name, ev.input)` on `tool_use` and `this._planFiles.enrich(ev)`
  on `plan_request`. The enrichment must stay **above** the auto-approve block at `:1841` (that
  block reads the event after enrichment today) and above `this._emitUi(ev)` at `:1848`.
- `:1739` — in the existing `if (ev.kind === 'turn_end')` branch, call
  `this._planFiles.noteTurnBoundary()`. `plan_request` and `turn_end` are distinct events in the
  same per-event loop and `plan_request` arrives first, so a same-turn write is still latched
  when the plan is enriched.
- `:2559` (`_wipeForResume`) — `this._planFiles.reset()` in place of the field assignment.

**Deliberate non-change:** `noteToolUse` is fed every top-level `tool_use`, including sub-agent
ones (today's code has no `parentToolUseId` guard either). A sub-agent writing to
`~/.claude/plans/` is a theoretical staleness source with no observed instance; adding a guard
is a separate call, not this card's.

### `src/transcript.ts`

- `replayPersistedLine(obj, { seqHint, blockCursor, pendingSkillLoads, planFiles? })` — new
  optional collaborator, threaded exactly like `blockCursor`.
- Assistant `tool_use` branch (`:206-212`): `planFiles?.noteToolUse(name, b.input)`; for
  `ExitPlanMode`, build the event with the branch-2 `planPath` above, then `planFiles?.enrich(ev)`
  before pushing.
- Turn boundaries: the two sites that already call `attachSkillLoad` and are already commented as
  genuine turn boundaries — the `type:'user'` array-content branch (`:145`) and the
  `attachment`/`queued_command` branch (`:169`) — also call `planFiles?.noteTurnBoundary()`.
- `loadPersistedTranscript` (`:341`) constructs one `new PlanFileTracker()` beside `blockCursor`
  and passes it on every line.
- Do **not** thread it through `loadSubAgentTranscript` — a sub-agent's plan file is not the
  outer session's.
- `grep -n 'replayPersistedLine(' src/` and thread the tracker anywhere a whole file is replayed
  in order. Callers replaying a **single line in isolation** omit it, same as `blockCursor`; those
  keep today's branch-2-only behavior, which is not a regression.

`loadHistory` (`instances.ts:1232`) needs no change — it consumes `loadPersistedTranscript`'s
already-enriched events, which is what restores `saved to …` on the plan card after a reload.

---

## Slice 2 — surface `planPath` on the MCP read surface

### `src/mcp/messageReconstruction.ts`

- `ReconMessage` gains `planPath?: string`.
- `reconstructMessages` (`:82`): one pre-pass over the event array building
  `Map<toolUseId, planPath>` from every `plan_request` carrying a `planPath` (skip
  `parentToolUseId` events). `plan_request` has **no `msgId`** — the join key is `toolUseId`,
  which both the delta-path `tool_use` event and the reconciled envelope's `block.id` carry.
  Pass the map into `buildMessageFromRing`; leave the `:90-91` msgId-collection filter alone
  (`plan_request` is not a message-bearing kind and must not become one).
- `buildMessageFromRing` (`:229-237` and `:271-279`): delete both
  `input.planFilePath ?? input.planPath` reads. Resolve
  `const pathFromEvent = planPaths.get(ev.toolUseId)` (resp. `block.id`) and hoist when **either**
  the inline plan text or `pathFromEvent` is present, setting `plan` and/or `planPath` accordingly.
  A path with no text still hoists — otherwise an unreadable plan file leaves a bare tool_use
  block and the bond is lost again.
- `hasPlanOrQuestions` (`:146`): `!!m.plan || !!m.planPath || (questions…)`. This is what makes a
  path-only plan message bond.

### `src/mcp/handlers.ts`

- `renderMessageBody` (`:1459-1467`): emit the plan segment when `m.plan || m.planPath`; header is
  `--- plan · saved to ${m.planPath} ---` when a path exists, otherwise the unchanged
  `--- plan ---`; the text follows on the next line when present.
- Meta entry (`:1562`): `if (m.plan || m.planPath) entry.hasPlan = true;` and
  `if (m.planPath) entry.planPath = m.planPath;`.

No change to `buildRecentMessages`' selection logic — it inherits the fix through
`hasPlanOrQuestions`, and `idleSubscriptions.ts:456-460` inherits it through `buildRecentMessages`.

---

## Slice 3 — the `split.implement` wording

`playbooks/split.json`, `implement.description`. The conditional exists only because branch 3
made a path unobtainable; with a path reliably available whenever a file backs the plan, it is a
simplification, not a weakening. Under the live **"Push what nothing volunteers"** rule, the
`otherwise the plan text verbatim` half is cut: the wake either names a path or it does not, and
`never a paraphrase` already forecloses the only wrong reading of the no-path case.

Replace:

> A fresh worker, not the planner — it starts with no context, so hand it the approved plan itself, never a paraphrase: **pass the plan document's path when the plan wake named one, otherwise the plan text verbatim.** Put it on the planner's worktree: …

with:

> A fresh worker, not the planner — it starts with no context, so hand it the approved plan itself, never a paraphrase: **prefer the plan document's path the wake named.** Put it on the planner's worktree: one branch stays one merge unit, and it inherits the base the plan was written against. Retire the planner (`kill_instance`) once you have the plan — that clears the shared-worktree hazard before it exists.

Everything after the first clause is unchanged. This stays one line, narrates the conductor's own
move, and restates no `tools`/`needs`.

`tests/playbook-schema.test.mjs:76` gates description *presence*, not wording — it passes either
way, and no test can pin this. **Do not claim test coverage for Slice 3**; the gate is review.

---

## Slice 4 — docs

- `docs/protocol.md:106` — `plan_request`: state what `planPath` is (input-named path, else the
  session's last `~/.claude/plans/*.md` write; attached alongside an inline `plan` only when that
  write happened in the same turn) and that jsonl replay reproduces it.
- `docs/protocol.md:301` — add `planPath?` to the `get_recent_messages` meta row; note the body's
  `--- plan · saved to <path> ---` header form.
- `docs/protocol.md:324` — bonding paragraph: a message whose plan is a path with no text bonds too.
- `src/mcp/tools.ts:811-816, 827` — schema text; `hasPlan` currently reads "called ExitPlanMode
  with an **inline** plan", which the fix makes wrong. Add `planPath`.
- `docs/features.md:70` (plan-mode card bullet) — the `saved to …` line now survives reload/respawn.
- `docs/architecture.md` — short entry for `src/planFile.ts`: one tracker, two drivers (live stdout
  + jsonl replay), and the branch-1/branch-3 asymmetry with its reason.
- `README.md` — **no change** (no new top-level subsystem; per `CONVENTIONS.md`).

---

## Integration tests

Run: `npm test` (gated — runs the `pretest` typecheck).

### New: `tests/mcp-recent-plan-path.test.mjs`

Integration, styled on `tests/mcp-recent-bond.test.mjs` (one server per file, fresh projects root
per test, scenario injected via `FAKE_CLAUDE_SCENARIO`, `unwrapMessages` helper). Plan-file paths
are injected with the `FAKE_PLAN_FILE` env substitution `tests/plan.test.mjs` already uses.

New fixtures under `tests/fixtures/`: `scenario-exit-plan-file.json` (Write → `ExitPlanMode {}` →
trailing prose in a second message, mirroring `scenario-exit-plan-split.json`'s frame shape),
`scenario-exit-plan-file-inline.json` (Write → `ExitPlanMode {plan:"…"}`, same turn), and
`scenario-exit-plan-file-later-turn.json` (turn 1: Write + `ExitPlanMode {}`; turn 2:
`ExitPlanMode {plan:"…"}` with no write).

| Test | Invariant pinned |
|---|---|
| `empty-input ExitPlanMode surfaces the plan file's path` | `messages[0].planPath === <plan file>` and the body carries `saved to <path>` **and** the file's contents. Killed by reverting the `plan_request`→reconstruction join, by `enrich`'s branch-3 arm, or by the `renderMessageBody` header. |
| `empty-input ExitPlanMode bonds with the turn's trailing prose` | `messages.length === 2`, `messages[0].hasPlan === true`. **The regression test for the defect** — on today's code this returns 1 message with no plan. Killed by dropping the hoist-on-path or the `\|\| !!m.planPath` in `hasPlanOrQuestions`. |
| `unreadable plan file still yields a path and still bonds` | `FAKE_PLAN_FILE` points at a path the scenario never creates: `planPath` present, `hasPlan` true, body is the header with no content, `messages.length === 2`. Killed by making the hoist require plan text, or by `enrich` setting `planPath` only on a successful read. |
| `inline plan written the same turn also carries the path` | `planPath` present **and** body shows the inline text (not file contents). Killed by removing branch 1's guarded arm from `enrich`. |
| `inline plan in a later turn does not inherit the earlier turn's path` | `messages[0].planPath` absent, body has no `saved to`, body is byte-identical to today's. **The same-turn guard's proof** — killed by dropping `noteTurnBoundary`'s flag clear or by making branch 1 session-scoped. |

### New: `tests/transcript-plan-path.test.mjs`

Unit, on `loadPersistedTranscript` over a hand-written jsonl in a temp claude-projects root
(seeding style as in `tests/mcp-recent-disk.test.mjs`).

| Test | Invariant pinned |
|---|---|
| `replay derives planPath from the session's plan-file Write` | The replayed `plan_request` carries `planPath` = the written path and `plan` = the file's contents. Killed by restoring `planPath: null` at `transcript.ts:227` or by not threading the tracker through `loadPersistedTranscript`. |
| `replay does not attach a path to an inline plan from a later turn` | A `type:'user'` prompt line between the Write and an inline-plan `ExitPlanMode` ⇒ `planPath === null`. Killed by omitting `noteTurnBoundary()` from the replay user-line branch. |

### Extended: `tests/mcp-recent-disk.test.mjs`

| Test | Invariant pinned |
|---|---|
| `a disk-sourced plan message keeps its planPath` | Seed a jsonl with the Write + empty-input `ExitPlanMode`, force ring eviction, assert `source === 'disk'` **and** `messages[0].planPath` present. Pins the specific "path evaporates after ring eviction" failure the card calls worse than the status quo. |

### Extended: `tests/mcp-recent-turn-bond.test.mjs`

| Test | Invariant pinned |
|---|---|
| `bonds a plan message that carries only a path` | Pure unit: `bondTrailingTurn` over a `{msgId, text:'', planPath:'/p.md'}` message + trailing prose returns both. Direct, cheap mutation target for `hasPlanOrQuestions`. |

### Regression surface that must stay byte-identical

`tests/mcp-recent-bond.test.mjs` (10 `hasPlan` assertions, incl. `'--- plan ---\nStep 1\nStep 2'`),
`tests/mcp-recent-async-envelopes.test.mjs:104`, `tests/mcp.test.mjs:784,839`,
`tests/parser.test.mjs:300` and `tests/rendering.test.mjs:750` (`planPath: null`),
`tests/plan.test.mjs:57`. None of these scenarios writes a plan file, so no path attaches and no
body changes. **If any of them moves, stop and report — do not adjust the assertion.**

## Acceptance checks

1. `npm test` green, including the `pretest` typecheck.
2. `grep -rn 'planFilePath' src/` returns hits only in `src/parser.ts` and `src/transcript.ts`
   (the dead `messageReconstruction` copies are gone).
3. `grep -rn '_lastPlanFilePath' src/` returns nothing.
4. Reviewer mutation gate (`harness/mutation/`, runner in the sibling `code-mutant` project):
   `baseline` on a clean tree, then a `probe` per row of the tables above. Never pass `--copy`;
   never use `narrowTo: "names"`; no survivor filed in env-gated territory (`RUN_REAL_CLAUDE` &c.).
   Every mutant gets an `expectFail` — take the ids from `probe --json`'s
   `results[0].failedTests[0]`, don't hand-construct them.
