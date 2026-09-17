// THE tier/deny artifact. ONE table, handed to the daemon as its pins file and
// to the hook's deny surface — two renderings of one array, or they drift.
//
// A tier is a longest-prefix rule over absolute paths:
//   host    → served from the orchestrator's own filesystem
//   project → served from the remote tier (the mirror), remote only
//   hide    → served from neither; the union must not see its own scaffolding
//   bind    → a directory `bootstrap.sh` bind-mounts the ORCHESTRATOR's own over
//   fail    → served from neither, because the provider excluded it
//
// Each entry also carries `toolAccess`, which is what the HOOK does with a file
// tool aimed at it (`classifyForTool` below): the daemon's pins file and the
// hook's deny table are ONE artifact, rendered and read from the same array, so
// they cannot drift.
//
// THE LOAD-BEARING INVARIANT: a host-pinned path keeps its EXACT spelling
// inside the chroot. That is what lets spawnEnv's HOME and CLAUDE_CODE_TMPDIR,
// the inline --settings / --mcp-config JSON and every --plugin-dir argument
// ride through the wrap unmodified.
//
// ── WHAT THE LIST HAS TO COVER, AND WHAT IT DOES NOT
//
// THE LIST DOES NOT GROW WITH THE HOST. `fail → host` for an unmarked caller
// (`policy_caller_tier`, policy.h) means the arrays below have to cover **the
// CLI's own execution closure and nothing else**: its NEEDED set, its dlopen
// closure, its settings, its temp paths. They do not have to grow when somebody
// installs a new tool on the host — a new shell, a new binary, a new library
// some UNMARKED subprocess reaches for is served the host at an unpinned path.
//
// AND AN ENTRY IS DELETABLE ONLY ON THE CALLER, NEVER ON THE GEOMETRY. A pin is
// dead when every path it covers is read exclusively by an UNMARKED caller,
// which resolves in `VIEW_HOST` at every geometry. It is NOT dead merely
// because the DEFAULT `mirrorRoot` (= the project's own path) makes an unpinned
// path `fail`, which the host answers anyway.
//
// UNDER AN ADVERTISED `mirrorRoot: '/'` EVERY SURVIVING ENTRY IS LOAD-BEARING,
// AND FOR THE MARKED CALLER. `add('project', '/')` covers everything unpinned,
// so `tier_of` can never return `T_FAIL` and an unpinned `/usr/lib/.../libc.so.6`
// would be `project` tier — i.e. the REMOTE's libc, not the orchestrator's one
// the chroot is built around. The pin is a longer prefix than `project /`,
// which is the only thing keeping it host-served FOR THE MARKED CLI. (What is
// NOT the reason: it is not that an UNMARKED caller loses anything here. An
// unmarked caller resolves in `VIEW_HOST`, where every `project` pin is
// struck — so it is served
// the orchestrator's own copy at a wide root with or without these pins,
// and at every other geometry identically. The pins are for the CLI.) Measured
// by building the real table both ways.
//
// The split, from the measured pre-mark window plus `ldd`. `bootstrap.sh` fires
// NO marking event, so the whole bootstrap chain runs unmarked and the window
// is the chain in full:
//   RETIRED  every shell spelling AND `setpriv`, everything `binaryPins`
//     derived from each, and `libcap-ng.so.0` — setpriv's alone. Each was read
//     exclusively by an UNMARKED caller — the chroot'd shell, `setpriv`, and
//     the backend launch command `setpriv` execs — and an unmarked caller
//     resolves in VIEW_HOST at every geometry, so none of it was load-bearing
//     under a wide `mirrorRoot` either. The standing licence is real gate
//     `R13w`: no marked op names a path under `/usr/bin` at all. If the CLI
//     grows a marked read there, `R13w` fails and the pins come back.
//   LOAD-BEARING  everything else, and each for a measured reason — `binaryPins`
//     of the CLI launcher, INCLUDING its realpath and the ancestors of that
//     realpath, because the mark fires at the launcher's own lookup and the
//     symlink target's chain is walked marked (`R16`); `ld-linux` and `libc`;
//     node's own NEEDED set and glibc's dlopen closure; `/etc/ld.so.cache` and
//     `/etc/passwd`/`/etc/group` for the CLI's own identity lookups; `/etc/hosts`
//     and the TLS trust for its DNS and TLS. `/etc/ld.so.preload` and
//     `/etc/claude-code` are pinned on the HAZARD rather than on a measurement —
//     a remote-supplied one would preload a remote object into a host binary, or
//     inject settings into the CLI — and that stays an inference, said so here.
//
// A THIRD CLASS, OUTSIDE THESE ARRAYS AND LOAD-BEARING FOR THE RULING:
// the whole-`$HOME` pin, the whole-`projectsRoot` pin and the `sessionTmpDir`
// localRoot are JOINTLY what keep the cross-mark handoff class empty — the
// CLI's shell snapshot (marked CLI writes, unmarked per-call shell reads at
// exec), its cwd breadcrumb and its `<tmpdir>/<encoded-cwd>/<sid>/tasks/` all
// sit inside them. Narrowing any of the three reopens one-path-two-answers for
// a CLI-internal file. `$HOME` has two reasons not to narrow now: that, and the
// EXDEV rename its own comment below records.

import path from 'node:path';
import { realpathSync, accessSync, constants as fsc } from 'node:fs';
import { isExcluded, withinPosix, excludedRefusal } from '../mirror.ts';

export type Tier = 'host' | 'project' | 'hide' | 'fail' | 'bind';

export interface TierEntry {
  tier: Tier;
  prefix: string;
  // Why this prefix is pinned, carried into the rendered file as a comment so
  // an operator reading a session's pins.txt can tell a derived entry from a
  // hand-written one — AND into the refusal a worker reads, so the sentence
  // that denies a path names the rule that denied it.
  why: string;
  // What a FILE TOOL aimed here gets. `project` allows, everything else denies,
  // EXCEPT a `localRoots`-derived entry, which carries the bit its declaration
  // gave it (see LocalRoot).
  toolAccess: 'allow' | 'deny';
}

// A host-local prefix a redirected session may name, DECLARED rather than
// listed: `access` is the whole reason this is not a bare string. Every one of
// these is host-pinned for the daemon either way — a local root the daemon
// served from the remote would answer about the wrong machine — so the bit says
// only whether a file TOOL may name it. THE ALLOW SET IS THIS ARRAY AND NOTHING
// ELSE: there is no second list of allowed prefixes anywhere in cc.
export interface LocalRoot {
  prefix: string;
  access: 'allow' | 'deny';
  why: string;
}

// The refusal classes. FOUR, and every one of them names Bash: what differs is
// what each has to say about the answer Bash gives — see the wordings below.
export type ToolDenyClass = 'excluded' | 'outside-mirror-root' | 'bind-mount' | 'host-pinned';

// UNCONDITIONAL, AND NEVER MERGED INTO THE TIER TABLE. The reasoning,
// restated once here so a later editor cannot merge them: a provider
// advertising no excludes would otherwise lose /proc bind-mounting (and
// /proc/self/exe with it), while an unusual exclude like /var/lib/secrets would
// be silently served from the host. /proc CANNOT be a tier — a passthrough
// serving /proc/self/* answers with the DAEMON's identity and breaks
// /proc/self/exe, which is how a bun single-file executable finds its embedded
// payload.
export const BIND_MOUNTS = ['/proc', '/sys', '/dev'] as const;

// Identity, name resolution, TLS trust and managed settings: the host-side
// files a CLI run needs to resolve names, trust TLS and read managed settings.
// The array below IS the artifact and the single source.
// ld.so.cache indexes THIS host's libraries; served from the
// remote it would name objects that do not exist here. ld.so.preload and
// /etc/claude-code are pinned on the hazard rather than on a measurement: a
// remote-supplied one would preload a remote object into a host binary, or
// inject settings into the CLI.
const ETC_PINS = [
  '/etc/ld.so.cache', '/etc/ld.so.preload',
  '/etc/passwd', '/etc/group', '/etc/hosts', '/etc/host.conf',
  '/etc/resolv.conf', '/etc/nsswitch.conf',
  '/etc/ssl', '/usr/share/ca-certificates',
  '/etc/claude-code',
];

// The loader's NEEDED objects plus glibc's dlopen closure — not all of it
// visible in `ldd` output, and only found by running the real CLI. A host
// libc that dlopens the REMOTE's NSS or gconv modules is a version mismatch
// waiting to happen.
//
// THE LIST IS HAND-MAINTAINED, and entries keep arriving the expensive way:
// several were added by reading the refusal log AFTER a spawn had already died
// on them. Deriving it from `ldd` of the binaries this file already pins is the
// shape that stops the next one being found that way.
const LOADER_OBJECTS = [
  '/usr/lib64/ld-linux-x86-64.so.2',
  '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  '/usr/lib/x86_64-linux-gnu/libc.so.6',
  '/usr/lib/x86_64-linux-gnu/libm.so.6',
  '/usr/lib/x86_64-linux-gnu/libdl.so.2',
  '/usr/lib/x86_64-linux-gnu/librt.so.1',
  '/usr/lib/x86_64-linux-gnu/libpthread.so.0',
  '/usr/lib/x86_64-linux-gnu/libnss_compat.so.2',
  '/usr/lib/x86_64-linux-gnu/libnss_dns.so.2',
  '/usr/lib/x86_64-linux-gnu/libnss_files.so.2',
  '/usr/lib/x86_64-linux-gnu/libnss_systemd.so.2',
  '/usr/lib/x86_64-linux-gnu/gconv',
  // DERIVED FROM THE EVENT LOG, not from a brief. Under the instrument's host
  // fallback these were served whether pinned or not, so nothing named them
  // until the `fail` tier made an unpinned NEEDED object -ENOENT:
  //
  //     /usr/local/bin/node: error while loading shared libraries:
  //     libstdc++.so.6: cannot open shared object file
  //
  // `libstdc++` and `libgcc_s` are node's own NEEDED set — a layer the CLI's
  // own loader closure does not cover, because it is reached only when node
  // itself is loaded inside the union. `libcap.so.2` is libsystemd's, reached through the
  // `libnss_systemd` dlopen closure already pinned above.
  '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
  '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
  '/usr/lib/x86_64-linux-gnu/libcap.so.2',
];

// A PIN'S TARGET IS A SECOND PIN, and this derivation belongs to EVERY pinned
// leaf rather than to the loader list alone. The tier table matches path
// STRINGS, and the union's open follows a symlink to a path that has its own
// tier — so pinning a link while its target stays unpinned is a `fail`-tier
// -ENOENT at the second hop.
//
// The loader list is where it was measured, on a pin THIS FILE DOES NOT CARRY:
// `setpriv`'s `libcap-ng.so.0`, which runs unmarked and is in neither array
// here. Pinning that link while its target `libcap-ng.so.0.0.0` stayed unpinned
// is what the refusal log named on the first fail-closed launch —
//
//     /usr/bin/setpriv: error while loading shared libraries: libcap-ng.so.0:
//     cannot open shared object file: No such file or directory
//
// — and it was invisible under the instrument's host fallback, which served the
// target whether it was pinned or not. THE MEASUREMENT IS WHAT THE DERIVATION
// RESTS ON, not a live entry: the hazard belongs to every pinned leaf, which is
// why `realpathsOf` runs over the arrays rather than over one of them.
//
// `ETC_PINS` carries the same hazard UNMEASURED HERE: nothing in it is a
// symlink on this host, but `/etc/resolv.conf` is one to
// `/run/systemd/resolve/stub-resolv.conf` on any systemd-resolved host, and
// `/run` is pinned by nothing. Derived rather than waited for, because the
// symptom is name resolution failing inside the chroot on a machine nobody has
// run this on yet.
function realpathsOf(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    try { const r = realpathSync(p); return r === p ? [] : [r]; }
    catch { return []; }   // not installed here; the pin that names it costs nothing
  });
}

// BOTH SPELLINGS OF EVERY ONE OF THEM, derived rather than hand-doubled so the
// two lists cannot drift. On a merged-usr host `/lib` and `/lib64` are symlinks
// to `/usr/lib` and `/usr/lib64` — but the tier table matches PATH STRINGS, and
// the ELF header of every binary here requests `/lib64/ld-linux-x86-64.so.2`
// literally, which the `/usr/lib64` spelling does not match.
const LOADER_PINS = [...new Set([...LOADER_OBJECTS, ...realpathsOf(LOADER_OBJECTS)].flatMap(
  p => p.startsWith('/usr/') ? [p, p.slice(4)] : [p],
))];

// THERE IS NO BOOTSTRAP-CHAIN ARRAY, AND NO `/usr/bin` ENTRY. The interpreter
// chain `bootstrap.sh`'s last step execs inside the union — the shell and
// `setpriv` — resolves UNMARKED at every geometry, and `VIEW_HOST` serves the
// orchestrator's own bytes there with or without a pin (`R13w`; the header
// block's split).
//
// `/usr/bin` IS DERIVED, never an entry: `installPins(dir, dir)` returns the
// directory itself whenever a pinned binary there is not a symlink, so on a
// host where node is `/usr/bin/node` it still arrives through
// `binaryPins(execPath)` below. Nothing names it, so nothing can delete it by
// name.

export interface TierTableInput {
  // The host-local prefixes a redirected session may legitimately reach, each
  // DECLARING whether a file tool may name it. One array, one construction site
  // (src/instances.ts), two consumers — the daemon's host pins and the hook's
  // ALLOW set — so the paths the daemon serves from the host and the paths a
  // tool may name cannot disagree.
  localRoots: readonly LocalRoot[];
  // The resolved `claude` command (RealClaudeLauncher's, i.e. resolveClaudeBin's
  // `command`) and node's own binary.
  //
  // `process.execPath` and the repo are host-pinned because the redirected Bash
  // tool is rewritten to `node <repo>/src/systems/bashForwarder.ts …` — a REAL
  // subprocess, which must run host bytes. The pin is what makes them REACHABLE
  // at all: under `mirrorRoot: "/"` both paths fall inside the remote tier's
  // boundary, and `T_PROJECT` has no host fallback by design, so an unpinned
  // caller there gets the remote's copy or -ENOENT (`policy_project_route`,
  // policy.h).
  claudeCommand: string;
  execPath: string;
  // The repo cc itself runs from — separate because it is not guaranteed to be
  // under `projectsRoot`.
  selfProjectDir: string;
  // ONE prefix, covering three things at once: the cc repo, `orchStoreRoot()`
  // (which is `projectsRoot()/.code-conductor` by construction) and the
  // `--plugin-dir` targets. Pinned so a remote box cannot shadow a host-owned
  // plugin. `fuseRunDir` still needs its narrower `hide`, and wins on it:
  // `tier_of` (union.c) skips any pin no longer than the best match so far, so
  // a longer prefix always beats a shorter one whatever the file order.
  projectsRoot: string;
  homeDir: string;
  // This session's scaffolding — hidden, so the union never serves its own
  // backing store through the host fallback.
  runDir: string;
  // The project's real path ON ITS SYSTEM.
  systemPath: string;
  // THE REMOTE TIER'S BOUNDARY — how much of the system this session may see
  // served from the system rather than from the host. It is the project's own
  // path whenever the provider advertises nothing, which is the common case and
  // the narrowest answer; a provider that advertises a wider `mirrorRoot` moves
  // this outwards. Remote only, no host fallback, which is why it is the
  // advertisement's job to be right about it (src/systems/mirror.ts).
  mirrorRoot: string;
  // THE PROVIDER'S `exclude` LIST (MirrorScope.exclude), and the SECOND
  // mechanism — never merged with BIND_MOUNTS above. Each entry inside the
  // mirror root renders `fail`: served from neither side, and refused at the
  // file-tool seam too — it fails BOTH surfaces. An exclude
  // OUTSIDE the mirror root is inert by criterion 4 and renders nothing —
  // `resolveMirrorScope` has already reported it on the session's stream.
  exclude: readonly string[];
}

// ['', 'usr', 'bin'] is the shallowest useful answer: pinning `/usr` or `/` is
// never what a caller means. A CONSTANT AND NOT A PARAMETER — the only value
// any caller would pass is this one, and a knob nothing varies invites a future
// tune of the one number this module's correctness rests on.
const PIN_FLOOR = 3;

// `dir` and every ancestor of it that clears the floor, shallowest first.
function ancestorsOf(dir: string): string[] {
  const parts = dir.split('/');
  const out: string[] = [];
  for (let i = PIN_FLOOR; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

// THE DIRECTORY PREFIXES A MARKED WALK OF A LAUNCHER NEEDS, given the
// launcher's own directory and its realpath's. The common ancestor when it
// clears the floor; otherwise the REALPATH's ancestor chain, floored the same
// way — so `/usr` and `/` are still never emitted.
//
// WHY THE FALLBACK IS THE REALPATH'S SIDE ONLY, and this is the half a reader
// would otherwise "fix" back to symmetry. The mark fires at the daemon's
// resolution of the COMMAND spelling. To reach that spelling the VFS must first
// walk the command's own ancestors, so they are resolved BEFORE the marking
// event, by an unmarked caller — and `VIEW_HOST` serves those from the
// orchestrator with or without a pin. Everything the VFS walks AFTER — the
// readlink, the realpath, and that realpath's ancestor chain — is resolved by
// an already-marked thread group, which has no host fallback. Real gate `R16`
// measures both halves: its `firstMarked` index is > 0, the first `mark=1` row
// names the link, and the realpath appears in the marked set strictly after it.
// Pinning the command side would be pinning paths no marked caller ever names.
//
// WHY THE CHAIN IS DECLARED AT THE FLOOR rather than at the first
// install-specific component, so the depth is not re-opened:
//   1. Host pins are prefix-inheriting, so `/usr/lib` SUBSUMES
//      `/usr/lib/node_modules` and everything under it. The floor is not a
//      wider class of grant — it is the same grant, one level up.
//   2. It is strictly more robust, and the residual is the benign one. Neither
//      depth removes the dependence on unpinnable ancestors existing on the
//      remote; this one reduces it to `/usr` alone, which every Linux rootfs
//      that could host a provider has. The SECOND component is the
//      install-specific one — `/usr/lib` vs `/usr/lib64` vs `/usr/share` vs
//      `/usr/lib/<triplet>` vary by distro, and a minimal remote image can
//      legitimately lack the one cc's own layout uses.
//   3. It adds one rule, not two: the floor, applied to the chain instead of to
//      a single common ancestor.
//   4. The cost is near-nil. A host pin refuses a worker's file tools on that
//      subtree under `mirrorRoot: '/'` — but `/usr/lib` is never inside a
//      project tree, so no worker legitimately edits through the union there.
export function installPins(cmdDir: string, realDir: string): string[] {
  const as = cmdDir.split('/'), bs = realDir.split('/');
  const common: string[] = [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) break;
    common.push(as[i]);
  }
  if (common.length >= PIN_FLOOR) return [common.join('/')];
  return ancestorsOf(realDir);
}

// A BARE COMMAND NAME RESOLVED AGAINST CC'S OWN PATH, the way the bootstrap's
// final `setpriv` resolves it INSIDE the chroot — `wrap.ts` puts cc's PATH in
// the worker environment file and the bootstrap sources it immediately before
// that exec, so the two lookups see the same list.
//
// IT STOPPED BEING OPTIONAL WHEN `T_FAIL` REACHED ENUM INDEX 0. Under the
// instrument's remote-first-with-host-fallback default an unpinned launcher
// still ran, from the host, so a bare `claude` costing no pin was invisible.
// Fail-closed, an unpinned launcher is `-ENOENT` and the CLI cannot exec at
// all — and `resolveClaudeBin()` returns a bare `claude` by default.
//
// '' when nothing on PATH matches: an unresolvable launcher is the caller's
// refusal to make, not this module's.
export function resolveOnPath(cmd: string): string {
  if (!cmd) return '';
  if (path.isAbsolute(cmd)) return cmd;
  if (cmd.includes('/')) return path.resolve(cmd);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { accessSync(p, fsc.X_OK); return p; } catch { /* next entry */ }
  }
  return '';
}

// A launcher binary's pins: the path itself, its realpath, and whatever
// `installPins` derives above the two — one prefix where they share a deep
// enough ancestor, the realpath's ancestor chain where they do not. Pinning the
// leaves alone left every parent directory in an npm-global chain falling back
// on a getattr.
//
// TWO CALLERS, both in `buildTierTable`: `claudeCommand` and `execPath`.
export function binaryPins(bin: string): string[] {
  const abs = resolveOnPath(bin);
  if (!abs) return [];
  bin = abs;
  const out = [bin];
  let real = bin;
  try { real = realpathSync(bin); } catch { /* not installed here; pin what we were given */ }
  if (real !== bin) out.push(real);
  out.push(...installPins(path.dirname(bin), path.dirname(real)));
  return out;
}

// ── FROM A LOGGED DENIAL TO A PIN ENTRY ─────────────────────────────────────
//
// THE OWNER'S MECHANISM, NOT A FALLBACK: "I want one method that works. I'm
// fine with a list plus a logging system, allowing the user (or a Claude
// session) to update the list." The daemon's event log names the path; this
// says which of the two arrays in THIS file to put it in and in which
// spelling. No runtime derivation, ever — the suggestion is text a human or a
// session applies.
//
// IT LIVES HERE BECAUSE THIS FILE OWNS THE ARRAYS. A copy anywhere else would
// be a second source of truth for a mapping whose whole value is naming the
// real one.
//
// THE FOUR-STEP UPDATE PATH, which the emitted line states so nobody has to
// know it: (1) the arrays are `LOADER_OBJECTS` and `ETC_PINS` in this file, and
// there is no second copy in cc; (2) add the `entry` to the `list`; (3)
// `buildTierTable` runs per spawn and `renderPinsFile` writes
// `<rundir>/pins.txt`, which the daemon parses at mount — so the change takes
// effect on the NEXT SPAWN AFTER AN ORCHESTRATOR RESTART, because cc holds this
// module in memory; (4) `npm test` re-runs the tier-table tests, which pin both
// spellings, the realpath closure, the install-prefix derivation and the
// realpath ancestor chain `installPins` falls back to.
export interface PinSuggestion {
  list: 'LOADER_OBJECTS' | 'ETC_PINS' | null;
  // The exact string to add to `list`, which is NOT always the path the daemon
  // refused — see the `/usr/` canonicalisation below.
  entry: string;
  note: string;
}

const LIB_DIRS = ['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'];
const BIN_DIRS = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/'];

// THE `/usr/`-PREFIXED SPELLING, AND IT IS LOAD-BEARING RATHER THAN TIDY.
// `LOADER_PINS` derives the `/lib` spelling AND the realpath from whatever is
// in `LOADER_OBJECTS`, so an entry added in the `/lib` spelling leaves the
// closure open — which is exactly the `libcap-ng.so.0.0.0` failure this file's
// own comment records. Adding the `/usr/` spelling gets both spellings and the
// realpath; adding the other one gets neither.
function usrSpelling(p: string): string {
  return p.startsWith('/lib/') || p.startsWith('/lib64/') ? `/usr${p}` : p;
}

export function suggestPin(refusedPath: string): PinSuggestion {
  const restart = 'the pin list is read at the next spawn AFTER an orchestrator restart — cc holds src/systems/fuse/tierTable.ts in memory';
  if (refusedPath.startsWith('/etc/')) {
    return { list: 'ETC_PINS', entry: refusedPath, note: restart };
  }
  // A SHARED OBJECT BY NAME **OR** BY LOCATION. The name test catches a
  // versioned soname anywhere; the location test catches everything else the
  // loader reaches for (a `gconv` directory, an NSS module's data file) that
  // carries no `.so` suffix at all.
  if (/\.so(\.\d+)*$/.test(path.basename(refusedPath)) || LIB_DIRS.some(d => refusedPath.startsWith(d))) {
    return {
      list: 'LOADER_OBJECTS',
      entry: usrSpelling(refusedPath),
      note: `add the /usr/-prefixed spelling: LOADER_PINS derives the /lib spelling AND the realpath from it, so the other spelling leaves the closure open. Then ${restart}`,
    };
  }
  // A BIN DIRECTORY IS NOT A GUESS, and the note says what the denial
  // MEANS rather than naming an array. `bootstrap.sh` fires no marking event,
  // so the chroot'd shell, `setpriv` and the backend launch command are all
  // unmarked and host-served without any pin — a refusal here therefore means
  // the MARKED CLI reached for it, and the first thing to check is whether it
  // is the launcher's own closure, which `binaryPins(claudeCommand)` already
  // pins.
  if (BIN_DIRS.some(d => refusedPath.startsWith(d))) {
    return {
      list: null,
      entry: refusedPath,
      note: `a bin-directory refusal means the MARKED CLI named this — the bootstrap's own shell and setpriv are unmarked and host-served with no pin. Check first whether it is the launcher's own closure, which binaryPins(claudeCommand) pins automatically. If it is not, no array here owns it: LOADER_OBJECTS is the loader's NEEDED/dlopen closure and ETC_PINS is /etc, and a bin path in either lands where those derivations say nothing about it. The one declared mechanism for a host-local prefix is the session's localRoots (declared at the ONE construction site, src/instances.ts). Then ${restart}`,
    };
  }
  // NO GUESS, AND IT NAMES EVERY PLACE A HUMAN MIGHT PUT IT. A wrong array is
  // worse than no suggestion: the entry lands somewhere the derivations do not
  // apply and the path stays refused for a reason the log no longer explains.
  return {
    list: null,
    entry: refusedPath,
    note: `no array in src/systems/fuse/tierTable.ts obviously owns this path — decide between LOADER_OBJECTS, ETC_PINS and the session's localRoots (which are declared at the ONE construction site, src/instances.ts). Then ${restart}`,
  };
}

export function buildTierTable(input: TierTableInput): TierEntry[] {
  const entries: TierEntry[] = [];
  // `project` is the only tier a file tool may name by tier alone; every other
  // one denies. A localRoot goes in through `addLocal` instead, carrying the bit
  // its declaration gave it.
  const add = (tier: Tier, prefix: string, why: string): void => {
    if (!prefix || !path.isAbsolute(prefix)) return;
    entries.push({ tier, prefix, why, toolAccess: tier === 'project' ? 'allow' : 'deny' });
  };
  const addLocal = (r: LocalRoot): void => {
    if (!r.prefix || !path.isAbsolute(r.prefix)) return;
    entries.push({ tier: 'host', prefix: r.prefix, why: r.why, toolAccess: r.access });
  };

  for (const p of binaryPins(input.claudeCommand)) add('host', p, "the CLI binary, its realpath and the realpath's install chain — all walked MARKED");
  for (const p of binaryPins(input.execPath)) add('host', p, 'node — the Bash forwarder is a real subprocess that must run host bytes');
  add('host', input.selfProjectDir, "cc's own checkout — the Bash forwarder's script lives here");
  add('host', input.projectsRoot, 'the projects root: the cc repo, the store and the plugin dirs in one prefix');
  // THE WHOLE HOME DIRECTORY, not ~/.claude, and that is forced by a
  // measurement: the CLI's config update is `mkdir ~/.claude.json.lock` /
  // `create ~/.claude.json.tmp.<pid>` / `rename ~/.claude.json`, which straddles
  // $HOME. A pin boundary between a temp file and its rename target produces
  // EXDEV, because renameat2 cannot cross backing stores.
  add('host', input.homeDir, "the CLI's own state — the whole home dir, because its config update straddles it");
  for (const r of input.localRoots) addLocal(r);
  for (const p of ETC_PINS) add('host', p, 'identity, name resolution, TLS trust, managed settings');
  for (const p of realpathsOf(ETC_PINS)) add('host', p, "the target of a pinned /etc symlink — the union's open follows it, and the target has its own tier");
  for (const p of LOADER_PINS) add('host', p, "the loader's NEEDED set and glibc's dlopen closure");
  // Longest prefix wins, so this overrides the store/projects-root host pins
  // above and the union never serves its own scaffolding.
  add('hide', input.runDir, "this session's own mount scaffolding");
  // THE TWO MECHANISMS, adjacent so the never-merge rule is visible, and in
  // THIS ORDER because the first occurrence of a prefix wins below: a provider
  // that excludes `/proc` must still get `bind /proc`, or `bootstrap.sh`'s
  // `mount --bind` lands on a path the daemon answers -ENOENT for and the
  // launch dies. The tool is denied either way; which mechanism names the
  // refusal is the only difference.
  //
  // `bind` reaches the daemon at all because those three targets have to EXIST
  // as directories for the bind to succeed — under the `fail` tier an unpinned
  // path does not.
  for (const b of BIND_MOUNTS) add('bind', b, "the orchestrator's own, bind-mounted over the union so the CLI works");
  for (const e of input.exclude) {
    if (withinPosix(e, input.mirrorRoot) === null) continue;
    add('fail', e, `excluded from file mirroring by the system's own advertisement`);
  }
  // THE REMOTE TIER'S BOUNDARY first, the project inside it second. Both are
  // `project`, and longest-prefix means the project's own entry wins where they
  // differ; naming both keeps a wider advertised root remote-only rather than
  // letting the space between it and the project fall to the host.
  add('project', input.mirrorRoot, "the system's advertised mirror root — remote only, no host fallback");
  add('project', input.systemPath, 'the project tree at its real remote path');

  // First occurrence of a prefix wins: a duplicate is a second spelling of an
  // already-decided rule, and silently letting a later one override would make
  // the table's meaning depend on its construction order.
  const seen = new Set<string>();
  return entries.filter(e => !seen.has(e.prefix) && (seen.add(e.prefix), true));
}

// The daemon's pins file: `<tier>\t<prefix>` per line, longest prefix wins
// (union.c's pins_load).
export function renderPinsFile(entries: readonly TierEntry[]): string {
  const lines = ['# generated by cc — src/systems/fuse/tierTable.ts. Do not edit.'];
  for (const e of entries) {
    lines.push(`# ${e.why}`);
    lines.push(`${e.tier}\t${e.prefix}`);
  }
  return lines.join('\n') + '\n';
}

// ── THE HOOK'S HALF OF THE ONE ARTIFACT ─────────────────────────────────────
//
// `classifyForTool` is what a PreToolUse hook asks about a file tool's path,
// and it reads THE SAME `TierEntry[]` the pins file was rendered from — that
// identity is criterion 15's mechanism, and there is no second table to keep in
// step.
//
// IT NEVER TOUCHES THE FILESYSTEM, and that is structural rather than a habit:
// criterion 11 forbids deciding by probing the mirror. A project path the
// mirror has not materialised yet is ALLOWED — the union materialises it when
// the CLI opens it, so a probe would deny exactly the first read of every file.

// The session facts a refusal has to name. `exclude` is the ADVERTISEMENT's
// list, which is what the excluded refusal quotes: the table says a deny
// happens, the advertisement says which rule caused it.
export interface ToolAccessSession {
  exclude: readonly string[];
  mirrorRoot: string;
  systemId: string;
  systemPath: string;
}

export type ToolAccessDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; class: ToolDenyClass; reason: string };

// Longest prefix wins, matched at a COMPONENT BOUNDARY — the same rule
// union.c's `tier_of` applies, so the hook and the daemon agree about which
// entry owns a path. `/tmp/apple` must not match the pin `/tmp/app`.
//
// Exported because it answers the DAEMON's question too — "which entry owns
// this path" — and a test that wanted that answer would otherwise transcribe
// the rule a third time.
export function resolveTierEntry(entries: readonly TierEntry[], p: string): TierEntry | null {
  const len = (e: TierEntry): number => (e.prefix === '/' ? 1 : e.prefix.length);
  let best: TierEntry | null = null;
  for (const e of entries) {
    if (best !== null && len(e) <= len(best)) continue;
    if (!p.startsWith(e.prefix)) continue;
    if (e.prefix !== '/' && p.length > e.prefix.length && p[e.prefix.length] !== '/') continue;
    best = e;
  }
  return best;
}

export function classifyForTool(
  entries: readonly TierEntry[],
  session: ToolAccessSession,
  p: string,
): ToolAccessDecision {
  const entry = resolveTierEntry(entries, p);
  // NO ENTRY AT ALL means outside the remote tier's boundary and outside every
  // host pin: the mirror root is itself a `project` entry, so nothing inside it
  // can land here.
  if (entry === null) {
    return { decision: 'deny', class: 'outside-mirror-root', reason: outsideMirrorRefusal(p, session) };
  }
  if (entry.toolAccess === 'allow') return { decision: 'allow' };
  switch (entry.tier) {
    case 'bind':
      return { decision: 'deny', class: 'bind-mount', reason: bindMountRefusal(p, entry, session.systemId) };
    case 'fail':
      // The advertisement names the rule. A `fail` entry exists only because an
      // exclude produced it, so the lookup cannot miss; the entry's own prefix
      // is the same string and stands in only to keep this total.
      return { decision: 'deny', class: 'excluded', reason: excludedRefusal(p, session.systemId, isExcluded(p, session.exclude) ?? entry.prefix) };
    default:
      return { decision: 'deny', class: 'host-pinned', reason: hostPinnedRefusal(p, entry, session.systemId) };
  }
}

// ── the three refusals `excludedRefusal` (src/systems/mirror.ts) does not cover
//
// All four keep ITS anti-ENOENT discipline — cc named as the actor, the act
// named as a refusal, the PREFIX named so the model generalises, and an explicit
// "this is not the file being absent" — because the failure mode is the same one
// in every class: a model that reads a refusal as file-not-found concludes the
// file is absent instead of using the channel that works.
//
// WHERE THEY DIVERGE IS WHETHER THERE **IS** SUCH A CHANNEL, and that is the
// whole reason there are four wordings rather than one.

// OUTSIDE THE REMOTE TIER'S BOUNDARY. Bash execs on the system and reaches this
// path, so the channel exists and is named.
//
// IT ALSO NAMES THE PROJECT'S OWN TREE, which is what a worker overwhelmingly
// wanted — a refusal that only says "not that one" costs a call to find out
// where the files actually are.
function outsideMirrorRefusal(p: string, session: ToolAccessSession): string {
  return `cc will not bridge '${p}' to this session: this session's file tools reach system `
    + `'${session.systemId}' only under '${session.mirrorRoot}', the mirror root that system `
    + `advertises, and '${p}' is outside it. This project's tree is at '${session.systemPath}', `
    + `and its files are read and edited there. This is cc refusing to carry the file, NOT the file `
    + `being absent — cc has not looked, and this says nothing about whether it exists. Bash runs on `
    + `'${session.systemId}' with the whole filesystem in reach: read it with \`cat\`, change it `
    + `with \`sed -i\` or a \`>\` redirect there instead.`;
}

// A BIND MOUNT. The channel exists, and the extra clause is WHOSE KERNEL: this
// path inside the chroot is the orchestrator's own, so a file tool and a Bash
// command would answer about different machines, and only one of them is the
// machine the worker is asking about.
function bindMountRefusal(p: string, entry: TierEntry, systemId: string): string {
  return `cc will not bridge '${p}' to this session: '${entry.prefix}' inside this session is the `
    + `ORCHESTRATOR's own — ${entry.why} — so a file tool aimed there would answer about the `
    + `orchestrator's kernel and not about system '${systemId}'. This is cc refusing to carry the `
    + `file, NOT the file being absent — cc has not looked. Bash runs on '${systemId}' and answers `
    + `the same question about the right kernel: read it with \`cat\` there instead.`;
}

// A HOST PIN, and the session's own hidden scaffolding with it. Like the other
// three, it names Bash — and unlike them it has to say WHICH MACHINE Bash
// answers from, because here the same path exists on both.
//
// WHY IT NAMES BASH AT ALL. A dead-end wording buys no concealment: the worker
// can `ls ~/` through Bash and reach the system's home directory whether this
// sentence mentions it or not. What the dead end actually cost was the worker's
// next move — it left the agent stuck without preventing anything.
//
// WHY THE REMOTE QUALIFIER IS LOAD-BEARING AND NOT DECORATION. A path pinned
// here is pinned because the ORCHESTRATOR needs it: `~/.claude`, the cc
// checkout, `/etc/nsswitch.conf`. Bash execs on the SYSTEM, so `cat` there
// resolves the same string against the system's own filesystem and answers with
// a different file. For an OS path that is exactly right — a question about the
// system's name resolution wants the system's `/etc/hosts`. For a cc-shaped
// path it is a real file that is not cc's, and an unqualified "use Bash" would
// have the agent read it as authoritative. Saying which machine answers is what
// keeps the same sentence true in both cases.
function hostPinnedRefusal(p: string, entry: TierEntry, systemId: string): string {
  return `cc will not bridge '${p}' to this session: '${entry.prefix}' is pinned to the `
    + `ORCHESTRATOR's machine (${entry.why}) so the local CLI can run there, and this session's `
    + `file tools do not carry it. This is cc refusing to carry the file, NOT the file being `
    + `absent — cc has not looked, and this says nothing about whether it exists. Bash runs ON `
    + `SYSTEM '${systemId}', not on the orchestrator: \`cat '${p}'\` there answers with system `
    + `'${systemId}''s own file at that path IF IT HAS ONE, which is the right answer for a `
    + `question about '${systemId}' and is NOT the orchestrator's copy this refusal is about.`;
}
