# The System provider protocol

The wire contract between code-conductor and a **provider** — a process cc
launches that gives it execution and file access on one System. This document is
complete: a conforming provider can be written from it alone.

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
| Line ceiling | `MAX_LINE_BYTES` = 4 MiB. A longer line is `EPROTO`. |
| Chunk size | `CHUNK_BYTES` = 64 KiB of raw bytes per `data` frame, before base64. |
| Per-file cap | `MAX_FILE_BYTES` = 32 MiB. A read or write above it is `EFBIG`. |
| Paths | **Absolute, on the system.** cc never sends a relative path. |

Provider MUSTs:

1. Write **nothing but frames** to stdout.
2. Answer cc's `hello` with a `hello` **before any other frame**.
3. **Exit when stdin reaches EOF.** This is the whole of provider lifecycle
   management on cc's side: cc closes the pipe (or dies) and the provider —
   and everything it started — goes away.
4. Interleave concurrent ids correctly (§4).

### The POSIX assumption

The target is a **competent POSIX environment with GNU coreutils**: `stat`,
`find` with `-printf`, `mkdir`, `rm`, `unlink`, `realpath`, `chmod`, `base64`,
`tr`, `printf`, `env`, and a POSIX login shell. This is what shrinks the
provider contract from fifteen operations to three — everything else is derived
by cc over `exec` (§6).

**Non-POSIX targets, and non-GNU coreutils, are out of scope.** cc ships no BSD
dialect: an untested second code path is worse than a refusal.

## 2. Handshake and capability negotiation

cc sends first:

```json
{"type":"hello","protocol":1,"client":"code-conductor"}
```

The provider answers exactly once:

```json
{"type":"hello","protocol":1,"provider":"docker-exec/0.1.0",
 "capabilities":{"persistentShell":true,"processGroupSignal":true},
 "system":{"os":"linux","pathSep":"/","shell":"/bin/bash","home":"/root"}}
```

- `protocol` is an integer. **A mismatch is refused** (`EPROTO`) — cc speaks
  `PROTOCOL_VERSION`, currently `1`.
- `capabilities`: a **missing key is `false`**; an **unknown key is ignored**.
- `system.shell` is what cc opens for a redirected shell (§5).
- Unknown *frame types* are likewise ignored by both ends. Unknown capability
  keys and unknown frame types are the extension point: **the contract can grow
  without a version bump.**

### Capability classification

Everything the protocol carries is in exactly one of these buckets. An optional
capability is only acceptable with all four of: a flag name, an absent-behaviour,
a user-visible difference, **and a test that runs the fallback**.

| Capability | Bucket | Absent-behaviour | User-visible difference | Fallback test |
|---|---|---|---|---|
| `exec`, `readFile`, `writeFile` | **1 — MUST** | Registration fails; there is no cc without them | — | — |
| **`persistentShell`** | **2 — OPTIONAL** | cc runs every redirected shell command as a **one-shot `exec`** of the same framing, passing `cwd` explicitly and reading `$PWD` back from the sentinel to carry into the next call | **cwd still persists; exports, shell functions and background jobs do not** — exactly the local CLI's own behaviour, so this is parity, not breakage | `tests/systems-shell-framing.test.mjs`, every case, in both modes |
| **`processGroupSignal`** | **2 — OPTIONAL** | A `signal` frame reaches the **direct child only** | On a timeout or an interrupt, grandchildren may survive; every result cc or the provider terminated carries **`descendantsMaySurvive: true`** | `tests/systems-protocol-conformance.test.mjs` → "process-group signalling", run with `--no-process-group-signal` |
| `pty` | **3 — NOT SUPPORTED** | Absent from the protocol | No cc feature requests a TTY, so there is no affordance to hide and nothing to refuse. A future TTY feature is a version bump with a fallback designed then | — |
| `watch` | **3 — NOT SUPPORTED** | Absent from the protocol | cc has no filesystem watching to replace | — |
| `rename`, `symlink` | **not capabilities** | — | `mv` / `ln -s` over `exec`; **cc-side helpers, not provider surface** | Covered by §6 |

## 3. Frames

Every request carries a unique string `id`. Stream frames echo it with a
`seq` that is **monotonic per id across both streams**, so cc can preserve
interleaving order.

### cc → provider

| Frame | Fields | Meaning |
|---|---|---|
| `hello` | `protocol`, `client` | Opens the connection |
| `exec` | `id`, `cwd`, **`argv`** *or* **`shell`**, `env?`, `timeoutMs?`, `killGraceMs?`, `stdin?` | Run a command |
| `stdin` | `id`, `dataB64` | Write to a running command's stdin. **Requires `persistentShell`** |
| `stdinClose` | `id` | EOF its stdin. **Requires `persistentShell`** |
| `signal` | `id`, `signal`, `processGroup` | Signal a running command |
| `close` | `id` | Abandon the operation |
| `readFile` | `id`, `path`, `offset?`, `length?` | Read |
| `writeFile` | `id`, `path`, `mode?`, `atomic?`, `exclusive?` | Open a write; `data`… then `end` follow |
| `data` | `id`, `seq`, `dataB64` | One chunk of a `writeFile` payload |
| `end` | `id` | End of a `writeFile` payload |

### provider → cc

| Frame | Fields | Meaning |
|---|---|---|
| `hello` | `protocol`, `provider`, `capabilities?`, `system?` | Handshake reply |
| `stdout` / `stderr` | `id`, `seq`, `dataB64` | Output of a running command |
| `exit` | `id`, `code`, `signal`, `timedOut`, `descendantsMaySurvive?` | Terminal for an `exec` |
| `readFileResult` | `id`, `size`, `mode`, `isBinary` | Opens a read; `data`… then `end` follow |
| `data` | `id`, `seq`, `dataB64` | One chunk of a read |
| `end` | `id` | Terminal for a `readFile` |
| `writeFileResult` | `id`, `ok:true` | Terminal for a `writeFile` |
| `error` | `id?`, `code`, `message`, `exitCode?`, `stderr?` | Terminal for the id; **id-less means the whole connection failed** |

## 4. Multiplexing

Multiple `id`s are open concurrently. Frames for **one** id arrive in `seq`
order; **cc assumes no ordering across ids.** A provider that cannot parallelise
must still interleave correctly rather than serialise cc behind one slow
command.

Ids are generated by cc, are never reused, and are opaque to the provider.

- A frame for an id cc has already closed is **dropped**, not an error: cc's
  `close` and the provider's last frames cross on the wire by design.
- A **second terminal frame** for a settled id is likewise dropped; the first
  one is the answer.

## 5. `exec` — the lifecycle

```
cc  →  {"type":"exec","id":"e7","cwd":"/app","argv":["git","status"]}
   ←  {"type":"stdout","id":"e7","seq":0,"dataB64":"…"}
   ←  {"type":"stderr","id":"e7","seq":1,"dataB64":"…"}
   ←  {"type":"exit","id":"e7","code":0,"signal":null,"timedOut":false}
```

| Field | Contract |
|---|---|
| `argv` | Run the binary directly, no shell. `argv[0]` is the executable. |
| `shell` | Run the string through a **login shell** (`bash -lc <string>`). This is what a user-authored hook or start command expects: pipes, `&&`, login-shell PATH. |
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
- A `signal` frame delivers exactly that signal. When the signal is `SIGTERM`
  the provider also **arms a SIGKILL backstop** after `killGraceMs`, because a
  script that traps or ignores SIGTERM would otherwise never die.
- `processGroup:true` means "the whole group". A provider without
  `processGroupSignal` signals the direct child and **sets
  `descendantsMaySurvive: true`** on the eventual `exit`.
- `close` means cc has stopped listening: kill the command (hard) and emit
  **no further frames** for that id.
- Backstop: cc arms its own deadline at `timeoutMs + 5 s` and abandons the
  operation if no `exit` arrives, so a wedged provider cannot turn a bounded
  command into an unbounded wait.

### The long-lived shell (cc-side framing)

There is **no shell operation in this protocol**. A redirected shell is one
`exec` of `$SHELL -l` that cc keeps open and writes framed commands into. Only
`persistentShell` is negotiated; the framing is entirely cc's
(`src/systems/shellFraming.ts`), which is why a provider needs to implement
nothing for it beyond honouring `stdin` frames.

For each command cc writes:

```sh
{ <user command>
} < /dev/null
__cc_rc=$?; printf '\n__CC_<nonce>__ %d %s\n' "$__cc_rc" "$(printf %s "$PWD" | base64 | tr -d '\n')"
printf '__CC_<nonce>__\n' >&2
```

Braces rather than a subshell, so `cd` and `export` land in the shell itself;
`$PWD` rides as base64 because a path may contain spaces or newlines; stderr
gets its own sentinel so cc knows both streams are done.

Four rules, each earned by a measured or reasoned failure:

1. **The nonce is random per command, not per shell.** A fixed nonce is
   forgeable: a command that echoed the sentinel was measured desynchronising
   the parser — five frames for four commands, the forgery parsed as `rc=999`.
2. **First match wins, then stop parsing** until cc writes the next command. A
   forgery can then truncate only its own output; **a desync cannot propagate
   past one command.**
3. **`< /dev/null` on the command group.** A command genuinely needing stdin
   runs as its own one-shot `exec`, at the cost of not sharing shell state.
4. **cc strips the one newline it injected**, so a blank line is never
   attributed to the command's stdout.

Two wedge modes, one recovery: an unterminated quote leaves the shell awaiting
input and no sentinel arrives (a per-command deadline fires → `ETIMEDOUT`); a
command that exits the shell closes the channel (`ESHELLGONE`). Both **reset**
the shell — close it and open a fresh one on the next command. A reconnected
shell says it lost its state rather than silently restoring cwd and looking
continuous. Concurrent commands are serialised per shell; a wait past its bound
is `EBUSY`.

Because `$SHELL -l` is a **login** shell, cc discards one framed no-op
immediately after opening it, so profile-file output is never attributed to a
user command.

## 6. `readFile` and `writeFile`

```
cc  →  {"type":"readFile","id":"r3","path":"/app/README.md","length":4096}
   ←  {"type":"readFileResult","id":"r3","size":18211,"mode":33188,"isBinary":false}
   ←  {"type":"data","id":"r3","seq":0,"dataB64":"…"}
   ←  {"type":"end","id":"r3"}
```

- `size` and `mode` describe the **whole file** (`mode` as `stat(2)` reports it,
  file-type bits included), not the returned range.
- `isBinary` is "a NUL byte within the first `BINARY_SNIFF_BYTES` (8 KiB) of the
  returned data".
- `offset`/`length` bound the read; both absent means the whole file.
- A requested extent above `MAX_FILE_BYTES` is `EFBIG`.

```
cc  →  {"type":"writeFile","id":"w4","path":"/app/x","atomic":true}
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
- `mode` sets the permission bits (masked to `0o7777`).

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
| `rename` / `symlink` | `mv -- <a> <b>` / `ln -s -- <target> <link>` |

Derived commands carry **no `env` frame field**: they are cc's own plumbing, so
they inherit the far side's environment (its PATH, its toolchain) and get
`LC_ALL=C` from `env(1)` so the `strerror()` text stays untranslated for §8's
classifier.

Costs cc accepts for the shrink, stated rather than hidden:

- Text parsing instead of typed records.
- A filename containing a newline produces an unparseable listing line. **cc
  treats it as an error, never a silent skip** — a listing that quietly drops an
  entry is indistinguishable from one that does not have it.
- `realpath` is a round trip on a path that is load-bearing for session
  identity, so it is cached per (system, path) for the session.

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
| `EBUSY` | The wait for a serialised shell exceeded its bound. |
| `ESHELLGONE` | The long-lived shell died, or a command destroyed the framing so no sentinel can arrive. |
| `EFBIG` | A read or write above `MAX_FILE_BYTES`. |

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
| The provider will not launch, or dies | Every in-flight operation fails `ETRANSPORT` at once. `exec` still resolves (with a `spawnError`) rather than throwing — its callers all branch on the result. |
| The next operation after a death | Relaunches and redoes the handshake. Supervision is **restart-on-demand**: nothing reconnects a channel nobody is using. |
| Repeated failures | Exponential backoff, 100 ms doubling to a 5 s ceiling. **Inside the window an operation is refused, not queued** — a caller told "unreachable" now beats one held open across a restart storm. |
| A malformed frame | The connection is torn down and restarted like a death. |
| An id-less `error` frame | Connection-level: everything in flight fails with that code. |

## 10. Verifying a provider

```
node tests/run.mjs tests/systems-protocol-conformance.test.mjs
```

Point it at your provider by editing the harness's launch argv
(`tests/referenceProviderHarness.mjs`), or run the whole application over it:

```
CC_LOCAL_SYSTEM_PROVIDER='["your-provider","--flags"]' npm test
npm run gate:systems     # the reference provider, in all three capability configurations
```

`CC_LOCAL_SYSTEM_PROVIDER` replaces the in-process `local` system with a
ProviderSystem over the named command, so **every project-scoped operation in cc
runs over the protocol**. That is the strongest available statement that the
three primitives are sufficient — nothing in the suite knows it is talking to a
provider.

## 11. A `docker exec` provider, as a sanity check

Docker is the exemplar the contract is checked against, never implemented or
special-cased here.

| Protocol | Docker |
|---|---|
| `exec` | `docker exec -w <cwd> -e … <ctr> sh -c …` |
| the long-lived shell | one `docker exec -i <ctr> $SHELL -l` |
| `signal`, `processGroup:true` | `docker exec … kill -- -<pgid>` → `processGroupSignal: true` |
| `readFile` / `writeFile` | `cat` / `cat >` |

Three primitives and two capabilities; a thin `docker exec` provider satisfies
all of them.
