// A project's location becomes ONE STORED FIELD.
//
// Before this, where a project lived was answered three ways and WHICH one
// applied was inferred from how the project had been registered: an in-root
// directory (nothing stored), a `.external/<name>` symlink (the symlink WAS the
// record), or `system` + `systemPath` in `project.json`. This writes
// `location` into every record, moves the checkouts that were standing in for a
// record, and takes the inference away.
//
// WHAT MOVES, AND WHAT DOES NOT. No project tree moves. Plugin checkouts move
// out of the projects root into `.plugins/`, and local worktree checkouts move
// under `.worktrees/<project>/<key>` — both because their OLD positions were
// load-bearing (a directory in the root used to register a project, and the
// transcript guard re-derives a worktree's cwd from the layout rather than
// reading it back, so a store key that no longer matches disk breaks it).
// Moving a worktree changes its `encodeCwd` transcript key, so its session
// history stops resolving. Accepted.
//
// PRE-EXISTING REMOTE WORKTREE REGISTRATIONS ARE DROPPED. This migration is a
// built-in with no System handle, so it cannot reach another machine to move a
// checkout — and that constraint is the only thing that would force a per-kind
// worktree layout. Forgetting the registrations removes it. cc cannot remove a
// directory on a machine it does not own, so every dropped registration's
// orphaned checkout path is LOGGED and survives in the snapshot.
//
// ── THE RULE THIS IS WRITTEN TO ────────────────────────────────────────────
// EVERY STEP AND EVERY PROBE CLAUSE HAS A DEFINED TERMINAL STATE FOR INPUT IT
// CANNOT PROCESS. A clause that can be permanently red is a full snapshot
// written on every boot, for ever.
//
// Two error classes, and no third — no silent `continue`:
//   A REFUSAL ABOUT THE INPUT (a locked worktree, EXDEV, a plugin that has a
//   registered worktree, a store row no source can locate) — this item cannot
//   be processed and retrying will not change that. LEDGER it, log the manual
//   repair, and let the probe converge around it. Applied-with-a-hole.
//   A FAULT ABOUT THE ENVIRONMENT (EACCES on cc's own store, ENOSPC, a failed
//   atomic rename of a record) — THROW, abort the boot. The operator fixes it
//   and restarts.
//
// ── WHY THERE IS A COMPLETION MARKER ───────────────────────────────────────
// `<root>/.code-conductor/migration-0037-complete.json`, written as the last
// act of a successful run, is the FIRST term of the probe.
//
// The structural clauses below cannot stand alone, in BOTH directions, and the
// two failures are opposite:
//   WITHOUT IT the migration never runs on the commonest install. A legacy
//   store where every project is a bare in-root directory has NO `project.json`
//   at all, so the records clause is vacuously green — as are the other three —
//   and the whole chain no-ops while every project silently disappears from a
//   store-derived listing.
//   WITH ONLY A BROADER CLAUSE — "every directory a source can locate has a
//   record" — the migration would instead run for ever after: a grouping
//   directory a user creates under the projects root is exactly what the new
//   model exists to allow, and the next boot would mint a record for it and turn
//   it into a project.
// So the ONE-TIME BACKFILL SOURCES (the `.external` sweep, the in-root scan and
// `.conduct`) are enumerated only while the marker is absent, and the clauses
// below are what still heals a TORN row after it is present.
//
// THE MARKER IS NOT USER-SERVICEABLE — the exact opposite of the ledger below.
// Removing a ledger entry re-arms one item's retry, and that is its documented
// repair. Removing the MARKER re-arms the in-root backfill against a projects
// root that has moved on: every non-dot directory in it is minted as a project
// again, grouping directories included. There is no reason to delete it; if a
// store genuinely needs re-migrating, restore it from
// `migrated-backup-0036/` first.
//
// ── THE LEDGER ─────────────────────────────────────────────────────────────
// `<root>/.code-conductor/migration-0037-unresolved.json`:
//   { "plugins": ["<name>", …], "worktrees": ["<project>/<key>", …] }
// Written incrementally and atomically as each item is ledgered — a crash
// mid-run must not lose what was learned. Never deleted by this migration.
// REMOVING AN ENTRY BY HAND RE-ARMS THE RETRY. New to this migration rather
// than a convention: no other migration in the tree has one.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const name = '0037-project-location-records';

const STORE = '.code-conductor';
const BACKUP = 'migrated-backup-0037';
const LEDGER_FILE = 'migration-0037-unresolved.json';
const MARKER_FILE = 'migration-0037-complete.json';
const EXTERNAL = '.external';
const WORKTREES = '.worktrees';
const PLUGINS = '.plugins';
const CONDUCT = '.conduct';
const PLUGIN_MANIFEST = 'conductor.plugin.json';
const GIT_TIMEOUT_MS = 60_000;

// Inlined, not imported: a migration may not import from src/, and it must stay
// faithful to the world it was written for even after that regex moves.
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

// ── small fs helpers ───────────────────────────────────────────────────────

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return null; }
}

// ABSENT AND UNREADABLE ARE DIFFERENT INPUTS, and one value for both is what
// wedges a probe. `writeMeta`/the old record writer were non-atomic, so a
// record torn by a crash exists in the field: it is PRESENT, so no source
// enumeration reaches past it, and unparseable, so the records clause reads it
// as un-migrated — a reader that answers `null` to both skips the row while the
// clause stays red, and the migration re-runs on every boot for ever. Returns
// `{present, value}` so a caller can route an unreadable record to the SAME
// terminal state an unlocatable one reaches.
async function readRecordFile(root, name) {
  let raw;
  try { raw = await fs.readFile(recordPath(root, name), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { present: false, value: null }; throw e; }
  try { return { present: true, value: JSON.parse(raw) }; }
  catch { return { present: true, value: null }; }
}

// tmp + rename, so a crash mid-write cannot leave a half-written record where a
// readable one was. A failure here is an ENVIRONMENT fault and propagates.
async function writeJsonAtomic(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, p);
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function pathExists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function dirEntries(p) {
  try { return await fs.readdir(p, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr: stderr || (err?.message ?? '') }));
  });
}

// POSIX, always: a remote path lives in the system's own path space.
function posixJoin(...parts) { return path.posix.join(...parts); }

// ── layout ─────────────────────────────────────────────────────────────────

const storeRoot = root => path.join(root, STORE);
const projectsStore = root => path.join(storeRoot(root), 'projects');
const projectStore = (root, name) => path.join(projectsStore(root), name);
const recordPath = (root, name) => path.join(projectStore(root, name), 'project.json');
const wtStoreRoot = (root, name) => path.join(projectStore(root, name), 'worktrees');
const wtStore = (root, name, key) => path.join(wtStoreRoot(root, name), key);
const backupDir = root => path.join(storeRoot(root), BACKUP);
const ledgerPath = root => path.join(storeRoot(root), LEDGER_FILE);
const markerPath = root => path.join(storeRoot(root), MARKER_FILE);

// Store rows that could be a project: a `project.json` under a NAME_RE-passing
// directory. The NAME_RE scope is the same one step 1c and step 3 apply —
// a row cc's own listing filters out is not a project this migration can make
// into one, so including it here would leave a clause permanently red.
async function storeRowNames(root) {
  const out = [];
  for (const e of await dirEntries(projectsStore(root))) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    if (await pathExists(recordPath(root, e.name))) out.push(e.name);
  }
  return out.sort();
}

async function registrationKeys(root, name) {
  return (await dirEntries(wtStoreRoot(root, name)))
    .filter(e => e.isDirectory()).map(e => e.name).sort();
}

// Every directory basename a registered worktree occupies, so step 1c does not
// mint a project for one. Both spellings are collected: the store KEY (the
// legacy dir name) and the basename of the recorded `worktreePath`.
async function worktreeDirNames(root) {
  const out = new Set();
  for (const e of await dirEntries(projectsStore(root))) {
    if (!e.isDirectory()) continue;
    for (const key of await registrationKeys(root, e.name)) {
      out.add(key);
      const meta = await readJson(path.join(wtStore(root, e.name, key), 'worktree.json'));
      if (meta && typeof meta.worktreePath === 'string') out.add(path.basename(meta.worktreePath));
    }
  }
  return out;
}

function hasLocation(rec) {
  const l = rec && typeof rec === 'object' ? rec.location : null;
  return !!l && typeof l === 'object' && typeof l.path === 'string' && l.path !== ''
    && (l.kind === 'local' || (l.kind === 'remote' && typeof l.system === 'string' && l.system !== ''));
}

// ── the ledger ─────────────────────────────────────────────────────────────

async function readLedger(root) {
  const raw = await readJson(ledgerPath(root));
  return {
    plugins: Array.isArray(raw?.plugins) ? raw.plugins.filter(x => typeof x === 'string') : [],
    worktrees: Array.isArray(raw?.worktrees) ? raw.worktrees.filter(x => typeof x === 'string') : [],
  };
}

async function ledgerAdd(root, ledger, bucket, entry, log, why) {
  if (!ledger[bucket].includes(entry)) ledger[bucket].push(entry);
  await writeJsonAtomic(ledgerPath(root), ledger);
  log(`migration ${name}: ${bucket} '${entry}' left in place — ${why}. `
    + `It is recorded in ${ledgerPath(root)}; remove the entry by hand to retry after fixing it.`);
}

// ── the convergence probe ──────────────────────────────────────────────────
//
// EVALUATED ONLY WHEN THE COMPLETION MARKER IS PRESENT — `run` short-circuits
// on it — so every clause below answers one question: "is anything TORN in a
// store this migration has already finished?" A clause whose red can only be
// cleared by a BACKFILL source does not belong here, because the backfill is
// gated off by the same marker that let the clause run at all.
//
// THAT IS WHY THERE IS NO PLUGIN CLAUSE. One was drafted — "no `<root>/<name>`
// holds a root `conductor.plugin.json`" — to cover step 3, and it is wrong in
// both directions:
//   - It does not cover step 3's crash window. That window leaves the checkout
//     at `.plugins/<name>` with no record and NOTHING at `<root>/<name>`, so a
//     clause about `<root>/<name>` is green over it. Source e reads the
//     destination side and is ungated precisely so it recovers on any run;
//     `a run interrupted BETWEEN the plugin rename and the record write
//     recovers` pins that.
//   - It has no step that can clear it post-marker. The only enumeration that
//     reaches a root-level manifest directory is the in-root scan, which is
//     backfill-gated — so the directory is never moved, never ledgered and
//     never excluded, and every boot re-runs the whole pipeline for ever: the
//     permanently-red class this file's opening rule forbids, and the pattern
//     0009 and 0017 were unregistered from the chain for.
//   - Making the enumeration ungated instead would be worse: a
//     `conductor.plugin.json` sitting in the projects root would become an
//     authoritative on-disk declaration that cc relocates the user's directory
//     over. Nothing on disk is authoritative here, and discovery is
//     user-initiated.
// Post-marker, a manifest-bearing directory in the projects root is an
// unregistered directory — not a project and not a plugin until a human adopts
// it. That is the correct answer, not a gap.
//
// C1 records    — every NAME_RE-passing `project.json` has a `location`.
//                 A row no source can locate is MOVED ASIDE, which removes the
//                 input, so this clause needs no exclusion list.
// C2 `.external`— no SYMLINK remains under `<root>/.external/`. Deliberately NOT
//                 "the directory is absent": an adopted project's worktree lives
//                 INSIDE it, a ledgered move leaves a real directory there, and
//                 `fs.rmdir` on a non-empty directory fails — so the absent-form
//                 clause could never go green.
// C3 worktrees  — for every registration, `worktree.json`'s `worktreeName` ===
//                 its store key, excluding `ledger.worktrees`. This is the
//                 json↔key equality, NOT an infix test: the infix test is blind
//                 to a crash between the store rename and the json rewrite,
//                 where the key has no infix so the row reads DONE while the
//                 json still names the vacated directory.
//                 KNOWN VACUITY, recorded so nobody leans on it: C4 is also
//                 green on a fully un-migrated legacy store, because legacy rows
//                 were written with `worktreeName` equal to their store key. It
//                 is a TORN-ROW DETECTOR, not a "worktrees are migrated" signal;
//                 it works because C1 gates the first run. A registration with
//                 no readable json is green here too — there is nothing to tear.
async function converged(root, ledger) {
  for (const n of await storeRowNames(root)) {
    if (!hasLocation(await readJson(recordPath(root, n)))) return false;
  }
  for (const e of await dirEntries(path.join(root, EXTERNAL))) {
    if (e.isSymbolicLink()) return false;
  }
  for (const e of await dirEntries(projectsStore(root))) {
    if (!e.isDirectory()) continue;
    for (const key of await registrationKeys(root, e.name)) {
      if (ledger.worktrees.includes(`${e.name}/${key}`)) continue;
      const meta = await readJson(path.join(wtStore(root, e.name, key), 'worktree.json'));
      if (meta && meta.worktreeName !== key) return false;
    }
  }
  return true;
}

// ── step 0: the snapshot ───────────────────────────────────────────────────
//
// ONE DIRECTORY, AT A FIXED PATH, WRITTEN ONCE. A deliberate deviation from the
// stamped `migrated-backup-<stamp>/` convention, and the reason is the whole
// point of the snapshot: its value is that it captures the PRE-migration store.
// A stamped snapshot taken on a resumed run captures a HALF-migrated one —
// worse than useless — and stamping is what produces a backup directory per
// boot. If it already exists, this is a no-op.
//
// The tmp→final rename is this step's last act, so "exists" implies "complete";
// a partial tmp precedes every mutation and is discarded and rewritten from
// identical state.
async function snapshot(root) {
  const final = backupDir(root);
  if (await pathExists(final)) return;
  const tmp = `${final}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  // THE RAW BYTES, never the parsed shape. A record this migration cannot parse
  // is exactly the input the snapshot exists for — backing it up as `{}` would
  // destroy the one thing nothing else holds (a workspace in its readable half,
  // say), at precisely the input "never destroy data you can't reconstruct" is
  // about.
  for (const n of await storeRowNames(root)) {
    const dest = path.join(tmp, 'projects', n, 'project.json');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(recordPath(root, n), dest);
  }
  // Captured BEFORE any unlink: after step 6 the link targets exist nowhere
  // else but in the records step 5 writes.
  const links = {};
  for (const e of await dirEntries(path.join(root, EXTERNAL))) {
    if (!e.isSymbolicLink()) continue;
    try { links[e.name] = await fs.readlink(path.join(root, EXTERNAL, e.name)); } catch { /* raced */ }
  }
  await writeJsonAtomic(path.join(tmp, 'external-links.json'), links);

  // Every registration with its metadata — the dropped remote ones are
  // reconstructable by hand from here and from the boot summary.
  const wts = {};
  for (const e of await dirEntries(projectsStore(root))) {
    if (!e.isDirectory()) continue;
    for (const key of await registrationKeys(root, e.name)) {
      const src = path.join(wtStore(root, e.name, key), 'worktree.json');
      wts[`${e.name}/${key}`] = await readJson(src);
      // The raw file too, for the same reason as the records above: step 2
      // REMOVES a remote registration, and a torn json's bytes exist nowhere
      // else afterwards. The index above stays the parsed convenience shape.
      const dest = path.join(tmp, 'projects', e.name, 'worktrees', key, 'worktree.json');
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  await writeJsonAtomic(path.join(tmp, 'initial-worktrees.json'), wts);

  // Where each plugin checkout was before step 3 moved it.
  const plugins = {};
  for (const e of await dirEntries(root)) {
    if (!e.isDirectory() || e.name.startsWith('.') || !NAME_RE.test(e.name)) continue;
    const dir = path.join(root, e.name);
    if (await pathExists(path.join(dir, PLUGIN_MANIFEST))) plugins[e.name] = dir;
  }
  await writeJsonAtomic(path.join(tmp, 'plugin-paths.json'), plugins);

  await fs.rename(tmp, final);
}

// ── step 1: build the location plan ────────────────────────────────────────
//
// Priority order, highest first:
//   a′ a record that ALREADY has a `location` — used verbatim. This is what
//      makes a resumed step 5 coherent, and it outranks b so a surviving
//      symlink cannot move a project that has already been migrated.
//   a  a record with `system` + `systemPath` → remote. A record with `system`
//      and NO `systemPath` is not a placement and nothing can reconstruct one:
//      the row is MOVED ASIDE.
//   b  a `.external/<name>` symlink → local at realpath(target). A BROKEN link
//      still becomes a record carrying readlink's raw target, so the project
//      stays addressable and the adopt dialog's relocation branch can repoint it.
//   c  a non-dot directory directly under `<root>` whose name passes NAME_RE and
//      is not a registered worktree dir. The name filter is load-bearing: the
//      old readdir loop had none, so `foo bar` listed — and minting a record for
//      it now produces a project the new listing filters out, registered nowhere
//      and listed nowhere.
//   d  `.conduct`, when the directory exists.
//   e  `<root>/.plugins/<name>` holding a root manifest. THIS SOURCE EXISTS
//      SOLELY TO MAKE STEP 3'S CRASH WINDOW RECOVERABLE — see step 3.
//   none → the store row is MOVED ASIDE. Move-aside beats ledgering because it
//      removes the INPUT, so C1 goes green with no exclusion.
async function buildPlan(root, log, { backfill }) {
  const wtDirs = await worktreeDirNames(root);
  const candidates = new Set(await storeRowNames(root));

  // BACKFILL-ONLY DISCOVERY. Once the marker is present, a directory in the
  // projects root is a grouping directory and not an un-migrated project — see
  // the completion-marker note at the top.
  if (backfill) {
    for (const e of await dirEntries(root)) {
      if (!e.isDirectory()) continue;
      if (e.name === CONDUCT) { candidates.add(CONDUCT); continue; }
      if (e.name.startsWith('.')) continue;
      if (!NAME_RE.test(e.name)) {
        log(`migration ${name}: skipping directory '${e.name}' — its name is not a usable project name, `
          + `so a record for it would be registered nowhere the project list can show.`);
        continue;
      }
      if (wtDirs.has(e.name)) continue;
      candidates.add(e.name);
    }
    for (const e of await dirEntries(path.join(root, EXTERNAL))) {
      if (e.isSymbolicLink() && NAME_RE.test(e.name)) candidates.add(e.name);
    }
  }
  // Source e is NOT backfill: it is the recovery for step 3's crash window and
  // must fire on a resumed run as well as a first one.
  for (const e of await dirEntries(path.join(root, PLUGINS))) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    if (await pathExists(path.join(root, PLUGINS, e.name, PLUGIN_MANIFEST))) candidates.add(e.name);
  }

  const plan = new Map();
  const orphaned = [];
  for (const n of [...candidates].sort()) {
    const { present, value: rec } = await readRecordFile(root, n);
    const location = await locate(root, n, rec, wtDirs);
    if (location) { plan.set(n, { location, workspace: typeof rec?.workspace === 'string' ? rec.workspace : null }); continue; }
    // No source. A record that is PRESENT but unreadable reaches the same
    // terminal state an unlocatable readable one does — moved aside, which
    // removes the input — because the alternative is a row no source ever
    // locates and no clause can ever go green over. A bare candidate with
    // nothing behind it is simply not a project.
    if (!present) continue;
    await moveAside(root, n, log);
    orphaned.push(n);
  }
  return { plan, orphaned };
}

async function locate(root, n, rec, wtDirs) {
  if (hasLocation(rec)) return rec.location;                                        // a′
  const system = typeof rec?.system === 'string' ? rec.system.trim() : '';
  if (system && system !== 'local') {                                               // a
    const p = typeof rec?.systemPath === 'string' ? rec.systemPath.trim() : '';
    if (!p) return null;   // not a placement, and unreconstructable → moved aside
    const remoteId = typeof rec?.remoteId === 'string' && rec.remoteId.trim() ? rec.remoteId.trim() : null;
    return { kind: 'remote', system, remoteId, path: p };
  }
  const link = path.join(root, EXTERNAL, n);                                        // b
  let linkStat = null;
  try { linkStat = await fs.lstat(link); } catch { /* no link */ }
  if (linkStat?.isSymbolicLink()) {
    try { return { kind: 'local', path: await fs.realpath(link) }; }
    catch { return { kind: 'local', path: await fs.readlink(link) }; }
  }
  const inRoot = path.join(root, n);                                                // c / d
  if (!n.startsWith('.') && NAME_RE.test(n) && !wtDirs.has(n) && await isDir(inRoot)) {
    return { kind: 'local', path: inRoot };
  }
  if (n === CONDUCT && await isDir(inRoot)) return { kind: 'local', path: inRoot };
  const inPlugins = path.join(root, PLUGINS, n);                                    // e
  if (await pathExists(path.join(inPlugins, PLUGIN_MANIFEST))) {
    return { kind: 'local', path: inPlugins };
  }
  return null;
}

// Never destroyed — moved, into the one snapshot directory. A failure here is an
// ENVIRONMENT fault (the store is cc's own disk) and aborts the boot.
async function moveAside(root, n, log) {
  const dest = path.join(backupDir(root), 'orphaned-records', n);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.rename(projectStore(root, n), dest);
  log(`migration ${name}: project '${n}' has a record but nothing on disk or in it locates a tree — `
    + `its store entry was moved to ${dest}.`);
}

// ── step 2: drop pre-existing REMOTE worktree registrations ────────────────
//
// The migration cannot reach another machine, so the registration is FORGOTTEN
// and the checkout it names is LOGGED. The fallback matters: `writeMeta` is a
// non-atomic mkdir + writeFile, so a registration directory with no json exists
// today — and those are exactly the rows most likely to be junk, so the logging
// obligation must not silently skip them. The legacy rule reconstructs what
// `worktreePathFor` computed at creation.
async function dropRemoteWorktrees(root, plan, log) {
  const dropped = [];
  for (const [n, { location }] of plan) {
    if (location.kind !== 'remote') continue;
    for (const key of await registrationKeys(root, n)) {
      const meta = await readJson(path.join(wtStore(root, n, key), 'worktree.json'));
      const orphan = typeof meta?.worktreePath === 'string' && meta.worktreePath
        ? meta.worktreePath
        : posixJoin(path.posix.dirname(location.path), key);
      await fs.rm(wtStore(root, n, key), { recursive: true, force: true });
      dropped.push(`${n}/${key}`);
      log(`migration ${name}: dropped the registration of worktree '${key}' of remote project '${n}' — `
        + `cc cannot remove a directory on a machine it does not own, so the checkout at `
        + `'${orphan}' on system '${location.system}' is left behind. Delete it there if you want it gone.`);
    }
  }
  return dropped;
}

// ── step 3: move plugin checkouts out of the projects root ─────────────────
//
// ⚠ THE CRASH WINDOW. The rename and the record write are two separate fs calls
// with no atomicity between them, and A PLUGIN HAS NO RECORD TODAY (the Library
// clones, rescans and enables, writing no `project.json` — the directory is the
// registration). The window leaves the checkout at `.plugins/<name>`, no record,
// and nothing at `<root>/<name>`. Source e sees exactly that and rebuilds the
// location; step 5 then writes the record. WITHOUT SOURCE E that state is
// unrecoverable AND no clause sees it — the records clause is vacuous with no
// `project.json` on disk, and nothing about `<root>/<name>` is true of a
// directory already renamed away from it — silently destroying a registered
// plugin project.
async function movePlugins(root, plan, ledger, log) {
  const moved = [];
  for (const [n, entry] of plan) {
    const { location } = entry;
    if (location.kind !== 'local') continue;
    if (location.path !== path.join(root, n)) continue;   // already elsewhere
    if (!NAME_RE.test(n) || n.startsWith('.')) continue;
    if (!(await pathExists(path.join(location.path, PLUGIN_MANIFEST)))) continue;
    if (ledger.plugins.includes(n)) continue;

    // A REGISTERED WORKTREE REFUSES THE MOVE. Moving a main checkout invalidates
    // every worktree's `.git` gitdir back-reference AND the repo's own
    // `worktrees/<n>/gitdir`, needing `git worktree repair` — machinery for a
    // case the design says does not exist.
    if ((await registrationKeys(root, n)).length > 0) {
      await ledgerAdd(root, ledger, 'plugins', n,
        log, 'it has registered worktrees, and moving a main checkout invalidates their gitdir back-references');
      continue;
    }

    const dest = path.join(root, PLUGINS, n);
    if (!(await pathExists(dest))) {
      await fs.mkdir(path.join(root, PLUGINS), { recursive: true });
      try {
        await fs.rename(location.path, dest);
      } catch (e) {
        // A refusal ABOUT THE INPUT: EXDEV, or a destination parent cc may not
        // write. Ledgered; the checkout stays whole where it is.
        await ledgerAdd(root, ledger, 'plugins', n, log, `its checkout could not be moved (${e.message})`);
        continue;
      }
    }
    entry.location = { kind: 'local', path: dest };
    // IMMEDIATELY, so the window above is as narrow as it can be made.
    await writeRecord(root, n, entry);
    moved.push(n);
  }
  return moved;
}

// ── step 4: move LOCAL worktree checkouts, IN TOPOLOGICAL ORDER ────────────
//
// THE MOVE UNIT IS A ROW; THE REFERENCE-REPAIR UNIT IS THE CHAIN. A derived
// worktree's record names its base TWICE — `parentPath` (the base's directory)
// and `baseWorktree` (a literal foreign key on the base's `worktreeName`) — and
// chains are a supported shape.
//
// MOVING AND REPAIRING ARE SEPARATE, AND THAT SEPARATION IS THE POINT. Moving
// can refuse about the input; a local store write cannot, so a failure there is
// an environment fault and throws. Both directions then come out right:
//   base ledgered, child moved → the child points at the base's LEGACY key and
//     path, which still exist (ledgered means left in place);
//   base moved, child ledgered → the child's checkout stays, but its references
//     are still repaired to the base's NEW key and path.
//
// WHY THAT MATTERS BEYOND STALE PATHS: `listDependentWorktrees` matches
// `baseWorktree` LITERALLY, and a reference matching nothing yields an EMPTY
// dependents list, not an error. A dangling reference therefore does not merely
// mis-address a directory — the dependents guard silently STOPS FIRING, which
// is a hole in the delete refusal itself.
async function moveWorktrees(root, plan, ledger, log) {
  let movedCount = 0;
  for (const [project, { location }] of plan) {
    if (location.kind !== 'local') continue;
    const keys = await registrationKeys(root, project);
    if (keys.length === 0) continue;

    const metas = new Map();
    for (const key of keys) metas.set(key, await readJson(path.join(wtStore(root, project, key), 'worktree.json')));

    // Creation order already IS a topological order (`baseWorktree` is written
    // at creation, naming a record that already exists), but readdir order is
    // not creation order — so it is sorted explicitly rather than assumed.
    const ordered = topological(keys, metas);

    // legacy key → the row's FINAL identity, whether it moved or was ledgered.
    const finalOf = new Map();

    for (const key of ordered) {
      const meta = metas.get(key);
      const stripped = stripKey(project, key);
      const dest = path.join(root, WORKTREES, project, stripped);

      // A REGISTRATION WITH NO `worktree.json` IS NOT A SKIP. `writeMeta` was a
      // non-atomic mkdir + writeFile, so this row exists in the field — and
      // leaving it alone leaves its LEGACY store key standing, which
      // `registeredPlaces` re-derives the transcript guard's cwd from through
      // `worktreePathFor`: the guard would then name a path under `.worktrees/`
      // while the checkout sits where the legacy rule put it, the exact
      // guard/reality divergence that re-derivation exists to prevent. So the
      // path comes from the LEGACY RULE — what `worktreePathFor` computed for a
      // local project before this change — and the row is moved and rekeyed
      // like any other. NOTHING IS FABRICATED: no `worktree.json` is written,
      // so `listWorktrees` keeps dropping the row exactly as it did; what is
      // repaired is where its key points.
      if (!meta) {
        const src = await legacyLocalWorktreePath(root, project, location, key);
        if (!(await pathExists(dest)) && src && await pathExists(src)) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          const r = await git(location.path, ['worktree', 'move', src, dest]);
          if (r.code !== 0) {
            await ledgerAdd(root, ledger, 'worktrees', `${project}/${key}`, log,
              `it carries no worktree.json and git could not move the checkout the legacy rule `
              + `locates at '${src}' (${(r.stderr || r.stdout || '').trim().split('\n')[0]})`);
            continue;
          }
          movedCount++;
        }
        if (key !== stripped) {
          await fs.rm(wtStore(root, project, stripped), { recursive: true, force: true });
          await fs.rename(wtStore(root, project, key), wtStore(root, project, stripped));
        }
        log(`migration ${name}: worktree '${key}' of project '${project}' carries no worktree.json — `
          + `its registration was rekeyed to '${stripped}' and any checkout moved to '${dest}'; `
          + `cc cannot reconstruct its branch or base, so it stays invisible to the worktree listing.`);
        continue;
      }

      // PER-ROW COMPLETION PROBE, CHECKED FIRST. Both halves are needed: the key
      // must already be the bare one AND the json must agree with it. The json
      // half is what heals a crash between the store rename and the json
      // rewrite, where the key has no infix and an infix-only probe reads DONE
      // while `worktreePath` still names a vacated directory.
      if (key === stripped && meta.worktreeName === key) {
        finalOf.set(key, { key, path: meta.worktreePath });
        await repairRow(root, project, key, metas, finalOf, location, log);
        continue;
      }

      let finalKey = key;
      let finalPath = meta.worktreePath;
      const ledgerEntry = `${project}/${key}`;
      let refused = ledger.worktrees.includes(ledgerEntry);

      // THE DESTINATION IS PROBED EVEN FOR A LEDGERED ROW, and that is the
      // whole of this branch's placement. `git worktree move` can be killed or
      // time out AFTER it moved the checkout and before its exit code was read,
      // which ledgers an entry whose checkout is already at `dest`. Gating the
      // probe on `!refused` then leaves the store key legacy and `worktreePath`
      // naming a vacated directory — and the worktrees clause excludes ledgered
      // rows, so it reads converged for ever. Adopt reality first; the ledger
      // only decides whether a MOVE may be attempted.
      if (await pathExists(dest)) {
        finalKey = stripped; finalPath = dest; refused = false;
      } else if (!refused) {
        const src = typeof meta.worktreePath === 'string' ? meta.worktreePath : '';
        if (!src || !(await pathExists(src))) {
          // Nothing on disk to move — the registration is all there is.
          finalKey = stripped; finalPath = dest;
        } else {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          const r = await git(location.path, ['worktree', 'move', src, dest]);
          if (r.code !== 0) {
            await ledgerAdd(root, ledger, 'worktrees', ledgerEntry, log,
              `git could not move its checkout (${(r.stderr || r.stdout || '').trim().split('\n')[0]})`);
            refused = true;
          } else {
            finalKey = stripped; finalPath = dest; movedCount++;
          }
        }
      }

      if (!refused && finalKey !== key) {
        // A failed store rename is an ENVIRONMENT fault and aborts the boot.
        await fs.rename(wtStore(root, project, key), wtStore(root, project, finalKey));
      }
      finalOf.set(key, { key: finalKey, path: finalPath });
      await repairRow(root, project, finalKey, metas, finalOf, location, log, key);
    }
  }
  return movedCount;
}

// Bases before children. `seen` terminates a hand-edited cycle that
// createWorktree cannot produce; anything left over is appended so no row is
// silently dropped from the pass.
function topological(keys, metas) {
  const out = [];
  const placed = new Set();
  const visit = (key, stack) => {
    if (placed.has(key) || stack.has(key)) return;
    stack.add(key);
    const base = metas.get(key)?.baseWorktree;
    if (typeof base === 'string' && metas.has(base)) visit(base, stack);
    stack.delete(key);
    if (!placed.has(key)) { placed.add(key); out.push(key); }
  };
  for (const key of keys) visit(key, new Set());
  return out;
}

// WHERE THE LEGACY RULE PUT A LOCAL PROJECT'S WORKTREE, for a registration that
// carries no `worktree.json` to read the path off. `worktreePathFor` before
// this change was `<root>/<key>` for a project whose tree sat in the root and
// `<root>/.external/<key>` for one reached through an adopted symlink — and the
// project's own location is the discriminator between those two. Both are
// probed anyway and whichever EXISTS wins: the derivation is a reconstruction,
// so disk beats inference wherever disk can answer.
async function legacyLocalWorktreePath(root, project, location, key) {
  if (location.kind !== 'local') return null;
  const wasInRoot = location.path === path.join(root, project);
  const candidates = wasInRoot
    ? [path.join(root, key), path.join(root, EXTERNAL, key)]
    : [path.join(root, EXTERNAL, key), path.join(root, key)];
  for (const c of candidates) if (await pathExists(c)) return c;
  return candidates[0];
}

function stripKey(project, key) {
  const prefix = `${project}_worktree_`;
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : key;
}

// Repair happens for EVERY row, ledgered or not: it is a local store write, so
// it cannot refuse about the input, and the chain must be coherent either way.
async function repairRow(root, project, finalKey, metas, finalOf, location, log, legacyKey = finalKey) {
  const meta = metas.get(legacyKey);
  if (!meta) return;
  const self = finalOf.get(legacyKey);
  const next = { ...meta, worktreeName: finalKey, worktreePath: self?.path ?? meta.worktreePath };
  if (typeof meta.baseWorktree === 'string') {
    const base = finalOf.get(meta.baseWorktree);
    if (base) {
      next.baseWorktree = base.key;
      next.parentPath = base.path ?? next.parentPath;
    } else {
      log(`migration ${name}: worktree '${finalKey}' of project '${project}' names base `
        + `'${meta.baseWorktree}', which has no registration — its dependents guard will not fire.`);
    }
  } else {
    next.parentPath = location.path;
  }
  await writeJsonAtomic(path.join(wtStore(root, project, finalKey), 'worktree.json'), next);
}

// ── step 5: write the records ──────────────────────────────────────────────

async function writeRecord(root, n, { location, workspace }) {
  await writeJsonAtomic(recordPath(root, n), {
    ...(workspace ? { workspace } : {}),
    location,
  });
}

// ── step 6: remove `.external/` ────────────────────────────────────────────
//
// Only SYMLINK entries are unlinked, one at a time, and the link is never
// followed — the target is the user's own tree. The directory itself is removed
// only when it is EMPTY: a ledgered worktree checkout inside it stays.
async function dropExternal(root, log) {
  const dir = path.join(root, EXTERNAL);
  let unlinked = 0;
  for (const e of await dirEntries(dir)) {
    if (!e.isSymbolicLink()) continue;
    await fs.unlink(path.join(dir, e.name));
    unlinked++;
  }
  try { await fs.rmdir(dir); }
  catch (e) {
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
      log(`migration ${name}: ${dir} still holds entries that are not symlinks — left in place.`);
    } else if (e.code !== 'ENOENT') { throw e; }
  }
  return unlinked;
}

// ── the run ────────────────────────────────────────────────────────────────

// Is there anything under this root a migration could be about? Precise rather
// than "does the root have any directory": the store's own dotfolder is always
// one, and snapshotting a fresh install would leave a backup directory that
// backs up nothing.
//
// ANY NON-DOT DIRECTORY COUNTS, INCLUDING ONE WHOSE NAME FAILS `NAME_RE`. That
// is deliberately WIDER than what step 1c will mint a record for, and the two
// must not be reconciled by loosening the filter: a non-conforming name cannot
// become a project, because the listing filters it out. What step 1c promises
// is that such a directory is SKIPPED AND LOGGED — and before this migration it
// was a first-class listed project, so the log is the only notice its owner
// gets. A shortcut that read the root as empty took that away silently. Routing
// it to the full path keeps ONE source for that message rather than a second
// copy here.
async function hasAnythingToMigrate(root) {
  if ((await storeRowNames(root)).length > 0) return true;
  for (const e of await dirEntries(root)) {
    if (!e.isDirectory()) continue;
    if (e.name === CONDUCT) return true;
    if (!e.name.startsWith('.')) return true;
  }
  if ((await dirEntries(path.join(root, EXTERNAL))).length > 0) return true;
  if ((await dirEntries(path.join(root, PLUGINS))).length > 0) return true;
  return false;
}

export async function run({ root, log = console.log }) {
  const ledger = await readLedger(root);
  const completed = await pathExists(markerPath(root));
  if (completed && await converged(root, ledger)) return { applied: false };

  if (!completed && !(await hasAnythingToMigrate(root))) {
    // A fresh install: nothing to record, and the marker is what keeps the
    // in-root backfill from firing later against a grouping directory.
    await writeJsonAtomic(markerPath(root), { completedAt: new Date().toISOString() });
    return { applied: false };
  }

  await snapshot(root);
  const { plan, orphaned } = await buildPlan(root, log, { backfill: !completed });
  const droppedRemoteWorktrees = await dropRemoteWorktrees(root, plan, log);
  const movedPlugins = await movePlugins(root, plan, ledger, log);
  const movedWorktrees = await moveWorktrees(root, plan, ledger, log);
  for (const [n, entry] of plan) await writeRecord(root, n, entry);
  await dropExternal(root, log);
  // LAST, so an interrupted run leaves the marker absent and the next boot
  // redoes the one-time backfill.
  await writeJsonAtomic(markerPath(root), { completedAt: new Date().toISOString() });

  log(`migration ${name}: wrote ${plan.size} project location record(s).`);
  return {
    applied: true,
    summary: {
      records: plan.size,
      orphanedRecords: orphaned,
      droppedRemoteWorktrees,
      movedPlugins,
      movedWorktrees,
      ledgeredPlugins: ledger.plugins,
      ledgeredWorktrees: ledger.worktrees,
    },
  };
}
