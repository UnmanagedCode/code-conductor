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
import { encodeCwd, orchStoreRoot, projectsBySystem } from '../projects.ts';
import { httpError } from '../httpError.ts';
import { CONVENTIONS_IMPORT_LINE } from '../conventionsImport.ts';
import {
  isExcluded, mirrorOffsets, resolveMirrorScope, within, withinPosix, type MirrorScope,
} from './mirror.ts';
import { LOCAL_SYSTEM_ID } from './localSystem.ts';
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

// THE KEY, and it is NOT INJECTIVE. `--` separates the project from its
// worktree, but `--` is also legal INSIDE a project name (validateName's
// charset is `[a-zA-Z0-9._-]`), so a project literally named `p--p_worktree_w`
// computes the key worktree `p_worktree_w` of project `p` computes: one root,
// one manifest, one CLI cwd, one transcript directory.
//
// Do not re-derive an "unambiguous" claim from the charsets. The right half is
// the worktree DIRECTORY name `<project>_worktree_<slug>` (worktrees.ts), not a
// bare slug, so it carries `_` and the project's own name — which is exactly
// why the reachable collider embeds its own prefix twice.
//
// What makes the key safe is not its spelling: it is sessionRootKeyCollision
// below, refused at every creation path, plus the fact that nothing renames a
// registered place afterwards. The claim that earns is narrow and is the only
// one to make — no REGISTERED pair on one system shares a key — not that the
// key is injective (card 2026-0293 §10).
//
// One home for the key, so a guard and a path cannot disagree about it.
export function sessionRootKey(project: string, worktree?: string | null): string {
  return worktree ? `${project}--${worktree}` : project;
}

export function sessionRootPath(systemId: string, project: string, worktree?: string | null): string {
  return path.join(sessionRootsDir(systemId), sessionRootKey(project, worktree));
}

// A place already registered on `systemId` whose session-root key collides with
// the candidate's, or null. Returns null for the local system: a local place
// has no session root, so it has no key to collide on.
//
// OVER COMPUTED KEYS, never over parsed `--` splits. A split-parser would have
// to know that a worktree slug cannot contain `--` — true, because
// slugifyWorktreeName collapses every RUN of non-alphanumerics to a single `-`,
// which is a charset property and not a sample — but that is a fact about a
// function this module does not own. Comparing what sessionRootKey actually
// returns cannot be wrong about it, and survives any change to either.
//
// `encodeCwd`-EQUALITY, NOT byte-equality. Byte-equality catches only the
// one-root case. The CLI names its transcript directory with encodeCwd, which
// collapses `_`, `.` and `/` alike to `-`, so `a--a_worktree_b` and
// `a--a-worktree-b` are two roots that normally land in ONE transcript
// directory: each place lists the other's sessions as its own, and
// findSessionLocation attributes a session to whichever it met first.
//
// A PROXY FOR THAT COLLISION, WRONG IN BOTH DIRECTIONS, AND KEPT ANYWAY. The
// CLI's cwd is `realpath(root) + mirror.offset` and the offset is the
// PROVIDER's, so:
//   • WIDER — two places whose keys encode alike but whose providers advertise
//     different mirror geometries do not in fact share a directory, so this
//     refuses a pair that would have been fine (card 2026-0293 §G-4).
//   • NARROWER — the offset contributes characters this comparison never sees,
//     so a pair whose KEYS differ can still land in one transcript directory
//     (project `p` at offset `-q` versus project `p--q`). NOT refused, here or
//     anywhere; card 2026-0304 owns that half. Do not read this predicate, or
//     any doc describing it, as sufficient.
// Keying on the key rather than the offset is the deliberate trade: the key is
// cc's own geometry and stable, while an offset changes with a connection
// generation, and a refusal whose answer changed when a box went down would be
// worse than one that is merely a proxy. The byte-equal half is unconditional
// regardless of any offset.
//
// NO SELF-EXCLUSION IS NEEDED, at this call site or any other, because
// encodeCwd is LENGTH-PRESERVING and so can only merge keys of equal length: a
// worktree's candidate key `p--p_worktree_w` can never match its own project's
// key `p`.
//
// A systemId containing `_` would collide with its `-` twin one level up, in
// sessionRootsDir — UNREACHABLE, and deliberately unguarded: SLUG_RE
// (src/identifiers.ts) admits no `_` in a system id, and pinning a state no
// supported operation reaches is what card 2026-0287 got wrong. WIDENING
// SLUG_RE TO ADMIT `_` REOPENS IT, and this enumeration — scoped to one
// systemId — would not see it (card 2026-0293 §G-2).
//
// STORE-ONLY: projectsBySystem is record-derived and registeredWorktreeNames
// readdirs cc's own store, so no creation path grows a system round trip and no
// system being DOWN can change the answer.
//
// A STORE DEGRADATION CAN, THOUGH, AND IT FAILS OPEN — silently and
// permissively. A corrupt `project.json` degrades to EMPTY_META, so the project
// reads as local and it AND all its worktrees drop out of projectsBySystem();
// registeredWorktreeNames swallows any readdir error to []. Either loses places
// from this enumeration, and a lost place cannot be collided with. Left open
// deliberately: failing closed would refuse every create on a system because
// some unrelated project's record is corrupt, and that corruption already
// demotes the project to local everywhere else. No supported operation produces
// one.
export async function sessionRootKeyCollision(
  systemId: string, project: string, worktree: string | null,
): Promise<SessionRootCollision | null> {
  if (systemId === LOCAL_SYSTEM_ID) return null;
  const key = sessionRootKey(project, worktree);
  const encoded = encodeCwd(key);
  // Lazy, for the same projects.ts <-> worktrees.ts circular edge every other
  // caller of this function sits on (src/projects.ts).
  const { registeredWorktreeNames } = await import('../worktrees.ts');
  for (const { name } of (await projectsBySystem())[systemId] ?? []) {
    for (const wt of [null, ...await registeredWorktreeNames(name)]) {
      // THE CANDIDATE'S OWN IDENTITY IS NOT A COLLISION. Re-creating a worktree
      // that is already registered is a DUPLICATE-CREATE, and createWorktree's
      // branch pre-check diagnoses that far better than this guard could —
      // it names the two states a user can be in ("still registered" / "deleted
      // and left the branch behind"), where this one would only say "pick
      // another name". Distinct from the self-collision the length argument
      // below rules out: that one is a candidate against its own PROJECT's key,
      // which cannot match; this one is a candidate against ITSELF, which can.
      if (name === project && wt === worktree) continue;
      const held = sessionRootKey(name, wt);
      if (encodeCwd(held) === encoded) {
        return { project: name, worktree: wt, key: held, sameRoot: held === key };
      }
    }
  }
  return null;
}

export interface SessionRootCollision {
  project: string;
  worktree: string | null;
  key: string;
  // Byte-equal keys (literally one root), versus keys that merely encode alike
  // (two roots that normally share one transcript directory). The refusal says
  // which, because they are different harms and a reader picking a new name
  // needs to know which characters matter.
  sameRoot: boolean;
}

// The refusal sentence, in ONE shape for all three creation paths, naming both
// members of the pair and what they would share. `subject` is the candidate as
// the caller would say it ("project 'x'", "worktree 'w' of project 'p'").
export function sessionRootCollisionReason(
  systemId: string, subject: string, candidateKey: string, hit: SessionRootCollision,
): string {
  const held = hit.worktree
    ? `worktree '${hit.worktree}' of project '${hit.project}'`
    : `project '${hit.project}'`;
  const heldPath = path.join(sessionRootsDir(systemId), hit.key);
  // BOTH HALVES BRANCH ON `sameRoot`, not just the first. In the encode-only
  // branch the two places do NOT share a session root, so the flat one-root
  // harm would be a plain falsehood two clauses after saying the roots differ.
  // Hence "normally" — the predicate is a proxy in both directions, for the
  // reasons on sessionRootKeyCollision above. That reasoning stays in a comment
  // and out of the string: a provider's mirror offset is not something a user
  // picking a new name can act on, and a refusal has to stay short.
  const [shared, harm] = hit.sameRoot
    ? [
      `its session root would be '${heldPath}', which already belongs to ${held}`,
      `Two places on one session root share a config surface, a manifest and a transcript directory.`,
    ]
    : [
      `its session root would be '${path.join(sessionRootsDir(systemId), candidateKey)}', which differs `
        + `from the one ${held} already holds ('${heldPath}') only in characters the Claude CLI collapses `
        + `when it names a transcript directory ('_' and '.' both become '-')`,
      `The two roots stay separate, but the sessions in them would normally land in one transcript `
        + `directory — each place listing the other's sessions as its own.`,
    ];
  return `cannot register ${subject} on system '${systemId}': ${shared}. ${harm} Pick another name.`;
}

// EVERY LOCAL CWD a session on this (system, project, worktree) can have run
// in — the read-only counterpart of the two lines pullSessionRoot computes
// before a launch: realpath the image root, then join the mirror offset. It
// lives here, beside sessionRootPath and the only other place that knows this
// geometry, so a locator does not grow a second copy of it (card 2026-0292).
//
// REALPATH, not the raw path: projectsRoot() is `PROJECTS_ROOT` verbatim while
// the CLI keys its transcript directory off getcwd(), so a store reached
// through a symlink gives cc and the CLI two spellings of one session dir —
// the same reason pullSessionRoot realpaths below. Realpath failure falls back
// to the raw path: a root that does not exist holds no session either way.
//
// COMPLETE, which is what makes it a SEARCH SPACE rather than a guess — see
// mirrorOffsets' own contract in ./mirror.ts for why no advertisement can put a
// session at a cwd outside this set. `systemPath` is the path of the PLACE
// being asked about, so a worktree's offsets come from the worktree's own path
// on the system, not from its project's.
export async function sessionRootCwds(
  systemId: string, project: string, worktree: string | null, systemPath: string,
): Promise<string[]> {
  const raw = sessionRootPath(systemId, project, worktree);
  const root = await fs.realpath(raw).catch(() => raw);
  return mirrorOffsets(systemPath).map(o => path.join(root, o));
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

// CAPS AND A FENCE, and the difference is in what each one BOUNDS rather than
// in how many of each there are.
//
// Per §3.4's "warns loudly and skips rather than failing the spawn": a repo that
// committed one enormous FILE under `.claude/skills` must not be a project cc
// cannot open a session on, and neither must one that committed an enormous
// NUMBER of small ones. The caps here skip and NAME; the fence below refuses,
// because it cannot name what it dropped (card 2026-0274).
export const SESSION_ROOT_FILE_CAP_BYTES = 256 * 1024;
export const SESSION_ROOT_TOTAL_CAP_BYTES = 4 * 1024 * 1024;

// WHY A COUNT AND NOT ONLY BYTES. The total cap sums SIZES, so it never fires
// for a tree of many tiny files. Measured over the wire: 14,589 one-byte files
// under `.claude/skills` were pulled IN FULL — 14,597 readFile round trips,
// 8.6 s, a 969 KB manifest, `skipped` empty — for ~14 KB of content, on every
// spawn AND every resume. The fence below bounds that only indirectly, at
// ~92,000 entries at ordinary path lengths, and it refuses rather than
// degrading — so before this cap existed, a project just under the fence was
// merely slow and one just over it could not open a session at all. Only the
// second half still holds, and it is the LIMIT of what this cap buys: it
// degrades everything below the fence's ceiling and nothing above it.
//
// 2,000 is far above any real config surface — the largest `.claude/skills`
// tree measured on this host is 53 files, and the entire official plugin
// marketplace is 446 across skills, commands and agents — and it holds that
// same 14,589-file tree to 2 `exec` + 2,005 `readFile` round trips, ~1.6 s and
// a 133 KB manifest, with a resume falling from 823 ms to ~200 ms — 2 `exec` +
// 1 `readFile` — CLAUDE.md, for the imports pass — and not one entry re-pulled.
//
// IT COUNTS LISTING POSITIONS, NOT SUCCESSFUL PULLS, which is what makes one
// number bound the round trips, the manifest, the skip list and the stderr
// those skips become, all at once: the two caps above can only fire inside the
// window this one admits, so the 10,494 skip lines (1.24 MB) the same tree
// reaches through the byte cap at 1 KiB per file become ~2,005 at worst.
// A tree whose admitted window is mostly over the per-file cap therefore
// salvages less content than a budget of successful PULLS would — that outcome
// is named entry by entry either way, and is accepted.
//
// NOT exported and NOT a setting: the tests assert the literal, so reading the
// number out of the module under test cannot be what makes them pass.
const SESSION_ROOT_ENTRY_CAP = 2000;

// A FENCE, not another cap — the distinction is in the name because it is the
// whole difference in behaviour. The caps above bound WHAT IS PULLED — the
// bytes of one entry, the bytes of the whole surface, and how much of the
// listing is considered at all — and every one of them SAYS what it refused:
// the byte caps name each entry they drop, the entry cap names the first and
// counts the rest. This one bounds the BYTES OF `find` OUTPUT those records are parsed
// out of — a different quantity from the entry cap's count of positions WITHIN
// a parsed listing — and past it the compose FAILS, for the reason
// runGit's does (src/worktrees.ts): findManifest parses the output WHOLE, so a
// clipped-but-successful parse is read as the config surface itself.
//
// Nothing bounded the listing before, and it is re-materialised at every stage
// between the `find` output and the manifest's JSON, on every spawn AND every
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
  const placement = { system, systemId, systemPath, project, worktree };
  const prior = await readManifest(systemId, project, worktree);
  const priorMirror = prior.mirrorRoot ?? systemPath;
  if (prior.remoteId === (system.remoteId ?? null) && priorMirror === mirror.mirrorRoot) {
    return pullSessionRoot(placement, mirror, notes, prior);
  }

  // THE ROOT IS REJECTED FROM HERE ON, and nothing below may be read as a
  // fallback: it was pulled from a different target, and diffing against a
  // manifest that describes another machine is precisely how the old target's
  // bytes end up under the new target's paths.
  //
  // THE REMOVAL IS INSIDE THE TRY, not before it. Both halves of a failed reset
  // are states cc must not launch on and neither is distinguishable from the
  // other by the time the error arrives: a removal that threw before deleting
  // leaves the REJECTED target's whole surface sitting there looking like a
  // last-good root, and one that threw after leaves a partial pull. So every
  // throw from here on is marked, and Instance._refreshSessionRoot refuses the
  // relaunch for it.
  try {
    const fresh = await resetRoot(systemId, project, worktree);
    return await pullSessionRoot(placement, mirror, notes, fresh);
  } catch (e) {
    throw markDiscarded(e);
  }
}

// The whole of the composition BELOW the target check, taking the manifest that
// check decided on: the prior one when it held, an empty one when the root was
// discarded and everything must be re-pulled.
async function pullSessionRoot(
  { system, systemId, systemPath, project, worktree }: {
    system: System; systemId: string; systemPath: string; project: string; worktree: string | null;
  },
  mirror: MirrorScope,
  notes: string[],
  manifest: Manifest,
): Promise<ComposedSessionRoot> {
  const rootRaw = sessionRootPath(systemId, project, worktree);

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

  const { pinned, capped } = await listAllowed(system, systemPath, mirror);
  // THE ENTRY CAP, applied HERE rather than inside the loop below. `pinned` is
  // admitted because it is pinned, and the loop keeps the shape it had — a gate
  // inside it would compute the same answer while being redundant with the
  // ranking, and therefore unkillable by any test.
  //
  // `pinned` LEADS, and that is load-bearing a SECOND time, independently of the
  // cap: the total-bytes cap below is first-come-first-served, and a pinned entry
  // is still subject to it. Measured with these two concatenated the other way
  // round, on a project with a 100 KB CLAUDE.md and 2,500 4 KiB skills: the
  // skills take the whole 4 MiB budget, CLAUDE.md and CONVENTIONS.md are BOTH
  // skipped by it, and ensureLocalImport then writes a 16-byte CLAUDE.md whose
  // @CONVENTIONS.md names a file that is not there — a config surface that looks
  // present and delivers nothing (card 2026-0274).
  const listing = [...pinned, ...capped.slice(0, SESSION_ROOT_ENTRY_CAP)];
  const dropped = capped.slice(SESSION_ROOT_ENTRY_CAP);

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

  // ONE skip for the whole overflow, not one per entry. THIS cap CAN name every
  // entry it dropped — that is exactly what separates it from the fence, which
  // cannot — but naming 12,592 of them puts 12,592 `system`/`stderr` lines on
  // the session at every launch, which is a second way to make a large config
  // surface expensive: measured, the same shape reached 10,494 lines and 1.24 MB
  // through the byte cap with nothing bounding the listing positions, which the
  // cap above now holds to ~2,005. The first entry not pulled, the total, and a
  // per-target rollup are what a user acts on.
  if (dropped.length > 0) {
    skipped.push({
      path: dropped[0].rel,
      reason: `the ${SESSION_ROOT_ENTRY_CAP}-entry session-root cap was already reached, so `
        + `${dropped.length} further ${dropped.length === 1 ? 'entry was' : 'entries were'} `
        + `not pulled (${rollup(dropped)})`,
    });
  }

  // An entry that has gone from the system must go from the root too — and an
  // entry that has fallen PAST the cap since an earlier compose is simply absent
  // from `next`, so it takes this path unchanged. A stale local copy is a
  // boundary leak: Read would answer from a file the system, and therefore Bash,
  // says is not there.
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

// A compose that FAILED after the target check had already discarded whatever
// earlier compose was at the root. There is no last-good root behind such a
// failure, so a caller that would otherwise warn and carry on has nothing to
// carry on with — see Instance._refreshSessionRoot.
//
// A SYMBOL rather than an `httpError` field: this rides on errors that reach
// REST and MCP bodies, and a merged string field would become part of them. And
// a MARK on the original error rather than a wrapper, so the refusal the create
// path already raises keeps its exact message and its exact status.
//
// Measured over four ways the walk and the pull can fail — the listing fence, a
// `spawnError`, a transport death mid-walk, and a readFile failure mid-pull —
// the target check is the whole discriminator. With it NOT holding, every one
// of them leaves the root without a config surface. With it HOLDING, none of
// them touches the MANIFEST — `writeManifest` is the last statement of the pull
// — so the next compose converges from it; the three that fail during the WALK
// leave the prior root byte-identical, and one that fails during the PULL
// leaves it partly re-pulled, from the SAME target, which is what makes warn-
// and-carry-on right there. So this marks the CHECK, not the failure (card
// 2026-0273) — and it cannot key on `statusCode`, which the mid-pull failure
// does not carry.
const DISCARDED = Symbol.for('cc.sessionRoot.discarded');

// The OBJECT branch is every case that occurs today: every throw site reachable
// from the pull raises an Error, and the original is rethrown untouched but for
// the symbol.
//
// A NON-OBJECT throw cannot carry a property, so it is wrapped and the wrapper
// is marked. NOT a claim that anything throws one — nothing here does, and this
// branch is unreachable today. It exists so the refusal is a property of THIS
// function rather than of its callers' throw shapes: an unmarked failure warns
// and carries on, which is exactly the silent relaunch this closes.
function markDiscarded(e: unknown): unknown {
  const err: object = (typeof e === 'object' && e !== null) ? e : new Error(String(e));
  (err as Record<symbol, unknown>)[DISCARDED] = true;
  return err;
}

export function composedRootWasDiscarded(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as Record<symbol, unknown>)[DISCARDED] === true;
}

// The root was pulled from a different target: remove it and its manifest, and
// hand back an empty one so everything below re-pulls.
async function resetRoot(systemId: string, project: string, worktree: string | null): Promise<Manifest> {
  await removeSessionRoot(systemId, project, worktree);
  return { remoteId: null, mirrorRoot: null, entries: new Map() };
}

export interface Listed { rel: string; abs: string; size: number; mtimeMs: number }

// THE RANKING, and it is CC'S rather than `find`'s.
//
// A count bound drops whatever the listing order puts past it, so the ORDER is
// the design. The starting points come back in argv order — which is what puts
// the four ALLOW_FILES at listing positions 0-3, and the `@`-imports pass, a
// SECOND `find` whose records are appended after the whole first pass, LAST —
// but the order PAST them is the `find` IMPLEMENTATION's, and findManifest runs
// `find` off the REMOTE system's PATH, so it is the target machine's choice and
// not cc's. Measured over one argv, GNU findutils and bfs descend depth-first
// and breadth-first respectively and agree with neither each other nor the
// ranking below (both orders are in tests/systems-session-root.test.mjs), so
// inheriting that order would make this guarantee a claim about which `find`
// the far side happens to ship (card 2026-0274).
//
// PINNED is the four ALLOW_FILES, and it is exempt from the entry cap because
// it is PINNED, never because it is short: its size is a property of THIS FILE
// rather than of the tree, so a fifth entry in ALLOW_FILES leaves the bound
// intact.
//
// CAPPED is everything else, `@`-imports first — content CLAUDE.md explicitly
// asks the CLI to load outranks an optional skill.
//
// BOTH HALVES OF `capped` ARE SORTED, for one reason: every order arriving here
// is `find`'s. Within a directory it is readdir order — stable across runs on
// the filesystem measured here, but not by contract, and an unstable one would
// have a resume delete and re-pull a different 2,000 entries every time. The
// imports are no exception: ONE `find` walks all of them, so their records come
// back in argv-then-readdir order too, and an import naming a DIRECTORY (which
// findManifest's refusal below already notes is possible) is readdir order
// outright. Sorting costs 89 ms at the listing fence's ceiling of ~96,000
// records, 1 ms at 15,000. What it costs in MEANING: CLAUDE.md's `@`-line order
// stops ranking its own imports — never a designed signal, only the same
// inherited accident this function exists to delete.
export interface RankedSurface { pinned: Listed[]; capped: Listed[] }

const byRel = (a: Listed, b: Listed) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

// Exported for ONE reason: a test must be able to feed it a listing cc's own
// callers can never produce.
export function rankConfigSurface(targets: Listed[], imports: Listed[]): RankedSurface {
  const pinned: Listed[] = [];
  const dirs: Listed[] = [];
  for (const e of targets) (ALLOW_FILES.includes(e.rel) ? pinned : dirs).push(e);
  pinned.sort((a, b) => ALLOW_FILES.indexOf(a.rel) - ALLOW_FILES.indexOf(b.rel));
  // `imports` is the caller's array; `listAllowed` has already filtered it
  // against `have`, and sorting it in place would reorder that caller's data.
  return { pinned, capped: [...[...imports].sort(byRel), ...dirs.sort(byRel)] };
}

// ONE batched `exec` for the whole allow-list — a `find` over the four fixed
// files and three fixed directories, plus a second pass for the `@`-imports the
// first pass's CLAUDE.md names. Two round trips at spawn, not one per entry.
async function listAllowed(system: System, systemPath: string, mirror: MirrorScope): Promise<RankedSurface> {
  const targets = [...ALLOW_FILES, ...ALLOW_DIRS].map(rel => path.posix.join(systemPath, rel));
  const first = await findManifest(system, systemPath, targets, mirror.exclude);
  const claude = first.find(e => e.rel === 'CLAUDE.md');
  if (!claude) return rankConfigSurface(first, []);
  const imports = parseImports(await system.readFile(claude.abs), systemPath);
  if (imports.length === 0) return rankConfigSurface(first, []);
  const have = new Set(first.map(e => e.rel));
  // THE SECOND PASS IS BOUND BY THE SAME LIST. An import names an arbitrary
  // path in the project, so it is exactly the case a target-shaped filter
  // misses; passing `exclude` here rather than pre-filtering keeps ONE gate.
  //
  // DEDUPED BY REL AGAINST ITSELF, not only against the targets pass. `imports`
  // is one entry per `@` line, so a CLAUDE.md naming the same file twice sends
  // `find` the same path twice and gets the record back twice — as does an
  // import naming a DIRECTORY that another import sits under. The double pull
  // that produced is older than the entry cap: it cost a second `readFile` on
  // every COLD pull (a resume's manifest check short-circuits both copies) and a
  // second charge against the byte budget on every compose, since `total` is
  // charged above that check. What the cap turned it into is a FALSE CLAIM,
  // because 2,001 copies of one import fill the cap and the summary skip then
  // names a file that is on disk. Fixed by construction here rather
  // than reworded downstream, so the cap bounds 2,000 DISTINCT entries.
  //
  // Scoped to this pass because it is the only one whose targets a project
  // controls: the seven allow-list targets are disjoint by construction.
  const extra: Listed[] = [];
  for (const e of await findManifest(system, systemPath, imports, mirror.exclude)) {
    if (have.has(e.rel)) continue;
    have.add(e.rel);
    extra.push(e);
  }
  return rankConfigSurface(first, extra);
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
    // NAMES THE SYSTEM, like its sibling refusal below: this is the message a
    // resume shows when the box cannot answer, and "the system" sends a reader
    // with several registered to look at all of them (card 2026-0292).
    throw httpError(502, `composing the session root: could not list the config surface on system '${system.id}': ${r.spawnError}`);
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
    // NAME THE PATHS THIS PASS ACTUALLY WALKED. The allow-list is only one of
    // the two callers: the `@`-imports pass walks whatever CLAUDE.md names,
    // including a DIRECTORY, which `find` recurses. A message that blamed
    // ALLOW_DIRS would send a user to inspect `.claude/skills` for files that
    // are under `docs/`, and offer advice — take it out of the allow-list —
    // that is impossible for a path never in it. Truncated because this list is
    // as long as CLAUDE.md has `@` lines, and an unbounded string inside the
    // refusal for an unbounded listing would be the same mistake twice.
    const walked = wanted.map(p => withinPosix(p, systemPath) || p);
    const named = walked.length > 10
      ? `${walked.slice(0, 10).join(', ')} and ${walked.length - 10} more`
      : walked.join(', ');
    throw httpError(
      502,
      `composing the session root: listing the config surface under ${systemPath} on system `
      + `'${system.id}' produced more than ${SESSION_ROOT_LISTING_FENCE_BYTES} bytes of \`find\` output `
      + `and was stopped, so cc cannot tell which entries it did not see and will not compose a `
      + `session root from a partial listing. This pass walked ${named}, and the fence counts `
      + `everything under those together — no single one of them need be the whole cause. Move `
      + `files out from under them, or — for any that CLAUDE.md names as an @-import — stop `
      + `importing it. Bash is unaffected and still reaches every file in the project: it runs `
      + `on '${system.id}' rather than through the mirrored file tools.`,
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

// Which TARGET the dropped entries came from, which is what a user can act on —
// a list of paths would be as long as the overflow itself. An entry under none
// of the recursive dirs came from the `@`-imports pass, the only other source.
function rollup(dropped: Listed[]): string {
  const counts = new Map<string, number>();
  for (const e of dropped) {
    const dir = ALLOW_DIRS.find(d => e.rel === d || e.rel.startsWith(`${d}/`)) ?? '@-imports';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].map(([d, n]) => `${d} ${n}`).join(', ');
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
