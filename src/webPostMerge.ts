// cc's own post-merge step (`.code-conductor/post-worktree-merge.sh`): after a
// merge lands in cc's main checkout, make a web-only change live at once when
// that is safe, and otherwise stage the build so the next start adopts it
// without building.
//
// "Safe" is measured against the commit the running server booted from
// (src/bootCommit.ts): a new UI is swapped in only when everything that changed
// since boot is under web/, so the backend serving it is the one it was built
// against. Anything else that the UI build reads — shared/, package.json —
// or a boot commit that cannot be vouched for, stages instead.

import path from 'node:path';
import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import { readBootCommit, type BootCommit } from './bootCommit.ts';
import { refreshWebDist, runViteBuild, stageWebBuild, webInputs, type RefreshOutcome, type WebBuilder } from './webBuild.ts';

export type WebPostMergeAction = 'swap' | 'stage' | 'noop';
export type WebPostMergeDecision = { action: WebPostMergeAction; reason: string };

// A path the UI build reads. `package-lock.json` is gitignored in cc, so the
// installed tree's own lockfile never shows up in a git diff.
const isRelevant = (p: string): boolean => p.startsWith('web/') || p.startsWith('shared/') || p === 'package.json';

export function decideWebPostMerge({ isMainCheckout, boot, bootIsAncestor, changedSinceBoot, changedThisMerge }: {
  isMainCheckout: boolean;
  boot: BootCommit;
  // Whether the boot commit is an ancestor of the merge result, and the paths
  // changed between the two. Only read for a known boot commit; null when git
  // could not tell.
  bootIsAncestor: boolean;
  changedSinceBoot: string[] | null;
  changedThisMerge: string[];
}): WebPostMergeDecision {
  if (!isMainCheckout) return { action: 'noop', reason: 'the merge target is a linked worktree, not the main checkout' };
  if ('sha' in boot && bootIsAncestor && changedSinceBoot) {
    if (!changedSinceBoot.some(isRelevant)) return { action: 'noop', reason: 'nothing the UI build reads changed since the server booted' };
    const outside = changedSinceBoot.find((p) => !p.startsWith('web/'));
    if (outside === undefined) return { action: 'swap', reason: 'every change since the server booted is under web/' };
    return { action: 'stage', reason: `changes since the server booted reach outside web/ (${outside}), so a new UI may not match the running server` };
  }
  const why = !('sha' in boot) ? boot.unknown
    : !bootIsAncestor ? `the boot commit ${boot.sha.slice(0, 12)} is not an ancestor of the merge`
    : 'the changes since the boot commit could not be listed';
  if (!changedThisMerge.some(isRelevant)) return { action: 'noop', reason: `nothing the UI build reads changed in this merge (${why})` };
  return { action: 'stage', reason: `the running server's commit is unknown: ${why}` };
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

async function gitFacts(root: string, pre: string, post: string) {
  const git = (args: string[]) => runGit(localSystem(), root, args);
  const dirs = await git(['rev-parse', '--git-dir', '--git-common-dir']);
  if (dirs.code !== 0) throw new Error(`${root} is not a git checkout: ${dirs.stderr.trim()}`);
  const [gitDir, commonDir] = lines(dirs.stdout).map((d) => path.resolve(root, d));
  const merge = await git(['diff', '--name-only', pre, post]);
  if (merge.code !== 0) throw new Error(`git diff ${pre} ${post} failed: ${merge.stderr.trim()}`);
  const boot = await readBootCommit(root);
  let bootIsAncestor = false;
  let changedSinceBoot: string[] | null = null;
  if ('sha' in boot) {
    // Exit 1 is "not an ancestor"; anything else is a sha that will not verify.
    // Either way it reads as not vouched for.
    bootIsAncestor = (await git(['merge-base', '--is-ancestor', boot.sha, post])).code === 0;
    if (bootIsAncestor) {
      const since = await git(['diff', '--name-only', boot.sha, post]);
      if (since.code === 0) changedSinceBoot = lines(since.stdout);
    }
  }
  return { isMainCheckout: gitDir === commonDir, boot, bootIsAncestor, changedSinceBoot, changedThisMerge: lines(merge.stdout) };
}

/**
 * Decide and act for a merge PRE..POST that landed in the checkout at `root`.
 * Prints one line naming the action, the reason and the boot commit. Throws
 * on a failed build, swap or git read, so the hook reports the failure.
 */
export async function runWebPostMerge(
  { root, pre, post, build, log = console }:
  { root: string; pre: string; post: string; build?: WebBuilder; log?: Pick<Console, 'log' | 'error'> },
): Promise<WebPostMergeDecision & { outcome?: RefreshOutcome | 'staged' | 'already-current' }> {
  const facts = await gitFacts(root, pre, post);
  const decision = decideWebPostMerge(facts);
  const bootName = 'sha' in facts.boot ? facts.boot.sha.slice(0, 12) : 'unknown';
  log.log(`[post-worktree-merge] web: ${decision.action} — ${decision.reason} (boot commit: ${bootName})`);
  if (decision.action === 'noop') return decision;
  const opts = {
    distDir: path.join(root, 'web', 'dist'),
    inputs: webInputs(root),
    build: build ?? ((outDir, o) => runViteBuild(outDir, { ...o, root })),
    log,
  };
  if (decision.action === 'swap') {
    const outcome = await refreshWebDist(opts);
    log.log(`[post-worktree-merge] web: ${outcome} — live on the next page load`);
    return { ...decision, outcome };
  }
  const { staged } = await stageWebBuild(opts);
  log.log(`[post-worktree-merge] web: ${staged ? 'staged in web/dist.next — the next start adopts it' : 'web/dist is already current'}`);
  return { ...decision, outcome: staged ? 'staged' : 'already-current' };
}
