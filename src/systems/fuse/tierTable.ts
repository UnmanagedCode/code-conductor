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
  // DERIVED FROM THE REFUSAL LOG, not from a brief. Under the instrument's host
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

export type ToolDenyClass = 'excluded' | 'outside-mirror-root' | 'bind-mount' | 'host-pinned';

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

// A HOST PIN (or the session's own hidden scaffolding) — A DEAD END, and it says
// so. This one deliberately does NOT point at Bash and must never name it: Bash
// execs on the system, which cannot see the orchestrator's own files either, so
// naming it would cost the worker a wasted call and its trust in the next
// refusal. What the worker needs to know is that there is nothing to try.
function hostPinnedRefusal(p: string, entry: TierEntry, systemId: string): string {
  return `cc will not bridge '${p}' to this session: '${entry.prefix}' is the orchestrator's own `
    + `(${entry.why}), pinned to the orchestrator's machine, while this project's files live on `
    + `system '${systemId}'. NO channel this session has reaches '${p}' on the system — every `
    + `command this session runs, runs on '${systemId}' — so there is nothing here to retry through `
    + `another tool. This is cc refusing to carry the file, NOT the file being absent — cc has not `
    + `looked, and this says nothing about whether it exists.`;
}
