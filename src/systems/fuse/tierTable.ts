// THE tier/deny artifact. One table, handed to the daemon as its pins file in
// S1 and to the hook's deny surface in S2 — the epic requires them to be one
// artifact or they drift.
//
// A tier is a longest-prefix rule over absolute paths:
//   host    → served from the orchestrator's own filesystem
//   project → served from the remote tier (the mirror), remote only
//   hide    → served from neither; the union must not see its own scaffolding
//   bind    → a directory `bootstrap.sh` bind-mounts the ORCHESTRATOR's own over
//   fail    → served from neither, because the provider excluded it
//
// Each entry also carries `toolAccess`, which is what the HOOK does with a file
// tool aimed at it (`classifyForTool` below). That is the epic's criterion 15:
// the daemon's pins file and the hook's deny table are ONE artifact, rendered
// and read from the same array, so they cannot drift.
//
// THE LOAD-BEARING INVARIANT: a host-pinned path keeps its EXACT spelling
// inside the chroot. That is what lets spawnEnv's HOME and CLAUDE_CODE_TMPDIR,
// the inline --settings / --mcp-config JSON and every --plugin-dir argument
// ride through the wrap unmodified.
//
// ── WHAT THE LIST HAS TO COVER SINCE CARD 2026-0382, AND WHAT IT NO LONGER DOES
//
// THE LIST DOES NOT SHRINK — IT STOPS GROWING. `fail → host` for an unmarked
// caller (`policy_caller_tier`, policy.h) means the arrays below have to cover
// **the CLI's own execution closure and nothing else**: its NEEDED set, its
// dlopen closure, its settings, its temp paths. They no longer have to grow
// when somebody installs a new tool on the host, which is what every past
// addition here was — a new shell, a new binary, a new library that some
// UNMARKED subprocess reached for. Nothing below is deleted, and the reason is
// the next paragraph.
//
// EVERY ENTRY STAYS, BECAUSE "DEAD" IS CONFIGURATION-DEPENDENT. A pin is dead
// only if every path it covers is read exclusively by an unmarked caller — and
// only under the DEFAULT `mirrorRoot` (= the project's own path), where an
// unpinned path is `fail` and an unmarked caller is served the host anyway.
//
// UNDER AN ADVERTISED `mirrorRoot: '/'` EVERY ENTRY BELOW IS LOAD-BEARING
// AGAIN, AND FOR THE MARKED CALLER. `add('project', '/')` covers everything
// unpinned, so `tier_of` can never return `T_FAIL` and an unpinned `/bin/sh`
// would be `project` tier — i.e. the REMOTE's shell, not the orchestrator's
// one the chroot is built around. The pin is a longer prefix than `project /`,
// which is the only thing keeping it host-served FOR THE MARKED CLI. (What is
// NOT the reason, and has not been since card 2026-0388: it is not that an
// UNMARKED caller loses anything here. Since card 2026-0398 an unmarked caller
// resolves in `VIEW_HOST`, where every `project` pin is struck — so it is served
// the orchestrator's own `/bin/sh` at a wide root with or without these pins,
// and at every other geometry identically. The pins are for the CLI.) Measured
// by building the real table both ways.
//
// The split, from the measured pre-mark window plus `ldd`, recorded rather than
// acted on:
//   DEAD (default config only)  BOOTSTRAP_CHAIN's `/bin/sh`, `/usr/bin/sh`,
//     `/bin/dash`, `/usr/bin/dash` — the shell loads at pre-mark ops 18–44 and
//     no marked caller ever execs it. `/bin/bash`, `/usr/bin/bash` were already
//     dead: `bootstrap.sh` execs `/bin/sh`.
//   LOAD-BEARING  everything else, and each for a measured reason — `setpriv`
//     execs AFTER the mark in the same tgid; `ld-linux` and `libc` are measured
//     on both sides of it; node's own NEEDED set and glibc's dlopen closure are
//     all post-mark; `/etc/ld.so.cache` and `/etc/passwd`/`/etc/group` are the
//     marked CLI's and setpriv's; `/etc/hosts` and the TLS trust are the marked
//     CLI's own DNS and TLS. `/etc/ld.so.preload` and `/etc/claude-code` are
//     pinned on the HAZARD rather than on a measurement — a remote-supplied one
//     would preload a remote object into a host binary, or inject settings into
//     the CLI — and that stays an inference, said so here.
//
// A THIRD CLASS, OUTSIDE THESE THREE ARRAYS AND LOAD-BEARING FOR THE RULING:
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

// UNCONDITIONAL, AND NEVER MERGED INTO THE TIER TABLE. The epic's reasoning,
// restated once here so a later editor cannot merge them: a provider
// advertising no excludes would otherwise lose /proc bind-mounting (and
// /proc/self/exe with it), while an unusual exclude like /var/lib/secrets would
// be silently served from the host. /proc CANNOT be a tier — a passthrough
// serving /proc/self/* answers with the DAEMON's identity and breaks
// /proc/self/exe, which is how a bun single-file executable finds its embedded
// payload (S1 §7.1, measured).
export const BIND_MOUNTS = ['/proc', '/sys', '/dev'] as const;

// Identity, name resolution, TLS trust and managed settings, from
// rig/pins.s3.txt. ld.so.cache indexes THIS host's libraries; served from the
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

// The six NEEDED objects (S1 §5.1) plus glibc's dlopen closure, which is in
// neither `ldd` nor the brief and was found only by running the thing. A host
// libc that dlopens the REMOTE's NSS or gconv modules is a version mismatch
// waiting to happen.
//
// `libcap-ng.so.0` is `setpriv`'s, from `ldd` on this host — one layer below
// the interpreter chain above, and covered by no other entry here.
const LOADER_OBJECTS = [
  '/usr/lib64/ld-linux-x86-64.so.2',
  '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  '/usr/lib/x86_64-linux-gnu/libc.so.6',
  '/usr/lib/x86_64-linux-gnu/libm.so.6',
  '/usr/lib/x86_64-linux-gnu/libdl.so.2',
  '/usr/lib/x86_64-linux-gnu/librt.so.1',
  '/usr/lib/x86_64-linux-gnu/libpthread.so.0',
  '/usr/lib/x86_64-linux-gnu/libcap-ng.so.0',
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
  // `libstdc++` and `libgcc_s` are node's own NEEDED set — one layer the S1
  // brief's six objects did not cover, because S1 never had to load node inside
  // the union. `libcap.so.2` is libsystemd's, reached through the
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
// The loader list is where it was measured. Pinning `libcap-ng.so.0` while its
// target `libcap-ng.so.0.0.0` stayed unpinned is what the refusal log named on
// the first fail-closed launch —
//
//     /usr/bin/setpriv: error while loading shared libraries: libcap-ng.so.0:
//     cannot open shared object file: No such file or directory
//
// — and it was invisible under the instrument's host fallback, which served the
// target whether it was pinned or not.
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
// literally, which the `/usr/lib64` spelling does not match. Same class as the
// interpreter chain, one layer down.
const LOADER_PINS = [...new Set([...LOADER_OBJECTS, ...realpathsOf(LOADER_OBJECTS)].flatMap(
  p => p.startsWith('/usr/') ? [p, p.slice(4)] : [p],
))];

// THE INTERPRETER CHAIN `bootstrap.sh`'S LAST STEP EXECS **INSIDE** THE UNION,
// as root and before the privilege drop: `chroot $ROOT /bin/sh -c '... exec
// setpriv ...'`. Unpinned, those paths take the remote-first `default:` arm
// (union.c:940), so which side answers depends on the remote's contents. Nearly
// unreachable with S1's narrow fixture and load-bearing the moment S2 widens
// `mirrorRoot` to `/`.
//
// Both spellings of each, because which one exists is a distribution choice and
// a pin that matches nothing costs nothing. `chroot` itself is NOT here: it runs
// on the host, before the union is entered. What these binaries in turn need —
// the ELF interpreter and `libcap-ng` — is in LOADER_PINS above.
const BOOTSTRAP_CHAIN = [
  '/bin/sh', '/usr/bin/sh', '/bin/dash', '/usr/bin/dash', '/bin/bash', '/usr/bin/bash',
  '/usr/bin/setpriv', '/bin/setpriv',
];

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
  // subprocess, which must run host bytes. What the pin buys differs by stage:
  //   * S1 (`route=path`, frozen daemon): DETERMINISM, not availability. An
  //     unpinned path takes the `default:` arm, which is remote-first
  //     (union.c:940) with a host fallback (:948) — so it works, but which side
  //     answers depends on the fake remote's contents rather than on cc's
  //     configuration. The pin moves it to the unconditional host arm (:893).
  //   * S2/S3: REACHABILITY. Once the `fail` tier replaces `default` and
  //     `mirrorRoot: "/"` puts both paths inside the remote tier's boundary,
  //     the pin is the only thing keeping them reachable at all — T_PROJECT has
  //     no host side by design (:903-909), so a caller there gets the remote's
  //     copy (:914) or -ENOENT (:912).
  claudeCommand: string;
  execPath: string;
  // The repo cc itself runs from — separate because it is not guaranteed to be
  // under `projectsRoot`.
  selfProjectDir: string;
  // ONE prefix, covering three things at once: the cc repo, `orchStoreRoot()`
  // (which is `projectsRoot()/.code-conductor` by construction) and the
  // `--plugin-dir` targets. This is the handover §3 entry, pinned so a remote
  // box cannot shadow a host-owned plugin. `fuseRunDir` still needs its
  // narrower `hide`, and wins on it: `tier_of` (union.c:236-257) skips any pin
  // no longer than the best match so far, so a longer prefix always beats a
  // shorter one whatever the file order.
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
  // file-tool seam too, which is the epic's "fails both surfaces". An exclude
  // OUTSIDE the mirror root is inert by criterion 4 and renders nothing —
  // `resolveMirrorScope` has already reported it on the session's stream.
  exclude: readonly string[];
}

// The common ancestor of two absolute paths, or null when they share nothing
// deeper than a single top-level component (pinning `/usr` or `/` is never what
// a caller means).
function installPrefix(a: string, b: string): string | null {
  const as = a.split('/'), bs = b.split('/');
  const out: string[] = [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) break;
    out.push(as[i]);
  }
  // ['', 'usr', 'bin'] is the shallowest useful answer.
  return out.length >= 3 ? out.join('/') : null;
}

// A BARE COMMAND NAME RESOLVED AGAINST CC'S OWN PATH, the way the bootstrap's
// final `setpriv` resolves it INSIDE the chroot — `wrap.ts` carries cc's PATH
// through as `CC_FUSE_PATH` and the bootstrap restores it immediately before
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

// A launcher binary's pins: the path itself, its realpath, and the install
// prefix above both. Pinning the leaves alone left every parent directory in an
// npm-global chain falling back on a getattr (rig/pins.s3.txt); one prefix
// covers the walk.
export function binaryPins(bin: string): string[] {
  const abs = resolveOnPath(bin);
  if (!abs) return [];
  bin = abs;
  const out = [bin];
  let real = bin;
  try { real = realpathSync(bin); } catch { /* not installed here; pin what we were given */ }
  if (real !== bin) out.push(real);
  const prefix = installPrefix(path.dirname(bin), path.dirname(real));
  if (prefix) out.push(prefix);
  return out;
}

// ── FROM A LOGGED DENIAL TO A PIN ENTRY ─────────────────────────────────────
//
// THE OWNER'S MECHANISM, NOT A FALLBACK: "I want one method that works. I'm
// fine with a list plus a logging system, allowing the user (or a Claude
// session) to update the list." The daemon's event log names the path; this
// says which of the three arrays in THIS file to put it in and in which
// spelling. No runtime derivation, ever — the suggestion is text a human or a
// session applies.
//
// IT LIVES HERE BECAUSE THIS FILE OWNS THE ARRAYS. A copy anywhere else would
// be a second source of truth for a mapping whose whole value is naming the
// real one.
//
// THE FOUR-STEP UPDATE PATH, which the emitted line states so nobody has to
// know it: (1) the arrays are `LOADER_OBJECTS`, `ETC_PINS`, `BOOTSTRAP_CHAIN`
// in this file, and there is no second copy in cc; (2) add the `entry` to the
// `list`; (3) `buildTierTable` runs per spawn and `renderPinsFile` writes
// `<rundir>/pins.txt`, which the daemon parses at mount — so the change takes
// effect on the NEXT SPAWN AFTER AN ORCHESTRATOR RESTART, because cc holds this
// module in memory; (4) `npm test` re-runs the tier-table tests, which pin both
// spellings, the realpath closure and the install-prefix derivation.
export interface PinSuggestion {
  list: 'LOADER_OBJECTS' | 'ETC_PINS' | 'BOOTSTRAP_CHAIN' | null;
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
  if (BIN_DIRS.some(d => refusedPath.startsWith(d))) {
    return { list: 'BOOTSTRAP_CHAIN', entry: refusedPath, note: `binaryPins derives its realpath and install prefix. Then ${restart}` };
  }
  // NO GUESS, AND IT NAMES EVERY PLACE A HUMAN MIGHT PUT IT. A wrong array is
  // worse than no suggestion: the entry lands somewhere the derivations do not
  // apply and the path stays refused for a reason the log no longer explains.
  return {
    list: null,
    entry: refusedPath,
    note: `no array in src/systems/fuse/tierTable.ts obviously owns this path — decide between LOADER_OBJECTS, ETC_PINS, BOOTSTRAP_CHAIN and the session's localRoots (which are declared at the ONE construction site, src/instances.ts). Then ${restart}`,
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

  for (const p of binaryPins(input.claudeCommand)) add('host', p, 'the CLI binary and its install prefix');
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
  for (const b of BOOTSTRAP_CHAIN) for (const p of binaryPins(b)) add('host', p, "the bootstrap's interpreter chain, exec'd inside the union as root");
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
