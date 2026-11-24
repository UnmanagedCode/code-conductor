# Protocol: the FUSE-union policy event log

## The FUSE-union daemon's policy event log

A **file format with real readers**, which is why it is here and not only in [components/fuse.md](../components/fuse.md#srcsystemsfuse): the real gate's `R4` filters it, `runTeardown` harvests it, and an operator (or a Claude session) derives the pin list from it. `docs/components/fuse.md` → `src/systems/fuse/` carries the *why*; this is the contract.

**Two artifacts, one row shape plus provenance.**

| | path | row |
|---|---|---|
| per session | `<rundir>/events.log`, written by the daemon (`CC_UNION_EVENTS`, `policy_event` in `policy.h`) | `<kind>\t<op>\t<path>\t<reason>\t<pid>\t<tgid>\t<comm>\t<cmdline>` |
| store-wide | `orchStoreRoot()/systems/fuse/events.log` (`fuseEventStore()`) and its one rotated generation `…/events.log.1` (`fuseEventStoreRotated()`), appended by `runTeardown` immediately before the run directory is reclaimed | `<iso8601>\t<instanceId>\t<kind>\t<op>\t<path>\t<pid>\t<tgid>\t<comm>\t<cmdline>\t<suggested list>\t<suggested entry>` |

**A `#` HEADER LINE IS WRITTEN ONCE**, when the daemon opens the session log (`main()`), naming the columns and the sampling caveat. **It contains tabs**, so a parser that only tests for N non-empty fields will read it as a row: `parsePolicyEvents` (`session.ts`) and the real gate's `eventsOf` both skip lines beginning with `#`.

- **Deduped on `(path, reason, tgid)`**, never on the op and never on the kind, in the daemon and in the harvest — the two keys are the same by design, or the artifacts stop being comparable. **The tgid is load-bearing**: without it the first caller to reach a path wins the row and every later one is silently dropped, so the identity columns would answer *who asked* with *whoever happened to be first*. The kind is left out because it is a **function of the reason** (set-compared against both C sources in both directions by `tests/fuse-union-policy.test.mjs`), so on any emission the daemon can produce the two keys partition identically and that choice is **unobservable**. **What that costs, named:** a defect emitting one reason under *both* kinds would collapse to a single row rather than showing two — acceptable only because the one-kind-per-reason property is checked at the **call sites**, where it is decidable, and never inferred from a row count here.
- **The last two store columns are for `deny`/`unpinned-fail-closed` rows only** and are empty otherwise: a pin does not fix an `unmarked-host-served` row, whose path already came from the host. `suggestPin` (`src/systems/fuse/tierTable.ts`) is the mapping.
- **PATHS ONLY, never content.** A credential path may appear in either; a credential never does.
- **Size-capped, one rotated generation.** Before each harvest appends, a store already over `fuseEventStoreMaxBytes()` (`CC_FUSE_EVENTS_MAX_BYTES`, default `FUSE_EVENT_STORE_MAX_BYTES`) is renamed to `events.log.1`, overwriting the previous one.
  - Rotation only happens between whole harvests, so both files start and end on whole rows: no marker line, no header. The live file can go over the cap by one harvest's rows.
  - To read everything retained, read `events.log.1` then `events.log`; rows older than `.1` are gone. The store is still the only record that outlives a session.
  - Concurrent teardowns in one cc are serialised per path by `appendRotating` (`src/logRotation.ts`), and the projects-root lock means one cc per store. A restart handover's brief overlap of two servers is not serialised; its worst case is a lost `.1` generation, never a split row.
  - An invalid `CC_FUSE_EVENTS_MAX_BYTES` falls back to `FUSE_EVENT_STORE_MAX_BYTES` with a teardown note naming the variable; the rows are still stored.
  - Any other store write failure (mkdir, stat, rename, append) becomes the teardown note `the event store could not be written: …`. That teardown's rows are then missing from the store, but its report and stderr sentence still carry them.
- **Unstable by design**, like the rest of cc's surface: `enum ev_kind` and the reason set change with their callers.

### The identity columns

`pid` is the **calling thread** (`fuse_get_context()->pid`, measured to be a TID); `tgid` is its thread group — the id the mark, the resolution cache and the dedupe key are all on, and the id `CC_FUSE_TRACE` rows can be joined on. Both are logged because neither substitutes for the other. `comm` and `cmdline` are read from the **tgid**.

**IDENTITY IS SAMPLED AT POLICY TIME**, after the decision and after the dedupe — so the two /proc reads it costs, `comm` and `cmdline`, are paid once per **distinct row** rather than once per op. The `tgid` read is **not**: the dedupe key needs it, so it happens on every call — the same read `mark_of` and `policy_project_route` already make. Identity can never change an answer. `exec(2)` replaces `comm`, `cmdline` and `exe` while leaving pid, tgid and start time untouched, so **no validation can make the sample authoritative for the op that triggered it**: a row may name what the process *became*. The header line says so in the file.

**ESCAPING — `policy_escape` in `policy.h`, applied to `path`, `comm` and `cmdline`.** `op` and `reason` are C string literals and need none. A `/proc/<pid>/cmdline` is NUL-separated and a `bash -c` argv carries the whole script, newlines included, so an unescaped row is unparsable — which is what the escaping exists to prevent.

| input byte | output |
|---|---|
| `\` | `\\` — **handled first**, or the round trip collapses |
| `\t` `\n` `\r` | `\t` `\n` `\r` (two chars each) |
| `0x00` | `\0` — **and this is the argv separator** |
| other `< 0x20`, `0x7f` | `\xHH`, lowercase hex |
| `0x80`–`0xff` | verbatim (a UTF-8 path stays readable and still cannot break the parse) |
| everything else | verbatim |

`decodeEventField` (`src/systems/fuse/session.ts`) is the **only** inverse; `parsePolicyEvents` splits a decoded `cmdline` on `U+0000` into `argv`. The two implementations are cross-checked against real daemon output by `tests/fuse-union-policy.test.mjs`'s `argv-vectors` round trip.

**RECORDED ABSENCES.** The escaper never emits `\` followed by `!`, so `\!` is an unforgeable sentinel namespace. A missing identity is one of these, never a value:

| sentinel | meaning |
|---|---|
| `\!gone` | the `/proc` entry was not there — the process exited between the op and the sample |
| `\!unreadable` | it was there and could not be read (`EACCES`, `EPERM`, a racing reap) |
| `\!empty` | the read succeeded and returned zero bytes (a kernel thread, or a zombie) |
| `\!truncated` | a **suffix** on an otherwise-valid encoded field that hit the cap |

**`cmdline` IS CAPPED BY `POLICY_CMDLINE_MAX` (`policy.h`, 4096) — the BUFFER, so the field carries at most 4095 bytes.** A cmdline can reach `ARG_MAX`; a log row cannot. The reader takes `n - 1` so the result is also a C string; a read that fills the buffer gets the `\!truncated` suffix and keeps the bytes it did read, so a reader gets *argv-so-far, truncated* rather than a short argv it would read as complete. Round-trip is exact **up to 4095 bytes**, and truncation is never silent.

**A CMDLINE OF EXACTLY 4095 BYTES IS MARKED TRUNCATED EVEN WHEN IT IS COMPLETE**, and there is no way to tell the two apart: "the read filled the buffer" is the only signal `read(2)` gives, and the alternative — a 4096-byte read to disambiguate — would only move the same ambiguity one byte along. The marker therefore means *at least this much, possibly more*, never *exactly this much was lost*.

**READERS MUST READ THE FILE AS BYTES.** `0x80-0xff` passes through verbatim, so the log is not necessarily valid UTF-8 — a latin-1 filename or a binary argument puts a lone high byte in it, and a `utf8` read replaces it with U+FFFD before any column is formed. `parsePolicyEvents` documents `latin1` as its input contract, and `harvestEvents`, `Instance._awaitFuseMount` and the real gate all read that way; the store is appended as a `Buffer` for the same reason.

**EXACTLY TWO KINDS, and `R4`'s whole filter is `kind === 'deny'`** — a third would silently fall out of it and stop being checked at all. `enum ev_kind { EV_DENY = 0, EV_SERVED }`, rendered by `ev_kind_name`:

- `deny` — the op was **refused**; the caller has a negative errno.
- `served` — the op **succeeded**, but not the way the tier table said.

**EVERY REASON, WITH ITS KIND.** Derived from every `policy_event(` call site in `union.c` and `policy.h` and set-compared **in both directions** by `tests/fuse-union-policy.test.mjs`, so a new reason with no classification is a test failure rather than an unclassified row.

| reason | kind | emitted where, and what the caller got |
|---|---|---|
| `unpinned-fail-closed` | `deny` | `route()`'s fall-through, `-ENOENT`. **The MARKED CLI's alone** — an unmarked caller at `fail` is substituted to `host` before the switch |
| `unmarked-project-denied` | `deny` | `policy_project_route`'s mark check, `-ENOENT`. **UNREACHABLE, AND THE ROW IS KEPT ANYWAY.** An unmarked caller resolves in `VIEW_HOST`, where `tier_of` skips every `project` pin — so no unmarked resolution can produce `T_PROJECT` and `route()` cannot dispatch one to that function. The check is retained as defence in depth on the only path that sends a control frame, and this row is what an operator would see if a later edit ever reopened the route. The live mechanism is the view, where the invariant is structural |
| `control-unavailable` | `deny` | cc could not be reached, `-EIO` |
| `remote-absent` | `deny` | the remote does not have it, `-ENOENT` |
| `control-refused` | `deny` | cc would not carry it, `-EACCES` |
| `not-reconcilable` | `deny` | outside `DIRTY`'s domain (`mknod`, `link`, `chown`, a directory rename), `-EOPNOTSUPP` |
| `xdev-rename` | `deny` | the two routed ends are on different backing stores, `-EXDEV` |
| `dirty-push-refused` | `deny` | the reconcile could not land; the op returns cc's errno |
| `dirty-remove-refused` | `deny` | as above, for a removal |
| `self-recursion` | `served` | the daemon's own thread group at a project path — served from `policy_host_fd`, **returns 0**. A liveness precondition, not a routing policy |
| `pinned-children-truncated` | `served` | a `readdir` past `MAX_PINNED_CHILDREN`; the listing **succeeds** with a name dropped |
| `unmarked-host-served` | `served` | an unmarked caller was routed to the host at an unpinned path. Fires on the **substitution**, whatever the host read then does — the host's own ENOENT is not a policy event and `route()` cannot know it. ~20 per shell startup. **It is also the row a `project`- or `synth`-tier path writes**, because both re-resolve in `VIEW_HOST` and land on this same rule rather than on a substitution of their own |

**TWO REASONS ARE RETIRED, and the deletions are the point rather than an omission.** `unmarked-project-host-served` existed because the `project` tier had a substitution rule of its own, gated on a host-existence probe; `cwd-traversal-served` recorded a grant by the cwd-chain exemption. Both mechanisms are gone — a project-tier path re-resolves in `VIEW_HOST` and writes `unmarked-host-served`, and a cwd component is answered by the orchestrator's own directory (same row) or by the overlay node (no row, because nothing was substituted). The set is derived from every `policy_event(` call site and compared **both ways** against `EVENT_KINDS` in `tests/fuse-union-policy.test.mjs`, so re-adding either reason means re-adding a mechanism.
