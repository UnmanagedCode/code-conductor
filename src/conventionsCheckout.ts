// Getting a fast-forward pull past cc's own regenerated convention files.
//
// cc rewrites a registered project's tracked CONVENTIONS.md and prepends the
// import to its CLAUDE.md (src/projectClaudeMd.ts), so any checkout cc pulls
// into — a Plugin Library clone, cc's own checkout when it is registered —
// carries that dirt, and `git pull --ff-only` refuses whenever upstream touches
// either file. The one rule: discard only what is PROVEN to be cc's output,
// pull, then regenerate whether the pull succeeded or not. Hand-made changes
// are never discarded; git alone decides whether they block the pull.
//
// Proof is the generator's own functions applied to HEAD's blob:
//   - CLAUDE.md is cc's iff its bytes equal withConventionsImport(HEAD's blob);
//   - CONVENTIONS.md is cc's iff its line 1 equals the marker cc derives from
//     HEAD's copy. The body is app-owned; line 1 is the project's selection,
//     which nothing in cc rewrites after creation — so a different line 1 is
//     a hand edit.
// Only ` M` / `??` at the checkout root are candidates. Staged, deleted,
// renamed, unmerged and every other path are "other dirt".

import path from 'node:path';
import type { System } from './systems/system.ts';
import { runGit } from './worktrees.ts';
import { httpError } from './httpError.ts';
import { withConventionsImport } from './conventionsImport.ts';
import { buildMarker, selectionOf, ensureProjectConventionsMd } from './projectClaudeMd.ts';

const CANDIDATES = new Set(['CLAUDE.md', 'CONVENTIONS.md']);

// A pseudo-ref or git-dir entry present while a merge/rebase/cherry-pick/revert
// is under way: the tree is mid-operation, so nothing in it is discarded.
const IN_PROGRESS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const IN_PROGRESS_DIRS = ['rebase-merge', 'rebase-apply'];

interface Dirt {
  tracked: string[];      // ` M`, restored with checkout
  untracked: string[];    // `??`, removed with clean
  other: string[];        // everything cc did not provably write
}

// Run `run` (the pull, which throws on failure) past cc's generated files in
// `dir`, the tree of registered project `project`. `project: null` means cc
// never writes into this tree, so `run` goes ahead untouched. `note` receives
// progress lines for the caller's pull phase.
export async function pullPastGeneratedConventions<T>({ system, dir, project, note, run }: {
  system: System;
  dir: string;
  project: string | null;
  note?: (text: string) => void;
  run: () => Promise<T>;
}): Promise<T> {
  if (project === null) return run();
  const dirt = await classify(system, dir);
  if (dirt === null) return run();

  const generated = [...dirt.tracked, ...dirt.untracked];
  if (generated.length === 0) {
    try { return await run(); }
    catch (e) { throw withOtherDirt(e, dirt.other, null); }
  }

  if (dirt.tracked.length) await mustGit(system, dir, ['checkout', 'HEAD', '--', ...dirt.tracked]);
  if (dirt.untracked.length) await mustGit(system, dir, ['clean', '-fq', '--', ...dirt.untracked]);
  note?.(`\n[discarded cc-generated ${generated.join(', ')} before pull]\n`);

  let result: T;
  try {
    result = await run();
  } catch (e) {
    const regenError = await regenerate(project, note);
    throw withOtherDirt(e, dirt.other, regenError);
  }
  const regenError = await regenerate(project, note);
  // Plumbing never turns a pull that landed into an error: the boot sweep (and,
  // for a plugin, the update route's sweep) regenerates again.
  if (regenError) console.warn(`conventionsCheckout: regenerating '${project}' after pull failed: ${regenError}`);
  return result;
}

// null = can't classify (not a repo, a mid-operation tree): leave it to the pull.
async function classify(system: System, dir: string): Promise<Dirt | null> {
  const status = await runGit(system, dir, ['-c', 'status.relativePaths=true', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.code !== 0) return null;
  for (const ref of IN_PROGRESS_REFS) {
    if ((await runGit(system, dir, ['rev-parse', '-q', '--verify', ref])).code === 0) return null;
  }
  for (const name of IN_PROGRESS_DIRS) {
    const p = await runGit(system, dir, ['rev-parse', '--git-path', name]);
    if (p.code !== 0) return null;
    if (await system.stat(path.resolve(dir, p.stdout.trim())) !== null) return null;
  }

  const dirt: Dirt = { tracked: [], untracked: [], other: [] };
  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename/copy carries its source as the next field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const kind = xy === ' M' ? 'tracked' : xy === '??' ? 'untracked' : null;
    if (kind && CANDIDATES.has(file) && await isGenerated(system, dir, file, kind)) dirt[kind].push(file);
    else dirt.other.push(file);
  }
  return dirt;
}

async function isGenerated(system: System, dir: string, file: string, kind: 'tracked' | 'untracked'): Promise<boolean> {
  const head = await headBlob(system, dir, file);
  // An untracked copy of a path HEAD still has (its deletion staged) is not
  // what the generator produced from HEAD.
  if ((kind === 'untracked') !== (head === null)) return false;
  const current = await system.readFile(path.join(dir, file));
  if (file === 'CLAUDE.md') return current === withConventionsImport(head);
  return current.split('\n', 1)[0] === buildMarker(selectionOf(head));
}

async function headBlob(system: System, dir: string, file: string): Promise<string | null> {
  const spec = `HEAD:./${file}`;
  if ((await runGit(system, dir, ['cat-file', '-e', spec])).code !== 0) return null;
  return (await mustGit(system, dir, ['cat-file', 'blob', spec])).stdout;
}

async function mustGit(system: System, dir: string, args: string[]): Promise<{ stdout: string }> {
  const r = await runGit(system, dir, args);
  if (r.code !== 0) throw httpError(500, `git ${args.join(' ')} failed in ${dir}: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

// Never throws: the error text, or null on success.
async function regenerate(project: string, note?: (text: string) => void): Promise<string | null> {
  try {
    const r = await ensureProjectConventionsMd(project, { log: console });
    if ('regenerated' in r) note?.('[regenerated CONVENTIONS.md]\n');
    else if (r.skipped === 'catalog-degraded') note?.('[CONVENTIONS.md left as upstream: catalog degraded]\n');
    else note?.('[CONVENTIONS.md not regenerated: project not found]\n');
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note?.(`[regenerating CONVENTIONS.md failed: ${msg}]\n`);
    return msg;
  }
}

// The pull's own error — status and tail kept — with the paths cc did not
// generate named, and a failed regeneration appended.
function withOtherDirt(e: unknown, other: string[], regenError: string | null): unknown {
  if (!other.length && !regenError) return e;
  if (typeof e !== 'object' || e === null) return e;
  const base = e instanceof Error ? e.message : String(e);
  const msg = base
    + (other.length ? `; local changes cc did not generate: ${other.join(', ')}` : '')
    + (regenError ? `; regenerating CONVENTIONS.md failed: ${regenError}` : '');
  const status = (e as { statusCode?: unknown }).statusCode;
  return httpError(typeof status === 'number' ? status : 502, msg, { ...e });
}
