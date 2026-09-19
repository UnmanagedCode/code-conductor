// THE SYMLINK FARM that makes a per-remote CLI config directory share the
// host's real one for everything except the three entries that must not be
// shared.
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
// SAFE BECAUSE THE CLI RESOLVES LINKS BEFORE WRITING, measured against 2.1.263:
// its single atomic-write helper either follows the link and writes the real
// target (`allowSymlink`, logging "Writing through symlink"), or refuses by name
// ("Refusing to write through symlink: …"). It cannot silently replace a link
// with a real file and fork the state — the failure mode is loud.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, remoteConfigDir } from './projects.ts';

// THE THREE ENTRIES THAT ARE NEVER LINKED, each for its own reason:
//
//   `projects`         — the transcripts. Sharing them IS the defect this whole
//                        mechanism exists to fix, so it is a real, private
//                        directory per remote.
//   `.claude.json`     — the CLI's global config. Its lock path is NOT
//                        realpath-resolved, so N config dirs over one real file
//                        take N distinct locks: measured 8 of 15 concurrent
//                        writes lost, against 5 of 5 kept under one shared lock.
//                        Worse, its `projects` map is keyed by ABSOLUTE CWD and
//                        carries `allowedTools`, `mcpServers` and
//                        `hasTrustDialogAccepted` — so sharing it would
//                        re-create this card's own defect on a second surface,
//                        leaking permission state between remotes. Left for the
//                        CLI to create, and deliberately NOT seeded: seeding is
//                        what would reintroduce drift.
//   `.credentials.json`— reached through `CLAUDE_SECURESTORAGE_CONFIG_DIR`
//                        instead (see Instance.spawn), which pins credentials to
//                        the real config dir without a link.
const NEVER_LINKED = new Set(['projects', '.claude.json', '.credentials.json']);

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
// `policy-limits.json`, `remote-settings.json`, `backups/`, `sessions/`), and
// deleting them is not cc's call.
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
    if (NEVER_LINKED.has(name)) continue;
    const target = path.join(source, name);
    const link = path.join(cfg, name);
    let held: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try { held = await fs.lstat(link); }
    catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    if (held === null) { await fs.symlink(target, link); continue; }
    if (!held.isSymbolicLink()) {
      if (!reported.has(link)) {
        reported.add(link);
        log.warn(`systems: leaving '${link}' alone — it is a real file, not cc's link to '${target}'`);
      }
      continue;
    }
    // A link to somewhere else means the real config dir moved. Repoint it, or
    // this remote serves stale settings for the rest of the install's life.
    if (await fs.readlink(link) !== target) {
      await fs.unlink(link);
      await fs.symlink(target, link);
    }
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
    if (!e.isSymbolicLink() || NEVER_LINKED.has(e.name) || live.has(e.name)) continue;
    const link = path.join(cfg, e.name);
    let target: string;
    try { target = await fs.readlink(link); }
    catch (err) { if (errCode(err) === 'ENOENT') continue; throw err; }
    if (target !== path.join(source, e.name)) continue;
    await fs.unlink(link);
  }
}

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
