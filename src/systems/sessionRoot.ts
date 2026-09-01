// The local session root: where it lives, what lands in one, and the prefix
// rule that says which paths belong to the system.
//
// A session root is cc-owned and LOCAL — the Claude CLI always runs on this
// machine, so a project on another system still needs a local directory to be
// the CLI's cwd. Keying it per (system, project, worktree) under cc's own store
// is what stops two systems that each host a project at `/app` from colliding
// on one local directory.
//
// IT IS A SPARSE LOCAL IMAGE OF THE MIRRORED ADDRESS SPACE, never a copy of the
// tree. What is PULLED AHEAD OF TIME is exactly the config surface the CLI
// reads implicitly — CLAUDE.md, CONVENTIONS.md, the repo-tracked `.claude/`
// allow-list — because those reads fire no hook and so cannot be redirected;
// that pull is ONE WAY, system → local, at spawn and resume. Everything else a
// worker touches arrives through a hooked tool, one file at a time, and
// materialises beside it.
//
// HOW WIDE THE IMAGE IS is the provider's to say (src/systems/mirror.ts): the
// root is the local image of the advertised MIRROR ROOT, and the CLI's cwd is
// the project's place inside it (`root + offset`). A provider that advertises
// nothing gives `offset === ''`, so cwd IS root and the geometry is exactly
// what it was before mirrors existed.
//
// THE ALLOW-LIST WALK DOES NOT MOVE WITH THE MIRROR. It stays anchored at the
// PROJECT over its seven fixed targets whatever the mirror root is: re-anchored
// at `/` the same walk was measured at 529k records, 46 MB of `find` output and
// 213 MB of orchestrator RSS, rising to 558 MB through the parse and the
// manifest serialise — and pruning `/proc`, `/dev` and `/sys` still left 37 MB.
// Widening the MAP is what makes an out-of-project file reachable; widening the
// WALK buys nothing and costs that.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from '../projects.ts';
import { httpError } from '../httpError.ts';
import { CONVENTIONS_IMPORT_LINE } from '../conventionsImport.ts';
import {
  isExcluded, resolveMirrorScope, within, withinPosix, type MirrorScope,
} from './mirror.ts';
import { requireAbsolute, type System } from './system.ts';

// `<store>/systems/<systemId>/sessions/` — the parent of every session root for
// one system. Exported so the assertion below and its test name one path rather
// than two spellings of it.
export function sessionRootsDir(systemId: string): string {
  return path.join(orchStoreRoot(), 'systems', systemId, 'sessions');
}

// THE PLACEMENT CHECK: no ancestor of the session roots may be a git repository.
//
// The CLI probes for a containing repo at startup by walking UP from its cwd. A
// session root inside one would make every session on this system report cc's
// own store's repo as the project's — git state from the wrong tree.
//
// NO LONGER THE ONLY DEFENCE, and deliberately kept. src/settings.ts injects
// `includeGitInstructions: false` for every redirected session, which is
// per-session and needs no property of the store's placement to hold; this check
// refuses at REGISTRATION only, so a store moved under a repository afterwards
// would slip past it. Two levers exist for the probe (the settings key and
// CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS — see src/settings.ts for why the key is
// the one cc uses), so this check has stopped being load-bearing. It stays
// because a store inside a repo is worth refusing on its own account: it is
// where the transcripts, the session roots and every sidecar live.
//
// A decoy `.git` in the session root is deliberately NOT the fix: it would stop
// the walk by making the CLI believe the session root is itself a repo.
//
// Walks from the deepest existing ancestor upward — the session roots dir does
// not exist until a session is created, and the directories that would hold it
// are cc's own.
export async function assertSessionRootsPlaceable(systemId: string): Promise<void> {
  let dir = sessionRootsDir(systemId);
  for (;;) {
    // `.git` is a DIRECTORY in a normal checkout and a FILE in a worktree, so
    // the test is existence, not kind.
    try {
      await fs.lstat(path.join(dir, '.git'));
      throw httpError(
        400,
        `cannot host sessions for system '${systemId}': '${dir}' is a git repository, `
        + `and it contains where cc keeps this system's local session directories `
        + `(${sessionRootsDir(systemId)}). Move the code-conductor store out of the repository.`,
      );
    } catch (e) {
      if ((e as { statusCode?: unknown }).statusCode === 400) throw e;
      // ENOENT/ENOTDIR: no `.git` here, or this ancestor does not exist yet.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return; // reached the filesystem root
    dir = parent;
  }
}

// ── Where one session's root is ──────────────────────────────────────

// `--` separates the project from its worktree. Both charsets are
// `[a-zA-Z0-9._-]` (validateName / worktree names), so the separator cannot
// occur inside either half and the key is unambiguous.
export function sessionRootPath(systemId: string, project: string, worktree?: string | null): string {
  const key = worktree ? `${project}--${worktree}` : project;
  return path.join(sessionRootsDir(systemId), key);
}

// The manifest of what was last pulled, kept BESIDE the root rather than inside
// it: the root is the CLI's cwd and the worker can see everything in it, so
// cc's own bookkeeping does not belong there.
function manifestPath(systemId: string, project: string, worktree?: string | null): string {
  return `${sessionRootPath(systemId, project, worktree)}.manifest.json`;
}

// Remove a session root and its manifest. One owner for the pair, so a caller
// cannot take the root and leave the bookkeeping that describes it.
export async function removeSessionRoot(systemId: string, project: string, worktree: string | null): Promise<void> {
  await fs.rm(sessionRootPath(systemId, project, worktree), { recursive: true, force: true });
  await fs.rm(manifestPath(systemId, project, worktree), { force: true });
}

// ── THE PREFIX RULE ──────────────────────────────────────────────────
//
// A path maps to the system ONLY when it lies under the session root. Stated
// once, here, because getting it wrong in either direction is silent: mapping
// too much sends a read of an attachment (which lives under the store) or of
// `~/.claude/**` to the wrong machine, and mapping too little leaves a tool
// answering from a local path the system knows nothing about — the boundary
// leak that costs a worker its trust in its own tool results.
//
// Containment is decided with path.relative, never a string prefix: a prefix
// test claims a merely prefix-SHARING sibling (`<root>-backup`) is inside. The
// predicates live in src/systems/mirror.ts so ONE of them serves the map, the
// exclude list and the advertisement's validation.
//
// THE FAR END IS THE MIRROR ROOT, NOT THE PROJECT. Those are the same path
// whenever a provider advertises nothing, which is the common case; when they
// differ, this one rule still decides the whole boundary, because a second
// mapping would be a second way to get a silent boundary wrong.
export class SessionPathMap {
  readonly root: string;
  readonly mirrorRoot: string;
  readonly exclude: readonly string[];

  constructor(root: string, mirrorRoot: string, exclude: readonly string[] = []) {
    this.root = root;
    this.mirrorRoot = mirrorRoot;
    this.exclude = exclude;
  }

  // The system path a local one names, or null when the local path is not the
  // system's business. PURE GEOMETRY: an excluded path still has a counterpart,
  // and `classify` is what decides whether cc will carry it.
  toSystem(localAbs: string): string | null {
    const rel = within(localAbs, this.root);
    return rel === null ? null : (rel === '' ? this.mirrorRoot : path.posix.join(this.mirrorRoot, toPosix(rel)));
  }

  // The local path a system one names, or null when it lies outside the mirror.
  // Used for the output annotation and — since the mirror can be wider than the
  // project — to TRANSLATE a system path a worker named into the local
  // counterpart it can actually use. Never to open a file.
  toLocal(systemAbs: string): string | null {
    const rel = withinPosix(systemAbs, this.mirrorRoot);
    return rel === null ? null : (rel === '' ? this.root : path.join(this.root, rel));
  }

  // THE ONE PREDICATE both halves of the redirect read, so "mapped", "excluded"
  // and "outside" cannot be decided two different ways.
  classify(localAbs: string): SessionPathVerdict {
    const systemPath = this.toSystem(localAbs);
    if (systemPath === null) return { kind: 'outside' };
    const excludedBy = isExcluded(systemPath, this.exclude);
    if (excludedBy !== null) return { kind: 'excluded', systemPath, excludedBy };
    return { kind: 'mapped', systemPath };
  }
}

export type SessionPathVerdict =
  | { kind: 'mapped'; systemPath: string }
  // The path has a counterpart, and the provider says cc must not carry it.
  // Bash reaches it under no such restriction, which is what the refusal says.
  | { kind: 'excluded'; systemPath: string; excludedBy: string }
  | { kind: 'outside' };

function toPosix(rel: string): string {
  return path.sep === '/' ? rel : rel.split(path.sep).join('/');
}

// ── §3.2 / §3.4: the allow-list, and what it costs ───────────────────

// A FIXED allow-list, not a whole-directory copy. Each entry is a config
// surface the CLI reads implicitly — no hook fires for it (M7), so it cannot be
// redirected and must be present locally or it is simply absent from the
// session. Anything NOT here reaches the worker through a hooked tool instead.
const ALLOW_FILES = ['CLAUDE.md', 'CONVENTIONS.md', '.claude/settings.json', '.claude/settings.local.json'];
const ALLOW_DIRS = ['.claude/skills', '.claude/commands', '.claude/agents'];

// Caps, per §3.4's "warns loudly and skips rather than failing the spawn". A
// repo that committed something enormous under `.claude/skills` must not be a
// project cc cannot open a session on.
export const SESSION_ROOT_FILE_CAP_BYTES = 256 * 1024;
export const SESSION_ROOT_TOTAL_CAP_BYTES = 4 * 1024 * 1024;

// A FENCE, not a third cap — the distinction is in the name because it is the
// whole difference in behaviour. The two caps above bound PULLED CONTENT: they
// are consulted per entry, after every record has been materialised, and each
// one they refuse is skipped and NAMED. This one bounds the LISTING those
// records are read out of, and past it the compose FAILS, for the reason
// runGit's does (src/worktrees.ts): findManifest parses the output WHOLE, so a
// clipped-but-successful parse is read as the config surface itself.
//
// Nothing bounded the listing before, and it is materialised three times — the
// `find` output, the Map, and the manifest's JSON — on every spawn AND every
// resume. Measured on one `.claude/skills` tree, unfenced: 420,000 entries
// (33.6 MB of `find` output) took cc to 533 MB RSS and wrote a 35 MB manifest,
// and 900,000 (72.9 MB) reached 542 MB of V8 heap — more than the 512 MB
// `--max-old-space-size` `npm test` runs under (package.json) — 843 MB RSS,
// and 3.0 s in JSON.stringify alone.
//
// 8 MiB is the same number chosen the same way as the redirected shell's output
// fence (DEFAULT_MAX_OUTPUT_BYTES, src/systems/toolRedirect.ts): far above any
// real config surface — roughly 96,000 allow-list files — and far below what
// threatens a process that hosts every session. Measured AT the fence, the
// largest listing it admits costs 112 MB of heap and 242 MB RSS record-dense
// (157,327 records) and 105 MB / 217 MB at ordinary path lengths. 16 MiB was
// rejected: it doubles that in a process where two spawns can compose at once
// (card 2026-0267).
const SESSION_ROOT_LISTING_FENCE_BYTES = 8 * 1024 * 1024;

export interface SessionRootSkip { path: string; reason: string }

export interface ComposedSessionRoot {
  // The local image of the MIRROR ROOT. Realpath-clean and stable: S14 keys the
  // CLI's transcript directory off getcwd(), so cc must hand it the same string
  // the CLI will read back.
  root: string;
  // The CLI's working directory — the project's place inside the image,
  // `root + mirror.offset`. Equal to `root` whenever nothing is advertised.
  cwd: string;
  mirror: MirrorScope;
  pulled: string[];
  skipped: SessionRootSkip[];
  // Diagnostics that are not refusals: an advertised exclude outside the mirror
  // root is sane configuration on a provider serving many shapes, and saying so
  // once beats refusing a session over it.
  notes: string[];
}

interface ManifestEntry { size: number; mtimeMs: number }

// What was last pulled, and — load-bearing — WHICH TARGET it was pulled from.
//
// The path template keys on the project name, which is globally unique, so one
// system serving many targets introduces no collision and the template does not
// change. What it does introduce is a need for INVALIDATION, because a change of
// target is SILENT otherwise: the root still holds CLAUDE.md, CONVENTIONS.md and
// the sparse content cache pulled from the OLD machine, the worker reads and
// edits those, and the write-back pushes the result to the NEW one — clobbering
// it with another machine's bytes while both sides stay internally consistent.
//
// The MIRROR ROOT rides beside it for the same reason: a widened or narrowed
// mirror moves where `cwd` sits inside the root, so a manifest written under
// one geometry describes a layout that is simply not where the next spawn will
// look. Both normalise to null so a manifest written before either field
// existed matches an unbound, unadvertised placement rather than costing every
// existing root a pointless wipe.
interface Manifest { remoteId: string | null; mirrorRoot: string | null; entries: Map<string, ManifestEntry> }

// Compose (or refresh) the session root for one worker session.
//
// Runs at spawn AND resume, before launch(). A worker that writes a new skill
// mid-session lands it on the system and sees it at the NEXT spawn — the same
// as locally, where the CLI reads its config once at startup.
export async function composeSessionRoot({ system, systemId, systemPath, project, worktree = null }: {
  system: System; systemId: string; systemPath: string; project: string; worktree?: string | null;
}): Promise<ComposedSessionRoot> {
  requireAbsolute('composeSessionRoot', 'systemPath', systemPath);
  const rootRaw = sessionRootPath(systemId, project, worktree);

  // THE MIRROR, resolved before anything is written, because its answer may be
  // "there should not be a session here at all". One round trip per connection
  // generation (ProviderSystem memoises it), and none at all for a provider
  // that does not advertise the capability.
  const { scope: mirror, inert: notes } = resolveMirrorScope({
    systemId, project, systemPath, advertisement: await system.mirror(),
  });

  // THE TARGET CHECK, and it runs before the root exists rather than after,
  // because its answer may be "there should not be one".
  //
  // Read off the HANDLE, not from a parameter: the handle is already bound to
  // the project's target, so a second copy of that fact could only ever
  // disagree with it. Both sides normalise to null so a manifest written before
  // this field existed matches an unbound handle rather than costing every
  // existing root a pointless wipe.
  //
  // A mismatch removes the WHOLE root and re-pulls from scratch. Diffing
  // against a manifest that describes a different machine is precisely how the
  // old target's bytes end up under the new target's paths.
  const prior = await readManifest(systemId, project, worktree);
  const priorMirror = prior.mirrorRoot ?? systemPath;
  const manifest = prior.remoteId === (system.remoteId ?? null) && priorMirror === mirror.mirrorRoot
    ? prior
    : await resetRoot(systemId, project, worktree);

  await fs.mkdir(rootRaw, { recursive: true });
  // The CLI encodes its transcript directory from getcwd(), which is always the
  // realpath. A store reached through a symlink would otherwise give cc and the
  // CLI two spellings of one session directory (S14, and the same reason
  // resolveProjectDir realpaths an external project).
  const root = await fs.realpath(rootRaw);
  // The project's place INSIDE the image. Identical to `root` whenever the
  // provider advertises nothing, which is what makes that path unchanged.
  const cwd = path.join(root, mirror.offset);
  await fs.mkdir(cwd, { recursive: true });

  const listing = await listAllowed(system, systemPath, mirror);

  const next = new Map<string, ManifestEntry>();
  const skipped: SessionRootSkip[] = [];
  const pulled: string[] = [];
  let total = 0;

  for (const entry of listing) {
    // THE LAST GATE BEFORE BYTES LAND ON DISK. Unreachable by construction —
    // findManifest drops an excluded record — and kept because this loop is
    // where any enumeration leak, present or future, would become a file the
    // CLI's unhooked channels can read. A THROW rather than a skip: it can only
    // mean cc grew a listing source that bypassed the walk, which is a bug in
    // cc, not a condition a provider can cause.
    const covered = isExcluded(entry.abs, mirror.exclude);
    if (covered !== null) {
      throw new Error(
        `cc: the session-root pull reached '${entry.abs}', which system '${systemId}' `
        + `advertises as excluded under '${covered}'`,
      );
    }
    if (entry.size > SESSION_ROOT_FILE_CAP_BYTES) {
      skipped.push({ path: entry.rel, reason: `${entry.size} bytes is over the ${SESSION_ROOT_FILE_CAP_BYTES}-byte per-file cap` });
      continue;
    }
    if (total + entry.size > SESSION_ROOT_TOTAL_CAP_BYTES) {
      skipped.push({ path: entry.rel, reason: `the ${SESSION_ROOT_TOTAL_CAP_BYTES}-byte session-root cap was already reached` });
      continue;
    }
    total += entry.size;
    next.set(entry.rel, { size: entry.size, mtimeMs: entry.mtimeMs });
    const local = path.join(cwd, entry.rel);
    const prev = manifest.entries.get(entry.rel);
    // readFile only for CHANGED entries — the manifest is what turns a resume
    // into one `find` for an unchanged config surface. An entry whose local
    // copy has gone (a wiped store) is always re-pulled.
    if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs && await exists(local)) continue;
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, await system.readFile(entry.abs));
    pulled.push(entry.rel);
  }

  // An entry that has gone from the system must go from the root too. A stale
  // local copy is a boundary leak: Read would answer from a file the system,
  // and therefore Bash, says is not there.
  for (const rel of manifest.entries.keys()) {
    if (next.has(rel)) continue;
    await fs.rm(path.join(cwd, rel), { force: true });
  }

  // The CLI's own CLAUDE.md discovery is the only channel CONVENTIONS.md has,
  // and the system's copy is not required to have arranged the import. Applied
  // to the LOCAL copy only — the pull is one way, and rewriting the system's
  // file from a session composer would be a write nobody asked for.
  await ensureLocalImport(path.join(cwd, 'CLAUDE.md'), next.has('CLAUDE.md'));

  await writeManifest(
    systemId, project, worktree, system.remoteId ?? null,
    // OMITTED when the mirror is the project itself, exactly as `remoteId` is
    // omitted for an unbound handle: absent and "no advertisement" are the same
    // state, so a root composed against a provider that says nothing keeps a
    // manifest byte-identical to one written before mirrors existed.
    mirror.mirrorRoot === systemPath ? null : mirror.mirrorRoot,
    next,
  );
  return { root, cwd, mirror, pulled, skipped, notes };
}

// The root was pulled from a different target: remove it and its manifest, and
// hand back an empty one so everything below re-pulls.
async function resetRoot(systemId: string, project: string, worktree: string | null): Promise<Manifest> {
  await removeSessionRoot(systemId, project, worktree);
  return { remoteId: null, mirrorRoot: null, entries: new Map() };
}

interface Listed { rel: string; abs: string; size: number; mtimeMs: number }

// ONE batched `exec` for the whole allow-list — a `find` over the four fixed
// files and three fixed directories, plus a second pass for the `@`-imports the
// first pass's CLAUDE.md names. Two round trips at spawn, not one per entry.
async function listAllowed(system: System, systemPath: string, mirror: MirrorScope): Promise<Listed[]> {
  const targets = [...ALLOW_FILES, ...ALLOW_DIRS].map(rel => path.posix.join(systemPath, rel));
  const first = await findManifest(system, systemPath, targets, mirror.exclude);
  const claude = first.find(e => e.rel === 'CLAUDE.md');
  if (!claude) return first;
  const imports = parseImports(await system.readFile(claude.abs), systemPath);
  if (imports.length === 0) return first;
  const have = new Set(first.map(e => e.rel));
  // THE SECOND PASS IS BOUND BY THE SAME LIST. An import names an arbitrary
  // path in the project, so it is exactly the case a target-shaped filter
  // misses; passing `exclude` here rather than pre-filtering keeps ONE gate.
  const extra = (await findManifest(system, systemPath, imports, mirror.exclude))
    .filter(e => !have.has(e.rel));
  return [...first, ...extra];
}

// `-path` matches with fnmatch, so a path containing a glob metacharacter would
// otherwise be a PATTERN rather than the literal cc means. Backslash escapes it
// (fnmatch without FNM_NOESCAPE, which is what find uses).
function globLiteral(p: string): string {
  return p.replace(/[\\*?[\]]/g, m => `\\${m}`);
}

// CRITERION 7, at both granularities and with a backstop behind them.
//
// THE TARGET FILTER IS NOT ENOUGH, and that was measured rather than reasoned:
// an exclude covering something DEEPER than one of the seven targets leaves the
// target in the argv, so `find` enumerates the excluded file anyway. Three
// gates, narrowest first:
//
//   1. a target the exclude covers is never sent;
//   2. an exclude that could intersect the walk is a `-prune` operand, so the
//      far side never descends into it — enumeration leaks names, sizes and
//      mtimes into the manifest even when the bytes are withheld;
//   3. every RECORD is checked on arrival, because (2) is the far side's
//      behaviour and cc's answer must be correct whatever `find` did.
//
// Gate 3 is the one that closes the class: it is the single point every listing
// flows through, so a future caller cannot reintroduce the leak by finding a
// fourth way to name a path. Against a real `find` it is INVISIBLE — prune
// already stopped the record, so nothing arrives for it to drop — which is why
// its own behaviour is exercised against a far side that ignores the operands
// (`--ignore-prune` in tests/fixtures/mirrorFixtureProvider.mjs) rather than
// left to be inferred from the outer two holding.
async function findManifest(
  system: System, systemPath: string, targets: string[], exclude: readonly string[],
): Promise<Listed[]> {
  const wanted = targets.filter(abs => isExcluded(abs, exclude) === null);
  if (wanted.length === 0) return [];
  // Only the entries that could match something under the walk. An exclude
  // outside the project cannot, so the argv stays bounded by the tree rather
  // than by the advertisement's length — and with none in scope the argv is
  // byte-identical to what it was before excludes existed.
  const prunable = exclude.filter(e => withinPosix(e, systemPath) !== null);
  const prune = prunable.length === 0 ? [] : [
    '(',
    ...prunable.flatMap((e, i) => [
      ...(i === 0 ? [] : ['-o']), '-path', globLiteral(e), '-o', '-path', `${globLiteral(e)}/*`,
    ]),
    ')', '-prune', '-o',
  ];
  // NUL-terminated records, so a filename containing a newline is unambiguous
  // rather than a malformed line cc has to decide what to do with. `find` exits
  // non-zero for each absent target and still reports the ones that exist, so
  // the exit code is not the answer here — the records are.
  const r = await system.exec(
    { argv: ['find', ...wanted, ...prune, '-type', 'f', '-printf', '%s\\t%T@\\t%p\\0'] },
    { cwd: systemPath, stdin: 'ignore', maxBufferBytes: SESSION_ROOT_LISTING_FENCE_BYTES },
  );
  if (r.spawnError) {
    throw httpError(502, `composing the session root: could not list the config surface on the system: ${r.spawnError}`);
  }
  // THE FENCE FIRED, and this is why it cannot be §3.4's skip-with-warning. A
  // skip NAMES what it dropped. A truncated listing cannot: it is cut at an
  // arbitrary byte, and the record straddling the cut PARSES as a real one 70%
  // of the time (measured over 2,000 cut points in a real listing), so a
  // "partial success" hands the pull a path that does not exist and writes a
  // manifest missing an unknown set of entries — which the delete pass in
  // composeSessionRoot then makes the local root agree with.
  //
  // READ BEFORE THE RECORDS ARE, deliberately: the loop below would otherwise
  // reach the straddling record first and report cc's own memory fence as the
  // far side sending malformed output.
  if (r.outputOverflowed) {
    throw httpError(
      502,
      `composing the session root: listing the config surface under ${systemPath} on system `
      + `'${system.id}' produced more than ${SESSION_ROOT_LISTING_FENCE_BYTES} bytes of \`find\` output `
      + `and was stopped, so cc cannot tell which entries it did not see and will not compose a `
      + `session root from a partial listing. Something under ${ALLOW_DIRS.join(', ')} holds an `
      + `enormous number of files — move it out of the allow-list. The project itself is `
      + `unaffected: every file in it is still reachable through Bash and the file tools.`,
    );
  }
  const out: Listed[] = [];
  for (const rec of r.stdout.split('\0')) {
    if (rec === '') continue;
    const m = /^(\d+)\t(\d+(?:\.\d+)?)\t([\s\S]+)$/.exec(rec);
    if (!m) throw httpError(502, `composing the session root: unparseable find record ${JSON.stringify(rec)}`);
    const abs = m[3];
    const rel = withinPosix(abs, systemPath);
    // A `find` that walked out of the tree (a symlinked allow-list dir) is not
    // this project's config surface — dropped rather than written to a local
    // path composed from `..`.
    if (rel === null || rel === '') continue;
    // GATE 3. A provider whose `find` ignored `-prune`, or reached the record by
    // some route cc did not anticipate, still cannot get an excluded path into
    // the listing — and therefore into the manifest or onto disk.
    if (isExcluded(abs, exclude) !== null) continue;
    out.push({ rel, abs, size: Number(m[1]), mtimeMs: Math.round(Number(m[2]) * 1000) });
  }
  return out;
}

// ONE LEVEL of `@`-import, per §3.5. A chain deeper than that is an accepted
// limitation: pulling transitively means walking the system once per level at
// every spawn, for a shape almost no project uses.
//
// Absolute and escaping targets are dropped — an import is a path in the
// project's own tree, and one that is not cannot be placed under the root.
function parseImports(claudeMd: string, systemPath: string): string[] {
  const out: string[] = [];
  for (const line of claudeMd.split('\n')) {
    const m = /^\s*@(\S+)\s*$/.exec(line);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith('/') || spec.startsWith('~')) continue;
    const abs = path.posix.normalize(path.posix.join(systemPath, spec));
    if (withinPosix(abs, systemPath) === null) continue;
    out.push(abs);
  }
  return out;
}

// The session root's CLAUDE.md must carry the `@CONVENTIONS.md` import: a
// CONVENTIONS.md nothing imports delivers nothing. Same three branches as
// ensureConventionsImport — absent → create, present without → PREPEND keeping
// every byte, present with → no write — detected line-level so prose naming the
// file does not read as an import.
async function ensureLocalImport(target: string, pulled: boolean): Promise<void> {
  if (!pulled) {
    await fs.writeFile(target, `${CONVENTIONS_IMPORT_LINE}\n`);
    return;
  }
  const existing = await fs.readFile(target, 'utf8');
  if (existing.split('\n').some(line => line.trim() === CONVENTIONS_IMPORT_LINE)) return;
  await fs.writeFile(target, `${CONVENTIONS_IMPORT_LINE}\n${existing}`);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function readManifest(systemId: string, project: string, worktree: string | null): Promise<Manifest> {
  const empty: Manifest = { remoteId: null, mirrorRoot: null, entries: new Map() };
  try {
    const raw: unknown = JSON.parse(await fs.readFile(manifestPath(systemId, project, worktree), 'utf8'));
    if (!raw || typeof raw !== 'object') return empty;
    const rec = raw as { remoteId?: unknown; mirrorRoot?: unknown; entries?: unknown };
    const entries = (typeof rec.entries === 'object' && rec.entries !== null)
      ? new Map(Object.entries(rec.entries as Record<string, ManifestEntry>))
      : new Map<string, ManifestEntry>();
    return {
      remoteId: typeof rec.remoteId === 'string' && rec.remoteId ? rec.remoteId : null,
      mirrorRoot: typeof rec.mirrorRoot === 'string' && rec.mirrorRoot ? rec.mirrorRoot : null,
      entries,
    };
  } catch {
    // A missing or corrupt manifest costs a full re-pull, never a failed spawn:
    // it is a cache of what cc last wrote, not a record anything depends on.
    return empty;
  }
}

async function writeManifest(
  systemId: string, project: string, worktree: string | null,
  remoteId: string | null, mirrorRoot: string | null, entries: Map<string, ManifestEntry>,
): Promise<void> {
  await fs.writeFile(
    manifestPath(systemId, project, worktree),
    JSON.stringify({
      ...(remoteId === null ? {} : { remoteId }),
      ...(mirrorRoot === null ? {} : { mirrorRoot }),
      entries: Object.fromEntries(entries),
    }),
  );
}
