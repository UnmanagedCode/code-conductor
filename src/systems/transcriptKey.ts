// THE CLAUDE CLI'S TRANSCRIPT DIRECTORY, and the one guard that keeps two of
// cc's places out of the same one.
//
// The CLI names that directory `<configDir>/projects/<encodeCwd(getcwd())>`.
// Two places that resolve to the same one share it: their sessions interleave,
// and `findSessionLocation` cannot tell them apart. `encodeCwd` collapses `_`
// and `.` to `-`, so "the same" is wider than "the same path" and a byte
// comparison of cwds misses the interesting half.
//
// IT COMPARES THE WHOLE DIRECTORY, not the encoded cwd. Each remote is given a
// CLI config directory of its own (`remoteConfigDir`), so the root differs per
// machine and two boxes at `/root/app3` are two directories — which is the
// configuration this guard used to refuse and now admits. What still collides
// is what genuinely IS one directory: two places on ONE target at one path, and
// two LOCAL places whose cwds encode alike.
//
// DERIVED THROUGH `transcriptRoot`, never re-spelled here: a guard that
// composed the directory itself could disagree with the thing it guards.

import { encodeCwd, normalizeSystemPath, transcriptRoot } from '../projects.ts';
import path from 'node:path';

export interface TranscriptPlace {
  project: string;
  worktree: string | null;
  system: string;
  // WHICH TARGET of that system — part of the identity, because two targets of
  // one system get separate config directories and therefore separate
  // transcript directories.
  remoteId: string | null;
  // The CLI's working directory for this place: the project's or worktree's
  // path on whatever machine it lives on.
  cwd: string;
}

export interface TranscriptCollision extends TranscriptPlace {
  // ONE DIRECTORY (however it is spelled) versus two directories that merely
  // encode alike. The refusal says which, because they are different harms and
  // a reader picking a new name needs to know which characters matter.
  //
  // DERIVED FROM THE NORMALISED PATHS, not from raw string equality: `/srv/app`
  // and `/srv/app/` are one directory, and calling them two would send a user
  // to the encode-only branch, whose "the two directories stay separate" is
  // then simply false.
  samePath: boolean;
}

// Every place cc has registered, on every system, with the cwd a session in it
// would run at. Store reads only — no System handle is taken and no remote is
// contacted, because a guard that has to reach another machine to answer would
// refuse a creation whenever that machine is down.
//
// The worktree cwd is DERIVED by the same rule createWorktree uses rather than
// read back, so the guard cannot disagree with the thing it guards; see
// `worktreePathFor`.
export async function registeredPlaces(): Promise<TranscriptPlace[]> {
  // Lazy, for the projects.ts ↔ worktrees.ts circular edge every caller of this
  // guard already sits on.
  const { listProjects } = await import('../projects.ts');
  const { registeredWorktreeNames, worktreePathFor } = await import('../worktrees.ts');
  const out: TranscriptPlace[] = [];
  for (const proj of await listProjects()) {
    // A row whose record could not be parsed carries no path, so it names no
    // directory anything could collide with.
    if (proj.degraded) continue;
    out.push({
      project: proj.name, worktree: null, system: proj.system, remoteId: proj.remoteId,
      cwd: proj.path,
    });
    for (const wt of await registeredWorktreeNames(proj.name)) {
      out.push({
        project: proj.name, worktree: wt, system: proj.system, remoteId: proj.remoteId,
        cwd: worktreePathFor(proj, wt),
      });
    }
  }
  return out;
}

// A registered place whose transcript directory the candidate would land in, or
// null.
//
// THE CANDIDATE'S OWN IDENTITY IS NOT A COLLISION. Re-creating a worktree that
// is already registered is a duplicate-create, which createWorktree's branch
// pre-check diagnoses far better than this guard could — it names the two
// states a user can be in, where this one would only say "pick another name".
export async function transcriptCwdCollision(
  candidate: TranscriptPlace,
  places?: readonly TranscriptPlace[],
): Promise<TranscriptCollision | null> {
  // NORMALISED BEFORE ENCODING, on BOTH sides. The write path stores a
  // normalised `systemPath`, but the predicate must not depend on that: an
  // un-normalised spelling reaching here would encode differently — `/srv/app/`
  // is `-srv-app-` and `/srv/app` is `-srv-app` — and one directory would pass
  // the guard as two, which is the bypass this closes.
  const mine = normalizeSystemPath(candidate.cwd);
  const myDir = directoryFor(candidate, mine);
  for (const held of places ?? await registeredPlaces()) {
    if (held.project === candidate.project && held.worktree === candidate.worktree) continue;
    const theirs = normalizeSystemPath(held.cwd);
    if (directoryFor(held, theirs) === myDir) return { ...held, samePath: theirs === mine };
  }
  return null;
}

// The transcript directory a place's sessions land in, from the NORMALISED cwd.
function directoryFor(place: TranscriptPlace, normalisedCwd: string): string {
  return path.join(transcriptRoot({ ...place, cwd: normalisedCwd }), encodeCwd(normalisedCwd));
}

// The refusal sentence, in ONE shape for all three creation paths, naming both
// members of the pair and what they would share. `subject` is the candidate as
// the caller would say it ("project 'x'", "worktree 'w' of project 'p'").
export function transcriptCollisionReason(
  subject: string, candidate: TranscriptPlace, hit: TranscriptCollision,
): string {
  const heldName = hit.worktree
    ? `worktree '${hit.worktree}' of project '${hit.project}'`
    : `project '${hit.project}'`;
  // Named only when it is not this one's, because "on system 'local'" in the
  // ordinary all-local case is noise; when the two differ it is the whole
  // explanation for why two paths that look unrelated are not.
  const where = hit.system === candidate.system && hit.remoteId === candidate.remoteId
    ? ''
    : ` on ${hit.remoteId === null ? `system '${hit.system}'` : `remote '${hit.remoteId}' of system '${hit.system}'`}`;
  // BOTH HALVES BRANCH ON `samePath`, not just the first. In the encode-only
  // branch the two places are genuinely different directories, so the flat
  // one-directory harm would be a plain falsehood two clauses after saying the
  // paths differ.
  const [shared, harm] = hit.samePath
    ? [
      `its working directory would be '${candidate.cwd}', which is already ${heldName}'s${where}`,
      'Two places in one directory share a transcript directory, and their sessions interleave in it.',
    ]
    : [
      `its working directory '${candidate.cwd}' differs from ${heldName}'s${where} ('${hit.cwd}') only in `
        + "characters the Claude CLI collapses when it names a transcript directory ('_' and '.' both become '-')",
      'The two directories stay separate, but the sessions in them would land in one transcript '
        + "directory — each place listing the other's sessions as its own.",
    ];
  return `cannot register ${subject}: ${shared}. ${harm} Pick another name.`;
}
