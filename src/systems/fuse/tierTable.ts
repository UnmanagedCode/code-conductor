// THE tier/deny artifact. One table, handed to the daemon as its pins file in
// S1 and to the hook's deny surface in S2 — the epic requires them to be one
// artifact or they drift.
//
// A tier is a longest-prefix rule over absolute paths:
//   host    → served from the orchestrator's own filesystem
//   project → served from the remote tier (the mirror), remote only
//   hide    → served from neither; the union must not see its own scaffolding
//
// THE LOAD-BEARING INVARIANT: a host-pinned path keeps its EXACT spelling
// inside the chroot. That is what lets spawnEnv's HOME and CLAUDE_CODE_TMPDIR,
// the inline --settings / --mcp-config JSON and every --plugin-dir argument
// ride through the wrap unmodified.

import path from 'node:path';
import { realpathSync } from 'node:fs';

export type Tier = 'host' | 'project' | 'hide';

export interface TierEntry {
  tier: Tier;
  prefix: string;
  // Why this prefix is pinned, carried into the rendered file as a comment so
  // an operator reading a session's pins.txt can tell a derived entry from a
  // hand-written one.
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
];

// BOTH SPELLINGS OF EVERY ONE OF THEM, derived rather than hand-doubled so the
// two lists cannot drift. On a merged-usr host `/lib` and `/lib64` are symlinks
// to `/usr/lib` and `/usr/lib64` — but the tier table matches PATH STRINGS, and
// the ELF header of every binary here requests `/lib64/ld-linux-x86-64.so.2`
// literally, which the `/usr/lib64` spelling does not match. Same class as the
// interpreter chain, one layer down.
const LOADER_PINS = [...new Set([
  ...LOADER_OBJECTS,
  ...LOADER_OBJECTS.map(p => p.startsWith('/usr/') ? p.slice(4) : p),
])];

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
  // The host-local paths a redirected session may legitimately reach. cc
  // already owns this set (see Instance create → SessionRedirect.localRoots);
  // it is READ here rather than restated, so the pin list and the file-tool
  // allowance cannot disagree.
  localRoots: readonly string[];
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
  // The project's real path ON ITS SYSTEM. Remote only, no fallback.
  systemPath: string;
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

// A launcher binary's pins: the path itself, its realpath, and the install
// prefix above both. Pinning the leaves alone left every parent directory in an
// npm-global chain falling back on a getattr (rig/pins.s3.txt); one prefix
// covers the walk.
export function binaryPins(bin: string): string[] {
  if (!bin || !path.isAbsolute(bin)) return [];
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
  const add = (tier: Tier, prefix: string, why: string): void => {
    if (!prefix || !path.isAbsolute(prefix)) return;
    entries.push({ tier, prefix, why });
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
  for (const r of input.localRoots) add('host', r, 'a local root this session\'s file tools may name');
  for (const b of BOOTSTRAP_CHAIN) for (const p of binaryPins(b)) add('host', p, "the bootstrap's interpreter chain, exec'd inside the union as root");
  for (const p of ETC_PINS) add('host', p, 'identity, name resolution, TLS trust, managed settings');
  for (const p of LOADER_PINS) add('host', p, "the loader's NEEDED set and glibc's dlopen closure");
  // Longest prefix wins, so this overrides the store/projects-root host pins
  // above and the union never serves its own scaffolding.
  add('hide', input.runDir, "this session's own mount scaffolding");
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
