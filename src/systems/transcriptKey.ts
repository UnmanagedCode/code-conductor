// THE CLAUDE CLI'S TRANSCRIPT DIRECTORY, and the one guard that keeps two of
// cc's places out of the same one.
//
// The CLI names that directory `~/.claude/projects/<encodeCwd(getcwd())>`. Two
// places whose cwds encode alike therefore share it: their sessions interleave,
// and `findSessionLocation` cannot tell them apart. `encodeCwd` collapses `_`
// and `.` to `-`, so "alike" is wider than "equal" and a byte comparison misses
// the interesting half.
//
// WHY THIS FILE REPLACED `sessionRoot.ts`. Under the FUSE-union geometry a
// remote session's cwd is the project's real path ON ITS SYSTEM — there is no
// cc-owned local session root any more, and nothing here has anything to do
// with one. What survived the geometry is this guard's JOB; what changed is the
// key it compares.
//
// AND IT NOW COMPARES ACROSS EVERY SYSTEM, not remote-against-remote. That
// widening is forced by the same change: while a remote cwd lived under cc's
// store it was disjoint from every local project path by construction, so a
// local place could never collide with a remote one. Now a local project at
// `/srv/app` and a remote project at `/srv/app` on `box` produce the same
// directory — and `~/.claude` is host-pinned, so it lands on the host's real
// disk.

import { encodeCwd, normalizeSystemPath } from '../projects.ts';

export interface TranscriptPlace {
  project: string;
  worktree: string | null;
  system: string;
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
    out.push({ project: proj.name, worktree: null, system: proj.system, cwd: proj.path });
    for (const wt of await registeredWorktreeNames(proj.name)) {
      out.push({ project: proj.name, worktree: wt, system: proj.system, cwd: worktreePathFor(proj, wt) });
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
  const encoded = encodeCwd(mine);
  for (const held of places ?? await registeredPlaces()) {
    if (held.project === candidate.project && held.worktree === candidate.worktree) continue;
    const theirs = normalizeSystemPath(held.cwd);
    if (encodeCwd(theirs) === encoded) return { ...held, samePath: theirs === mine };
  }
  return null;
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
  const where = hit.system === candidate.system ? '' : ` on system '${hit.system}'`;
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
