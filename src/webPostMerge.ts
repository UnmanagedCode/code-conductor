// cc's own post-merge step (`.code-conductor/post-worktree-merge.sh`): after a
// merge lands in cc's main checkout, make a web-only change live at once when
// that is safe, and otherwise stage the build so the next start adopts it
// without building.
//
// "Safe" is measured against the commit the serving server booted from, which
// only that server can say: it passes `CC_SERVER_BOOT_SHA` to a hook merging
// into its own checkout while none of its own web builds runs
// (src/bootCommit.ts). A new UI is swapped in only when everything that changed
// since boot is under web/, so the backend serving it is the one it was built
// against. Anything else the UI build reads (isWebInput, src/webBuild.ts), or
// no boot commit, stages instead.

import path from 'node:path';
import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import type { BootCommit } from './bootCommit.ts';
import {
  isWebInput, refreshWebDist, runViteBuild, stageWebBuild, webInputs,
  type RefreshOutcome, type WebBuilder, type WebInputs,
} from './webBuild.ts';

export type WebPostMergeAction = 'swap' | 'stage' | 'noop';
export type WebPostMergeDecision = { action: WebPostMergeAction; reason: string };

/** The serving server's boot commit as the hook's env carries it; absent means unknown. */
export function bootCommitFromEnv(env: NodeJS.ProcessEnv): BootCommit {
  if (env.CC_SERVER_BOOT_SHA) return { sha: env.CC_SERVER_BOOT_SHA };
  return { unknown: env.CC_SERVER_BOOT_UNKNOWN || 'CC_SERVER_BOOT_SHA is unset: the merge target is not the running server\'s own checkout' };
}

export function decideWebPostMerge({ inputs, isMainCheckout, boot, bootIsAncestor, changedSinceBoot, changedThisMerge }: {
  // The UI build's inputs: a changed path counts only if the build reads it.
  inputs: WebInputs;
  isMainCheckout: boolean;
  boot: BootCommit;
  // Whether the boot commit is an ancestor of the merge result, and the paths
  // changed between the two. Only read for a known boot commit; null when git
  // could not tell.
  bootIsAncestor: boolean;
  changedSinceBoot: string[] | null;
  changedThisMerge: string[];
}): WebPostMergeDecision {
  const relevant = (p: string) => isWebInput(inputs, p);
  if (!isMainCheckout) return { action: 'noop', reason: 'the merge target is a linked worktree, not the main checkout' };
  if ('sha' in boot && bootIsAncestor && changedSinceBoot) {
    if (!changedSinceBoot.some(relevant)) return { action: 'noop', reason: 'nothing the UI build reads changed since the server booted' };
    const outside = changedSinceBoot.find((p) => !p.startsWith('web/'));
    if (outside === undefined) return { action: 'swap', reason: 'every change since the server booted is under web/' };
    return { action: 'stage', reason: `changes since the server booted reach outside web/ (${outside}), so a new UI may not match the running server` };
  }
  const why = !('sha' in boot) ? boot.unknown
    : !bootIsAncestor ? `the boot commit ${boot.sha.slice(0, 12)} is not an ancestor of the merge`
    : 'the changes since the boot commit could not be listed';
  if (!changedThisMerge.some(relevant)) return { action: 'noop', reason: `nothing the UI build reads changed in this merge (${why})` };
  return { action: 'stage', reason: `the running server's commit is unknown: ${why}` };
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

async function gitFacts(root: string, pre: string, post: string, boot: BootCommit) {
  const git = (args: string[]) => runGit(localSystem(), root, args);
  // --no-renames: a rename lists BOTH sides, so a move out of src/ into web/
  // still names the src/ path it changed.
  const changed = (from: string) => git(['diff', '--no-renames', '--name-only', from, post]);
  const dirs = await git(['rev-parse', '--git-dir', '--git-common-dir']);
  if (dirs.code !== 0) throw new Error(`${root} is not a git checkout: ${dirs.stderr.trim()}`);
  const [gitDir, commonDir] = lines(dirs.stdout).map((d) => path.resolve(root, d));
  const merge = await changed(pre);
  if (merge.code !== 0) throw new Error(`git diff ${pre} ${post} failed: ${merge.stderr.trim()}`);
  let bootIsAncestor = false;
  let changedSinceBoot: string[] | null = null;
  if ('sha' in boot) {
    // Exit 1 is "not an ancestor"; anything else is a sha that will not verify.
    // Either way it reads as not vouched for.
    bootIsAncestor = (await git(['merge-base', '--is-ancestor', boot.sha, post])).code === 0;
    if (bootIsAncestor) {
      const since = await changed(boot.sha);
      if (since.code === 0) changedSinceBoot = lines(since.stdout);
    }
  }
  return { isMainCheckout: gitDir === commonDir, bootIsAncestor, changedSinceBoot, changedThisMerge: lines(merge.stdout) };
}

/**
 * Decide and act for a merge PRE..POST that landed in the checkout at `root`,
 * given what the serving server booted from. Prints one line naming the
 * action, the reason and the boot commit. Throws on a failed build, swap or
 * git read, so the hook reports the failure.
 */
export async function runWebPostMerge(
  { root, pre, post, boot, build, log = console }:
  { root: string; pre: string; post: string; boot: BootCommit; build?: WebBuilder; log?: Pick<Console, 'log' | 'error'> },
): Promise<WebPostMergeDecision & { outcome?: RefreshOutcome | 'staged' | 'already-current' }> {
  const inputs = webInputs(root);
  const decision = decideWebPostMerge({ inputs, boot, ...(await gitFacts(root, pre, post, boot)) });
  const bootName = 'sha' in boot ? boot.sha.slice(0, 12) : 'unknown';
  log.log(`[post-worktree-merge] web: ${decision.action} — ${decision.reason} (boot commit: ${bootName})`);
  if (decision.action === 'noop') return decision;
  const opts = {
    distDir: path.join(root, 'web', 'dist'),
    inputs,
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
