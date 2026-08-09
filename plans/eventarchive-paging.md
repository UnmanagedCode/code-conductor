# Event-archive paging seam — 2026-0037 / 0038 / 0039 / 0054

> Destination: `plans/eventarchive-paging.md` in worktree `code-conductor/618876`
> (base `main@d612939`). Plan-mode restricts writes to the harness plan file, so
> this content lands at the final path on approval.

## Context

Four cards sit in the `src/eventArchive.ts` backward-paging seam. They were filed
against `src/eventArchive.js`; that file is now TypeScript (TS migration
2026-0048/0049 landed after filing), so **every line number in every card is
stale**. All sites below were re-located and verified against the current file.

Everything asserted here was **observed in a run**, not derived by reading. The
repros are in "Evidence" per defect; each was driven through the real
`pageInstanceEvents` with a stub `InstanceLike` (the shape
`tests/events-endpoint.test.mjs:527` already uses) plus, where the archive is
needed, a real jsonl under a temp `CLAUDE_PROJECTS_ROOT`.

Baseline before any change: `node --test tests/events-endpoint.test.mjs` → 13/13 pass.

---

## Card-premise corrections (read before briefing anyone)

**1. 2026-0039 is not latent. Both halves reproduce today.** The card says the
state is "currently believed UNREACHABLE". That is false, and it is false in two
independent ways:

- The **cursor collapse** needs no archive-side headless group at all. It is
  reachable on the plain ring path and silently drops real, servable events
  (observed: 15 events in one repro, 7 in another).
- The **stall** (`hasMore === true` and `nextBefore === before`, i.e. a client
  that re-requests the identical cursor forever) reproduces at limits 2, 3, 4 and
  5 on an archive-side headless group.

The card's unreachability argument — "`loadSubAgentTranscript` always emits the
parent `tool_use` head on an earlier line than the children" — holds *within one
replay of a complete jsonl*, but the head and the children come from **different
jsonl lines**: the head from an `assistant` line's `tool_use` block, the children
from the later `user` line's `toolUseResult.agentId` fan-out
(`src/transcript.ts:379-397`). Nothing couples the two. Any jsonl carrying the
`tool_result` line without its `tool_use` line replays to an archive-side
headless group. Observed directly (see Evidence D).

Consequence: **do not take the "prove it unreachable and record the argument in a
comment" route.** It is not available — the state is reachable. It also would not
have been the right route even if the repro had failed: proving a behavioural
negative by inspection is exactly the class of claim that turned out false here,
and the only observation that could have settled it (an exhaustive search over
jsonl shapes the CLI can emit) is not something this repo can run.

**2. 2026-0054's "ALSO IN SCOPE" doc bullet is already done — drop it.** Commit
`1e33182` ("Strengthen the omitted-fromSeq assertion; fix gap-marker doc
wording", an ancestor of `main`) replaced "appended as the page's lone content"
with "appended after whatever the page does serve so the marker is never silently
dropped" in `docs/architecture.md:61`. The card's bullet is satisfied.

**However**, the same stale wording survives in the **source comment**:
`src/eventArchive.ts:242` still reads "append it as this page's lone content".
That is in scope for the 2026-0054 slice, which is rewriting that comment block
anyway.

**3. The carve-up is 3 slices, not 4.** 2026-0038 is a documentation decision
whose content is a restatement of the invariant 2026-0039's fix establishes. It
cannot be written correctly before 0039 lands, and it is three sentences after.
Splitting it into its own implementer briefing costs a full context load to
produce a paragraph. It is folded into slice 2. No card is dropped.

---

## 1. Actual mechanism of each defect

### 2026-0037 — archive-side head never reunites with ring-side children

**Site:** `src/eventArchive.ts:181-182`

```ts
const needArchive = tb > 0 && !!inst.sessionId
  && (before != null ? before - max < tb : (after ?? 0) < tb);
```

The predicate is purely arithmetic on the window's *seq extent*. When a backward
window sits entirely inside the ring (`before - max >= tb`), the archive is not
loaded, so `combined === ring` and `seamIdx === -1`
(`src/eventArchive.ts:184-198`).

A ring-side child whose owning `tool_use` head lives archive-side then has no head
anywhere in `combined[0, end)`. `groupBoundaryComponents`
(`src/parser.ts:733-782`) marks its interval `headless: true`, and
`snapStartToQuiescent` (`src/parser.ts:1019-1021`) takes the headless branch and
pushes `start` **past** the child rather than pulling back to a head it cannot
see. The children are excluded from that page — and from every page, because the
only page whose window covers them is the one just computed.

The comment at `src/eventArchive.ts:177-180` states the justification: "The
quiescent snap can never reach below the ring head from inside the ring." That is
true for *quiescence* and false for *group integrity* — group heads are resolved
across the whole loaded array, not bounded by the ring head. The comment is the
defect, restated.

**Evidence A (ring-only, no archive):** ring `_seq` 100–119, `trimmedBefore` 100,
`sessionId: null`, seqs 115–119 are children of a head that exists nowhere.
Paging backward from 120 at `limit 5`:

```
page 0 before=120 n=0 hasMore=true nextBefore=100
page 1 before=100 n=1 hasMore=false nextBefore=100
MISSING real seqs: 100..114     <- 15 servable events never served
```

**Evidence B (real archive, head archive-side):** jsonl of 5 turns replaying to 16
archive events with an `Agent` `tool_use` (`tu_A`) at flat index 8; ring
`_seq` 16–26 with children of `tu_A` at 22, 23, 24; `trimmedBefore` 16.

```
limit  3 → children served NONE, missing ring seqs 16,17,18,19,20,21,25
limit  5 → children served NONE, missing ring seqs 16,17,18,19,20,21,25
limit  7 → children served NONE, missing ring seqs 16,17,18,19,20,21,25
limit 10 → children served NONE, missing ring seqs 16,17,18,19,20,21,25
limit 12 → children served 22,23,24, missing none
```

Per-page trace at `limit 5`:

```
page 0 before=27 seqs=[26]                hasMore=true nextBefore=26
page 1 before=26 seqs=[]                  hasMore=true nextBefore=16   <- 0038 + 0039
page 2 before=16 seqs=[11,12,13,14,15]    hasMore=true nextBefore=11
page 3 before=11 seqs=[6,7,8,9,10]        hasMore=true nextBefore=6
page 4 before=6  seqs=[1,2,3,4,5]         hasMore=true nextBefore=1
page 5 before=1  seqs=[0]                 hasMore=false nextBefore=0
```

Page 1's window is ring indices 5–9 (`_seq` 21–25) and contains the three
`tu_A` children; `needArchive` is false (`26 - 5 = 21 >= 16`), the group reads
headless, and the page serves nothing. Note the damage is larger than the card
claims: `_seq` 16–21 and 25 are ordinary non-group events and are lost too —
that second loss is 2026-0039's site, not 0037's. The `limit 12` row is the
control: once `needArchive` happens to be true, everything is served.

### 2026-0038 — empty page with `hasMore: true`

**Site:** `src/eventArchive.ts:203-224` (`end`/`start` selection and the `hasMore`
disjunction).

When `snapStartToQuiescent` pushes `start` all the way to `end`, `events` is empty
while `hasMore = start > 0` is true. Reproduced as page 1 of Evidence B above and
as page 0 of Evidence A. Post-0037 the *cause* narrows: the archive-side-head
variant disappears (the head becomes visible and the snap pulls back instead), but
a **truly** headless group still produces it.

Truly-headless is production-reachable, not just a test construction: with a
mid-turn ring head the archive `cut` lands just after the anchor echo
(`src/eventArchive.ts:140`), so a `tool_use` emitted later in that same turn is
sliced away by `combined = archive.events.slice(0, archive.cut)`
(`src/eventArchive.ts:195`) while its ring-side children survive. That is the
same fixture family as 2026-0054. `tests/events-endpoint.test.mjs:444-449` already
pins the path as reached (`empties === 1`, asserted in both directions).

### 2026-0039 — empty-page cursor collapse and cursor stall

**Site:** `src/eventArchive.ts:231`

```ts
const nextBefore = events.length ? events[0]._seq as number : Math.max(0, Math.min(before ?? 0, tb));
```

Two distinct failures from one expression.

**(a) Collapse.** On an empty page with `before > tb`, `nextBefore` becomes `tb` —
the top of the archive — so every seq in `[tb, before)` is skipped, not just the
window the resolver rejected. Observed in Evidence A (15 events lost) and
Evidence B (7 events lost: `_seq` 16–21, 25, none of which belong to any group).
This is live today on `main`.

**(b) Stall.** When an empty page occurs with `before <= tb`, `Math.min(before, tb)`
is `before`, so `nextBefore === before` while `hasMore` is true. The client
re-requests the identical cursor forever. `before <= tb` forces `needArchive`
true, so this needs the headless component to sit **archive-side**.

**Evidence D (stall, reproduced):** a jsonl whose `user` line carries
`toolUseResult.agentId` (fanning out three sub-agent blocks tagged
`parentToolUseId: 'tu_X'`) with **no** preceding `assistant` line holding
`tool_use id: 'tu_X'`. `buildArchive` replays it to:

```
0 user_echo(ui=0)   1 text_delta   2 text_end
3 user_echo(ui=1)
4..9  text_delta/text_end   p=tu_X      <- archive-side HEADLESS component
10 tool_result tu=tu_X
11 user_echo(ui=2)  12 text_delta  13 text_end
14 user_echo(ui=3)  15 text_delta  16 text_end
```

Ring head = echo `userIndex 2`, `trimmedBefore` 11, `cut` 11. Paging backward:

```
--- limit 2
 page 3 before=10 seqs=[] hasMore=true nextBefore=10   !!! STALL
--- limit 3
 page 2 before=10 seqs=[] hasMore=true nextBefore=10   !!! STALL
--- limit 4
 page 2 before=10 seqs=[] hasMore=true nextBefore=10   !!! STALL
--- limit 5
 page 1 before=10 seqs=[] hasMore=true nextBefore=10   !!! STALL
```

Every limit tested stalls. The jsonl shape is hand-constructed and I have **not**
observed the CLI emitting one; what the repro establishes is that the guard is
`transcript.ts` line-ordering luck, not a structural invariant of
`pageInstanceEvents`, and that the failure mode when it breaks is a client
infinite loop.

### 2026-0054 — `history_gap` marker at the wrong seam

**Site:** `src/eventArchive.ts:243-247` (and its comment, `:233-242`)

```ts
if (gap) {
  const headIdx = events.length ? events.findIndex(ev => (ev._seq as number) === tb) : -1;
  if (headIdx !== -1) events.splice(headIdx, 0, { kind: 'history_gap' });
  else if (!hasMore) events.push({ kind: 'history_gap' });
}
```

The marker is anchored to the **ring head event** (`_seq === tb`) being present in
the served slice. But the seam is a *boundary between two pages*, and the page that
ends exactly at that boundary carries the last archive event, not the ring head.
Compounding it: `gap` is only computed when `needArchive` is true
(`:189-197`), and `needArchive` is false precisely on the pages that sit above the
seam — so the page that does carry the ring head is usually the one that does not
know a gap exists.

**Evidence C (card's repro, reproduced):** jsonl of 5 plain turns (archive flat
length 15, echo #4 at index 12); mid-turn ring head on the non-first turn
(`trimmedBefore` 13, ring `_seq` 13–21, no retained echo). `cut = 13`, `gap = true`.
`limit 7`:

```
page 0 before=22 [13,14,15,16,17,18,19,20,21]  hasMore=true  nextBefore=13
page 1 before=13 [6,7,8,9,10,11,12]            hasMore=true  nextBefore=6
page 2 before=6  [0,1,2,3,4,5,<<GAP>>]         hasMore=false nextBefore=0
```

- Page 0 carries the ring head (`_seq 13 === tb`) but `needArchive` is false
  (`22 - 7 = 15 >= 13`), so `gap` is false and no marker is considered.
- Page 1 ends exactly at the seam (`end === seamIdx === 13`) but `headIdx === -1`
  and `hasMore` is true → marker silently dropped.
- Page 2 is 6 real events plus the appended marker, ~13 seqs below the real
  boundary.

Exactly one marker, in the wrong place — the card's characterisation is accurate,
and the `else if (!hasMore)` append is load-bearing (its removal is mutant `mutG`,
killed by `tests/events-endpoint.test.mjs:185`), so it must not simply be deleted.

---

## 2. Slices

Three slices. Each is independently briefable; each touches `src/eventArchive.ts`
in a **disjoint region**, so a same-file conflict is the only reason they are
sequenced rather than parallel (slice 3 is logically independent of 1 and 2).

### Slice 1 — `needArchive` must trigger on headless children (closes 2026-0037)

**Scope.** Extend the backward-paging arm of `needArchive` so the archive is also
loaded when the tentative ring window contains a sub-agent child with no owning
head inside the ring.

**Files it may touch**
- `src/eventArchive.ts` — the `needArchive` computation (`:177-182`) and its
  now-wrong comment; hoisting the ring-side `end`/raw-`start` computation above it
  is expected.
- `src/parser.ts` — export one narrow predicate over `groupBoundaryComponents`,
  e.g. `hasHeadlessChildIn(arr, start, end): boolean`. Reuse the existing
  component builder (`:733-782`); do not write a second scan. Keep
  `snapStartToGroupBoundary`'s "NOT on the production path" comment (`:806-811`)
  accurate — the new export is the production one.
- `tests/events-endpoint.test.mjs` — one new test.
- `docs/architecture.md` (the `src/eventArchive.ts` bullet, line 61) — the archive
  is now loaded for a second reason; one clause.

**Must NOT touch**
- The `nextBefore` expression (`:231`) — slice 2 owns it.
- The `history_gap` block (`:243-247`) — slice 3 owns it.
- The forward (`after`) arm of `needArchive`. Forward paging intentionally
  bypasses isolated-page snapping; 2026-0037's acceptance says so explicitly.
- `tests/events-endpoint.test.mjs:372` assertions (see acceptance).

**Shape.** For the `before` branch, compute `ringEnd = firstIndexAtOrAbove(ring,
before)` and `ringStart = Math.max(0, ringEnd - max)` first, then

```ts
needArchive ||= tb > 0 && !!inst.sessionId && hasHeadlessChildIn(ring, ringStart, ringEnd);
```

Headlessness must be judged over `ring[0, ringEnd)` (matching what
`groupBoundaryComponents(arr, end)` does), so a child whose head sits in the ring
below `ringStart` correctly does **not** force a replay.

Loading the archive is not guaranteed to supply the head (a mid-turn `cut` can
have sliced it away). That is fine and intended: correctness first, one wasted
replay in the degenerate case.

**Tests + the invariant each pins**

| Test | Invariant pinned |
|---|---|
| New: `archive-side Agent head reunites with its ring-side children on one page` — Evidence B fixture (jsonl `Agent` `tool_use` archive-side, three children at `_seq` 22/23/24, `tb = 16`), `limit 5`; assert some single page's `events` contains **both** the `tool_use` with `toolUseId: 'tu_A'` and all three children | Mutating `needArchive` back to the arithmetic-only form makes the children unservable at any page → test dies. Choosing `limit 5` (well under the `limit 12` threshold where the arithmetic predicate happens to fire) is what decorrelates the fixture from the old behaviour; at `limit 12` the test would pass with or without the fix. |

**Acceptance checks**
- `node --test tests/events-endpoint.test.mjs` green.
- `tests/events-endpoint.test.mjs:372` (`archive/ring seam: overlapping groups
  page whole…`) passes with **its assertions unmodified**. Its
  `empties === 1` (`:448`) is a two-sided pin and the sharpest risk in this
  slice: loading the archive on the `GONE` window changes `combined`, hence `end`,
  `start` and the page boundaries. The expected outcome is unchanged (the `GONE`
  head is absent from the archive too, so the window still resolves to empty), but
  it must be **observed**, not assumed. If `empties` moves, stop and report — do
  not adjust the assertion.
  - Its comment block at `:456-465` ("this test keeps passing once the
    archive-reach limitation (2026-0037) is fixed") becomes stale prose. Updating
    that comment is in scope; changing any `assert` in that test is not, and is
    the stop signal 2026-0037's acceptance describes.
- `npm test` green (gated typecheck included).

### Slice 2 — empty-page cursor + the 0038 decision (closes 2026-0039 and 2026-0038)

**Scope.** Make an empty page's `nextBefore` skip **only the window the resolver
rejected**, instead of collapsing to `trimmedBefore`. Then document the
empty-page-with-`hasMore` behaviour that this makes safe.

**Files it may touch**
- `src/eventArchive.ts` — the `nextBefore` expression (`:231`) and the
  pre-snap `start` it needs.
- `docs/protocol.md` — the paging-mechanics paragraph (`:223`).
- `docs/architecture.md` — the `src/eventArchive.ts` cursor sentence (`:61`), if
  the protocol wording alone leaves it inconsistent.
- `tests/events-endpoint.test.mjs` — two new tests.

**Must NOT touch**
- `needArchive` (slice 1's site) or the `history_gap` block (slice 3's).
- The non-empty-page `nextBefore` (`events[0]._seq`) — already correct.
- The forward (`after`) branch's fallback. `before` is `null` there, so
  `before ?? 0` yields 0; keep that path byte-identical.

**Shape.** Keep the pre-snap window start (`rawStart = Math.max(0, end - max)`,
`src/eventArchive.ts:204`) in scope past the snap, and on an empty backward page
use `combined[rawStart]?._seq ?? 0`. Because `rawStart < end` whenever `end > 0`,
and `combined[end - 1]._seq < before`, this is **strictly** below `before` — the
stall is closed structurally, not by a special case. When `rawStart === 0` the
next page's `end` is 0, so it serves nothing with `hasMore` false and paging
terminates.

**Decision recorded (2026-0038): document-as-acceptable, do not change `end`
selection.** Argument:

- An empty page is the honest wire representation of "this window contained
  nothing renderable". The alternative — lowering `end` to the rejected
  component's left boundary and re-slicing — does not recover any event: the
  rejected events are headless children, unrenderable by design
  (`src/parser.ts:837-851`). It only saves one HTTP round-trip.
- With the cursor fix, the page after an empty one serves exactly the events the
  lowered-`end` variant would have served. Net client-visible content is
  identical; only the request count differs. Changing `end` selection buys a
  round-trip and costs a second, subtler notion of where a page ends — squarely
  against this repo's YAGNI rule.
- The guarantees that matter are already pinned by
  `tests/events-endpoint.test.mjs:428-449` (strict `nextBefore` progress,
  termination, never all-empty, per-page group integrity), and slice 2 adds the
  missing one (no seq skipped past the rejected window).
- The decision is only *safe* post-fix. On today's `main` an empty page can stall
  the client forever, and "acceptable protocol behaviour" would be false. This is
  why 0038 is folded into this slice rather than briefed separately.

Documentation to add in `docs/protocol.md:223`: a backward page may be **empty
while `hasMore` is true** (its whole window was sub-agent children with no
reachable head); `nextBefore` still moves strictly below the requested `before`,
skipping only that rejected window, so the client's next request resumes
immediately below it and paging terminates.

**Tests + the invariant each pins**

| Test | Invariant pinned |
|---|---|
| New: `empty page skips only the rejected window, not down to the ring head` — Evidence A fixture (`sessionId: null`, `tb = 100`, ring `_seq` 100–119 with 115–119 headless), `limit 5`, page backward to exhaustion; assert every non-child `_seq` in 100–114 is served | Reverting to `Math.min(before, tb)` drops all 15 → dies. Deliberately decorrelated: uses `sessionId: null` so no jsonl is involved and the assertion cannot be satisfied by an archive load — it can only be satisfied by the cursor arithmetic. Also asserts `nextBefore < before` on every page with `hasMore`. |
| New: `an empty archive-side page never returns nextBefore === before` — Evidence D fixture (jsonl with a `toolUseResult.agentId` line and no matching `tool_use` line, plus its `subagents/agent-ag1.jsonl`), parameterised over `limit` 2/3/4/5, page to exhaustion with a hard iteration cap; assert termination and `nextBefore !== before` whenever `hasMore` | This is the only test in the suite that reaches the archive-side-headless state. Reverting the fix hangs the loop at every one of the four limits → dies four times over. The fixture is also the standing record that the "unreachable" argument in 2026-0039 does not hold — it belongs in the tree, not in a comment. |

**Acceptance checks**
- Both new tests fail on `git stash` of the `nextBefore` change (verify, don't assume).
- `node --test tests/events-endpoint.test.mjs` green, `:372` seam test unmodified.
- No cursor state anywhere in the suite with `hasMore === true` and
  `nextBefore === before` (`pageResponses`/`pageAll` already throw on
  non-termination; the second new test asserts it directly).
- `npm test` green.

### Slice 3 — `history_gap` at the archive-cut/ring-head seam (closes 2026-0054)

**Scope.** Anchor the marker to the seam **index** rather than to the ring-head
event, and close the "the page that carries the head doesn't know there is a gap"
hole. Fix the stale source comment.

**Files it may touch**
- `src/eventArchive.ts` — the marker block (`:243-247`) and its comment
  (`:233-242`, including the "append it as this page's lone content" sentence at
  `:242`).
- `docs/architecture.md:61` and `docs/protocol.md:223` — both describe the
  marker's placement rule; both change together.
- `tests/events-endpoint.test.mjs` — one new test (the fixture the card's TEST GAP
  names).

**Must NOT touch**
- `needArchive` (slice 1) or `nextBefore` (slice 2).
- `buildArchive`'s `gap` computation (`:143-150`) — the four gap *causes* are
  correct and pinned by `tests/events-endpoint.test.mjs:491` and `:522`. This
  slice changes *where* the marker goes, not *when* `gap` is true.
- The `else if (!hasMore)` backstop must not simply be deleted (mutant `mutG`).

**Shape (confirm before implementing — the card says "confirm, don't assume").**
The seam's position inside `combined` is already computed: `seamIdx`
(`src/eventArchive.ts:196`), the archive `cut`. The served slice is
`combined.slice(start, end)`, so the seam falls inside the served events at
offset `seamIdx - start`. Splice there when that offset is in `[0,
events.length]`; keep the `!hasMore` append as the backstop for pages that never
reach the seam. Two details to resolve empirically, not by reading:

1. When `needArchive` is false the code leaves `seamIdx = -1` while `gap` can still
   be true via the no-`sessionId` branch (`:189`), where the seam is at combined
   index 0. Introduce a **separate** marker-anchor variable rather than changing
   `seamIdx` — `seamIdx` is also passed as `resetIdx` to `snapStartToQuiescent`
   (`:218`) and changing it changes snapping.
2. **Double-marker risk.** In Evidence C, page 1 would newly qualify for the splice
   while page 2 still satisfies `!hasMore` — two markers. The backstop must be
   narrowed to fire only when no page can carry the seam. Determine which existing
   test actually exercises the append branch (a temporary counter plus a run of
   `tests/events-endpoint.test.mjs:136` and `:185`, removed before commit) and
   narrow against that observation. Both existing gap tests assert
   `gaps.length === 1` over the reassembled stream, so a double marker fails the
   suite — that is the guard, and it must stay green.

Both existing gap assertions (`all[gi + 1]._seq === trimmedBefore`,
`tests/events-endpoint.test.mjs:171` and `:219`) remain satisfiable under the
seam-relative rule: in Evidence C the reassembled stream becomes
`[0..5][6..12, GAP][13..21]`, so the event after the marker is `_seq 13 === tb`.
That is a strictly better outcome than today's, from the same assertion.

**Tests + the invariant each pins**

| Test | Invariant pinned |
|---|---|
| New: `mid-turn ring head on a non-first turn: gap marker sits at the archive/ring seam` — the card's named missing fixture: 4 normal turns plus a giant 5th (mid-turn head, no retained echo), `limit 7` (below ring size). Assert (a) exactly one `history_gap` across all pages; (b) it is the **last** event of the page whose newest served `_seq` is the last archive seq — i.e. it lands at the `_seq 12 → _seq 13` boundary, not after `_seq 5`; (c) in the reassembled stream the event after the marker is `_seq === trimmedBefore` | Pins marker *position*, which is the whole defect. Today's code puts it after `_seq 5` on the terminal page, so the unfixed code fails (b) and (c). Assertion (a) kills the "splice everywhere" mutant; (b) kills "keep the terminal append as the only path"; and because the fixture has 5 turns, the assertion must be written against the **seam** boundary rather than a hard-coded page index — a page-index assertion would be satisfiable by an accidental off-by-one and would not survive mutation. Both `limit 7 < ring size` and the head being on a *non-first* turn are load-bearing; either relaxed and the fixture stops distinguishing. |

**Acceptance checks**
- The new test fails on unmodified `main` (run it before the fix — this is the
  fixture the card says nothing covers, so its pre-fix failure is the proof it
  covers something).
- `tests/events-endpoint.test.mjs:136` and `:185` (the two existing
  `gaps.length === 1` tests) stay green — no double marker, `mutG` still killed.
- The source comment at `:233-242` no longer claims "lone content" and describes
  the seam-anchored rule.
- `docs/architecture.md:61` and `docs/protocol.md:223` agree with each other and
  with the code.
- `npm test` green.

---

## 3. Ordering and cross-slice re-verification

```
Slice 1 (0037) ──▶ Slice 2 (0039 + 0038) ──▶ Slice 3 (0054)
```

**1 → 2.** Slice 1 changes the *population* of empty pages: the archive-side-head
variant disappears, only truly-headless windows remain. Slice 2 must therefore:
- Re-derive its fixtures against post-slice-1 behaviour. Evidence A
  (`sessionId: null`) is unaffected — no archive is reachable, so slice 1's
  predicate cannot change it. Evidence D **must be re-run**: its headless component
  is archive-side, and slice 1 may change which pages load the archive. Re-confirm
  the stall still reproduces pre-fix at all four limits before writing the fix; if
  slice 1 accidentally closed it, say so rather than shipping a test that passes
  vacuously.
- Re-check `tests/events-endpoint.test.mjs:448` (`empties === 1`) after its own
  change: slice 1 already stressed that assertion, slice 2 changes the cursor that
  produces those pages.

**2 → 3.** Slice 2 changes `nextBefore` on empty pages, which changes page
boundaries wherever an empty page occurs. Slice 3 must re-run Evidence C after
slice 2 lands: the marker's correct position is defined relative to page
boundaries, so if any page in that fixture becomes empty the "last event of the
seam-carrying page" assertion needs re-deriving. Expected: no change — Evidence C
has no sub-agent groups at all, so neither slice 1's predicate nor slice 2's
empty-page path fires in it, and all three pages are non-empty. **Expected, so
verify.**

**Slice 3 is logically independent** of 1 and 2 (different function of the same
file, no shared state) and could go first. It is sequenced last only because all
three edit `src/eventArchive.ts` and serialising avoids conflict resolution in a
file where every line is load-bearing.

**Nothing merges to `main` in this batch.** Each slice commits on
`code-conductor/618876`.

---

## 4. Decisions on the open cards

**2026-0038 → document-as-acceptable.** Argued in slice 2 above. In one line: the
alternative recovers no event, costs a second definition of "where a page ends",
and the round-trip it saves is not a problem anyone has. Conditional on 2026-0039
landing first — without it the behaviour being documented is not acceptable, it is
a client hang.

**2026-0039 → fix, and drop the "prove unreachable" route entirely.** Both halves
reproduce (Evidence A, B, D). The collapse loses real events on the plain ring
path today; the stall is a client infinite loop. The fix is a single expression at
`src/eventArchive.ts:231` and is strictly smaller than the comment the alternative
route would have required. The card should be updated to drop "latent" and
"currently believed UNREACHABLE" — the observation that settled it is Evidence D,
and it lands in the tree as a test rather than as prose.

---

## 5. 2026-0054's doc bullet

Already corrected on `main` by `1e33182` — `docs/architecture.md:61` now says
"appended after whatever the page does serve so the marker is never silently
dropped". **Drop the bullet as the card instructs.**

The stale wording does survive at `src/eventArchive.ts:242` ("append it as this
page's lone content"); slice 3 rewrites that comment block regardless. Separately,
`docs/protocol.md:223` describes the marker as "spliced before the first ring-side
event" and never mentions the terminal-page fallback at all — that is not the
card's bullet, but slice 3 is rewriting the placement rule and must bring that
sentence along.

---

## Candidate new cards (noted, not folded in)

- `docs/protocol.md:223` omits the terminal-page gap-marker fallback that
  `docs/architecture.md:61` documents — the two layers disagree on the marker
  rule. Slice 3 fixes it incidentally; if slice 3 is deferred, this stands alone.
- `docs/architecture.md:35` is a single ~1,400-word bullet for `src/instances.ts`.
  Per this repo's own "split a doc before its section sprawls" rule it is well past
  a screenful and wants promoting to `docs/` of its own.
- `groupBoundaryComponents` is recomputed twice per snap
  (`snapStartToQuiescent:1013` and again inside the `firstCombinedBoundary` /
  `lastCombinedBoundary` walks) and once more per page by slice 1's predicate.
  Correct, but a caching opportunity if paging cost ever shows up.
