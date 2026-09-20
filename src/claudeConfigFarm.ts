// THE SYMLINK FARM that makes a per-remote CLI config directory share the
// host's real one for everything except the entries that must not be shared.
//
// `remoteConfigDir()` (src/projects.ts) names the directory; this module fills
// it. A worker on a remote is launched with `CLAUDE_CONFIG_DIR` pointing there,
// so the CLI's cwd-derived transcript directory is scoped by a root that
// already differs per machine — which is the whole of the isolation. Everything
// the operator configured once (settings, plugins, skills, agents, history)
// still comes from one place, reached through a link.
//
// WHY LINKS AND NOT COPIES: a copy drifts from its source the moment either
// side is written, and keeping N copies current is a synchronisation problem
// with no natural point to run at. A link has no such state.
//
// A CRASH BETWEEN `symlink(tmp)` AND `rename` LEAKS THE TEMP LINK, and that is
// known and accepted rather than collected: the prune below skips the temp name
// by construction (or it would race a live rename), so a leaked one survives
// every later refresh. It is inert — it points at a real entry in the host's
// config dir, the CLI never looks for that name, and the tier table denies a
// file tool naming it exactly as it denies the final link. No cleanup pass.
//
// SAFE BECAUSE THE CLI RESOLVES LINKS BEFORE WRITING, measured against 2.1.263:
// its single atomic-write helper either follows the link and writes the real
// target (`allowSymlink`, logging "Writing through symlink"), or refuses by name
// ("Refusing to write through symlink: …"). It cannot silently replace a link
// with a real file and fork the state — the failure mode is loud.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { claudeConfigDir, remoteConfigDir } from './projects.ts';

// THE EXACT NAMES that are never linked. One further exclusion is a CLASS, not
// a name, and is below.
//
//   `projects`         — the transcripts. Sharing them IS the defect this whole
//                        mechanism exists to fix, so it is a real, private
//                        directory per remote.
//   `.credentials.json`— reached through `CLAUDE_SECURESTORAGE_CONFIG_DIR`
//                        instead (see Instance.spawn), which pins credentials to
//                        the real config dir without a link.
//   `backups`          — where the CLI drops `.claude.json` backups, and it
//                        holds nothing else: measured on a live host, 6 of 6
//                        entries were `.claude.json.backup.<ms>` or
//                        `.claude.json.corrupted.<ms>`. It is the class below
//                        one level down, so the class's harm reaches it.
//                        Shared, its entries are told apart only by epoch-ms
//                        with no provenance, and one config's churn evicts
//                        another's last backup. Sharper: the CLI's
//                        missing-config recovery reads `<configDir>/backups/`
//                        and offers a FOREIGN config for restore — measured on
//                        a first spawn, a `cp` hint naming a 98,979-byte host
//                        backup while that remote's own config was 41,466
//                        bytes. Following it imports the host's cwd-keyed
//                        `projects` map, the leak the class exclusion exists to
//                        prevent. Not filed with the class because it is not a
//                        member of it but a directory of them. Left for the CLI
//                        to create.
const NEVER_LINKED = new Set(['projects', '.credentials.json', 'backups']);

// THE GLOBAL-CONFIG CLASS, matched as a PATTERN rather than by name.
//
// The CLI's own bundle treats `^\.claude(-[a-z-]+)?\.json(\.backup)?$` as one
// class — `.claude.json` is merely the spelling a release build uses, and
// `.config.json` is the same file under its legacy name (the bundle's own
// `legacyPath`, which its resolver prefers when present). `.claude.json.lock`
// and `.claude.json.tmp.<pid>` are the write dance's transient siblings.
//
// GUARDED AS A CLASS BECAUSE THE HARM IS THE CLASS'S, not one filename's:
// every member is the CLI's global config, whose `projects` map is keyed by
// ABSOLUTE CWD and carries `allowedTools`, `mcpServers` and
// `hasTrustDialogAccepted`. Linking any one of them would re-create this card's
// own defect on a second surface, leaking permission state between remotes —
// and it would do so INVISIBLY, because the farm links whatever new top-level
// entry it finds at the next spawn. Its lock path is also NOT realpath-resolved,
// so N config dirs over one real file take N distinct locks: measured 8 of 15
// concurrent writes lost, against 5 of 5 kept under one shared lock.
//
// Left for the CLI to create, and deliberately NOT seeded: seeding is what
// would reintroduce drift. Nothing reachable writes a non-`.claude.json` member
// today — this is defence in depth against a CLI that starts to, not a claim
// that one does.
const GLOBAL_CONFIG_RE = /^\.claude(-[a-z-]+)?\.json(\.backup)?$/;
const LEGACY_GLOBAL_CONFIG = '.config.json';

// THE SAME NAMES AS PREFIXES, because the write dance's siblings are not one
// suffix. `<name>.lock` is a DIRECTORY that outlives the write it guards, and
// `<name>.tmp.<pid>.<rand>` is the file being renamed over it — an anchored
// match catches neither. Sharing a lock directory across remotes is the
// divergent-lock problem from the other side: they would serialise against each
// other while writing different files.
//
// `.config.json` needs this as much as `.claude.json` does: on a host that has
// one it is the ACTIVE global config, because the CLI's resolver prefers it.
// `.credentials.json` is not linked either, so neither are its temp files.
const GLOBAL_CONFIG_PREFIX_RE = /^(\.claude(-[a-z-]+)?\.json|\.config\.json|\.credentials\.json)\./;

// `placeLink`'s in-flight temp name. Skipped by the prune below so a concurrent
// refresh cannot unlink another call's half-built link out from under its
// `rename` — which would turn this module's own concurrency fix into a new race.
const TMP_LINK_RE = /\.cc-tmp-\d+-[0-9a-f]+$/;

function neverLinked(name: string): boolean {
  return NEVER_LINKED.has(name)
    || name === LEGACY_GLOBAL_CONFIG
    || GLOBAL_CONFIG_RE.test(name)
    || GLOBAL_CONFIG_PREFIX_RE.test(name);
}

export interface FarmLogger { warn(msg: string): void }

// Log ONCE per link path per process. `ensureRemoteConfigDir` runs before every
// spawn, so a per-call message would repeat for the life of the orchestrator on
// a condition the operator can only act on once.
const reported = new Set<string>();

// Build or refresh the config directory for one remote, and return its path.
//
// IDEMPOTENT, and re-run before EVERY spawn rather than once at registration:
// the CLI grows new top-level entries across versions, and a directory built
// once would silently stop sharing whatever appeared afterwards.
//
// NEVER DESTRUCTIVE TOWARDS WHAT IT DID NOT CREATE. A real file or directory
// where cc would have put a link is left alone and reported — the CLI creates
// several of these inside a config dir it is handed (measured: `.claude.json`,
// `policy-limits.json`, `remote-settings.json`, `sessions/`), and deleting them
// is not cc's call.
export async function ensureRemoteConfigDir(
  place: { system: string; remoteId: string | null },
  { log = console as FarmLogger }: { log?: FarmLogger } = {},
): Promise<string> {
  const cfg = remoteConfigDir(place);
  const source = claudeConfigDir();
  await fs.mkdir(cfg, { recursive: true });
  // The private half, created unconditionally: a worker whose transcript
  // directory does not exist writes nothing cc can later read back.
  await fs.mkdir(path.join(cfg, 'projects'), { recursive: true });

  let names: string[] = [];
  try { names = await fs.readdir(source); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }

  for (const name of names) {
    if (neverLinked(name)) continue;
    const target = path.join(source, name);
    const link = path.join(cfg, name);
    let held: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try { held = await fs.lstat(link); }
    catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    // CREATE: plain `symlink`, and EEXIST is "something arrived since the
    // lstat" rather than an error. NOT `rename` here — rename would silently
    // clobber whatever arrived, and what arrives is exactly the class cc must
    // not destroy: the CLI creates real files inside a config dir it is handed
    // (measured: `.claude.json`, `policy-limits.json`, `remote-settings.json`,
    // `sessions/`). An `lstat` immediately before the rename would only narrow
    // the window, not close it. Re-evaluating instead lands the arrival on the
    // leave-alone rule below, which is where it belongs.
    if (held === null) {
      if (await tryCreateLink(target, link)) continue;
      held = await fs.lstat(link).catch(() => null);
      if (held === null) continue; // vanished again; the next spawn settles it
    }
    if (!held.isSymbolicLink()) {
      if (!reported.has(link)) {
        reported.add(link);
        log.warn(`systems: leaving '${link}' alone — it is a real file, not cc's link to '${target}'`);
      }
      continue;
    }
    // REPOINT: the real config dir moved. `rename` here, where cc knows it owns
    // the thing being replaced — it is already cc's own link — so there is no
    // window in which a reader sees no link at all, and a concurrent refresh
    // simply overwrites an identical one.
    if (await fs.readlink(link) !== target) await placeLink(target, link);
  }

  await pruneVanishedLinks(cfg, source, new Set(names));
  return cfg;
}

// A DANGLING LINK IS WORSE THAN ABSENCE: a read of it gets ENOENT rather than
// falling through to a default, and the CLI's link-resolving writer would
// resolve it to a path whose parent may no longer exist.
//
// Only links INTO the real config dir are cc's to remove — one pointing
// anywhere else was not made here.
async function pruneVanishedLinks(cfg: string, source: string, live: Set<string>): Promise<void> {
  let held: Array<{ name: string; isSymbolicLink(): boolean }>;
  try { held = await fs.readdir(cfg, { withFileTypes: true }); }
  catch (e) { if (errCode(e) === 'ENOENT') return; throw e; }
  for (const e of held) {
    if (!e.isSymbolicLink() || neverLinked(e.name) || live.has(e.name)) continue;
    if (TMP_LINK_RE.test(e.name)) continue;
    const link = path.join(cfg, e.name);
    let target: string;
    try { target = await fs.readlink(link); }
    catch (err) { if (errCode(err) === 'ENOENT') continue; throw err; }
    if (target !== path.join(source, e.name)) continue;
    // ENOENT: a concurrent refresh for the same remote already removed it.
    try { await fs.unlink(link); }
    catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
  }
}

// CREATE — true if the link is now ours, false if something already occupies
// the name and the caller must re-evaluate.
//
// `ensureRemoteConfigDir` runs before every spawn and nothing serialises
// launches across sessions on one remote — the create lock is per-session — so
// two `spawn_instance` calls fanning out onto a fresh remote (an ordinary
// conductor pattern) both see ENOENT and both create. Letting EEXIST escape is
// what made the loser's spawn die with a raw errno out of `launch()`; swallowing
// it converges, and costs nothing, because the winner wrote the identical link.
async function tryCreateLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link);
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
}

// REPOINT, ATOMICALLY — build the link under a unique temp name and `rename` it
// into place.
//
// `unlink`+`symlink` would give a concurrent refresh an ENOENT and, worse, a
// window in which the link is absent entirely — a reader in that window gets
// ENOENT on a settings file that exists. `rename` replaces the destination in
// one step, so the loser simply overwrites an identical link.
//
// SAFE TO CLOBBER HERE and not on the create path: what it replaces is already
// known to be cc's own symlink.
async function placeLink(target: string, link: string): Promise<void> {
  const tmp = `${link}.cc-tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await fs.symlink(target, tmp);
  try {
    await fs.rename(tmp, link);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    // The destination became a real DIRECTORY under us — someone else owns it
    // now, and the leave-alone rule says so. Any other failure is real.
    if (errCode(e) === 'EISDIR' || errCode(e) === 'ENOTDIR' || errCode(e) === 'ENOTEMPTY') return;
    throw e;
  }
}

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
