# The System provider protocol

The wire contract between code-conductor and a **provider** — a process cc
launches that gives it execution and file access on one System. This document is
complete: a conforming provider can be written from it alone — §1-§9 are the
wire contract, and §10 is the flag-and-environment surface the conformance
harness launches a provider with.

- Executable half of this spec: `src/systems/protocol.ts` (frame types, codec,
  taxonomy), shared by both ends.
- cc's side: `src/systems/providerSystem.ts` + `src/systems/providerConnection.ts`.
- Worked example: `src/systems/referenceProvider.ts` — the local machine over
  this protocol, ~400 lines, no cc-specific dependencies.
- **The definition of a valid provider is `tests/systems-protocol-conformance.test.mjs`.**
  If a claim here and that suite disagree, the suite is right.

A **System** is a remote *execution environment*, not a remote filesystem. cc's
own store, the Claude CLI and everything under `~/.claude/` stay on cc's host; a
System owns a project's tree, its git repo and shell commands run inside it.

## 1. Transport and framing

| | |
|---|---|
| Channel | cc launches the provider as a child process. cc → provider on the provider's **stdin**; provider → cc on its **stdout**. |
| Framing | **NDJSON** — one JSON object per line, UTF-8, `\n`-terminated. |
| stderr | **Diagnostics only. cc never parses it**; it keeps a bounded tail and quotes it when reporting that the provider died. |
| Binary payloads | base64 in a `dataB64` field (~33% overhead). |
| Blank lines | Ignored between frames. Not an error. |
| Line ceiling | `MAX_LINE_BYTES` = 4 MiB. A longer line is `EPROTO`. It is a framing fence, not a payload budget: one chunk frame is `CHUNK_BYTES × 4/3` plus a small envelope, an order of magnitude below it. |
| Payload validity | A `dataB64` on a `stdout`, `stderr` or `data` frame **MUST be canonical base64** (standard alphabet, correct padding, length a multiple of 4) and **MUST be present**. A payload is part of its frame, so an invalid one is `EPROTO` and fatal exactly as an unparseable line is — decoders in most languages stop at the first bad character and return the prefix, which would turn a corrupted chunk into a silently truncated success. |
| Chunk size | `CHUNK_BYTES` = 64 KiB of raw bytes per `data` frame, before base64. **Both ends MUST chunk at it** — a payload is not permitted to ride as one large frame. A 32 MiB read sent as a single frame breaches the line ceiling below and dies `EPROTO` mid-transfer. |
| Per-file cap | `MAX_FILE_BYTES` = 32 MiB. A read or write above it is `EFBIG`. |
| Paths | **Absolute, on the system.** cc never sends a relative path — **enforced client-side, on both implementations of `System`** (`requireAbsolute`, `src/systems/system.ts`, since the invariant is a property of cc's callers rather than of a transport): every path-taking operation, plus the `cwd` of `exec`, which is the one way a `cwd` reaches the wire. A relative path is cc's own bug, so it REJECTS with the operation named, never a returned refusal and never a frame a provider has to reject. |

Provider MUSTs:

1. Write **nothing but frames** to stdout.
2. Answer cc's `hello` with a `hello` **before any other frame**.
3. **Exit when stdin reaches EOF, taking everything it started with it.** This
   is the whole of provider lifecycle management on cc's side: cc closes the
   pipe (or dies) and the provider goes away. **A provider whose children are
   not its OS descendants must relay the kill itself** — a `docker exec` child
   is reparented inside the container and outlives the provider, so a docker
   provider has to SIGKILL its in-flight `docker exec` processes on exit. cc has
   no way to clean up after a provider that does not.
4. Interleave concurrent ids correctly (§4).
5. **Answer every operation it accepts, or refuse it.** Each `id` cc opens
   terminates in a frame for that `id` — `exit`, `readFileResult` + `end`,
   `writeFileResult`, `remoteDescriptor`, or an `error` frame from §8's
   taxonomy — unless cc ends it first with `close` or `detach`, after which the
   provider emits nothing for it (§5's rules). Accepting an operation and then
   answering nothing is a breach.

### Non-conformance is a provider defect

The MUSTs above are the contract. This section says what happens when one is
broken, because that boundary is easy to assume wrongly in both directions.

- **What cc guarantees.** An operation cc did not bound itself expires at
  `DEFAULT_OP_TIMEOUT_MS` (`src/systems/providerSystem.ts`; override
  `ORCH_OP_TIMEOUT_MS`, `docs/architecture.md`'s env table), and **the operation
  fails with a named code** — `{code:124, timedOut:true}` from an `exec`,
  `ETIMEDOUT` from `readFile` / `writeFile` / `describeRemote`. Expiry sends
  `close`, which is this protocol's instruction to kill the command; a provider
  that ignores `close` keeps running it, and cc cannot reap what it started
  (MUST 3). See *Backstop* in §5's rules for the deadlines cc arms and their
  scope.
- **What cc does NOT do.** Model, classify, retry, recover from, or gracefully
  degrade around a breach. cc's only stateful accommodation for a provider is
  the restart backoff for one that **dies** (`ProviderConnection`'s failure
  count and refusal window) — a provider that answers nothing never reaches it,
  because it has not died. Nothing is keyed on slowness, nothing trips on a
  timeout, and nothing remembers that an operation expired. The deadline is the
  whole of it: a liveness fence, so cc's own surfaces stay answerable.
- **Why the boundary is drawn here.** Implementing this protocol is the
  provider's job. Every mechanism cc could add to compensate would also make a
  broken provider look partly usable, which is how a wrong answer reaches a user
  instead of a refusal.
- **What a provider author should expect to see, and it is SPLIT.** For a
  provider that accepts operations and answers nothing:
  - **The project row discloses.** A timed-out git command is a `GIT_TIMED_OUT`
    refusal (504, `src/worktrees.ts`); the project listing **omits `isGitRepo`**
    — absent, never `false`, since "could not look" is not the claim "not a git
    repo" — and carries a `systemUnreachable` reason naming the system, and
    merge / sync convert it to their own returned refusals.
  - **The worktree listing and the session lookup SWALLOW it**, matching exactly
    what they do for a system that is simply unreachable: `listWorktrees`
    applies no git filter, so **every registration lists** (`src/worktrees.ts`),
    and `findSessionLocation` composes a place for each of those unfiltered
    registrations (`src/projects.ts`). Neither says anything.
  - So such a provider **can change what a worktree listing contains — and
    which places a session lookup probes — with nothing on either to say so.**
    That is a property a system that is DOWN already has, and cc does not
    distinguish the two: see *What cc does NOT do* above.

### The POSIX assumption

The target is a **competent POSIX environment with GNU coreutils**: `stat`,
`find` with `-printf` (plus POSIX `-path`/`-prune`, which the session-root walk
uses to skip an advertised exclude — not a new bar: `-printf` is the stricter
requirement, and a target that has it has these), `mkdir`, `rm`, `unlink`,
`realpath`, `chmod`, `base64`, `tr`, `printf`, `env`, and a POSIX login shell. This is what shrinks the
provider contract to **three** operations: everything else on cc's own `System`
interface (`src/systems/system.ts` — the members beyond `exec`, `readFile` and
`readFileBytes`/`writeFile`) is DERIVED by cc over `exec`, listed in §7. The
interface owns that count; nothing here restates it.

**Non-POSIX targets, and non-GNU coreutils, are out of scope.** cc ships no BSD
dialect: an untested second code path is worse than a refusal.

What §8's classifier actually matches is the **`strerror()` tail** (`No such
file or directory`, `Not a directory`, …), not a tool's prefix — the tested
surface is GNU coreutils 9.x plus both `find` families in use here, GNU
findutils (`find: '/p/.': Not a directory`) and `bfs` (`bfs: error: /p/.: Not a
directory.`). A `find` or `stat` that produces the POSIX message tails will
classify correctly whatever it calls itself; one that translates them will not,
which is what `LC_ALL=C` is for.

## 2. Handshake and capability negotiation

cc sends first:

```json
{"type":"hello","protocol":1,"client":"code-conductor"}
```

The provider answers exactly once:

```json
{"type":"hello","protocol":1,"provider":"docker-exec/0.1.0",
 "capabilities":{"processGroupSignal":true,"remotes":true}}
```

- `protocol` is an integer. **A mismatch is refused** (`EPROTO`) — cc speaks
  `PROTOCOL_VERSION`, currently `1`.
- `capabilities`: a **missing key is `false`**; an **unknown key is ignored**.
- **There is NO `system` descriptor.** The hello carried one — `os`, `pathSep`,
  `shell`, `home`, with `shell` REQUIRED and refused `EPROTO` when absent — and
  it is gone. `shell` was the only field cc ever acted on (it opened the
  long-lived shell) and there is no long-lived shell; the other three had **zero
  readers** even before that, so the claim that cc "reports the rest" was false
  when it was written. Send one anyway if you like: an unknown key is ignored.
  - **This records that nothing reads it today, NOT that cc has decided it never
    will.** A future consumer re-adds the field it needs and cc starts reading
    it; there is no compatibility cost either way, because a provider that
    already sends one is already ignored.
- **THE PROVIDER OWNS THE INTERPRETER, per target.** cc requires a POSIX shell
  and nothing more, and its framing (§5) does not care which one or whether it is
  a login shell — measured on Linux 6.17 / bash 5.2.37 / dash 0.5.12 as
  `/bin/sh`, under `bash -lc`, `bash -c`, `/bin/sh -c` and `/bin/sh`: identical
  `$?` propagation, identical `$PWD` capture, and the opening sentinel discarding
  whatever the interpreter printed before the script in every case. **Four
  interpreters on one host is the whole of the evidence** — nothing here has been
  measured on another OS, another libc, or a non-POSIX shell. So a provider whose targets need different
  shells simply uses different ones; nothing is negotiated and nothing needs to
  be. The one per-target fact cc DOES negotiate is the **mirror advertisement**
  (§2.1), which rides its own frame.
- **An unknown FIELD on a KNOWN frame is ignored too**, and this is stated
  separately because it is a third rule, not a restatement of the two above: cc
  reads the fields it knows off a frame and never rejects one for carrying more.
  It became load-bearing when the hello's `system` descriptor was deleted — every
  provider written before that still sends one, and each must connect unchanged
  rather than be refused for a field cc no longer reads.
  Pinned by `tests/systems-provider-supervision.test.mjs` (a provider still
  sending it connects) and `tests/systems-protocol-codec.test.mjs` (it survives
  decoding).
- Unknown *frame types* are likewise ignored by both ends. Unknown capability
  keys, unknown frame types and unknown fields are the extension point: **the
  contract can grow, and shrink, without a version bump.**

### Capability classification

Everything the protocol carries is in exactly one of these buckets. An optional
capability is only acceptable with all four of: a flag name, an absent-behaviour,
a user-visible difference, **and a test that runs the fallback**.

| Capability | Bucket | Absent-behaviour | User-visible difference | Fallback test |
|---|---|---|---|---|
| `exec`, `readFile`, `writeFile` | **1 — MUST** | Registration fails; there is no cc without them | — | — |
| **`processGroupSignal`** | **2 — OPTIONAL** | A `signal` frame reaches the **direct child only** | On a timeout or an interrupt, grandchildren may survive; every result cc or the provider terminated carries **`descendantsMaySurvive: true`** | `tests/systems-protocol-conformance.test.mjs` → "process-group signalling", run with `--no-process-group-signal` |
| **`remotes`** | **2 — OPTIONAL** | The endpoint serves exactly ONE target. A project that names a `remoteId` on it is refused `SYSTEM_NO_REMOTES` (501) at registration and at every resolution, and **the field is never put on the wire** | The Remote field is refused at create/change time with a message naming the system's provider. A project that names no remote is byte-identical to before the capability existed | ABSENT-behaviour: `tests/systems-remote-id.test.mjs` — the reference provider with no `--remote` flags: a project naming a remote refuses by name and no frame carries the field, one that names none is unchanged. Which is also the whole suite under configurations 2-3 of `npm run gate:systems`. PRESENT-behaviour: configuration 1 of that gate, whose provider carries `--remote` and whose `local` handle is bound to it, so every frame the application emits in that pass is target-bound |
| **`remoteDescriptors`** | **2 — OPTIONAL** | cc **never sends `describeRemote`**. The session root is the local image of the project root exactly as before, `mirrorRoot = systemPath`, `offset = ""`, and no path is excluded | None. A session on such a system is byte-identical to one before the capability existed — same wire traffic, same geometry, same walk | `tests/systems-mirror-fallback.test.mjs` — the recording provider with no `--mirror` flag: no `describeRemote` frame is on the wire, `offset === ''`, `cwd === root`, the exclude list is empty. Plus the `remoteDescriptors:false` row asserted in every configuration of `tests/systems-protocol-conformance.test.mjs`. `npm run gate:systems` does NOT exercise the present-behaviour, on purpose: `mirror()` is unreachable for the system id `local` whatever class backs it, and a `--mirror` gate configuration was measured receiving zero `describeRemote` frames across the whole suite |
| `pty` | **3 — NOT SUPPORTED** | Absent from the protocol | No cc feature requests a TTY, so there is no affordance to hide and nothing to refuse. A future TTY feature is a version bump with a fallback designed then | — |
| `watch` | **3 — NOT SUPPORTED** | Absent from the protocol | cc has no filesystem watching to replace | — |
| `rename`, `symlink` | **not in the protocol** | — | cc issues neither: nothing on the `System` interface renames or symlinks on a system, so a provider is never asked to | — |

### 2.1 The mirror advertisement

**How much of a target's filesystem cc's session root is the local image of,**
and which prefixes cc must not carry across. One request/response pair, gated on
`remoteDescriptors`, resolved **per target**:

```
cc  →  {"type":"describeRemote","id":"d1","remoteId":"ctr-a"}
   ←  {"type":"remoteDescriptor","id":"d1","mirrorRoot":"/","exclude":["/proc","/dev","/sys"]}
```

- **A frame, not a handshake field**, because the handshake's `system`
  descriptor is one-per-connection (§2) and a `remotes` provider's targets
  plausibly differ — `/app` in one container, `/srv/thing` in another.
- `remoteId` **omitted** asks about the provider's default target, the same
  convention the other three request frames use. It is the **fourth** request
  frame carrying `remoteId`, and the only one with no follow-on frames, so §4's
  id-binding rule has nothing to bind.
- **Both response fields are optional.** A `remoteDescriptor` with neither is a
  valid "I advertise nothing" and takes the same path as a provider that never
  heard of the frame.
- **Sent once per connection generation.** cc memoises the answer on the
  handshake, so a provider restart re-asks and nothing else does.
- Error answers: **`ENOREMOTE`**, id-addressed (§9); **`EUNSUPPORTED`** if a
  provider answers it despite advertising the capability — cc treats that as "I
  advertise nothing" rather than failing the session.
- **An unrecognised field on a `remoteDescriptor` is ignored.** This direction is
  safe to grow without a version bump in a way the cc → provider direction is
  not: cc decodes every line into `{type} & Record<string, unknown>` and reads
  named fields off it, so a field it does not know is inert on arrival. The
  hazard the `remotes` capability row exists to prevent is the opposite — cc
  optimistically *sending* a field to a provider that predates it, which
  silently misroutes.

**What cc will not believe** (`src/systems/mirror.ts`, refusal
`MIRROR_ADVERTISEMENT_INVALID`, **502** — the far side answered, and answered
badly; the message quotes the offending value):

| Advertisement | Verdict |
|---|---|
| `mirrorRoot` absent or `null` | **Valid** — no advertisement |
| `mirrorRoot` not a string, empty, or whitespace-only | refused |
| `mirrorRoot` relative (`"app"`, `"./app"`, `"../x"`) | refused — the same absolute-paths-only rule §1 puts on cc's own callers |
| `mirrorRoot` containing a NUL byte, longer than `MIRROR_PATH_MAX` (`src/systems/protocol.ts`), or not in POSIX normal form (contains `.`, `..`, `//`, or a trailing `/` other than the root itself) | refused — **cc does not normalise on a provider's behalf**, because a normalised-away `..` is how a hostile root would be smuggled past a containment test |
| `exclude` absent | **Valid** — `[]` |
| `exclude` not an array; any entry not a string, empty, relative or non-normalised | refused, naming the entry and its index |
| `exclude.length > MIRROR_EXCLUDE_MAX` (`src/systems/protocol.ts`) | refused |

**What cc refuses about the project** (raised at **spawn**, not at project
resolution — a bad advertisement breaks worker sessions only; git, status, diff,
worktrees and every `project_*` tool run at the project path and never consult
the mirror):

| Condition | Refusal |
|---|---|
| the mirror root is not an ancestor of, or equal to, the project path | **`MIRROR_ROOT_EXCLUDES_PROJECT`** (501) |
| an exclude entry covers or equals the project path | **`MIRROR_EXCLUDE_COVERS_PROJECT`** (501) |
| an exclude entry lies outside the mirror root | **inert** — reported on the session's event stream, once per launch, never a refusal |

Containment throughout is `path.posix.relative`, never a string prefix, so
`/app-backup` is not inside `/app`. cc **never stats the mirror root**: it is a
prefix for path arithmetic and is never opened, so a non-directory root fails at
whatever operation touches it, carrying the far side's own reason.

**What it changes locally.** The session root becomes the image of the mirror
root and the CLI's cwd moves to the project's place inside it
(`root + offset`, `offset = ""` when the two are equal). The **allow-list walk
does not move**: it stays anchored at the project over its fixed targets
whatever the mirror root is (`src/systems/sessionRoot.ts`). The `exec` frames a
composition sends are identical for `mirrorRoot: "/"` and
`mirrorRoot: <project>`, pinned differentially in
`tests/systems-session-root.test.mjs`.

## 3. Frames

Every request carries a unique string `id`. Stream frames echo it with a `seq`
that is monotonic per id across both streams.

**What cc actually relies on is arrival order on the single stdout pipe**, which
is what preserves stdout/stderr interleaving; `seq` is a diagnostic for a
provider author and for anyone reading a captured stream, and cc does not check
it. A provider that emits wrong `seq` values cannot desynchronise or corrupt
anything — but it is lying in its own logs.

### cc → provider

| Frame | Fields | Meaning |
|---|---|---|
| `hello` | `protocol`, `client` | Opens the connection |
| `exec` | `id`, `cwd`, **`argv`** *or* **`shell`**, `remoteId?`, `env?`, `timeoutMs?`, `killGraceMs?`, `stdin?` | Run a command |
| `signal` | `id`, `signal`, `processGroup` | Signal a running command. **`signal` is a POSIX signal NAME in `SIG*` form** (`"SIGTERM"`, `"SIGKILL"`) — never a bare name and never a number |
| `close` | `id` | Abandon the operation **and kill the command** |
| `detach` | `id` | The command is over: stop reporting, **kill nothing**. **`exec` ids only** |
| `readFile` | `id`, `path`, `remoteId?`, `offset?`, `length?` | Read |
| `writeFile` | `id`, `path`, `remoteId?`, `mode?`, `atomic?`, `exclusive?` | Open a write; `data`… then `end` follow |
| `describeRemote` | `id`, `remoteId?` | Ask for a target's mirror advertisement (§2.1). **Requires `remoteDescriptors`** |
| `data` | `id`, `seq`, `dataB64` | One chunk of a `writeFile` payload |
| `end` | `id` | End of a `writeFile` payload |

**`remoteId` is carried by those four REQUEST frames and by nothing else.**
It names which of the provider's targets the operation is for, and it is sent
only to a provider that advertises `remotes` — see §4 for why every follow-on
frame omits it, and the `remotes` row in §2 for why an optimistically-sent field
would be unsafe.

### provider → cc

| Frame | Fields | Meaning |
|---|---|---|
| `hello` | `protocol`, `provider`, `capabilities?` | Handshake reply |
| `stdout` / `stderr` | `id`, `seq`, `dataB64` | Output of a running command |
| `exit` | `id`, `code`, `signal`, `timedOut`, `descendantsMaySurvive?` | Terminal for an `exec` |
| `readFileResult` | `id`, `size`, `mode`, `isBinary` | Opens a read; `data`… then `end` follow |
| `data` | `id`, `seq`, `dataB64` | One chunk of a read |
| `end` | `id` | Terminal for a `readFile` |
| `writeFileResult` | `id`, `ok:true` | Terminal for a `writeFile` |
| `remoteDescriptor` | `id`, `mirrorRoot?`, `exclude?` | Terminal for a `describeRemote`; both fields optional (§2.1) |
| `error` | `id?`, `code`, `message`, `exitCode?`, `stderr?` | Terminal for the id; **id-less means the whole connection failed** |

## 4. Multiplexing

Multiple `id`s are open concurrently. Frames for **one** id arrive in `seq`
order; **cc assumes no ordering across ids.** A provider that cannot parallelise
must still interleave correctly rather than serialise cc behind one slow
command.

Ids are generated by cc, are never reused, and are opaque to the provider.

**AN ID IS BOUND TO ONE REMOTE FOR ITS WHOLE LIFETIME.** The `remoteId` on the
opening `exec` / `readFile` / `writeFile` is the operation's target for every
frame that follows it (`describeRemote`, the fourth request frame, has no
follow-on frames — it opens and closes in one exchange) — `signal`, `close`,
`detach`, `data`, `end` carry no `remoteId` and a provider must not look for one on them. A provider
that re-derived the target per frame would have to answer "which target" for a
frame that never names one.

- A frame for an id cc has already closed is **dropped**, not an error: cc's
  `close` and the provider's last frames cross on the wire by design.
- A **second terminal frame** for a settled id is likewise dropped; the first
  one is the answer.

## 5. `exec` — the lifecycle

```
cc  →  {"type":"exec","id":"e7","remoteId":"ctr-a","cwd":"/app","argv":["git","status"]}
   ←  {"type":"stdout","id":"e7","seq":0,"dataB64":"…"}
   ←  {"type":"stderr","id":"e7","seq":1,"dataB64":"…"}
   ←  {"type":"exit","id":"e7","code":0,"signal":null,"timedOut":false}
```

| Field | Contract |
|---|---|
| `argv` | Run the binary directly, no shell. `argv[0]` is the executable. |
| `shell` | Run the string through a shell (`bash -lc <string>` in the reference provider; `sh -c` is equally valid — see §11). **The interpreter is the provider's choice, per target**: cc requires a POSIX shell and nothing more, and cc's own framing (§5) is interpreter-agnostic and does not require a *login* shell. Whichever is picked must give a user-authored hook or start command what it expects: pipes, `&&`, a usable PATH. In the reference provider an unqualified interpreter is resolved through the `env` the frame carried rather than through the provider's own; a runtime that resolves the name before applying the new environment may do the opposite. Either way, naming the interpreter absolutely removes the dependence on either side's `PATH`. |
| `cwd` | Absolute. The command's working directory. |
| `env` | **REPLACES** the environment, exactly as `posix_spawn` does — not an overlay. Absent means the provider's own environment. |
| `timeoutMs` | The **provider** enforces it: SIGTERM the command (its whole group where the capability allows), SIGKILL after `killGraceMs`, then report `{"code":124,"timedOut":true}`. 124 is `timeout(1)`'s convention. |
| `killGraceMs` | SIGTERM → SIGKILL delay. Default 100 ms. |
| `stdin` | `"ignore"` gives the command a **closed stdin**, so an interactive one sees EOF instead of blocking until the timeout. Default `"pipe"`. |

Rules:

- **A command that never started is an `error` frame, not an `exit` frame** —
  a missing binary, an unreadable cwd, an argv entry containing a NUL. Its
  `code` comes from the taxonomy (usually `ENOENT`). cc turns it into a result
  carrying a `spawnError` rather than a throw, so the two are distinguishable at
  every call site.
- A `signal` frame delivers exactly that signal, named in `SIG*` form. When it is `SIGTERM`
  the provider also **arms a SIGKILL backstop** after `killGraceMs`, because a
  script that traps or ignores SIGTERM would otherwise never die.
- `processGroup:true` means "the whole group". A provider without
  `processGroupSignal` signals the direct child and **sets
  `descendantsMaySurvive: true`** on the eventual `exit`.
- `close` means cc has stopped listening: kill the command (hard) and emit
  **no further frames** for that id.
- `detach` means **the command is over and nothing is to be killed**: drop the
  operation, cancel any deadline armed for it, and emit no further frames for
  that id — but leave the process, and anything it backgrounded, running.
  **`exec` ids only.** Keep reading the command's streams and discard what
  arrives: pausing them blocks a survivor still writing, and destroying them
  kills it with SIGPIPE (both measured, card 2026-0318 §3), and either is a
  divergence from what a local background job gets.
  - cc sends it when a **redirected shell command** settles on cc's own framing
    sentinel (below), which may be long before — or instead of — the command's
    exit being reported.
  - **A provider that ignores it** falls through to whatever it does with an
    unknown frame (§2: ignore it), so the operation stays open on its side with
    its deadline still armed, and it reaps the command when that fires. **cc
    cannot detect that**, and does not try: it is MUST 5's breach, reported by
    nothing.
- **Backstop: no operation is unbounded, with no exceptions.** cc arms its own
  deadline on every `exec` — at `timeoutMs + EXEC_TIMEOUT_SLACK_MS`
  (`src/systems/providerSystem.ts`) when the caller named one, and at
  `DEFAULT_OP_TIMEOUT_MS` when it did not (`runGit` and the §7 derivations
  deliberately carry no timeout, because locally there is nothing to time out
  against). For a redirected shell command, whose `timeoutMs` is
  `DEFAULT_COMMAND_TIMEOUT_MS`, that sum is 610 000 ms — **measured at
  610 083 ms** (card 2026-0318 §1). Read the sum from the constants rather than
  the number: `timeoutMs` is per-command and `ORCH_SHELL_COMMAND_TIMEOUT_MS`
  moves it. Expiry sends `close`, which is the provider's instruction
  to kill the command, and reports `{code:124, timedOut:true}` with
  `abandonedAfterMs` carrying that timer's own value —
  **the bound cc actually waited, which is longer than the deadline the provider
  was given**. `readFile` and
  `writeFile` carry the same ceiling and fail `ETIMEDOUT`. The ceiling is a
  liveness fence, not a performance budget: it sits above the slowest legitimate
  operation cc issues, so it can only ever turn a hang into a reported failure.
  **No operation is an exception**: a redirected shell command is an ordinary
  bounded `exec`, carrying the per-command ceiling of §5 as its `timeoutMs`.

### The redirected shell command (cc-side framing)

There is **no shell operation in this protocol**, and nothing long-lived. A
redirected shell command is **one `exec` per command** of a script cc frames
itself (`src/systems/shellFraming.ts`) — the shape a LOCAL `Bash` call already
has, where nothing outlives the command either. A provider implements nothing
for it beyond `exec`.

For each command cc sends:

```sh
printf '\n__CC_<nonce>_BEGIN__\n'; printf '\n__CC_<nonce>_BEGIN__\n' >&2
{ <user command>
} < /dev/null
__cc_rc=$?; printf '\n__CC_<nonce>__ %d %s\n' "$__cc_rc" "$(printf %s "$PWD" | base64 | tr -d '\n')"
printf '\n__CC_<nonce>__\n' >&2
```

Braces rather than a subshell, so a `cd` inside the command is the shell's own
and `$PWD` reports it; `$PWD` rides as base64 because a path may contain spaces
or newlines. Each stream is bracketed by its OWN pair of sentinels, so cc knows
both where a command's output starts and when it is done.

**THE SENTINEL'S `$?` IS THE ONLY EXIT CODE THERE IS**, and it is not redundant
with the `exit` frame. Measured: the framed script's own `exec` exits **0** while
the user command exits **2** (`ls /nope`) — the script's last statement is a
`printf`. A provider MUST NOT synthesise a command's exit code from the `exec`'s.

**THE CLOSING SENTINEL — NOT THE `exit` FRAME — IS WHAT SETTLES A REDIRECTED
COMMAND.** Once it has arrived at the start of a complete line on **both**
streams, cc has the command's whole output and its exit code, sends `detach`,
and returns. The `exit` frame may arrive later, or never.

**So cc does NOT require a provider to report `exit` promptly after the process
exits — and this protocol deliberately does not ask for it.** Measured on the
reference provider (card 2026-0318 §1, §4), both same-host and across a real
container boundary, in both capability configurations:

- A provider that reports `exit` when the child's **streams close** never
  reports it for a command that backgrounded a job, because the job inherits the
  command's stdout pipe and holds it open: `cmd &`, `cmd & disown`,
  `setsid cmd &`, and `nohup cmd &` **without** an explicit output redirect all
  produce **zero** `exit` frames.
- A provider that reports `exit` on the child's **process exit** instead drops
  output: measured, up to 64 KB of a command's stdout was silently lost because
  the streams had not drained. There is **no zero-heuristic way for a provider
  to know a drain is complete**, so demanding promptness would demand a magic
  number the reference implementation could not supply.

The backstop above is still what bounds a command that produces **no sentinel at
all** — the shell died, the provider wedged. That is a different failure mode,
not a redundant guard.

**CAPTURE, NOT CARRY.** cc reads `$PWD` back so it can TELL the worker where its
command ended; it never feeds that value into the next command's `cwd`. Every
command starts at the project root, and a command that ended elsewhere gets a
notice saying so — because a discarded `cd` that is never mentioned is the
silent divergence this whole layer exists to prevent.

Five rules, each earned by a measured or reasoned failure:

1. **The nonce is random and unguessable** — 128 bits, so a command cannot emit
   the sentinel by accident. A CONSTANT nonce is forgeable: a command that echoed
   it was measured desynchronising the parser — five frames for four commands,
   the forgery parsed as `rc=999`. cc generates one per command, but that
   FRESHNESS is no longer what makes anything safe: it mattered when one byte
   stream carried every command, and each command now has its own `exec`, its own
   stream and its own parser, so a forgery is confined to its own command by
   construction. What IS load-bearing is that a command is parsed with the nonce
   it was framed with.
2. **First match wins, then stop parsing.** A forgery can then truncate only its
   own output; **a desync cannot propagate past one command.**
3. **`< /dev/null` on the command group**, matching `project_bash`'s
   `stdin:'ignore'` and the CLI's own Bash tool, which has no stdin parameter.
4. **EVERY sentinel line — opening and closing, on BOTH streams — is emitted
   with an injected leading newline.** A sentinel only counts when it STARTS a
   line, and whatever precedes it may have no trailing newline of its own: a
   command ending in `printf err >&2`, or a login profile printing an
   unterminated banner. Without the injected newline the marker glues itself to
   that text, never matches, and the command runs to its deadline instead of
   returning — on EVERY command, because every command gets its own shell and its
   own copy of that banner. This is the rule to keep if any line of the script is
   ever edited; the four sentinels are just today's instances of it.
5. **cc strips the injected newline back off the CLOSING sentinels**, so a blank
   line is never attributed to the command. The opening ones need no strip:
   everything before them is discarded by definition.

**The opening sentinel is what separates the shell's output from the command's**,
and it is load-bearing on EVERY command. Whatever the interpreter prints before
cc's first `printf` — a login shell's MOTD, an `nvm` banner — arrives on the
stream ahead of the command's own output, and everything up to and including the
opening sentinel line is discarded. This is why the interpreter is the provider's
choice (§2): a login shell is safe because the banner is discarded, and a
non-login shell is safe because there is nothing to discard.

**THE WEDGE CLASS IS GONE.** A command that destroys its own framing — an
unterminated quote, a syntax error, an `exit` — takes its own shell with it and
fails `ESHELLGONE`, immediately (measured: 17 ms, against the 1504 ms full
deadline the long-lived shell took to notice the same input). It costs the next
command nothing, because the next command has its own shell. **Nothing is
serialised**: N commands of one session are N independent processes, exactly as
a local fan-out produces, bounded by the same thing that bounds it locally.

**The deadline is PER COMMAND, it is cc's, and no caller can move it.**
`DEFAULT_COMMAND_TIMEOUT_MS` is 605 000 ms = the built-in Bash tool's documented
600 000 ms max plus 5 s of slack, so that for any tool timeout **up to that
documented max** the caller's own timer expires first and cc's never decides the
outcome; `ORCH_SHELL_COMMAND_TIMEOUT_MS` overrides it. A tool timeout **above**
the documented max is unmeasured; if the CLI honours one it outruns this ceiling,
and raising that var is what restores the ordering.

It is enforced by the **provider**, as the `exec` frame's own `timeoutMs`, and
expiry kills the command and reports `{code:124,timedOut:true}` exactly as any
other bounded `exec` does — **except when the provider reports nothing**, where
what fires is cc's own backstop at `timeoutMs + EXEC_TIMEOUT_SLACK_MS` and the
failure carries `abandonedAfterMs` instead (§5's rules). It does **one** job — the longest a command may run.
It used to do three, also capping how long a wedged shell stayed wedged and how
long a queued command waited for its turn, and both of those went with the
long-lived shell and the queue.

The tool timeout a redirected `Bash` carries reaches cc **not at all**, and cc
needs it for nothing. At the tool timeout the CLI **detaches** the forwarder and
hands the agent a background task — measured at CLI 2.1.258, for a rewritten
forwarder command and for the same command left un-rewritten alike, and whether
its output was flowing or silent. The command keeps running, bounded by this
ceiling, which is why the ceiling sits **above** the documented max rather than
at it. The CLI's **kill** of the forwarder, on an
interrupt or a stopped background task, closes the socket, and that is cc's
cancellation channel; it carries no number either. Cancellation is a **kill,
not a rollback**: cc makes no claim about effects the command had already
produced, and nothing in cc inspects or undoes them.

## 6. `readFile` and `writeFile`

```
cc  →  {"type":"readFile","id":"r3","remoteId":"ctr-a","path":"/app/README.md","length":4096}
   ←  {"type":"readFileResult","id":"r3","size":18211,"mode":33188,"isBinary":false}
   ←  {"type":"data","id":"r3","seq":0,"dataB64":"…"}
   ←  {"type":"end","id":"r3"}
```

- `size` and `mode` describe the **whole file** (`mode` as `stat(2)` reports it,
  file-type bits included), not the returned range.
- `isBinary` describes **the returned data, not the file**: "a NUL byte within
  the first `BINARY_SNIFF_BYTES` (8 KiB) of what this call returns". cc's only
  reader asks for the head of a file, so the two coincide in practice — but a
  ranged read from an offset answers about that range, and a provider author
  reading it as "is this file binary" would be implementing something else.
- `offset`/`length` bound the read; both absent means the whole file.
- A requested extent above `MAX_FILE_BYTES` is `EFBIG`.

```
cc  →  {"type":"writeFile","id":"w4","remoteId":"ctr-a","path":"/app/x","atomic":true}
cc  →  {"type":"data","id":"w4","seq":0,"dataB64":"…"}
cc  →  {"type":"end","id":"w4"}
   ←  {"type":"writeFileResult","id":"w4","ok":true}
```

- `atomic:true` — write a **uniquely named** temp file beside the target and
  rename over it, so a reader never sees a torn write. The temp name must be
  unique per call (pid + counter): a shared one lets one writer's rename delete
  another's source file. Creates the parent directory.
- `exclusive:true` — fail `EEXIST` rather than overwrite. Callers catch EEXIST;
  that is how "create if absent" stays safe against a concurrent writer.
- `atomic` and `exclusive` together are refused: an atomic write ends in a
  rename, which overwrites by definition.
- `mode` sets the permission bits (masked to `0o7777`). It is what makes an
  `atomic` write mode-PRESERVING: the rename installs the temp file, so without
  it an edited script comes back 0644 and silently stops being executable. cc's
  write-back path sends the mode it read at the matching `readFile`.

## 7. Everything else, derived from `exec`

These are **cc-side helpers, not provider surface** — a provider implements none
of them. They are listed so a provider author knows what its `exec` will be
asked to run, and so the POSIX assumption is concrete.

| Operation | Command cc runs |
|---|---|
| `stat` | `env LC_ALL=C stat -L -c '%f %s %.3Y' -- <path>` — `-L` follows symlinks (matching `fs.stat`), `%f` is the raw mode so the kind comes from the type bits rather than a locale-dependent word |
| `readDir` | `env LC_ALL=C find <path>/. -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'` — the trailing `/.` is what makes a **file** report `ENOTDIR` instead of an empty listing |
| `realpath` | `env LC_ALL=C realpath -e -- <path>` — `-e` requires every component to exist, matching `fs.realpath` |
| `mkdir` | `mkdir -- <path>`, or `mkdir -p -- <path>` when recursive |
| `removeTree` | `rm -rf -- <path>` |
| `unlink` | `unlink -- <path>` — one directory entry, never followed, never recursed |
| `chmod` | `chmod <octal> -- <path>` |

That is the whole list — it is what `System`'s derived members compile to, and a
provider's `exec` is asked to run nothing else on cc's behalf.

**No `exec` cc issues carries an `env` frame field** — a caller's command and
cc's own plumbing alike. Every command therefore runs in **the provider's own
environment**, which is what §5's `env` row says an absent field means: the far
side's PATH and toolchain, not cc's. The derived ones additionally get `LC_ALL=C` from
`env(1)`, which ADDS a variable to that environment where a frame `env` would
replace it, so the `strerror()` text stays untranslated for §8's classifier. A
caller needing a variable on the far side ships it the same way, in argv.

### Every derivation is sent with `cwd: "/"`, and a provider MUST accept it

**`cwd` on a derived command is a PLACEHOLDER, not a location.** Each command
above carries its real target as an absolute path in `argv`; the far side's
notion of "here" is not cc's, so there is no meaningful directory for cc to
name. It sends `/` — chosen precisely because cc has no expectation about it.

**A provider MUST NOT refuse `cwd: "/"`**, and in particular must not fence it
against a remote's root. That matters most for exactly the provider §11
describes: a `docker exec -w <cwd>` mapping that scoped `<cwd>` to a container's
project root would refuse **every** derived operation — `stat`, `readDir`,
`realpath`, `mkdir`, `removeTree`, `unlink`, `chmod`, all of them — while `exec`
and the two file primitives kept working, which reads as cc being broken rather
than as a fence doing its job. Fencing it also buys nothing: a provider cannot
fence `argv`, and `argv` is where the real path is.

**What routes a derivation instead is `remoteId`,** which every one of these
frames carries like any other `exec` (§3). That is the compensating guarantee,
and it is asserted on the wire rather than inferred from an operation
succeeding: see `tests/systems-remote-id.test.mjs` → "every derived operation
carries its binding on the wire". A provider that wants to scope a remote should
scope `readFile`/`writeFile` `path` and a **non-placeholder** `exec` `cwd`; cc's
own reference provider does exactly that.

Costs cc accepts for the shrink, stated rather than hidden:

- Text parsing instead of typed records.
- A filename containing a newline produces an unparseable listing line. **cc
  treats it as an error, never a silent skip** — a listing that quietly drops an
  entry is indistinguishable from one that does not have it.
- `realpath` is a round trip on a path that is load-bearing for session
  identity, and it is **not cached** — a project's realpath is resolved afresh
  on every call. Caching it would trade a round trip for a class of bug that is
  much worse than the round trip: a stale entry survives the user moving or
  re-linking a checkout, and the value keys the session directory, so a wrong
  one strands every resume for that project. If the round trips ever become the
  bottleneck, the cache has to be invalidated by something — not merely added.

## 8. Error taxonomy

Split by layer, because that is the only split that survives contact with a
shell.

### Protocol-level — properties of the channel, carried as `error` frames

| Code | Raised when |
|---|---|
| `EPROTO` | A malformed frame: not JSON, not an object, no `type`, or past the line ceiling. **A malformed line is fatal to the connection, not skipped** — a stream that has proved it cannot be framed cannot be trusted for what follows. Also a protocol-version mismatch. |
| `ETRANSPORT` | The connection is gone: the provider exited, the pipe broke, or the launch failed. Every in-flight operation fails with it **immediately**. |
| `ETIMEDOUT` | A bounded wait elapsed: the handshake, or a shell command's deadline. |
| `EUNSUPPORTED` | An optional capability the provider does not advertise was asked for. |
| `ESHELLGONE` | A redirected command destroyed its own framing, so no sentinel could arrive. |
| `EFBIG` | A read or write above `MAX_FILE_BYTES`. |
| `ECANCELLED` | The caller went away: an interrupt, or a tool timeout. **cc raises this one itself**, from the caller's cancellation channel (see §5), in `src/systems/providerShell.ts`. The provider-produced table below has no row for it. |
| `ENOREMOTE` | The request named a `remoteId` this provider does not serve — or named none, on a provider that advertises `remotes` and therefore has no default. cc converts it to `REMOTE_NOT_FOUND` (502) at the registry. **It MUST be id-addressed** — see §9. |

### What a provider puts in an `error` frame

An `error` frame carries a code from **either** group above. Which one is not a
provider's choice — it follows from what failed:

| The provider is answering… | with |
|---|---|
| `readFile` / `writeFile` that the filesystem refused | **the FS code the local filesystem would have raised**: `ENOENT`, `EACCES`, `EEXIST` (an `exclusive` write over an existing file), `EISDIR` (a read of a directory), `ENOTDIR`, `ENOSPC` |
| `readFile` / `writeFile` above `MAX_FILE_BYTES` | `EFBIG` |
| an `exec` whose command **never started** | the FS code of the spawn failure — usually `ENOENT` (no such binary, or a cwd that is gone), `EACCES` |
| a request naming a `remoteId` it does not serve, or naming none while it advertises `remotes` | `ENOREMOTE`, **id-addressed** |
| a frame it could not read at all | `EPROTO`, **id-less** — that is a connection-level failure |
| a filesystem failure it has no code for | `EUNKNOWN`, with `exitCode`/`stderr` filled in |

**This is a MUST, not a courtesy.** cc's callers branch on these exact codes —
"create the file unless it already exists" is written as *catch `EEXIST` and
re-read*, and a missing path resolves to *absent* rather than to an error — so a
provider that answered `EUNKNOWN` for everything would not be wrong on the wire,
it would change what the application does. It is what makes a System reached
over the protocol behave like the local one, and it is asserted per code in the
conformance suite.

A code cc does not recognise is treated as `EUNKNOWN` rather than as a framing
violation: inventing a code is a provider being unhelpful, not a stream cc
cannot read.

### cc-side interpretation — an exit code plus stderr text

A derived command that **ran and failed** is classified by matching its stderr
against a small table of well-known `strerror()` strings (substring, under
`LC_ALL=C`): `ENOENT`, `EACCES`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOSPC`.

**An unmatched failure is `EUNKNOWN`, carrying the exit code and the raw stderr
verbatim, and it is surfaced to the user.** cc never guesses silently at a
message it does not know.

**"Absent" is a value, not an error.** A `stat` that fails with a no-such-file
line resolves to `null`, matching cc's own ENOENT→null contract for project
resolution. Every *other* failure throws, because reading a broken installation
as "no such file" turns one fixable fault into a fleet of misses.

## 9. Failure and restart

| Situation | cc's behaviour |
|---|---|
| The provider will not launch, or dies | Every in-flight operation fails `ETRANSPORT` at once. `exec` still resolves (with a `spawnError`) rather than throwing — its callers all branch on the result. The result also carries **`transportFailure: true`**, which is the ONLY way to tell this from the far side answering "I could not start that command": a transport failure's `spawnError` embeds the provider's dying stderr tail, so it may name any errno at all and must never be classified by its text. `runGit` reads exactly that flag to decide between refusing by system and reporting a git answer. |
| The next operation after a death | Relaunches and redoes the handshake. Supervision is **restart-on-demand**: nothing reconnects a channel nobody is using. |
| Repeated failures | Exponential backoff, 100 ms doubling to a 5 s ceiling. **Inside the window an operation is refused, not queued** — a caller told "unreachable" now beats one held open across a restart storm. |
| A malformed frame | The connection is torn down and restarted like a death. |
| cc tears the connection down (`dispose`, a protocol violation, a handshake timeout) | cc **closes the provider's stdin** and lets MUST 3 do the work, then **SIGKILLs** it if it has not exited within a bounded grace. A provider that ignores EOF is still terminated — but cc cannot reap what such a provider started, which is what MUST 3 exists to prevent. |
| An id-less `error` frame | Connection-level: everything in flight fails with that code. |
| **One dead remote is not a dead connection** | On a provider serving many targets, one connection carries every target's work. So a refusal ABOUT a target — `ENOREMOTE`, or any FS code from an operation on it — **MUST be id-addressed**. A provider that answered a bad `remoteId` id-lessly would tear the connection down and fail every OTHER target's in-flight operation with it. Pinned by `tests/systems-protocol-conformance.test.mjs` → "ENOREMOTE is id-addressed". |

## 10. Verifying a provider

```
# the reference provider
node tests/run.mjs tests/systems-protocol-conformance.test.mjs

# YOUR provider, same battery, no test edits
CC_CONFORMANCE_PROVIDER='["python3","my_provider.py"]' \
  node tests/run.mjs tests/systems-protocol-conformance.test.mjs
```

`CC_CONFORMANCE_PROVIDER` is a JSON argv array. The suite **appends flags** to
it: the `flags` of every entry in `CAPABILITY_CONFIGS`
(`tests/referenceProviderHarness.mjs` owns that list) for the core battery, and
the target/mirror flags below in the `remotes` and `remoteDescriptors` fixtures,
which launch providers of their own. **Every configuration runs whatever the
provider does with those flags**: one that accepts a flag and ignores it fails
the rows the flag toggles, and one that exits on an unknown flag fails that
whole configuration at the handshake. Neither is skipped. The suite
builds its fixtures with node's own `fs` and then asks the provider about them,
so it verifies a provider that reaches **the same filesystem as the test
process**.

### The launch surface — what the suite sends beyond the wire contract

Every flag is repeatable, and its capability is advertised **iff** at least one
is given. The names are pinned by the reference provider and by every fixture
that passes them, so renaming one reds the suite.

| Flag / variable | The provider must | Effect on the handshake |
|---|---|---|
| `--no-process-group-signal` | send a `signal` to the direct child only (§5) | `processGroupSignal: false` |
| `--remote <id>=<absolute root>` | serve that target — the id is its whole address; the root is where the suite places that target's fixtures, not a fence it asks you to enforce. An unknown or absent id is an id-addressed `ENOREMOTE` (§8, §9) | `remotes: true` |
| `--mirror <[id=]absolute root>` | answer `describeRemote` with that `mirrorRoot` (§2.1) | `remoteDescriptors: true` |
| `--exclude <[id=]absolute path>` | add that path to the same descriptor's `exclude` | `remoteDescriptors: true` |
| `CC_REMOTE=<id>` | be in the environment of **every child an `exec` starts**, naming the target it ran on | — (asserted directly, not negotiated) |

**`CC_CONFORMANCE_REMOTE_ID` (below) presupposes `--remote`**, and the two ids
must match. cc refuses a `remoteId` on its own side whenever the handshake
reports `remotes:false` (§2), so binding a handle to a target the launch never
declared loses most of the battery to bare value diffs that name neither the
flag nor the variable. The shape that trips on this is a provider launched with
`--mirror`/`--exclude` alone: it advertises `remoteDescriptors` and, correctly
by the rule above, `remotes:false`. **The handshake row refuses that combination
outright and names the flag**, so that half of the rule is enforced rather than
remembered.

**The id match itself is NOT checked.** A *declared but different* id — the
launch says `--remote u=/`, the variable says `t` — advertises `remotes:true`,
so it clears the handshake and fails the rest of the battery as value diffs.
What identifies it is your own provider's `ENOREMOTE` text naming the unknown
target, carried on the **actual** side of each diff; the assertions themselves
name neither the flag nor the variable.

### If your provider serves only NAMED targets

**The core fixtures build an UNBOUND handle**, so every frame they send names no
remote — and §8 requires a provider with no default target to refuse exactly
those `ENOREMOTE`. A provider whose every kind serves named targets therefore
loses most of the battery, and the failures are about binding, not about
anything it got wrong. **That is this document's own rule meeting a fixture that
never binds**, not a reference-specific assertion the suite could drop.

`CC_CONFORMANCE_REMOTE_ID=<id>` binds every fixture handle to one target — to
the conformance suite what `CC_LOCAL_SYSTEM_REMOTE_ID` (below) is to `npm test`:

```
CC_CONFORMANCE_PROVIDER='["node","my_provider.js","--remote","t=/"]' \
  CC_CONFORMANCE_REMOTE_ID=t \
  node tests/run.mjs tests/systems-protocol-conformance.test.mjs
```

**A bound run proves strictly less than the reference run**, and none of what it
gives up is silent — each row is either relaxed here or skipped in the output
with its own reason:

- **The capability assertion is relaxed on one axis.** The capabilities
  `CAPABILITY_CONFIGS` toggles must still match the flags exactly; `remotes` and
  `remoteDescriptors` may be a **superset** of the configuration. So the suite
  stops being the verifier for the `remotes` and `remoteDescriptors` rows of
  §2's capability table.
- **The CC-SIDE rows are SKIPPED.** They use a provider as a fixture to assert
  what *cc* does — what it sends a provider that advertises a capability off,
  what this suite's own defaults are — so they are pinned to the reference
  provider and skip for any third-party one whatever its shape. **Read the
  printed `skip` reasons off your run: they are the list, and none of them is a
  statement about your provider.** (The shape that motivates the pin: a kind
  that always serves named targets cannot supply a `remotes:false` fixture at
  all, and must not be made to lie about it — that would be a test-only
  divergence in the one field cc negotiates on.)

Run it anyway, because the alternative is weaker. Without the bound path a
provider whose kinds all serve named targets is verified only by a
**generalisation** — that the protocol core and the file operations are
kind-agnostic, and each kind's command builder is a pure function — while only a
differently-shaped kind ever runs the battery. The bound path turns that
generalisation into a **measurement against the shipped kind itself**. The
`docker exec` provider of §11, one process serving every container, is precisely
that shape.

Then run the whole application over it:

```
CC_LOCAL_SYSTEM_PROVIDER='["your-provider","--flags"]' npm test
npm run gate:systems     # the reference provider, in each of the gate's capability configurations
```

`CC_LOCAL_SYSTEM_PROVIDER` replaces the in-process `local` system with a
ProviderSystem over the named command, so **every project-scoped operation in cc
runs over the protocol**. That is the strongest available statement that the
three primitives are sufficient — nothing in the suite knows it is talking to a
provider.

**If your provider serves NAMED targets, it needs `CC_LOCAL_SYSTEM_REMOTE_ID`
too.** It names which target the stand-in `local` handle is bound to; without it
every request frame is unnamed and a provider advertising `remotes` refuses all
of them `ENOREMOTE`. It is inert on its own — with no `CC_LOCAL_SYSTEM_PROVIDER` set, cc
stays on its own in-process machine. The gate's first configuration uses exactly
this pair: `--remote gate=/` on the provider argv and
`CC_LOCAL_SYSTEM_REMOTE_ID=gate` on cc. The gate's own capability matrix — which
capabilities it toggles, why `remotes` is folded into an existing
configuration and why `remoteDescriptors` is absent — is documented at the top of
`tests/systems-gate.mjs`, which owns it.

## 11. A `docker exec` provider, as a sanity check

Docker is the exemplar the contract is checked against, never implemented or
special-cased here. **It is also the motivating case for `remotes`:** the
container id IS the `remoteId`, and one provider talks to the daemon on behalf
of every container — so ten containers are one registry row and one process, not
ten of each.

| Protocol | Docker |
|---|---|
| `exec` | `docker exec -w <cwd> -e … <ctr> sh -c …`, where `<ctr>` is the frame's `remoteId` |
| `remotes` | `true` — the daemon serves every container it knows. An unknown `<ctr>` is `ENOREMOTE`, id-addressed |
| `signal`, `processGroup:true` | `docker exec … kill -- -<pgid>` → `processGroupSignal: true` |
| `detach` | Drop the exec from the provider's bookkeeping and stop forwarding its frames. **Signal nothing** — this frame's whole content is that the command is over and is not to be killed. MUST 3 still applies at provider exit |
| `readFile` / `writeFile` | `cat` / `cat >`, with a companion `stat` for `size`/`mode`, each against the frame's `<ctr>` |
| `remoteDescriptors` | `true` if the provider knows its containers' layouts: `mirrorRoot` = the container's project root, or `/` to let a worker read and edit anywhere in it; `exclude` = the container's pseudo-filesystems (`/proc`, `/dev`, `/sys`) |

Three primitives and three capabilities; a `docker exec` provider satisfies all
of them. **Three things it is not thin about**, worth knowing before starting one:

1. **Reaping.** MUST 3 does not come free: `docker exec` children live in the
   container and are not reparented to the provider, so stdin-EOF ends the
   provider and leaves them running. The provider must SIGKILL its in-flight
   `docker exec` processes on exit itself.
2. **`processGroupSignal: true` is work.** It needs `setsid` inside the
   container, discovery of the resulting pgid, and `kill -- -<pgid>` — not just
   a flag in the handshake. Advertising it without doing that is the one lie
   this protocol cannot detect; a provider that cannot is expected to advertise
   `false` and let cc take the documented fallback.
3. **The base image has to satisfy §1's POSIX assumption.** Alpine — the most
   likely image a reader reaches for — is busybox, and it fails that assumption
   in three ways, only two of which announce themselves. Measured against
   **BusyBox v1.38.0**, running each §7 derivation in the exact form cc sends it
   (busybox's getopt honours `--` throughout, so the `--` is never what breaks):
   - `env LC_ALL=C find <p>/. -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'` →
     `find: unrecognized: -printf`, exit 1. **`readDir` fails outright.**
   - `env LC_ALL=C realpath -e -- <p>` → busybox `realpath` implements neither
     `-e` nor `--`, so it reads both as operands and reports each as missing
     before resolving the real one: exit 1. **`realpath` fails outright.**
   - `env LC_ALL=C stat -L -c '%f %s %.3Y' -- <p>` → **succeeds, and is wrong.**
     busybox `stat` does implement `-c`, but ignores the `.3` precision. On one
     file: GNU answers `81a4 2 1788194735.064`, busybox `81a4 2 1788194735`, so
     `mtimeMs` comes back at one-second granularity with no error anywhere. This
     is the dangerous one — a silent degradation, not a refusal.

   The other four derivations are fine, measured in the same forms: `mkdir --`,
   `mkdir -p --`, `chmod <octal> --` and `rm -rf --` all exit 0, and `unlink --`
   removes a symlink without following it and refuses a directory with the
   POSIX `Is a directory` tail §8's classifier already matches. So busybox is a
   PARTIAL failure, not a total one, which is exactly what makes it worth
   stating. It is out of scope by §1 rather than a gap in the mapping, but it is
   exactly where a reader will discover it.
