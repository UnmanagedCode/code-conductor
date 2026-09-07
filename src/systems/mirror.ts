// THE MIRROR SCOPE: how much of a system's filesystem the union's remote tier is the
// local image of, and which parts of it cc will not carry.
//
// A provider ADVERTISES `{mirrorRoot, exclude}` per target (`describeRemote`,
// docs/systems-protocol.md §2.1). cc does not derive either one: the far side
// knows its own layout and cc does not, so this module's whole job is to decide
// whether a claim is usable and what geometry it implies. It never opens the
// mirror root — the root is a PREFIX FOR PATH ARITHMETIC, so a non-directory
// root simply fails at the operation that touches it, carrying the far side's
// own reason rather than one cc invented.
//
// ONE CONTAINMENT PREDICATE serves the map, the exclude list and the validation
// (`withinPosix`), and it lives here rather than in the tier table because all
// three readers are about the mirror. Containment is decided with
// path.relative, never a string prefix: a prefix test claims a merely
// prefix-SHARING sibling (`/app-backup` under `/app`) is inside.

import path from 'node:path';
import { httpError } from '../httpError.ts';
import { MIRROR_EXCLUDE_MAX, MIRROR_PATH_MAX } from './protocol.ts';

// What a provider said, after validation. `mirrorRoot: null` is the valid
// "I advertise nothing" — the overwhelmingly common answer, and the one every
// provider that predates this frame gives by never being asked.
export interface MirrorAdvertisement {
  mirrorRoot: string | null;
  exclude: string[];
}

export const NO_ADVERTISEMENT: MirrorAdvertisement = { mirrorRoot: null, exclude: [] };

// The resolved geometry for one session. There is no `offset` any more: it was
// the project's place inside a LOCAL image of the mirror root, and the union
// serves the system's own paths, so the project is at its own path and nowhere
// else.
export interface MirrorScope {
  mirrorRoot: string;
  exclude: string[];
}

// The scope a project gets when nothing was advertised. Named, and the only
// spelling of it, so the fallback cannot drift into two forms.
export function noMirror(systemPath: string): MirrorScope {
  return { mirrorRoot: systemPath, exclude: [] };
}

// '' when equal, the relative path when inside, null when outside — in the
// SYSTEM's path space, which A4 fixes at `/`.
export function withinPosix(inner: string, outer: string): string | null {
  const rel = path.posix.relative(outer, inner);
  if (rel === '') return '';
  if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}



// The exclude entry that covers `systemAbs`, or null. The PREFIX comes back
// rather than a boolean so a refusal can name the rule and a model can
// generalise from it instead of retrying sibling by sibling.
export function isExcluded(systemAbs: string, exclude: readonly string[]): string | null {
  for (const e of exclude) {
    if (withinPosix(systemAbs, e) !== null) return e;
  }
  return null;
}

// ── card 2026-0259 §2.4: what cc will and will not believe ───────────

function invalid(systemId: string, detail: string): Error {
  // 502 for the reason REMOTE_NOT_FOUND is: the far side ANSWERED, and answered
  // badly. A 501 would say cc cannot do this at all, which is not the repair.
  return httpError(502, `system '${systemId}' sent an unusable mirror advertisement: ${detail}`, {
    code: 'MIRROR_ADVERTISEMENT_INVALID', systemRefusal: true,
  });
}

// Is `p` an absolute path already in its own normal form? cc REFUSES TO
// NORMALISE ON THE PROVIDER'S BEHALF: a normalised-away `..` is exactly how a
// hostile root would be smuggled past a containment test, and `/app/` vs
// `/app` are two spellings of one place that would compare unequal in a
// manifest. `/` is its own normal form despite the trailing separator.
function normalAbsolute(p: string): boolean {
  // A NUL is refused rather than carried. It is INERT everywhere downstream
  // today — nothing splits on it — which is exactly why it is dangerous: a
  // provider that meant `/proc` and sent `/proc\0` would advertise an exclude
  // that silently matches nothing, and the byte would ride verbatim into
  // refusal prose. There is no reading of it that is safely wrong.
  if (p.includes('\0')) return false;
  // Bounded before it can reach the tier table, the mount plan and every refusal
  // string composed from it.
  if (p.length > MIRROR_PATH_MAX) return false;
  // `normalize` PRESERVES a trailing separator ('/app/' normalizes to itself),
  // so it is tested separately rather than left to the round trip.
  if (p !== '/' && p.endsWith('/')) return false;
  return path.posix.isAbsolute(p) && p === path.posix.normalize(p);
}

// The SHAPE half of validation — everything decidable without knowing where the
// project is. Split from resolveMirrorScope because the two need different
// inputs and fire at different moments.
export function validateAdvertisement(systemId: string, raw: unknown): MirrorAdvertisement {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  let mirrorRoot: string | null = null;
  if (o.mirrorRoot !== undefined && o.mirrorRoot !== null) {
    if (typeof o.mirrorRoot !== 'string') {
      throw invalid(systemId, `mirrorRoot must be a string, got ${JSON.stringify(o.mirrorRoot)}`);
    }
    if (o.mirrorRoot.trim() === '') {
      throw invalid(systemId, `mirrorRoot is empty (${JSON.stringify(o.mirrorRoot)})`);
    }
    if (!normalAbsolute(o.mirrorRoot)) {
      throw invalid(systemId,
        `mirrorRoot ${JSON.stringify(o.mirrorRoot)} is not an absolute path in normal form — `
        + `cc does not normalise a provider's claim about its own layout`);
    }
    mirrorRoot = o.mirrorRoot;
  }

  const exclude: string[] = [];
  if (o.exclude !== undefined && o.exclude !== null) {
    if (!Array.isArray(o.exclude)) {
      throw invalid(systemId, `exclude must be an array, got ${JSON.stringify(o.exclude)}`);
    }
    if (o.exclude.length > MIRROR_EXCLUDE_MAX) {
      throw invalid(systemId, `exclude has ${o.exclude.length} entries, over the ${MIRROR_EXCLUDE_MAX}-entry cap`);
    }
    for (let i = 0; i < o.exclude.length; i++) {
      const e: unknown = o.exclude[i];
      if (typeof e !== 'string' || e.trim() === '' || !normalAbsolute(e)) {
        throw invalid(systemId,
          `exclude[${i}] must be an absolute path in normal form, got ${JSON.stringify(e)}`);
      }
      exclude.push(e);
    }
  }
  return { mirrorRoot, exclude };
}

// The PROJECT-RELATIVE half, and the geometry that falls out of it.
//
// Both refusals are 501 and join the SYSTEM_NO_REMOTES family: each is a
// mismatch between cc's own project record and the provider's advertisement,
// and the user can repair either side. They fire at SPAWN, never at project
// resolution — a bad advertisement breaks worker sessions and nothing else,
// since git, status, diff, worktrees and every `project_*` tool run at
// `systemPath` over `exec`/`readFile` and never touch the mirror.
export function resolveMirrorScope({ systemId, project, systemPath, advertisement }: {
  systemId: string; project: string; systemPath: string; advertisement: MirrorAdvertisement;
}): { scope: MirrorScope; inert: string[] } {
  if (advertisement.mirrorRoot === null) return { scope: noMirror(systemPath), inert: [] };
  const mirrorRoot = advertisement.mirrorRoot;

  // Containment, not an offset: what the project needs from the advertised
  // root is that the root CONTAINS it, and where inside no longer matters.
  if (withinPosix(systemPath, mirrorRoot) === null) {
    throw httpError(501,
      `project '${project}' is at '${systemPath}' on system '${systemId}', but that system advertises `
      + `'${mirrorRoot}' as its mirror root, which does not contain the project. cc will not narrow the `
      + `mirror to fit: fix the provider's advertised root, or re-register the project at a path inside it.`,
      { code: 'MIRROR_ROOT_EXCLUDES_PROJECT', systemRefusal: true });
  }

  const inert: string[] = [];
  for (const e of advertisement.exclude) {
    // An exclude that COVERS OR EQUALS the project is fatal for a session on
    // it: no file in the project could be read or written at all. An exclude
    // strictly INSIDE the project is legal and stays active — it withholds that
    // subtree from the union's remote tier. What ENFORCES that per path is
    // S2's — the tier table is the artifact, the hook consumer arrives with it
    // (docs/architecture.md → what `fileBridge` carried).
    if (withinPosix(systemPath, e) !== null) {
      throw httpError(501,
        `project '${project}' is at '${systemPath}' on system '${systemId}', but that system advertises `
        + `'${e}' as excluded from file mirroring, which covers the project itself. No file in this `
        + `project could be read or written. Fix the provider's exclude list.`,
        { code: 'MIRROR_EXCLUDE_COVERS_PROJECT', systemRefusal: true });
    }
    // Outside the mirror root entirely: sane configuration on a provider that
    // mirrors `/app` and also lists `/proc`, not an error. Reported, never
    // refused.
    if (withinPosix(e, mirrorRoot) === null) {
      inert.push(`system '${systemId}' excludes '${e}', which is outside its mirror root '${mirrorRoot}' — no effect`);
    }
  }
  return { scope: { mirrorRoot, exclude: advertisement.exclude }, inert };
}

// ── The refusal a worker reads mid-task ──────────────────────────────

// THE HIGHEST-VALUE SENTENCE IN THIS FEATURE, and every clause earns its place
// against one failure mode: a model that mistakes a refusal for file-not-found
// concludes the file is absent instead of using the channel that works.
//
//   `cc will not bridge`   — names cc as the actor and the act as a refusal.
//                            Not "cannot", which reads as inability.
//   the PREFIX, not just the path — so the model generalises instead of
//                            retrying sibling by sibling.
//   `NOT the file being absent — cc has not looked` — the anti-ENOENT clause,
//                            twice: a denial AND a positive statement of
//                            ignorance.
//   `Bash runs on … under no such restriction`, with `cat` / `sed -i` / `>`
//                          — the channel that works, with concrete verbs for
//                            both directions, delivered at the point of use.
//
// The word "found" and the phrase "does not exist" appear nowhere.
export function excludedRefusal(p: string, systemId: string, prefix: string): string {
  return `cc will not bridge '${p}' to this session: system '${systemId}' advertises '${prefix}' as `
    + `excluded from file mirroring, so Read, Write and Edit cannot reach any path under it. This is cc `
    + `refusing to carry the file, NOT the file being absent — cc has not looked, and this says nothing `
    + `about whether it exists. Bash runs on '${systemId}' under no such restriction: read it with `
    + `\`cat\`, change it with \`sed -i\` or a \`>\` redirect there instead.`;
}
